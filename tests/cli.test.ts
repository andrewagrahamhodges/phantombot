/**
 * Smoke test for the Citty dispatcher.
 *
 * Verifies the CLI compiles, the main command is defined, and every
 * planned subcommand is wired in. Does NOT execute any subcommand —
 * those will get their own tests as they're implemented.
 */

import { describe, expect, test } from "bun:test";
import { mainCommand } from "../src/cli/index.ts";

describe("phantombot CLI dispatcher", () => {
  test("main command is defined with the expected meta", async () => {
    const meta = await resolveMeta(mainCommand);
    expect(meta?.name).toBe("phantombot");
    expect(meta?.version).toBeDefined();
  });

  test("all planned subcommands are wired in", () => {
    const subs = mainCommand.subCommands ?? {};
    const names = Object.keys(subs).sort();
    expect(names).toEqual([
      "ask",
      "doctor",
      "embedding",
      "env",
      "harness",
      "heartbeat",
      "init",
      "install",
      "memory",
      "nightly",
      "notify",
      "persona",
      "run",
      "task",
      "telegram",
      "tick",
      "uninstall",
      "update",
      "voice",
    ]);
  });
});

// Citty's `meta` may be a value, a function returning a value, or a function
// returning a Promise. Normalize to a plain object for assertions.
async function resolveMeta(cmd: typeof mainCommand) {
  const m = cmd.meta;
  if (typeof m === "function") return await m();
  return m;
}
