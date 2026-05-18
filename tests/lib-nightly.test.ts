import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNightlyPrompt,
  buildNightlyPromptForPersona,
  buildNightlyStagePrompt,
  CATCHUP_WINDOW_MS,
  clearNightlyProgress,
  loadNightlyProgress,
  loadNightlyState,
  NIGHTLY_STAGES,
  type NightlyProgress,
  nightlyConversationKey,
  nightlyStatePath,
  pendingNightlyStages,
  saveNightlyProgress,
  saveNightlyState,
  shouldRunCatchupNightly,
} from "../src/lib/nightly.ts";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-nightly-"));
  await mkdir(join(workdir, "memory"), { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("nightlyConversationKey", () => {
  test("uses system:nightly:<date> namespace", () => {
    expect(nightlyConversationKey("2026-05-02")).toBe(
      "system:nightly:2026-05-02",
    );
  });
});

describe("nightlyStatePath", () => {
  test("returns memory/.nightly-state.json under the persona dir", () => {
    expect(nightlyStatePath("/tmp/persona")).toBe(
      "/tmp/persona/memory/.nightly-state.json",
    );
  });
});

describe("loadNightlyState / saveNightlyState", () => {
  test("returns {} when no state file exists", async () => {
    expect(await loadNightlyState(workdir)).toEqual({});
  });

  test("save then load round-trips", async () => {
    await saveNightlyState(workdir, {
      last_run: "2026-05-02T02:15:00Z",
      last_status: "ok",
      items_promoted: 5,
    });
    const r = await loadNightlyState(workdir);
    expect(r.last_run).toBe("2026-05-02T02:15:00Z");
    expect(r.last_status).toBe("ok");
    expect(r.items_promoted).toBe(5);
  });

  test("save merges into existing state", async () => {
    await saveNightlyState(workdir, {
      last_run: "2026-05-01T02:00:00Z",
      items_promoted: 3,
    });
    await saveNightlyState(workdir, {
      last_run: "2026-05-02T02:00:00Z",
      last_status: "ok",
    });
    const r = await loadNightlyState(workdir);
    expect(r.last_run).toBe("2026-05-02T02:00:00Z");
    expect(r.last_status).toBe("ok");
    // items_promoted from the first save is preserved.
    expect(r.items_promoted).toBe(3);
  });

  test("malformed JSON falls back to {} (logs warn but doesn't throw)", async () => {
    await writeFile(nightlyStatePath(workdir), "not json", "utf8");
    expect(await loadNightlyState(workdir)).toEqual({});
  });
});

describe("buildNightlyPrompt", () => {
  test("embeds the persona name + today + isolation note", () => {
    const p = buildNightlyPrompt("kai", "2026-05-02");
    expect(p).toContain("persona 'kai'");
    expect(p).toContain("Today is 2026-05-02");
    expect(p).toContain("system:nightly:2026-05-02");
    expect(p).toContain("ISOLATED");
    expect(p).toContain("PHASE 1");
    expect(p).toContain("PHASE 5");
  });

  test("references all five phases in order", () => {
    const p = buildNightlyPrompt("x", "2026-01-01");
    const phase1 = p.indexOf("PHASE 1");
    const phase5 = p.indexOf("PHASE 5");
    expect(phase1).toBeGreaterThan(0);
    expect(phase5).toBeGreaterThan(phase1);
    for (let i = 2; i <= 4; i++) {
      const idx = p.indexOf(`PHASE ${i}`);
      expect(idx).toBeGreaterThan(phase1);
      expect(idx).toBeLessThan(phase5);
    }
  });

  test("references the phantombot memory tools the harness must call", () => {
    const p = buildNightlyPrompt("x", "2026-01-01");
    expect(p).toContain("phantombot memory today");
    expect(p).toContain("phantombot memory search");
    expect(p).toContain("phantombot memory get");
    expect(p).toContain("phantombot memory index --rebuild");
  });
});

describe("shouldRunCatchupNightly", () => {
  test("returns true when no state file exists", async () => {
    expect(await shouldRunCatchupNightly(workdir)).toBe(true);
  });

  test("returns true when last_run is more than 24h ago", async () => {
    const old = new Date(Date.now() - CATCHUP_WINDOW_MS - 60_000);
    await saveNightlyState(workdir, {
      last_run: old.toISOString(),
    });
    expect(await shouldRunCatchupNightly(workdir)).toBe(true);
  });

  test("returns false when last_run is within the last 24h", async () => {
    const recent = new Date(Date.now() - 60_000); // 1 minute ago
    await saveNightlyState(workdir, {
      last_run: recent.toISOString(),
    });
    expect(await shouldRunCatchupNightly(workdir)).toBe(false);
  });

  test("returns true when last_run is unparseable", async () => {
    // Write malformed last_run directly (bypass saveNightlyState which uses Date.toISOString)
    await writeFile(
      nightlyStatePath(workdir),
      JSON.stringify({ last_run: "not-a-date" }, null, 2) + "\n",
      "utf8",
    );
    expect(await shouldRunCatchupNightly(workdir)).toBe(true);
  });

  test("returns false exactly at the window boundary", async () => {
    // Pin Date.now() so the boundary check is deterministic — without this,
    // elapsed time between the two Date.now() calls (here vs inside
    // shouldRunCatchupNightly) pushes `now - lastRun` past CATCHUP_WINDOW_MS
    // and the strict `>` comparison flips true.
    const fixedNow = Date.now();
    const origNow = Date.now;
    Date.now = () => fixedNow;
    try {
      const atBoundary = new Date(fixedNow - CATCHUP_WINDOW_MS);
      await saveNightlyState(workdir, {
        last_run: atBoundary.toISOString(),
      });
      // Exactly at boundary: still within window (strictly greater than)
      expect(await shouldRunCatchupNightly(workdir)).toBe(false);
    } finally {
      Date.now = origNow;
    }
  });
});

describe("buildNightlyPromptForPersona — override", () => {
  test("returns the built-in prompt when no override file exists", async () => {
    const built = await buildNightlyPromptForPersona(
      workdir,
      "kai",
      "2026-05-02",
    );
    expect(built).toContain("PHASE 5");
    expect(built).toContain("persona 'kai'");
  });

  test("uses the override file with {{persona}} / {{today}} substitution", async () => {
    await writeFile(
      join(workdir, "nightly-prompt.md"),
      "Hey {{persona}}, today is {{today}}. Do the thing.",
      "utf8",
    );
    const built = await buildNightlyPromptForPersona(
      workdir,
      "robbie",
      "2026-05-02",
    );
    expect(built).toBe("Hey robbie, today is 2026-05-02. Do the thing.");
  });
});

describe("nightly checkpoint — progress file", () => {
  test("loadNightlyProgress returns null when no file exists", async () => {
    expect(await loadNightlyProgress(workdir)).toBeNull();
  });

  test("save then load round-trips", async () => {
    const progress: NightlyProgress = {
      date: "2026-05-18",
      started_at: "2026-05-18T02:00:00.000Z",
      updated_at: "2026-05-18T02:03:00.000Z",
      completed_stages: ["essence", "promote"],
      status: "in_progress",
    };
    await saveNightlyProgress(workdir, progress);
    expect(await loadNightlyProgress(workdir)).toEqual(progress);
  });

  test("clearNightlyProgress removes the file", async () => {
    await saveNightlyProgress(workdir, {
      date: "2026-05-18",
      started_at: "x",
      updated_at: "x",
      completed_stages: [],
      status: "in_progress",
    });
    await clearNightlyProgress(workdir);
    expect(await loadNightlyProgress(workdir)).toBeNull();
  });

  test("clearNightlyProgress is a no-op when there is no file", async () => {
    await clearNightlyProgress(workdir); // must not throw
    expect(await loadNightlyProgress(workdir)).toBeNull();
  });
});

describe("pendingNightlyStages", () => {
  test("returns every stage when resume is false", async () => {
    expect(await pendingNightlyStages(workdir, "2026-05-18", false)).toEqual([
      ...NIGHTLY_STAGES,
    ]);
  });

  test("returns every stage when resume is true but no checkpoint", async () => {
    expect(await pendingNightlyStages(workdir, "2026-05-18", true)).toEqual([
      ...NIGHTLY_STAGES,
    ]);
  });

  test("skips completed stages when checkpoint matches today", async () => {
    await saveNightlyProgress(workdir, {
      date: "2026-05-18",
      started_at: "x",
      updated_at: "x",
      completed_stages: ["essence", "promote"],
      status: "partial",
    });
    expect(await pendingNightlyStages(workdir, "2026-05-18", true)).toEqual([
      "kb",
      "compress",
      "state",
    ]);
  });

  test("ignores a stale checkpoint from a different date", async () => {
    await saveNightlyProgress(workdir, {
      date: "2026-05-17",
      started_at: "x",
      updated_at: "x",
      completed_stages: ["essence", "promote", "kb"],
      status: "partial",
    });
    expect(await pendingNightlyStages(workdir, "2026-05-18", true)).toEqual([
      ...NIGHTLY_STAGES,
    ]);
  });
});

describe("buildNightlyStagePrompt", () => {
  test("embeds persona, date and the isolation/checkpoint notes", () => {
    const p = buildNightlyStagePrompt("robbie", "2026-05-18", "essence");
    expect(p).toContain("persona 'robbie'");
    expect(p).toContain("2026-05-18");
    expect(p).toContain("CHECKPOINTED");
    expect(p).toContain("system:nightly:2026-05-18");
  });

  test("each stage carries its own distinct instruction body", () => {
    const bodies = NIGHTLY_STAGES.map((s) =>
      buildNightlyStagePrompt("robbie", "2026-05-18", s),
    );
    expect(bodies[0]).toContain("DAY ESSENCE");
    expect(bodies[1]).toContain("PROMOTE TO DRAWERS");
    expect(bodies[2]).toContain("FEED THE KB");
    expect(bodies[3]).toContain("COMPRESS MEMORY.md");
    expect(bodies[4]).toContain("STATE REPORT");
  });
});
