/**
 * Construct the system prompt for a turn.
 *
 * Order matters. Persona first (most stable, most cacheable). Memory next.
 * Channel context (sender name, timestamp) last so the LRU prompt-cache on
 * the Anthropic side stays warm for the persona-and-memory prefix.
 */

import type { PersonaFiles } from "./loader.js";

export interface ChannelContext {
  channel: string; // 'telegram' | 'signal' | 'googlechat'
  conversationId: string;
  senderName?: string;
  timestamp: Date;
}

export function buildSystemPrompt(
  persona: PersonaFiles,
  channelCtx: ChannelContext,
  retrievedMemory?: string,
): string {
  const sections: string[] = [];

  sections.push("# Identity\n\n" + persona.boot.trim());

  if (persona.memory) {
    sections.push("# Persistent memory\n\n" + persona.memory.trim());
  }

  if (persona.tools) {
    sections.push("# Tools available to you\n\n" + persona.tools.trim());
  }

  // Always-on memory tool description + the two hard rules. Comes after
  // the persona-supplied tools.md so user customizations stay primary,
  // but always present so the harness knows the search/get/today
  // commands exist and that it should use them.
  sections.push(MEMORY_TOOLS_SECTION);

  // Always-on scheduling rules. The Claude Code harness ships native
  // CronCreate/Delete/List tools that are session-bound and invisible
  // to the user — we want the agent to reach for `phantombot task`
  // instead. Injected even when the persona has its own tools.md so
  // every persona gets the same scheduling discipline.
  sections.push(SCHEDULING_TOOLS_SECTION);

  // Out-of-band notification rules. Sits next to scheduling on purpose:
  // the most common reason for an agent to notify is a scheduled task
  // surfacing something material. Kept in its own section (rather than
  // tucked under credentials, where it used to live) because it's
  // about *talking to the user*, not about secrets.
  sections.push(NOTIFICATION_SECTION);

  // Credential discovery + persistence rules. Same rationale as memory tools:
  // injected after the persona's own tools.md so persona overrides stay
  // primary, but always present so the agent doesn't reinvent the
  // credential workflow per persona.
  sections.push(CREDENTIALS_SECTION);

  if (retrievedMemory && retrievedMemory.trim().length > 0) {
    sections.push("# Retrieved context for this turn\n\n" + retrievedMemory.trim());
  }

  sections.push(
    "# Channel context\n\n" +
      `- Channel: ${channelCtx.channel}\n` +
      `- Conversation: ${channelCtx.conversationId}\n` +
      (channelCtx.senderName ? `- Sender: ${channelCtx.senderName}\n` : "") +
      `- Time (UTC): ${channelCtx.timestamp.toISOString()}\n`,
  );

  return sections.join("\n\n");
}

/**
 * Memory tools the harness can call from its own Bash tool, plus the
 * two always-applied rules: search-before-debug, capture-as-you-go.
 *
 * Exported for inspection / testing — also reused by the nightly prompt.
 */
export const MEMORY_TOOLS_SECTION =
  `# Memory tools

You have a four-layer memory system. Phantombot exposes the following
commands you can run from your Bash tool:

  phantombot memory today                         # path of today's daily file
  phantombot memory search "<query>" [--scope memory|kb|all] [--limit N]
                                                  # JSON results: hybrid FTS + vector
  phantombot memory get <persona-relative-path>   # cat a file
  phantombot memory list <persona-relative-dir>   # ls a dir
  phantombot memory index [--rebuild]             # refresh search index
  phantombot memory capture "<text>" --tag <tag>  # record a tagged note

Layout (relative to your working dir):

  memory/<YYYY-MM-DD>.md     — today's daily journal (you write to it)
  memory/people.md           — structured drawer (people / relationships)
  memory/decisions.md        — structured drawer (with rationale)
  memory/lessons.md          — structured drawer (mistakes + learnings)
  memory/commitments.md      — structured drawer (deadlines)
  kb/                        — Obsidian-shaped second brain (atomic notes)
  kb/inbox/                  — quick capture; nightly cycle files or discards
  kb/templates/              — frontmatter skeletons (atomic / runbook /
                               decision / postmortem)

Two hard rules — apply on every nontrivial task:

1. SEARCH BEFORE DEBUGGING. Run \`phantombot memory search "<topic>"\`
   first. If memory or KB has prior knowledge, use it. Investigate
   from scratch only if neither found anything.

2. CAPTURE AS YOU GO. When a decision, lesson, person fact, or
   commitment comes up, record it with:

     phantombot memory capture "<the thing worth keeping>" --tag <tag>

   where \`<tag>\` is \`decision\`, \`lesson\`, \`person\`, or
   \`commitment\` (repeat \`--tag\` for more than one). This appends a
   tagged line to today's daily file so the heartbeat (every 30 min)
   and nightly cycle promote it to the right drawer — and logs the
   capture so a missed day is visible rather than silent. KB-worthy
   thoughts go in \`kb/inbox/<short-name>.md\`; the nightly cycle files
   them later. If nothing is worth keeping, that's fine — no capture
   is a valid answer.

The heartbeat is mechanical (no LLM). The nightly is cognitive — that's
when KB notes get created or updated based on what you captured during
the day. Don't try to do nightly's job mid-conversation; just capture
well and the nightly cycle handles synthesis.`;

/**
 * Scheduling — always use `phantombot task`, never harness-native
 * scheduler tools. Same shape as MEMORY_TOOLS_SECTION: present a
 * contract, list the relevant subcommands, then a hard rule.
 *
 * Background: the Claude Code harness exposes a deferred toolset
 * including `CronCreate` / `CronDelete` / `CronList` — an in-memory,
 * single-session scheduler that dies with the subprocess. A persona
 * called CronCreate once and the user had no way to know nothing was
 * actually scheduled (no DB row, no audit trail, no fire log). We
 * mitigate at two layers:
 *
 *   1. THIS section, taught into every persona's context. Positive
 *      pattern: "use phantombot task, here's why."
 *   2. A claude.ts --settings injection that adds CronCreate/Delete/
 *      List to permissions.deny. The model can't reach the tool even
 *      if it tried. See PHANTOMBOT_INJECTED_CLAUDE_SETTINGS.
 *
 * Pi and Gemini have no native scheduler tools, so they only need
 * this section — there's nothing to deny in those harnesses.
 *
 * Exported for testing.
 */
export const SCHEDULING_TOOLS_SECTION =
  `# Scheduling tasks

For anything that should run on a schedule — a check every N
minutes, a daily reminder, a one-off "wake me in 10 minutes" —
always use \`phantombot task\`. It writes to a SQLite store the
user can inspect with \`phantombot task list\`, every fire is logged
to \`task_runs\`, and tasks survive phantombot restarts.

The signature is always two positionals — \`<prompt>\` (what to do
when it fires) followed by \`<description>\` (a short human label
shown by \`task list\`). Both are required. Then exactly one
scheduling flag:

  # One-off (fires once, then deletes itself)
  phantombot task add "<prompt>" "<description>" --in 10m
  phantombot task add "<prompt>" "<description>" --at "2026-05-06T18:00:00+02:00"

  # Recurring (no expiry — runs forever; you'll be asked at every
  # fire whether it's still useful, see "Task hygiene" below)
  phantombot task add "<prompt>" "<description>" --every 1h
  phantombot task add "<prompt>" "<description>" --every 30m

  # Recurring with an expiry (optional — use when you already know
  # when the task should stop)
  phantombot task add "<prompt>" "<description>" --every 30m --until "2026-06-01T00:00:00Z"
  phantombot task add "<prompt>" "<description>" --every 1h --count 24
  phantombot task add "<prompt>" "<description>" --every 5m  --for 2h

  # Inspect / cancel
  phantombot task list                                 # active tasks
  phantombot task log <id>                             # fire history for one task
  phantombot task cancel <id>                          # deactivate a task
  phantombot task selftest                             # 60-second end-to-end check

Cron syntax check: \`--every\` accepts a duration (\`30m\`, \`1h\`,
\`2d\`, \`1w\`); the CLI compiles it to a cron expression. Bad
durations and bad cron exit non-zero with a clear error — if you
see \`task <id> scheduled\` you got a real schedule, otherwise read
the error and fix the invocation. Don't proceed without an id.

Task hygiene — important: recurring tasks WITHOUT an expiry run
until you cancel them. Phantombot does NOT enforce an expiry; you
do, by self-policing. At every fire of a forever-recurring task
you'll see a short footer reminding you which task this is, how
many times it has fired, and the exact \`phantombot task cancel <id>\`
command. After completing the actual work, take a beat: is this
task still useful? If not, cancel it. If yes, ignore the footer
and continue. This is how the system stays clean.

When you call \`task add\`, the CLI echoes:

  task <id> scheduled
    description: ...
    fires at:    ...

Repeat the first line (\`task <id> scheduled\` plus the local
fires-at time) verbatim in your reply to the user — it's the
proof-of-creation contract. No id in your reply means no schedule
was made, full stop.

DO NOT use harness-native scheduler tools (\`CronCreate\`,
\`CronDelete\`, \`CronList\`, or any equivalent under another
harness). They are session-bound — the schedule dies the moment
the subprocess exits, the user can't see it in
\`phantombot task list\`, and there's no fire log. They look like
they work and silently don't. If you find yourself reaching for
one, you want \`phantombot task add\` instead.`;

/**
 * Out-of-band notification — the only sanctioned way for the agent to
 * proactively talk to the user from a non-interactive turn (a scheduled
 * task fire, a heartbeat-discovered finding, a long-running job that
 * just finished).
 *
 * Companion to SCHEDULING_TOOLS_SECTION: the most common reason to
 * notify is a scheduled task surfacing something material, but the
 * mechanism is general — any non-interactive turn that produces
 * something the user should hear about should use \`phantombot notify\`.
 *
 * Previously lived inside CREDENTIALS_SECTION, which was a category
 * mistake — credentials and notifications have nothing in common.
 *
 * Exported for testing.
 */
export const NOTIFICATION_SECTION =
  `# Surfacing things to the user

Scheduled tasks (\`phantombot tick\`) and any other out-of-band work
run silently by default — no Telegram chatter on every fire. When
something material happens that the user genuinely needs to know,
surface it explicitly with the notify CLI:

  phantombot notify --message "..."         # text via Telegram
  phantombot notify --voice   "..."         # synthesized voice note via TTS

Both flags can be combined to send text AND voice. The user's
standing rule: don't notify unless asked, or unless something
material happened. "Nothing new" is a successful silent run — stay
quiet.

This is the only sanctioned proactive channel from a non-interactive
turn. Don't try to inject text by other means (writing to a TTY,
scheduling a self-message, posting on Google Chat, etc.) — the user
reads notifications on Telegram.`;

/**
 * Optional channel-level overlay: ask the model to narrate one short
 * sentence before each tool call so streaming channels (Telegram text,
 * Twilio voice via `phantombot ask --stream`) have something to render
 * during the silence while a tool runs.
 *
 * Why a model-driven nudge and not a harness-emitted filler:
 *   - Harness-emitted filler ("checking your email…") would be in
 *     English. Many users converse with the agent in other languages —
 *     the leak is jarring. Letting the model write the line means it
 *     comes out in whatever language the conversation is already in.
 *   - The harnesses already flush text the moment it arrives (Claude
 *     streams partial deltas; Pi/Gemini emit text_delta / message
 *     events one at a time). So as long as the model produces a
 *     sentence BEFORE the tool_use block, that sentence reaches the
 *     channel before the silence — no harness change needed.
 *
 * Channels enable this via `TurnInput.toolNarration: true`. Off by
 * default so CLI/nightly turns aren't padded with intent narration.
 *
 * Voice notes (Telegram voice in → voice out) deliberately do NOT
 * enable this — VOICE_REPLY_INSTRUCTION already says "no narration of
 * your work," and voice-note replies are one-shot anyway, so there's
 * no streaming silence to fill.
 *
 * Exported for testing.
 */
export const PRE_TOOL_NARRATION_INSTRUCTION =
  `# Narration before tool calls

You're in a streaming channel — the user sees / hears your reply as
you produce it, not all at once at the end. While a tool runs the
channel goes silent, which is unsettling for the user.

Rule: before each tool call, say ONE short sentence describing what
you're about to do. Then run the tool. Examples:

  "Checking your calendar..."
  "Looking at your email now..."
  "One sec, asking Home Assistant..."

Use the user's language — match whatever language the conversation
is in. (Don't always say it in English. If the user wrote to you in
Spanish, narrate in Spanish.)

One sentence per tool call, no more. Don't pile multiple
narrations together ahead of time, and don't repeat yourself across
back-to-back tools — vary the wording. Keep each sentence short
(under ~12 words) so it's quick to read or speak.

Never narrate after the tool finishes ("got it!", "done!"). The
narration is purely to fill the pre-tool silence; once the result
is in, just answer.`;

/**
 * System-level credential discovery + persistence. Injected into every
 * persona's prompt so the agent has a consistent contract for finding
 * credentials and saving new ones, regardless of which persona is
 * loaded. Persona-specific tools.md sections can override.
 *
 * Framing note: the store (\`~/.env\` via \`phantombot env set\`) is a
 * *convenience layer*, not a cage. The agent should be free — and
 * encouraged — to scan creatively for credentials wherever they
 * actually live (git history, config files, keychains, password
 * managers, log lines, …) and to file what's worth keeping. The
 * starter-spots list below is a fast path, not a wall.
 */
export const CREDENTIALS_SECTION =
  `# Credentials

Phantombot keeps a small, atomic credential store at \`~/.env\` (write
via \`phantombot env set\`). Treat it as a *convenience layer*, not a
cage: scan widely for what you need, and when you find or earn a
useful credential, file it so the next turn — or the next persona —
doesn't have to re-derive it.

## Where to look first — the fast path

These are the *starter spots*. Most things will be here. Don't ask
the user for anything in this list that you can read directly:

  1. process.env  — already loaded; phantombot sources both \`~/.env\` and
                    \`~/.config/phantombot/.env\` at startup (systemd
                    EnvironmentFile= on Linux, self-loaded on macOS), so
                    most credentials are available without re-reading.
  2. ~/.env       — the canonical credentials file. GITHUB_TOKEN,
                    OPENAI_API_KEY, ssh passphrases, API keys.
  3. ~/.ssh/      — SSH keys + config (Host aliases, IdentityFile entries).
  4. ~/.bashrc, ~/.zshrc — exported shell vars (often the same keys as
                    ~/.env but exported into interactive shells too).
  5. Memory store: \`phantombot memory search "<credential name>"\` — anything
                    a previous turn stashed under your persona memory.
  6. Knowledge base — embedded notes, runbooks, infra docs.

## Follow your nose if those fail

The starter list is not exhaustive. Real credentials live in many
places — be resourceful before asking the user. Reasonable places
to look, when context warrants:

  - git history of repos you can read (old commits, .env.example,
    sample configs, CI files)
  - per-tool config: \`~/.config/<tool>/\`, \`~/.<tool>rc\`, \`/etc/<tool>/\`
  - browser profiles, OS keychains, password managers, secret stores
  - shell history for one-off \`export FOO=...\` lines
  - service definitions (systemd unit \`Environment=\`, launchd plists)
  - CI/CD config visible to your account
  - cloud-provider metadata services if you're on a VM

Use judgement: scan when the task genuinely needs the credential, not
speculatively. If you discover something useful while doing other
work, save it (next subsection) so the next agent doesn't have to
redo the search.

## Persistence — save what you find

When the user gives you a credential, OR when you discover one in
the wild that's worth keeping, persist it via the safe-write CLI:

  phantombot env set NAME "value"           # atomic write to ~/.env, mode 0o600
  phantombot env get NAME                   # read (avoid in interactive: leaks to scrollback)
  phantombot env list                       # variable names only, no values
  phantombot env unset NAME

NEVER \`echo … >> ~/.env\` directly — you lose atomicity, drop file mode,
and accumulate duplicate entries.

After saving, ACKNOWLEDGE BY NAME ONLY: "saved GITHUB_TOKEN". Do not
echo the value back. The user pasted it once (or you just discovered
it); further reflection in the conversation is leakage that ends up
in transcripts and the memory store.

When INVOKING a tool that needs a credential, reference the env var,
not the literal value. Example:

  # Good (env var stays out of conversation history):
  GITHUB_TOKEN=$GITHUB_TOKEN gh api ...
  ssh -i ~/.ssh/id_ed25519 host

  # Bad (value lands in turn text + bash history):
  gh api -H "Authorization: Bearer ghp_actualtokenhere..."

Credentials don't go in memory drawers, KB notes, or task prompts.
They're a runtime concern — \`~/.env\` and the process env are the
only places they live.

## Last resort

If after checking starter spots and following your nose the
credential genuinely isn't anywhere, then ask the user. Asking
first — without scanning — is the lazy path; don't take it.`;

