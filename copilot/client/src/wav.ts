// WAV encoding for walker voice entry — the pure half of mic capture.
//
// The transcribe contract takes a WAV file, and browsers cannot record
// one natively (MediaRecorder produces webm/opus), so the panel captures
// raw PCM over WebAudio (micRecorder.ts) and wraps it here: mono 16-bit
// PCM at 16 kHz. Dependency-free, and pure functions only — no DOM — so
// the unit suite (scripts/run-unit-tests.ts) can grade the exact bytes.

export const WAV_TARGET_SAMPLE_RATE = 16000;

/**
 * Box-average decimation to a lower rate. The averaging window doubles
 * as a cheap low-pass, which is speech-grade for a tag number. A source
 * already at or below the target rate is returned untouched (never
 * upsampled) — the WAV header carries the true rate either way.
 */
export function downsampleToRate(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate <= toRate) return samples.slice();
  const ratio = fromRate / toRate;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

/**
 * Encode mono Float32 samples (nominally [-1, 1], clamped) as a complete
 * WAV file: 44-byte RIFF header + little-endian 16-bit PCM.
 */
export function encodeWav(
  samples: Float32Array,
  inputSampleRate: number,
  targetSampleRate: number = WAV_TARGET_SAMPLE_RATE,
): Uint8Array {
  const pcm = downsampleToRate(samples, inputSampleRate, targetSampleRate);
  const rate = inputSampleRate <= targetSampleRate ? inputSampleRate : targetSampleRate;
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate (mono 16-bit)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

/** Chunked base64 (a 15 s clip is ~480 KB — no single spread of it). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
