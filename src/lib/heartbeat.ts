/**
 * Heartbeat job — mechanical maintenance, no LLM call.
 *
 * Runs every 30 minutes via systemd timer. Three things only:
 *   1. Promote tagged lines from today's daily file into the matching
 *      structured drawer. Dedup by text-equality so re-promotion of the
 *      same line is a no-op.
 *   2. Staleness scan of MEMORY.md's `## Recent` section — flag lines
 *      whose embedded date is older than 48h. Logs warnings; does not
 *      mutate.
 *   3. Refresh the FTS5 index so newly-written notes are searchable
 *      without waiting for the next manual `memory index`. Does NOT
 *      run the embedding pass (that's the nightly cycle's job).
 *
 * The harness never sees this — heartbeat runs as its own short-lived
 * process. Per the OpenClaw spec: "Heartbeat is mechanical, nightly is
 * cognitive. Don't let the heartbeat write KB notes."
 */

import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { TelegramTransport } from "../channels/telegram.ts";
import type { Config } from "../config.ts";
import { log } from "./logger.ts";
import { MemoryIndex } from "./memoryIndex.ts";
import {
  checkAndNotifyOnce,
  type CheckAndNotifyOnceResult,
} from "./updateNotify.ts";

export interface HeartbeatResult {
  promoted: { drawer: string; line: string }[];
  staleRecent: { line: string; ageHours: number }[];
  indexedFiles: number;
  /** When the heartbeat ran. */
  ranAt: Date;
  /**
   * Result of the optional update check. Undefined when the heartbeat
   * wasn't given a config (e.g. tests that skip the network path).
   */
  updateCheck?: CheckAndNotifyOnceResult;
}

/**
 * Tag → drawer mapping. Both singular and plural spellings are accepted
 * so the heartbeat promotion and `phantombot memory capture` agree on
 * exactly the same vocabulary. Exported so the CLI validates against the
 * single source of truth.
 */
export const TAG_TO_DRAWER: Record<string, string> = {
  decision: "memory/decisions.md",
  decisions: "memory/decisions.md",
  lesson: "memory/lessons.md",
  lessons: "memory/lessons.md",
  person: "memory/people.md",
  people: "memory/people.md",
  commitment: "memory/commitments.md",
  commitments: "memory/commitments.md",
};

const TAG_PATTERN = /^\s*-?\s*\[([a-z]+)\]\s+(.+)$/i;

export interface RunHeartbeatInput {
  personaDir: string;
  /** Override "today" for testing. ISO date YYYY-MM-DD. */
  today?: string;
  /** Override "now" for staleness scan (testing). */
  now?: Date;
  /** Optional MemoryIndex; if omitted, opens one at indexPath. */
  index?: MemoryIndex;
  /** Path to the FTS index file (used only if index isn't passed). */
  indexPath?: string;
  /**
   * Loaded config — required to enable the once-per-version update
   * notification. When omitted the heartbeat skips the GitHub check
   * entirely. The CLI entry point passes this; tests can omit it to
   * keep the network out of the path.
   */
  config?: Config;
  /**
   * Currently running phantombot version. Compared against GitHub's
   * latest release to decide whether to notify. Defaults to the
   * VERSION constant via the CLI; tests inject a known value.
   */
  currentVersion?: string;
  /** Override fetch for the GitHub release check (test seam). */
  fetchImpl?: typeof fetch;
  /** Override transport for the notify send (test seam). */
  transport?: TelegramTransport;
  /** Override the dedup-cache path (test seam). */
  lastNotifiedPath?: string;
}

export async function runHeartbeat(
  input: RunHeartbeatInput,
): Promise<HeartbeatResult> {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const now = input.now ?? new Date();

  const promoted = await promoteTaggedLines(input.personaDir, today);
  const staleRecent = await checkStaleness(input.personaDir, now);

  // FTS-only refresh. Don't touch embeddings.
  const ix = input.index ?? (input.indexPath ? await MemoryIndex.open(input.indexPath) : null);
  let indexedFiles = 0;
  if (ix) {
    const r = await ix.refreshStale(input.personaDir);
    indexedFiles = r.indexed;
    if (!input.index) ix.close();
  }

  if (promoted.length > 0) {
    log.info("heartbeat: promoted", { count: promoted.length });
  }
  if (staleRecent.length > 0) {
    log.warn("heartbeat: stale items in ## Recent", {
      count: staleRecent.length,
      sample: staleRecent.slice(0, 3),
    });
  }

  // Update check — guarded by config + currentVersion so tests that
  // pre-date the wiring stay opt-out. Errors here never bubble up
  // (checkAndNotifyOnce catches everything internally and returns a
  // status); a transient GitHub blip mustn't fail the whole heartbeat.
  let updateCheck: CheckAndNotifyOnceResult | undefined;
  if (input.config && input.currentVersion) {
    try {
      updateCheck = await checkAndNotifyOnce({
        config: input.config,
        currentVersion: input.currentVersion,
        fetchImpl: input.fetchImpl,
        transport: input.transport,
        lastNotifiedPath: input.lastNotifiedPath,
      });
      if (updateCheck.status === "notified") {
        log.info("heartbeat: notified update available", {
          version: updateCheck.latestVersion,
          recipients: updateCheck.notifiedRecipients,
        });
      }
    } catch (e) {
      // checkAndNotifyOnce shouldn't throw — but if it does, log and
      // keep going. The heartbeat's primary job is the local
      // promotions/staleness/index work; the update notify is a bonus.
      log.warn("heartbeat: update check threw unexpectedly", {
        error: (e as Error).message,
      });
    }
  }

  return { promoted, staleRecent, indexedFiles, ranAt: now, updateCheck };
}

/** Scan today's daily file for [tag] lines; append to matching drawer. */
export async function promoteTaggedLines(
  personaDir: string,
  today: string,
): Promise<HeartbeatResult["promoted"]> {
  const dailyPath = join(personaDir, "memory", `${today}.md`);
  if (!existsSync(dailyPath)) return [];

  const text = await readFile(dailyPath, "utf8");
  const lines = text.split("\n");
  const promoted: HeartbeatResult["promoted"] = [];

  // Cache drawer contents to avoid re-reading per line.
  const drawerCache = new Map<string, string>();
  const loadDrawer = async (rel: string): Promise<string> => {
    if (drawerCache.has(rel)) return drawerCache.get(rel)!;
    const p = join(personaDir, rel);
    let content = "";
    if (existsSync(p)) content = await readFile(p, "utf8");
    drawerCache.set(rel, content);
    return content;
  };

  for (const raw of lines) {
    const m = TAG_PATTERN.exec(raw);
    if (!m) continue;
    const tag = m[1]!.toLowerCase();
    const drawer = TAG_TO_DRAWER[tag];
    if (!drawer) continue;
    const cleanLine = raw.trim();
    const existing = await loadDrawer(drawer);
    if (existing.includes(cleanLine)) continue;

    // Append under a date header. If today's header isn't there, add it.
    const header = `## ${today}`;
    let block = "";
    if (!existing.includes(header)) {
      block += `\n${header}\n\n`;
    }
    block += `- ${cleanLine}\n`;
    await appendFile(join(personaDir, drawer), block, "utf8");
    drawerCache.set(drawer, existing + block);
    promoted.push({ drawer, line: cleanLine });
  }
  return promoted;
}

/** Scan MEMORY.md's ## Recent for date-stamped lines older than 48h. */
export async function checkStaleness(
  personaDir: string,
  now: Date,
  thresholdHours = 48,
): Promise<HeartbeatResult["staleRecent"]> {
  const memPath = join(personaDir, "MEMORY.md");
  if (!existsSync(memPath)) return [];
  const text = await readFile(memPath, "utf8");
  const recent = extractRecentSection(text);
  if (!recent) return [];

  const out: HeartbeatResult["staleRecent"] = [];
  for (const line of recent.split("\n")) {
    const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(line);
    if (!dateMatch) continue;
    const lineDate = new Date(`${dateMatch[1]}T00:00:00Z`);
    if (Number.isNaN(lineDate.getTime())) continue;
    const ageHours = (now.getTime() - lineDate.getTime()) / 3_600_000;
    if (ageHours >= thresholdHours) {
      out.push({ line: line.trim(), ageHours: Math.round(ageHours) });
    }
  }
  return out;
}

/** Extract the body of `## Recent` from MEMORY.md (between this header and the next). */
export function extractRecentSection(memoryMd: string): string | undefined {
  const lines = memoryMd.split("\n");
  let inRecent = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^##\s+Recent\b/i.test(line)) {
      inRecent = true;
      continue;
    }
    if (inRecent && /^##\s+/.test(line)) break;
    if (inRecent) out.push(line);
  }
  return inRecent ? out.join("\n") : undefined;
}
