// Board zone-status chip (holder + loader screens): the board-facing face
// of the zone check. VERIFIED = counts match; CHECKING = one mismatching
// still, debounce pending; MISMATCH = flag raised (2 consecutive).
// Plain, high-contrast states — L6 of the scope-cut ladder is the floor
// for this component, not a degradation of it.

import type { ZoneLaneState } from "./api";

const STYLES: Record<ZoneLaneState["status"], { bg: string; fg: string; label: string }> = {
  VERIFIED: { bg: "linear-gradient(135deg, #16a34a, #0b6e35)", fg: "#ffffff", label: "ZONE VERIFIED" },
  CHECKING: { bg: "linear-gradient(135deg, #d97706, #a35c05)", fg: "#ffffff", label: "ZONE CHECKING" },
  MISMATCH: { bg: "linear-gradient(135deg, #d43d31, #9c1f16)", fg: "#ffffff", label: "ZONE MISMATCH" },
};

export function ZoneChip({ laneState }: { laneState: ZoneLaneState }) {
  const s = STYLES[laneState.status];
  return (
    <div
      data-zone-chip={laneState.lane}
      data-status={laneState.status}
      style={{
        background: s.bg,
        color: s.fg,
        borderRadius: 16,
        padding: "14px 16px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        fontWeight: 700,
        letterSpacing: 0.4,
        border: "1px solid rgba(255, 255, 255, 0.16)",
        boxShadow: "0 8px 22px rgba(0, 0, 0, 0.35)",
      }}
    >
      <span>
        {s.label}
        <span style={{ fontWeight: 400, opacity: 0.85 }}>
          {"  ·  "}
          {laneState.lane === "main" ? "Main" : laneState.lane === "left" ? "Left Line" : "Right Line"}
        </span>
      </span>
      <span aria-label="zone count versus wave count">
        zone {laneState.count ?? "—"} · wave {laneState.expected}
      </span>
    </div>
  );
}
