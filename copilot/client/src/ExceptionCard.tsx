// Board exception card (Build 2): the exception agent's current line.
//
// ADVISORY ONLY — the card displays one instruction line and its action
// label; the Confirm / Dismiss taps mark the line seen and execute
// NOTHING else. No hold is placed or lifted, no wave is released, no
// entry changes from this card. A human decides; the card just talks.

import type { ExceptionAction, ExceptionRecord } from "./api";

const ACTION_LABELS: Record<ExceptionAction, string> = {
  hold_wave: "HOLD WAVE",
  check_tag: "CHECK TAG",
  keep_out_of_wave: "KEEP OUT OF WAVE",
  sweep: "SWEEP",
  info: "INFO",
};

export function ExceptionCard({
  record,
  onResolve,
}: {
  record: ExceptionRecord;
  onResolve: (resolution: "confirmed" | "dismissed") => void;
}) {
  return (
    <div
      data-exception-card={record.trigger}
      data-source={record.source}
      role="alert"
      style={{
        background: "linear-gradient(135deg, #8c231b, #5f130d)",
        color: "#ffffff",
        borderRadius: 16,
        padding: "16px",
        display: "grid",
        gap: 10,
        border: "1px solid rgba(255, 150, 130, 0.35)",
        boxShadow: "0 12px 28px rgba(0, 0, 0, 0.45)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ letterSpacing: 0.4 }}>COPILOT — {ACTION_LABELS[record.action]}</strong>
        <span style={{ fontSize: 12, opacity: 0.8 }}>
          advisory{record.source === "rule-fallback" ? " · rule fallback" : ""}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 18, lineHeight: 1.4 }}>{record.instruction}</p>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => onResolve("confirmed")}
          style={{ fontSize: 15, padding: "8px 14px", fontWeight: 700 }}
        >
          Confirm
        </button>
        <button
          onClick={() => onResolve("dismissed")}
          style={{ fontSize: 15, padding: "8px 14px" }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
