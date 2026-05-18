/**
 * Telegram channel adapter.
 *
 * Long-polls Telegram's getUpdates, dispatches each text message through
 * runTurn, and sends the assistant reply back via sendMessage. Per-chat
 * memory uses conversation key `telegram:<chatId>` so DMs and groups are
 * isolated from the CLI's `cli:default` history.
 *
 * Streaming: we send `sendChatAction(typing)` at the start of each turn,
 * refresh it on every harness chunk, and — for text-out turns — flush
 * any buffered prose as a separate Telegram message right before each
 * tool call (signalled by a `progress` chunk). That makes one-line
 * narrations like "Checking your inboxes…" land *before* the silent
 * tool-run window instead of arriving stapled to the back of the final
 * answer. Voice-out skips chunked flushing — voice is one synthesized
 * clip at the end, mid-turn flushes would just bloat the audio.
 *
 * Gemini-cli models often go straight to tool calls without narration.
 * For that case: we run a background typing-indicator refresh timer
 * during tool execution (the status bar keeps showing "typing…" or
 * "recording voice…" — no canned chat messages), and flush accumulated
 * text on post-tool heartbeat events so replies stream progressively
 * instead of arriving as one blob at turn-end.
 *
 * Token-by-token live edits would be nicer still but Telegram
 * rate-limits edits at ~1/sec — not worth the complexity.
 *
 * Auth gating: if `allowedUserIds` is empty, anyone who DMs the bot is
 * answered. We log a warning at startup so this isn't accidental.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { type Config, xdgDataHome } from "../config.ts";
import type { Harness } from "../harnesses/types.ts";
import {
  type AudioSupport,
  replyModalityOverride,
  sttSupport,
  synthesize,
  transcribe,
  ttsSupported,
} from "../lib/audio.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import type { ServiceControl } from "../lib/systemd.ts";
import type { MemoryStore } from "../memory/store.ts";
import { runTurn } from "../orchestrator/turn.ts";
import {
  type ActiveTurnHandle,
  handleSlashCommand,
} from "./commands.ts";
import { markdownToTelegramHtml } from "./telegramFormat.ts";

/**
 * Telegram bot-API hard cap on file downloads. `getFile` rejects requests
 * for larger files outright, regardless of attachment type. Documented at
 * https://core.telegram.org/bots/api#getfile. Client-side uploads can be
 * much bigger, but bots literally cannot fetch them through this API —
 * the right user-facing behavior is to surface the size and move on, not
 * to silently drop.
 */
const TELEGRAM_BOT_DOWNLOAD_CAP_BYTES = 20 * 1024 * 1024;

/** Per-chat inbox where Telegram attachments are saved. */
export function inboxDir(chatId: number): string {
  return join(xdgDataHome(), "phantombot", "inbox", String(chatId));
}

/**
 * Build the user message handed to the harness for an attachment-bearing
 * Telegram message. Caption + a single bracketed line that names the
 * absolute file path (or explains why we couldn't fetch it). The agent
 * decides what to do — read it, ignore it, ask for clarification.
 *
 * Exported for testing.
 */
export function formatAttachmentUserText(args: {
  caption: string | undefined;
  attachment: TelegramAttachment;
  /** Absolute path on disk if the download succeeded. */
  savedPath?: string;
  /** Set when the file was over Telegram's bot-API download cap. */
  oversizeBytes?: number;
  /** Set when getFile or the actual download threw. */
  downloadError?: string;
}): string {
  const captionPart = (args.caption ?? "").trim();
  let line: string;
  if (args.savedPath) {
    line = `[attached: ${args.savedPath}]`;
  } else if (args.oversizeBytes !== undefined) {
    const mb = (args.oversizeBytes / 1024 / 1024).toFixed(1);
    line = `[attached but too large to fetch: ${args.attachment.fileName} (${mb} MB > 20 MB Telegram bot-API cap)]`;
  } else {
    line = `[attached but couldn't download: ${args.attachment.fileName}${args.downloadError ? ` (${args.downloadError})` : ""}]`;
  }
  return captionPart ? `${captionPart}\n\n${line}` : line;
}

export interface TelegramAttachment {
  /** Telegram file_id; pass to getFile + the resulting file_path URL. */
  fileId: string;
  /** Filename to use on disk. Either Telegram's `file_name` (documents,
   *  audio, video) or synthesized from the message id + kind + mime. */
  fileName: string;
  /** Bytes if Telegram included it. Used to skip the download when the
   *  file is over Telegram's bot-API cap (getFile rejects > 20 MB). */
  fileSize?: number;
  /** MIME type if Telegram included one. */
  mimeType?: string;
  /** The Telegram message field this came from — useful for log clarity. */
  kind:
    | "document"
    | "photo"
    | "audio"
    | "video"
    | "video_note"
    | "animation"
    | "sticker";
}

export interface TelegramMessage {
  updateId: number;
  chatId: number;
  fromUserId: number;
  fromUsername?: string;
  /** For text messages — the text. For voice messages — empty string until
   *  STT runs. For attachment-only messages — empty until processChatMessage
   *  rewrites it to "<caption>\n\n[attached: <path>]". */
  text: string;
  /** Caption accompanying media (Telegram delivers `caption` not `text`
   *  for media messages). Empty when absent. */
  caption?: string;
  /** Set when the incoming message was a voice note. Voice keeps its
   *  dedicated STT path; it is NOT carried via `attachment`. */
  voice?: {
    fileId: string;
    mimeType: string;
    durationS: number;
  };
  /** Any non-voice attachment (photo, document, audio, video, etc.).
   *  Downloaded to the per-chat inbox and surfaced to the harness as
   *  an absolute path the agent can `read`. */
  attachment?: TelegramAttachment;
}

export interface TelegramTransport {
  /**
   * Long-poll Telegram for updates from `offset`. Returns parsed updates
   * and the new offset. The optional `signal` cancels the in-flight HTTP
   * call so SIGINT during a 30-second long-poll exits in milliseconds
   * instead of waiting out the full timeout.
   */
  getUpdates(
    offset: number,
    timeoutS: number,
    signal?: AbortSignal,
  ): Promise<{ updates: TelegramMessage[]; nextOffset: number }>;
  /**
   * Confirm to Telegram that all updates with `update_id < offset` have
   * been processed, so the next long-poll won't re-deliver them. Per the
   * Bot API: "An update is considered confirmed as soon as getUpdates is
   * called with an offset higher than its update_id." This is a fire-
   * and-forget short-timeout getUpdates whose only purpose is to commit
   * the offset before we do something that would kill the process (e.g.
   * /restart). Without it, SIGTERM during the long-poll window means
   * Telegram never sees the offset advance, and the freshly-started
   * process gets the same /restart again — restart loop.
   */
  ackUpdates(offset: number): Promise<void>;
  sendMessage(chatId: number, text: string): Promise<void>;
  sendTyping(chatId: number): Promise<void>;
  /** Send an OGG-Opus voice note. */
  sendVoice(chatId: number, audio: Buffer, mime: string): Promise<void>;
  /** Send the "recording voice" status indicator. */
  sendRecording(chatId: number): Promise<void>;
  /** Download a file by Telegram file_id; returns audio bytes + content-type. */
  downloadFile(fileId: string): Promise<{ data: Buffer; mime: string }>;
}

/**
 * Real HTTP transport against api.telegram.org.
 */
export class HttpTelegramTransport implements TelegramTransport {
  constructor(private readonly token: string) {}

  async getUpdates(
    offset: number,
    timeoutS: number,
    signal?: AbortSignal,
  ): Promise<{ updates: TelegramMessage[]; nextOffset: number }> {
    const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${offset}&timeout=${timeoutS}&allowed_updates=%5B%22message%22%5D`;
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (e) {
      // AbortError is the expected path on Ctrl-C; just return empty so the
      // caller's next signal check exits the loop.
      if ((e as Error).name === "AbortError") {
        return { updates: [], nextOffset: offset };
      }
      log.warn("telegram: getUpdates fetch failed", {
        error: (e as Error).message,
      });
      return { updates: [], nextOffset: offset };
    }
    if (!res.ok) {
      log.warn("telegram: getUpdates non-OK", { status: res.status });
      return { updates: [], nextOffset: offset };
    }
    const body = (await res.json()) as {
      ok?: boolean;
      result?: TelegramRawUpdate[];
      description?: string;
    };
    if (!body.ok) {
      log.warn("telegram: getUpdates not ok", { description: body.description });
      return { updates: [], nextOffset: offset };
    }
    return parseGetUpdatesResult(body.result ?? [], offset);
  }

  /**
   * Commit `offset` to Telegram by making a zero-timeout getUpdates call.
   * Best-effort: failures are logged and swallowed because the caller is
   * about to do something destructive (e.g. systemctl restart) and the
   * worst case of a missed ack is a single duplicate delivery — not
   * something to crash the channel for. Uses timeout=0 so this returns
   * in tens of milliseconds; no long-poll involved.
   */
  async ackUpdates(offset: number): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${offset}&timeout=0&limit=1&allowed_updates=%5B%22message%22%5D`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        log.warn("telegram: ackUpdates non-OK", {
          status: res.status,
          offset,
        });
      }
    } catch (e) {
      log.warn("telegram: ackUpdates fetch failed", {
        error: (e as Error).message,
        offset,
      });
    }
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    // Telegram caps message length at 4096 chars. Truncate the SOURCE
    // markdown to stay clear of the cap after HTML conversion adds
    // tags. ~3500 source chars leaves comfortable headroom for the
    // tag overhead a heavily-formatted reply could introduce.
    const safe =
      text.length > 3500 ? text.slice(0, 3500) + "\n…[truncated]" : text;
    const html = markdownToTelegramHtml(safe);

    // First try: rendered HTML. If Telegram rejects with 400 (parse
    // error from a converter bug we haven't seen yet), retry once as
    // plain text so the user always gets *some* reply rather than the
    // assistant going silent on a malformed conversion.
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
      }),
    });
    if (res.ok) return;

    if (res.status === 400) {
      log.warn(
        "telegram: HTML sendMessage rejected, falling back to plain text",
        {
          chatId,
          status: res.status,
          // First 200 chars helps a future contributor reproduce the
          // converter bug without pulling the full transcript.
          htmlPreview: html.slice(0, 200),
        },
      );
      const fallback = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: safe }),
      });
      if (!fallback.ok) {
        log.warn("telegram: plain-text fallback also failed", {
          chatId,
          status: fallback.status,
        });
      }
      return;
    }

    log.warn("telegram: sendMessage non-OK", {
      chatId,
      status: res.status,
    });
  }

  async sendTyping(chatId: number): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendChatAction`;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    }).catch(() => {
      /* typing indicator is best-effort */
    });
  }

  async sendRecording(chatId: number): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendChatAction`;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "record_voice" }),
    }).catch(() => {});
  }

  async sendVoice(
    chatId: number,
    audio: Buffer,
    mime: string,
  ): Promise<void> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set(
      "voice",
      new Blob([audio], { type: mime || "audio/ogg" }),
      "voice.ogg",
    );
    const res = await fetch(
      `https://api.telegram.org/bot${this.token}/sendVoice`,
      { method: "POST", body: form },
    );
    if (!res.ok) {
      log.warn("telegram: sendVoice non-OK", {
        chatId,
        status: res.status,
      });
    }
  }

  async downloadFile(
    fileId: string,
  ): Promise<{ data: Buffer; mime: string }> {
    // Two-step: getFile to get file_path, then GET the file URL.
    const meta = await fetch(
      `https://api.telegram.org/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`,
    );
    const metaBody = (await meta.json()) as {
      ok?: boolean;
      result?: { file_path?: string };
    };
    if (!metaBody.ok || !metaBody.result?.file_path) {
      throw new Error(`getFile failed for ${fileId}`);
    }
    const file = await fetch(
      `https://api.telegram.org/file/bot${this.token}/${metaBody.result.file_path}`,
    );
    const data = Buffer.from(await file.arrayBuffer());
    const mime =
      file.headers.get("content-type") ?? guessMimeFromPath(metaBody.result.file_path);
    return { data, mime };
  }
}

function guessMimeFromPath(path: string): string {
  if (path.endsWith(".oga") || path.endsWith(".ogg")) return "audio/ogg";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".m4a")) return "audio/mp4";
  return "audio/ogg";
}

/**
 * Render an AbortSignal.reason as a short string for logging.
 * Callers pass plain strings ("stop", "reset", "interrupt"); the DOM
 * default for a parameterless abort() is a DOMException — fold it down
 * to its message so journalctl stays readable.
 */
function abortReasonString(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return "aborted";
}

interface TelegramRawFile {
  file_id?: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}

interface TelegramRawPhotoSize {
  file_id?: string;
  file_size?: number;
  width?: number;
  height?: number;
}

interface TelegramRawUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: { id?: number };
    from?: { id?: number; username?: string };
    text?: string;
    caption?: string;
    voice?: {
      duration?: number;
      mime_type?: string;
      file_id?: string;
    };
    document?: TelegramRawFile;
    audio?: TelegramRawFile;
    video?: TelegramRawFile;
    video_note?: TelegramRawFile;
    animation?: TelegramRawFile;
    sticker?: TelegramRawFile;
    photo?: TelegramRawPhotoSize[];
  };
}

/**
 * Walk a raw message looking for an attachment. Photos are an array of
 * sizes; we pick the largest. Voice is intentionally skipped — it has its
 * own STT path. Returns undefined when the message has nothing
 * attachment-shaped.
 *
 * Exported for testing.
 */
export function extractAttachment(
  msg: NonNullable<TelegramRawUpdate["message"]>,
): TelegramAttachment | undefined {
  const msgId = typeof msg.message_id === "number" ? msg.message_id : 0;

  // Documents/audio/video/etc. all have the same shape: file_id + optional
  // file_name, mime_type, file_size. Walked in priority order.
  const simpleKinds: Array<{
    field: TelegramAttachment["kind"];
    raw: TelegramRawFile | undefined;
  }> = [
    { field: "document", raw: msg.document },
    { field: "audio", raw: msg.audio },
    { field: "video", raw: msg.video },
    { field: "video_note", raw: msg.video_note },
    { field: "animation", raw: msg.animation },
    { field: "sticker", raw: msg.sticker },
  ];
  for (const { field, raw } of simpleKinds) {
    if (raw && typeof raw.file_id === "string") {
      return {
        fileId: raw.file_id,
        fileName: raw.file_name ?? synthesizeFileName(msgId, field, raw.mime_type),
        fileSize: typeof raw.file_size === "number" ? raw.file_size : undefined,
        mimeType: raw.mime_type,
        kind: field,
      };
    }
  }

  // Photos: pick the largest size. file_size may be missing on some
  // sizes; rank by (file_size ?? width*height ?? 0) descending.
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const sized = msg.photo
      .filter((p): p is TelegramRawPhotoSize & { file_id: string } =>
        typeof p?.file_id === "string",
      )
      .map((p) => ({
        p,
        rank:
          p.file_size ??
          (typeof p.width === "number" && typeof p.height === "number"
            ? p.width * p.height
            : 0),
      }))
      .sort((a, b) => b.rank - a.rank);
    const best = sized[0]?.p;
    if (best) {
      return {
        fileId: best.file_id,
        fileName: synthesizeFileName(msgId, "photo", "image/jpeg"),
        fileSize: typeof best.file_size === "number" ? best.file_size : undefined,
        mimeType: "image/jpeg",
        kind: "photo",
      };
    }
  }

  return undefined;
}

function synthesizeFileName(
  msgId: number,
  kind: TelegramAttachment["kind"],
  mimeType: string | undefined,
): string {
  return `${msgId}-${kind}${extensionFromMime(mimeType)}`;
}

/**
 * Map a MIME to a file extension. Conservative: handles the common ones
 * we'll actually see from Telegram (photo, voice, audio, video, common
 * documents); unknown → ".bin" so we still write *something* the agent
 * can `read`. Exported for testing.
 */
export function extensionFromMime(mime: string | undefined): string {
  if (!mime) return ".bin";
  const m = mime.toLowerCase().split(";")[0]!.trim();
  switch (m) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/heic":
      return ".heic";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    case "text/csv":
      return ".csv";
    case "application/json":
      return ".json";
    case "application/zip":
      return ".zip";
    case "audio/ogg":
      return ".ogg";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
      return ".m4a";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
    default:
      // Generic fallback: take everything after the slash, strip
      // anything non-alphanumeric, cap at 8 chars. So "application/
      // vnd.openxmlformats-officedocument.wordprocessingml.document"
      // becomes ".vndopenx" — ugly but unique-ish, and the absolute
      // path the agent gets includes the kind, so it's fine.
      const sub = m.split("/")[1] ?? "";
      const cleaned = sub.replace(/[^a-z0-9]/g, "").slice(0, 8);
      return cleaned ? `.${cleaned}` : ".bin";
  }
}

/**
 * Pure parser exposed for testing. Consumes Telegram getUpdates result
 * objects and returns the messages we care about — text or voice.
 */
export function parseGetUpdatesResult(
  raw: TelegramRawUpdate[],
  fallbackOffset: number,
): { updates: TelegramMessage[]; nextOffset: number } {
  const updates: TelegramMessage[] = [];
  let nextOffset = fallbackOffset;
  for (const u of raw) {
    if (typeof u.update_id === "number") {
      nextOffset = Math.max(nextOffset, u.update_id + 1);
    }
    const msg = u.message;
    if (
      typeof u.update_id !== "number" ||
      !msg ||
      typeof msg.chat?.id !== "number" ||
      typeof msg.from?.id !== "number"
    ) {
      continue;
    }

    // Attachments take priority over plain text, but if BOTH text and an
    // attachment are present (rare; Telegram normally uses `caption` not
    // `text` for media), use text as the caption.
    const attachment = extractAttachment(msg);
    if (attachment) {
      const captionFromMedia =
        typeof msg.caption === "string" ? msg.caption : undefined;
      const captionFromText =
        typeof msg.text === "string" && msg.text.length > 0
          ? msg.text
          : undefined;
      updates.push({
        updateId: u.update_id,
        chatId: msg.chat.id,
        fromUserId: msg.from.id,
        fromUsername: msg.from.username,
        text: "", // filled by processChatMessage after download
        caption: captionFromMedia ?? captionFromText,
        attachment,
      });
      continue;
    }
    if (typeof msg.text === "string" && msg.text.length > 0) {
      updates.push({
        updateId: u.update_id,
        chatId: msg.chat.id,
        fromUserId: msg.from.id,
        fromUsername: msg.from.username,
        text: msg.text,
      });
      continue;
    }
    if (msg.voice && typeof msg.voice.file_id === "string") {
      updates.push({
        updateId: u.update_id,
        chatId: msg.chat.id,
        fromUserId: msg.from.id,
        fromUsername: msg.from.username,
        text: "", // filled by STT before harness dispatch
        voice: {
          fileId: msg.voice.file_id,
          mimeType: msg.voice.mime_type ?? "audio/ogg",
          durationS: msg.voice.duration ?? 0,
        },
      });
    }
  }
  return { updates, nextOffset };
}

export interface RunTelegramServerInput {
  config: Config;
  memory: MemoryStore;
  harnesses: Harness[];
  agentDir: string;
  persona: string;
  transport: TelegramTransport;
  /** Stop after one polling cycle. For tests. */
  oneShot?: boolean;
  /** Signal to stop the loop cleanly. */
  signal?: AbortSignal;
  /**
   * Minimum gap between two `sendChatAction` calls (ms). Used to throttle
   * the per-chunk refresh so a fast stream-json burst doesn't fire
   * dozens of typing actions per second. Default 2000ms — well under
   * Telegram's ~5s chat-action lifetime, so the indicator stays solid
   * during continuous activity but vanishes within ~5s when the harness
   * goes silent (the truthful "frozen / no signal" cue). Tests pass a
   * smaller value for determinism.
   */
  typingThrottleMs?: number;
  out?: WriteSink;
  err?: WriteSink;
  /**
   * Optional override for the service control passed to /restart's
   * afterSend. Tests inject a stub so they can verify the channel
   * layer's "ack offset before fatal callback" ordering without
   * actually invoking systemctl on the developer's host. Production
   * leaves this undefined and /restart picks up the host backend.
   */
  serviceControl?: ServiceControl;
}

/**
 * The long-poll loop. Returns when signal is aborted, or after one
 * iteration if oneShot is set. Otherwise runs forever.
 *
 * Concurrency model:
 *
 *   - The polling loop never `await`s a turn directly. That was the
 *     bug that broke /stop in the old design — a hung tool call inside
 *     the harness blocked the polling loop, so even the next slash
 *     command from the same user couldn't be picked up off the wire.
 *
 *   - Slash commands are handled INLINE in the polling loop, so they
 *     respond immediately even when an LLM turn is running.
 *
 *   - Regular messages are queued onto a per-chat promise chain. Same
 *     chat → still serial (the LLM's history would get scrambled
 *     otherwise). Different chats → parallel.
 *
 *   - Each in-flight turn registers an AbortController under
 *     `activeTurns[chatId]` so /stop can abort it.
 *
 *   - On `oneShot`, we drain in-flight workers before returning so tests
 *     can assert on `transport.sent` without racing the workers.
 */
export async function runTelegramServer(
  input: RunTelegramServerInput,
): Promise<void> {
  const serverStartedAt = Date.now();
  const tg = input.config.channels.telegram!;
  const allowedSet = new Set(tg.allowedUserIds);
  const checkAllowed = (userId: number): boolean =>
    allowedSet.size === 0 || allowedSet.has(userId);

  // /harness reorders this in place — keep a local mutable copy so we
  // don't mutate the caller's array.
  const harnesses: Harness[] = [...input.harnesses];

  // Active turns per chat — keyed by chatId. Read by /stop and /status.
  const activeTurns = new Map<number, ActiveTurnHandle>();

  // Per-chat promise chain so messages within one chat stay ordered.
  // We chain `next = prev.then(work)` and store `next` here. When the
  // next message arrives, it chains off the latest entry.
  const chatChains = new Map<number, Promise<void>>();
  // Set of every in-flight worker promise — drained at shutdown / oneShot.
  const inFlight = new Set<Promise<void>>();

  if (allowedSet.size === 0) {
    log.warn(
      "telegram: no allowed_user_ids configured — anyone who DMs the bot is answered",
    );
  }

  let offset = 0;

  try {
    do {
      if (input.signal?.aborted) return;

      const { updates, nextOffset } = await input.transport.getUpdates(
        offset,
        tg.pollTimeoutS,
        input.signal,
      );
      offset = nextOffset;

      for (const msg of updates) {
        if (input.signal?.aborted) return;

        if (!checkAllowed(msg.fromUserId)) {
          log.info("telegram: rejecting unauthorized user", {
            fromUserId: msg.fromUserId,
            fromUsername: msg.fromUsername,
          });
          continue;
        }

        const isVoice = Boolean(msg.voice);
        log.info("telegram: incoming", {
          chatId: msg.chatId,
          fromUserId: msg.fromUserId,
          fromUsername: msg.fromUsername,
          textLength: msg.text.length,
          persona: input.persona,
          voice: isVoice,
          voiceDurationS: msg.voice?.durationS,
          attachment: msg.attachment
            ? {
                kind: msg.attachment.kind,
                fileName: msg.attachment.fileName,
                fileSize: msg.attachment.fileSize,
                mimeType: msg.attachment.mimeType,
              }
            : undefined,
          captionLength: msg.caption?.length,
        });

        // Slash commands: handled INLINE so they bypass the per-chat queue
        // and any in-flight turn. Voice messages are never slash commands
        // (the body is empty until STT runs, by which point we've already
        // committed to the LLM path).
        if (!isVoice && msg.text.startsWith("/")) {
          const result = await handleSlashCommand(msg.text, {
            chatId: msg.chatId,
            persona: input.persona,
            conversation: `telegram:${msg.chatId}`,
            memory: input.memory,
            harnesses,
            startedAt: serverStartedAt,
            activeTurn: activeTurns.get(msg.chatId),
            config: input.config,
            serviceControl: input.serviceControl,
          });
          if (result) {
            try {
              await input.transport.sendMessage(msg.chatId, result.reply);
            } catch (e) {
              log.error("telegram: slash reply send failed", {
                error: (e as Error).message,
                chatId: msg.chatId,
              });
            }
            // afterSend runs strictly after sendMessage so heads-up
            // text lands before any side-effect that could kill us
            // (used by /update and /restart to trigger systemctl
            // restart). Before firing it, ack the current offset to
            // Telegram so a SIGTERM mid-restart doesn't leave the just-
            // handled command on the wire — without this, the next
            // process's long-poll re-delivers the same /restart and
            // the user gets two restarts from one tap. Ack is best-
            // effort: failures are logged inside ackUpdates and we
            // proceed regardless.
            if (result.afterSend) {
              await input.transport.ackUpdates(offset);
              try {
                await result.afterSend();
              } catch (e) {
                log.error("telegram: slash afterSend failed", {
                  error: (e as Error).message,
                  chatId: msg.chatId,
                });
              }
            }
            continue;
          }
          // Unrecognized /command — fall through to the LLM.
        }

        // Regular message. If a turn is already in flight for this
        // chat, abort it — the user typing again means "pay attention
        // to this instead." The aborted turn returns silently via the
        // wasAborted path; only the new turn's reply lands. Same UX
        // as Claude Code's "type to interrupt." The new task still
        // chains off `prev` (the aborted turn's worker promise) so
        // the harness's process group has time to clean up before we
        // spawn the next subprocess.
        const active = activeTurns.get(msg.chatId);
        if (active) {
          log.info("telegram: new message — interrupting active turn", {
            chatId: msg.chatId,
            elapsedS: (
              (Date.now() - active.startTime) / 1000
            ).toFixed(1),
          });
          active.controller.abort("interrupt");
        }

        // Enqueue onto this chat's serial chain.
        const prev = chatChains.get(msg.chatId) ?? Promise.resolve();
        const next = prev.then(() =>
          processChatMessage(msg, {
            input,
            harnesses,
            activeTurns,
          }),
        );
        // Detach completed entries so the maps don't leak.
        const tracked = next.finally(() => {
          if (chatChains.get(msg.chatId) === tracked) {
            chatChains.delete(msg.chatId);
          }
          inFlight.delete(tracked);
        });
        chatChains.set(msg.chatId, tracked);
        inFlight.add(tracked);
      }
    } while (!input.oneShot);
  } finally {
    // Drain pending workers so tests can assert on transport state, and
    // production shutdowns don't leave zombie subprocesses behind.
    if (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }
}

/**
 * Process one (non-slash) message: STT if voice, run the harness chain,
 * send the reply. Stays self-contained so the polling loop can fire-and-
 * track via Promise.allSettled at shutdown.
 */
async function processChatMessage(
  msg: TelegramMessage,
  ctx: {
    input: RunTelegramServerInput;
    harnesses: Harness[];
    activeTurns: Map<number, ActiveTurnHandle>;
  },
): Promise<void> {
  const { input, harnesses, activeTurns } = ctx;
  const startedAt = Date.now();
  const isVoice = Boolean(msg.voice);

  // For voice messages: download → transcribe → use the transcript as
  // the user message before invoking the harness.
  if (isVoice && msg.voice) {
    const stt = sttSupport(input.config);
    if (!stt.ok) {
      await input.transport.sendMessage(
        msg.chatId,
        voiceUnavailableMessage(stt),
      );
      return;
    }
    try {
      const file = await input.transport.downloadFile(msg.voice.fileId);
      const r = await transcribe(input.config, file.data, file.mime);
      if (!r.ok) {
        log.error("telegram: STT failed", { error: r.error });
        await input.transport.sendMessage(
          msg.chatId,
          `(voice transcription failed: ${r.error})`,
        );
        return;
      }
      msg.text = r.text;
      log.info("telegram: STT ok", {
        chatId: msg.chatId,
        transcriptChars: r.text.length,
      });
    } catch (e) {
      log.error("telegram: voice download failed", {
        error: (e as Error).message,
      });
      await input.transport.sendMessage(
        msg.chatId,
        `(couldn't download your voice message: ${(e as Error).message})`,
      );
      return;
    }
  }

  // Non-voice attachment: download to per-chat inbox, then rewrite the
  // user-facing text to "<caption>\n\n[attached: <abs-path>]". The
  // harness decides what to do with the file — read, ignore, ask. We
  // never inspect or transform contents.
  if (msg.attachment) {
    const att = msg.attachment;
    let savedPath: string | undefined;
    let oversizeBytes: number | undefined;
    let downloadError: string | undefined;

    if (
      att.fileSize !== undefined &&
      att.fileSize > TELEGRAM_BOT_DOWNLOAD_CAP_BYTES
    ) {
      oversizeBytes = att.fileSize;
      log.warn("telegram: attachment over bot-API cap, not downloading", {
        chatId: msg.chatId,
        kind: att.kind,
        fileName: att.fileName,
        fileSize: att.fileSize,
      });
    } else {
      try {
        const dir = inboxDir(msg.chatId);
        await mkdir(dir, { recursive: true });
        // basename strips any path separators or "../" climbs from
        // Telegram's user-controlled file_name field — without this,
        // a sender with file_name="../../etc/passwd" could write
        // outside the inbox dir.
        const path = join(dir, `${msg.updateId}-${basename(att.fileName)}`);
        const file = await input.transport.downloadFile(att.fileId);
        await writeFile(path, file.data);
        savedPath = path;
        log.info("telegram: attachment saved", {
          chatId: msg.chatId,
          kind: att.kind,
          path,
          bytes: file.data.byteLength,
          mime: file.mime,
        });
      } catch (e) {
        downloadError = (e as Error).message;
        log.error("telegram: attachment download failed", {
          chatId: msg.chatId,
          kind: att.kind,
          fileName: att.fileName,
          error: downloadError,
        });
      }
    }

    msg.text = formatAttachmentUserText({
      caption: msg.caption,
      attachment: att,
      savedPath,
      oversizeBytes,
      downloadError,
    });
  }

  // Reply-modality routing.
  //
  //   default       — mirror the input modality (voice-in → voice-out,
  //                   text-in → text-out)
  //   user override — explicit per-message directive in the message
  //                   text ("reply in text", "send a voice note") flips
  //                   the wire format. Applies AFTER STT so the
  //                   transcript is what gets inspected for voice-in.
  //
  // Voice is still capped by ttsSupported(): if the user asks for a
  // voice reply but the provider can't do TTS, we degrade to text
  // gracefully (same fallback as the original voice-in path).
  const modalityOverride = replyModalityOverride(msg.text);
  const wantsVoiceReply =
    modalityOverride === "voice"
      ? true
      : modalityOverride === "text"
        ? false
        : isVoice;
  const willReplyWithVoice = wantsVoiceReply && ttsSupported(input.config);
  const sendStatus = () =>
    willReplyWithVoice
      ? input.transport.sendRecording(msg.chatId)
      : input.transport.sendTyping(msg.chatId);

  // Indicator policy: refresh on EVERY harness chunk (text, heartbeat,
  // progress). When chunks stop, the indicator naturally expires after
  // ~5s — that vanishing IS the user-visible "harness has gone silent /
  // possibly frozen" signal. One exception: during tool execution,
  // gemini-cli emits zero events (potentially for minutes), which would
  // make the indicator expire and look frozen. For that gap we run a
  // background refresh timer (startToolRefresh / stopToolRefresh). The
  // throttle just prevents stream-json bursts from hitting Telegram's
  // per-bot rate cap.
  const throttleMs = input.typingThrottleMs ?? 2000;
  let lastSendStatusAt = 0;
  const refreshIndicator = () => {
    const now = Date.now();
    if (now - lastSendStatusAt < throttleMs) return;
    lastSendStatusAt = now;
    void sendStatus();
  };

  // Background typing/recording indicator refresh during tool execution.
  // gemini-cli emits zero events while a tool runs (potentially minutes),
  // causing Telegram's chat-action indicator to expire after ~5s. This
  // interval timer keeps it visible during the gap. Started on the first
  // `progress` event, stopped on the next `text` / `heartbeat` / `done`
  // / `error` / `finally`.
  let toolRefreshTimer: ReturnType<typeof setInterval> | undefined;
  const startToolRefresh = () => {
    if (toolRefreshTimer) return; // already running
    toolRefreshTimer = setInterval(() => {
      void sendStatus();
    }, 4000);
  };
  const stopToolRefresh = () => {
    if (toolRefreshTimer) {
      clearInterval(toolRefreshTimer);
      toolRefreshTimer = undefined;
    }
  };

  // Initial nudge so the user sees "typing…" the moment we start
  // working, before the first chunk lands.
  refreshIndicator();

  // Register the AbortController so /stop can find us.
  const controller = new AbortController();
  const turnHandle: ActiveTurnHandle = {
    controller,
    startTime: startedAt,
  };
  activeTurns.set(msg.chatId, turnHandle);

  // Streaming-narration accumulators. The text-out path flushes
  // buffered prose as a separate Telegram message right before each
  // tool call (signalled by a `progress` chunk), so the user sees
  // "Checking your inboxes…" land *before* the silent tool-run window.
  // Without this, the entire turn batches into one bubble at the end
  // and narration is invisible.
  //
  //   streamedReply  — running sum of `text` chunks seen so far
  //   flushedReply   — what's already been sent as narration bubbles;
  //                    a prefix of streamedReply (and, in the happy
  //                    path, of the final reply too)
  //   finalReply     — set on the `done` chunk; authoritative full
  //                    text the harness wants delivered
  //
  // Voice-out skips flushing entirely — voice is one synthesized clip
  // at the end, so mid-turn flushes would just bloat the audio.
  let streamedReply = "";
  let flushedReply = "";
  let finalReply: string | undefined;
  let errored: string | undefined;
  let progressCount = 0;
  let chosenHarness: string | undefined;
  // Gemini-cli streaming UX: track whether we're past the first tool
  // call (so we know when heartbeat events signal post-tool reply
  // streaming), and throttle heartbeat-triggered text flushes so
  // replies stream progressively instead of arriving as one blob.
  let pastFirstTool = false;
  let lastHeartbeatFlushAt = 0;

  // Flush whatever's buffered since the last flush as a narration
  // bubble. No-ops in voice-out (we synthesize once at the end) and
  // when there's nothing meaningful to send (whitespace-only). Logs
  // and swallows send failures rather than aborting the turn — a
  // dropped narration bubble is a cosmetic loss, not a correctness
  // one.
  const flushNarration = async () => {
    if (willReplyWithVoice) return;
    const pending = streamedReply.slice(flushedReply.length);
    if (pending.trim().length === 0) return;
    flushedReply = streamedReply;
    try {
      await input.transport.sendMessage(msg.chatId, pending);
    } catch (e) {
      log.warn("telegram: narration flush failed", {
        error: (e as Error).message,
        chatId: msg.chatId,
      });
    }
    // Sending a real message replaces the typing indicator — re-arm
    // it so the user sees we're still working on the next step.
    refreshIndicator();
  };

  // Mechanical capture nudge: every CAPTURE_NUDGE_INTERVAL user turns
  // without a `memory capture`, append a reminder to the system-prompt
  // suffix. Only for real `telegram:*` conversations — never tick:/system:.
  // runTurn appends this incoming message to `turns` only AFTER the turn,
  // so we count prior user turns + 1 to land the nudge on the Nth turn.
  const conversationKey = `telegram:${msg.chatId}`;
  let captureNudge: string | undefined;
  if (conversationKey.startsWith("telegram:")) {
    captureNudge = await captureNudgeForTurn(
      input.memory,
      input.persona,
      conversationKey,
    );
  }

  try {
    for await (const chunk of runTurn({
      persona: input.persona,
      conversation: conversationKey,
      userMessage: msg.text,
      agentDir: input.agentDir,
      harnesses,
      memory: input.memory,
      idleTimeoutMs: input.config.harnessIdleTimeoutMs,
      hardTimeoutMs: input.config.harnessHardTimeoutMs,
      signal: controller.signal,
      // Channel-layer prompt suffix:
      //   - Always: TELEGRAM_REPLY_INSTRUCTION — short conversational
      //     replies + plan-then-confirm before long jobs (git/build/
      //     deploy or anything that would spawn more than one tool call).
      //   - Voice-out: stack VOICE_REPLY_INSTRUCTION on top — stricter
      //     1-3 sentence limit and no markdown so TTS doesn't read out
      //     headers/bullets.
      // Living at the channel layer (not in persona files) keeps these
      // rules from leaking into CLI/nightly turns, where verbosity is
      // fine and the user isn't on a phone.
      // The mechanical capture nudge (when due) stacks last so it is
      // the freshest standing instruction the harness sees this turn —
      // exactly the salience boost weak harnesses need.
      systemPromptSuffix: [
        willReplyWithVoice
          ? `${TELEGRAM_REPLY_INSTRUCTION}\n\n${VOICE_REPLY_INSTRUCTION}`
          : TELEGRAM_REPLY_INSTRUCTION,
        captureNudge,
      ]
        .filter(Boolean)
        .join("\n\n"),
      // Pre-tool narration: ON for text-out (the user sees streamed
      // text as it lands, so a "checking your calendar..." sentence
      // before a tool call usefully fills the silence). OFF for
      // voice-out: the reply is synthesized as one clip at the end,
      // so narration would just lengthen the spoken output without
      // helping with perceived latency. VOICE_REPLY_INSTRUCTION
      // already forbids work narration too, so off is consistent.
      toolNarration: !willReplyWithVoice,
    })) {
      if (chunk.type === "text") {
        streamedReply += chunk.text;
        stopToolRefresh();
        refreshIndicator();
      }
      if (chunk.type === "heartbeat") {
        // Tool completed (or model is thinking) — stop the background
        // tool-refresh timer and show the indicator naturally.
        stopToolRefresh();
        refreshIndicator();
        // After the first tool call, heartbeat events signal the model
        // has started streaming its post-tool reply. Flush accumulated
        // text so gemini-cli users see replies progressively instead of
        // waiting for the entire turn to finish. Throttled to avoid
        // sending a new message on every heartbeat/token pair.
        if (pastFirstTool) {
          const now = Date.now();
          if (now - lastHeartbeatFlushAt >= 1500) {
            const pending = streamedReply.slice(flushedReply.length);
            if (pending.trim().length > 0) {
              flushedReply = streamedReply;
              try {
                await input.transport.sendMessage(msg.chatId, pending);
                lastHeartbeatFlushAt = now;
              } catch (e) {
                log.warn("telegram: heartbeat flush failed", {
                  error: (e as Error).message,
                  chatId: msg.chatId,
                });
              }
              refreshIndicator();
            }
          }
        }
      }
      if (chunk.type === "progress") {
        progressCount++;
        pastFirstTool = true;
        // Stash the latest progress note on the active-turn handle so
        // /status can show "currently: <tool>" in real time.
        turnHandle.lastProgressNote = chunk.note.slice(0, 500);
        log.debug("telegram: progress", {
          chatId: msg.chatId,
          note: chunk.note.slice(0, 200),
        });
        // A tool is about to run — flush whatever narration the model
        // emitted before this point so the user sees it during the
        // silence. (Inside the loop so multi-tool turns get one
        // bubble per tool, not one wall at the end.)
        // flushNarration() re-arms the typing indicator after sending,
        // so we don't need to call refreshIndicator() again here.
        const pendingBeforeTool = streamedReply.slice(flushedReply.length);
        if (pendingBeforeTool.trim().length > 0) {
          await flushNarration();
        }
        // Start a background timer to keep the typing/recording
        // indicator visible during tool execution. Without this,
        // gemini-cli's multi-minute tool runs cause Telegram's
        // indicator to expire after ~5s, making it look like the
        // bot has frozen. Stopped on the next text/heartbeat/done/error.
        startToolRefresh();
      }
      if (chunk.type === "done") {
        finalReply = chunk.finalText;
        const meta = chunk.meta as { harnessId?: unknown } | undefined;
        if (typeof meta?.harnessId === "string") {
          chosenHarness = meta.harnessId;
        }
      }
      if (chunk.type === "error") errored = chunk.error;
    }
  } catch (e) {
    errored = (e as Error).message;
    log.error("telegram: turn threw", { error: errored });
  } finally {
    stopToolRefresh();
    // Only deregister if we're still the active turn for this chat.
    // (Defensive: a /reset or /stop could have replaced us.)
    if (activeTurns.get(msg.chatId) === turnHandle) {
      activeTurns.delete(msg.chatId);
    }
  }

  // The controller was aborted from outside. Causes:
  //   - "stop"      — /stop slash command (slash handler already replied).
  //   - "reset"     — /reset slash command (handler replied; history wiped).
  //   - "interrupt" — a new message arrived for this chat; the new
  //                   turn supersedes us. Stay silent so only the new
  //                   reply lands.
  // In every case, suppress the would-be reply.
  if (controller.signal.aborted) {
    const reason = abortReasonString(controller.signal.reason);
    log.info("telegram: turn aborted", {
      chatId: msg.chatId,
      durationMs: Date.now() - startedAt,
      reason,
    });
    // Persist a synthetic interrupted-pair so the next turn knows what
    // the user just said and that the agent never got to respond.
    // Without this, follow-ups like "actually use blue instead" land
    // with no referent in history and the model is surprised. Skip
    // when:
    //   - reason === "reset"  → /reset just wiped this conversation;
    //                           writing here would un-wipe it.
    //   - msg.text.length === 0 → voice message aborted before STT
    //                             completed; nothing meaningful to log.
    if (reason !== "reset" && msg.text.length > 0) {
      try {
        await input.memory.appendTurn({
          persona: input.persona,
          conversation: `telegram:${msg.chatId}`,
          role: "user",
          text: msg.text,
        });
        await input.memory.appendTurn({
          persona: input.persona,
          conversation: `telegram:${msg.chatId}`,
          role: "assistant",
          text: "[interrupted before reply]",
        });
      } catch (e) {
        log.warn("telegram: failed to persist interrupted-pair", {
          chatId: msg.chatId,
          error: (e as Error).message,
        });
      }
    }
    return;
  }

  // The authoritative full reply: prefer the harness's `done.finalText`
  // (which may have been reformatted), fall back to whatever streamed.
  const fullReply = finalReply ?? streamedReply;

  // Compute what to send in the FINAL bubble (post-tool answer):
  //   - error: surface the diagnostic
  //   - flushed prefix matches: send only the suffix (the part of the
  //     answer the user hasn't seen yet)
  //   - flushed prefix doesn't match (harness reformatted): send the
  //     full reply. We accept some duplication of the narration text
  //     over silently truncating the answer.
  //   - nothing came back AND nothing was flushed: "(no reply)"
  //   - nothing came back BUT we flushed: stay silent (the narration
  //     bubbles are the user-visible reply)
  let outText: string;
  if (errored) {
    outText = `(error: ${errored})`;
  } else if (fullReply.length === 0) {
    outText = flushedReply.length > 0 ? "" : "(no reply)";
  } else if (
    flushedReply.length > 0 &&
    fullReply.startsWith(flushedReply)
  ) {
    outText = fullReply.slice(flushedReply.length);
  } else {
    outText = fullReply;
  }

  // Voice in → voice out (when TTS is configured AND no error).
  // Text in → text out, always. The reply lands as a fresh message,
  // so Telegram pushes a notification — important when the user kicked
  // off a long job and walked away from the chat.
  //
  // Voice-out always synthesizes the *full* reply (ignoring the chunked
  // outText), since flushNarration is a no-op for voice and the user
  // expects one coherent audio clip.
  let sentAsVoice = false;
  try {
    if (willReplyWithVoice && !errored && fullReply.length > 0) {
      const r = await synthesize(input.config, fullReply);
      if (r.ok) {
        await input.transport.sendVoice(
          msg.chatId,
          r.audio.data,
          r.audio.mime,
        );
        sentAsVoice = true;
      } else {
        log.warn("telegram: TTS failed; falling back to text", {
          error: r.error,
        });
        // TTS failure fallback: send the full reply as text (not the
        // prefix-trimmed outText) since we never flushed narration on
        // the voice path — there's nothing to dedupe against.
        await input.transport.sendMessage(msg.chatId, fullReply);
      }
    } else if (outText.length > 0) {
      // Empty outText is intentional silence: we already flushed the
      // narration bubbles and the harness produced nothing further
      // (and there's no error to surface). Skipping the send avoids
      // a stray "(no reply)" tacked onto the end of a perfectly
      // delivered turn.
      await input.transport.sendMessage(msg.chatId, outText);
    }
  } catch (e) {
    log.error("telegram: send failed", {
      error: (e as Error).message,
      chatId: msg.chatId,
    });
  }

  log.info("telegram: complete", {
    chatId: msg.chatId,
    durationMs: Date.now() - startedAt,
    replyChars: outText.length,
    flushedChars: flushedReply.length,
    progressEvents: progressCount,
    harness: chosenHarness ?? (errored ? "(error)" : "(unknown)"),
    modality: sentAsVoice ? "voice" : "text",
    inputModality: isVoice ? "voice" : "text",
    modalityOverride: modalityOverride ?? "none",
    ok: !errored,
  });
}

/**
 * System-prompt suffix applied to EVERY Telegram turn.
 *
 * Two purposes:
 *
 * 1. Reply style. The user is on a phone with a narrow column. Long
 *    walls of text and meta-narration ("Let me check…", "Right,
 *    here's what I found…") read poorly there. Default to short,
 *    conversational answers; structured-and-clear is fine when the
 *    user explicitly asks for a detailed report.
 *
 * 2. Plan-then-confirm before long jobs. A Telegram round-trip is
 *    seconds, but a misaligned 10-minute build burns the user's time
 *    AND tokens. Asking the agent to outline the plan and wait for
 *    confirmation when it's about to do something irreversible (git
 *    push, deploy) or expensive (multi-tool-call work) avoids that.
 *
 * Lives at the channel layer (not in persona files) so CLI / nightly
 * turns aren't affected — those run unattended and don't want a
 * confirmation gate, and verbose CLI output is fine.
 */
export const TELEGRAM_REPLY_INSTRUCTION =
  `# Reply style (Telegram chat)

You're chatting via Telegram. Default to short, conversational
replies — typically 1-4 sentences. The user is usually on a phone,
and the narrow column makes long walls of text hard to read. Skip
narration ("Let me…", "Right, here's what I found…"); answer directly.

Longer replies are fine when the user explicitly asks for a detailed
report or analysis. Use clear structure (headings, lists) when the
content earns it.

# Confirm before long jobs

Before starting any of these, briefly outline your plan in 2-3
sentences and ask the user to confirm or adjust:

- Anything involving git, build, or deploy operations
- Anything where you're going to spawn more than one tool call

Telegram round-trips are slow and tokens aren't free — confirming up
front beats producing the wrong thing minutes later. For
straightforward questions, just answer.`;

/**
 * Mechanical capture nudge — every {@link CAPTURE_NUDGE_INTERVAL} user
 * turns without a `memory capture`, the dispatch appends this to the
 * system-prompt suffix. Pure turn counter; no LLM decides whether to
 * nudge. Counteracts long-context dilution on weak harnesses that
 * weight standing instructions less.
 */
export const CAPTURE_NUDGE_INTERVAL = 30;

export const CAPTURE_NUDGE_TEXT =
  `${CAPTURE_NUDGE_INTERVAL} turns without a memory capture in this ` +
  `conversation. If a decision, lesson, person fact or commitment came ` +
  `up, capture it now with \`phantombot memory capture\`. If nothing is ` +
  `worth keeping, carry on — no capture is a valid answer.`;

/**
 * Decide whether to append the capture nudge for this turn.
 *
 * Counts `role = 'user'` turns since the last capture in this
 * (persona, conversation) — so any capture resets the counter for free
 * and the nudge re-fires at 2x, 3x, … if still dry. State lives entirely
 * in `memory.sqlite`, shared by the long-running phantombot process and
 * the short-lived `memory capture` CLI call, so the two stay in sync.
 *
 * The current incoming user message is NOT yet persisted to `turns`
 * (runTurn appends it only after the turn completes), so the effective
 * turn index is `countUserTurnsSince(...) + 1`. The nudge fires when
 * that effective index is a positive multiple of `interval` — i.e. on
 * the 30th, 60th, … dry turn.
 *
 * Only meaningful for real `telegram:*` conversations — the caller is
 * responsible for that gate.
 */
export async function captureNudgeForTurn(
  memory: MemoryStore,
  persona: string,
  conversation: string,
  interval = CAPTURE_NUDGE_INTERVAL,
): Promise<string | undefined> {
  try {
    const since =
      (await memory.lastCaptureAt(persona, conversation)) ??
      "1970-01-01T00:00:00.000Z";
    const priorTurns = await memory.countUserTurnsSince(
      persona,
      conversation,
      since,
    );
    // +1 for the current message, not yet written to `turns`.
    const effectiveTurn = priorTurns + 1;
    if (effectiveTurn > 0 && effectiveTurn % interval === 0) {
      return CAPTURE_NUDGE_TEXT;
    }
  } catch (e) {
    // A nudge is a nice-to-have — never let a counter query fail a turn.
    log.warn("telegram: capture nudge check failed", {
      error: (e as Error).message,
    });
  }
  return undefined;
}

/**
 * Voice-only overlay, stacked on top of TELEGRAM_REPLY_INSTRUCTION
 * when the reply will be synthesized via TTS.
 *
 * Why this exists separately: the chat-style instruction allows
 * "longer when asked" and structured markdown — both wrong for TTS,
 * which reads bullets/headers awkwardly and turns 4-sentence replies
 * into 90-second voice notes. This overlay tightens the length cap
 * to 1-3 sentences and forbids markdown.
 */
export const VOICE_REPLY_INSTRUCTION =
  `# Reply length (this turn only)

This message arrived as a voice note and your reply will be spoken
aloud via text-to-speech. Reply briefly and conversationally — 1-3
sentences, under ~30 seconds of speech (≈60 words / ≈100 tokens).
Output only the final answer — no narration of your work
("Let me check…"), no markdown headers/bullets/code blocks (TTS
reads them awkwardly), no "according to my analysis" preamble.
Just the human reply.`;

/**
 * Render an honest, actionable explanation when sttSupport() rules a
 * voice message out. Each variant points at the specific user action that
 * fixes it, instead of the old single-message catch-all that misled
 * users into thinking their provider was wrong when actually the systemd
 * unit was stale.
 */
export function voiceUnavailableMessage(
  s: Extract<AudioSupport, { ok: false }>,
): string {
  if (s.reason === "provider_none") {
    return "voice transcription is disabled — run `phantombot voice` to set up OpenAI or ElevenLabs";
  }
  if (s.reason === "provider_no_stt") {
    return `current provider '${s.provider}' has no STT — switch via \`phantombot voice\``;
  }
  // key_missing
  return `voice key not loaded into the service environment — run \`phantombot install\` to upgrade the systemd unit, then try again. (provider '${s.provider}', expected env var ${s.envVar})`;
}
