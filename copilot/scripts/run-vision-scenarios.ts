// Vision acceptance runner — Tue Oct 27 gate for Build 1.
//
// Runs SC-03, SC-04, SC-05, SC-06 from test-assets/SCENARIOS.md against the
// REAL actions function (in-process, stub SAM adapter), plus a ground-truth
// sweep of the whole STILLS-PLAN set through the same pipeline. Every
// assertion prints the evidence it was graded on (R-19: raw evidence, not
// summaries). Results are also written to test-results/.
//
//   bun scripts/run-vision-scenarios.ts
//
// Uses a THROWAWAY local DB file (COPILOT_DB_URL is forced for this
// process) so runs are deterministic and never touch any shared state.

import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";

const DB_PATH = "/tmp/copilot-vision-gate.sqlite";
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
}
process.env.COPILOT_DB_URL = `file:${DB_PATH}`;
process.env.COPILOT_SAM_ADAPTER = "stub";

const { getDb, ensureSchema } = await import("../src/db");
const db = getDb();
const actions: any = await import("../functions/actions");
const handler: (req: Request) => Promise<Response> = actions.default;

await ensureSchema();
// ensureSchema now self-bootstraps this exact demo school (db.ts
// ensureDemoSchool) — INSERT OR IGNORE keeps this setup line idempotent
// against it. No graded assertion reads the school row itself.
await db.execute({
  sql: `INSERT OR IGNORE INTO copilot_schools (id, join_code, name, lane_mode, spots_per_wave, created_at)
        VALUES ('sch_staging_auburn', 'RT-KW4W4X', 'Auburn Elementary (Demo)', 'dual', 4, ?)`,
  args: [Date.now()],
});

const CODE = "RT-KW4W4X";
async function call(action: string, args: unknown = {}): Promise<any> {
  const res = await handler(
    new Request("https://ridertap-copilot.internal/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, args, schoolCode: CODE }),
    }),
  );
  return res.json();
}

const lines: string[] = [];
let failures = 0;
function log(s = "") {
  lines.push(s);
  console.log(s);
}
function check(label: string, cond: boolean, evidence = "") {
  log(`${cond ? "PASS" : "FAIL"}  ${label}${evidence ? ` — ${evidence}` : ""}`);
  if (!cond) failures++;
}
const zc = (lane: string, stillId: string, expected: number) =>
  call("zoneCheck", { lane, stillId, expected });

// ------------------------------------------------------------ health ---
log("== health ==");
const health = await call("health");
check("health answers ok", health.ok === true, JSON.stringify(health));

// ------------------------------------------- ground-truth sweep (§2) ---
log("\n== STILLS-PLAN ground-truth sweep (single still, expected = ground truth → count must equal it, status VERIFIED) ==");
const SWEEP: Array<[string, string, number]> = [
  // [stillId, lane, ground-truth count]
  ["ST-01", "main", 0], ["ST-02", "main", 1], ["ST-03", "main", 2],
  ["ST-04", "main", 3], ["ST-05", "main", 4], ["ST-06", "main", 5],
  ["ST-07", "main", 6], ["ST-08", "main", 7], ["ST-09", "main", 8],
  ["ST-10", "main", 9],
  ["ST-11", "main", 4], // centroid of 5th car OUTSIDE the crop → not counted
  ["ST-12", "main", 5], // centroid INSIDE → counted
  ["ST-13", "left", 4], ["ST-13", "right", 4],
  ["ST-14", "left", 3], ["ST-14", "right", 5],
  ["ST-15", "left", 4], ["ST-15", "right", 4], // approach cars outside crop
  ["ST-16", "main", 0], ["ST-17", "main", 0],
  ["ST-18", "main", 3], // cones + sign must not count
  ["ST-19", "main", 2], // people must not count
  ["ST-20", "main", 4], // bicycle must not count
  ["ST-21", "main", 0], // bus outside the zone
  ["ST-22", "main", 4], // parked car outside the zone
  ["ST-23", "left", 5],
  ["ST-24", "main", 1],
];
for (const [stillId, lane, truth] of SWEEP) {
  await call("resetZone", { lane });
  const r = await zc(lane, stillId, truth);
  check(
    `${stillId} (${lane}) counts ${truth}`,
    r.count === truth && r.status === "VERIFIED",
    `got count=${r.count} status=${r.status} masks=${r.masksReturned}`,
  );
}

// ------------------------------------------------------------- SC-03 ---
log("\n== SC-03 — zone match + count-only persistence ==");
await call("resetZone", { lane: "left" });
const sc3a = await zc("left", "ST-05", 4);
const sc3b = await zc("left", "ST-05", 4);
check("SC-03 still 1: count 4, VERIFIED", sc3a.count === 4 && sc3a.status === "VERIFIED", JSON.stringify(sc3a));
check("SC-03 still 2: count 4, VERIFIED (a match never needs debounce)", sc3b.count === 4 && sc3b.status === "VERIFIED", JSON.stringify(sc3b));
const checkRows = (
  await db.execute({
    sql: "SELECT lane, source, count, expected, status FROM copilot_zone_checks WHERE lane='left' ORDER BY id ASC",
    args: [],
  })
).rows;
check(
  "SC-03 persistence: exactly the 2 count records for this lane",
  checkRows.length === 2 && checkRows.every((r) => Number(r.count) === 4 && String(r.status) === "VERIFIED"),
  JSON.stringify(checkRows),
);
const cols = (
  await db.execute({
    sql: "SELECT name, type FROM pragma_table_info('copilot_zone_checks')",
    args: [],
  })
).rows.map((r) => `${r.name}:${r.type}`);
check(
  "SC-03 privacy: checks table has no image/mask/blob column",
  !cols.some((c) => /image|mask|blob|photo|thumb/i.test(c)),
  `columns=${cols.join(",")}`,
);
const dbBytes = await Bun.file(DB_PATH).arrayBuffer();
const dbBuf = Buffer.from(dbBytes);
const hasJpeg = dbBuf.includes(Buffer.from([0xff, 0xd8, 0xff]));
const hasPng = dbBuf.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
check("SC-03 privacy: no JPEG/PNG signature anywhere in the DB file", !hasJpeg && !hasPng);

// ------------------------------------------------------------- SC-04 ---
log("\n== SC-04 — mismatch +1 (5 vs 4), debounce then flag ==");
await call("resetZone", { lane: "left" });
const sc4a = await zc("left", "ST-06", 4);
check("SC-04 still 1: count 5, CHECKING, NO flag", sc4a.count === 5 && sc4a.status === "CHECKING" && sc4a.flagRaised === false, JSON.stringify(sc4a));
const sc4b = await zc("left", "ST-06", 4);
check("SC-04 still 2: count 5, MISMATCH, flag raised with 5-vs-4", sc4b.count === 5 && sc4b.expected === 4 && sc4b.status === "MISMATCH" && sc4b.flagRaised === true, JSON.stringify(sc4b));
const sc4c = await zc("left", "ST-06", 4);
check("SC-04 still 3: still MISMATCH, flag NOT re-raised (one episode)", sc4c.status === "MISMATCH" && sc4c.flagRaised === false, JSON.stringify(sc4c));
const st4 = await call("getZoneStatus");
const left4 = st4.lanes.find((l: any) => l.lane === "left");
check("SC-04 board status: left = MISMATCH, count 5, expected 4, flagCount 1", left4?.status === "MISMATCH" && left4?.count === 5 && left4?.expected === 4 && left4?.flagCount === 1, JSON.stringify(left4));

// ------------------------------------------------------------- SC-05 ---
log("\n== SC-05 — mismatch −1 (3 vs 4) on Right ==");
await call("resetZone", { lane: "right" });
const sc5a = await zc("right", "ST-04", 4);
check("SC-05 still 1: count 3, CHECKING, no flag", sc5a.count === 3 && sc5a.status === "CHECKING" && sc5a.flagRaised === false, JSON.stringify(sc5a));
const sc5b = await zc("right", "ST-04", 4);
check("SC-05 still 2: count 3, MISMATCH, flag with 3-vs-4", sc5b.count === 3 && sc5b.expected === 4 && sc5b.status === "MISMATCH" && sc5b.flagRaised === true, JSON.stringify(sc5b));

// ------------------------------------------------------------- SC-06 ---
log("\n== SC-06 — debounce guard: one transient mismatch = NO flag, ever ==");
await call("resetZone", { lane: "left" });
const seq = ["ST-05", "ST-06", "ST-05", "ST-05"];
const statuses: string[] = [];
for (const still of seq) {
  const r = await zc("left", still, 4);
  statuses.push(r.status);
}
check(
  "SC-06 status sequence = VERIFIED, CHECKING, VERIFIED, VERIFIED",
  JSON.stringify(statuses) === JSON.stringify(["VERIFIED", "CHECKING", "VERIFIED", "VERIFIED"]),
  statuses.join(" → "),
);
const st6 = await call("getZoneStatus");
const left6 = st6.lanes.find((l: any) => l.lane === "left");
check("SC-06 flag count for the scenario = 0", left6?.flagCount === 0, JSON.stringify(left6));
check("SC-06 chip ends VERIFIED", left6?.status === "VERIFIED");

// -------------------------------------------------------------- done ---
log(failures === 0 ? "\nALL VISION CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
mkdirSync(new URL("../test-results/", import.meta.url).pathname, { recursive: true });
writeFileSync(
  new URL("../test-results/vision-scenarios-2026-10-27.txt", import.meta.url).pathname,
  lines.join("\n") + "\n",
);
process.exit(failures === 0 ? 0 : 1);
