// FINAL production-bundle verification — runs the FINAL production
// function (functions/actions.ts) and the FINAL bundled zip through the
// full behavioral suite against a local libSQL file (the same engine as
// Turso). Two independent driver PROCESSES (two libSQL connections, two
// would-be Netlify Function instances) are used wherever concurrency
// matters — nothing here mocks the handler or the database.
//
// Run from ~/workspace/ridertap/production:  bun scripts/final-bundle-test.ts
// Exit code 0 only if every check passes.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROD = new URL("..", import.meta.url).pathname;
const TMP = join("/tmp", `ridertap-final-test-${process.pid}`);
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const DBPATH = join(TMP, "prod.db");
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
function applySchema(path: string) {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(schemaSql);
  db.close();
}
function seedSchool(path: string, id: string, code: string, name: string, spots: number) {
  const db = new Database(path);
  db.query(
    `INSERT INTO schools (id, join_code, name, district, county, state, school_type,
       dismissal_start, dismissal_end, spots_per_wave, lane_mode, left_label, right_label, created_at)
     VALUES (?, ?, ?, 'Test District', 'Test County', 'GA', 'elementary',
             '14:15', '15:00', ?, 'dual', 'Left Line', 'Right Line', ?)`,
  ).run(id, code, name, spots, Date.now());
  db.close();
}
applySchema(DBPATH);
seedSchool(DBPATH, "sch_a", "TESTCODE", "Test Elementary", 4);
seedSchool(DBPATH, "sch_b", "OTHERCODE", "Other Elementary", 8);
seedSchool(DBPATH, "sch_c", "RACECODE", "Race Elementary", 4);
check("production schema applies cleanly; 3 tenant schools seeded", true);

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
const call = (action: string, args: unknown = {}, schoolCode: string | null = "TESTCODE") => ({
  call: { action, args, schoolCode },
});

// ============================================================ PHASE A
section("A — two-walker interleave (two processes, ping-pong barriers)");
const aSteps: unknown[] = [{ wait: "go1" }];
const bSteps: unknown[] = [{ wait: "go1" }];
for (let i = 1; i <= 5; i++) {
  aSteps.push(call("addEntry", { number: `10${i}`, lane: "left" }), { touch: `a${i}` });
  if (i < 5) aSteps.push({ wait: `b${i}` });
  bSteps.push({ wait: `a${i}` }, call("addEntry", { number: `20${i}`, lane: "right" }), { touch: `b${i}` });
}
const pA = runDriver(aSteps);
const pB = runDriver(bSteps);
await Bun.sleep(600);
writeFileSync(join(TMP, "go1"), "1");
const [resA, resB] = await Promise.all([pA, pB]);
const expectAssign = (res: Array<any>, nums: string[]) =>
  res.every((r, i) => {
    const e = r.body?.entry;
    return (
      r.status === 200 && r.body?.ok === true && e &&
      e.number === nums[i] &&
      e.waveNumber === (i < 4 ? 1 : 2) && e.spot === (i < 4 ? i + 1 : 1)
    );
  });
check("walker A (left): 101–105 accepted, W1 S1–4 then W2 S1",
  expectAssign(resA, ["101", "102", "103", "104", "105"]));
check("walker B (right): 201–205 accepted, W1 S1–4 then W2 S1",
  expectAssign(resB, ["201", "202", "203", "204", "205"]));
const firstEntryAt = resA[0].body.entry.enteredAt;

section("A2 — cross-connection duplicate guard");
const dup1 = await runDriver([call("addEntry", { number: "101", lane: "right" })]);
check("B's session re-entering A's 101 → duplicate, A's placement reported",
  dup1[0].body?.ok === false && dup1[0].body?.reason === "duplicate" &&
  dup1[0].body?.existing?.lane === "left" && dup1[0].body?.existing?.waveNumber === 1 &&
  dup1[0].body?.existing?.spot === 1);
const dup2 = await runDriver([call("addEntry", { number: "201", lane: "left" })]);
check("A's session re-entering B's 201 → duplicate, B's placement reported",
  dup2[0].body?.ok === false && dup2[0].body?.reason === "duplicate" &&
  dup2[0].body?.existing?.lane === "right" && dup2[0].body?.existing?.spot === 1);
{
  const db = new Database(DBPATH, { readonly: true });
  const c = db.query("SELECT COUNT(*) AS c FROM car_entries WHERE number='101'").get() as { c: number };
  check("exactly one row for 101 after both duplicate attempts", c.c === 1);
  db.close();
}

section("A3 — per-lane wave release independence");
const st1 = (await runDriver([call("getState")]))[0].body;
const waveId = (lane: string, n: number) => st1.waves.find((w: any) => w.lane === lane && w.number === n).id;
const entryId = (number: string) => st1.entries.find((e: any) => e.number === number).id;
const adv = async (number: string, times = 3) => {
  const steps = Array.from({ length: times }, () => call("advanceEntry", { id: entryId(number) }));
  return runDriver(steps);
};
for (const n of ["101", "102", "103", "104"]) await adv(n);
const relLeft = await runDriver([call("releaseWave", { waveId: waveId("left", 1) })]);
check("Left W1 releases on its own count (4 in / 4 ready)",
  relLeft[0].body?.ok === true && relLeft[0].body?.inCount === 4 && relLeft[0].body?.readyCount === 4);
const relRightEarly = await runDriver([call("releaseWave", { waveId: waveId("right", 1) })]);
check("Right W1 stays blocked while its cars are not loaded (not_ready, 0 ready)",
  relRightEarly[0].body?.ok === false && relRightEarly[0].body?.reason === "not_ready" &&
  relRightEarly[0].body?.readyCount === 0);

section("A4 — holds: block + Proof Report session counting");
const holdSeq = await runDriver([
  call("setHold", { number: "205" }),
  call("advanceEntry", { id: entryId("205") }),
  call("clearHold", { number: "205" }),
  call("setHold", { number: "888" }),
  call("clearHold", { number: "888" }),
]);
check("advanceEntry on a held car is refused (reason=held)",
  holdSeq[1].body?.ok === false && holdSeq[1].body?.reason === "held");
for (const n of ["201", "202", "203", "204"]) await adv(n);
const relRight = await runDriver([call("releaseWave", { waveId: waveId("right", 1) })]);
check("Right W1 releases after its own cars load", relRight[0].body?.ok === true);

section("A5 — End Dismissal writes the Proof Report summary");
const end1 = (await runDriver([call("endDismissal")]))[0].body.summary;
check("summary counts: 8 loaded, 0 no-show, 2 waves, 2 still waiting (105, 205)",
  end1.totalLoaded === 8 && end1.totalNoShow === 0 && end1.wavesRun === 2 && end1.stillWaiting === 2,
  JSON.stringify(end1));
check("summary holdsPlaced = 2 (set+cleared holds still count)",
  end1.holdsPlaced === 2);
check("summary startedAt == first entry's enteredAt (duration anchor)",
  end1.startedAt === firstEntryAt, `${end1.startedAt} vs ${firstEntryAt}`);
check("summary duration endedAt − startedAt >= 0 and date matches endedAt",
  Date.parse(end1.endedAt) - Date.parse(end1.startedAt) >= 0 &&
  end1.date === end1.endedAt.slice(0, 10));
const stAfter1 = (await runDriver([call("getState")]))[0].body;
check("board purged; getState summaries=[summary], lastSummary=summary",
  stAfter1.entries.length === 0 && stAfter1.waves.length === 0 &&
  stAfter1.summaries.length === 1 && stAfter1.lastSummary?.endedAt === end1.endedAt &&
  stAfter1.summaries[0]?.startedAt === end1.startedAt);

// ============================================================ PHASE B
section("B — second dismissal: no-show + history ordering");
const b1 = await runDriver([
  call("addEntry", { number: "301", lane: "left" }),
  call("addEntry", { number: "302", lane: "left" }),
]);
const id301 = b1[0].body.entry.id, id302 = b1[1].body.entry.id, w301 = b1[0].body.entry.waveId;
await runDriver([
  call("advanceEntry", { id: id301 }), call("advanceEntry", { id: id301 }), call("advanceEntry", { id: id301 }),
  call("markNoShow", { id: id302 }),
]);
const relB = await runDriver([call("releaseWave", { waveId: w301 })]);
check("wave with 1 loaded + 1 no-show releases (count check counts both)",
  relB[0].body?.ok === true && relB[0].body?.inCount === 2 && relB[0].body?.readyCount === 2);
const end2 = (await runDriver([call("endDismissal")]))[0].body.summary;
check("summary 2: 1 loaded, 1 no-show, 1 wave, 0 holds, 0 still waiting",
  end2.totalLoaded === 1 && end2.totalNoShow === 1 && end2.wavesRun === 1 &&
  end2.holdsPlaced === 0 && end2.stillWaiting === 0, JSON.stringify(end2));
const stB = (await runDriver([call("getState")]))[0].body;
check("history holds both days, oldest first; lastSummary is day 2",
  stB.summaries.length === 2 && stB.summaries[0].endedAt === end1.endedAt &&
  stB.summaries[1].endedAt === end2.endedAt && stB.lastSummary.endedAt === end2.endedAt);

// ============================================================ PHASE C
section("C — tenant isolation, undo session semantics, saveSetup");
const stOther0 = (await runDriver([call("getState", {}, "OTHERCODE")]))[0].body;
check("school B sees its own profile and none of school A's data",
  stOther0.school?.name === "Other Elementary" && stOther0.entries.length === 0 &&
  stOther0.summaries.length === 0);
const bAdd = await runDriver([call("addEntry", { number: "101", lane: "left" }, "OTHERCODE")]);
check("school B can use car 101 independently of school A", bAdd[0].body?.ok === true);
const endB1 = (await runDriver([call("endDismissal", {}, "OTHERCODE")]))[0].body.summary;
check("school B summary: 0 loaded, 1 still waiting (101 never loaded)",
  endB1.totalLoaded === 0 && endB1.stillWaiting === 1);
const stA2 = (await runDriver([call("getState")]))[0].body;
check("school A history untouched by school B's dismissal (still 2)",
  stA2.summaries.length === 2);
const undoSeq = await runDriver([
  call("addEntry", { number: "401", lane: "left" }, "OTHERCODE"),
  call("addEntry", { number: "402", lane: "left" }, "OTHERCODE"),
  call("undoLastEntry", {}, "OTHERCODE"),
  call("undoLastEntry", {}, "OTHERCODE"),
]);
check("undo removes newest entry first (402, then 401)",
  undoSeq[2].body?.removedNumber === "402" && undoSeq[3].body?.removedNumber === "401");
const b403 = await runDriver([call("addEntry", { number: "403", lane: "left" }, "OTHERCODE")]);
await runDriver([call("endDismissal", {}, "OTHERCODE")]);
const stB2 = (await runDriver([call("getState", {}, "OTHERCODE")]))[0].body;
check("after undo-all + re-entry, summary startedAt re-stamps to the new first entry",
  stB2.summaries[1]?.startedAt === b403[0].body.entry.enteredAt);
const setupArgs = {
  name: "Other Elementary", district: "Test District", county: "Test County", state: "GA",
  schoolType: "elementary", dismissalStart: "14:15", dismissalEnd: "15:00",
  spotsPerWave: 5, laneMode: "dual", leftLabel: "Left Line", rightLabel: "Right Line",
};
await runDriver([call("saveSetup", setupArgs, "OTHERCODE")]);
const stB3 = (await runDriver([call("getState", {}, "OTHERCODE")]))[0].body;
check("saveSetup persists (spotsPerWave 8 → 5 for school B only)",
  stB3.school?.spotsPerWave === 5 &&
  (await runDriver([call("getState")]))[0].body.school?.spotsPerWave === 4);

// ============================================================ PHASE D
section("D — dispatch + access gate");
const noCode = await runDriver([call("getState", {}, null)]);
check("missing school code → 401", noCode[0].status === 401);
const badCode = await runDriver([call("getState", {}, "WRONGCODE")]);
check("unknown school code → 403", badCode[0].status === 403);
const seedTry = await runDriver([call("seedDemo")]);
const resetTry = await runDriver([call("resetDemo")]);
check("seedDemo / resetDemo are NOT ported (400 unknown_action)",
  seedTry[0].status === 400 && resetTry[0].status === 400);

// ============================================================ PHASE E
section("E — true same-moment race: exactly one winner (5 rounds)");
for (let r = 0; r < 5; r++) {
  const number = `7${r}1`;
  const steps = [{ wait: `goR${r}` }, call("addEntry", { number, lane: "left" }, "RACECODE")];
  const p1 = runDriver(steps);
  const p2 = runDriver(steps);
  await Bun.sleep(500);
  writeFileSync(join(TMP, `goR${r}`), "1");
  const [r1, r2] = await Promise.all([p1, p2]);
  const winners = [r1[0], r2[0]].filter((x) => x.body?.ok === true).length;
  const losers = [r1[0], r2[0]].filter((x) => x.body?.ok === false && x.body?.reason === "duplicate").length;
  const db = new Database(DBPATH, { readonly: true });
  const c = db.query("SELECT COUNT(*) AS c FROM car_entries WHERE school_id='sch_c' AND number=?").get(number) as { c: number };
  db.close();
  check(`race round ${r + 1} (${number}): 1 winner, 1 duplicate rejection, 1 row`,
    winners === 1 && losers === 1 && c.c === 1,
    `winners=${winners} losers=${losers} rows=${c.c}`);
}

// ============================================================ PHASE F
section("F — the bundled zip itself (Lambda handler export)");
{
  // Bundle the app code with @libsql/client EXTERNAL and ship its
  // node_modules tree inside the zip — the zip-it-and-ship-it shape.
  // (Inlining the client breaks: its native `libsql` binding must be
  // require-resolved from real node_modules at runtime, here and on
  // Netlify's Lambda runtime alike.)
  const build = Bun.spawn(
    ["bun", "build", "functions/actions.ts", "--target=node", "--format=cjs",
     "--external", "@libsql/client",
     "--outfile", "functions-dist/actions.js"],
    { cwd: PROD, stdout: "pipe", stderr: "pipe" },
  );
  const [bOut, bErr, bCode] = await Promise.all([
    new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited,
  ]);
  check("function bundles (bun build, node/cjs, @libsql/client external)",
    bCode === 0, bErr.slice(0, 200) || bOut.trim());
  const zip = Bun.spawn(
    ["python3", "-c",
     "import os, zipfile\n" +
     "z = zipfile.ZipFile('functions-dist/actions.zip', 'w', zipfile.ZIP_DEFLATED)\n" +
     "z.write('functions-dist/actions.js', 'actions.js')\n" +
     "for root, dirs, files in os.walk('node_modules'):\n" +
     "    dirs[:] = [d for d in dirs if d not in ('.bin', '.cache')]\n" +
     "    for f in files:\n" +
     "        p = os.path.join(root, f)\n" +
     "        z.write(p, p)\n" +
     "z.close()"],
    { cwd: PROD, stdout: "pipe", stderr: "pipe" },
  );
  check("actions.zip written (actions.js + node_modules tree)", (await zip.exited) === 0 &&
    existsSync(join(PROD, "functions-dist/actions.zip")));
  const unzipDir = join(TMP, "bundle");
  mkdirSync(unzipDir, { recursive: true });
  const un = Bun.spawn(["python3", "-c",
    `import zipfile; zipfile.ZipFile('${join(PROD, "functions-dist/actions.zip")}').extractall('${unzipDir}')`],
    { stdout: "pipe", stderr: "pipe" });
  await un.exited;
  const DB2 = join(TMP, "bundle.db");
  applySchema(DB2);
  seedSchool(DB2, "sch_x", "BUNDLECODE", "Bundle Elementary", 4);
  const bundleRes = await runDriver(
    [
      call("getState", {}, "BUNDLECODE"),
      call("addEntry", { number: "101", lane: "left" }, "BUNDLECODE"),
      call("addEntry", { number: "101", lane: "left" }, "BUNDLECODE"),
      call("endDismissal", {}, "BUNDLECODE"),
    ],
    { RIDERTAP_FUNCTION_MODULE: join(unzipDir, "actions.js"), RIDERTAP_LAMBDA: "1", TURSO_DATABASE_URL: `file:${DB2}` },
  );
  check("bundled handler: getState returns the bundle school",
    bundleRes[0].body?.school?.name === "Bundle Elementary");
  check("bundled handler: addEntry ok, duplicate rejected",
    bundleRes[1].body?.ok === true && bundleRes[2].body?.ok === false &&
    bundleRes[2].body?.reason === "duplicate");
  check("bundled handler: endDismissal summary carries Proof Report fields",
    bundleRes[3].body?.summary?.stillWaiting === 1 &&
    bundleRes[3].body?.summary?.startedAt === bundleRes[1].body.entry.enteredAt &&
    typeof bundleRes[3].body?.summary?.endedAt === "string");
}

console.log(failures === 0 ? "\nALL FINAL-BUNDLE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
