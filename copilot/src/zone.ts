// Zone check pipeline — Build 1 (vision), Tue Oct 27, 2026.
//
// Flow per still (ARCHITECTURE §3.2B, LOCK DEFAULTS Oct 27):
//   cropped still reference → SAM adapter (prompt "car") → masks →
//   COUNT = masks whose label matches the prompt AND whose centroid lies
//   inside the cropped frame (the crop IS the zone — R-08 resolved by the
//   lock default: on-device crop, server counts inside the crop) →
//   compare to the wave's expected count → DEBOUNCE state machine →
//   persist the COUNT ONLY → board-facing status per lane.
//
// Debounce (spec v2, SC-04/SC-05/SC-06): a mismatch flags only after 2
// CONSECUTIVE stills with the SAME mismatching count. One mismatching
// still = CHECKING (no flag, no incident, no agent call). A matching still
// clears straight back to VERIFIED — a match never needs debounce.
//
// Persistence: copilot_zone_checks gets (school, lane, ts, source, count,
// expected, status) and nothing else. The frame is never written anywhere;
// masks are never written anywhere. flag_count increments once per
// MISMATCH EPISODE (on the transition into MISMATCH), which is what SC-06
// asserts stays 0 for a transient.

import { getDb, ensureSchema } from "./db";
import { selectSamAdapter, type SamAdapter } from "./sam";

export type ZoneStatus = "VERIFIED" | "CHECKING" | "MISMATCH";
export const ZONE_PROMPT = "car";
export const DEBOUNCE_STREAK = 2;

export interface ZoneCheckArgs {
  lane: string;
  expected: number;
  stillId?: string;
  imageBase64?: string;
}

export interface ZoneCheckResult {
  ok: true;
  lane: string;
  count: number;
  expected: number;
  status: ZoneStatus;
  flagRaised: boolean; // true only on the still that transitions into MISMATCH
  streak: number;
  masksReturned: number;
  masksCounted: number;
  adapter: string;
  modelId: string;
  latencyMs: number;
}

export interface ZoneLaneState {
  lane: string;
  status: ZoneStatus;
  count: number | null;
  expected: number;
  flagCount: number;
  updatedAt: string | null;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** The counting rule, isolated so the gate can unit-grade it directly. */
export function countInCrop(
  masks: Array<{ label: string; centroid: { x: number; y: number } }>,
  prompt: string,
): number {
  return masks.filter(
    (m) =>
      m.label === prompt &&
      m.centroid.x >= 0 && m.centroid.x <= 1 &&
      m.centroid.y >= 0 && m.centroid.y <= 1,
  ).length;
}

export class ZoneChecker {
  constructor(private adapter: SamAdapter = selectSamAdapter()) {}

  get adapterKind() {
    return this.adapter.kind;
  }
  get modelId() {
    return this.adapter.modelId;
  }

  async check(schoolId: string, args: ZoneCheckArgs): Promise<ZoneCheckResult> {
    await ensureSchema();
    const lane = String(args.lane);
    const expected = num(args.expected);

    const sam = await this.adapter.countVehicles({
      stillId: args.stillId,
      imageBase64: args.imageBase64,
      lane,
      prompt: ZONE_PROMPT,
    });
    // The frame (if any) and the masks end their life here — only the
    // count crosses into persistence.
    const count = countInCrop(sam.masks, ZONE_PROMPT);

    // --- debounce state machine -------------------------------------
    const prevRows = (
      await getDb().execute({
        sql: "SELECT * FROM copilot_zone_state WHERE school_id = ? AND lane = ?",
        args: [schoolId, lane],
      })
    ).rows;
    const prev = prevRows[0];
    const prevStatus = (prev ? String(prev.status) : "VERIFIED") as ZoneStatus;
    const prevStreak = prev ? num(prev.mismatch_streak) : 0;
    const prevCount = prev && prev.last_count != null ? num(prev.last_count) : null;
    const prevFlags = prev ? num(prev.flag_count) : 0;

    let status: ZoneStatus;
    let streak = 0;
    let flagRaised = false;
    if (count === expected) {
      status = "VERIFIED";
    } else {
      streak = prevCount === count && prevStatus !== "VERIFIED" ? prevStreak + 1 : 1;
      // Note: a continuing streak counts consecutive stills with the same
      // mismatching count. If the mismatching count CHANGES, the streak
      // restarts at 1 (a new discrepancy must prove itself twice too).
      if (prevCount === count && prevStatus === "VERIFIED") streak = 1;
      if (streak >= DEBOUNCE_STREAK) {
        status = "MISMATCH";
        flagRaised = prevStatus !== "MISMATCH";
      } else {
        status = "CHECKING";
      }
    }
    const flagCount = prevFlags + (flagRaised ? 1 : 0);
    const now = Date.now();

    await getDb().execute({
      sql: `INSERT INTO copilot_zone_state
              (school_id, lane, expected, last_count, mismatch_streak, status, flag_count, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(school_id, lane) DO UPDATE SET
              expected = excluded.expected,
              last_count = excluded.last_count,
              mismatch_streak = excluded.mismatch_streak,
              status = excluded.status,
              flag_count = excluded.flag_count,
              updated_at = excluded.updated_at`,
      args: [schoolId, lane, expected, count, streak, status, flagCount, now],
    });
    await getDb().execute({
      sql: `INSERT INTO copilot_zone_checks (school_id, lane, ts, source, count, expected, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [schoolId, lane, now, sam.source, count, expected, status],
    });

    return {
      ok: true,
      lane,
      count,
      expected,
      status,
      flagRaised,
      streak,
      masksReturned: sam.masks.length,
      masksCounted: count,
      adapter: this.adapter.kind,
      modelId: sam.modelId,
      latencyMs: sam.latencyMs,
    };
  }

  async boardStatus(schoolId: string): Promise<{ lanes: ZoneLaneState[] }> {
    await ensureSchema();
    const rows = (
      await getDb().execute({
        sql: "SELECT * FROM copilot_zone_state WHERE school_id = ? ORDER BY lane ASC",
        args: [schoolId],
      })
    ).rows;
    return {
      lanes: rows.map((r) => ({
        lane: String(r.lane),
        status: String(r.status) as ZoneStatus,
        count: r.last_count == null ? null : num(r.last_count),
        expected: num(r.expected),
        flagCount: num(r.flag_count),
        updatedAt: new Date(num(r.updated_at)).toISOString(),
      })),
    };
  }

  async reset(schoolId: string, lane?: string): Promise<{ ok: true }> {
    await ensureSchema();
    if (lane) {
      await getDb().execute({
        sql: "DELETE FROM copilot_zone_state WHERE school_id = ? AND lane = ?",
        args: [schoolId, lane],
      });
      await getDb().execute({
        sql: "DELETE FROM copilot_zone_checks WHERE school_id = ? AND lane = ?",
        args: [schoolId, lane],
      });
    } else {
      await getDb().execute({
        sql: "DELETE FROM copilot_zone_state WHERE school_id = ?",
        args: [schoolId],
      });
      await getDb().execute({
        sql: "DELETE FROM copilot_zone_checks WHERE school_id = ?",
        args: [schoolId],
      });
    }
    return { ok: true as const };
  }
}
