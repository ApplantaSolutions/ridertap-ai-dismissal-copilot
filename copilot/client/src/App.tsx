// Copilot client shell — Build 1 (Tue Oct 27, 2026) + Build 2
// exception card + Build 3 voice panel (Wed Oct 28, 2026).
//
// Mirrors the base app's shape: a join-code gate, then one screen with
// the dismissal board's Copilot elements. Three views:
//   - Board: the per-lane zone-status chips + the exception agent's
//     current advisory line, polled every ~3s exactly like the base
//     board polls state.
//   - Zone phone: the fixed camera view that crops + sends stills.
//   - Walker: push-to-talk voice entry (Build 3).

import { useCallback, useEffect, useState } from "react";
import {
  call,
  getSchoolCode,
  setSchoolCode,
  normalizeCode,
  type ExceptionRecord,
  type ZoneLaneState,
} from "./api";
import { ZoneChip } from "./ZoneChip";
import { ZonePhone } from "./ZonePhone";
import { ExceptionCard } from "./ExceptionCard";
import { VoicePanel } from "./VoicePanel";

const POLL_MS = 3000;
const EXPECTED_DEFAULT = 4; // lock default: wave size 4 = the test standard

function Board() {
  const [lanes, setLanes] = useState<ZoneLaneState[]>([]);
  const [exception, setException] = useState<ExceptionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [walkUpTag, setWalkUpTag] = useState("");
  const [walkUpNote, setWalkUpNote] = useState<string | null>(null);

  const poll = useCallback(async () => {
    const st = await call<{ lanes: ZoneLaneState[] }>("getZoneStatus");
    setLanes(st.lanes);
    const ex = await call<{ current: ExceptionRecord | null }>("getException");
    setException(ex.current && ex.current.status === "open" ? ex.current : null);
    setError(null);
  }, []);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        await poll();
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [poll]);

  async function resolveException(resolution: "confirmed" | "dismissed") {
    try {
      await call("resolveException", { resolution });
      await poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function markWalkUp(e: React.FormEvent) {
    e.preventDefault();
    const tag = walkUpTag.trim();
    if (!tag) return;
    try {
      // Human flag only: the office/lead marks the tag a walk-up; the
      // exception agent is then informed (it never flags walk-ups).
      await call("markWalkUp", { tag });
      setWalkUpNote(`Tag ${tag} marked walk-up.`);
      setWalkUpTag("");
      await poll();
    } catch (err) {
      setWalkUpNote(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <h2>Dismissal board — zone status</h2>
      {error && (
        <p role="alert" style={{ color: "#f87171" }}>
          {error}
        </p>
      )}
      {exception && (
        <div style={{ marginBottom: 10 }}>
          <ExceptionCard record={exception} onResolve={resolveException} />
        </div>
      )}
      {lanes.length === 0 && !error && (
        <p style={{ opacity: 0.7 }}>
          No zone checks yet this dismissal. The zone phone starts them.
        </p>
      )}
      <div style={{ display: "grid", gap: 10 }}>
        {lanes.map((l) => (
          <ZoneChip key={l.lane} laneState={l} />
        ))}
      </div>
      <form
        onSubmit={markWalkUp}
        style={{
          marginTop: 18,
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          background: "rgba(20, 29, 46, 0.7)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          borderRadius: 14,
          padding: "12px 14px",
        }}
      >
        <label style={{ fontSize: 14 }}>
          Walk-up tag{" "}
          <input
            value={walkUpTag}
            onChange={(e) => setWalkUpTag(e.target.value)}
            inputMode="numeric"
            placeholder="e.g. 132"
            style={{ fontSize: 16, padding: "6px 8px", width: 110 }}
          />
        </label>
        <button type="submit" style={{ fontSize: 15, padding: "7px 12px" }}>
          Mark walk-up
        </button>
        {walkUpNote && <span style={{ fontSize: 13, opacity: 0.8 }}>{walkUpNote}</span>}
      </form>
    </section>
  );
}

export default function App() {
  const [code, setCode] = useState<string | null>(getSchoolCode());
  const [draft, setDraft] = useState("");
  const [view, setView] = useState<"board" | "zone" | "walker">("board");
  const [zoneLane, setZoneLane] = useState("left");

  if (!code) {
    return (
      <main
        style={{
          fontFamily: "ui-sans-system, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          padding: "30px 26px",
          maxWidth: 520,
          margin: "48px auto 0",
          background: "rgba(20, 29, 46, 0.88)",
          border: "1px solid rgba(255, 255, 255, 0.09)",
          borderRadius: 20,
          boxShadow: "0 18px 50px rgba(0, 0, 0, 0.45)",
        }}
      >
        <img
          src="/assets/applanta-logo.jpg"
          alt="Applanta Solutions"
          style={{ width: 54, height: 54, objectFit: "cover", borderRadius: 14, boxShadow: "0 6px 18px rgba(0, 0, 0, 0.4)" }}
        />
        <h1 style={{ fontSize: 27, margin: "16px 0 6px" }}>RiderTap Copilot</h1>
        <p style={{ margin: "0 0 18px", color: "#9db1c9", fontSize: 14.5, lineHeight: 1.45 }}>
          Enter your school's join code to open the Copilot board.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (normalizeCode(draft).length > 0) {
              setSchoolCode(draft);
              setCode(getSchoolCode());
            }
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Join code"
            autoComplete="off"
            style={{ fontSize: 18, padding: 10, width: "100%", boxSizing: "border-box" }}
          />
          <button
            type="submit"
            style={{
              marginTop: 12,
              fontSize: 16,
              padding: "12px 16px",
              width: "100%",
              fontWeight: 700,
              color: "#ffffff",
              background: "linear-gradient(135deg, #22c55e, #15803d)",
              border: "1px solid rgba(255, 255, 255, 0.18)",
            }}
          >
            Open board
          </button>
        </form>
      </main>
    );
  }

  return (
    <main
      style={{
        fontFamily: "ui-sans-system, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        padding: "18px 16px 44px",
        maxWidth: 760,
        margin: "0 auto",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          paddingBottom: 14,
          borderBottom: "1px solid rgba(255, 255, 255, 0.07)",
          marginBottom: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <img
            src="/assets/applanta-logo.jpg"
            alt="Applanta Solutions"
            style={{ width: 38, height: 38, objectFit: "cover", borderRadius: 10, boxShadow: "0 4px 12px rgba(0, 0, 0, 0.35)" }}
          />
          <div>
            <h1 style={{ fontSize: 19, margin: 0, lineHeight: 1.1 }}>RiderTap Copilot</h1>
            <div style={{ fontSize: 10, letterSpacing: 2.2, fontWeight: 700, color: "#7d92ad", marginTop: 3 }}>
              APPLANTA SOLUTIONS
            </div>
          </div>
        </div>
        <nav style={{ display: "flex", gap: 2 }}>
          <button onClick={() => setView("board")} aria-pressed={view === "board"}>
            Board
          </button>
          <button onClick={() => setView("zone")} aria-pressed={view === "zone"}>
            Zone phone
          </button>
          <button onClick={() => setView("walker")} aria-pressed={view === "walker"}>
            Walker
          </button>
        </nav>
      </header>
      {view === "walker" ? (
        <VoicePanel />
      ) : view === "board" ? (
        <Board />
      ) : (
        <>
          <label style={{ fontSize: 13 }}>
            This phone watches:{" "}
            <select value={zoneLane} onChange={(e) => setZoneLane(e.target.value)}>
              <option value="left">Left Line</option>
              <option value="right">Right Line</option>
              <option value="main">Main (single lane)</option>
            </select>
          </label>
          <ZonePhone lane={zoneLane} expected={EXPECTED_DEFAULT} />
        </>
      )}
    </main>
  );
}
