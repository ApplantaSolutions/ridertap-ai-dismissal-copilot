// SPIKE — Muse Voice Transcribe, REAL contract (R-05 follow-up). READY, NOT RUN.
//
// The original transcribe-spike.ts guessed the OpenAI-style file endpoint
// and measured its answer on Oct 29: POST /v1/audio/transcriptions → 404.
// The contract has since been pinned from Meta's official docs + cookbook
// (see ~/workspace/ridertap/hackathon/TRANSCRIBE-CONTRACT.md):
//
//   streaming:  wss://api.meta.ai/v1/asr/realtime — handshake JSON carries
//               the credential (authorization.accessToken), audio is raw
//               PCM binary frames paced at real time, {"type":"endStream"}
//               half-closes input, events are type-tagged JSON.
//   one-shot:   POST https://api.meta.ai/v1/asr/transcribe — Authorization
//               header, multipart with a JSON "request" part + WAV "audio"
//               part; caps 10 min / 32 MB.
//
// This spike implements the pinned contract. Default = ONE streaming
// session (the transport the product research bet on). --once = ONE
// one-shot POST instead (the transport the Copilot adapter will likely
// use for push-to-talk clips). Exactly one call per invocation.
//
// Usage:
//   META_API_KEY=<redacted> bun spikes/transcribe-stream-spike.ts [--audio clip.wav]
//       [--mode PUSH_TO_TALK|ENDPOINTING|DIARIZATION] [--once]
//       [--keywords 101,102,103] [--language-bias english]
// Without --audio it uses generated silence (1s, 16 kHz): a handshake /
// session / close probe only — silence yields no transcript, and that is
// a valid contract result. With --audio, pass a mono 16-bit WAV at 16 or
// 24 kHz (a VOICE-CASES clip once they exist: spoken tags, e.g. "three
// four five"). Convert anything else first:
//   ffmpeg -i in.mp3 -ac 1 -ar 24000 -sample_fmt s16 clip.wav

import { authHeaders, BASE_URL, requireKey, shapeOf, timedFetch } from "./lib";

const MODEL = process.env.COPILOT_TRANSCRIBE_MODEL_ID ?? "muse-voice-transcribe-1.0";
const WS_URL = `${BASE_URL.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/asr/realtime`;
const ONCE_URL = `${BASE_URL}/asr/transcribe`;

// In-play tags for the demo wave — the biasing set from the original spike.
const DEFAULT_KEYWORDS = ["101", "102", "103", "104", "345", "354"];
const MODES = ["PUSH_TO_TALK", "ENDPOINTING", "DIARIZATION"] as const;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const audioPath = argValue("--audio");
const mode = argValue("--mode") ?? "PUSH_TO_TALK";
const keywords = (argValue("--keywords")?.split(",").map((s) => s.trim()).filter(Boolean)) ?? DEFAULT_KEYWORDS;
const languageBias = argValue("--language-bias") ? [argValue("--language-bias")!] : undefined;
const once = process.argv.includes("--once");

if (!(MODES as readonly string[]).includes(mode)) {
  console.error(`unknown --mode ${mode}; expected one of ${MODES.join(", ")}`);
  process.exit(1);
}

// ------------------------------------------------------------ WAV handling --
interface WavData {
  pcm: Uint8Array;
  wavBytes: Uint8Array;
  sampleRate: number;
  seconds: number;
}

/** Smallest valid WAV around raw PCM: 16-bit mono at `sampleRate`. */
function makeWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + pcm.length);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  writeStr(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, "data");
  v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(buf);
  out.set(pcm, 44);
  return out;
}

/** Parse a WAV file: validate mono / 16-bit, locate the data chunk. */
function parseWav(bytes: Uint8Array): WavData {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) =>
    String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("not a WAV file (missing RIFF/WAVE header)");
  }
  let channels = 0, bits = 0, sampleRate = 0, dataOff = -1, dataLen = 0;
  for (let off = 12; off + 8 <= bytes.length; ) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      channels = v.getUint16(off + 10, true);
      sampleRate = v.getUint32(off + 12, true);
      bits = v.getUint16(off + 22, true);
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = Math.min(size, bytes.length - dataOff);
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) throw new Error("WAV has no data chunk");
  const problems: string[] = [];
  if (channels !== 1) problems.push(`${channels} channels (need mono)`);
  if (bits !== 16) problems.push(`${bits}-bit samples (need 16-bit)`);
  if (sampleRate !== 16000 && sampleRate !== 24000) {
    problems.push(`${sampleRate} Hz (need 16000 or 24000)`);
  }
  if (problems.length) {
    throw new Error(
      `${problems.join(", ")}. Convert it with:\n  ffmpeg -i <in> -ac 1 -ar 24000 -sample_fmt s16 clip.wav`,
    );
  }
  const pcm = bytes.subarray(dataOff, dataOff + dataLen);
  return { pcm, wavBytes: bytes, sampleRate, seconds: pcm.length / (sampleRate * 2) };
}

async function loadAudio(): Promise<WavData & { note: string }> {
  if (audioPath) {
    const bytes = new Uint8Array(await Bun.file(audioPath).arrayBuffer());
    return { ...parseWav(bytes), note: `real clip: ${audioPath}` };
  }
  const sampleRate = 16000;
  const pcm = new Uint8Array(sampleRate * 2); // 1s of silence
  return {
    pcm,
    wavBytes: makeWav(pcm, sampleRate),
    sampleRate,
    seconds: 1,
    note: "1s generated silence (contract probe only — no transcript expected)",
  };
}

// ------------------------------------------------------------- one-shot -----
async function runOnce(key: string, audio: WavData & { note: string }): Promise<number> {
  console.log(`Transcribe spike (one-shot) — model=${MODEL} mode=${mode}`);
  console.log(`endpoint: POST ${ONCE_URL}`);
  console.log(`audio: ${audio.note} · ${audio.seconds.toFixed(2)}s · ${audio.sampleRate} Hz`);
  // Pinned shape (TRANSCRIBE-CONTRACT §3): the params travel as a JSON
  // part named "request", NOT as form fields; auth is the Bearer header.
  const requestJson = {
    mode,
    model: MODEL,
    audioEncoding: "WAV",
    ...(keywords.length ? { keywords } : {}),
    ...(languageBias ? { languageBias } : {}),
  };
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(requestJson)], { type: "application/json" }));
  form.append("audio", new Blob([audio.wavBytes as BlobPart], { type: "audio/wav" }), audioPath ?? "probe.wav");

  const { res, ms } = await timedFetch(ONCE_URL, {
    method: "POST",
    headers: { ...authHeaders(key) },
    body: form,
  });
  const text = await res.text();
  console.log(`HTTP ${res.status} · latency ${ms} ms`);
  try {
    const json = JSON.parse(text);
    console.log(`response shape: ${shapeOf(json)}`);
    if (json.transcript !== undefined) console.log(`transcript: ${JSON.stringify(json.transcript)}`);
    if (json.audioDurationMs !== undefined) console.log(`audioDurationMs: ${json.audioDurationMs}`);
    if (Array.isArray(json.turns)) {
      for (const t of json.turns) {
        console.log(`  turn [${((t.startMs ?? 0) / 1000).toFixed(2)}s] ${t.speaker ? `${t.speaker}: ` : ""}${t.transcript ?? ""}`);
      }
    }
    if (!res.ok) console.log(`response excerpt: ${text.slice(0, 800)}`);
  } catch {
    console.log(`response (non-JSON), first 800 chars:\n${text.slice(0, 800)}`);
  }
  return res.ok ? 0 : 1;
}

// ------------------------------------------------------------ streaming -----
async function runStream(key: string, audio: WavData & { note: string }): Promise<number> {
  const encoding = audio.sampleRate === 16000 ? "PCM_16KHZ" : "PCM_24KHZ";
  console.log(`Transcribe spike (streaming) — model=${MODEL} mode=${mode} encoding=${encoding}`);
  console.log(`endpoint: ${WS_URL}`);
  console.log(`audio: ${audio.note} · ${audio.seconds.toFixed(2)}s · ${audio.sampleRate} Hz`);

  const handshake = {
    mode,
    // The credential rides inside the handshake JSON — there is no
    // Authorization header on this endpoint. NEVER print the handshake.
    authorization: { accessToken: key },
    audioEncoding: encoding,
    model: MODEL,
    partialMode: "CUMULATIVE",
    emitAudioProgress: false,
    ...(keywords.length ? { keywords } : {}),
    ...(languageBias ? { languageBias } : {}),
  };
  console.log(
    `handshake shape: { mode, authorization: { accessToken: <redacted> }, audioEncoding, model, partialMode, emitAudioProgress` +
      `${keywords.length ? ", keywords" : ""}${languageBias ? ", languageBias" : ""} }`,
  );

  const started = performance.now();
  const rel = () => Math.round(performance.now() - started);
  const result = { code: 1 };

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    let acked = false;
    let sawError = false;
    let firstTranscriptMs: number | null = null;
    const finals: string[] = [];
    const completedTurns = new Map<number, string>();

    const overallTimer = setTimeout(() => {
      console.log(`timeout: no close within ${(audio.seconds + 30).toFixed(0)}s of audio — closing locally`);
      try { ws.close(); } catch { /* already closed */ }
    }, (audio.seconds + 30) * 1000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(handshake));
    });

    ws.addEventListener("message", async (ev) => {
      if (typeof ev.data !== "string") return; // binary frames carry no events
      let frame: any;
      try { frame = JSON.parse(ev.data); } catch {
        console.log(`[+${rel()} ms] non-JSON text frame: ${String(ev.data).slice(0, 200)}`);
        return;
      }
      // The handshake ack is the one frame with no "type": {"sessionId": …}.
      if (!acked && frame && typeof frame === "object" && "sessionId" in frame && !("type" in frame)) {
        acked = true;
        console.log(`[+${rel()} ms] session ack: sessionId=${frame.sessionId}`);
        // Server answers the handshake before accepting audio — stream now.
        void sendAudio();
        return;
      }
      const type = frame?.type ?? "unknown";
      console.log(`[+${rel()} ms] event ${type}: ${JSON.stringify(frame).slice(0, 400)}`);
      if (type === "transcript") {
        if (firstTranscriptMs === null) firstTranscriptMs = rel();
        if (frame.final) finals.push(String(frame.transcript ?? ""));
      } else if (type === "speechComplete") {
        completedTurns.set(Number(frame.turnId), String(frame.transcript ?? ""));
      } else if (type === "error") {
        sawError = true;
        console.log(`server error event (verbatim): ${frame.message ?? "(no message)"}`);
      }
    });

    async function sendAudio() {
      // 80 ms frames, paced against an absolute schedule (contract §2.3:
      // >5s backlog or <real-time ingress for 10s both close with 1008).
      const chunkBytes = Math.floor(audio.sampleRate * 2 * 80 / 1000);
      const t0 = performance.now();
      let sentSeconds = 0;
      for (let off = 0; off < audio.pcm.length; off += chunkBytes) {
        const chunk = audio.pcm.subarray(off, Math.min(off + chunkBytes, audio.pcm.length));
        ws.send(chunk);
        sentSeconds += chunk.length / (audio.sampleRate * 2);
        const behind = t0 + sentSeconds * 1000 - performance.now();
        if (behind > 0) await Bun.sleep(behind);
      }
      ws.send(JSON.stringify({ type: "endStream" }));
      console.log(`[+${rel()} ms] audio fully sent (${sentSeconds.toFixed(2)}s), endStream sent`);
    }

    ws.addEventListener("error", () => {
      console.log(`[+${rel()} ms] websocket error event`);
    });

    ws.addEventListener("close", (ev) => {
      clearTimeout(overallTimer);
      const meaning = {
        1000: "clean finish",
        1008: "policy violation — bad handshake/request, or pacing broke (backlog >5s, ingress <real-time 10s, no handshake in 10s)",
        1011: "server error, or 60-minute session cap reached",
        1013: "rate limited — back off and reconnect",
      }[ev.code] ?? "unexpected close";
      console.log(`[+${rel()} ms] closed: code=${ev.code} (${meaning}) reason=${JSON.stringify(ev.reason ?? "")}`);
      if (firstTranscriptMs !== null) console.log(`first transcript event at +${firstTranscriptMs} ms`);
      if (finals.length) console.log(`final transcript: ${JSON.stringify(finals[finals.length - 1])}`);
      for (const [turnId, transcript] of completedTurns) {
        console.log(`speechComplete turn ${turnId}: ${JSON.stringify(transcript)}`);
      }
      result.code = ev.code === 1000 && !sawError ? 0 : 1;
      resolve();
    });
  });

  return result.code;
}

// ------------------------------------------------------------------ main ----
const key = requireKey();
let audio: WavData & { note: string };
try {
  audio = await loadAudio();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const exitCode = once ? await runOnce(key, audio) : await runStream(key, audio);
console.log(
  "\nRecord in SPIKE-RESULTS.md: endpoint + transport used, session ack latency,\n" +
    "first-partial and final transcript verbatim, speechComplete turns, close code\n" +
    "(streaming) — or HTTP status, audioDurationMs, transcript and turns (one-shot).\n" +
    "Then the live Transcribe adapter is wired to the pinned contract.",
);
process.exit(exitCode);
