// Transcribe adapter — the seam between the voice service and Meta's
// Muse Voice Transcribe, mirroring src/sam.ts (Build 1) and src/spark.ts
// (Build 2). The voice service NEVER talks to the Meta Model API
// directly; it calls this interface. Two implementations:
//   - StubTranscribeAdapter: returns the SCRIPTED transcript for a
//     test-asset clip/utterance ID, exactly as test-assets/VOICE-CASES.md
//     assumes it (spoken words where the case grades normalization and
//     resolution; the digit string where the case defines its assumed
//     transcript as digits). This is the grading implementation (the
//     scenario harnesses force it via COPILOT_TRANSCRIBE_ADAPTER=stub).
//   - LiveTranscribeAdapter: the real Muse Voice Transcribe call, built
//     to the contract pinned from Meta's official docs and CONFIRMED
//     live Oct 29 (TRANSCRIBE-CONTRACT.md, SPIKE-RESULTS.md): one-shot
//     POST /v1/asr/transcribe, multipart with a JSON `request` part
//     ({mode: "PUSH_TO_TALK", model, audioEncoding: "WAV", keywords})
//     and the WAV clip as the `audio` part; the response's top-level
//     `transcript` is the surface. It FAILS CLOSED: no key, no audio, an
//     HTTP error, or a malformed response throws `live_adapter_error`,
//     and the voice service degrades to its ASK-REPEAT path — voice
//     entry never fabricates a transcript and never silently stubs.
//
// KEYWORD BIASING (contract): every transcribe call carries the in-play
// tag list — the closed set the resolver will check against — as the
// biasing vocabulary. The stub echoes the list it was biased toward in
// its result so the gate can assert the biasing actually happened; the
// live adapter will send the same list as transcription keywords.
//
// PRIVACY: walker (staff) audio is transcribed and DISCARDED. The
// adapter returns a transcript string in memory only; nothing in this
// layer persists audio or transcripts anywhere (the voice-event log in
// src/voice.ts stores only the resolved tag + outcome).

export interface TranscribeInput {
  /** Clip/utterance ID when the audio comes from the test set (e.g. "VC-01"). */
  clipId?: string;
  /**
   * The walker's PTT clip as base64 WAV bytes — the live adapter's
   * input. Audio is transcribed and discarded; it is never persisted
   * anywhere in this layer (see the privacy note above).
   */
  audioBase64?: string;
  /** Lane the walker's phone serves: 'left' | 'right' | 'main'. */
  lane: string;
  /** The in-play tag numbers — keyword-biasing vocabulary (the closed set). */
  biasedTags: string[];
  /** App language hint ('en' | 'es'); transcription language is per-utterance. */
  language?: string;
}

export interface TranscribeResult {
  /** Transcript text, in memory only — never persisted by any caller. */
  transcript: string;
  /** Language AS TRANSCRIBED (per-utterance; code-switching is normal). */
  language: "en" | "es";
  latencyMs: number;
  modelId: string;
  source: "stub" | "live";
  /** Echo of the biasing vocabulary this call carried (graded on the stub). */
  biasedTags: string[];
}

export interface TranscribeAdapter {
  readonly kind: "stub" | "live";
  readonly modelId: string;
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}

// ---------------------------------------------------------------- stub ---
// Scripted transcripts keyed by clip ID, from VOICE-CASES.md. Where a
// case's assumed transcript is a word phrase, the phrase is what the
// stub returns (normalization + resolution are the graded surface);
// where the case defines its assumed transcript as digits, digits are
// returned. For the Spanish clean cases the case file states the assumed
// transcript as the resolved digits — the stub returns the spoken
// Spanish phrase instead, so the resolver's ES normalization is graded
// on the phrase and must produce exactly those digits.
interface ScriptedClip {
  transcript: string;
  language: "en" | "es";
}
const SCRIPTED: Record<string, ScriptedClip> = {
  "VC-01": { transcript: "214", language: "en" },
  "VC-02-1": { transcript: "two twelve", language: "en" },
  "VC-02-2": { transcript: "two twenty-one", language: "en" },
  "VC-02-3": { transcript: "three forty-five", language: "en" },
  "VC-02-4": { transcript: "three fifty-four", language: "en" },
  "VC-03": { transcript: "left 214", language: "en" },
  "VC-04-1": { transcript: "three forty-five", language: "en" },
  "VC-04-2": { transcript: "three five four", language: "en" },
  "VC-05": { transcript: "three forty-five", language: "en" },
  // VC-06's planted error: the walker said "two twenty-one"; the assumed
  // transcript is 212. The resolver cannot know — that is the case.
  "VC-06": { transcript: "212", language: "en" },
  "VC-07-1": { transcript: "399", language: "en" },
  "VC-07-2": { transcript: "three fifty-nine", language: "en" },
  "VC-08": { transcript: "for oh one", language: "en" },
  "VC-09": { transcript: "two fourteen", language: "en" },
  "VC-10": { transcript: "two twenty-one", language: "en" },
  "VC-11": { transcript: "nine ninety-nine", language: "en" },
  "VC-12-1": { transcript: "three forty-seven", language: "en" },
  "VC-12-2": { transcript: "three forty-five", language: "en" },
  // VC-13 (playground noise): the target transcript at the resolver boundary.
  "VC-13": { transcript: "212", language: "en" },
  // VC-14 is ambient audio with NO push-to-talk session: the voice
  // service rejects it before any adapter call. The clip exists here so
  // the gate can prove the rejection happens upstream of transcription.
  "VC-14": { transcript: "three fifty-four", language: "en" },
  // VC-15 (wind/traffic): the degraded transcript, then the clean repeat.
  "VC-15-1": { transcript: "3 4", language: "en" },
  "VC-15-2": { transcript: "three fifty-four", language: "en" },
  "VC-16": { transcript: "two twen", language: "en" },
  "VC-17": { transcript: "doscientos catorce", language: "es" },
  "VC-18-1": { transcript: "doscientos doce", language: "es" },
  "VC-18-2": { transcript: "trescientos cuarenta y cinco", language: "es" },
  "VC-18-3": { transcript: "trescientos cincuenta y cuatro", language: "es" },
  "VC-19": { transcript: "trescientos cuarenta y cinco", language: "es" },
  "VC-20-1": { transcript: "two twelve", language: "en" },
  "VC-20-2": { transcript: "doscientos veintiuno", language: "es" },
  "VC-20-3": { transcript: "three forty-five", language: "en" },
};

export class StubTranscribeAdapter implements TranscribeAdapter {
  readonly kind = "stub" as const;
  readonly modelId = "stub:muse-voice-transcribe-scripted";

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const started = performance.now();
    if (!input.clipId) {
      throw new Error(
        "stub_adapter_requires_clip_id: the stub grades test-asset clips; live audio needs the live adapter (not yet enabled)",
      );
    }
    const clip = SCRIPTED[input.clipId];
    if (!clip) {
      throw new Error(`stub_adapter_unknown_clip: ${input.clipId}`);
    }
    return {
      transcript: clip.transcript,
      language: clip.language,
      latencyMs: Math.round(performance.now() - started),
      modelId: this.modelId,
      source: "stub",
      biasedTags: [...input.biasedTags],
    };
  }
}

// ---------------------------------------------------------------- live ---
const META_BASE_URL = process.env.META_API_BASE_URL ?? "https://api.meta.ai/v1";
/** Measured median was 632 ms; the ceiling only bounds a hung request. */
const TRANSCRIBE_TIMEOUT_MS = 20_000;

/**
 * The measured one-shot request JSON (TRANSCRIBE-CONTRACT §3): params
 * travel as a JSON part named "request", NOT as form fields. `keywords`
 * carries the in-play tag list — it nudges the transcription toward the
 * closed set; the resolver remains the guarantee. `languageBias` is
 * deliberately omitted (the confirmed-live run did not use it, and the
 * resolver detects EN/ES per utterance downstream).
 */
export function buildTranscribeRequestJson(
  modelId: string,
  input: TranscribeInput,
): Record<string, unknown> {
  return {
    mode: "PUSH_TO_TALK",
    model: modelId,
    audioEncoding: "WAV",
    ...(input.biasedTags.length ? { keywords: [...input.biasedTags] } : {}),
  };
}

/** The exact multipart body the live adapter sends (unit-test surface). */
export function buildTranscribeForm(
  modelId: string,
  input: TranscribeInput,
  wavBytes: Uint8Array,
): FormData {
  const form = new FormData();
  form.append(
    "request",
    new Blob([JSON.stringify(buildTranscribeRequestJson(modelId, input))], {
      type: "application/json",
    }),
  );
  form.append("audio", new Blob([wavBytes as BlobPart], { type: "audio/wav" }), "walker.wav");
  return form;
}

function liveError(reason: string): Error {
  return new Error(`live_adapter_error: ${reason}`);
}

export class LiveTranscribeAdapter implements TranscribeAdapter {
  readonly kind = "live" as const;
  readonly modelId = process.env.COPILOT_TRANSCRIBE_MODEL_ID ?? "muse-voice-transcribe-1.0";

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const started = performance.now();
    const key = process.env.META_API_KEY;
    if (!key) {
      throw liveError(
        "META_API_KEY is not configured — the live Transcribe adapter cannot run. " +
          "The voice service will ask the walker to repeat.",
      );
    }
    if (!input.audioBase64) {
      throw liveError(
        "the live Transcribe adapter needs the PTT clip bytes (audioBase64); " +
          "clip IDs are the stub path.",
      );
    }
    const wavBytes = Buffer.from(input.audioBase64, "base64");
    let res: Response;
    try {
      res = await fetch(`${META_BASE_URL}/asr/transcribe`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: buildTranscribeForm(this.modelId, input, wavBytes),
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      });
    } catch (e) {
      throw liveError(`Transcribe request failed (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!res.ok) {
      throw liveError(`Transcribe returned HTTP ${res.status}`);
    }
    const json: unknown = await res.json().catch(() => null);
    const transcript = (json as { transcript?: unknown })?.transcript;
    if (typeof transcript !== "string") {
      throw liveError("Transcribe response carried no transcript");
    }
    // The audio bytes and the transcript end their life in the resolver;
    // neither is persisted (the voice log stores tag + outcome only).
    // The response carries no language field — the app hint rides along
    // and the resolver re-detects the utterance's language from the
    // transcript itself (numbers.ts detectLanguage).
    return {
      transcript,
      language: input.language === "es" ? "es" : "en",
      latencyMs: Math.round(performance.now() - started),
      modelId: this.modelId,
      source: "live",
      biasedTags: [...input.biasedTags],
    };
  }
}

export function selectTranscribeAdapter(): TranscribeAdapter {
  const kind = (process.env.COPILOT_TRANSCRIBE_ADAPTER ?? "live").toLowerCase();
  if (kind === "live") return new LiveTranscribeAdapter();
  if (kind !== "stub") {
    throw new Error(`unknown COPILOT_TRANSCRIBE_ADAPTER value: ${kind}`);
  }
  return new StubTranscribeAdapter();
}
