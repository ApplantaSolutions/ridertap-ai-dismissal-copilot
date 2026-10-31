// Exception-agent acceptance runner — Wed Oct 28 gate for Build 2.
//
// Runs EX-01…EX-08 from test-assets/EXCEPTION-SCRIPTS.md against the REAL
// actions function (in-process, stub Spark adapter), the 4 negative
// tests, the timeout drill ×8 (stub delayed past the 3s cap via a
// harness-only delay), a payload-hygiene test, and a prohibited-line
// guard test. Spark lines are graded by the scripts' acceptable-line
// RULES (right tags named, same action as the reference, one sentence
// ≤ 140 chars, no prohibited instruction) — not by string match; the
// stub's determinism against the scripted reference line is checked
// separately as evidence. Fallback lines ARE graded word-for-word.
//
//   bun scripts/run-exception-scenarios.ts
//
// Uses a THROWAWAY local DB file (COPILOT_DB_URL is forced for this
// process) so runs are deterministic and never touch any shared state.

import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";

const DB_PATH = "/tmp/copilot-exception-gate.sqlite";
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
}
process.env.COPILOT_DB_URL = `file:${DB_PATH}`;
process.env.COPILOT_SAM_ADAPTER = "stub";
process.env.COPILOT_SPARK_ADAPTER = "stub";
delete process.env.COPILOT_SPARK_STUB_DELAY_MS;

const { getDb, ensureSchema } = await import("../src/db");
const db = getDb();
const actions: any = await import("../functions/actions");
const handler: (req: Request) => Promise<Response> = actions.default;
const { ExceptionService, validatePayloadHygiene, prohibitedInstruction } =
  await import("../src/exceptions");
const { StubSparkAdapter } = await import("../src/spark");
const { ruleFallback } = await import("../src/fallbacks");

await ensureSchema();
await db.execute({
  sql: `INSERT OR IGNORE INTO copilot_schools (id, join_code, name, lane_mode, spots_per_wave, created_at)
        VALUES ('sch_staging_auburn', 'RT-KW4W4X', 'Auburn Elementary (Demo)', 'dual', 4, ?)`,
  args: [Date.now()],
});
const SCHOOL = "sch_staging_auburn";

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
let total = 0;
function log(s = "") {
  lines.push(s);
  console.log(s);
}
function check(label: string, cond: boolean, evidence = "") {
  total++;
  log(`${cond ? "PASS" : "FAIL"}  ${label}${evidence ? ` — ${evidence}` : ""}`);
  if (!cond) failures++;
}
const zc = (lane: string, stillId: string, expected: number) =>
  call("zoneCheck", { lane, stillId, expected });
async function logCount(): Promise<number> {
  const rows = (
    await db.execute({
      sql: "SELECT COUNT(*) AS n FROM copilot_exception_log WHERE school_id = ?",
      args: [SCHOOL],
    })
  ).rows;
  return Number(rows[0].n);
}
async function lastLogRow(): Promise<{ trigger: string; source: string }> {
  const rows = (
    await db.execute({
      sql: "SELECT trigger, source FROM copilot_exception_log WHERE school_id = ? ORDER BY id DESC LIMIT 1",
      args: [SCHOOL],
    })
  ).rows;
  return { trigger: String(rows[0].trigger), source: String(rows[0].source) };
}
async function resetAll(lane?: string) {
  await call("resetBoard");
  if (lane) await call("resetZone", { lane });
}
function oneSentence(line: string): boolean {
  if (!line.endsWith(".")) return false;
  return line.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean).length === 1;
}
/** Grade a Spark line by the EXCEPTION-SCRIPTS acceptable-line rules. */
function gradeSparkLine(
  id: string,
  rec: any,
  want: { trigger: string; action: string; contains: string[]; reference: string },
) {
  check(`${id}: an exception line was produced`, !!rec, JSON.stringify(rec));
  if (!rec) return;
  check(`${id}: trigger is ${want.trigger}`, rec.trigger === want.trigger, rec.trigger);
  check(`${id}: source is spark (healthy stub run)`, rec.source === "spark", rec.source);
  check(
    `${id}: action is ${want.action} (same as reference)`,
    rec.action === want.action,
    rec.action,
  );
  check(
    `${id}: one sentence, ≤140 chars (${rec.instruction?.length})`,
    typeof rec.instruction === "string" &&
      rec.instruction.length <= 140 &&
      oneSentence(rec.instruction),
    rec.instruction,
  );
  for (const c of want.contains) {
    check(`${id}: line names "${c}"`, rec.instruction.includes(c), rec.instruction);
  }
  check(
    `${id}: no prohibited instruction`,
    prohibitedInstruction(rec.instruction) === null,
    prohibitedInstruction(rec.instruction) ?? "clean",
  );
  check(
    `${id}: stub line equals the scripted acceptable line (determinism evidence)`,
    rec.instruction === want.reference,
    rec.instruction,
  );
}

// ------------------------------------------------------------ health ---
log("== health ==");
const health = await call("health");
check("health answers ok", health.ok === true, JSON.stringify(health));
check(
  "health reports build-2 + stub Spark adapter",
  health.build === "build-2-exception-agent" && health.sparkAdapter === "stub",
  `build=${health.build} sparkAdapter=${health.sparkAdapter}`,
);

// ------------------------------------------------------------- EX-01 ---
log("\n== EX-01 — zone mismatch +1 (SC-04), the demo hook ==");
await resetAll("left");
await call("callWave", { id: "L1", lane: "left", tags: ["101", "102", "103", "104"] });
for (const tag of ["101", "102", "103", "104"]) {
  await call("enterTag", { tag, lane: "left", wave: "L1" });
}
await call("setEntryStatus", { tag: "101", status: "at_spot" });
await call("setEntryStatus", { tag: "102", status: "on_board" });
await call("setEntryStatus", { tag: "103", status: "on_board" });
await call("setWaveStatus", { wave: "L1", status: "loading" });
const ex1a = await zc("left", "ST-06", 4);
check(
  "EX-01 still 1: CHECKING, NO exception (debounce pending)",
  ex1a.status === "CHECKING" && !("exception" in ex1a),
  JSON.stringify(ex1a),
);
const ex1b = await zc("left", "ST-06", 4);
check(
  "EX-01 still 2: MISMATCH flag raised, exception attached",
  ex1b.status === "MISMATCH" && ex1b.flagRaised === true && !!ex1b.exception,
  JSON.stringify(ex1b),
);
gradeSparkLine("EX-01", ex1b.exception, {
  trigger: "zone_mismatch",
  action: "hold_wave",
  contains: ["L1"],
  reference:
    "Five cars in the zone but Wave L1 has four — hold the wave and check for an extra car before loading.",
});
check(
  "EX-01: line does NOT blame a specific tag (vision cannot know which car is extra)",
  !/\b10[1-4]\b/.test(ex1b.exception?.instruction ?? ""),
  ex1b.exception?.instruction,
);
const ex1log = await lastLogRow();
check(
  "EX-01: audit log marks the served line spark-prefetch (computed at CHECKING, served at the flag)",
  ex1log.source === "spark-prefetch" && ex1log.trigger === "zone_mismatch",
  JSON.stringify(ex1log),
);

// ------------------------------------------------------------- EX-02 ---
log("\n== EX-02 — zone mismatch −1 (SC-05), Right lane ==");
await resetAll("right");
await call("callWave", { id: "R1", lane: "right", tags: ["201", "202", "203", "204"] });
for (const tag of ["201", "202", "203", "204"]) {
  await call("enterTag", { tag, lane: "right", wave: "R1" });
}
await zc("right", "ST-04", 4);
const ex2 = await zc("right", "ST-04", 4);
gradeSparkLine("EX-02", ex2.exception, {
  trigger: "zone_mismatch",
  action: "check_tag",
  contains: ["R1"],
  reference:
    "Only three cars in the zone for Wave R1's four tags — check which called car is missing before loading.",
});
check(
  "EX-02: line does NOT guess which tag is missing",
  !/\b20[1-4]\b/.test(ex2.exception?.instruction ?? ""),
  ex2.exception?.instruction,
);
const ex2log = await lastLogRow();
check(
  "EX-02: audit log marks the served line spark-prefetch",
  ex2log.source === "spark-prefetch" && ex2log.trigger === "zone_mismatch",
  JSON.stringify(ex2log),
);

// ------------------------------------------------------------- EX-03 ---
log("\n== EX-03 — out-of-order arrival (SC-07) ==");
await resetAll();
await call("callWave", { id: "L1", lane: "left", tags: ["101", "102", "103", "104"] });
const ex3a = await call("enterTag", { tag: "101", lane: "left", wave: "L1" });
check(
  "EX-03: in-order entry of 101 fires nothing",
  ex3a.ok === true && !("exception" in ex3a),
  JSON.stringify(ex3a),
);
const ex3b = await call("enterTag", { tag: "103", lane: "left", wave: "L1" });
gradeSparkLine("EX-03", ex3b.exception, {
  trigger: "out_of_order",
  action: "info",
  contains: ["103", "102"],
  reference:
    "103 arrived before 102 — keep the board order and call 102's student with this wave as planned.",
});

// ------------------------------------------------------------- EX-04 ---
log("\n== EX-04 — duplicate tag (SC-08) ==");
await resetAll();
await call("callWave", { id: "L1", lane: "left", tags: ["213", "214", "215", "216"] });
await call("enterTag", { tag: "213", lane: "left", wave: "L1" });
await call("enterTag", { tag: "214", lane: "left", wave: "L1" });
await call("setEntryStatus", { tag: "214", status: "on_board" });
const ex4 = await call("enterTag", { tag: "214", lane: "left", wave: "L1" });
check(
  "EX-04: duplicate attempt is refused by the guard",
  ex4.ok === false && ex4.duplicate === true,
  JSON.stringify(ex4),
);
gradeSparkLine("EX-04", ex4.exception, {
  trigger: "duplicate",
  action: "info",
  contains: ["214"],
  reference:
    "214 is already queued in Left, Wave 1, spot 2 — don't enter it again; the first entry stands.",
});
const board4 = await call("getBoard");
const entries214 = board4.entries.filter((e: any) => e.tag === "214");
check(
  "EX-04: exactly ONE entry for 214 exists on the board after the case",
  entries214.length === 1,
  JSON.stringify(entries214),
);

// ------------------------------------------------------------- EX-05 ---
log("\n== EX-05 — HOLD placed, wave not yet loading (SC-09) ==");
await resetAll();
await call("callWave", { id: "L2", lane: "left", tags: ["118", "119", "120", "121"] });
await call("enterTag", { tag: "118", lane: "left", wave: "L2" });
const ex5 = await call("placeHold", { tag: "118" });
check("EX-05: hold is live in the placeHold response", ex5.holdLive === true, JSON.stringify(ex5));
check(
  "EX-05 ordering: hold placed_at ≤ exception created_at (hold never waits on the agent)",
  Date.parse(ex5.holdPlacedAt) <= Date.parse(ex5.exception?.createdAt ?? ""),
  `hold=${ex5.holdPlacedAt} exception=${ex5.exception?.createdAt}`,
);
gradeSparkLine("EX-05", ex5.exception, {
  trigger: "hold_placed",
  action: "keep_out_of_wave",
  contains: ["118"],
  reference:
    "118 is on hold — keep it out of Wave L2's loading until the office clears the hold.",
});
const board5 = await call("getBoard");
check("EX-05: hold stands on the board", board5.holds.includes("118"), JSON.stringify(board5.holds));

// ------------------------------------------------------------- EX-06 ---
log("\n== EX-06 — HOLD placed while the wave is loading (SC-10) ==");
await resetAll();
await call("callWave", { id: "R1", lane: "right", tags: ["201", "202", "203", "204"] });
for (const tag of ["201", "202", "203", "204"]) {
  await call("enterTag", { tag, lane: "right", wave: "R1" });
}
await call("setEntryStatus", { tag: "201", status: "at_spot" });
await call("setEntryStatus", { tag: "202", status: "on_board" });
await call("setWaveStatus", { wave: "R1", status: "loading" });
const ex6 = await call("placeHold", { tag: "203" });
gradeSparkLine("EX-06", ex6.exception, {
  trigger: "hold_placed",
  action: "keep_out_of_wave",
  contains: ["203", "201", "204"],
  reference:
    "203 is now on hold mid-wave — stop 203 here and finish loading 201, 202, and 204 around it.",
});

// ------------------------------------------------------------- EX-07 ---
log("\n== EX-07 — walk-up, no car (SC-11) ==");
await resetAll("left");
await call("callWave", { id: "L2", lane: "left", tags: ["132", "133", "134", "135"] });
await call("enterTag", { tag: "132", lane: "left", wave: "L2" });
const ex7zone = await zc("left", "ST-05", 4);
check(
  "EX-07 setup: zone VERIFIED at 4 (walk-up must not change the vehicle expectation)",
  ex7zone.status === "VERIFIED" && ex7zone.count === 4,
  JSON.stringify(ex7zone),
);
const ex7 = await call("markWalkUp", { tag: "132" });
gradeSparkLine("EX-07", ex7.exception, {
  trigger: "walk_up",
  action: "keep_out_of_wave",
  contains: ["132"],
  reference:
    "132 is a walk-up, not a car — call the student to the pickup point and keep them out of the vehicle waves.",
});

// ------------------------------------------------------------- EX-08 ---
log("\n== EX-08 — no-show at the Still Waiting sweep (SC-12) ==");
await resetAll();
await call("callWave", { id: "R2", lane: "right", tags: ["225", "226", "227", "228"] });
await call("enterTag", { tag: "225", lane: "right", wave: "R2" });
await call("setWaveStatus", { wave: "R2", status: "released" });
const ex8 = await call("openSweep", {});
check(
  "EX-08: sweep surfaces 225 as still waiting",
  Array.isArray(ex8.stillWaiting) && ex8.stillWaiting.includes("225"),
  JSON.stringify(ex8),
);
gradeSparkLine("EX-08", ex8.exception, {
  trigger: "no_show_candidate",
  action: "sweep",
  contains: ["225"],
  reference:
    "225 never arrived — office should contact the guardian; mark it no-show only when you confirm.",
});

// -------------------------------------------------- negative tests -----
log("\n== Negative tests — situations that must produce NO agent call ==");
await resetAll("left");
const n1 = await zc("left", "ST-05", 4);
check("NEG-1 zone match: VERIFIED, no exception attached", n1.status === "VERIFIED" && !("exception" in n1));
check("NEG-1 zone match: exception log stays empty", (await logCount()) === 0, `log=${await logCount()}`);
const neg1cur = await call("getException");
check("NEG-1 zone match: no current line on the board", neg1cur.current === null);

const n2 = await zc("left", "ST-06", 4);
check(
  "NEG-2 single mismatching still: CHECKING, no call",
  n2.status === "CHECKING" && !("exception" in n2) && (await logCount()) === 0,
  `status=${n2.status} log=${await logCount()}`,
);

await resetAll();
await call("callWave", { id: "L1", lane: "left", tags: ["301", "302"] });
await call("enterTag", { tag: "301", lane: "left", wave: "L1" });
await call("enterTag", { tag: "302", lane: "left", wave: "L1" });
await call("setWaveStatus", { wave: "L1", status: "loading" });
await call("setEntryStatus", { tag: "301", status: "loaded" });
await call("setWaveStatus", { wave: "L1", status: "released" });
await call("setEntryStatus", { tag: "301", status: "departed" });
check(
  "NEG-3 normal wave release / loading / departure: no call",
  (await logCount()) === 0,
  `log=${await logCount()}`,
);

await resetAll();
await call("callWave", { id: "L2", lane: "left", tags: ["118", "119"] });
await call("enterTag", { tag: "118", lane: "left", wave: "L2" });
await call("placeHold", { tag: "118" });
const beforeRemove = await logCount();
await call("resolveException", { resolution: "confirmed" });
await call("removeHold", { tag: "118" });
const afterRemove = await logCount();
const neg4cur = await call("getException");
const boardNeg4 = await call("getBoard");
check(
  "NEG-4 HOLD removal by a human: no call, line not reopened, hold gone",
  beforeRemove === 1 && afterRemove === 1 && neg4cur.current?.status === "confirmed" && boardNeg4.holds.length === 0,
  `log ${beforeRemove}→${afterRemove}, current=${neg4cur.current?.status}, holds=${JSON.stringify(boardNeg4.holds)}`,
);

// ------------------------------------------------- prohibited guard ----
log("\n== Prohibited-instruction guard — a dangerous Spark line is discarded ==");
const evilAdapter = {
  kind: "stub" as const,
  modelId: "stub:evil-for-guard-test",
  async advise() {
    return {
      instruction: "Load 203 anyway and lift the hold so the wave can go.",
      action: "info" as const,
      latencyMs: 1,
      modelId: "stub:evil-for-guard-test",
      source: "stub" as const,
    };
  },
};
const guardSvc = new ExceptionService(evilAdapter as any);
const guardRec = await guardSvc.advise(SCHOOL, {
  trigger: "hold_placed",
  school_mode: "dual",
  wave: { id: "R1", lane: "right", size: 4, status: "loading" },
  entries: [
    { tag: "201", lane: "right", wave: "R1", spot: 1, status: "at_spot" },
    { tag: "203", lane: "right", wave: "R1", spot: 3, status: "entered" },
  ],
  holds: ["203"],
});
check(
  "GUARD: prohibited line discarded → verbatim fallback shown, source rule-fallback",
  guardRec.source === "rule-fallback" &&
    guardRec.instruction === "203 is on hold — stop it here; the rest of Wave R1 continues.",
  JSON.stringify(guardRec),
);

// ---------------------------------------------------- timeout drill ----
log("\n== Timeout drill ×8 — stub delayed 4000ms past the 3s cap ==");
const DRILL: Array<{ id: string; payload: any; fallback: string }> = [
  {
    id: "EX-01",
    payload: {
      trigger: "zone_mismatch", school_mode: "dual",
      zone: { lane: "left", count: 5, expected: 4, consecutive_mismatches: 2 },
      wave: { id: "L1", lane: "left", size: 4, status: "loading" },
      entries: [
        { tag: "101", lane: "left", wave: "L1", spot: 1, status: "at_spot" },
        { tag: "102", lane: "left", wave: "L1", spot: 2, status: "on_board" },
        { tag: "103", lane: "left", wave: "L1", spot: 3, status: "on_board" },
        { tag: "104", lane: "left", wave: "L1", spot: 4, status: "entered" },
      ],
      holds: [],
    },
    fallback: "Zone count is 5, wave L1 expects 4 — hold the wave and check the extra car.",
  },
  {
    id: "EX-02",
    payload: {
      trigger: "zone_mismatch", school_mode: "dual",
      zone: { lane: "right", count: 3, expected: 4, consecutive_mismatches: 2 },
      wave: { id: "R1", lane: "right", size: 4, status: "called" },
      entries: [
        { tag: "201", lane: "right", wave: "R1", spot: 1, status: "entered" },
        { tag: "202", lane: "right", wave: "R1", spot: 2, status: "entered" },
        { tag: "203", lane: "right", wave: "R1", spot: 3, status: "entered" },
        { tag: "204", lane: "right", wave: "R1", spot: 4, status: "entered" },
      ],
      holds: [],
    },
    fallback: "Zone count is 3, wave R1 expects 4 — check for the missing car before loading.",
  },
  {
    id: "EX-03",
    payload: {
      trigger: "out_of_order", school_mode: "dual",
      wave: { id: "L1", lane: "left", size: 4, status: "called" },
      entries: [
        { tag: "101", lane: "left", wave: "L1", spot: 1, status: "entered" },
        { tag: "103", lane: "left", wave: "L1", spot: 3, status: "entered" },
      ],
      queue_next: [
        { tag: "102", lane: "left", wave: "L1" },
        { tag: "104", lane: "left", wave: "L1" },
      ],
      detail: { arrived_tag: "103", skipped_tag: "102" },
    },
    fallback: "103 arrived ahead of 102 — load in board order and watch for 102 next.",
  },
  {
    id: "EX-04",
    payload: {
      trigger: "duplicate", school_mode: "dual",
      entries: [{ tag: "214", lane: "left", wave: "L1", spot: 2, status: "on_board" }],
      detail: { attempted_tag: "214", attempted_lane: "left", attempt_count: 2 },
    },
    fallback: "214 is already on the board in Left — do not re-enter it.",
  },
  {
    id: "EX-05",
    payload: {
      trigger: "hold_placed", school_mode: "dual",
      entries: [{ tag: "118", lane: "left", wave: "L2", spot: 3, status: "entered" }],
      holds: ["118"],
      wave: { id: "L2", lane: "left", size: 4, status: "called" },
    },
    fallback: "118 is on hold — do not load it until the office clears it.",
  },
  {
    id: "EX-06",
    payload: {
      trigger: "hold_placed", school_mode: "dual",
      wave: { id: "R1", lane: "right", size: 4, status: "loading" },
      entries: [
        { tag: "201", lane: "right", wave: "R1", spot: 1, status: "at_spot" },
        { tag: "202", lane: "right", wave: "R1", spot: 2, status: "on_board" },
        { tag: "203", lane: "right", wave: "R1", spot: 3, status: "entered" },
        { tag: "204", lane: "right", wave: "R1", spot: 4, status: "entered" },
      ],
      holds: ["203"],
    },
    fallback: "203 is on hold — stop it here; the rest of Wave R1 continues.",
  },
  {
    id: "EX-07",
    payload: {
      trigger: "walk_up", school_mode: "dual",
      entries: [{ tag: "132", lane: "left", wave: "L2", status: "entered" }],
      zone: { lane: "left", count: 4, expected: 4, consecutive_mismatches: 0 },
      detail: { walk_up_tag: "132" },
    },
    fallback: "132 arrived on foot — handle at the pickup point, not in a car wave.",
  },
  {
    id: "EX-08",
    payload: {
      trigger: "no_show_candidate", school_mode: "dual",
      entries: [{ tag: "225", lane: "right", wave: "R2", status: "entered" }],
      detail: { still_waiting_tags: ["225"], waves_completed: true },
    },
    fallback: "225 is still waiting and never arrived — contact the guardian before marking no-show.",
  },
];
const drillSvc = new ExceptionService(new StubSparkAdapter({ delayMs: 4000 }));
for (const d of DRILL) {
  check(
    `DRILL ${d.id}: fallback template is the scripted line verbatim`,
    ruleFallback(d.payload).instruction === d.fallback,
    ruleFallback(d.payload).instruction,
  );
  const t0 = performance.now();
  const rec = await drillSvc.advise(SCHOOL, d.payload);
  const elapsed = Math.round(performance.now() - t0);
  check(
    `DRILL ${d.id}: fallback displayed at the cap (elapsed ${elapsed}ms, before the 4000ms stub)`,
    rec.source === "rule-fallback" && rec.instruction === d.fallback && elapsed >= 2800 && elapsed < 3950,
    `source=${rec.source} elapsed=${elapsed}ms line="${rec.instruction}"`,
  );
  // Let the delayed stub actually return, then prove it changed nothing.
  await Bun.sleep(1400);
  const cur = await drillSvc.current(SCHOOL);
  check(
    `DRILL ${d.id}: late Spark line did NOT overwrite the fallback`,
    cur?.instruction === d.fallback && cur?.source === "rule-fallback",
    `current="${cur?.instruction}" source=${cur?.source}`,
  );
  const lastLog = (
    await db.execute({
      sql: "SELECT trigger, source FROM copilot_exception_log WHERE school_id = ? ORDER BY id DESC LIMIT 1",
      args: [SCHOOL],
    })
  ).rows[0];
  check(
    `DRILL ${d.id}: log records source rule-fallback`,
    String(lastLog.source) === "rule-fallback" && String(lastLog.trigger) === d.payload.trigger,
    JSON.stringify(lastLog),
  );
}

// ------------------------------------------------- payload hygiene -----
log("\n== Payload hygiene — anything beyond the contract fails on sight ==");
const hygieneSvc = new ExceptionService(new StubSparkAdapter());
const logsBeforeHygiene = await logCount();
let hygieneThrew = "";
try {
  await hygieneSvc.advise(SCHOOL, {
    ...DRILL[0].payload,
    student_name: "Emma",
  } as any);
} catch (e) {
  hygieneThrew = String(e instanceof Error ? e.message : e);
}
check(
  "HYGIENE: payload with an injected student_name field fails on sight",
  hygieneThrew.startsWith("payload_hygiene"),
  hygieneThrew,
);
let nestedThrew = "";
try {
  validatePayloadHygiene({
    ...DRILL[3].payload,
    entries: [{ tag: "214", lane: "left", wave: "L1", spot: 2, status: "on_board", student_name: "Emma" }],
  });
} catch (e) {
  nestedThrew = String(e instanceof Error ? e.message : e);
}
check(
  "HYGIENE: student_name nested in an entry also fails on sight",
  nestedThrew.startsWith("payload_hygiene"),
  nestedThrew,
);
let streakThrew = "";
try {
  validatePayloadHygiene({
    ...DRILL[0].payload,
    zone: { lane: "left", count: 5, expected: 4, consecutive_mismatches: 1 },
  });
} catch (e) {
  streakThrew = String(e instanceof Error ? e.message : e);
}
check(
  "HYGIENE: zone_mismatch at consecutive_mismatches 1 is refused (EX-01 rule)",
  streakThrew.startsWith("payload_hygiene"),
  streakThrew,
);
check(
  "HYGIENE: rejected payloads produced no log rows",
  (await logCount()) === logsBeforeHygiene,
  `log ${logsBeforeHygiene}→${await logCount()}`,
);

// -------------------------------------- HOLD hard block (Oct 30) -----
log("\n== HOLD hard block — a hold stops entry AND progression, not just advises ==");
async function callWithStatus(action: string, args: unknown = {}): Promise<{ status: number; body: any }> {
  const res = await handler(
    new Request("https://ridertap-copilot.internal/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, args, schoolCode: CODE }),
    }),
  );
  return { status: res.status, body: await res.json() };
}
await resetAll();
await call("callWave", { id: "L1", lane: "left", tags: ["118", "119", "120", "121"] });
const hbPlaced = await call("placeHold", { tag: "119" });
check("HB-0: hold placed on the not-yet-entered 119", hbPlaced.holdLive === true, JSON.stringify(hbPlaced));
const hbLogsArmed = await logCount();
const hb1 = await call("enterTag", { tag: "119", lane: "left", wave: "L1" });
check(
  "HB-1: enterTag on a held tag → held outcome (a 200 safety outcome like duplicate, not an error)",
  hb1.ok === false && hb1.held === true && hb1.tag === "119",
  JSON.stringify(hb1),
);
const hbBoard1 = await call("getBoard");
check(
  "HB-1: NO entry row exists for 119 afterwards (the hold blocked the write itself)",
  !hbBoard1.entries.some((e: any) => e.tag === "119"),
  JSON.stringify(hbBoard1.entries),
);
check(
  "HB-1: the refused entry fired no agent line",
  (await logCount()) === hbLogsArmed,
  `log ${hbLogsArmed}→${await logCount()}`,
);
// Progression: 118 enters first, THEN the hold lands on it.
await call("enterTag", { tag: "118", lane: "left", wave: "L1" });
await call("placeHold", { tag: "118" });
const hb2 = await callWithStatus("setEntryStatus", { tag: "118", status: "loaded" });
check(
  "HB-2: advancing a held tag (loaded) → HTTP 422 tag_on_hold with a plain-language reason",
  hb2.status === 422 &&
    typeof hb2.body.error === "string" &&
    hb2.body.error.startsWith("tag_on_hold") &&
    /on HOLD/.test(hb2.body.error),
  JSON.stringify(hb2),
);
const hbBoard2 = await call("getBoard");
check(
  "HB-2: the held entry's status did not move (still entered)",
  hbBoard2.entries.find((e: any) => e.tag === "118")?.status === "entered",
  JSON.stringify(hbBoard2.entries),
);
const hb3 = await callWithStatus("setEntryStatus", { tag: "118", status: "entered" });
check(
  "HB-3: a non-advancing status on a held tag stays allowed",
  hb3.status === 200 && hb3.body.ok === true,
  JSON.stringify(hb3),
);
await call("removeHold", { tag: "118" });
await call("removeHold", { tag: "119" });
const hb4 = await call("enterTag", { tag: "119", lane: "left", wave: "L1" });
check(
  "HB-4: after the hold clears, 119 enters normally",
  hb4.ok === true && hb4.entry?.tag === "119",
  JSON.stringify(hb4),
);
const hb5 = await callWithStatus("setEntryStatus", { tag: "118", status: "loaded" });
check(
  "HB-4: after the hold clears, 118 advances (loaded) normally",
  hb5.status === 200 && hb5.body.ok === true,
  JSON.stringify(hb5),
);

// ------------------------------------------- persistence hygiene -------
log("\n== Persistence hygiene — the exception path stores no image/name data ==");
const logCols = (
  await db.execute({ sql: "SELECT name FROM pragma_table_info('copilot_exception_log')", args: [] })
).rows.map((r) => String(r.name));
check(
  "LOG: exception log columns are count/state only (trigger, source, latency, action)",
  JSON.stringify(logCols) ===
    JSON.stringify(["id", "school_id", "ts", "trigger", "source", "latency_ms", "action"]),
  logCols.join(","),
);
const curCols = (
  await db.execute({ sql: "SELECT name FROM pragma_table_info('copilot_exception_current')", args: [] })
).rows.map((r) => String(r.name));
check(
  "LOG: no image/name/photo column in the current-exception table",
  !curCols.some((c) => /image|name|photo|blob|mask/i.test(c)),
  curCols.join(","),
);
const dbBytes = Buffer.from(await Bun.file(DB_PATH).arrayBuffer());
check(
  "HYGIENE: the injected name appears nowhere in the DB file",
  !dbBytes.includes(Buffer.from("Emma")),
);

// -------------------------------------- prefetch hardening (Oct 30) ----
log("\n== Prefetch hardening — speculative advise at CHECKING, served at the flag ==");
// The slimmed production shape (tags in queue_next), EX-01 geometry.
const PF_FLAG: any = {
  trigger: "zone_mismatch", school_mode: "dual",
  zone: { lane: "left", count: 5, expected: 4, consecutive_mismatches: 2 },
  wave: { id: "L1", lane: "left", size: 4, status: "loading" },
  queue_next: [
    { tag: "101", lane: "left", wave: "L1" },
    { tag: "102", lane: "left", wave: "L1" },
    { tag: "103", lane: "left", wave: "L1" },
    { tag: "104", lane: "left", wave: "L1" },
  ],
  holds: [],
};
const PF_STILL1: any = {
  ...PF_FLAG,
  zone: { ...PF_FLAG.zone, consecutive_mismatches: 1 },
};
const PF_REFERENCE =
  "Five cars in the zone but Wave L1 has four — hold the wave and check for an extra car before loading.";
function countingAdapter(inner: any) {
  const state = { calls: 0 };
  return {
    state,
    adapter: {
      kind: inner.kind,
      modelId: inner.modelId,
      async advise(p: any) {
        state.calls++;
        return inner.advise(p);
      },
    },
  };
}

// PF-A: context unchanged between stills → the prefetched line is served.
const aWrap = countingAdapter(new StubSparkAdapter());
const svcA = new ExceptionService(aWrap.adapter as any);
const logsBeforeA = await logCount();
await svcA.prefetchZoneMismatch(SCHOOL, PF_STILL1);
check(
  "PF-A: the speculative compute persists NOTHING (no log row at CHECKING)",
  (await logCount()) === logsBeforeA,
  `log ${logsBeforeA}→${await logCount()}`,
);
const recA = await svcA.advise(SCHOOL, PF_FLAG);
check(
  "PF-A: prefetched line served at the flag — adapter called ONCE (at CHECKING, not again)",
  aWrap.state.calls === 1,
  `calls=${aWrap.state.calls}`,
);
check(
  "PF-A: board-facing source stays spark and the line is the scripted mismatch line",
  recA.source === "spark" && recA.instruction === PF_REFERENCE,
  JSON.stringify(recA),
);
const logA = await lastLogRow();
check(
  "PF-A: audit log records the provenance as spark-prefetch",
  logA.source === "spark-prefetch" && logA.trigger === "zone_mismatch",
  JSON.stringify(logA),
);

// PF-B1: observed count changed between stills → cache discarded, fresh race.
const b1Wrap = countingAdapter(new StubSparkAdapter());
const svcB1 = new ExceptionService(b1Wrap.adapter as any);
await svcB1.prefetchZoneMismatch(SCHOOL, PF_STILL1);
const recB1 = await svcB1.advise(SCHOOL, {
  ...PF_FLAG,
  zone: { ...PF_FLAG.zone, count: 3 },
});
check(
  "PF-B1: count changed (5→3) → fresh race ran (adapter called at prefetch AND at the flag)",
  b1Wrap.state.calls === 2 && recB1.source === "spark",
  `calls=${b1Wrap.state.calls} source=${recB1.source}`,
);
const logB1 = await lastLogRow();
check(
  "PF-B1: audit log records a plain spark serve, not a prefetch",
  logB1.source === "spark",
  JSON.stringify(logB1),
);

// PF-B2: the wave's tags changed between stills → fresh race.
const b2Wrap = countingAdapter(new StubSparkAdapter());
const svcB2 = new ExceptionService(b2Wrap.adapter as any);
await svcB2.prefetchZoneMismatch(SCHOOL, PF_STILL1);
const recB2 = await svcB2.advise(SCHOOL, {
  ...PF_FLAG,
  queue_next: PF_FLAG.queue_next.slice(0, 3),
});
check(
  "PF-B2: tags changed (104 not in the flag payload) → fresh race ran",
  b2Wrap.state.calls === 2 && recB2.source === "spark",
  `calls=${b2Wrap.state.calls} source=${recB2.source}`,
);
const logB2 = await lastLogRow();
check("PF-B2: audit log records a plain spark serve", logB2.source === "spark", JSON.stringify(logB2));

// PF-C: the mismatch cleared (discard) → the flag runs a fresh race.
const cWrap = countingAdapter(new StubSparkAdapter());
const svcC = new ExceptionService(cWrap.adapter as any);
await svcC.prefetchZoneMismatch(SCHOOL, PF_STILL1);
svcC.discardPrefetch(SCHOOL, "left");
const recC = await svcC.advise(SCHOOL, PF_FLAG);
check(
  "PF-C: after discardPrefetch the flag runs the fresh race (no stale serve)",
  cWrap.state.calls === 2 && recC.source === "spark" && recC.instruction === PF_REFERENCE,
  `calls=${cWrap.state.calls}`,
);
const logC = await lastLogRow();
check("PF-C: audit log records a plain spark serve", logC.source === "spark", JSON.stringify(logC));

// PF-D: BOTH the speculative and the flag-time calls hang → the verbatim
// fallback still lands at the ~3s cap at flag time. A speculative
// fallback is never cached, so the flag always gets its own race.
const dWrap = countingAdapter(new StubSparkAdapter({ delayMs: 4000 }));
const svcD = new ExceptionService(dWrap.adapter as any);
const tPre = performance.now();
await svcD.prefetchZoneMismatch(SCHOOL, PF_STILL1);
const preElapsed = Math.round(performance.now() - tPre);
check(
  `PF-D: the hanging speculative call is capped, not waited out (elapsed ${preElapsed}ms)`,
  preElapsed >= 2800 && preElapsed < 3950,
  `elapsed=${preElapsed}ms`,
);
const tFlag = performance.now();
const recD = await svcD.advise(SCHOOL, PF_FLAG);
const flagElapsed = Math.round(performance.now() - tFlag);
check(
  "PF-D: fallback displayed at the cap at flag time, verbatim (both calls hung)",
  recD.source === "rule-fallback" &&
    recD.instruction === DRILL[0].fallback &&
    flagElapsed >= 2800 &&
    flagElapsed < 3950,
  `source=${recD.source} elapsed=${flagElapsed}ms line="${recD.instruction}"`,
);
check(
  "PF-D: both calls really happened (speculative + flag race)",
  dWrap.state.calls === 2,
  `calls=${dWrap.state.calls}`,
);
await Bun.sleep(1500);
const curD = await svcD.current(SCHOOL);
check(
  "PF-D: late Spark lines did NOT overwrite the fallback",
  curD?.instruction === DRILL[0].fallback && curD?.source === "rule-fallback",
  `current="${curD?.instruction}" source=${curD?.source}`,
);

// PF-E: through the actions function — mismatch at still 1, MATCH at
// still 2 (the episode clears) → no exception ever opens, nothing logs.
await resetAll("left");
await call("callWave", { id: "L1", lane: "left", tags: ["101", "102", "103", "104"] });
for (const tag of ["101", "102", "103", "104"]) {
  await call("enterTag", { tag, lane: "left", wave: "L1" });
}
const zmLogCount = async () =>
  Number(
    (
      await db.execute({
        sql: "SELECT COUNT(*) AS n FROM copilot_exception_log WHERE school_id = ? AND trigger = 'zone_mismatch'",
        args: [SCHOOL],
      })
    ).rows[0].n,
  );
const zmBefore = await zmLogCount();
const curBeforeE = (await call("getException")).current?.instruction ?? null;
const clr1 = await zc("left", "ST-06", 4);
const clr2 = await zc("left", "ST-05", 4);
check(
  "PF-E: still 1 CHECKING (prefetch arms silently), still 2 VERIFIED — no exception attached either time",
  clr1.status === "CHECKING" && !("exception" in clr1) && clr2.status === "VERIFIED" && !("exception" in clr2),
  `s1=${clr1.status} s2=${clr2.status}`,
);
check(
  "PF-E: the cleared episode logged no zone_mismatch line and left the current exception untouched",
  (await zmLogCount()) === zmBefore &&
    ((await call("getException")).current?.instruction ?? null) === curBeforeE,
  `zmLog ${zmBefore}→${await zmLogCount()}`,
);

// -------------------------------------------------------------- done ---
log(`\nEXCEPTION GATE: ${total - failures}/${total} PASS, ${failures} FAIL`);
log(failures === 0 ? "ALL EXCEPTION CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
mkdirSync(new URL("../test-results/", import.meta.url).pathname, { recursive: true });
writeFileSync(
  new URL("../test-results/exception-scenarios-2026-10-28.txt", import.meta.url).pathname,
  lines.join("\n") + "\n",
);
process.exit(failures === 0 ? 0 : 1);
