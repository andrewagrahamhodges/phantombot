/**
 * Shared TTS / STT types + the dispatcher that picks the right
 * provider based on Config.voice.provider.
 *
 * Telegram needs OGG-Opus for sendVoice, so every provider returns
 * audio in that container (or a buffer Telegram can accept as-is).
 */

import type { Config } from "../config.ts";
import type { VoiceProvider } from "./voice.ts";

export interface SynthesizedAudio {
  data: Buffer;
  /** Telegram-compatible MIME for sendVoice. We aim for audio/ogg. */
  mime: string;
}

export type SynthesizeResult =
  | { ok: true; audio: SynthesizedAudio }
  | { ok: false; error: string };

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Tri-state diagnostic for TTS/STT support. Each `{ ok: false }` variant
 * carries exactly the fields its reason needs — `envVar` is required on
 * `key_missing` and absent on the other two — so consumers can render an
 * honest, actionable message without `??` defenses against malformed
 * payloads.
 */
export type AudioSupport =
  | { ok: true }
  | { ok: false; reason: "provider_none"; provider: VoiceProvider }
  | { ok: false; reason: "provider_no_stt"; provider: VoiceProvider }
  | { ok: false; reason: "key_missing"; provider: VoiceProvider; envVar: string };

/** Diagnose whether the configured provider can perform STT. */
export function sttSupport(config: Config): AudioSupport {
  const provider = config.voice.provider;
  if (provider === "none") {
    return { ok: false, reason: "provider_none", provider };
  }
  if (provider === "azure_edge") {
    return { ok: false, reason: "provider_no_stt", provider };
  }
  const envVar =
    provider === "openai"
      ? "PHANTOMBOT_OPENAI_API_KEY"
      : "PHANTOMBOT_ELEVENLABS_API_KEY";
  return process.env[envVar]
    ? { ok: true }
    : { ok: false, reason: "key_missing", provider, envVar };
}

/** Diagnose whether the configured provider can synthesize TTS. */
export function ttsSupport(config: Config): AudioSupport {
  const provider = config.voice.provider;
  if (provider === "none") {
    return { ok: false, reason: "provider_none", provider };
  }
  if (provider === "azure_edge") return { ok: true }; // free, no key
  const envVar =
    provider === "openai"
      ? "PHANTOMBOT_OPENAI_API_KEY"
      : "PHANTOMBOT_ELEVENLABS_API_KEY";
  return process.env[envVar]
    ? { ok: true }
    : { ok: false, reason: "key_missing", provider, envVar };
}

/** Boolean wrapper around sttSupport — kept for callers that don't need the reason. */
export function sttSupported(config: Config): boolean {
  return sttSupport(config).ok;
}

/** Boolean wrapper around ttsSupport — kept for callers that don't need the reason. */
export function ttsSupported(config: Config): boolean {
  return ttsSupport(config).ok;
}

/**
 * Detect an explicit reply-modality directive in the user's message.
 *
 *   "text"     — user asked for a text reply ("reply in text", "no voice")
 *   "voice"    — user asked for a voice reply ("send a voice note", "as voice")
 *   undefined  — no clear directive; caller falls back to input modality
 *
 * Used by the Telegram channel to let users override the default
 * mirror-the-input-modality routing on a per-message basis. The model
 * still sees the directive verbatim in the prompt either way — this is
 * purely about picking the wire format (sendMessage vs sendVoice) and
 * the brevity directive applied to the system prompt.
 *
 * Deliberately conservative. Only matches explicit reply-form phrases
 * ("respond with text", "as voice") and near-unmistakable shorthand
 * ("voice note", "no voice"). Avoids false positives on bare nouns —
 * "the chapter is text-heavy" must NOT trigger, nor "compose a text
 * message to John". When the same message contains both a text and a
 * voice directive (a user mid-correction), the later one wins.
 */
export function replyModalityOverride(
  text: string | undefined,
): "text" | "voice" | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();

  // Negation short-circuit. "Do not reply with voice" literally CONTAINS
  // the substring "reply with voice" which would otherwise hit the
  // positive voice pattern below — so we check negations first and exit.
  // Symmetric for text ("no text", "don't reply with text") so users can
  // negate either modality. If a message negates BOTH (rare — "no text
  // and no voice"), the later mention is the user's settled intent,
  // matching the later-wins rule used by the positive patterns below.
  const NEGATION_VOICE =
    /\b(?:no|never|don't|do\s+not)\s+(?:use\s+|reply\s+(?:with|in)\s+|respond\s+(?:with|in)\s+|send\s+(?:me\s+|a\s+)*)?voice(?:\s*(?:note|message|reply|response))?\b/;
  const NEGATION_TEXT =
    /\b(?:no|never|don't|do\s+not)\s+(?:use\s+|reply\s+(?:with|in)\s+|respond\s+(?:with|in)\s+|send\s+(?:me\s+|a\s+)*)?text(?:\s*(?:reply|response|message))?\b/;
  const negVoice = NEGATION_VOICE.exec(t);
  const negText = NEGATION_TEXT.exec(t);
  if (negVoice && negText) {
    return negVoice.index > negText.index ? "text" : "voice";
  }
  if (negVoice) return "text";
  if (negText) return "voice";

  // Patterns are anchored on reply-verbs ("reply", "respond", "answer"),
  // unmistakable shorthand ("text reply", "voice note"), or "as/in text|
  // voice". Bare "text" or "voice" never trigger on their own — the
  // exclusion of "text message" from the noun-list is deliberate
  // ("compose a text message to john" must not flip routing).
  const textPatterns: RegExp[] = [
    // "(please) reply/respond/answer/get back to me with/in/as/using (plain) text"
    /\b(?:reply|respond|answer|response|get\s+back(?:\s+to\s+me)?)\s+(?:to\s+me\s+)?(?:with|in|as|using)\s+(?:plain\s+|just\s+|only\s+)?text\b/,
    // "text reply / response / answer / please / only" — "message" is
    // deliberately omitted (false-positive bait).
    /\btext[ -](?:reply|response|answer|please|only)\b/,
    // "as text" / "in text form|format"
    /\bas\s+text\b/,
    /\bin\s+text\s+(?:form|format)\b/,
  ];

  const voicePatterns: RegExp[] = [
    // "reply/respond/answer/get back to me with/in/as/using (a) voice"
    /\b(?:reply|respond|answer|response|get\s+back(?:\s+to\s+me)?)\s+(?:to\s+me\s+)?(?:with|in|as|using)\s+(?:a\s+|just\s+)?voice\b/,
    // "voice note / message / reply / response / answer / please / only"
    /\bvoice[ -](?:note|message|reply|response|answer|please|only)\b/,
    // "send (me) (a) voice (note|message)?"
    /\bsend(?:\s+me)?\s+(?:a\s+)?voice(?:\s*(?:note|message))?\b/,
    // "as (a) voice"
    /\bas\s+(?:a\s+)?voice\b/,
  ];

  let textIdx = -1;
  for (const re of textPatterns) {
    const m = re.exec(t);
    if (m && (textIdx === -1 || m.index < textIdx)) textIdx = m.index;
  }
  let voiceIdx = -1;
  for (const re of voicePatterns) {
    const m = re.exec(t);
    if (m && (voiceIdx === -1 || m.index < voiceIdx)) voiceIdx = m.index;
  }

  if (textIdx >= 0 && voiceIdx >= 0) {
    // Both fired: the later mention is the user's settled intent.
    return textIdx > voiceIdx ? "text" : "voice";
  }
  if (textIdx >= 0) return "text";
  if (voiceIdx >= 0) return "voice";
  return undefined;
}

export async function synthesize(
  config: Config,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SynthesizeResult> {
  const p = config.voice.provider;
  if (p === "elevenlabs") {
    const key = process.env.PHANTOMBOT_ELEVENLABS_API_KEY;
    if (!key) return { ok: false, error: "no ElevenLabs API key in env" };
    return elevenlabsTts(key, text, config.voice.elevenlabs!, fetchImpl);
  }
  if (p === "openai") {
    const key = process.env.PHANTOMBOT_OPENAI_API_KEY;
    if (!key) return { ok: false, error: "no OpenAI API key in env" };
    return openaiTts(key, text, config.voice.openai!, fetchImpl);
  }
  if (p === "azure_edge") {
    return {
      ok: false,
      error:
        "Azure Edge TTS not implemented yet — configure ElevenLabs or OpenAI for voice replies",
    };
  }
  return { ok: false, error: "TTS provider is 'none'" };
}

export async function transcribe(
  config: Config,
  audio: Buffer,
  mime: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TranscribeResult> {
  const p = config.voice.provider;
  if (p === "elevenlabs") {
    const key = process.env.PHANTOMBOT_ELEVENLABS_API_KEY;
    if (!key)
      return { ok: false, error: "no ElevenLabs API key in env" };
    return elevenlabsScribe(key, audio, mime, fetchImpl);
  }
  if (p === "openai") {
    const key = process.env.PHANTOMBOT_OPENAI_API_KEY;
    if (!key) return { ok: false, error: "no OpenAI API key in env" };
    return openaiWhisper(key, audio, mime, fetchImpl);
  }
  return {
    ok: false,
    error: `STT not supported for provider '${p}' — configure ElevenLabs or OpenAI to accept voice messages`,
  };
}

// ---------------------------------------------------------------------------
// Provider implementations (local — no SDK deps, raw HTTPS)
// ---------------------------------------------------------------------------

async function elevenlabsTts(
  apiKey: string,
  text: string,
  cfg: NonNullable<Config["voice"]["elevenlabs"]>,
  fetchImpl: typeof fetch,
): Promise<SynthesizeResult> {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}` +
    `?output_format=opus_48000_128`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: cfg.modelId,
        voice_settings: {
          stability: cfg.stability,
          similarity_boost: cfg.similarityBoost,
          style: cfg.style,
        },
      }),
    });
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      error: `elevenlabs HTTP ${res.status}: ${errText.slice(0, 200)}`,
    };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, audio: { data: buf, mime: "audio/ogg" } };
}

async function openaiTts(
  apiKey: string,
  text: string,
  cfg: NonNullable<Config["voice"]["openai"]>,
  fetchImpl: typeof fetch,
): Promise<SynthesizeResult> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        voice: cfg.voice,
        input: text,
        speed: cfg.speed,
        response_format: "opus",
      }),
    });
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      error: `openai HTTP ${res.status}: ${errText.slice(0, 200)}`,
    };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, audio: { data: buf, mime: "audio/ogg" } };
}

async function elevenlabsScribe(
  apiKey: string,
  audio: Buffer,
  mime: string,
  fetchImpl: typeof fetch,
): Promise<TranscribeResult> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([audio], { type: mime || "audio/ogg" }),
    "voice.ogg",
  );
  form.set("model_id", "scribe_v1");
  let res: Response;
  try {
    res = await fetchImpl("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      error: `elevenlabs scribe HTTP ${res.status}: ${errText.slice(0, 200)}`,
    };
  }
  const body = (await res.json()) as { text?: string };
  if (typeof body.text !== "string") {
    return { ok: false, error: "no transcript text in scribe response" };
  }
  return { ok: true, text: body.text };
}

async function openaiWhisper(
  apiKey: string,
  audio: Buffer,
  mime: string,
  fetchImpl: typeof fetch,
): Promise<TranscribeResult> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([audio], { type: mime || "audio/ogg" }),
    "voice.ogg",
  );
  form.set("model", "whisper-1");
  let res: Response;
  try {
    res = await fetchImpl(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      },
    );
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return {
      ok: false,
      error: `whisper HTTP ${res.status}: ${errText.slice(0, 200)}`,
    };
  }
  const body = (await res.json()) as { text?: string };
  if (typeof body.text !== "string") {
    return { ok: false, error: "no transcript text in whisper response" };
  }
  return { ok: true, text: body.text };
}
