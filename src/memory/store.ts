/**
 * Memory store. SQLite-backed via bun:sqlite (no native compile, no extra deps).
 *
 * Schema is two tables:
 *   turns(id, persona, conversation, role, text, created_at)
 *   capture_log(id, persona, conversation, tags, created_at)
 *
 * `capture_log` records every `phantombot memory capture` invocation —
 * it gives the otherwise-invisible capture protocol a queryable trace
 * and backs the mechanical "N turns without a capture" nudge.
 *
 * Turns are scoped by (persona, conversation). The conversation key is
 * 'cli:default' for v1 — phantombot is a single-operator CLI tool, so all
 * CLI invocations share one conversation per persona. Per-channel scoping
 * (telegram:1234, signal:abc) is reserved for a future channels phase.
 *
 * Vector / FTS retrieval is deferred — the interface intentionally has no
 * vectorSearch() method. When/if added, prefer SQLite FTS5 (built into
 * the bun:sqlite-bundled sqlite) before reaching for sqlite-vec.
 */

import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type Role = "user" | "assistant";

export interface Turn {
  id: number;
  persona: string;
  conversation: string;
  role: Role;
  text: string;
  createdAt: Date;
}

export interface AppendTurnInput {
  persona: string;
  conversation: string;
  role: Role;
  text: string;
}

export interface AppendCaptureInput {
  persona: string;
  conversation: string;
  /** Tags applied to this capture (already validated by the caller). */
  tags: string[];
}

export interface MemoryStore {
  /** Persist one turn. Auto-stamps created_at to "now" UTC. */
  appendTurn(turn: AppendTurnInput): Promise<void>;
  /** Most recent N turns within (persona, conversation), oldest first. */
  recentTurns(
    persona: string,
    conversation: string,
    n: number,
  ): Promise<Array<{ role: Role; text: string }>>;
  /** Most recent N turns across all conversations for one persona, full rows, oldest first. */
  recentTurnsForDisplay(persona: string, n: number): Promise<Turn[]>;
  /** Delete all turns for a (persona, conversation) pair. Used by /reset. */
  deleteConversation(persona: string, conversation: string): Promise<number>;
  /** Record one `memory capture` invocation. Auto-stamps created_at UTC. */
  appendCapture(input: AppendCaptureInput): Promise<void>;
  /**
   * ISO timestamp of the most recent capture in (persona, conversation),
   * or undefined if this pair has never captured.
   */
  lastCaptureAt(
    persona: string,
    conversation: string,
  ): Promise<string | undefined>;
  /**
   * Count `role = 'user'` turns in (persona, conversation) with
   * `created_at > since`. Used by the mechanical capture nudge.
   */
  countUserTurnsSince(
    persona: string,
    conversation: string,
    since: string,
  ): Promise<number>;
  /**
   * Count capture_log rows for one persona with `created_at >= since`.
   * Used by `doctor` to detect a fully dry capture day.
   */
  countCapturesSince(persona: string, since: string): Promise<number>;
  /**
   * Count `role = 'user'` turns for one persona, across conversations
   * matching `conversationPrefix` (SQL LIKE-escaped), with
   * `created_at >= since`. Used by `doctor`'s capture-health check.
   */
  countUserTurnsForPersonaSince(
    persona: string,
    conversationPrefix: string,
    since: string,
  ): Promise<number>;
  /** Close the underlying SQLite connection. Safe to call once; idempotent thereafter. */
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  persona      TEXT NOT NULL,
  conversation TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_persona_conv_time
  ON turns (persona, conversation, created_at);
CREATE INDEX IF NOT EXISTS idx_turns_persona_time
  ON turns (persona, created_at);

CREATE TABLE IF NOT EXISTS capture_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  persona      TEXT NOT NULL,
  conversation TEXT NOT NULL,
  tags         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capture_persona_conv_time
  ON capture_log (persona, conversation, created_at);
`;

interface RawDisplayRow {
  id: number;
  persona: string;
  conversation: string;
  role: Role;
  text: string;
  created_at: string;
}

class SqliteMemoryStore implements MemoryStore {
  private appendStmt;
  private recentStmt;
  private recentDisplayStmt;
  private deleteStmt;
  private appendCaptureStmt;
  private lastCaptureStmt;
  private countTurnsSinceStmt;
  private countCapturesSinceStmt;
  private closed = false;

  constructor(private db: Database) {
    db.exec(SCHEMA);
    this.appendStmt = db.prepare(
      "INSERT INTO turns (persona, conversation, role, text, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    // Inner query gets most-recent-N descending; outer flips back to chronological.
    this.recentStmt = db.prepare(
      `SELECT role, text FROM (
         SELECT id, role, text, created_at
         FROM turns
         WHERE persona = ? AND conversation = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       ) ORDER BY created_at ASC, id ASC`,
    );
    this.recentDisplayStmt = db.prepare(
      `SELECT id, persona, conversation, role, text, created_at FROM (
         SELECT id, persona, conversation, role, text, created_at
         FROM turns
         WHERE persona = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       ) ORDER BY created_at ASC, id ASC`,
    );
    this.deleteStmt = db.prepare(
      "DELETE FROM turns WHERE persona = ? AND conversation = ?",
    );
    this.appendCaptureStmt = db.prepare(
      "INSERT INTO capture_log (persona, conversation, tags, created_at) VALUES (?, ?, ?, ?)",
    );
    this.lastCaptureStmt = db.prepare(
      `SELECT created_at FROM capture_log
       WHERE persona = ? AND conversation = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    this.countTurnsSinceStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM turns
       WHERE persona = ? AND conversation = ?
         AND role = 'user' AND created_at > ?`,
    );
    this.countCapturesSinceStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM capture_log
       WHERE persona = ? AND created_at >= ?`,
    );
  }

  async appendTurn(t: AppendTurnInput): Promise<void> {
    this.appendStmt.run(
      t.persona,
      t.conversation,
      t.role,
      t.text,
      new Date().toISOString(),
    );
  }

  async recentTurns(
    persona: string,
    conversation: string,
    n: number,
  ): Promise<Array<{ role: Role; text: string }>> {
    return this.recentStmt.all(persona, conversation, n) as Array<{
      role: Role;
      text: string;
    }>;
  }

  async recentTurnsForDisplay(persona: string, n: number): Promise<Turn[]> {
    const rows = this.recentDisplayStmt.all(persona, n) as RawDisplayRow[];
    return rows.map((r) => ({
      id: r.id,
      persona: r.persona,
      conversation: r.conversation,
      role: r.role,
      text: r.text,
      createdAt: new Date(r.created_at),
    }));
  }

  async appendCapture(input: AppendCaptureInput): Promise<void> {
    this.appendCaptureStmt.run(
      input.persona,
      input.conversation,
      input.tags.join(","),
      new Date().toISOString(),
    );
  }

  async lastCaptureAt(
    persona: string,
    conversation: string,
  ): Promise<string | undefined> {
    const row = this.lastCaptureStmt.get(persona, conversation) as
      | { created_at: string }
      | undefined;
    return row?.created_at;
  }

  async countUserTurnsSince(
    persona: string,
    conversation: string,
    since: string,
  ): Promise<number> {
    const row = this.countTurnsSinceStmt.get(persona, conversation, since) as {
      n: number;
    };
    return row.n;
  }

  async countCapturesSince(persona: string, since: string): Promise<number> {
    const row = this.countCapturesSinceStmt.get(persona, since) as {
      n: number;
    };
    return row.n;
  }

  async countUserTurnsForPersonaSince(
    persona: string,
    conversationPrefix: string,
    since: string,
  ): Promise<number> {
    // Escape LIKE wildcards in the caller-supplied prefix, then anchor it
    // with a trailing % so `telegram:` matches `telegram:123` etc.
    const escaped = conversationPrefix.replace(/[\\%_]/g, "\\$&");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM turns
         WHERE persona = ? AND role = 'user' AND created_at >= ?
           AND conversation LIKE ? ESCAPE '\\'`,
      )
      .get(persona, since, `${escaped}%`) as { n: number };
    return row.n;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  async deleteConversation(
    persona: string,
    conversation: string,
  ): Promise<number> {
    const result = this.deleteStmt.run(persona, conversation);
    return result.changes;
  }
}

export async function openMemoryStore(path: string): Promise<MemoryStore> {
  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  // WAL keeps reads non-blocking even though phantombot is single-process —
  // useful if `phantombot history` is run while a `phantombot chat` REPL is open.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return new SqliteMemoryStore(db);
}
