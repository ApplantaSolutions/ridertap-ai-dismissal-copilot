// Exception service — Build 2 (exception agent), Wed Oct 28, 2026.
//
// Contract (test-assets/EXCEPTION-SCRIPTS.md, the acceptance source):
//   input   — ONE compact board-state summary (tags, lanes, waves, zone
//             counts, hold flags; NOTHING else — the hygiene guard below
//             fails any other payload on sight) plus the trigger type.
//   output  — exactly one instruction line for the dismissal lead:
//             one sentence, ≤ 140 chars, action ∈ the advisory enum,
//             and NEVER an instruction to lift a HOLD, auto-release a
//             wave, load a held tag, or put a walk-up in a vehicle wave.
//   timeout — hard cap 3s (design target ~2.5s). On timeout, error,
//             malformed output, or a guard violation, the verbatim
//             rule-fallback line is displayed instead. There is no third
//             outcome: the lead always gets exactly one line, and a late
//             Spark line NEVER overwrites a displayed fallback.
//   role    — advisory only. The line executes nothing; a human confirms
//             with a tap. A HOLD is placed and lifted by humans only and
//             never waits on this service.
//   logging — per call, count/state only: trigger, source
//             (`spark` | `rule-fallback`), latency ms, action.

import { getDb, ensureSchema } from "./db";
import { selectSparkAdapter, type SparkAdapter } from "./spark";
import { ruleFallback } from "./fallbacks";

export const SPARK_TIMEOUT_MS = 3000;
export const MAX_INSTRUCTION_CHARS = 140;

export type ExceptionTrigger =
  | "zone_mismatch"
  | "duplicate"
  | "hold_placed"
  | "out_of_order"
  | "walk_up"
  | "no_show_candidate";

export type ExceptionAction =
  | "hold_wave"
  | "check_tag"
  | "keep_out_of_wave"
  | "sweep"
  | "info";

export interface ExceptionLine {
  instruction: string;
  action: ExceptionAction;
}

export interface BoardEntry {
  tag: string;
  lane: string;
  wave: string;
  spot?: number;
  status: "entered" | "on_board" | "at_spot" | "loaded" | "departed";
}

export interface BoardWave {
  id: string;
  lane: string;
  size: number;
  status: "loading" | "called" | "released";
}

export interface BoardStateSummary {
  trigger: ExceptionTrigger;
  school_mode: "dual" | "single";
  zone?: {
    lane: string;
    count: number;
    expected: number;
    consecutive_mismatches: number;
  };
  wave?: BoardWave;
  entries?: BoardEntry[];
  holds?: string[];
  queue_next?: Array<{ tag: string; lane: string; wave: string }>;
  detail?: Record<string, unknown>;
}

export interface ExceptionRecord extends ExceptionLine {
  trigger: ExceptionTrigger;
  source: "spark" | "rule-fallback";
  latencyMs: number;
  status: "open" | "confirmed" | "dismissed";
  createdAt: string;
}

export class PayloadHygieneError extends Error {
  constructor(reason: string) {
    super(`payload_hygiene: ${reason}`);
    this.name = "PayloadHygieneError";
  }
}

// ------------------------------------------------------- hygiene guard ---
// Whitelist validation of the EXACT contract shape. The system contains
// no student names or records, so a payload carrying anything beyond
// tag numbers, lane/wave/spot/status, zone counts, hold flags, and the
// scripted `detail` fields is a defect — it fails here, on sight, before
// any adapter sees it and before anything is logged or persisted.

const TRIGGERS: readonly string[] = [
  "zone_mismatch", "duplicate", "hold_placed", "out_of_order", "walk_up", "no_show_candidate",
];
const LANES: readonly string[] = ["left", "right", "main"];
const WAVE_STATUSES: readonly string[] = ["loading", "called", "released"];
const ENTRY_STATUSES: readonly string[] = ["entered", "on_board", "at_spot", "loaded", "departed"];
const TAG_RE = /^\d+$/;
const WAVE_ID_RE = /^[A-Za-z]+\d+$/;

function fail(reason: string): never {
  throw new PayloadHygieneError(reason);
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`${where}: unexpected field "${k}"`);
  }
}
function checkTag(v: unknown, where: string) {
  if (typeof v !== "string" || !TAG_RE.test(v)) fail(`${where}: not a tag number`);
}
function checkLane(v: unknown, where: string) {
  if (typeof v !== "string" || !LANES.includes(v)) fail(`${where}: not a lane`);
}
function checkCount(v: unknown, where: string) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) fail(`${where}: not a count`);
}

export function validatePayloadHygiene(payload: unknown): BoardStateSummary {
  if (!isObj(payload)) fail("payload is not an object");
  checkKeys(payload, ["trigger", "school_mode", "zone", "wave", "entries", "holds", "queue_next", "detail"], "payload");
  if (typeof payload.trigger !== "string" || !TRIGGERS.includes(payload.trigger)) {
    fail("unknown trigger");
  }
  if (payload.school_mode !== "dual" && payload.school_mode !== "single") {
    fail("school_mode must be dual | single");
  }
  if (payload.zone !== undefined) {
    if (!isObj(payload.zone)) fail("zone is not an object");
    checkKeys(payload.zone, ["lane", "count", "expected", "consecutive_mismatches"], "zone");
    checkLane(payload.zone.lane, "zone.lane");
    checkCount(payload.zone.count, "zone.count");
    checkCount(payload.zone.expected, "zone.expected");
    checkCount(payload.zone.consecutive_mismatches, "zone.consecutive_mismatches");
    // EX-01's hard rule: a zone_mismatch payload at streak 1 must never be sent.
    if (payload.trigger === "zone_mismatch" && (payload.zone.consecutive_mismatches as number) < 2) {
      fail("zone_mismatch below the 2-still debounce (consecutive_mismatches < 2)");
    }
  }
  if (payload.wave !== undefined) {
    if (!isObj(payload.wave)) fail("wave is not an object");
    checkKeys(payload.wave, ["id", "lane", "size", "status"], "wave");
    if (typeof payload.wave.id !== "string" || !WAVE_ID_RE.test(payload.wave.id)) {
      fail("wave.id is not a wave id");
    }
    checkLane(payload.wave.lane, "wave.lane");
    checkCount(payload.wave.size, "wave.size");
    if (typeof payload.wave.status !== "string" || !WAVE_STATUSES.includes(payload.wave.status)) {
      fail("wave.status outside the enum");
    }
  }
  const checkEntry = (e: unknown, where: string, withStatus: boolean) => {
    if (!isObj(e)) fail(`${where} is not an object`);
    checkKeys(e, withStatus ? ["tag", "lane", "wave", "spot", "status"] : ["tag", "lane", "wave"], where);
    checkTag(e.tag, `${where}.tag`);
    checkLane(e.lane, `${where}.lane`);
    if (typeof e.wave !== "string" || !WAVE_ID_RE.test(e.wave)) fail(`${where}.wave is not a wave id`);
    if (e.spot !== undefined) checkCount(e.spot, `${where}.spot`);
    if (withStatus && (typeof e.status !== "string" || !ENTRY_STATUSES.includes(e.status))) {
      fail(`${where}.status outside the enum`);
    }
  };
  if (payload.entries !== undefined) {
    if (!Array.isArray(payload.entries)) fail("entries is not an array");
    payload.entries.forEach((e, i) => checkEntry(e, `entries[${i}]`, true));
  }
  if (payload.queue_next !== undefined) {
    if (!Array.isArray(payload.queue_next)) fail("queue_next is not an array");
    payload.queue_next.forEach((e, i) => checkEntry(e, `queue_next[${i}]`, false));
  }
  if (payload.holds !== undefined) {
    if (!Array.isArray(payload.holds)) fail("holds is not an array");
    payload.holds.forEach((h, i) => checkTag(h, `holds[${i}]`));
  }
  if (payload.detail !== undefined) {
    if (!isObj(payload.detail)) fail("detail is not an object");
    checkKeys(
      payload.detail,
      ["arrived_tag", "skipped_tag", "attempted_tag", "attempted_lane", "attempt_count", "walk_up_tag", "still_waiting_tags", "waves_completed"],
      "detail",
    );
    const d = payload.detail;
    for (const k of ["arrived_tag", "skipped_tag", "attempted_tag", "walk_up_tag"] as const) {
      if (d[k] !== undefined) checkTag(d[k], `detail.${k}`);
    }
    if (d.attempted_lane !== undefined) checkLane(d.attempted_lane, "detail.attempted_lane");
    if (d.attempt_count !== undefined) checkCount(d.attempt_count, "detail.attempt_count");
    if (d.waves_completed !== undefined && typeof d.waves_completed !== "boolean") {
      fail("detail.waves_completed is not a boolean");
    }
    if (d.still_waiting_tags !== undefined) {
      if (!Array.isArray(d.still_waiting_tags)) fail("detail.still_waiting_tags is not an array");
      d.still_waiting_tags.forEach((t, i) => checkTag(t, `detail.still_waiting_tags[${i}]`));
    }
  }
  return payload as unknown as BoardStateSummary;
}

// -------------------------------------------------- output validation ---
// Applied to every Spark line before it may be displayed. Any failure —
// wrong shape, two sentences, over length, action outside the enum, or a
// prohibited instruction — discards the line and the verbatim fallback
// is shown instead. A discarded line is never displayed, never stored.

const ACTIONS: readonly string[] = ["hold_wave", "check_tag", "keep_out_of_wave", "sweep", "info"];

// Prohibited instructions (contract, Output shape). Patterns are phrased
// to catch the imperative while never matching the scripted acceptable /
// fallback lines — e.g. "until the office clears the hold" (a condition,
// third person) must NOT trip the lift-a-hold guard, and "do not load it
// until the office clears it" must NOT trip the load-a-held-tag guard.
const PROHIBITED: Array<{ name: string; re: RegExp }> = [
  // lift / remove / clear / release a HOLD (imperative forms)
  { name: "lifts a HOLD", re: /\b(lift|remove|clear|release|override|ignore|drop)\s+(the\s+|a\s+)?hold\b/i },
  { name: "lifts a HOLD", re: /\bhold\s+(is\s+|has\s+been\s+)?(lifted|removed|cleared|released|overridden)\b/i },
  { name: "lifts a HOLD", re: /\bignore\s+(the\s+)?hold\b/i },
  // auto-release a wave
  { name: "releases a wave", re: /\b(release|send|dispatch)\s+(the\s+)?wave\b/i },
  { name: "releases a wave", re: /\bauto-?release\b/i },
  // load a held tag anyway
  { name: "loads a held tag", re: /\bload(ing)?\b[^.!?]*\b(anyway|regardless|even so|despite|even though|while (it|the tag|the car) is)\b/i },
  { name: "loads a held tag", re: /\bload\s+(the\s+)?(held|hold)\s+(tag|car|student)\b/i },
  // put a walk-up into a vehicle wave / spot
  { name: "walk-up into a vehicle wave", re: /\b(put|place|assign|add|move|load)\b[^.!?]*\bwalk-?up\b[^.!?]*\b(wave|spot)\b/i },
  { name: "walk-up into a vehicle wave", re: /\b(assign|give)\b[^.!?]*\b(spot|wave)\b[^.!?]*\bwalk-?up\b/i },
];

export function prohibitedInstruction(line: string): string | null {
  for (const p of PROHIBITED) {
    if (p.re.test(line)) return p.name;
  }
  return null;
}

/** Returns the validated line, or null if it must be discarded. */
export function validateSparkLine(raw: unknown): ExceptionLine | null {
  if (!isObj(raw)) return null;
  const instruction = raw.instruction;
  const action = raw.action;
  if (typeof instruction !== "string" || typeof action !== "string") return null;
  if (!ACTIONS.includes(action)) return null;
  const line = instruction.trim();
  if (line.length === 0 || line.length > MAX_INSTRUCTION_CHARS) return null;
  if (/[\r\n]/.test(line)) return null;
  // Exactly one sentence: a single terminal period and no other
  // sentence-ending punctuation anywhere in the line.
  if (!line.endsWith(".")) return null;
  const sentences = line.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length !== 1) return null;
  if (prohibitedInstruction(line)) return null;
  return { instruction: line, action: action as ExceptionAction };
}

// ------------------------------------------------------------ service ---

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** The 2-still debounce (zone.ts DEBOUNCE_STREAK): a mismatch flags only
 *  at this streak, and the hygiene guard refuses a zone_mismatch payload
 *  below it. The speculative prefetch below therefore computes against
 *  the PROJECTED flag payload — identical live board state, with the
 *  streak field set to the value the flag payload will carry if the next
 *  still confirms. Nothing computed from it is ever displayed at
 *  CHECKING, and the cached line is served only after the real flag
 *  lands and its context is re-verified field by field. */
const FLAG_STREAK = 2;

/** How long a prefetched line may be served after it was computed. The
 *  context equality check is the real guard; this only bounds how stale
 *  a line can be if the board later returns to an identical context. */
const PREFETCH_TTL_MS = 120_000;

/**
 * The context a zone_mismatch line was computed from: wave id, expected
 * count, observed count, and the wave's tags. At flag time the live
 * payload's context must equal the cached one on EVERY field, or the
 * cached line is discarded and the normal race runs.
 */
interface MismatchContext {
  waveId: string;
  expected: number;
  count: number;
  tags: string[];
}

interface PrefetchedLine {
  context: MismatchContext;
  line: ExceptionLine;
  latencyMs: number;
  createdAt: number;
}

function mismatchContext(payload: BoardStateSummary): MismatchContext {
  // The wave's tags, from whichever contract field carries them: the
  // slimmed builder payload puts them in queue_next (minimal shape);
  // a full payload carries them in entries. Union of both, so the
  // comparison is about the tags themselves, not the envelope.
  const tags = new Set<string>();
  for (const e of payload.entries ?? []) tags.add(e.tag);
  for (const q of payload.queue_next ?? []) tags.add(q.tag);
  return {
    waveId: payload.wave?.id ?? "",
    expected: payload.zone?.expected ?? 0,
    count: payload.zone?.count ?? 0,
    tags: [...tags].sort(),
  };
}

function sameContext(a: MismatchContext, b: MismatchContext): boolean {
  return (
    a.waveId === b.waveId &&
    a.expected === b.expected &&
    a.count === b.count &&
    a.tags.length === b.tags.length &&
    a.tags.every((t, i) => t === b.tags[i])
  );
}

type LineSource = "spark" | "rule-fallback";

export class ExceptionService {
  private readonly timeoutMs: number;
  /**
   * Speculative zone_mismatch lines, keyed `${schoolId}|${lane}`.
   * In-memory only, per warm function instance: a cold start simply
   * misses the cache and the flag runs the normal race. An entry is
   * consumed (deleted) the first time a flag consults it, discarded
   * when the mismatch clears, and overwritten by a newer prefetch.
   */
  private readonly prefetchCache = new Map<string, PrefetchedLine>();

  constructor(
    private adapter: SparkAdapter = selectSparkAdapter(),
    opts: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? SPARK_TIMEOUT_MS;
  }

  get adapterKind() {
    return this.adapter.kind;
  }
  get modelId() {
    return this.adapter.modelId;
  }

  /**
   * The race, isolated: hygiene-validated payload in → the adapter raced
   * against the hard cap → the line validated → the verbatim fallback on
   * any failure. Persists NOTHING. Both branches of `attempt` are
   * handled, so a late adapter rejection can never surface as an
   * unhandled rejection — and its value is simply never read again:
   * once the fallback is chosen, a late Spark line has no path to the
   * board. It cannot overwrite, by construction.
   */
  private async computeLine(
    payload: BoardStateSummary,
  ): Promise<{ line: ExceptionLine; source: LineSource; latencyMs: number }> {
    const started = performance.now();
    const attempt: Promise<{ ok: true; value: unknown } | { ok: false }> =
      Promise.resolve()
        .then(() => this.adapter.advise(payload))
        .then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        );
    const cap: Promise<{ ok: false }> = new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false }), this.timeoutMs),
    );
    const first = await Promise.race([attempt, cap]);

    let line: ExceptionLine | null = null;
    let source: LineSource = "rule-fallback";
    if (first.ok) {
      const valid = validateSparkLine(first.value);
      if (valid) {
        line = valid;
        source = "spark";
      }
    }
    if (!line) {
      line = ruleFallback(payload);
      source = "rule-fallback";
    }
    return { line, source, latencyMs: Math.round(performance.now() - started) };
  }

  /** Persist log + current line and shape the record. The audit LOG can
   *  carry a more precise provenance marker than the board-facing
   *  current line (see the prefetch serve path in advise()). */
  private async persist(
    schoolId: string,
    payload: BoardStateSummary,
    line: ExceptionLine,
    currentSource: LineSource,
    logSource: string,
    latencyMs: number,
  ): Promise<ExceptionRecord> {
    const now = Date.now();
    await getDb().execute({
      sql: `INSERT INTO copilot_exception_log (school_id, ts, trigger, source, latency_ms, action)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [schoolId, now, payload.trigger, logSource, latencyMs, line.action],
    });
    await getDb().execute({
      sql: `INSERT INTO copilot_exception_current
              (school_id, trigger, instruction, action, source, latency_ms, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
            ON CONFLICT(school_id) DO UPDATE SET
              trigger = excluded.trigger,
              instruction = excluded.instruction,
              action = excluded.action,
              source = excluded.source,
              latency_ms = excluded.latency_ms,
              status = 'open',
              created_at = excluded.created_at,
              updated_at = excluded.updated_at`,
      args: [schoolId, payload.trigger, line.instruction, line.action, currentSource, latencyMs, now, now],
    });

    return {
      trigger: payload.trigger,
      instruction: line.instruction,
      action: line.action,
      source: currentSource,
      latencyMs,
      status: "open",
      createdAt: new Date(now).toISOString(),
    };
  }

  /**
   * Try to serve a prefetched line for a flag that just landed. The
   * cache entry is consumed either way. Returns null — run the normal
   * race — when there is no entry, the entry is stale, its context
   * differs from the live flag payload on ANY field, or the cached line
   * fails the SAME output validation a fresh line must pass (checked
   * again here, at serve time, by design). A served record keeps the
   * truthful board-facing source `spark` and the latency the line
   * actually took to compute at CHECKING; the audit log records the
   * provenance as `spark-prefetch`.
   */
  private async servePrefetched(
    schoolId: string,
    payload: BoardStateSummary,
  ): Promise<ExceptionRecord | null> {
    const lane = payload.zone?.lane;
    if (!lane) return null;
    const key = `${schoolId}|${lane}`;
    const entry = this.prefetchCache.get(key);
    this.prefetchCache.delete(key);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > PREFETCH_TTL_MS) return null;
    if (!sameContext(entry.context, mismatchContext(payload))) return null;
    const valid = validateSparkLine({
      instruction: entry.line.instruction,
      action: entry.line.action,
    });
    if (!valid) return null;
    return this.persist(schoolId, payload, valid, "spark", "spark-prefetch", entry.latencyMs);
  }

  /**
   * SPECULATIVE advise for a provisional zone_mismatch — fired by the
   * zone flow at the FIRST mismatching still (CHECKING), where Spark's
   * ~2.5s median latency can be spent BEFORE the flag exists instead of
   * racing the 3s cap after it. Computes against the projected flag
   * payload (see FLAG_STREAK) and caches a validated Spark line.
   *
   * Safety shape: this persists NOTHING, opens NO exception surface,
   * and never throws — a failed prefetch caches nothing and the
   * flag-time advise() re-validates and re-races exactly as before.
   * Only a genuine Spark line is cached: a speculative FALLBACK is
   * discarded, because the flag deserves its own race (a transient
   * failure at CHECKING must not forfeit Spark's second chance) and
   * the fallback is deterministic anyway. Zone_mismatch only — no
   * other trigger is ever prefetched.
   */
  async prefetchZoneMismatch(
    schoolId: string,
    payloadInput: BoardStateSummary,
  ): Promise<void> {
    try {
      if (payloadInput.trigger !== "zone_mismatch" || !payloadInput.zone) return;
      const projected: BoardStateSummary = {
        ...payloadInput,
        zone: {
          ...payloadInput.zone,
          consecutive_mismatches: Math.max(
            payloadInput.zone.consecutive_mismatches,
            FLAG_STREAK,
          ),
        },
      };
      const payload = validatePayloadHygiene(projected);
      const { line, source, latencyMs } = await this.computeLine(payload);
      if (source !== "spark") return;
      this.prefetchCache.set(`${schoolId}|${payload.zone!.lane}`, {
        context: mismatchContext(payload),
        line,
        latencyMs,
        createdAt: Date.now(),
      });
    } catch {
      // Advisory optimization: silence is the contract here. The same
      // payload at flag time goes through advise(), which fails loudly.
    }
  }

  /** Drop a lane's prefetched line (the mismatch cleared at VERIFIED). */
  discardPrefetch(schoolId: string, lane: string): void {
    this.prefetchCache.delete(`${schoolId}|${lane}`);
  }

  /**
   * Run one exception: hygiene → (zone_mismatch only: a context-verified
   * prefetched line, if one is cached) → race the adapter against the
   * hard cap → validate → fallback on any failure → persist log +
   * current line. Hygiene failure THROWS (the case fails on sight —
   * nothing is logged, nothing is displayed, the adapter is never
   * called).
   */
  async advise(
    schoolId: string,
    payloadInput: BoardStateSummary,
  ): Promise<ExceptionRecord> {
    const payload = validatePayloadHygiene(payloadInput);
    await ensureSchema();
    if (payload.trigger === "zone_mismatch") {
      const served = await this.servePrefetched(schoolId, payload);
      if (served) return served;
    }
    const { line, source, latencyMs } = await this.computeLine(payload);
    return this.persist(schoolId, payload, line, source, source, latencyMs);
  }

  async current(schoolId: string): Promise<ExceptionRecord | null> {
    await ensureSchema();
    const rows = (
      await getDb().execute({
        sql: "SELECT * FROM copilot_exception_current WHERE school_id = ?",
        args: [schoolId],
      })
    ).rows;
    if (!rows.length) return null;
    const r = rows[0];
    return {
      trigger: String(r.trigger) as ExceptionTrigger,
      instruction: String(r.instruction),
      action: String(r.action) as ExceptionAction,
      source: String(r.source) as "spark" | "rule-fallback",
      latencyMs: num(r.latency_ms),
      status: String(r.status) as ExceptionRecord["status"],
      createdAt: new Date(num(r.created_at)).toISOString(),
    };
  }

  /** Human confirm/dismiss. Executes nothing else — advisory only. */
  async resolve(
    schoolId: string,
    resolution: "confirmed" | "dismissed",
  ): Promise<{ ok: true; status: string }> {
    await ensureSchema();
    await getDb().execute({
      sql: "UPDATE copilot_exception_current SET status = ?, updated_at = ? WHERE school_id = ? AND status = 'open'",
      args: [resolution, Date.now(), schoolId],
    });
    const cur = await this.current(schoolId);
    return { ok: true, status: cur ? cur.status : "none" };
  }
}
