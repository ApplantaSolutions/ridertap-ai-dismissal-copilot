// ADMIN BOARD + CODE NORMALIZATION verification — runs the production
// function (functions/actions.ts) through independent driver processes
// against a scratch local libSQL file seeded with TWO schools with
// different summary histories. Hand-computed expectations:
//
//   Alpha Elementary (join code stored DASHED as "RT-ALPHA1", dual, 4/wave)
//     summaries: (10 loaded, 1 no-show, 600 s) + (14 loaded, 2 no-show, 900 s)
//       → days 2 · cars 24 · no-shows 3 · avg 750 s · last 2026-09-17
//     live board: entered×2, on_board×1, loaded×1, departed×1, no_show×1
//       → active 4 {entered 2, on_board 1, at_spot 0, loaded 1} · holds 2
//   Beta Middle (join code "BETA22", single, 6/wave)
//     summaries: (7 loaded, 0 no-show, started_at NULL — legacy row)
//       → days 1 · cars 7 · no-shows 0 · avg null · last 2026-09-12
//     live board: entered×1, at_spot×2 → active 3 {1, 0, 2, 0} · holds 1
//
// Run from ~/workspace/ridertap/production:  bun scripts/admin-board-test.ts
// Exit code 0 only if every check passes.

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROD = new URL("..", import.meta.url).pathname;
const TMP = join("/tmp", `ridertap-admin-test-${process.pid}`);
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const DBPATH = join(TMP, "admin.db");
const DRIVER = join(PROD, "scripts/invoke-driver.ts");

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}
function section(s: string) {
  console.log(`\n== ${s}`);
}

// ------------------------------------------------------------- DB setup
const schemaSql = readFileSync(join(PROD, "schema/0001_production_schema.sql"), "utf8");
const T0 = Date.parse("2026-08-15T12:00:00Z");
const T1 = Date.parse("2026-09-01T12:00:00Z");
{
  const db = new Database(DBPATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(schemaSql);
  const insSchool = db.query(
    `INSERT INTO schools (id, join_code, name, district, county, state, school_type,
       dismissal_start, dismissal_end, spots_per_wave, lane_mode, left_label, right_label, created_at)
     VALUES (?, ?, ?, ?, ?, 'GA', ?, '14:15', '15:00', ?, ?, 'Left Line', 'Right Line', ?)`,
  );
  insSchool.run("sch_alpha", "RT-ALPHA1", "Alpha Elementary", "Alpha District", "Alpha County", "elementary", 4, "dual", T0);
  insSchool.run("sch_beta", "BETA22", "Beta Middle", "Beta District", "Beta County", "middle", 6, "single", T1);
  const insSummary = db.query(
    `INSERT INTO day_summaries (school_id, total_loaded, total_no_show, waves_run,
       total_holds, still_waiting, started_at, first_car_at, last_car_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const a1s = Date.parse("2026-09-10T18:00:00Z");
  insSummary.run("sch_alpha", 10, 1, 3, 2, 0, a1s, a1s, a1s + 600_000, a1s + 600_000);
  const a2s = Date.parse("2026-09-17T18:00:00Z");
  insSummary.run("sch_alpha", 14, 2, 4, 1, 1, a2s, a2s, a2s + 900_000, a2s + 900_000);
  const b1e = Date.parse("2026-09-12T18:05:00Z");
  insSummary.run("sch_beta", 7, 0, 2, 0, 0, null, b1e - 300_000, b1e, b1e);
  const insWave = db.query(
    `INSERT INTO waves (school_id, lane, number, status, created_at) VALUES (?, ?, 1, 'open', ?)`,
  );
  const wA = insWave.run("sch_alpha", "left", T0).lastInsertRowid;
  const wB = insWave.run("sch_beta", "main", T1).lastInsertRowid;
  const insEntry = db.query(
    `INSERT INTO car_entries (school_id, number, lane, wave_id, spot, status, entered_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Alpha live board (777005 departed / 777006 no_show must NOT count as active)
  insEntry.run("sch_alpha", "777001", "left", wA, 1, "entered", T0, T0);
  insEntry.run("sch_alpha", "777002", "left", wA, 2, "entered", T0, T0);
  insEntry.run("sch_alpha", "777003", "left", wA, 3, "on_board", T0, T0);
  insEntry.run("sch_alpha", "777004", "left", wA, 4, "loaded", T0, T0);
  insEntry.run("sch_alpha", "777005", "left", wA, 5, "departed", T0, T0);
  insEntry.run("sch_alpha", "777006", "left", wA, 6, "no_show", T0, T0);
  insEntry.run("sch_beta", "888001", "main", wB, 1, "at_spot", T1, T1);
  insEntry.run("sch_beta", "888002", "main", wB, 2, "at_spot", T1, T1);
  insEntry.run("sch_beta", "888003", "main", wB, 3, "entered", T1, T1);
  const insHold = db.query(
    `INSERT INTO holds (school_id, number, created_at) VALUES (?, ?, ?)`,
  );
  insHold.run("sch_alpha", "777004", T0);
  insHold.run("sch_alpha", "999000", T0);
  insHold.run("sch_beta", "888001", T1);
  db.close();
}
check("schema applied; 2 schools + summaries + live boards seeded", true);

// ------------------------------------------------------------- drivers
let driverSeq = 0;
async function runDriver(
  steps: unknown[],
  env: Record<string, string> = {},
): Promise<Array<{ status: number; body: any }>> {
  const scriptPath = join(TMP, `driver-${driverSeq++}.json`);
  writeFileSync(scriptPath, JSON.stringify({ steps }));
  const proc = Bun.spawn(["bun", DRIVER, scriptPath], {
    env: {
      ...process.env,
      TURSO_DATABASE_URL: `file:${DBPATH}`,
      RIDERTAP_TMP: TMP,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`driver exited ${code}: ${err.slice(0, 800)}`);
  return JSON.parse(out.trim().split("\n").pop()!);
}
const call = (action: string, args: unknown = {}, schoolCode: string | null = "RT-ALPHA1") => ({
  call: { action, args, schoolCode },
});
const ADMIN_ENV = { ADMIN_CODE: "Owner-9X" }; // mixed case on purpose

// ============================================================ ADMIN GATE
section("Admin gate — ADMIN_CODE set");
const noCode = await runDriver([call("adminOverview", {}, null)], ADMIN_ENV);
check("adminOverview with NO code → 401 admin_code_required",
  noCode[0].status === 401 && noCode[0].body?.error === "admin_code_required");
const wrong = await runDriver([call("adminOverview", {}, "WRONGCODE")], ADMIN_ENV);
check("adminOverview with WRONG code → 403, nothing admin-shaped returned",
  wrong[0].status === 403 && wrong[0].body?.error === "admin_forbidden" &&
  !("schools" in (wrong[0].body ?? {})));
const schoolCodeTry = await runDriver([call("adminOverview", {}, "RT-ALPHA1")], ADMIN_ENV);
check("adminOverview with a valid SCHOOL code → 403 (school code unlocks nothing)",
  schoolCodeTry[0].status === 403 && !("schools" in (schoolCodeTry[0].body ?? {})));

// ============================================================ OVERVIEW
section("Admin overview — owner code, aggregates hand-checked");
const ov = await runDriver([call("adminOverview", {}, "owner9x")], ADMIN_ENV);
check("owner code in lowercase/no-dash form ('owner9x') → 200 (normalized compare)",
  ov[0].status === 200, `status=${ov[0].status}`);
const body = ov[0].body ?? {};
check("overview lists BOTH schools, created order (Alpha, Beta)",
  Array.isArray(body.schools) && body.schools.length === 2 &&
  body.schools[0]?.name === "Alpha Elementary" && body.schools[1]?.name === "Beta Middle");
const A = body.schools?.[0] ?? {};
const B = body.schools?.[1] ?? {};
check("Alpha profile: join code (as stored, dashed), type, lanes, spots, createdAt",
  A.joinCode === "RT-ALPHA1" && A.schoolType === "elementary" && A.laneMode === "dual" &&
  A.spotsPerWave === 4 && A.county === "Alpha County" &&
  A.createdAt === new Date(T0).toISOString());
check("Alpha summary: days 2, cars 24, no-shows 3, avg 750 s, last 2026-09-17",
  A.summary?.daysRecorded === 2 && A.summary?.totalCarsLoaded === 24 &&
  A.summary?.totalNoShows === 3 && A.summary?.avgDismissalDurationSec === 750 &&
  A.summary?.lastDismissalDate === "2026-09-17" &&
  A.summary?.lastDismissalAt === new Date(Date.parse("2026-09-17T18:00:00Z") + 900_000).toISOString(),
  JSON.stringify(A.summary));
check("Alpha today: active 4 {entered 2, on_board 1, at_spot 0, loaded 1}, holds 2",
  A.today?.activeEntries === 4 && A.today?.byStatus?.entered === 2 &&
  A.today?.byStatus?.on_board === 1 && A.today?.byStatus?.at_spot === 0 &&
  A.today?.byStatus?.loaded === 1 && A.today?.activeHolds === 2,
  JSON.stringify(A.today));
check("Beta summary: days 1, cars 7, no-shows 0, avg null (legacy row), last 2026-09-12",
  B.summary?.daysRecorded === 1 && B.summary?.totalCarsLoaded === 7 &&
  B.summary?.totalNoShows === 0 && B.summary?.avgDismissalDurationSec === null &&
  B.summary?.lastDismissalDate === "2026-09-12",
  JSON.stringify(B.summary));
check("Beta today: active 3 {entered 1, on_board 0, at_spot 2, loaded 0}, holds 1",
  B.today?.activeEntries === 3 && B.today?.byStatus?.entered === 1 &&
  B.today?.byStatus?.on_board === 0 && B.today?.byStatus?.at_spot === 2 &&
  B.today?.byStatus?.loaded === 0 && B.today?.activeHolds === 1,
  JSON.stringify(B.today));
const payloadText = JSON.stringify(body);
check("payload carries NO car numbers and no entry rows (aggregates only)",
  !["777001", "777002", "777003", "777004", "777005", "777006",
    "888001", "888002", "888003", "999000"].some((n) => payloadText.includes(n)) &&
  !("entries" in A) && !("entries" in B));

// ============================================================ UNSET ENV
section("Admin gate — ADMIN_CODE unset (admin locked, school flow unaffected)");
const unsetEnv = { ADMIN_CODE: "" };
const dis = await runDriver([call("adminOverview", {}, "Owner-9X")], unsetEnv);
check("ADMIN_CODE unset → owner code refused 403 admin_disabled",
  dis[0].status === 403 && dis[0].body?.error === "admin_disabled");
const disNoCode = await runDriver([call("adminOverview", {}, null)], unsetEnv);
check("ADMIN_CODE unset + no code → 401 (still refuses)",
  disNoCode[0].status === 401);
const gsUnset = await runDriver(
  [call("getState"), call("addEntry", { number: "555", lane: "left" })],
  unsetEnv,
);
check("school flow unaffected while ADMIN_CODE unset (getState + addEntry)",
  gsUnset[0].status === 200 && gsUnset[0].body?.school?.name === "Alpha Elementary" &&
  gsUnset[1].body?.ok === true);

// ============================================================ NORMALIZATION
section("School code normalization — every format opens the same school");
for (const fmt of ["RT-ALPHA1", "RTALPHA1", "rt-alpha1", "RT ALPHA1", "rt alpha1"]) {
  const r = await runDriver([call("getState", {}, fmt)], ADMIN_ENV);
  check(`getState with '${fmt}' → Alpha Elementary`,
    r[0].status === 200 && r[0].body?.school?.name === "Alpha Elementary",
    `status=${r[0].status}`);
}
const betaAdd = await runDriver([call("addEntry", { number: "555", lane: "main" }, "beta22")], ADMIN_ENV);
check("car 555 (already in Alpha) enters Beta independently, via lowercase code",
  betaAdd[0].body?.ok === true);
const alphaDup = await runDriver([call("addEntry", { number: "555", lane: "left" }, "RTALPHA1")], ADMIN_ENV);
check("car 555 re-entered in Alpha via dashless code → duplicate",
  alphaDup[0].body?.ok === false && alphaDup[0].body?.reason === "duplicate");

console.log(failures === 0 ? "\nALL ADMIN-BOARD CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
