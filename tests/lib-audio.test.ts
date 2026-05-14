/**
 * Tests for the TTS / STT dispatcher and provider implementations.
 * Uses mocked fetch — no network calls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  replyModalityOverride,
  sttSupport,
  sttSupported,
  synthesize,
  transcribe,
  ttsSupport,
  ttsSupported,
} from "../src/lib/audio.ts";
import type { Config } from "../src/config.ts";

const SAVED_ENV = {
  PHANTOMBOT_OPENAI_API_KEY: process.env.PHANTOMBOT_OPENAI_API_KEY,
  PHANTOMBOT_ELEVENLABS_API_KEY: process.env.PHANTOMBOT_ELEVENLABS_API_KEY,
};

beforeEach(() => {
  delete process.env.PHANTOMBOT_OPENAI_API_KEY;
  delete process.env.PHANTOMBOT_ELEVENLABS_API_KEY;
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function makeConfig(provider: Config["voice"]["provider"]): Config {
  const base: Omit<Config, "voice"> = {
    defaultPersona: "x",
    harnessIdleTimeoutMs: 1, harnessHardTimeoutMs: 1,
    personasDir: "/tmp",
    memoryDbPath: "/tmp/m.sqlite",
    configPath: "/tmp/c.toml",
    harnesses: {
      chain: [],
      claude: { bin: "x", model: "y", fallbackModel: "" },
      pi: { bin: "x", maxPayloadBytes: 1 },
      gemini: { bin: "x", model: "" },
    },
    channels: {},
    embeddings: { provider: "none" },
  };
  if (provider === "elevenlabs") {
    return {
      ...base,
      voice: {
        provider: "elevenlabs",
        elevenlabs: {
          voiceId: "v",
          modelId: "m",
          stability: 1,
          similarityBoost: 0.7,
          style: 0.8,
        },
      },
    };
  }
  if (provider === "openai") {
    return {
      ...base,
      voice: {
        provider: "openai",
        openai: { model: "tts-1", voice: "nova", speed: 1 },
      },
    };
  }
  if (provider === "azure_edge") {
    return {
      ...base,
      voice: {
        provider: "azure_edge",
        azure_edge: { voice: "en-US-JennyNeural", rate: "+0%", pitch: "+0Hz" },
      },
    };
  }
  return { ...base, voice: { provider: "none" } };
}

function fakeBytesFetch(bytes: Buffer, status = 200): typeof fetch {
  return (async () =>
    new Response(bytes, {
      status,
      headers: { "content-type": "audio/ogg" },
    })) as unknown as typeof fetch;
}

function fakeJsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("ttsSupported / sttSupported", () => {
  test("none → both false", () => {
    expect(ttsSupported(makeConfig("none"))).toBe(false);
    expect(sttSupported(makeConfig("none"))).toBe(false);
  });
  test("azure_edge → tts true, stt false", () => {
    expect(ttsSupported(makeConfig("azure_edge"))).toBe(true);
    expect(sttSupported(makeConfig("azure_edge"))).toBe(false);
  });
  test("openai with key → both true", () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    expect(ttsSupported(makeConfig("openai"))).toBe(true);
    expect(sttSupported(makeConfig("openai"))).toBe(true);
  });
  test("openai without key → both false", () => {
    expect(ttsSupported(makeConfig("openai"))).toBe(false);
    expect(sttSupported(makeConfig("openai"))).toBe(false);
  });
  test("elevenlabs with key → both true", () => {
    process.env.PHANTOMBOT_ELEVENLABS_API_KEY = "k";
    expect(ttsSupported(makeConfig("elevenlabs"))).toBe(true);
    expect(sttSupported(makeConfig("elevenlabs"))).toBe(true);
  });
});

describe("ttsSupport / sttSupport (diagnostic variants)", () => {
  test("none → provider_none for both", () => {
    expect(ttsSupport(makeConfig("none"))).toEqual({
      ok: false,
      reason: "provider_none",
      provider: "none",
    });
    expect(sttSupport(makeConfig("none"))).toEqual({
      ok: false,
      reason: "provider_none",
      provider: "none",
    });
  });

  test("azure_edge → ok for tts, provider_no_stt for stt", () => {
    expect(ttsSupport(makeConfig("azure_edge"))).toEqual({ ok: true });
    expect(sttSupport(makeConfig("azure_edge"))).toEqual({
      ok: false,
      reason: "provider_no_stt",
      provider: "azure_edge",
    });
  });

  test("openai without key → key_missing names env var for both", () => {
    expect(ttsSupport(makeConfig("openai"))).toEqual({
      ok: false,
      reason: "key_missing",
      provider: "openai",
      envVar: "PHANTOMBOT_OPENAI_API_KEY",
    });
    expect(sttSupport(makeConfig("openai"))).toEqual({
      ok: false,
      reason: "key_missing",
      provider: "openai",
      envVar: "PHANTOMBOT_OPENAI_API_KEY",
    });
  });

  test("openai with key → ok for both", () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    expect(ttsSupport(makeConfig("openai"))).toEqual({ ok: true });
    expect(sttSupport(makeConfig("openai"))).toEqual({ ok: true });
  });

  test("elevenlabs without key → key_missing names env var for both", () => {
    expect(ttsSupport(makeConfig("elevenlabs"))).toEqual({
      ok: false,
      reason: "key_missing",
      provider: "elevenlabs",
      envVar: "PHANTOMBOT_ELEVENLABS_API_KEY",
    });
    expect(sttSupport(makeConfig("elevenlabs"))).toEqual({
      ok: false,
      reason: "key_missing",
      provider: "elevenlabs",
      envVar: "PHANTOMBOT_ELEVENLABS_API_KEY",
    });
  });

  test("elevenlabs with key → ok for both", () => {
    process.env.PHANTOMBOT_ELEVENLABS_API_KEY = "k";
    expect(ttsSupport(makeConfig("elevenlabs"))).toEqual({ ok: true });
    expect(sttSupport(makeConfig("elevenlabs"))).toEqual({ ok: true });
  });
});

describe("synthesize", () => {
  test("elevenlabs returns ogg buffer on success", async () => {
    process.env.PHANTOMBOT_ELEVENLABS_API_KEY = "k";
    const fakeAudio = Buffer.from([1, 2, 3, 4, 5]);
    const r = await synthesize(
      makeConfig("elevenlabs"),
      "hello",
      fakeBytesFetch(fakeAudio),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.audio.mime).toBe("audio/ogg");
      expect(r.audio.data).toEqual(fakeAudio);
    }
  });

  test("openai returns ogg buffer on success", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const fakeAudio = Buffer.from([7, 8, 9]);
    const r = await synthesize(
      makeConfig("openai"),
      "hello",
      fakeBytesFetch(fakeAudio),
    );
    expect(r.ok).toBe(true);
  });

  test("azure_edge → not implemented error (clear message)", async () => {
    const r = await synthesize(makeConfig("azure_edge"), "hello");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not implemented");
  });

  test("none → error", async () => {
    const r = await synthesize(makeConfig("none"), "hello");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("none");
  });

  test("missing key → clear error", async () => {
    const r = await synthesize(makeConfig("elevenlabs"), "hello");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ElevenLabs API key");
  });

  test("HTTP 401 → error with status", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "bad";
    const r = await synthesize(
      makeConfig("openai"),
      "hello",
      fakeBytesFetch(Buffer.from(""), 401),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("HTTP 401");
  });
});

describe("transcribe", () => {
  test("openai whisper returns text", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const r = await transcribe(
      makeConfig("openai"),
      Buffer.from("audio bytes"),
      "audio/ogg",
      fakeJsonFetch({ text: "hello world" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("hello world");
  });

  test("elevenlabs scribe returns text", async () => {
    process.env.PHANTOMBOT_ELEVENLABS_API_KEY = "k";
    const r = await transcribe(
      makeConfig("elevenlabs"),
      Buffer.from("audio"),
      "audio/ogg",
      fakeJsonFetch({ text: "transcript here" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("transcript here");
  });

  test("azure_edge → STT not supported", async () => {
    const r = await transcribe(
      makeConfig("azure_edge"),
      Buffer.from(""),
      "audio/ogg",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not supported");
  });

  test("HTTP error returns clear message", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "bad";
    const r = await transcribe(
      makeConfig("openai"),
      Buffer.from(""),
      "audio/ogg",
      fakeJsonFetch({ error: { message: "bad" } }, 401),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("401");
  });

  test("response without text → error", async () => {
    process.env.PHANTOMBOT_OPENAI_API_KEY = "k";
    const r = await transcribe(
      makeConfig("openai"),
      Buffer.from(""),
      "audio/ogg",
      fakeJsonFetch({}),
    );
    expect(r.ok).toBe(false);
  });
});

describe("replyModalityOverride", () => {
  // Positive — text directive
  test.each([
    "please reply in text",
    "respond with text",
    "Answer as text please",
    "give me a text reply",
    "text response only",
    "no voice please",
    "don't use voice",
    "Do not reply with voice",
    "as text",
    "in text format",
    "could you respond using text",
  ])("text directive: %s → text", (input) => {
    expect(replyModalityOverride(input)).toBe("text");
  });

  // Positive — voice directive
  test.each([
    "respond with voice",
    "reply in voice please",
    "send me a voice note",
    "voice note please",
    "as a voice",
    "voice reply",
    "answer with a voice note",
    "no text please",
    "don't use text",
    "Do not reply with text",
    "no text, voice please",
    "don't reply with text",
  ])("voice directive: %s → voice", (input) => {
    expect(replyModalityOverride(input)).toBe("voice");
  });

  // Negative — bare nouns must not trigger
  test.each([
    "the next chapter is text-heavy",
    "compose a text message to john",
    "what is the voice of the narrator",
    "the report has voice tags in it",
    "I'm reading a textbook",
    "summarise this text",
    "what's the difference between text and audio formats",
    "",
    undefined,
  ])("no directive: %p → undefined", (input) => {
    expect(replyModalityOverride(input)).toBeUndefined();
  });

  test("both directives in one message — later one wins (text after voice)", () => {
    expect(
      replyModalityOverride("send a voice note — actually reply in text"),
    ).toBe("text");
  });

  test("both directives in one message — later one wins (voice after text)", () => {
    expect(
      replyModalityOverride("text response please — wait, respond with voice"),
    ).toBe("voice");
  });

  test("both negations in one message — later one wins (voice negated last → text)", () => {
    expect(
      replyModalityOverride("no text — actually don't use voice either"),
    ).toBe("text");
  });

  test("both negations in one message — later one wins (text negated last → voice)", () => {
    expect(
      replyModalityOverride("no voice — actually don't reply with text"),
    ).toBe("voice");
  });

  test("case-insensitive", () => {
    expect(replyModalityOverride("REPLY IN TEXT")).toBe("text");
    expect(replyModalityOverride("Send A Voice Note")).toBe("voice");
    expect(replyModalityOverride("NO TEXT PLEASE")).toBe("voice");
  });
});
