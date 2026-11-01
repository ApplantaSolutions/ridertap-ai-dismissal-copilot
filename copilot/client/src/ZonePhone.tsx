// Zone phone — the fixed-position phone overlooking the loading zone.
//
// What it does (ARCHITECTURE §3.2A, LOCK DEFAULT Oct 27):
//   - Opens the rear camera (getUserMedia) and shows a live preview with
//     the ZONE RECTANGLE overlaid: the rectangle the staff member frames
//     on the loading zone once, at setup.
//   - While running, every CAPTURE_INTERVAL_MS it draws the current frame
//     to a canvas, CROPS TO THE ZONE RECTANGLE ON THE DEVICE, and sends
//     only the crop (JPEG, base64) to the zoneCheck action. The full frame
//     never leaves the phone — the crop IS the zone (R-08 lock default),
//     and the server counts vehicles inside the crop and discards it.
//   - Shows the last verdict (count vs expected + chip state) so the zone
//     staffer can see the check working.
//
// What it does NOT do: no server-side code reads this device (R-07 — the
// function only ever receives the payload this component sends), and no
// image is stored anywhere by this component beyond the in-flight send.
//
// Live state: the server's SAM adapter is LIVE on staging (sam-3.1), so
// camera frames are counted for real. NO CAMERA HANDY? A bundled SAMPLE
// LOT PHOTO (client/sample-lot.jpg, served at /assets/sample-lot.jpg)
// stands in for the camera: it is drawn into the same frame area, cropped
// to the SAME zone rectangle, and sent through the SAME zoneCheck action
// — one tap is one sample, exactly like one camera tick. The sample is
// labeled as a sample everywhere it appears; it is a real photograph of
// a real lot (3 cars), so against the standard wave of 4 it exercises
// the full mismatch path on purpose.

import { useEffect, useRef, useState } from "react";
import { call, type ZoneCheckResult } from "./api";

export const CAPTURE_INTERVAL_MS = 5000;
export const SAMPLE_STILL_URL = "/assets/sample-lot.jpg";

interface ZoneRect {
  x: number;
  y: number;
  w: number;
  h: number;
} // normalized 0..1, relative to the full frame

export function ZonePhone({
  lane,
  expected,
}: {
  lane: string;
  expected: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sampleImgRef = useRef<HTMLImageElement | null>(null);
  const sampleOnRef = useRef(false);
  const pendingSampleSendRef = useRef(false);
  const [rect, setRect] = useState<ZoneRect>({ x: 0.05, y: 0.3, w: 0.9, h: 0.55 });
  const [running, setRunning] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [sampleOn, setSampleOn] = useState(false);
  const [sampleReady, setSampleReady] = useState(false);
  const [last, setLast] = useState<ZoneCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sends, setSends] = useState(0);

  async function startCamera() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraReady(true);
    } catch (e) {
      setError(`camera unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function stopCamera() {
    stopCapture();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraReady(false);
  }

  /** Draw a frame source, crop to the zone rect, return base64 JPEG. */
  function cropFrameBase64(
    source: CanvasImageSource,
    srcW: number,
    srcH: number,
  ): string | null {
    if (srcW === 0 || srcH === 0) return null;
    const sx = Math.floor(rect.x * srcW);
    const sy = Math.floor(rect.y * srcH);
    const sw = Math.floor(rect.w * srcW);
    const sh = Math.floor(rect.h * srcH);
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  }

  /** The camera frame, cropped to the zone rect. */
  function captureCropBase64(): string | null {
    const video = videoRef.current;
    if (!video) return null;
    return cropFrameBase64(video, video.videoWidth, video.videoHeight);
  }

  /** The sample lot photo, cropped to the SAME zone rect. */
  function sampleCropBase64(): string | null {
    const img = sampleImgRef.current;
    if (!img || !img.complete) return null;
    return cropFrameBase64(img, img.naturalWidth, img.naturalHeight);
  }

  async function sendImage(imageBase64: string) {
    try {
      const result = await call<ZoneCheckResult>("zoneCheck", {
        lane,
        expected,
        imageBase64,
      });
      setLast(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setSends((n) => n + 1);
  }

  async function sendStill() {
    const imageBase64 = captureCropBase64();
    if (imageBase64) await sendImage(imageBase64);
  }

  async function sendSample() {
    const imageBase64 = sampleCropBase64();
    if (imageBase64) await sendImage(imageBase64);
  }

  /** Show the sample lot photo and run one check on it immediately. */
  function useSamplePhoto() {
    sampleOnRef.current = true;
    setSampleOn(true);
    const img = sampleImgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      void sendSample();
    } else {
      // The <img> fires onLoad when it arrives; send then (see onLoad).
      pendingSampleSendRef.current = true;
    }
  }

  function hideSamplePhoto() {
    stopCapture();
    sampleOnRef.current = false;
    setSampleOn(false);
  }

  function startCapture() {
    if (timerRef.current) return;
    const tick = () => void (sampleOnRef.current ? sendSample() : sendStill());
    tick();
    timerRef.current = setInterval(tick, CAPTURE_INTERVAL_MS);
    setRunning(true);
  }

  function stopCapture() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setRunning(false);
  }

  useEffect(() => stopCamera, []); // cleanup on unmount

  // The <video> unmounts while the sample photo is shown; when the
  // camera view returns, re-attach the still-live stream to it.
  useEffect(() => {
    if (!sampleOn && streamRef.current && videoRef.current) {
      videoRef.current.srcObject = streamRef.current;
      void videoRef.current.play().catch(() => {});
    }
  }, [sampleOn]);

  const slider = (key: keyof ZoneRect, label: string) => (
    <label style={{ display: "block", fontSize: 12, marginTop: 6 }}>
      {label}: {rect[key].toFixed(2)}
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={rect[key]}
        onChange={(e) =>
          setRect((r) => ({ ...r, [key]: Number(e.target.value) }))
        }
        style={{ width: "100%" }}
      />
    </label>
  );

  return (
    <section>
      <h2>Zone phone — {lane === "main" ? "Main" : lane === "left" ? "Left Line" : "Right Line"}</h2>
      <div
        style={{
          position: "relative",
          background: "#111",
          borderRadius: 16,
          overflow: "hidden",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          boxShadow: "0 12px 30px rgba(0, 0, 0, 0.45)",
        }}
      >
        {sampleOn ? (
          <img
            ref={sampleImgRef}
            src={SAMPLE_STILL_URL}
            alt="Sample lot photo"
            onLoad={() => {
              setSampleReady(true);
              if (pendingSampleSendRef.current) {
                pendingSampleSendRef.current = false;
                void sendSample();
              }
            }}
            style={{ width: "100%", display: "block" }}
          />
        ) : (
          <video ref={videoRef} playsInline muted style={{ width: "100%", display: "block" }} />
        )}
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.w * 100}%`,
            height: `${rect.h * 100}%`,
            border: "3px solid #ffd34d",
            boxSizing: "border-box",
            pointerEvents: "none",
          }}
        />
      </div>
      {sampleOn && (
        <p style={{ fontSize: 12.5, opacity: 0.8, marginTop: 8 }}>
          <strong>Sample lot photo</strong> — a still standing in for the
          camera. Checks crop it to the yellow rectangle and send only the
          crop, exactly like a live frame.
        </p>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {!cameraReady ? (
          <button onClick={() => void startCamera()}>Open camera</button>
        ) : (
          <button onClick={stopCamera}>Close camera</button>
        )}
        {!sampleOn ? (
          <button onClick={useSamplePhoto}>Use sample lot photo</button>
        ) : (
          <>
            <button onClick={() => void sendSample()} disabled={!sampleReady}>
              Check sample photo again
            </button>
            <button onClick={hideSamplePhoto}>Hide sample photo</button>
          </>
        )}
        {(cameraReady || sampleOn) && !running && <button onClick={startCapture}>Start zone check (every {CAPTURE_INTERVAL_MS / 1000}s)</button>}
        {(cameraReady || sampleOn) && running && <button onClick={stopCapture}>Stop zone check</button>}
      </div>

      <details style={{ marginTop: 10 }}>
        <summary style={{ fontSize: 13 }}>Zone rectangle (set once, at setup)</summary>
        {slider("x", "left")}
        {slider("y", "top")}
        {slider("w", "width")}
        {slider("h", "height")}
      </details>

      <p style={{ fontSize: 13, opacity: 0.8 }}>
        Expected this wave: <strong>{expected}</strong> · stills sent: {sends}
      </p>
      {last && (
        <p style={{ fontSize: 14 }}>
          Last check: zone <strong>{last.count}</strong> vs wave{" "}
          <strong>{last.expected}</strong> → <strong>{last.status}</strong>{" "}
          <span style={{ opacity: 0.7 }}>({last.adapter}, {last.latencyMs} ms)</span>
        </p>
      )}
      {last?.exception && (
        <p style={{ fontSize: 14 }}>
          Copilot: <strong>{last.exception.instruction}</strong>{" "}
          <span style={{ opacity: 0.7 }}>
            — confirm or dismiss it on the Board tab.
          </span>
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: "#f87171", fontSize: 13 }}>
          {error}
        </p>
      )}
      <p style={{ fontSize: 12, opacity: 0.65 }}>
        Only the yellow rectangle's crop leaves this phone. The frame is
        counted and discarded — nothing is stored but the count.
      </p>
    </section>
  );
}
