/**
 * `phantombot memory` — tools for the harness's own use.
 *
 * Subcommands the harness can call from its Bash tool:
 *
 *   phantombot memory search "<query>" [--scope memory|kb|all] [--limit N]
 *                              JSON to stdout: hits with path, snippet, score
 *   phantombot memory get <path>
 *                              cat a persona-relative file (validates path
 *                              is inside personasDir/<persona>/)
 *   phantombot memory list <subdir>
 *                              list files in a persona-relative subdir
 *   phantombot memory today
 *                              print today's daily-file path (creates the
 *                              directory if missing — returns the path
 *                              unconditionally so the harness can write to it)
 *   phantombot memory index [--rebuild]
 *                              rebuild the FTS5 index (incremental by default)
 *   phantombot memory capture "<text>" --tag <tag> [--tag <tag> ...]
 *                              append a tagged line to today's daily file
 *                              and record the capture in capture_log
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { type Config, loadConfig, personaDir } from "../config.ts";
import { defaultEmbedder, runEmbedJob } from "../lib/embedJob.ts";
import { geminiEmbed } from "../lib/geminiEmbed.ts";
import { TAG_TO_DRAWER } from "../lib/heartbeat.ts";
import type { WriteSink } from "../lib/io.ts";
import { MemoryIndex, type Scope } from "../lib/memoryIndex.ts";
import { openMemoryStore } from "../memory/store.ts";

function indexPath(_config: Config, persona: string): string {
  // One index file per persona — easier to rebuild a single persona without
  // touching others, and easier to reason about scope.
  return join(
    process.env.XDG_DATA_HOME || join(process.env.HOME ?? "", ".local/share"),
    "phantombot",
    "memory-index",
    `${persona}.sqlite`,
  );
}

function resolvePersonaDir(config: Config, persona?: string): {
  persona: string;
  dir: string;
} {
  const name = persona ?? config.defaultPersona;
  return { persona: name, dir: personaDir(config, name) };
}

/**
 * Validate that `relPath` resolves to a file/dir INSIDE the persona dir.
 * Refuses absolute paths and `..` traversals so the harness can't
 * accidentally read/write outside the agent's workspace.
 */
function safeJoin(personaDir: string, relPath: string): string | null {
  if (isAbsolute(relPath)) return null;
  const candidate = resolve(personaDir, relPath);
  const r = relative(personaDir, candidate);
  if (r.startsWith("..") || isAbsolute(r)) return null;
  return candidate;
}

export interface RunMemoryInput {
  config?: Config;
  out?: WriteSink;
  err?: WriteSink;
}

export interface RunSearchInput extends RunMemoryInput {
  query: string;
  persona?: string;
  scope?: Scope | "all";
  limit?: number;
  /** Override the index path for testing. */
  indexPath?: string;
}

export async function runMemorySearch(
  input: RunSearchInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const { persona, dir } = resolvePersonaDir(config, input.persona);

  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const ix = await MemoryIndex.open(input.indexPath ?? indexPath(config, persona));
  try {
    await ix.refreshStale(dir);

    // If embeddings are configured AND there are stored vectors, do a
    // hybrid search. Otherwise fall back to FTS-only.
    let queryVec: Float32Array | undefined;
    if (
      config.embeddings.provider === "gemini" &&
      config.embeddings.gemini?.apiKey &&
      ix.embeddingCount() > 0
    ) {
      const r = await geminiEmbed(
        config.embeddings.gemini.apiKey,
        input.query,
        {
          model: config.embeddings.gemini.model,
          dims: config.embeddings.gemini.dims,
        },
      );
      if (r.ok) queryVec = r.values;
      else err.write(`(query embed failed: ${r.error}; falling back to FTS-only)\n`);
    }

    const hits = queryVec
      ? ix.hybridSearch(input.query, queryVec, {
          scope: input.scope,
          limit: input.limit,
        })
      : ix.search(input.query, {
          scope: input.scope,
          limit: input.limit,
        });
    out.write(JSON.stringify({ persona, query: input.query, results: hits }, null, 2));
    out.write("\n");
  } finally {
    ix.close();
  }
  return 0;
}

export interface RunGetInput extends RunMemoryInput {
  path: string;
  persona?: string;
}

export async function runMemoryGet(input: RunGetInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const { dir } = resolvePersonaDir(config, input.persona);

  const target = safeJoin(dir, input.path);
  if (!target) {
    err.write(`refusing path outside persona dir: ${input.path}\n`);
    return 2;
  }
  if (!existsSync(target)) {
    err.write(`not found: ${relative(dir, target)}\n`);
    return 1;
  }
  const file = Bun.file(target);
  out.write(await file.text());
  return 0;
}

export interface RunListInput extends RunMemoryInput {
  path: string;
  persona?: string;
}

export async function runMemoryList(input: RunListInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const { dir } = resolvePersonaDir(config, input.persona);

  const target = safeJoin(dir, input.path);
  if (!target) {
    err.write(`refusing path outside persona dir: ${input.path}\n`);
    return 2;
  }
  if (!existsSync(target)) {
    err.write(`not found: ${relative(dir, target)}\n`);
    return 1;
  }
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(target, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    out.write(`${e.isDirectory() ? "d" : "f"}  ${e.name}\n`);
  }
  return 0;
}

export interface RunTodayInput extends RunMemoryInput {
  persona?: string;
  /** Override "today" for testing. ISO date YYYY-MM-DD. */
  date?: string;
}

export async function runMemoryToday(
  input: RunTodayInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const { persona, dir } = resolvePersonaDir(config, input.persona);

  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const memDir = join(dir, "memory");
  await mkdir(memDir, { recursive: true });
  const path = join(memDir, `${date}.md`);
  out.write(path);
  out.write("\n");
  return 0;
}

export interface RunIndexInput extends RunMemoryInput {
  persona?: string;
  rebuild?: boolean;
  indexPath?: string;
}

export interface RunIndexInputV2 extends RunIndexInput {
  /** Skip the embedding pass even when a provider is configured. */
  noEmbed?: boolean;
}

export async function runMemoryIndex(
  input: RunIndexInputV2,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const { persona, dir } = resolvePersonaDir(config, input.persona);

  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const ix = await MemoryIndex.open(input.indexPath ?? indexPath(config, persona));
  try {
    const ftsResult = input.rebuild
      ? { ...(await ix.rebuild(dir)), removed: 0 }
      : await ix.refreshStale(dir);
    out.write(
      `${input.rebuild ? "rebuilt" : "refreshed"} FTS index for '${persona}': ` +
        `${ftsResult.indexed} file(s) (re)indexed` +
        (ftsResult.removed > 0 ? `, ${ftsResult.removed} removed` : "") +
        `\n`,
    );

    if (input.noEmbed) {
      out.write(`(skipping embedding pass; --no-embed)\n`);
      return 0;
    }
    const embedder = defaultEmbedder(config);
    if (!embedder) {
      out.write(
        `(embeddings provider is "${config.embeddings.provider}"; ` +
          `run \`phantombot embedding\` to set up Gemini)\n`,
      );
      return 0;
    }

    out.write(`embedding…\n`);
    const r = await runEmbedJob({
      personaDir: dir,
      index: ix,
      embedder,
      force: input.rebuild,
    });
    out.write(
      `embedded ${r.embedded}, skipped ${r.skipped} (sha match), ` +
        `failed ${r.failed} of ${r.totalNotes} notes\n`,
    );
    if (r.failed > 0) {
      for (const e of r.errors.slice(0, 5)) {
        err.write(`  ${e.path}#${e.chunkIdx}: ${e.error}\n`);
      }
      if (r.errors.length > 5) {
        err.write(`  ...and ${r.errors.length - 5} more\n`);
      }
    }
  } finally {
    ix.close();
  }
  return 0;
}

export interface RunCaptureInput extends RunMemoryInput {
  text: string;
  tags: string[];
  persona?: string;
  /** Conversation key the capture belongs to. Default: cli:default. */
  conversation?: string;
  /** Override "today" for testing. ISO date YYYY-MM-DD. */
  date?: string;
  /** Override "now" for the line timestamp (testing). */
  now?: Date;
}

/**
 * `phantombot memory capture` — append one tagged line per tag to today's
 * daily file and record the capture in `capture_log`.
 *
 * Gives the capture protocol the same observable shape every other
 * harness-facing tool has: a command, a log line, an exit code. The line
 * leads with the tag (`- [decision] … · 09:34Z`) so the heartbeat
 * promotion regex matches and the timestamp lands at the end where it
 * won't break the `[a-z]+` tag capture.
 */
export async function runMemoryCapture(
  input: RunCaptureInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const { persona, dir } = resolvePersonaDir(config, input.persona);

  if (!existsSync(dir)) {
    err.write(`persona '${persona}' not found at ${dir}\n`);
    return 2;
  }

  const text = input.text.trim();
  if (text.length === 0) {
    err.write("memory capture: empty text\n");
    return 2;
  }

  const tags = input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tags.length === 0) {
    err.write("memory capture: at least one --tag is required\n");
    return 2;
  }
  for (const tag of tags) {
    if (!TAG_TO_DRAWER[tag]) {
      err.write(
        `memory capture: unknown tag '${tag}'. ` +
          `Valid tags: ${Object.keys(TAG_TO_DRAWER).sort().join(", ")}\n`,
      );
      return 2;
    }
  }

  const now = input.now ?? new Date();
  const date = input.date ?? now.toISOString().slice(0, 10);
  const memDir = join(dir, "memory");
  await mkdir(memDir, { recursive: true });
  const dailyPath = join(memDir, `${date}.md`);

  // Create today's daily file with a one-line header if it doesn't exist.
  if (!existsSync(dailyPath)) {
    await Bun.write(dailyPath, `# ${date}\n`);
  }

  // HH:MMZ — appended at the END of the line so the heartbeat tag regex
  // (/^\s*-?\s*\[([a-z]+)\]\s+(.+)$/i) still matches.
  const stamp = `${now.toISOString().slice(11, 16)}Z`;
  let block = "";
  for (const tag of tags) {
    block += `- [${tag}] ${text} · ${stamp}\n`;
  }
  await appendFile(dailyPath, block, "utf8");

  // Record the capture so the nudge counter and `doctor` can see it.
  const conversation = input.conversation ?? "cli:default";
  const store = await openMemoryStore(config.memoryDbPath);
  try {
    await store.appendCapture({ persona, conversation, tags });
  } finally {
    await store.close();
  }

  out.write(
    `memory capture: tags=${tags.join(",")} conv=${conversation} ` +
      `persona=${persona} ok\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Citty subcommand wiring
// ---------------------------------------------------------------------------

const searchCmd = defineCommand({
  meta: { name: "search", description: "Hybrid (FTS5 today; +vec in phase 25) search across memory/ and kb/." },
  args: {
    query: {
      type: "positional",
      description: "What to search for.",
      required: true,
    },
    persona: { type: "string", description: "Persona name (default: configured default)." },
    scope: {
      type: "string",
      description: "memory | kb | all (default: all)",
      default: "all",
    },
    limit: { type: "string", description: "max results (default 5)", default: "5" },
  },
  async run({ args }) {
    const limit = Number(args.limit);
    process.exitCode = await runMemorySearch({
      query: String(args.query),
      persona: args.persona ? String(args.persona) : undefined,
      scope: (String(args.scope) as Scope | "all") ?? "all",
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5,
    });
  },
});

const getCmd = defineCommand({
  meta: { name: "get", description: "Cat a persona-relative file." },
  args: {
    path: { type: "positional", description: "Persona-relative path.", required: true },
    persona: { type: "string", description: "Persona name." },
  },
  async run({ args }) {
    process.exitCode = await runMemoryGet({
      path: String(args.path),
      persona: args.persona ? String(args.persona) : undefined,
    });
  },
});

const listCmd = defineCommand({
  meta: { name: "list", description: "List files in a persona-relative subdir." },
  args: {
    path: { type: "positional", description: "Persona-relative subdir.", required: true },
    persona: { type: "string", description: "Persona name." },
  },
  async run({ args }) {
    process.exitCode = await runMemoryList({
      path: String(args.path),
      persona: args.persona ? String(args.persona) : undefined,
    });
  },
});

const todayCmd = defineCommand({
  meta: { name: "today", description: "Print today's daily-file path (creates memory/ if absent)." },
  args: {
    persona: { type: "string", description: "Persona name." },
  },
  async run({ args }) {
    process.exitCode = await runMemoryToday({
      persona: args.persona ? String(args.persona) : undefined,
    });
  },
});

const indexCmd = defineCommand({
  meta: { name: "index", description: "Refresh FTS5 + embeddings (incremental by default; --rebuild for from-scratch; --no-embed to skip the vector pass)." },
  args: {
    persona: { type: "string", description: "Persona name." },
    rebuild: { type: "boolean", description: "Drop and re-index from scratch.", default: false },
    "no-embed": { type: "boolean", description: "Skip embedding pass (FTS only).", default: false },
  },
  async run({ args }) {
    process.exitCode = await runMemoryIndex({
      persona: args.persona ? String(args.persona) : undefined,
      rebuild: Boolean(args.rebuild),
      noEmbed: Boolean(args["no-embed"]),
    });
  },
});

const captureCmd = defineCommand({
  meta: {
    name: "capture",
    description:
      "Append a tagged line to today's daily file and record the capture (decision | lesson | person | commitment).",
  },
  args: {
    text: {
      type: "positional",
      description: "The thing worth keeping.",
      required: true,
    },
    tag: {
      type: "string",
      description:
        "Tag (decision | lesson | person | commitment). Repeatable for multi-tag.",
      required: true,
    },
    persona: { type: "string", description: "Persona name." },
    conversation: {
      type: "string",
      description: "Conversation key this capture belongs to (default cli:default).",
    },
  },
  async run({ args }) {
    // citty collapses repeated --tag into a string OR string[]; normalise.
    const rawTag = args.tag as unknown;
    const tags = Array.isArray(rawTag)
      ? rawTag.map(String)
      : [String(rawTag)];
    process.exitCode = await runMemoryCapture({
      text: String(args.text),
      tags,
      persona: args.persona ? String(args.persona) : undefined,
      conversation: args.conversation ? String(args.conversation) : undefined,
    });
  },
});

export default defineCommand({
  meta: {
    name: "memory",
    description:
      "Memory tools the harness can call from its Bash loop (search, get, list, today, index, capture).",
  },
  subCommands: {
    search: searchCmd,
    get: getCmd,
    list: listCmd,
    today: todayCmd,
    index: indexCmd,
    capture: captureCmd,
  },
});
