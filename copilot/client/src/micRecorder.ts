// Phone microphone capture for push-to-talk — the live half of mic
// capture (wav.ts is the pure encoding half).
//
// PRIVACY, by construction: the microphone is requested only from the
// press handler and every track is stopped on release — capture exists
// ONLY while the walker holds the button, never ambient. The clip lives
// in memory just long enough to be sent once for transcription; nothing
// is written to any storage and nothing is logged.
//
// ENGINE HISTORY (Oct 30, learned on JR's real phone): capture began as
// raw PCM over WebAudio ScriptProcessor. On his Android Chrome the
// processor node never delivered a single buffer — the panel showed
// "Recording" (a wall-clock state) while capturing silence, and the
// press failed with no trace on either side. ScriptProcessor is
// deprecated and its scheduling is exactly the kind of thing OEM
// browser builds quietly skip. Capture now runs on MediaRecorder —
// the one capture API every Android browser actually exercises — and
// the recorded blob is decoded and resampled to 16 kHz mono WAV
// client-side (OfflineAudioContext + wav.ts), because the transcribe
// contract takes WAV and MediaRecorder produces webm/opus or mp4.

import { encodeWav, WAV_TARGET_SAMPLE_RATE } from "./wav";

export type MicFailure = "denied" | "unavailable" | "cancelled";

export class MicError extends Error {
  readonly failure: MicFailure;
  constructor(failure: MicFailure) {
    super(`microphone ${failure}`);
    this.failure = failure;
  }
}

export interface RecordedClip {
  wav: Uint8Array;
  /** Length of the encoded (16 kHz) audio, in milliseconds. */
  durationMs: number;
}

/** Container preference order for MediaRecorder; first supported wins. */
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

export class PttRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private cancelled = false;
  recording = false;
  /** Set true once a decoded clip actually contains samples. */
  sawAudio = false;
  /** What the last stop() saw: decoded samples + engine state. */
  lastCapture: { samples: number; ctxState: string } | null = null;

  /**
   * Kept for the panel's call symmetry with the old engine: the
   * MediaRecorder path needs no gesture-prepared context (decoding
   * runs on an OfflineAudioContext, which has no activation rules).
   */
  prepareContext(): void {
    // no-op on this engine
  }

  async start(): Promise<void> {
    if (this.recording) return;
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new MicError("unavailable");
    }
    let stream: MediaStream;
    try {
      stream = await md.getUserMedia({ audio: true });
    } catch (e) {
      // NotAllowedError = the walker (or the OS) said no; anything else
      // (no device, busy device, insecure context) is "unavailable".
      throw new MicError(
        (e as { name?: string })?.name === "NotAllowedError" ? "denied" : "unavailable",
      );
    }
    if (this.cancelled) {
      stream.getTracks().forEach((t) => t.stop());
      throw new MicError("cancelled");
    }
    this.stream = stream;
    const mimeType = MIME_CANDIDATES.find((m) => {
      try {
        return MediaRecorder.isTypeSupported(m);
      } catch {
        return false;
      }
    });
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      this.dispose();
      throw new MicError("unavailable");
    }
    this.chunks = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    this.recorder = recorder;
    recorder.start(250);
    this.recording = true;
  }

  /** Stop capture and return the WAV clip; null if nothing was captured. */
  async stop(): Promise<RecordedClip | null> {
    if (!this.recording || !this.recorder) {
      this.cancel();
      return null;
    }
    const recorder = this.recorder;
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    try {
      recorder.stop();
    } catch {
      // already stopped — fall through and decode whatever arrived
    }
    await stopped;
    const chunks = this.chunks;
    const type = recorder.mimeType || chunks[0]?.type || "audio/webm";
    this.dispose();
    if (chunks.length === 0) {
      this.lastCapture = { samples: 0, ctxState: "mediarecorder:no-data" };
      return null;
    }
    try {
      const blob = new Blob(chunks, { type });
      const raw = await blob.arrayBuffer();
      // Decode + resample in one step: an OfflineAudioContext at the
      // target rate hands back 16 kHz mono samples directly.
      const offline = new OfflineAudioContext(1, 1, WAV_TARGET_SAMPLE_RATE);
      const decoded = await offline.decodeAudioData(raw);
      const samples = decoded.getChannelData(0).slice();
      this.lastCapture = {
        samples: samples.length,
        ctxState: `mediarecorder:decoded-${decoded.sampleRate}hz`,
      };
      if (samples.length === 0) return null;
      this.sawAudio = true;
      const wav = encodeWav(samples, WAV_TARGET_SAMPLE_RATE);
      return { wav, durationMs: Math.round((samples.length / WAV_TARGET_SAMPLE_RATE) * 1000) };
    } catch {
      // An undecodable clip is a capture failure, not a crash: the
      // panel turns a null clip into its visible no-audio note.
      this.lastCapture = { samples: 0, ctxState: "mediarecorder:decode-failed" };
      return null;
    }
  }

  /** Abandon capture (released before it started, unmount, new press). */
  cancel(): void {
    this.cancelled = true;
    this.dispose();
  }

  private dispose(): void {
    this.recording = false;
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      try {
        if (this.recorder.state !== "inactive") this.recorder.stop();
      } catch {
        // already stopped
      }
      this.recorder = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.chunks = [];
  }
}
