/**
 * Citty dispatcher. The phantombot command surface is intentionally small:
 *
 *   import-persona  - copy an OpenClaw agent dir + telegram config in
 *   create-persona  - TUI to make a new persona from scratch
 *   telegram        - TUI to configure the Telegram channel
 *   harness         - TUI to choose primary + fallback harnesses
 *   install         - install systemd --user unit so phantombot survives logout
 *   uninstall       - remove the systemd unit
 *   run             - run the bot in the foreground (Ctrl-C to stop)
 *   ask             - one-shot prompt through the persona + harness chain
 *
 * Dev/debug commands (chat, history, list-personas, etc.) were removed
 * as part of the v0.1 surface lock. `ask` was reintroduced for external
 * programs that want Robbie's brain as a non-interactive tool (e.g. the
 * Twilio voice-agent's `askRobbie` relay). `doctor` was reintroduced as
 * the memory-subsystem health check + nightly auto-repair.
 */

import { defineCommand } from "citty";
import { VERSION } from "../version.ts";
import askCmd from "./ask.ts";
import personaCmd from "./persona.ts";
import telegramCmd from "./telegram.ts";
import harnessCmd from "./harness.ts";
import installCmd from "./install.ts";
import uninstallCmd from "./uninstall.ts";
import initCmd from "./init.ts";
import runCmd from "./run.ts";
import memoryCmd from "./memory.ts";
import embeddingCmd from "./embedding.ts";
import heartbeatCmd from "./heartbeat.ts";
import nightlyCmd from "./nightly.ts";
import doctorCmd from "./doctor.ts";
import envCmd from "./env.ts";
import notifyCmd from "./notify.ts";
import taskCmd from "./task.ts";
import tickCmd from "./tick.ts";
import updateCmd from "./update.ts";
import voiceCmd from "./voice.ts";

export const mainCommand = defineCommand({
  meta: {
    name: "phantombot",
    version: VERSION,
    description:
      "Giving the harness a Soul. The harness can do its own tools — let it. Personality-first chat agent CLI.",
  },
  subCommands: {
    persona: personaCmd,
    telegram: telegramCmd,
    harness: harnessCmd,
    embedding: embeddingCmd,
    env: envCmd,
    init: initCmd,
    install: installCmd,
    uninstall: uninstallCmd,
    run: runCmd,
    ask: askCmd,
    memory: memoryCmd,
    notify: notifyCmd,
    heartbeat: heartbeatCmd,
    nightly: nightlyCmd,
    doctor: doctorCmd,
    task: taskCmd,
    tick: tickCmd,
    update: updateCmd,
    voice: voiceCmd,
  },
});
