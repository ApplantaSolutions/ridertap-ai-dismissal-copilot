// Board state — Build 2's minimal dismissal-board data layer.
//
// The exception agent reads board state; this module owns it: waves and
// their called queue, tag entries, and human-placed holds. Tag numbers
// and statuses only — the system has no student names or records, so
// none can exist here (that absence is the privacy architecture).
//
// This module is the DATA layer only: mutations return outcomes, and
// `buildExceptionPayload` assembles the exact board-state summary the
// exception contract defines (test-assets/EXCEPTION-SCRIPTS.md). Firing
// the agent is the actions layer's job, so the ordering guarantees live
// in one visible place (e.g. a hold is INSERTED — live — before any
// agent call is built on top of it).

import { getDb, ensureSchema } from "./db";
import type {
  BoardEntry,
  BoardStateSummary,
  BoardWave,
  ExceptionTrigger,
} from "./exceptions";

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export interface BoardEntryRow extends BoardEntry {
  walkUp: boolean;
  attempts: number;
}

function rowToEntry(r: Record<string, unknown>): BoardEntryRow {
  return {
    tag: String(r.tag),
    lane: String(r.lane),
    wave: String(r.wave),
    ...(r.spot != null ? { spot: num(r.spot) } : {}),
    status: String(r.status) as BoardEntry["status"],
    walkUp: num(r.walk_up) === 1,
    attempts: num(r.attempts),
  };
}

/** Payload-shaped entry (drops the bookkeeping fields the contract omits). */
function toPayloadEntry(e: BoardEntryRow): BoardEntry {
  return {
    tag: e.tag,
    lane: e.lane,
    wave: e.wave,
    ...(e.spot != null ? { spot: e.spot } : {}),
    status: e.status,
  };
}

async function schoolMode(schoolId: string): Promise<"dual" | "single"> {
  const rows = (
    await getDb().execute({
      sql: "SELECT lane_mode FROM copilot_schools WHERE id = ?",
      args: [schoolId],
    })
  ).rows;
  return rows.length && String(rows[0].lane_mode) === "single" ? "single" : "dual";
}

async function waveRow(
  schoolId: string,
  waveId: string,
): Promise<BoardWave | null> {
  const rows = (
    await getDb().execute({
      sql: "SELECT * FROM copilot_waves WHERE school_id = ? AND id = ?",
      args: [schoolId, waveId],
    })
  ).rows;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    lane: String(r.lane),
    size: num(r.size),
    status: String(r.status) as BoardWave["status"],
  };
}

async function activeWaveForLane(
  schoolId: string,
  lane: string,
): Promise<BoardWave | null> {
  const rows = (
    await getDb().execute({
      sql: `SELECT * FROM copilot_waves
            WHERE school_id = ? AND lane = ? AND status != 'released'
            ORDER BY created_at DESC LIMIT 1`,
      args: [schoolId, lane],
    })
  ).rows;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    lane: String(r.lane),
    size: num(r.size),
    status: String(r.status) as BoardWave["status"],
  };
}

export async function entriesOfWave(
  schoolId: string,
  waveId: string,
): Promise<BoardEntryRow[]> {
  const rows = (
    await getDb().execute({
      sql: `SELECT * FROM copilot_entries WHERE school_id = ? AND wave = ?
            ORDER BY (spot IS NULL), spot ASC, created_at ASC`,
      args: [schoolId, waveId],
    })
  ).rows;
  return rows.map(rowToEntry);
}

export async function entryByTag(
  schoolId: string,
  tag: string,
): Promise<BoardEntryRow | null> {
  const rows = (
    await getDb().execute({
      sql: "SELECT * FROM copilot_entries WHERE school_id = ? AND tag = ?",
      args: [schoolId, tag],
    })
  ).rows;
  return rows.length ? rowToEntry(rows[0]) : null;
}

export async function allHolds(schoolId: string): Promise<string[]> {
  const rows = (
    await getDb().execute({
      sql: "SELECT tag FROM copilot_holds WHERE school_id = ? ORDER BY placed_at ASC",
      args: [schoolId],
    })
  ).rows;
  return rows.map((r) => String(r.tag));
}

/** True while a human-placed HOLD stands on this tag for the school. */
export async function isTagHeld(schoolId: string, tag: string): Promise<boolean> {
  await ensureSchema();
  const rows = (
    await getDb().execute({
      sql: "SELECT tag FROM copilot_holds WHERE school_id = ? AND tag = ?",
      args: [schoolId, tag],
    })
  ).rows;
  return rows.length > 0;
}

async function queueOfWave(
  schoolId: string,
  waveId: string,
): Promise<Array<{ tag: string; position: number; entered: boolean }>> {
  const rows = (
    await getDb().execute({
      sql: `SELECT * FROM copilot_wave_queue WHERE school_id = ? AND wave = ?
            ORDER BY position ASC`,
      args: [schoolId, waveId],
    })
  ).rows;
  return rows.map((r) => ({
    tag: String(r.tag),
    position: num(r.position),
    entered: num(r.entered) === 1,
  }));
}

// ------------------------------------------------------------ mutations ---

/**
 * Wave-id shape (Fri Oct 30, 100× battery Fix 3): the exception
 * payload hygiene validator (src/exceptions.ts) only accepts letters
 * followed by digits — the product convention L1/R1/L2. Before this
 * check, callWave accepted any string and an id like "WD" was created
 * happily, then silently disabled EVERY advisory for that wave: the
 * payload build threw at advise time (a 422 after the fact, with the
 * guard effects already landed). Refuse the id here, at creation,
 * where the mistake is made and can still be corrected.
 */
export const WAVE_ID_PATTERN = /^[A-Za-z]+\d+$/;

export async function callWave(
  schoolId: string,
  args: { id: string; lane: string; tags: string[] },
): Promise<{ ok: true; wave: BoardWave }> {
  if (!WAVE_ID_PATTERN.test(args.id)) {
    throw new Error(
      `wave_id_invalid: "${args.id}" — wave ids are letters followed by digits (L1, R1, L2)`,
    );
  }
  await ensureSchema();
  const now = Date.now();
  const wave: BoardWave = {
    id: args.id,
    lane: args.lane,
    size: args.tags.length,
    status: "called",
  };
  await getDb().execute({
    sql: `INSERT INTO copilot_waves (school_id, id, lane, size, status, created_at)
          VALUES (?, ?, ?, ?, 'called', ?)
          ON CONFLICT(school_id, id) DO UPDATE SET
            lane = excluded.lane, size = excluded.size, status = excluded.status`,
    args: [schoolId, wave.id, wave.lane, wave.size, now],
  });
  for (const [i, tag] of args.tags.entries()) {
    await getDb().execute({
      sql: `INSERT INTO copilot_wave_queue (school_id, wave, tag, position, entered)
            VALUES (?, ?, ?, ?, 0)
            ON CONFLICT(school_id, wave, tag) DO NOTHING`,
      args: [schoolId, wave.id, tag, i + 1],
    });
  }
  return { ok: true, wave };
}

export type EnterTagOutcome =
  | { kind: "entered"; entry: BoardEntryRow; skippedTag: string | null }
  | { kind: "duplicate"; entry: BoardEntryRow; attemptCount: number }
  | { kind: "held"; tag: string };

/**
 * The walker's entry path. The duplicate guard is the base's rule: a tag
 * that is already active on the board is never entered twice — the
 * attempt is counted, the original entry stands, and the outcome tells
 * the caller to fire the `duplicate` trigger.
 *
 * HOLD IS A HARD BLOCK (Oct 30 safety hardening): a human-placed hold
 * stops ENTRY itself, not just progression. The hold is checked FIRST —
 * before the duplicate branch — and a held attempt performs NO writes
 * of any kind (no entry row, no attempt count): there is no way to
 * enter around a hold.
 *
 * Out-of-order (EX-03): when the tag's position in the wave's called
 * queue is behind an already... precisely: when a queue tag AHEAD of this
 * one (lower position) has not been entered yet, the entry still stands
 * (cars arrive in the order they arrive) and the outcome names the first
 * skipped tag so the caller can fire `out_of_order`.
 */
export async function enterTag(
  schoolId: string,
  args: { tag: string; lane: string; wave: string; spot?: number },
): Promise<EnterTagOutcome> {
  await ensureSchema();
  if (await isTagHeld(schoolId, args.tag)) {
    return { kind: "held", tag: args.tag };
  }
  const existing = await entryByTag(schoolId, args.tag);
  if (existing && existing.status !== "departed") {
    const attemptCount = existing.attempts + 1;
    await getDb().execute({
      sql: "UPDATE copilot_entries SET attempts = ?, updated_at = ? WHERE school_id = ? AND tag = ?",
      args: [attemptCount, Date.now(), schoolId, args.tag],
    });
    return { kind: "duplicate", entry: { ...existing, attempts: attemptCount }, attemptCount };
  }

  const queue = await queueOfWave(schoolId, args.wave);
  const mine = queue.find((q) => q.tag === args.tag);
  const spot = mine ? mine.position : args.spot ?? null;
  let skippedTag: string | null = null;
  if (mine) {
    const skipped = queue.find((q) => !q.entered && q.position < mine.position);
    skippedTag = skipped ? skipped.tag : null;
  }

  const now = Date.now();
  await getDb().execute({
    sql: `INSERT INTO copilot_entries
            (school_id, tag, lane, wave, spot, status, walk_up, attempts, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'entered', 0, 1, ?, ?)
          ON CONFLICT(school_id, tag) DO UPDATE SET
            lane = excluded.lane, wave = excluded.wave, spot = excluded.spot,
            status = 'entered', attempts = copilot_entries.attempts + 1,
            updated_at = excluded.updated_at`,
    args: [schoolId, args.tag, args.lane, args.wave, spot, now, now],
  });
  if (mine) {
    await getDb().execute({
      sql: "UPDATE copilot_wave_queue SET entered = 1 WHERE school_id = ? AND wave = ? AND tag = ?",
      args: [schoolId, args.wave, args.tag],
    });
  }
  const entry = (await entryByTag(schoolId, args.tag))!;
  return { kind: "entered", entry, skippedTag };
}

/**
 * Refused status advance on a held tag. The actions layer surfaces this
 * as HTTP 422 with the plain-language reason in the message.
 */
export class TagOnHoldError extends Error {
  constructor(tag: string, status: string) {
    super(
      `tag_on_hold: tag ${tag} is on HOLD — it cannot move to "${status}" until the office clears the hold`,
    );
    this.name = "TagOnHoldError";
  }
}

/** Statuses that move a child toward/into a car — the advancing set. */
const ADVANCING_STATUSES = new Set(["on_board", "at_spot", "loaded", "departed"]);

export async function setEntryStatus(
  schoolId: string,
  args: { tag: string; status: string },
): Promise<{ ok: true }> {
  await ensureSchema();
  // HOLD hard block (Oct 30 safety hardening): a held tag cannot be
  // advanced — not to a spot, not onto a car, not loaded, not departed.
  // Non-advancing statuses (e.g. back to "entered") stay allowed: they
  // move nobody toward a release.
  if (ADVANCING_STATUSES.has(args.status) && (await isTagHeld(schoolId, args.tag))) {
    throw new TagOnHoldError(args.tag, args.status);
  }
  await getDb().execute({
    sql: "UPDATE copilot_entries SET status = ?, updated_at = ? WHERE school_id = ? AND tag = ?",
    args: [args.status, Date.now(), schoolId, args.tag],
  });
  return { ok: true };
}

export async function setWaveStatus(
  schoolId: string,
  args: { wave: string; status: string },
): Promise<{ ok: true }> {
  await ensureSchema();
  await getDb().execute({
    sql: "UPDATE copilot_waves SET status = ? WHERE school_id = ? AND id = ?",
    args: [args.status, schoolId, args.wave],
  });
  return { ok: true };
}

/**
 * Place a human HOLD. The INSERT happens here, FIRST — the hold is live
 * on the board the moment this resolves, before (and regardless of) any
 * agent call the caller fires afterwards. The agent is informed, never
 * consulted; a slow or dead model cannot delay a hold.
 */
export async function placeHold(
  schoolId: string,
  args: { tag: string },
): Promise<{ ok: true; holdLive: true; placedAt: number }> {
  await ensureSchema();
  const now = Date.now();
  await getDb().execute({
    sql: "INSERT OR IGNORE INTO copilot_holds (school_id, tag, placed_at) VALUES (?, ?, ?)",
    args: [schoolId, args.tag, now],
  });
  const rows = (
    await getDb().execute({
      sql: "SELECT placed_at FROM copilot_holds WHERE school_id = ? AND tag = ?",
      args: [schoolId, args.tag],
    })
  ).rows;
  return { ok: true, holdLive: true, placedAt: rows.length ? num(rows[0].placed_at) : now };
}

/** Remove a human HOLD. Never fires the agent — in either direction. */
export async function removeHold(
  schoolId: string,
  args: { tag: string },
): Promise<{ ok: true }> {
  await ensureSchema();
  await getDb().execute({
    sql: "DELETE FROM copilot_holds WHERE school_id = ? AND tag = ?",
    args: [schoolId, args.tag],
  });
  return { ok: true };
}

export async function markWalkUp(
  schoolId: string,
  args: { tag: string },
): Promise<BoardEntryRow> {
  await ensureSchema();
  const entry = await entryByTag(schoolId, args.tag);
  if (!entry) throw new Error(`walk_up_unknown_tag: ${args.tag}`);
  await getDb().execute({
    sql: "UPDATE copilot_entries SET walk_up = 1, updated_at = ? WHERE school_id = ? AND tag = ?",
    args: [Date.now(), schoolId, args.tag],
  });
  return { ...entry, walkUp: true };
}

/**
 * Still Waiting sweep candidates: in RELEASED (completed) waves, entries
 * still sitting at `entered` (called, never progressed) plus queue tags
 * that were called but never entered at all.
 */
export async function stillWaiting(
  schoolId: string,
): Promise<{ tags: string[]; entries: BoardEntryRow[]; wavesCompleted: boolean }> {
  await ensureSchema();
  const waveRows = (
    await getDb().execute({
      sql: "SELECT id, status FROM copilot_waves WHERE school_id = ?",
      args: [schoolId],
    })
  ).rows;
  const wavesCompleted =
    waveRows.length > 0 && waveRows.every((r) => String(r.status) === "released");
  const releasedIds = new Set(
    waveRows.filter((r) => String(r.status) === "released").map((r) => String(r.id)),
  );
  if (!releasedIds.size) return { tags: [], entries: [], wavesCompleted };

  const entryRows = (
    await getDb().execute({
      sql: "SELECT * FROM copilot_entries WHERE school_id = ? AND status = 'entered'",
      args: [schoolId],
    })
  ).rows.map(rowToEntry).filter((e) => releasedIds.has(e.wave));

  const tags: string[] = entryRows.map((e) => e.tag);
  const entries: BoardEntryRow[] = [...entryRows];
  for (const waveId of releasedIds) {
    const queue = await queueOfWave(schoolId, waveId);
    for (const q of queue) {
      if (!q.entered && !tags.includes(q.tag)) {
        tags.push(q.tag);
        const wave = await waveRow(schoolId, waveId);
        entries.push({
          tag: q.tag,
          lane: wave?.lane ?? "main",
          wave: waveId,
          status: "entered",
          walkUp: false,
          attempts: 0,
        });
      }
    }
  }
  return { tags, entries, wavesCompleted };
}

export async function getBoard(schoolId: string): Promise<{
  waves: BoardWave[];
  entries: BoardEntryRow[];
  holds: string[];
}> {
  await ensureSchema();
  const waveRows = (
    await getDb().execute({
      sql: "SELECT * FROM copilot_waves WHERE school_id = ? ORDER BY created_at ASC",
      args: [schoolId],
    })
  ).rows;
  const entryRows = (
    await getDb().execute({
      sql: "SELECT * FROM copilot_entries WHERE school_id = ? ORDER BY created_at ASC",
      args: [schoolId],
    })
  ).rows;
  return {
    waves: waveRows.map((r) => ({
      id: String(r.id),
      lane: String(r.lane),
      size: num(r.size),
      status: String(r.status) as BoardWave["status"],
    })),
    entries: entryRows.map(rowToEntry),
    holds: await allHolds(schoolId),
  };
}

// ------------------------------------------------------- voice state ---

export interface LaneBoardState {
  lane: string;
  /** The live wave a walker entry lands in (latest non-released), or null. */
  waveId: string | null;
  /**
   * The CLOSED SET (VOICE-CASES contract): every tag in the lane's called
   * queues, in call order, plus any active entry tag not in a queue. A
   * voice transcript may resolve ONLY to a member of this set.
   */
  closedSet: string[];
  /** Entries active on the board in this lane (status != departed). */
  activeEntries: BoardEntryRow[];
}

/**
 * The voice resolver's view of the board. Read fresh at every utterance —
 * the closed set is the board's LIVE state, never the voice channel's
 * history (VC-10: an entry typed on the phone is just as active as one
 * spoken).
 */
export async function laneBoardState(
  schoolId: string,
  lane: string,
): Promise<LaneBoardState> {
  await ensureSchema();
  const waveRows = (
    await getDb().execute({
      sql: `SELECT id FROM copilot_waves WHERE school_id = ? AND lane = ?
            ORDER BY created_at ASC`,
      args: [schoolId, lane],
    })
  ).rows;
  const closedSet: string[] = [];
  for (const w of waveRows) {
    const queue = await queueOfWave(schoolId, String(w.id));
    for (const q of queue) {
      if (!closedSet.includes(q.tag)) closedSet.push(q.tag);
    }
  }
  const entryRows = (
    await getDb().execute({
      sql: "SELECT * FROM copilot_entries WHERE school_id = ? AND lane = ? ORDER BY created_at ASC",
      args: [schoolId, lane],
    })
  ).rows.map(rowToEntry);
  const activeEntries = entryRows.filter((e) => e.status !== "departed");
  for (const e of activeEntries) {
    if (!closedSet.includes(e.tag)) closedSet.push(e.tag);
  }
  const activeWave = await activeWaveForLane(schoolId, lane);
  return { lane, waveId: activeWave?.id ?? null, closedSet, activeEntries };
}

/**
 * Undo (VC-06's graded safety net): remove an entry completely — the
 * entry row goes away and its queue slot flips back to not-entered, so
 * the board is exactly as if the tag was never entered. No residue.
 */
export async function removeEntry(
  schoolId: string,
  args: { tag: string },
): Promise<{ ok: true; removed: BoardEntryRow | null }> {
  await ensureSchema();
  const existing = await entryByTag(schoolId, args.tag);
  if (!existing) return { ok: true, removed: null };
  await getDb().execute({
    sql: "DELETE FROM copilot_entries WHERE school_id = ? AND tag = ?",
    args: [schoolId, args.tag],
  });
  await getDb().execute({
    sql: "UPDATE copilot_wave_queue SET entered = 0 WHERE school_id = ? AND wave = ? AND tag = ?",
    args: [schoolId, existing.wave, args.tag],
  });
  return { ok: true, removed: existing };
}

/** Staging test support, mirroring resetZone: wipe board + exception state. */
export async function resetBoard(schoolId: string): Promise<{ ok: true }> {
  await ensureSchema();
  for (const table of [
    "copilot_waves",
    "copilot_wave_queue",
    "copilot_entries",
    "copilot_holds",
    "copilot_exception_current",
    "copilot_exception_log",
    "copilot_voice_log",
    "copilot_voice_state",
    "copilot_voice_sessions",
  ]) {
    await getDb().execute({
      sql: `DELETE FROM ${table} WHERE school_id = ?`,
      args: [schoolId],
    });
  }
  return { ok: true };
}

// ----------------------------------------------------- payload builder ---

export type PayloadContext =
  | { trigger: "zone_mismatch"; zone: { lane: string; count: number; expected: number; consecutiveMismatches: number } }
  | { trigger: "out_of_order"; waveId: string; arrivedTag: string; skippedTag: string }
  | { trigger: "duplicate"; entry: BoardEntryRow; attemptedLane: string; attemptCount: number }
  | { trigger: "hold_placed"; tag: string }
  | { trigger: "walk_up"; entry: BoardEntryRow }
  | { trigger: "no_show_candidate"; tags: string[]; entries: BoardEntryRow[]; wavesCompleted: boolean };

function fallbackWaveId(lane: string): string {
  return lane === "left" ? "L1" : lane === "right" ? "R1" : "M1";
}

/**
 * Assemble the board-state summary in the EXACT shape the exception
 * contract defines. Only the sections relevant to the trigger are
 * populated — no empty filler. Every value comes from tag-only board
 * state; the service's hygiene guard re-validates the result on sight
 * before any adapter sees it.
 */
export async function buildExceptionPayload(
  schoolId: string,
  ctx: PayloadContext,
): Promise<BoardStateSummary> {
  await ensureSchema();
  const mode = await schoolMode(schoolId);
  const trigger: ExceptionTrigger = ctx.trigger;

  switch (ctx.trigger) {
    case "zone_mismatch": {
      const wave =
        (await activeWaveForLane(schoolId, ctx.zone.lane)) ?? {
          id: fallbackWaveId(ctx.zone.lane),
          lane: ctx.zone.lane,
          size: ctx.zone.expected,
          status: "called" as const,
        };
      const entries = await entriesOfWave(schoolId, wave.id);
      const waveTags = new Set(entries.map((e) => e.tag));
      return {
        trigger,
        school_mode: mode,
        zone: {
          lane: ctx.zone.lane,
          count: ctx.zone.count,
          expected: ctx.zone.expected,
          consecutive_mismatches: ctx.zone.consecutiveMismatches,
        },
        wave,
        // SLIMMED (Oct 30 latency hardening): the mismatch instruction
        // needs the wave's tags only, carried as the contract's minimal
        // entry shape (tag, lane, wave) in queue_next. The full entry
        // list — per-entry spot and status — is board detail the model
        // cannot use: the scenario brief forbids blaming a specific
        // tag, because vision cannot know WHICH car is extra or
        // missing. (The `entries` shape itself is unchanged in the
        // contract; the hygiene rules still require status there, so
        // the tags ride the field whose shape is exactly tag/lane/wave.)
        queue_next: entries.map((e) => ({ tag: e.tag, lane: e.lane, wave: e.wave })),
        // Hold presence FOR THIS WAVE only: a hold on another lane's
        // tag is not this wave's business and no longer leaks in.
        holds: (await allHolds(schoolId)).filter((t) => waveTags.has(t)),
      };
    }
    case "out_of_order": {
      const wave = await waveRow(schoolId, ctx.waveId);
      const entries = await entriesOfWave(schoolId, ctx.waveId);
      const queue = await queueOfWave(schoolId, ctx.waveId);
      return {
        trigger,
        school_mode: mode,
        ...(wave ? { wave } : {}),
        entries: entries.map(toPayloadEntry),
        queue_next: queue
          .filter((q) => !q.entered)
          .map((q) => ({ tag: q.tag, lane: wave?.lane ?? "main", wave: ctx.waveId })),
        detail: { arrived_tag: ctx.arrivedTag, skipped_tag: ctx.skippedTag },
      };
    }
    case "duplicate": {
      return {
        trigger,
        school_mode: mode,
        entries: [toPayloadEntry(ctx.entry)],
        detail: {
          attempted_tag: ctx.entry.tag,
          attempted_lane: ctx.attemptedLane,
          attempt_count: ctx.attemptCount,
        },
      };
    }
    case "hold_placed": {
      const entry = await entryByTag(schoolId, ctx.tag);
      const wave = entry ? await waveRow(schoolId, entry.wave) : null;
      const entries = entry ? await entriesOfWave(schoolId, entry.wave) : [];
      return {
        trigger,
        school_mode: mode,
        entries: entries.map(toPayloadEntry),
        holds: await allHolds(schoolId),
        ...(wave ? { wave } : {}),
      };
    }
    case "walk_up": {
      const zoneRows = (
        await getDb().execute({
          sql: "SELECT * FROM copilot_zone_state WHERE school_id = ? AND lane = ?",
          args: [schoolId, ctx.entry.lane],
        })
      ).rows;
      const z = zoneRows[0];
      const expected = z ? num(z.expected) : 0;
      return {
        trigger,
        school_mode: mode,
        entries: [toPayloadEntry(ctx.entry)],
        zone: {
          lane: ctx.entry.lane,
          count: z && z.last_count != null ? num(z.last_count) : expected,
          expected,
          consecutive_mismatches: z ? num(z.mismatch_streak) : 0,
        },
        detail: { walk_up_tag: ctx.entry.tag },
      };
    }
    case "no_show_candidate": {
      return {
        trigger,
        school_mode: mode,
        entries: ctx.entries.map(toPayloadEntry),
        detail: {
          still_waiting_tags: ctx.tags,
          waves_completed: ctx.wavesCompleted,
        },
      };
    }
  }
}
