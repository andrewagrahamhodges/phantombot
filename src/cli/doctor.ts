/**
 * `phantombot doctor` — memory-subsystem health check + auto-repair.
 *
 * Reads signals that already exist on disk and in `memory.sqlite`:
 *   - `.nightly-state.json`    — last run timestamp + status
 *   - `.nightly-progress.json` — an in-flight / partial checkpoint
 *   - `capture_log`            — was anything captured in the last 24h?
 *
 * It answers the three questions the issue author could only guess at:
 * did the last nightly run, did it succeed, and is capture actually
 * firing. When the nightly is stale, failed, or left a partial
 * checkpoint, doctor spawns `phantombot nightly --resume` as a detached
 * background process — which, thanks to the checkpointed nightly, picks
 * up exactly where the last run stopped.
 *
 * Invoked manually, from the startup catch-up in `run`, and safe to
 * wire into any mechanical scheduler (it never runs an LLM in-process —
 * repair is a detached child).
 */

import { spawn } from "node:child_process";
import { defineCommand } from "citty";
import { existsSync } from "node:fs";

import { type Config, loadConfig, personaDir } from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import {
  CATCHUP_WINDOW_MS,
  loadNightlyProgress,
  loadNightlyState,
  type NightlyProgress,
  type NightlyState,
} from "../lib/nightly.ts";
import { openMemoryStore } from "../memory/store.ts";

/** Window for the capture-health check: a "dry day" is judged over 24h. */
const CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Below this many real user turns in the window we don't flag a dry
 * day — a genuinely quiet day legitimately has nothing to capture.
 */
const DRY_DAY_TURN_THRESHOLD = 20;

export interface DoctorReport {
  persona: string;
  nightly: {
    last_run?: string;
    last_status?: string;
    /** Hours since the last run, or null if it never ran. */
    age_hours: number | null;
    stale: boolean;
    /** A partial/in-progress checkpoint, if one is parked on disk. */
    checkpoint?: {
      date: string;
      status: NightlyProgress["status"];
      completed_stages: string[];
      last_error?: string;
    };
  };
  capture: {
    window_hours: number;
    user_turns: number;
    captures: number;
    /** Many user turns, zero captures — capture is likely not firing. */
    dry_day: boolean;
  };
  repair_needed: boolean;
  repair_reason?: string;
  repair_triggered: boolean;
}

export interface RunDoctorInput {
  config?: Config;
  persona?: string;
  /** Spawn `nightly --resume` when repair is warranted. Default true. */
  repair?: boolean;
  /** Emit machine-readable JSON instead of the human summary. */
  json?: boolean;
  out?: WriteSink;
  err?: WriteSink;
  /** Test seam — override the repair spawn. */
  spawnRepair?: (persona: string) => void;
}

function decideRepair(
  state: NightlyState,
  progress: NightlyProgress | null,
  ageHours: number | null,
): { needed: boolean; reason?: string } {
  if (progress && progress.status !== "complete") {
    return {
      needed: true,
      reason:
        `partial nightly checkpoint for ${progress.date} ` +
        `(${progress.completed_stages.length} stage(s) done` +
        (progress.last_error ? `; last error: ${progress.last_error}` : "") +
        ")",
    };
  }
  if (!state.last_run || ageHours === null) {
    return { needed: true, reason: "no record of any nightly run" };
  }
  if (state.last_status === "error" || state.last_status === "partial") {
    return {
      needed: true,
      reason: `last nightly status was '${state.last_status}'`,
    };
  }
  if (ageHours * 3_600_000 > CATCHUP_WINDOW_MS) {
    return {
      needed: true,
      reason: `last nightly ran ${Math.round(ageHours)}h ago (>${
        CATCHUP_WINDOW_MS / 3_600_000
      }h)`,
    };
  }
  return { needed: false };
}

/** Spawn a detached `phantombot nightly --resume` that outlives this process. */
function defaultSpawnRepair(persona: string): void {
  const entry = process.argv[1] ?? "";
  const dev = entry.endsWith(".ts") || entry.endsWith(".js");
  const args = dev
    ? [entry, "nightly", "--resume", "--persona", persona]
    : ["nightly", "--resume", "--persona", persona];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  log.info("doctor: spawned background nightly --resume", { persona });
}

export async function runDoctor(input: RunDoctorInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const repair = input.repair ?? true;

  const config = input.config ?? (await loadConfig());
  const persona = input.persona ?? config.defaultPersona;
  const dir = personaDir(config, persona);
  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const state = await loadNightlyState(dir);
  const progress = await loadNightlyProgress(dir);

  const lastRunMs = state.last_run ? Date.parse(state.last_run) : NaN;
  const ageHours = Number.isNaN(lastRunMs)
    ? null
    : (Date.now() - lastRunMs) / 3_600_000;

  // Capture health — compare real user turns vs captures over 24h.
  const since = new Date(Date.now() - CAPTURE_WINDOW_MS).toISOString();
  const memory = await openMemoryStore(config.memoryDbPath);
  let userTurns = 0;
  let captures = 0;
  try {
    userTurns = await memory.countUserTurnsForPersonaSince(
      persona,
      "telegram:",
      since,
    );
    captures = await memory.countCapturesSince(persona, since);
  } finally {
    await memory.close();
  }
  const dryDay = userTurns >= DRY_DAY_TURN_THRESHOLD && captures === 0;

  const { needed, reason } = decideRepair(state, progress, ageHours);

  let repairTriggered = false;
  if (needed && repair) {
    (input.spawnRepair ?? defaultSpawnRepair)(persona);
    repairTriggered = true;
  }

  const report: DoctorReport = {
    persona,
    nightly: {
      last_run: state.last_run,
      last_status: state.last_status,
      age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      stale: needed,
      ...(progress
        ? {
            checkpoint: {
              date: progress.date,
              status: progress.status,
              completed_stages: progress.completed_stages,
              ...(progress.last_error
                ? { last_error: progress.last_error }
                : {}),
            },
          }
        : {}),
    },
    capture: {
      window_hours: CAPTURE_WINDOW_MS / 3_600_000,
      user_turns: userTurns,
      captures,
      dry_day: dryDay,
    },
    repair_needed: needed,
    repair_reason: reason,
    repair_triggered: repairTriggered,
  };

  if (input.json) {
    out.write(JSON.stringify(report, null, 2) + "\n");
    return needed && !repairTriggered ? 1 : 0;
  }

  // Human summary.
  const tick = (ok: boolean) => (ok ? "ok" : "WARN");
  out.write(`phantombot doctor — persona '${persona}'\n`);
  out.write(
    `  nightly: ${tick(!needed)} — ` +
      (state.last_run
        ? `last run ${state.last_run} (${report.nightly.age_hours}h ago), status '${
            state.last_status ?? "unknown"
          }'`
        : "never run") +
      "\n",
  );
  if (progress) {
    out.write(
      `  checkpoint: ${progress.status} for ${progress.date} — ` +
        `done [${progress.completed_stages.join(", ") || "none"}]` +
        (progress.last_error ? ` — ${progress.last_error}` : "") +
        "\n",
    );
  }
  out.write(
    `  capture: ${tick(!dryDay)} — ${captures} capture(s), ${userTurns} ` +
      `user turn(s) in the last ${report.capture.window_hours}h` +
      (dryDay ? " — DRY DAY: turns but no captures" : "") +
      "\n",
  );
  if (needed) {
    out.write(`  repair: ${reason}\n`);
    out.write(
      repairTriggered
        ? "  → spawned background `nightly --resume`\n"
        : "  → run `phantombot nightly --resume` to repair\n",
    );
  } else {
    out.write("  repair: not needed\n");
  }

  return needed && !repairTriggered ? 1 : 0;
}

export default defineCommand({
  meta: {
    name: "doctor",
    description:
      "Memory health check — reports nightly/capture status and auto-repairs a stale or partial nightly by resuming it in the background.",
  },
  args: {
    persona: {
      type: "string",
      description: "Persona name (default: configured default).",
    },
    "no-repair": {
      type: "boolean",
      description: "Only report; do not spawn a background nightly --resume.",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Emit the report as JSON (for schedulers / scripts).",
      default: false,
    },
  },
  async run({ args }) {
    process.exitCode = await runDoctor({
      persona: args.persona ? String(args.persona) : undefined,
      repair: !args["no-repair"],
      json: Boolean(args.json),
    });
  },
});
