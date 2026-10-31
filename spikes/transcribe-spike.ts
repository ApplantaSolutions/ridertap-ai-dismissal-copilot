// SPIKE — Muse Voice Transcribe input contract (R-05). READY, NOT RUN.
//
// Research says Transcribe is streaming-over-WebSocket with in-model
// VAD/endpointing and keyword biasing (muse-voice-transcribe-1.0,
// $0.18/hr) — but its exact callable contract was NOT verified against
// the live catalog. This spike's job is to replace that assumption with
// a measured fact, using the smallest possible probe:
//
//   Attempt: ONE OpenAI-style multipart POST /audio/transcriptions with
//   a tiny silent WAV, the research model ID, and a keyword-biasing
//   field attempt. Whatever comes back IS the deliverable:
//     - 200 + transcript shape → the file-clip path (C-07 fallback) is
//       real; record format limits from the response/docs.
//     - 4xx naming an unknown field/model/endpoint → record the exact
//       error verbatim in SPIKE-RESULTS.md; the contract is then pinned
//       from JR's account docs/console before Thu's voice build, and
//       C-07's pre-decision (push-to-talk file clips in an accepted
//       format; biasing replaced by closed-set resolver weighting)
//       governs the build either way.
//
// Usage:
//   META_API_KEY=… bun spikes/transcribe-spike.ts [--audio clip.wav]
// With --audio, a real walker clip replaces the silent probe (use a
// VOICE-CASES clip once they exist: spoken tags, e.g. "three four five").

import { authHeaders, BASE_URL, requireKey, shapeOf, timedFetch } from "./lib";

const MODEL = process.env.COPILOT_TRANSCRIBE_MODEL_ID ?? "muse-voice-transcribe-1.0";

/** Smallest valid WAV: 0.25s of 16kHz mono silence. */
function silentWav(): Uint8Array {
  const sampleRate = 16000;
  const samples = sampleRate / 4;
  const dataSize = samples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, "data");
  v.setUint32(40, dataSize, true);
  return new Uint8Array(buf);
}

const audioArg = process.argv.indexOf("--audio");
const audioPath = audioArg >= 0 ? process.argv[audioArg + 1] : undefined;

const key = requireKey();
console.log(`Transcribe spike — model=${MODEL}`);
console.log(`endpoint attempt: POST ${BASE_URL}/audio/transcriptions (multipart)`);
console.log(
  audioPath ? `audio: ${audioPath}` : "audio: 0.25s silent WAV probe (contract check only)",
);

const form = new FormData();
const audioBytes = audioPath
  ? new Uint8Array(await Bun.file(audioPath).arrayBuffer())
  : silentWav();
form.append("file", new Blob([audioBytes as BlobPart], { type: "audio/wav" }), audioPath ?? "probe.wav");
form.append("model", MODEL);
form.append("response_format", "json");
// Keyword-biasing attempt: the in-play tags for the demo wave. If the API
// rejects unknown fields, the error text is spike data — record it.
form.append("keywords", JSON.stringify(["101", "102", "103", "104", "345", "354"]));

const { res, ms } = await timedFetch(`${BASE_URL}/audio/transcriptions`, {
  method: "POST",
  headers: { ...authHeaders(key) },
  body: form,
});
const text = await res.text();
console.log(`HTTP ${res.status} · latency ${ms} ms`);
try {
  const json = JSON.parse(text);
  console.log(`response shape: ${shapeOf(json)}`);
  console.log(`response excerpt: ${text.slice(0, 800)}`);
} catch {
  console.log(`response (non-JSON), first 800 chars:\n${text.slice(0, 800)}`);
}
console.log(
  "\nRecord VERBATIM in SPIKE-RESULTS.md: this status + shape/error, the accepted audio\n" +
    "formats, whether keyword biasing exists as a callable parameter (and its real name),\n" +
    "and whether streaming is WebSocket-only. Then the C-07 decision is final for Thu.",
);
if (!res.ok) process.exit(1);
