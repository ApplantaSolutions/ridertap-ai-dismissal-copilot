// Walker voice panel (Build 3): push-to-talk voice entry.
//
// Flow mirrors the graded contract end to end: press-and-HOLD opens the
// PTT session, releasing sends the utterance — nothing is ever taken
// from ambient audio. The resolver answers with exactly one of MATCHED /
// CONFIRM / ASK-REPEAT / DUPLICATE / HELD; a CONFIRM enters nothing until
// the walker taps YES, and a HELD tag enters nothing at all (it renders
// as a clear on-HOLD alert, never as an entry). The last entered tag is
// read back BIG (the VC-06 safety net) with a one-tap Undo beside it.
//
// The microphone is the primary path: holding the button captures the
// walker's voice (micRecorder.ts → wav.ts) and the release sends the
// clip as a WAV for live transcription. The typed "heard-as" field is
// the fallback for a blocked or absent mic — and it is the same
// transcript boundary the acceptance harness injects at, so it stays.
// Audio is never stored client-side and never logged.

import { useCallback, useEffect, useRef, useState } from "react";
import { call, type VoiceStateView, type VoiceUtteranceResult } from "./api";
import { MicError, PttRecorder } from "./micRecorder";
import { bytesToBase64 } from "./wav";

/** Hard recording cap; the walker sees it counting up while holding. */
const MAX_RECORD_SECONDS = 15;
/** A shorter clip than this is a tap, not an utterance — don't send it. */
const MIN_CLIP_MS = 250;

const MIC_DENIED = {
  en: "The microphone is blocked. You can allow it in the browser's site settings — or type the number above instead; the hold button still sends it.",
  es: "El micrófono está bloqueado. Puedes permitirlo en los ajustes del sitio del navegador — o escribe el número arriba; el botón de mantener también lo envía.",
} as const;
const MIC_UNAVAILABLE = {
  en: "No microphone is available here (this page needs a secure connection and a device mic). Type the number above instead; the hold button still sends it.",
  es: "No hay micrófono disponible aquí (esta página necesita una conexión segura y un micrófono). Escribe el número arriba; el botón de mantener también lo envía.",
} as const;
const SEND_FAILED = {
  en: "That didn't go through. Hold the button and say the number again — or type it above.",
  es: "Eso no se envió. Mantén el botón y di el número otra vez — o escríbelo arriba.",
} as const;
/**
 * The capture produced nothing sendable (zero samples, or a clip too
 * short to be speech) and there was no typed fallback: until Oct 30
 * this path showed the walker NOTHING — a press that silently ate the
 * utterance (proven live on JR's phone). It always speaks now.
 */
const NO_AUDIO = {
  en: "No sound reached the app that time, so nothing was sent. Hold the button, wait for the red Recording line, then say the number — or type it above instead.",
  es: "Ningún sonido llegó a la app esa vez, así que no se envió nada. Mantén el botón, espera la línea roja de grabación y di el número — o escríbelo arriba.",
} as const;
/** A CONFIRM's YES met a hold that landed while the question was open. */
const confirmHeldNote = {
  en: (tag: string) => `Tag ${tag} is on HOLD — it was not entered. The office has to clear the hold first.`,
  es: (tag: string) => `La etiqueta ${tag} está en HOLD — no se registró. La oficina debe levantar el HOLD primero.`,
} as const;

export function VoicePanel() {
  const [lang, setLang] = useState<"en" | "es">("en");
  const [lane, setLane] = useState("left");
  const [heard, setHeard] = useState("");
  const [holding, setHolding] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [micNote, setMicNote] = useState<string | null>(null);
  const [sendFailed, setSendFailed] = useState(false);
  const [noAudio, setNoAudio] = useState(false);
  const [heldNote, setHeldNote] = useState<string | null>(null);
  const [result, setResult] = useState<VoiceUtteranceResult | null>(null);
  const [state, setState] = useState<VoiceStateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const recorderRef = useRef<PttRecorder | null>(null);
  // Bumped on every press AND release: a press whose session/mic finished
  // opening after the walker already let go must not resurrect "holding".
  const pressGenRef = useRef(0);
  const recordStartRef = useRef(0);
  const tickRef = useRef<number | null>(null);
  const pressEndRef = useRef<() => void>(() => {});

  const refresh = useCallback(async () => {
    const s = await call<VoiceStateView>("getVoiceState", { language: lang });
    setState(s);
  }, [lang]);

  useEffect(() => {
    refresh().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [refresh]);

  // Unmount: stop the clock and release the microphone, whatever state
  // the press was in.
  useEffect(
    () => () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
      recorderRef.current?.cancel();
    },
    [],
  );

  async function pressStart() {
    const gen = ++pressGenRef.current;
    setError(null);
    setSendFailed(false);
    setNoAudio(false);
    setHeldNote(null);
    setMicNote(null);
    setElapsed(0);
    // Start the mic inside the press gesture; its outcome is captured,
    // never thrown — a mic failure must not block the typed fallback.
    const rec = new PttRecorder();
    recorderRef.current = rec;
    // Wake the AudioContext synchronously, while this is still the
    // press gesture — a context created after the awaits below can
    // stay suspended on Android Chrome and capture pure silence.
    rec.prepareContext();
    const micOutcome = rec.start().then(
      () => ({ ok: true as const, failure: null }),
      (e: unknown) => ({
        ok: false as const,
        failure: e instanceof MicError ? e.failure : ("unavailable" as const),
      }),
    );
    try {
      const s = await call<{ token: string }>("startPtt", { lane, language: lang });
      if (gen !== pressGenRef.current) {
        // Released while the session was opening: close both quietly.
        rec.cancel();
        call("endPtt", { token: s.token }).catch(() => {});
        return;
      }
      tokenRef.current = s.token;
      setHolding(true);
      const outcome = await micOutcome;
      if (gen !== pressGenRef.current) return; // pressEnd already handled it
      if (outcome.ok) {
        setRecording(true);
        recordStartRef.current = Date.now();
        tickRef.current = window.setInterval(() => {
          const secs = (Date.now() - recordStartRef.current) / 1000;
          setElapsed(secs);
          if (secs >= MAX_RECORD_SECONDS) pressEndRef.current();
        }, 100);
      } else if (outcome.failure !== "cancelled") {
        setMicNote(outcome.failure === "denied" ? MIC_DENIED[lang] : MIC_UNAVAILABLE[lang]);
      }
    } catch (e) {
      rec.cancel();
      if (recorderRef.current === rec) recorderRef.current = null;
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function pressEnd() {
    pressGenRef.current++;
    if (tickRef.current) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    setHolding(false);
    setRecording(false);
    setElapsed(0);
    const token = tokenRef.current;
    tokenRef.current = null;
    // The recorder is consulted directly (not via React state): its
    // start() may have resolved while this release was already coming.
    const rec = recorderRef.current;
    recorderRef.current = null;
    let clipBase64: string | null = null;
    if (rec) {
      if (rec.recording) {
        const clip = await rec.stop();
        if (clip && clip.durationMs >= MIN_CLIP_MS) clipBase64 = bytesToBase64(clip.wav);
      } else {
        rec.cancel();
      }
    }
    if (!token) {
      // Released before the session opened: nothing was sent, and the
      // walker must be told so — never leave a silent press behind.
      setNoAudio(true);
      return;
    }
    let sent = false;
    try {
      try {
        if (clipBase64) {
          sent = true;
          const r = await call<VoiceUtteranceResult>("voiceUtterance", {
            token,
            lane,
            language: lang,
            audioBase64: clipBase64,
          });
          setResult(r);
        } else if (heard.trim()) {
          sent = true;
          const r = await call<VoiceUtteranceResult>("voiceUtterance", {
            token,
            lane,
            language: lang,
            transcript: heard.trim(),
          });
          setResult(r);
          setHeard("");
        }
      } catch {
        // Never put a raw transport error on the walker's screen — the
        // remedy is always the same: say it again, or type it.
        setSendFailed(true);
      }
      await call("endPtt", { token });
      await refresh();
      // Nothing sent and no other note explains why (a mic failure
      // already raised its own note): the capture came back empty or
      // too short to be speech. Say so — silence here once ate real
      // utterances on a real phone with no trace on either side.
      if (!sent && !micNote) setNoAudio(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  pressEndRef.current = () => {
    void pressEnd();
  };

  async function confirm(yes: boolean) {
    try {
      const res = await call<{ outcome: string; tag?: string }>("voiceConfirm", {
        yes,
        language: lang,
      });
      setResult(null);
      // A hold that landed while the CONFIRM was open turns YES into a
      // refusal: say so plainly instead of silently clearing the card.
      setHeldNote(
        res.outcome === "held" && res.tag ? confirmHeldNote[lang](res.tag) : null,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function undo() {
    try {
      await call("voiceUndo");
      setResult(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const pending = state?.pending ?? null;
  const readBack = result?.readBack ?? state?.lastTag ?? null;

  return (
    <section>
      <h2>{lang === "es" ? "Entrada por voz" : "Voice entry"} — Walker</h2>
      {error && (
        <p role="alert" style={{ color: "#f87171" }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
        <label style={{ fontSize: 14 }}>
          Lane{" "}
          <select value={lane} onChange={(e) => setLane(e.target.value)}>
            <option value="left">Left Line</option>
            <option value="right">Right Line</option>
            <option value="main">Main (single lane)</option>
          </select>
        </label>
        <label style={{ fontSize: 14 }}>
          Language{" "}
          <select value={lang} onChange={(e) => setLang(e.target.value as "en" | "es")}>
            <option value="en">EN</option>
            <option value="es">ES</option>
          </select>
        </label>
      </div>

      <label style={{ fontSize: 13, display: "block", marginBottom: 6 }}>
        {lang === "es" ? "Lo que dice el asistente:" : "What the walker says:"}{" "}
        <input
          value={heard}
          onChange={(e) => setHeard(e.target.value)}
          placeholder={lang === "es" ? "p. ej. doscientos catorce" : "e.g. two fourteen"}
          style={{
            fontSize: 16,
            padding: "10px 12px",
            width: 280,
            background: "#0e1626",
            border: "1px solid rgba(255, 255, 255, 0.16)",
            borderRadius: 12,
            color: "#e8eef7",
          }}
        />
      </label>
      <button
        onPointerDown={pressStart}
        onPointerUp={pressEnd}
        onPointerCancel={pressEnd}
        onPointerLeave={() => holding && pressEnd()}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          fontSize: 19,
          padding: "18px 30px",
          fontWeight: 700,
          background: holding
            ? "linear-gradient(135deg, #d43d31, #a51f16)"
            : "linear-gradient(135deg, #24365a, #1a2740)",
          color: "#ffffff",
          border: "1px solid rgba(255, 255, 255, 0.16)",
          borderRadius: 16,
          boxShadow: holding
            ? "0 10px 26px rgba(212, 61, 49, 0.35)"
            : "0 10px 24px rgba(0, 0, 0, 0.4)",
          touchAction: "none",
          userSelect: "none",
        }}
      >
        🎤 {holding ? (lang === "es" ? "Escuchando…" : "Listening…") : lang === "es" ? "Mantener para hablar" : "Hold to talk"}
      </button>

      {holding && recording && (
        <p aria-live="polite" style={{ marginTop: 10, fontSize: 16, color: "#ff6b5e", fontWeight: 600 }}>
          ●{" "}
          {lang === "es"
            ? `Grabando — ${elapsed.toFixed(1)}s de ${MAX_RECORD_SECONDS}s máx`
            : `Recording — ${elapsed.toFixed(1)}s of ${MAX_RECORD_SECONDS}s max`}
        </p>
      )}
      {holding && !recording && !micNote && (
        <p aria-live="polite" style={{ marginTop: 10, fontSize: 15, color: "#8fa3ba" }}>
          {lang === "es" ? "Iniciando el micrófono…" : "Starting the microphone…"}
        </p>
      )}
      {micNote && (
        <p role="alert" style={{ marginTop: 10, fontSize: 15, color: "#f5b942" }}>
          {micNote}
        </p>
      )}
      {noAudio && !micNote && (
        <p role="alert" style={{ marginTop: 10, fontSize: 15, color: "#f5b942" }}>
          {NO_AUDIO[lang]}
        </p>
      )}
      {sendFailed && (
        <p role="alert" style={{ marginTop: 10, fontSize: 16, color: "#f87171" }}>
          {SEND_FAILED[lang]}
        </p>
      )}
      {heldNote && (
        <p
          role="alert"
          data-voice-held="confirm"
          style={{ marginTop: 10, fontSize: 16, fontWeight: 600, color: "#f87171" }}
        >
          {heldNote}
        </p>
      )}

      {readBack && (
        <div
          data-voice-readback={readBack}
          style={{
            marginTop: 16,
            background: "linear-gradient(135deg, #16a34a, #14532d)",
            color: "#fff",
            borderRadius: 16,
            padding: "14px 18px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            border: "1px solid rgba(255, 255, 255, 0.16)",
            boxShadow: "0 12px 28px rgba(0, 0, 0, 0.4)",
          }}
        >
          <span style={{ fontSize: 13, letterSpacing: 0.4 }}>
            {lang === "es" ? "ÚLTIMA ETIQUETA" : "LAST TAG ENTERED"}
          </span>
          <strong style={{ fontSize: 46, lineHeight: 1, letterSpacing: 0.5 }}>{readBack}</strong>
          <button onClick={undo} style={{ fontSize: 15, padding: "8px 14px", marginLeft: "auto" }}>
            {lang === "es" ? "Deshacer" : "Undo"}
          </button>
        </div>
      )}

      {pending && (
        <div
          role="alert"
          data-voice-confirm={pending.suggestedTag}
          style={{
            marginTop: 14,
            background: "linear-gradient(135deg, #b45309, #7c3a06)",
            color: "#fff",
            borderRadius: 16,
            padding: "16px",
            border: "1px solid rgba(255, 190, 90, 0.4)",
            boxShadow: "0 12px 28px rgba(0, 0, 0, 0.4)",
          }}
        >
          <p style={{ margin: "0 0 8px", fontSize: 17 }}>{pending.prompt}</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => confirm(true)} style={{ fontSize: 15, padding: "8px 16px", fontWeight: 700 }}>
              {lang === "es" ? "Sí" : "Yes"}
            </button>
            <button onClick={() => confirm(false)} style={{ fontSize: 15, padding: "8px 16px" }}>
              No
            </button>
          </div>
        </div>
      )}

      {result && !pending && (
        <p
          data-voice-outcome={result.outcome}
          style={{
            marginTop: 12,
            fontSize: 16,
            color:
            result.outcome === "ASK-REPEAT" ||
            result.outcome === "DUPLICATE" ||
            result.outcome === "HELD"
              ? "#f87171"
              : "#4ade80",
          }}
        >
          {result.message}
        </p>
      )}
    </section>
  );
}
