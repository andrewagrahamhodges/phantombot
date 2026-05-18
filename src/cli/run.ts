/**
 * `phantombot run` — long-running channel listener (Telegram for v1).
 * Stays in the foreground. Ctrl-C to stop. Daemonize via systemd
 * (`phantombot install`) or `nohup phantombot run &`.
 *
 * Replaces the older `phantombot serve --telegram`.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";

import {
  HttpTelegramTransport,
  runTelegramServer,
} from "../channels/telegram.ts";
import { type Config, loadConfig, personaDir } from "../config.ts";
import { buildHarnessChain } from "../harnesses/buildChain.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import { healDefaultPersonaIfBroken } from "../lib/personaDefault.ts";
import { logsCommand, statusCommand } from "../lib/platform.ts";
import {
  acquireRunLock,
  defaultLockPath,
  isLockHandle,
} from "../lib/runLock.ts";
import { notifyPostRestartIfPending } from "../lib/updateNotify.ts";
import { openMemoryStore } from "../memory/store.ts";
import { VERSION } from "../version.ts";
import { runDoctor } from "./doctor.ts";

export interface RunInput {
  config?: Config;
  out?: WriteSink;
  err?: WriteSink;
  /** Override the lock file path (for testing). */
  lockPath?: string;
}

export async function runRun(input: RunInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  const config = input.config ?? (await loadConfig());
  const tg = config.channels.telegram;
  if (!tg) {
    err.write(
      "no telegram bot token configured. Run `phantombot telegram` to set one up.\n",
    );
    return 2;
  }

  let persona = config.defaultPersona;
  let agentDir = personaDir(config, persona);
  if (!existsSync(agentDir)) {
    const healed = await healDefaultPersonaIfBroken(config, err);
    if (!healed) {
      err.write(
        `default persona '${persona}' not found at ${agentDir} and no other personas exist.\n` +
          "Create one with `phantombot persona`.\n",
      );
      return 2;
    }
    // Re-resolve paths with the healed persona. loadConfig() cached the
    // stale default, but personaDir(healed) is deterministic from config
    // so we can compute it directly.
    persona = healed;
    agentDir = personaDir(config, persona);
    config.defaultPersona = healed;
  }

  const harnesses = buildHarnessChain(config, err);
  if (harnesses.length === 0) {
    err.write(
      "no harnesses configured. Run `phantombot harness` to pick at least one.\n",
    );
    return 2;
  }

  const lockPath = input.lockPath ?? defaultLockPath();
  const lock = acquireRunLock(lockPath);
  if (!isLockHandle(lock)) {
    err.write(
      `phantombot is already running (pid ${Number.isFinite(lock.pid) ? lock.pid : "unknown"}; lock at ${lock.path})\n` +
        `view logs:    ${logsCommand()}\n` +
        `status:       ${statusCommand()}\n` +
        "stop the other instance first, or remove the lock if it's stale.\n",
    );
    return 1;
  }

  const memory = await openMemoryStore(config.memoryDbPath);
  const transport = new HttpTelegramTransport(tg.token);

  // Post-restart check: if `/update` wrote a pending-update marker before
  // we got SIGTERMed, surface the result to the chat that triggered it.
  // Runs once at startup; if no marker exists this is a quick no-op stat.
  // Logged + swallowed so a notify-send failure can't keep us out of the
  // poll loop — startup must always succeed.
  try {
    const r = await notifyPostRestartIfPending({
      config,
      currentVersion: VERSION,
      transport,
    });
    if (r.status === "success_notified" || r.status === "failure_notified") {
      log.info("run: post-restart notify", {
        status: r.status,
        targetTag: r.marker?.targetTag,
        previousVersion: r.marker?.previousVersion,
        currentVersion: VERSION,
      });
    }
  } catch (e) {
    log.warn("run: post-restart notify threw", {
      error: (e as Error).message,
    });
  }

  out.write(
    `phantombot — persona '${persona}', harnesses ${config.harnesses.chain.join(" → ")}\n`,
  );
  out.write(
    `telegram long-poll ${tg.pollTimeoutS}s; allowed users: ${
      tg.allowedUserIds.length === 0 ? "ANY (no allowlist)" : tg.allowedUserIds.join(",")
    }\n`,
  );
  out.write("Ctrl-C to stop.\n");

  // Startup catch-up: `doctor` checks for a stale, failed, or partially
  // checkpointed nightly and, if found, spawns a detached
  // `nightly --resume` that picks up from the last good stage. This
  // covers machines powered off during the 02:00 window. Don't await —
  // doctor's repair is a detached child, so this returns immediately.
  runDoctor({ config, persona, out, err }).then(
    (code) => {
      if (code !== 0) log.info("run: startup doctor flagged an issue", { code });
    },
    (e: unknown) =>
      log.error("run: startup doctor threw", {
        error: (e as Error).message,
      }),
  );

  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  try {
    await runTelegramServer({
      config,
      memory,
      harnesses,
      agentDir,
      persona,
      transport,
      signal: ac.signal,
      out,
      err,
    });
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
    await memory.close();
    lock.release();
  }
  return 0;
}

export default defineCommand({
  meta: {
    name: "run",
    description:
      "Run phantombot in the foreground (Telegram listener + harness loop). Ctrl-C to stop.",
  },
  async run() {
    const code = await runRun();
    process.exitCode = code;
  },
});
