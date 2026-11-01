// RiderTap PRODUCTION actions function — FINAL PORT (Oct 24 2026).
//
// Built from the FROZEN artifact source (server/src/actions.ts in the
// space, after the Principal's Proof Report landed) per DEPLOY_PLAN.md §4:
//   - Every artifact action is ported 1:1 EXCEPT seedDemo/resetDemo, which
//     are intentionally NOT ported (in production they would let anyone
//     wipe a school; provisioning is gated — scripts/provision-school.md).
//   - Every query is scoped by school_id; the tenant is resolved from the
//     per-school join code on each request.
//   - getState returns the FULL summary history (`summaries`, oldest
//     first) plus `lastSummary` — the Proof Report reads it unchanged.
//   - Day summaries carry the Proof Report fields: startedAt (the day's
//     first entry), endedAt, holdsPlaced (session count of holds placed,
//     stored in day_summaries.total_holds), stillWaiting — aggregates
//     only, never a car number.
//   - addEntry is hardened for real concurrency (the artifact gets this
//     for free from its serialized runtime): the whole check → assign →
//     insert runs inside ONE write transaction (BEGIN IMMEDIATE at the
//     Turso primary — writers serialize for milliseconds), AND the
//     partial unique index car_entries_one_active_per_number makes the
//     database engine itself reject a second active row for the same
//     number in the same school, even in a same-millisecond race. A
//     constraint rejection is mapped back to the client's existing
//     { ok:false, reason:"duplicate", existing } contract.
//
// Shape: ONE Netlify Function ("actions") dispatching on {action, args,
// schoolCode} — the wire format the production client transport sends.
// Exports BOTH a fetch-style default handler (used by the local test
// suite) and a Lambda-style `handler` (what the bundled Netlify zip
// invokes). Environment (Netlify site env vars — NEVER committed):
//   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
//   ADMIN_CODE — the RiderTap OWNER's code for the Admin Board
//     (adminOverview action). Read per-request from process.env; there is
//     NO default and NO hardcoded fallback: while ADMIN_CODE is unset or
//     empty, adminOverview refuses every caller. JR chooses the value and
//     sets it as a Netlify env var; it never appears in source.

import { createClient } from "@libsql/client";

// Remote-only client: every read and write hits the Turso PRIMARY (no
// embedded replicas in functions) → read-after-write is immediate and the
// client's 3 s poll sees a single linearizable state per school.
const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Local file databases (the production-shape test suite) get a busy
// timeout so SQLite waits out writer contention inside the statement
// instead of surfacing SQLITE_BUSY. Remote Turso serializes writers at
// the primary and doesn't need it. Awaited once before the first dispatch.
const ready = (async () => {
  if ((process.env.TURSO_DATABASE_URL ?? "").startsWith("file:")) {
    try {
      await client.execute("PRAGMA busy_timeout = 5000");
    } catch {
      // best effort — the dispatch retry below is the second line
    }
  }
})();

type Row = Record<string, unknown>;
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const iso = (ms: unknown): string | null =>
  ms == null ? null : new Date(Number(ms)).toISOString();

// ------------------------------------------------------------ summaries
// The artifact's summary wire shape, exactly (server summarySchema):
// { date, totalLoaded, totalNoShow, wavesRun, holdsPlaced, stillWaiting,
//   firstCarAt, lastCarAt, startedAt, endedAt }
function toSummary(r: Row) {
  const endedAt = iso(r.ended_at)!;
  return {
    date: endedAt.slice(0, 10),
    totalLoaded: num(r.total_loaded),
    totalNoShow: num(r.total_no_show),
    wavesRun: num(r.waves_run),
    holdsPlaced: num(r.total_holds),
    stillWaiting: num(r.still_waiting),
    firstCarAt: iso(r.first_car_at),
    lastCarAt: iso(r.last_car_at),
    startedAt: iso(r.started_at),
    endedAt,
  };
}

// ------------------------------------------------------------ state read
async function loadState(schoolId: string) {
  const sRes = await client.execute({
    sql: "SELECT * FROM schools WHERE id = ? LIMIT 1",
    args: [schoolId],
  });
  const s = sRes.rows[0] as Row | undefined;
  if (!s) {
    return { school: null, entries: [], waves: [], holds: [], lastSummary: null, summaries: [] };
  }
  const waveRows = (
    await client.execute({
      sql: "SELECT * FROM waves WHERE school_id = ? ORDER BY number ASC",
      args: [schoolId],
    })
  ).rows as Row[];
  const waveNumberById = new Map(waveRows.map((w) => [num(w.id), num(w.number)]));
  const holdRows = (
    await client.execute({
      sql: "SELECT number FROM holds WHERE school_id = ?",
      args: [schoolId],
    })
  ).rows as Row[];
  const holdSet = new Set(holdRows.map((h) => String(h.number)));
  const entryRows = (
    await client.execute({
      sql: "SELECT * FROM car_entries WHERE school_id = ? ORDER BY id ASC",
      args: [schoolId],
    })
  ).rows as Row[];
  // Full summary history, oldest first — the Proof Report renders it;
  // lastSummary stays the newest row for compat.
  const summaryRows = (
    await client.execute({
      sql: "SELECT * FROM day_summaries WHERE school_id = ? ORDER BY id ASC",
      args: [schoolId],
    })
  ).rows as Row[];
  const summaries = summaryRows.map(toSummary);
  return {
    school: {
      name: s.name, district: s.district, county: s.county, state: s.state,
      schoolType: s.school_type, dismissalStart: s.dismissal_start,
      dismissalEnd: s.dismissal_end, spotsPerWave: num(s.spots_per_wave),
      laneMode: s.lane_mode, leftLabel: s.left_label, rightLabel: s.right_label,
    },
    entries: entryRows.map((e) => ({
      id: num(e.id), number: String(e.number), lane: String(e.lane),
      waveId: num(e.wave_id), waveNumber: waveNumberById.get(num(e.wave_id)) ?? 0,
      spot: num(e.spot), status: String(e.status), held: holdSet.has(String(e.number)),
      enteredAt: iso(e.entered_at), updatedAt: iso(e.updated_at),
    })),
    waves: waveRows.map((w) => ({
      id: num(w.id), lane: String(w.lane), number: num(w.number), status: String(w.status),
    })),
    holds: holdRows.map((h) => String(h.number)),
    lastSummary: summaries[summaries.length - 1] ?? null,
    summaries,
  };
}

// ------------------------------------------------------------- handlers
// Each handler is the artifact handler of the same name, ported 1:1, plus
// the tenant filter. (Artifact source: server/src/actions.ts in the hosted project.)

type Handler = (schoolId: string, args: any) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  async getState(schoolId) {
    return loadState(schoolId);
  },

  async saveSetup(schoolId, args) {
    await client.execute({
      sql: `UPDATE schools SET name = ?, district = ?, county = ?, state = ?,
              school_type = ?, dismissal_start = ?, dismissal_end = ?,
              spots_per_wave = ?, lane_mode = ?, left_label = ?, right_label = ?
            WHERE id = ?`,
      args: [
        args.name, args.district, args.county, args.state, args.schoolType,
        args.dismissalStart, args.dismissalEnd, args.spotsPerWave,
        args.laneMode, args.leftLabel, args.rightLabel, schoolId,
      ],
    });
    return { ok: true as const };
  },

  // THE critical handler — see the header comment for the two duplicate
  // defenses (write transaction + partial unique index).
  async addEntry(schoolId, args) {
    const tx = await client.transaction("write");
    try {
      const sRows = await tx.execute({
        sql: "SELECT spots_per_wave, lane_mode FROM schools WHERE id = ?",
        args: [schoolId],
      });
      const s = sRows.rows[0] as Row | undefined;
      if (!s) {
        await tx.rollback();
        return { ok: false, reason: "no_school", holdWarning: false, entry: null, existing: null };
      }
      const number = String(args.number).trim();
      const lane = s.lane_mode === "single" ? "main" : String(args.lane);
      const holdRows = await tx.execute({
        sql: "SELECT number FROM holds WHERE school_id = ? AND number = ?",
        args: [schoolId, number],
      });
      const holdWarning = holdRows.rows.length > 0;

      const dupRows = await tx.execute({
        sql: `SELECT id, lane, wave_id, spot, status FROM car_entries
              WHERE school_id = ? AND number = ? AND status NOT IN ('departed','no_show')`,
        args: [schoolId, number],
      });
      const dup = dupRows.rows[0] as Row | undefined;
      if (dup) {
        const wRows = await tx.execute({
          sql: "SELECT number FROM waves WHERE id = ?",
          args: [num(dup.wave_id)],
        });
        await tx.rollback();
        return {
          ok: false, reason: "duplicate", holdWarning, entry: null,
          existing: {
            lane: String(dup.lane), waveNumber: num(wRows.rows[0]?.number),
            spot: num(dup.spot), status: String(dup.status),
          },
        };
      }

      // Find the lane's current filling wave (newest open wave), scoped
      // (school_id, lane) — lanes never share a wave row, so Left and
      // Right fill fully in parallel.
      let wave: { id: number; number: number } | null = null;
      let countInWave = 0;
      const openRows = await tx.execute({
        sql: `SELECT id, number FROM waves
              WHERE school_id = ? AND lane = ? AND status = 'open'
              ORDER BY number DESC LIMIT 1`,
        args: [schoolId, lane],
      });
      if (openRows.rows.length > 0) {
        wave = { id: num(openRows.rows[0].id), number: num(openRows.rows[0].number) };
        const cRows = await tx.execute({
          sql: "SELECT COUNT(*) AS c FROM car_entries WHERE wave_id = ?",
          args: [wave.id],
        });
        countInWave = num(cRows.rows[0].c);
        if (countInWave >= num(s.spots_per_wave)) wave = null;
      }
      if (!wave) {
        const maxRows = await tx.execute({
          sql: "SELECT MAX(number) AS m FROM waves WHERE school_id = ? AND lane = ?",
          args: [schoolId, lane],
        });
        const nextNumber = num(maxRows.rows[0].m) + 1;
        const ins = await tx.execute({
          sql: `INSERT INTO waves (school_id, lane, number, status, created_at)
                VALUES (?, ?, ?, 'open', ?) RETURNING id, number`,
          args: [schoolId, lane, nextNumber, Date.now()],
        });
        wave = { id: num(ins.rows[0].id), number: num(ins.rows[0].number) };
        countInWave = 0;
      }

      const now = Date.now();
      const insEntry = await tx.execute({
        sql: `INSERT INTO car_entries
                (school_id, number, lane, wave_id, spot, status, entered_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'entered', ?, ?) RETURNING id`,
        args: [schoolId, number, lane, wave.id, countInWave + 1, now, now],
      });
      // Proof Report: the day's startedAt is the FIRST entry's timestamp —
      // stamped once per dismissal session, never moved afterwards.
      await tx.execute({
        sql: `INSERT INTO dismissal_session (school_id, started_at, holds_placed)
              VALUES (?, ?, 0) ON CONFLICT(school_id) DO NOTHING`,
        args: [schoolId, now],
      });
      await tx.execute({
        sql: `UPDATE dismissal_session SET started_at = ?
              WHERE school_id = ? AND started_at IS NULL`,
        args: [now, schoolId],
      });
      await tx.commit();
      return {
        ok: true, reason: null, holdWarning,
        entry: {
          id: num(insEntry.rows[0].id), number, lane,
          waveId: wave.id, waveNumber: wave.number, spot: countInWave + 1,
          status: "entered", held: holdWarning,
          enteredAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
        },
        existing: null,
      };
    } catch (e) {
      try { await tx.rollback(); } catch {}
      if (String(e).includes("UNIQUE constraint failed")) {
        // Lost a true race: report the winner as the duplicate.
        const state = await loadState(schoolId);
        const winner = state.entries.find(
          (en) => en.number === String(args.number).trim() &&
            en.status !== "departed" && en.status !== "no_show",
        );
        return {
          ok: false, reason: "duplicate", holdWarning: false, entry: null,
          existing: winner
            ? { lane: winner.lane, waveNumber: winner.waveNumber, spot: winner.spot, status: winner.status }
            : null,
        };
      }
      throw e;
    }
  },

  async undoLastEntry(schoolId) {
    const rows = (
      await client.execute({
        sql: "SELECT * FROM car_entries WHERE school_id = ? ORDER BY id DESC LIMIT 1",
        args: [schoolId],
      })
    ).rows as Row[];
    const last = rows[0];
    if (!last || last.status !== "entered") return { ok: false, removedNumber: null };
    await client.execute({ sql: "DELETE FROM car_entries WHERE id = ?", args: [num(last.id)] });
    // If that was the day's only entry, the session has not really
    // started — clear startedAt so the next entry becomes the first.
    const anyLeft = (
      await client.execute({
        sql: "SELECT id FROM car_entries WHERE school_id = ? LIMIT 1",
        args: [schoolId],
      })
    ).rows;
    if (anyLeft.length === 0) {
      await client.execute({
        sql: "UPDATE dismissal_session SET started_at = NULL WHERE school_id = ?",
        args: [schoolId],
      });
    }
    const remaining = (
      await client.execute({
        sql: "SELECT id FROM car_entries WHERE wave_id = ?",
        args: [num(last.wave_id)],
      })
    ).rows;
    if (remaining.length === 0) {
      await client.execute({
        sql: "DELETE FROM waves WHERE id = ? AND status = 'open'",
        args: [num(last.wave_id)],
      });
    }
    return { ok: true, removedNumber: String(last.number) };
  },

  async advanceEntry(schoolId, args) {
    const rows = (
      await client.execute({
        sql: "SELECT * FROM car_entries WHERE id = ? AND school_id = ?",
        args: [args.id, schoolId],
      })
    ).rows as Row[];
    const e = rows[0];
    if (!e) return { ok: false, reason: "not_found", status: null };
    const holdRows = (
      await client.execute({
        sql: "SELECT number FROM holds WHERE school_id = ? AND number = ?",
        args: [schoolId, String(e.number)],
      })
    ).rows;
    if (holdRows.length > 0) return { ok: false, reason: "held", status: String(e.status) };
    const flow: Record<string, string> = {
      entered: "on_board", on_board: "at_spot", at_spot: "loaded",
    };
    const next = flow[String(e.status)];
    if (!next) return { ok: false, reason: "final", status: String(e.status) };
    await client.execute({
      sql: "UPDATE car_entries SET status = ?, updated_at = ? WHERE id = ?",
      args: [next, Date.now(), num(e.id)],
    });
    return { ok: true, reason: null, status: next };
  },

  async markNoShow(schoolId, args) {
    await client.execute({
      sql: "UPDATE car_entries SET status = 'no_show', updated_at = ? WHERE id = ? AND school_id = ?",
      args: [Date.now(), args.id, schoolId],
    });
    return { ok: true };
  },

  async releaseWave(schoolId, args) {
    const entries = (
      await client.execute({
        sql: "SELECT * FROM car_entries WHERE wave_id = ? AND school_id = ?",
        args: [args.waveId, schoolId],
      })
    ).rows as Row[];
    const inCount = entries.length;
    const ready = entries.filter((e) => e.status === "loaded" || e.status === "no_show");
    if (inCount === 0 || ready.length !== inCount) {
      return { ok: false, reason: "not_ready", inCount, readyCount: ready.length };
    }
    const loadedIds = entries.filter((e) => e.status === "loaded").map((e) => num(e.id));
    if (loadedIds.length > 0) {
      const ph = loadedIds.map(() => "?").join(",");
      await client.execute({
        sql: `UPDATE car_entries SET status = 'departed', updated_at = ? WHERE id IN (${ph})`,
        args: [Date.now(), ...loadedIds],
      });
    }
    await client.execute({
      sql: "UPDATE waves SET status = 'released', released_at = ? WHERE id = ? AND school_id = ?",
      args: [Date.now(), args.waveId, schoolId],
    });
    return { ok: true, reason: null, inCount, readyCount: ready.length };
  },

  async setHold(schoolId, args) {
    const number = String(args.number).trim();
    const existing = (
      await client.execute({
        sql: "SELECT id FROM holds WHERE school_id = ? AND number = ?",
        args: [schoolId, number],
      })
    ).rows;
    if (existing.length === 0) {
      await client.execute({
        sql: "INSERT INTO holds (school_id, number, created_at) VALUES (?, ?, ?)",
        args: [schoolId, number, Date.now()],
      });
      // Proof Report aggregate: count holds placed today (the number
      // itself is never stored in the summary — counts only).
      await client.execute({
        sql: `INSERT INTO dismissal_session (school_id, started_at, holds_placed)
              VALUES (?, NULL, 0) ON CONFLICT(school_id) DO NOTHING`,
        args: [schoolId],
      });
      await client.execute({
        sql: "UPDATE dismissal_session SET holds_placed = holds_placed + 1 WHERE school_id = ?",
        args: [schoolId],
      });
    }
    return { ok: true as const };
  },

  async clearHold(schoolId, args) {
    await client.execute({
      sql: "DELETE FROM holds WHERE school_id = ? AND number = ?",
      args: [schoolId, String(args.number).trim()],
    });
    return { ok: true as const };
  },

  async endDismissal(schoolId) {
    const entries = (
      await client.execute({
        sql: "SELECT * FROM car_entries WHERE school_id = ?",
        args: [schoolId],
      })
    ).rows as Row[];
    const waveRows = (
      await client.execute({
        sql: "SELECT * FROM waves WHERE school_id = ?",
        args: [schoolId],
      })
    ).rows as Row[];
    const sessionRows = (
      await client.execute({
        sql: "SELECT * FROM dismissal_session WHERE school_id = ?",
        args: [schoolId],
      })
    ).rows as Row[];
    const session = sessionRows[0];
    const loaded = entries.filter((e) => e.status === "loaded" || e.status === "departed");
    const noShow = entries.filter((e) => e.status === "no_show");
    // Still waiting at end: entered but never loaded, departed, or no-show.
    const stillWaiting = entries.filter(
      (e) => e.status !== "loaded" && e.status !== "departed" && e.status !== "no_show",
    );
    const firstCarAt = entries.length > 0
      ? Math.min(...entries.map((e) => num(e.entered_at)))
      : null;
    const lastCarAt = loaded.length > 0
      ? Math.max(...loaded.map((e) => num(e.updated_at)))
      : null;
    const endedAt = Date.now();
    const ins = await client.execute({
      sql: `INSERT INTO day_summaries
              (school_id, total_loaded, total_no_show, waves_run, total_holds,
               still_waiting, started_at, first_car_at, last_car_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      args: [
        schoolId, loaded.length, noShow.length,
        waveRows.filter((w) => w.status === "released").length,
        session ? num(session.holds_placed) : 0,
        stillWaiting.length,
        session?.started_at != null ? num(session.started_at) : firstCarAt,
        firstCarAt, lastCarAt, endedAt,
      ],
    });
    const summary = toSummary(ins.rows[0] as Row);
    // Purge the day for THIS school only: numbers, lanes, spots, times,
    // holds. The summary history is retained; the session starts fresh.
    await client.execute({ sql: "DELETE FROM car_entries WHERE school_id = ?", args: [schoolId] });
    await client.execute({ sql: "DELETE FROM waves WHERE school_id = ?", args: [schoolId] });
    await client.execute({ sql: "DELETE FROM holds WHERE school_id = ?", args: [schoolId] });
    await client.execute({ sql: "DELETE FROM dismissal_session WHERE school_id = ?", args: [schoolId] });
    return { summary };
  },

  // NOTE — the artifact's seedDemo/resetDemo are intentionally NOT in
  // this dispatch table: in production they would let anyone wipe a
  // school. They return "unknown_action" like any other non-action.
};

// ------------------------------------------------------- admin board
// Owner-only fleet overview (JR's Admin Board). Deliberately NOT part of
// the school dispatch table above: it is gated by ADMIN_CODE (see the
// dispatch), never by a school join code, and its payload contains school
// profiles + AGGREGATES ONLY — no car numbers, no entry rows, no hold
// numbers (hold COUNT only).
// The ONE code normalization for the whole system: uppercase, then
// strip everything that isn't A–Z/0–9. RT-KW4W4X, RTKW4W4X, rt-kw4w4x,
// and "RT KW4W4X" are the same code — on the client (which stores this
// form) and here on the server (which normalizes BOTH sides before
// comparing, so codes provisioned with dashes still match).
function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function safeEqualCode(a: string, b: string): boolean {
  // Compare normalized codes in a fixed-work loop so the check doesn't
  // leak prefix matches by timing.
  const aa = normalizeCode(a);
  const bb = normalizeCode(b);
  let diff = aa.length ^ bb.length;
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (aa.charCodeAt(i) || 0) ^ (bb.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function loadAdminOverview() {
  const schoolRows = (
    await client.execute(
      "SELECT * FROM schools ORDER BY created_at ASC, name ASC",
    )
  ).rows as Row[];
  // Per-school Proof Report aggregates from the retained day summaries.
  // Average duration uses ONLY days with both timestamps (legacy rows
  // without started_at are counted in days/cars but excluded from the
  // average — same rule the in-app Proof Report follows).
  const summaryRows = (
    await client.execute({
      sql: `SELECT school_id,
              COUNT(*) AS days_recorded,
              COALESCE(SUM(total_loaded), 0) AS total_loaded,
              COALESCE(SUM(total_no_show), 0) AS total_no_show,
              AVG(CASE WHEN started_at IS NOT NULL AND ended_at IS NOT NULL
                       THEN (ended_at - started_at) / 1000.0 END) AS avg_duration_sec,
              MAX(ended_at) AS last_ended_at
            FROM day_summaries GROUP BY school_id`,
    })
  ).rows as Row[];
  // Today's live board counts: rows still on the board (departed/no_show
  // are finished cars, excluded), grouped by status. Counts only.
  const entryRows = (
    await client.execute({
      sql: `SELECT school_id, status, COUNT(*) AS c FROM car_entries
            WHERE status NOT IN ('departed', 'no_show')
            GROUP BY school_id, status`,
    })
  ).rows as Row[];
  const holdRows = (
    await client.execute(
      "SELECT school_id, COUNT(*) AS c FROM holds GROUP BY school_id",
    )
  ).rows as Row[];

  const summaryBySchool = new Map(summaryRows.map((r) => [String(r.school_id), r]));
  const holdsBySchool = new Map(holdRows.map((r) => [String(r.school_id), num(r.c)]));
  const statusBySchool = new Map<string, Map<string, number>>();
  for (const r of entryRows) {
    const sid = String(r.school_id);
    if (!statusBySchool.has(sid)) statusBySchool.set(sid, new Map());
    statusBySchool.get(sid)!.set(String(r.status), num(r.c));
  }

  return {
    generatedAt: new Date().toISOString(),
    schools: schoolRows.map((s) => {
      const sid = String(s.id);
      const sum = summaryBySchool.get(sid);
      const byStatusMap = statusBySchool.get(sid) ?? new Map<string, number>();
      const byStatus = {
        entered: byStatusMap.get("entered") ?? 0,
        on_board: byStatusMap.get("on_board") ?? 0,
        at_spot: byStatusMap.get("at_spot") ?? 0,
        loaded: byStatusMap.get("loaded") ?? 0,
      };
      const lastDismissalAt = sum ? iso(sum.last_ended_at) : null;
      const avgSec = sum?.avg_duration_sec == null ? null : Number(sum.avg_duration_sec);
      return {
        id: sid,
        name: s.name,
        district: s.district,
        county: s.county,
        state: s.state,
        schoolType: s.school_type,
        laneMode: s.lane_mode,
        leftLabel: s.left_label,
        rightLabel: s.right_label,
        spotsPerWave: num(s.spots_per_wave),
        joinCode: s.join_code,
        createdAt: iso(s.created_at),
        summary: {
          daysRecorded: sum ? num(sum.days_recorded) : 0,
          totalCarsLoaded: sum ? num(sum.total_loaded) : 0,
          totalNoShows: sum ? num(sum.total_no_show) : 0,
          avgDismissalDurationSec:
            avgSec != null && Number.isFinite(avgSec)
              ? Math.round(avgSec * 10) / 10
              : null,
          lastDismissalDate: lastDismissalAt ? lastDismissalAt.slice(0, 10) : null,
          lastDismissalAt,
        },
        today: {
          activeEntries:
            byStatus.entered + byStatus.on_board + byStatus.at_spot + byStatus.loaded,
          byStatus,
          activeHolds: holdsBySchool.get(sid) ?? 0,
        },
      };
    }),
  };
}

// Gate + serve adminOverview. Status design (client relies on it):
//   no code supplied            → 401 admin_code_required
//   ADMIN_CODE unset/empty      → 403 admin_disabled (admin stays locked)
//   code ≠ ADMIN_CODE           → 403 admin_forbidden
//     (a valid SCHOOL join code lands here too — it unlocks nothing)
//   code = ADMIN_CODE           → 200 overview
async function handleAdminOverview(provided: string | undefined): Promise<Response> {
  if (!provided) {
    return Response.json({ error: "admin_code_required" }, { status: 401 });
  }
  const configured = normalizeCode(process.env.ADMIN_CODE ?? "");
  if (!configured) {
    return Response.json({ error: "admin_disabled" }, { status: 403 });
  }
  if (!safeEqualCode(provided, configured)) {
    return Response.json({ error: "admin_forbidden" }, { status: 403 });
  }
  await ready;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return Response.json(await loadAdminOverview());
    } catch (e) {
      lastErr = e;
      const msg = String(e).toLowerCase();
      if (!msg.includes("locked") && !msg.includes("busy")) break;
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(300, 30 * 2 ** attempt)));
    }
  }
  console.error("ridertap adminOverview failed", lastErr);
  return Response.json({ error: "internal" }, { status: 500 });
}

// ------------------------------------------------------------ dispatch
async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  let body: { action?: string; args?: unknown; schoolCode?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  // Owner Admin Board: handled before the school dispatch on purpose —
  // the owner code is NOT a school join code and must never resolve to a
  // tenant (and no school code may ever resolve to admin).
  if (body.action === "adminOverview") {
    return handleAdminOverview(body.schoolCode);
  }
  const handler = body.action ? handlers[body.action] : undefined;
  if (!handler) {
    return Response.json({ error: "unknown_action" }, { status: 400 });
  }
  if (!body.schoolCode) {
    return Response.json({ error: "school_code_required" }, { status: 401 });
  }
  // Tenant resolution is normalization-insensitive on BOTH sides: the
  // incoming code and each stored join_code are reduced by normalizeCode
  // before comparing, so a code provisioned as RT-KW4W4X also opens with
  // RTKW4W4X or rt-kw4w4x. (Pilot scale: the registry is a handful of
  // rows; if it ever grows, store a normalized column + index instead.)
  const wanted = normalizeCode(body.schoolCode);
  const schoolRows = (
    await client.execute("SELECT id, join_code FROM schools")
  ).rows as Row[];
  const school = schoolRows.find(
    (r) => normalizeCode(String(r.join_code)) === wanted,
  );
  if (!school) {
    return Response.json({ error: "unknown_school" }, { status: 403 });
  }
  // SQLite/libSQL serializes writers. Under a genuine two-phone race the
  // losing write transaction can surface a transient busy/locked error
  // instead of queueing behind the winner. Retry — a busy-failed attempt
  // committed nothing — with exponential FULL-jitter backoff (fixed
  // delays let two contenders retry in lockstep and collide repeatedly;
  // jitter desynchronizes them), so the loser reaches the duplicate
  // check and returns the proper client response instead of a 500.
  await ready;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const result = await handler(String(school.id), body.args ?? {});
      return Response.json(result);
    } catch (e) {
      lastErr = e;
      const msg = String(e).toLowerCase();
      if (!msg.includes("locked") && !msg.includes("busy")) break;
      const cap = Math.min(500, 30 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, Math.random() * cap));
    }
  }
  console.error("ridertap action failed", body.action, lastErr);
  return Response.json({ error: "internal" }, { status: 500 });
}

export default handleRequest;

// Netlify Functions (classic Lambda) entry — what the bundled zip runs.
// Netlify hands the function an API-Gateway-shaped event; adapt it onto
// the same core handler the fetch export (and the local tests) use.
export const handler = async (event: {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
}): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => {
  const raw = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body
    : "";
  const method = event.httpMethod ?? "POST";
  const req = new Request("https://ridertap.internal/api/actions", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? raw : undefined,
  });
  const res = await handleRequest(req);
  return {
    statusCode: res.status,
    headers: { "content-type": "application/json" },
    body: await res.text(),
  };
};
