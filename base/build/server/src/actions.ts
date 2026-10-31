// RiderTap actions — numbers only. No student data exists anywhere in this
// system: an entry is a tag number, a lane, a spot, a wave, a status, times.

import {
defineAction,
z,
type ActionsModule,
type Ctx,
} from "@hatch/space-sdk";
import { asc, desc, eq, inArray } from "drizzle-orm";
import * as schema from "./schema";

const schoolSchema = z.object({
  name: z.string(),
  district: z.string(),
  county: z.string(),
  state: z.string(),
  schoolType: z.string(),
  dismissalStart: z.string(),
  dismissalEnd: z.string(),
  spotsPerWave: z.number(),
  laneMode: z.enum(["single", "dual"]),
  leftLabel: z.string(),
  rightLabel: z.string(),
});

const entrySchema = z.object({
  id: z.number(),
  number: z.string(),
  lane: z.string(),
  waveId: z.number(),
  waveNumber: z.number(),
  spot: z.number(),
  status: z.string(),
  held: z.boolean(),
  enteredAt: z.string(),
  updatedAt: z.string(),
});

const waveSchema = z.object({
  id: z.number(),
  lane: z.string(),
  number: z.number(),
  status: z.string(),
});

const summarySchema = z.object({
  date: z.string(),
  totalLoaded: z.number(),
  totalNoShow: z.number(),
  wavesRun: z.number(),
  holdsPlaced: z.number(),
  stillWaiting: z.number(),
  firstCarAt: z.string().nullable(),
  lastCarAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string(),
});

const stateResponse = z.object({
  school: schoolSchema.nullable(),
  entries: z.array(entrySchema),
  waves: z.array(waveSchema),
  holds: z.array(z.string()),
  lastSummary: summarySchema.nullable(),
  summaries: z.array(summarySchema),
});

// Owner Admin Board (PRODUCTION-ONLY action). The runtime lives in the
// production Netlify function (production/functions/actions.ts), gated by
// the ADMIN_CODE env var; this definition exists so the production
// client's ActionClient<typeof Actions> typing includes adminOverview
// with its exact payload shape. Payload = school profiles + aggregates
// only — no car numbers anywhere.
const adminOverviewResponse = z.object({
  generatedAt: z.string(),
  schools: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      district: z.string(),
      county: z.string(),
      state: z.string(),
      schoolType: z.string(),
      laneMode: z.string(),
      leftLabel: z.string(),
      rightLabel: z.string(),
      spotsPerWave: z.number(),
      joinCode: z.string(),
      createdAt: z.string().nullable(),
      summary: z.object({
        daysRecorded: z.number(),
        totalCarsLoaded: z.number(),
        totalNoShows: z.number(),
        avgDismissalDurationSec: z.number().nullable(),
        lastDismissalDate: z.string().nullable(),
        lastDismissalAt: z.string().nullable(),
      }),
      today: z.object({
        activeEntries: z.number(),
        byStatus: z.object({
          entered: z.number(),
          on_board: z.number(),
          at_spot: z.number(),
          loaded: z.number(),
        }),
        activeHolds: z.number(),
      }),
    }),
  ),
});

type AdminOverviewResponse = z.infer<typeof adminOverviewResponse>;

type StateResponse = z.infer<typeof stateResponse>;
type SummaryRow = typeof schema.daySummaries.$inferSelect;

function toSummary(sum: SummaryRow): z.infer<typeof summarySchema> {
  return {
    date: sum.endedAt.toISOString().slice(0, 10),
    totalLoaded: sum.totalLoaded,
    totalNoShow: sum.totalNoShow,
    wavesRun: sum.wavesRun,
    holdsPlaced: sum.holdsPlaced,
    stillWaiting: sum.stillWaiting,
    firstCarAt: sum.firstCarAt ? sum.firstCarAt.toISOString() : null,
    lastCarAt: sum.lastCarAt ? sum.lastCarAt.toISOString() : null,
    startedAt: sum.startedAt ? sum.startedAt.toISOString() : null,
    endedAt: sum.endedAt.toISOString(),
  };
}

async function ensureSession(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.dismissalSession).limit(1);
  const row = rows[0];
  if (row) return row;
  await db
    .insert(schema.dismissalSession)
    .values({ id: 1, startedAt: null, holdsPlaced: 0 });
  return { id: 1, startedAt: null as Date | null, holdsPlaced: 0 };
}

async function loadState(ctx: Ctx): Promise<StateResponse> {
  const db = ctx.db<typeof schema>();
  const schoolRows = await db.select().from(schema.school).limit(1);
  const s = schoolRows[0];
  const waveRows = await db
    .select()
    .from(schema.waves)
    .orderBy(asc(schema.waves.number));
  const waveNumberById = new Map(waveRows.map((w) => [w.id, w.number]));
  const holdRows = await db.select().from(schema.holds);
  const holdSet = new Set(holdRows.map((h) => h.number));
  const entryRows = await db
    .select()
    .from(schema.carEntries)
    .orderBy(asc(schema.carEntries.id));
  // Full summary history, oldest first (most recent last) — the Proof
  // Report renders it; lastSummary stays the newest row for compat.
  const summaryRows = await db
    .select()
    .from(schema.daySummaries)
    .orderBy(asc(schema.daySummaries.id));
  const summaries = summaryRows.map(toSummary);
  const lastSummary = summaries[summaries.length - 1] ?? null;
  return {
    school: s
      ? {
          name: s.name,
          district: s.district,
          county: s.county,
          state: s.state,
          schoolType: s.schoolType,
          dismissalStart: s.dismissalStart,
          dismissalEnd: s.dismissalEnd,
          spotsPerWave: s.spotsPerWave,
          laneMode: s.laneMode,
          leftLabel: s.leftLabel,
          rightLabel: s.rightLabel,
        }
      : null,
    entries: entryRows.map((e) => ({
      id: e.id,
      number: e.number,
      lane: e.lane,
      waveId: e.waveId,
      waveNumber: waveNumberById.get(e.waveId) ?? 0,
      spot: e.spot,
      status: e.status,
      held: holdSet.has(e.number),
      enteredAt: e.enteredAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    })),
    waves: waveRows.map((w) => ({
      id: w.id,
      lane: w.lane,
      number: w.number,
      status: w.status,
    })),
    holds: holdRows.map((h) => h.number),
    lastSummary,
    summaries,
  };
}

const DEMO_SCHOOL = {
  id: 1,
  name: "Auburn Elementary School",
  district: "Barrow County",
  county: "Barrow County",
  state: "GA",
  schoolType: "elementary",
  dismissalStart: "14:15",
  dismissalEnd: "15:00",
  spotsPerWave: 8,
  laneMode: "dual" as const,
  leftLabel: "Left Line",
  rightLabel: "Right Line",
};

export const Actions = {
  getState: defineAction({
    request: z.object({}),
    response: stateResponse,
    async handler(ctx): Promise<StateResponse> {
      return loadState(ctx);
    },
  }),

  seedDemo: defineAction({
    request: z.object({}),
    response: z.object({ seeded: z.boolean() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.school).limit(1);
      if (existing.length > 0) return { seeded: false };
      await db
        .insert(schema.school)
        .values(DEMO_SCHOOL)
        .onConflictDoNothing();
      ctx.invalidateQueries();
      return { seeded: true };
    },
  }),

  resetDemo: defineAction({
    request: z.object({}),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.carEntries);
      await db.delete(schema.waves);
      await db.delete(schema.holds);
      await db.delete(schema.daySummaries);
      await db.delete(schema.dismissalSession);
      await db.delete(schema.school);
      await db.insert(schema.school).values(DEMO_SCHOOL);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  saveSetup: defineAction({
    request: schoolSchema,
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.school).limit(1);
      if (existing.length > 0) {
        await db
          .update(schema.school)
          .set({ ...args })
          .where(eq(schema.school.id, 1));
      } else {
        await db.insert(schema.school).values({ id: 1, ...args });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  addEntry: defineAction({
    request: z.object({
      number: z.string().min(1).max(10),
      lane: z.string().min(1).max(10),
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string().nullable(),
      holdWarning: z.boolean(),
      entry: entrySchema.nullable(),
      existing: z
        .object({
          lane: z.string(),
          waveNumber: z.number(),
          spot: z.number(),
          status: z.string(),
        })
        .nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const schoolRows = await db.select().from(schema.school).limit(1);
      const s = schoolRows[0];
      if (!s) {
        return {
          ok: false,
          reason: "no_school",
          holdWarning: false,
          entry: null,
          existing: null,
        };
      }
      const num = args.number.trim();
      const lane = s.laneMode === "single" ? "main" : args.lane;
      const holdRows = await db
        .select()
        .from(schema.holds)
        .where(eq(schema.holds.number, num));
      const holdWarning = holdRows.length > 0;

      // Duplicate check: same number still active today.
      const active = await db
        .select()
        .from(schema.carEntries)
        .where(eq(schema.carEntries.number, num));
      const dup = active.find(
        (e) => e.status !== "departed" && e.status !== "no_show",
      );
      if (dup) {
        const w = await db
          .select()
          .from(schema.waves)
          .where(eq(schema.waves.id, dup.waveId));
        return {
          ok: false,
          reason: "duplicate",
          holdWarning,
          entry: null,
          existing: {
            lane: dup.lane,
            waveNumber: w[0]?.number ?? 0,
            spot: dup.spot,
            status: dup.status,
          },
        };
      }

      // Find the lane's current filling wave (highest-numbered open wave).
      const laneWaves = await db
        .select()
        .from(schema.waves)
        .where(eq(schema.waves.lane, lane))
        .orderBy(desc(schema.waves.number));
      let wave = laneWaves.find((w) => w.status === "open");
      let countInWave = 0;
      if (wave) {
        const inWave = await db
          .select()
          .from(schema.carEntries)
          .where(eq(schema.carEntries.waveId, wave.id));
        countInWave = inWave.length;
        if (countInWave >= s.spotsPerWave) wave = undefined;
      }
      if (!wave) {
        const nextNumber = (laneWaves[0]?.number ?? 0) + 1;
        const inserted = await db
          .insert(schema.waves)
          .values({ lane, number: nextNumber, status: "open" })
          .returning({ id: schema.waves.id, number: schema.waves.number });
        const row = inserted[0];
        if (!row) throw new Error("addEntry: wave insert returned no rows");
        wave = {
          id: row.id,
          lane,
          number: row.number,
          status: "open" as const,
          createdAt: new Date(),
          releasedAt: null,
        };
        countInWave = 0;
      }

      const now = new Date();
      const insertedEntry = await db
        .insert(schema.carEntries)
        .values({
          number: num,
          lane,
          waveId: wave.id,
          spot: countInWave + 1,
          status: "entered",
          enteredAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.carEntries.id });
      const entryRow = insertedEntry[0];
      if (!entryRow) throw new Error("addEntry: insert returned no rows");
      // Proof Report: the day's startedAt is the FIRST entry's timestamp —
      // set it once per dismissal session (first addEntry after the
      // previous End Dismissal) and never move it afterwards.
      const session = await ensureSession(ctx);
      if (!session.startedAt) {
        await db
          .update(schema.dismissalSession)
          .set({ startedAt: now })
          .where(eq(schema.dismissalSession.id, 1));
      }
      ctx.invalidateQueries();
      return {
        ok: true,
        reason: null,
        holdWarning,
        entry: {
          id: entryRow.id,
          number: num,
          lane,
          waveId: wave.id,
          waveNumber: wave.number,
          spot: countInWave + 1,
          status: "entered",
          held: holdWarning,
          enteredAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        existing: null,
      };
    },
  }),

  undoLastEntry: defineAction({
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      removedNumber: z.string().nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.carEntries)
        .orderBy(desc(schema.carEntries.id))
        .limit(1);
      const last = rows[0];
      if (!last || last.status !== "entered") {
        return { ok: false, removedNumber: null };
      }
      await db
        .delete(schema.carEntries)
        .where(eq(schema.carEntries.id, last.id));
      // If that was the day's only entry, the session has not really
      // started — clear startedAt so the next entry becomes the first.
      const anyLeft = await db.select().from(schema.carEntries).limit(1);
      if (anyLeft.length === 0) {
        await db
          .update(schema.dismissalSession)
          .set({ startedAt: null })
          .where(eq(schema.dismissalSession.id, 1));
      }
      // If its wave is now empty and it was the newest wave, drop the wave.
      const remaining = await db
        .select()
        .from(schema.carEntries)
        .where(eq(schema.carEntries.waveId, last.waveId));
      if (remaining.length === 0) {
        const w = await db
          .select()
          .from(schema.waves)
          .where(eq(schema.waves.id, last.waveId));
        if (w[0] && w[0].status === "open") {
          await db.delete(schema.waves).where(eq(schema.waves.id, last.waveId));
        }
      }
      ctx.invalidateQueries();
      return { ok: true, removedNumber: last.number };
    },
  }),

  advanceEntry: defineAction({
    request: z.object({ id: z.number().int() }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string().nullable(),
      status: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.carEntries)
        .where(eq(schema.carEntries.id, args.id));
      const e = rows[0];
      if (!e) return { ok: false, reason: "not_found", status: null };
      const holdRows = await db
        .select()
        .from(schema.holds)
        .where(eq(schema.holds.number, e.number));
      if (holdRows.length > 0) {
        return { ok: false, reason: "held", status: e.status };
      }
      const flow: Record<string, string> = {
        entered: "on_board",
        on_board: "at_spot",
        at_spot: "loaded",
      };
      const next = flow[e.status];
      if (!next) return { ok: false, reason: "final", status: e.status };
      await db
        .update(schema.carEntries)
        .set({
          status: next as "on_board" | "at_spot" | "loaded",
          updatedAt: new Date(),
        })
        .where(eq(schema.carEntries.id, e.id));
      ctx.invalidateQueries();
      return { ok: true, reason: null, status: next };
    },
  }),

  markNoShow: defineAction({
    request: z.object({ id: z.number().int() }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.carEntries)
        .set({ status: "no_show", updatedAt: new Date() })
        .where(eq(schema.carEntries.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  releaseWave: defineAction({
    request: z.object({ waveId: z.number().int() }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string().nullable(),
      inCount: z.number(),
      readyCount: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const entries = await db
        .select()
        .from(schema.carEntries)
        .where(eq(schema.carEntries.waveId, args.waveId));
      const inCount = entries.length;
      const ready = entries.filter(
        (e) => e.status === "loaded" || e.status === "no_show",
      );
      if (inCount === 0 || ready.length !== inCount) {
        return {
          ok: false,
          reason: "not_ready",
          inCount,
          readyCount: ready.length,
        };
      }
      const loadedIds = entries
        .filter((e) => e.status === "loaded")
        .map((e) => e.id);
      if (loadedIds.length > 0) {
        await db
          .update(schema.carEntries)
          .set({ status: "departed", updatedAt: new Date() })
          .where(inArray(schema.carEntries.id, loadedIds));
      }
      await db
        .update(schema.waves)
        .set({ status: "released", releasedAt: new Date() })
        .where(eq(schema.waves.id, args.waveId));
      ctx.invalidateQueries();
      return { ok: true, reason: null, inCount, readyCount: ready.length };
    },
  }),

  setHold: defineAction({
    request: z.object({ number: z.string().min(1).max(10) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const num = args.number.trim();
      const existing = await db
        .select()
        .from(schema.holds)
        .where(eq(schema.holds.number, num));
      if (existing.length === 0) {
        await db.insert(schema.holds).values({ number: num });
        // Proof Report aggregate: count holds placed today (the number
        // itself is never stored in the summary — counts only).
        const session = await ensureSession(ctx);
        await db
          .update(schema.dismissalSession)
          .set({ holdsPlaced: session.holdsPlaced + 1 })
          .where(eq(schema.dismissalSession.id, 1));
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  clearHold: defineAction({
    request: z.object({ number: z.string().min(1).max(10) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.holds)
        .where(eq(schema.holds.number, args.number.trim()));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  endDismissal: defineAction({
    request: z.object({}),
    response: z.object({ summary: summarySchema }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const entries = await db.select().from(schema.carEntries);
      const waveRows = await db.select().from(schema.waves);
      const sessionRows = await db.select().from(schema.dismissalSession);
      const session = sessionRows[0];
      const loaded = entries.filter(
        (e) => e.status === "loaded" || e.status === "departed",
      );
      const noShow = entries.filter((e) => e.status === "no_show");
      // Still waiting at end: entered but never loaded, departed, or
      // marked no-show — the count the Proof Report calls no-shows.
      const stillWaiting = entries.filter(
        (e) =>
          e.status !== "loaded" &&
          e.status !== "departed" &&
          e.status !== "no_show",
      );
      const firstCarAt =
        entries.length > 0
          ? new Date(
              Math.min(...entries.map((e) => e.enteredAt.getTime())),
            )
          : null;
      const lastCarAt =
        loaded.length > 0
          ? new Date(Math.max(...loaded.map((e) => e.updatedAt.getTime())))
          : null;
      const summary = {
        totalLoaded: loaded.length,
        totalNoShow: noShow.length,
        wavesRun: waveRows.filter((w) => w.status === "released").length,
        firstCarAt,
        lastCarAt,
        endedAt: new Date(),
        // startedAt was stamped by the day's first addEntry; fall back to
        // the earliest entry time if the session row is somehow absent.
        startedAt: session?.startedAt ?? firstCarAt,
        holdsPlaced: session?.holdsPlaced ?? 0,
        stillWaiting: stillWaiting.length,
      };
      const inserted = await db
        .insert(schema.daySummaries)
        .values(summary)
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("endDismissal: summary insert returned no rows");
      // Purge the day: numbers, lanes, spots, times, holds — all gone.
      // The summary history is retained; the session starts fresh.
      await db.delete(schema.carEntries);
      await db.delete(schema.waves);
      await db.delete(schema.holds);
      await db.delete(schema.dismissalSession);
      ctx.invalidateQueries();
      return { summary: toSummary(row) };
    },
  }),

  // Typing contract ONLY (see adminOverviewResponse above). The artifact
  // runtime must never serve the fleet overview — the production function
  // implements it behind the ADMIN_CODE gate. If this handler is ever
  // invoked here, it refuses loudly instead of improvising an answer.
  adminOverview: defineAction({
    request: z.object({}),
    response: adminOverviewResponse,
    async handler(): Promise<AdminOverviewResponse> {
      throw new Error(
        "adminOverview is production-only: served by the Netlify actions function behind the ADMIN_CODE gate",
      );
    },
  }),
} satisfies ActionsModule;
