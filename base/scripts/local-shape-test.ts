// Local production-shape test — NO artifact code is touched.
// Simulates two independent Netlify Function invocations (two separate DB
// connections to ONE shared libSQL/SQLite database file, WAL mode) running
// the exact production addEntry algorithm:
//   BEGIN IMMEDIATE -> duplicate check -> find/create lane wave ->
//   spot = count in wave + 1 -> INSERT -> COMMIT
// with the production schema (schema/0001_production_schema.sql), including
// the partial unique index that makes duplicate rejection a DATABASE
// guarantee rather than an application hope.
//
// Run: bun scripts/local-shape-test.ts

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { unlinkSync, existsSync } from "node:fs";

const DB = "/tmp/ridertap-shape-test.db";
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(DB + suffix)) unlinkSync(DB + suffix);
}

const schemaSql = readFileSync(
  new URL("../schema/0001_production_schema.sql", import.meta.url),
  "utf8",
);

function openConn(): Database {
  const db = new Database(DB);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

const setup = openConn();
setup.exec(schemaSql);
setup
  .query(
    `INSERT INTO schools (id, join_code, name, spots_per_wave, lane_mode, created_at)
     VALUES ('sch_test', 'TESTCODE', 'Shape Test Elementary', 4, 'dual', ?)`,
  )
  .run(Date.now());
setup.close();

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

// The production addEntry algorithm, verbatim in shape.
function addEntry(
  db: Database,
  schoolId: string,
  number: string,
  lane: string,
): { ok: boolean; reason?: string; waveNumber?: number; spot?: number } {
  db.exec("BEGIN IMMEDIATE");
  try {
    const school = db
      .query("SELECT spots_per_wave, lane_mode FROM schools WHERE id = ?")
      .get(schoolId) as { spots_per_wave: number; lane_mode: string };
    const effLane = school.lane_mode === "single" ? "main" : lane;

    const dup = db
      .query(
        `SELECT id, lane, wave_id, spot, status FROM car_entries
         WHERE school_id = ? AND number = ? AND status NOT IN ('departed','no_show')`,
      )
      .get(schoolId, number);
    if (dup) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "duplicate" };
    }

    let wave = db
      .query(
        `SELECT id, number FROM waves WHERE school_id = ? AND lane = ? AND status = 'open'
         ORDER BY number DESC LIMIT 1`,
      )
      .get(schoolId, effLane) as { id: number; number: number } | null;
    let count = 0;
    if (wave) {
      count = (
        db.query("SELECT COUNT(*) AS c FROM car_entries WHERE wave_id = ?").get(wave.id) as { c: number }
      ).c;
      if (count >= school.spots_per_wave) wave = null;
    }
    if (!wave) {
      const maxRow = db
        .query("SELECT MAX(number) AS m FROM waves WHERE school_id = ? AND lane = ?")
        .get(schoolId, effLane) as { m: number | null };
      const nextNumber = (maxRow.m ?? 0) + 1;
      const info = db
        .query(
          `INSERT INTO waves (school_id, lane, number, status, created_at)
           VALUES (?, ?, ?, 'open', ?) RETURNING id, number`,
        )
        .get(schoolId, effLane, nextNumber, Date.now()) as { id: number; number: number };
      wave = info;
      count = 0;
    }
    const now = Date.now();
    const entry = db
      .query(
        `INSERT INTO car_entries (school_id, number, lane, wave_id, spot, status, entered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'entered', ?, ?) RETURNING id`,
      )
      .get(schoolId, number, effLane, wave.id, count + 1, now, now) as { id: number };
    db.exec("COMMIT");
    return { ok: true, waveNumber: wave.number, spot: count + 1 };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    // The partial unique index firing IS the atomic duplicate rejection.
    if (String(e).includes("UNIQUE constraint failed")) {
      return { ok: false, reason: "duplicate" };
    }
    throw e;
  }
}

// Two independent connections = two function invocations / two phones.
const walkerA = openConn(); // LEFT lane
const walkerB = openConn(); // RIGHT lane

// --- Test 1: rapid interleaved two-walker entry, 4 spots/wave -------------
const seq: Array<[Database, string, string]> = [
  [walkerA, "101", "left"], [walkerB, "201", "right"],
  [walkerA, "102", "left"], [walkerB, "202", "right"],
  [walkerA, "103", "left"], [walkerB, "203", "right"],
  [walkerA, "104", "left"], [walkerB, "204", "right"],
  [walkerA, "105", "left"], [walkerB, "205", "right"],
];
const results = seq.map(([db, n, l]) => addEntry(db, "sch_test", n, l));
check("all 10 interleaved entries accepted", results.every((r) => r.ok));
const expected: Record<string, [number, number]> = {
  "101": [1, 1], "102": [1, 2], "103": [1, 3], "104": [1, 4], "105": [2, 1],
  "201": [1, 1], "202": [1, 2], "203": [1, 3], "204": [1, 4], "205": [2, 1],
};
let assignmentOk = true;
seq.forEach(([, n], i) => {
  const [w, s] = expected[n];
  if (results[i].waveNumber !== w || results[i].spot !== s) assignmentOk = false;
});
check("per-lane wave/spot assignment identical to local sim (L: W1S1-4+W2S1, R: same)", assignmentOk);

// --- Test 2: cross-connection duplicate is rejected ------------------------
const dupAttempt = addEntry(walkerB, "sch_test", "101", "right");
check("duplicate from the OTHER connection rejected", !dupAttempt.ok && dupAttempt.reason === "duplicate");
const stillOne = walkerA
  .query("SELECT COUNT(*) AS c FROM car_entries WHERE school_id='sch_test' AND number='101'")
  .get() as { c: number };
check("exactly one row for 101 after duplicate attempt", stillOne.c === 1);

// --- Test 3: the index itself is the last line of defense ------------------
// Bypass the app-level check entirely: a raw racing insert must still fail.
let indexFired = false;
try {
  walkerB
    .query(
      `INSERT INTO car_entries (school_id, number, lane, wave_id, spot, status, entered_at, updated_at)
       VALUES ('sch_test', '102', 'right', 1, 9, 'entered', 1, 1)`,
    )
    .run();
} catch (e) {
  indexFired = String(e).includes("UNIQUE constraint failed");
}
check("partial unique index rejects a raw duplicate active insert", indexFired);

// --- Test 4: number reusable after departure (partial index semantics) -----
walkerA
  .query("UPDATE car_entries SET status='departed' WHERE school_id='sch_test' AND number='103'")
  .run();
const reuse = addEntry(walkerA, "sch_test", "103", "left");
check("number 103 reusable after its car departed", reuse.ok);

// --- Test 5: same number in a DIFFERENT school is fine ---------------------
walkerB.exec(
  `INSERT INTO schools (id, join_code, name, spots_per_wave, lane_mode, created_at)
   VALUES ('sch_other', 'OTHERCODE', 'Other Elementary', 4, 'dual', ${Date.now()})`,
);
const otherSchool = addEntry(walkerB, "sch_other", "101", "left");
check("tenant isolation: 101 in another school accepted independently", otherSchool.ok);

walkerA.close();
walkerB.close();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
