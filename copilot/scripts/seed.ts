// Seed the Copilot staging school into the configured DB (default: the
// local file DB — the C-12 stand-in). Idempotent: safe to re-run.
//
//   bun scripts/seed.ts
//
// The staging school mirrors the live demo school's configuration (dual
// lane, 4 spots/wave, Left/Right Line) under the same join code the live
// tenant uses — against a LOCAL database only. Production is never read
// or written by this script.

import { getDb, ensureSchema } from "../src/db";

await ensureSchema();
const db = getDb();
const now = Date.now();
await db.execute({
  sql: `INSERT INTO copilot_schools (id, join_code, name, lane_mode, spots_per_wave, created_at)
        VALUES ('sch_staging_auburn', 'RT-KW4W4X', 'Auburn Elementary (Demo)', 'dual', 4, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, lane_mode = excluded.lane_mode,
          spots_per_wave = excluded.spots_per_wave`,
  args: [now],
});
const rows = (
  await db.execute("SELECT id, join_code, name, lane_mode, spots_per_wave FROM copilot_schools")
).rows;
console.log("copilot_schools:", JSON.stringify(rows, null, 2));
