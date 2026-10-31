// Copilot DB — libSQL client, same pattern as the frozen base.
//
// URL resolution (C-12, env-driven):
//   1. COPILOT_DB_URL (+ COPILOT_DB_TOKEN) — the explicit per-process
//      override; the gate harnesses force a throwaway local file here.
//   2. TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) — the persistent staging
//      database, set on the staging site once JR creates it.
//   3. A LOCAL FILE database (`file:…`) — the stand-in when neither is
//      set (dev machines and the deployed function's /tmp).
// The schema dialect is identical either way; nothing in the build
// waits on a cloud DB.
//
// Two hard-won properties (first staging draft, Oct 27):
//   1. LAZY client. The client is created on first use, inside the
//      handler's error handling — never at module scope. An eager
//      createClient crashed the deployed function at require time when
//      its file path didn't exist on the host, taking even `health`
//      down with it.
//   2. RUNTIME default path. Deployed (Lambda sets LAMBDA_TASK_ROOT),
//      the only writable location is /tmp, so the default local file
//      lives there; on a dev machine it lives next to this repo. The
//      path is computed from env at runtime — a bundler must never bake
//      a build machine's absolute path into the artifact.

import { createClient, type Client } from "@libsql/client";
import { SCHEMA_SQL } from "./schema";

export const dbUrl =
  process.env.COPILOT_DB_URL ??
  process.env.TURSO_DATABASE_URL ??
  (process.env.LAMBDA_TASK_ROOT
    ? "file:/tmp/copilot.sqlite"
    : `file:${new URL("../copilot-local.sqlite", import.meta.url).pathname}`);

/** The token paired with whichever URL won the resolution above. */
export const dbAuthToken = process.env.COPILOT_DB_URL
  ? process.env.COPILOT_DB_TOKEN
  : (process.env.TURSO_AUTH_TOKEN ?? process.env.COPILOT_DB_TOKEN);

export const dbKind = dbUrl.startsWith("file:") ? "local-file" : "libsql-remote";

let cached: Client | null = null;
export function getDb(): Client {
  if (!cached) {
    cached = createClient({ url: dbUrl, authToken: dbAuthToken });
  }
  return cached;
}

let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = getDb();
      // Statements split on ; at line ends — SCHEMA_SQL is authored to
      // keep that safe: no semicolons inside string literals or comments.
      const statements = SCHEMA_SQL
        .split(/;\s*(?:\r?\n|$)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of statements) {
        await db.execute(stmt);
      }
      // Migration (Fri Oct 30, 100× battery Fix 1): copilot_voice_state
      // gains pending_kind ('suggest' | 'readback') — which tag a
      // CONFIRM YES enters. CREATE TABLE IF NOT EXISTS cannot add a
      // column to a table that already exists, so add it here, guarded
      // by the table's actual column list. Idempotent on every boot;
      // rows written before the migration read NULL → 'suggest', the
      // only kind that existed then.
      const voiceStateCols = (
        await db.execute("SELECT name FROM pragma_table_info('copilot_voice_state')")
      ).rows.map((r) => String(r.name));
      if (!voiceStateCols.includes("pending_kind")) {
        await db.execute("ALTER TABLE copilot_voice_state ADD COLUMN pending_kind TEXT");
      }
      if (dbUrl.startsWith("file:")) {
        try {
          await db.execute("PRAGMA busy_timeout = 5000");
        } catch {
          // best effort, mirrors the base
        }
      }
      await ensureDemoSchool(db);
    })();
  }
  return schemaReady;
}

// --- Demo-school bootstrap (DEMO SEEDING — staging only) ------------------
// This codebase deploys ONLY to the Copilot staging site (production
// RiderTap is a separate, frozen repo), and its database starts empty on
// every cold start (ephemeral /tmp file — the C-12 stand-in). Without a
// seeded tenant the join gate dead-ends at 403 unknown_school, so the
// demo school self-bootstraps here, inside ensureSchema: the first call
// on any cold start creates it if absent, and every later call no-ops.
//
// The demo school mirrors the production demo school's shape and uses the
// SAME join code (RT-KW4W4X) deliberately — one code for JR to remember.
// Idempotent by construction: school insert is guarded + INSERT OR IGNORE
// (safe under concurrent cold starts); zone-state rows use
// ON CONFLICT DO NOTHING so a live board state is never reset by a
// re-run.
export const DEMO_SCHOOL_ID = "sch_staging_auburn";
export const DEMO_JOIN_CODE = "RT-KW4W4X";
const DEMO_LANES = ["left", "right"] as const;

export async function ensureDemoSchool(db: Client): Promise<void> {
  const wanted = normalizeCode(DEMO_JOIN_CODE);
  const rows = (
    await db.execute("SELECT id, join_code FROM copilot_schools")
  ).rows;
  const existing = rows.find((r) => normalizeCode(String(r.join_code)) === wanted);
  let schoolId: string;
  if (existing) {
    schoolId = String(existing.id);
  } else {
    await db.execute({
      sql: `INSERT OR IGNORE INTO copilot_schools
              (id, join_code, name, lane_mode, spots_per_wave, created_at)
            VALUES (?, ?, 'Auburn Elementary (Demo)', 'dual', 4, ?)`,
      args: [DEMO_SCHOOL_ID, DEMO_JOIN_CODE, Date.now()],
    });
    schoolId = DEMO_SCHOOL_ID;
  }
  // Minimum zone state so the board renders both lanes at a sane initial
  // status (VERIFIED, wave = spots_per_wave) instead of an empty list.
  // A zoneCheck overwrites these rows through its own upsert; resetZone
  // can still delete them — the bootstrap only fills ABSENT rows.
  for (const lane of DEMO_LANES) {
    await db.execute({
      sql: `INSERT INTO copilot_zone_state
              (school_id, lane, expected, last_count, mismatch_streak, status, flag_count, updated_at)
            VALUES (?, ?, 4, NULL, 0, 'VERIFIED', 0, ?)
            ON CONFLICT(school_id, lane) DO NOTHING`,
      args: [schoolId, lane, Date.now()],
    });
  }
}

// Tenant resolution — identical discipline to the base: normalize BOTH
// sides (uppercase, strip non-alphanumerics) before comparing, so
// RT-KW4W4X / RTKW4W4X / rt-kw4w4x are the same code.
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function resolveSchool(
  joinCode: string,
): Promise<{ id: string; laneMode: string; spotsPerWave: number } | null> {
  await ensureSchema();
  const wanted = normalizeCode(joinCode);
  const rows = (
    await getDb().execute("SELECT id, join_code, lane_mode, spots_per_wave FROM copilot_schools")
  ).rows;
  const school = rows.find((r) => normalizeCode(String(r.join_code)) === wanted);
  if (!school) return null;
  return {
    id: String(school.id),
    laneMode: String(school.lane_mode),
    spotsPerWave: Number(school.spots_per_wave),
  };
}
