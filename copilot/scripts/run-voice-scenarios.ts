// Voice-entry acceptance runner — Wed Oct 28 gate for Build 3.
//
// Runs VC-01…VC-20 from test-assets/VOICE-CASES.md against the REAL
// actions function (in-process, stub Transcribe adapter). Utterances go
// through the stub's scripted clips where the case defines them, and
// through injected transcripts at the same boundary elsewhere (VC-13 /
// VC-15 are graded at resolver level with their target/degraded
// transcripts, per the case file's test-input note). After EVERY case
// the global auto-fail conditions are asserted: the board contains only
// spoken-and-in-set tags, no tag appears twice, no partial entry exists.
//
//   bun scripts/run-voice-scenarios.ts   (npm: test:voice)
//
// Uses a THROWAWAY local DB file (COPILOT_DB_URL is forced for this
// process) so runs are deterministic and never touch any shared state.

import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";

const DB_PATH = "/tmp/copilot-voice-gate.sqlite";
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
}
process.env.COPILOT_DB_URL = `file:${DB_PATH}`;
process.env.COPILOT_SAM_ADAPTER = "stub";
process.env.COPILOT_SPARK_ADAPTER = "stub";
process.env.COPILOT_TRANSCRIBE_ADAPTER = "stub";
delete process.env.COPILOT_SPARK_STUB_DELAY_MS;

const { getDb, ensureSchema } = await import("../src/db");
const db = getDb();
const actions: any = await import("../functions/actions");
const handler: (req: Request) => Promise<Response> = actions.default;

await ensureSchema();
await db.execute({
  sql: `INSERT OR IGNORE INTO copilot_schools (id, join_code, name, lane_mode, spots_per_wave, created_at)
        VALUES ('sch_staging_auburn', 'RT-KW4W4X', 'Auburn Elementary (Demo)', 'dual', 4, ?)`,
  args: [Date.now()],
});
const SCHOOL = "sch_staging_auburn";
const CODE = "RT-KW4W4X";
const SEED = ["212", "214", "221", "345", "354"]; // shared seed, queue order

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

// ------------------------------------------------------------ helpers ---
async function reset() {
  await call("resetBoard");
}
async function seedWave(tags: string[] = SEED) {
  await call("callWave", { id: "L1", lane: "left", tags });
}
async function ptt(language?: string): Promise<string> {
  const s = await call("startPtt", { lane: "left", ...(language ? { language } : {}) });
  return s.token as string;
}
async function say(
  token: string | null,
  args: { clipId?: string; transcript?: string; language?: string },
): Promise<any> {
  return call("voiceUtterance", { token, lane: "left", ...args });
}
async function boardEntries(): Promise<any[]> {
  const b = await call("getBoard");
  return b.entries as any[];
}
async function entryTags(): Promise<string[]> {
  return (await boardEntries()).map((e) => e.tag);
}
/** Entry tags in queue (spot) order — the board's spoken-order evidence. */
async function entryTagsBySpot(): Promise<string[]> {
  return (await boardEntries())
    .slice()
    .sort((a, b) => (a.spot ?? 99) - (b.spot ?? 99))
    .map((e) => e.tag);
}
async function voiceLog(): Promise<Array<{ lane: string; tag: string | null; outcome: string }>> {
  const rows = (
    await db.execute({
      sql: "SELECT lane, resolved_tag, outcome FROM copilot_voice_log WHERE school_id = ? ORDER BY id ASC",
      args: [SCHOOL],
    })
  ).rows;
  return rows.map((r) => ({
    lane: String(r.lane),
    tag: r.resolved_tag == null ? null : String(r.resolved_tag),
    outcome: String(r.outcome),
  }));
}
async function exceptionLogCount(): Promise<number> {
  const rows = (
    await db.execute({
      sql: "SELECT COUNT(*) AS n FROM copilot_exception_log WHERE school_id = ?",
      args: [SCHOOL],
    })
  ).rows;
  return Number(rows[0].n);
}
/**
 * The global auto-fail conditions, asserted after every case: every
 * board entry was spoken-and-in-set (the case's allowed set), and no
 * tag appears twice.
 */
async function clean(id: string, allowed: string[]) {
  const tags = await entryTags();
  check(
    `${id} auto-fail sweep: board holds only spoken-and-in-set tags`,
    tags.every((t) => allowed.includes(t)),
    `board=${JSON.stringify(tags)} allowed=${JSON.stringify(allowed)}`,
  );
  check(
    `${id} auto-fail sweep: no duplicate entries`,
    new Set(tags).size === tags.length,
    `board=${JSON.stringify(tags)}`,
  );
}

// ------------------------------------------------------------ health ---
log("== health ==");
const health = await call("health");
check("health answers ok", health.ok === true, JSON.stringify(health));
check(
  "health reports the stub Transcribe adapter + model",
  health.transcribeAdapter === "stub" &&
    typeof health.transcribeModel === "string" &&
    health.transcribeModel.length > 0,
  `transcribeAdapter=${health.transcribeAdapter} transcribeModel=${health.transcribeModel}`,
);

// ------------------------------------------------------------- VC-01 ---
log("\n== VC-01 — single clean tag ==");
await reset();
await seedWave();
{
  const t = await ptt();
  // HAMMING-1 UPDATE (Fri Oct 30, JR-approved guard widening): was
  // "outcome MATCHED" with a direct entry. 214's one-digit-off
  // neighbor 212 is live in the seed wave, so the widened read-back
  // guard now holds the clean read for a CONFIRM; YES enters the
  // heard tag. What the case grades is unchanged — the exact tag
  // lands exactly once, logged, read back — apart from the confirm
  // step and the `corrected` log outcome that comes with it.
  const r = await say(t, { clipId: "VC-01" });
  check(
    "VC-01: outcome CONFIRM (212 live, one digit off 214 — nothing enters silently)",
    r.outcome === "CONFIRM" && r.tag === "214" && r.enteredTag === null,
    JSON.stringify(r),
  );
  check(
    "VC-01: prompt names the heard tag and the one-digit-off neighbor",
    r.prompt === "I heard 214 — 212 is also queued in Left. Enter 214?" &&
      r.suggestedTag === "212",
    r.prompt,
  );
  check(
    "VC-01: transcribe was biased toward the live closed set",
    JSON.stringify(r.biasedTags) === JSON.stringify(SEED),
    JSON.stringify(r.biasedTags),
  );
  check(
    "VC-01: nothing entered while the CONFIRM is pending",
    (await entryTags()).length === 0,
    JSON.stringify(await entryTags()),
  );
  const yes = await call("voiceConfirm", { yes: true });
  check(
    "VC-01: YES enters 214, outcome corrected",
    yes.entered === "214" && yes.outcome === "corrected",
    JSON.stringify(yes),
  );
  check("VC-01: board holds exactly [214]", JSON.stringify(await entryTags()) === '["214"]');
  const vl = await voiceLog();
  check(
    "VC-01: voice log records (left, 214, corrected) only",
    vl.length === 1 && vl[0].tag === "214" && vl[0].outcome === "corrected" && vl[0].lane === "left",
    JSON.stringify(vl),
  );
  const st = await call("getVoiceState");
  check("VC-01: read-back shows 214", st.lastTag === "214", JSON.stringify(st));
  await call("endPtt", { token: t });
}
await clean("VC-01", ["214"]);

// ------------------------------------------------------------- VC-02 ---
log("\n== VC-02 — clean sequence of four (both confusion-pair members) ==");
await reset();
await seedWave();
{
  const t = await ptt();
  // FIX-1 UPDATE (Fri Oct 30, 100× battery): was "MATCHED ×4, zero
  // CONFIRM prompts". Every tag in this sequence has its transposition
  // twin live in the wave, so the widened rule now holds each one for
  // a read-back CONFIRM; YES enters the heard tag and the sequence
  // still lands all four, in order, one each. Geometry-only change —
  // the case's intent (a clean pair-member sequence enters cleanly)
  // is preserved through the confirm step.
  const outcomes: string[] = [];
  const confirmed: Array<string | null> = [];
  for (const clip of ["VC-02-1", "VC-02-2", "VC-02-3", "VC-02-4"]) {
    outcomes.push((await say(t, { clipId: clip })).outcome);
    confirmed.push((await call("voiceConfirm", { yes: true })).entered);
  }
  check(
    "VC-02: CONFIRM ×4 (twin-guarded, Fix 1), zero silent entries",
    JSON.stringify(outcomes) === '["CONFIRM","CONFIRM","CONFIRM","CONFIRM"]',
    JSON.stringify(outcomes),
  );
  check(
    "VC-02: each YES enters the heard tag (212, 221, 345, 354)",
    JSON.stringify(confirmed) === '["212","221","345","354"]',
    JSON.stringify(confirmed),
  );
  check(
    "VC-02: board shows 212, 221, 345, 354 in spoken order, one each",
    JSON.stringify(await entryTagsBySpot()) === '["212","221","345","354"]',
    JSON.stringify(await entryTagsBySpot()),
  );
  await call("endPtt", { token: t });
}
await clean("VC-02", ["212", "221", "345", "354"]);

// ------------------------------------------------------------- VC-03 ---
log("\n== VC-03 — lane callout is routing, not digits ==");
await reset();
await seedWave();
{
  const t = await ptt();
  // HAMMING-1 UPDATE (Fri Oct 30): was MATCHED. 214 now lands through
  // the read-back CONFIRM (212 live, one digit off). The case still
  // grades the callout itself: routing put the entry in Left and no
  // phantom tag came out of the word "left".
  const r = await say(t, { clipId: "VC-03" });
  check(
    "VC-03: outcome CONFIRM on 214 (lane callout routed; neighbor guard held the entry)",
    r.outcome === "CONFIRM" && r.tag === "214" && r.enteredTag === null,
    JSON.stringify(r),
  );
  const yes = await call("voiceConfirm", { yes: true });
  check("VC-03: YES enters 214", yes.entered === "214", JSON.stringify(yes));
  const entries = await boardEntries();
  check(
    "VC-03: 214 lands in Left exactly once, no phantom tag from 'left'",
    entries.length === 1 && entries[0].tag === "214" && entries[0].lane === "left",
    JSON.stringify(entries),
  );
  await call("endPtt", { token: t });
}
await clean("VC-03", ["214"]);

// ------------------------------------------------------------- VC-04 ---
log("\n== VC-04 — grouped and digit-by-digit normalize identically ==");
await reset();
await seedWave();
{
  const t = await ptt();
  // FIX-1 UPDATE (Fri Oct 30, 100× battery): both utterances were
  // MATCHED; each tag's twin is live in the seed wave, so each now
  // resolves through the read-back CONFIRM and YES enters the heard
  // tag. Normalization is still what is graded — the resolved `tag`
  // on each CONFIRM must be the correctly normalized digits.
  const r1 = await say(t, { clipId: "VC-04-1" });
  check(
    "VC-04: 'three forty-five' → CONFIRM on 345 (grouped form normalized)",
    r1.outcome === "CONFIRM" && r1.tag === "345" && r1.enteredTag === null,
    JSON.stringify(r1),
  );
  const y1 = await call("voiceConfirm", { yes: true });
  check("VC-04: YES enters 345", y1.entered === "345", JSON.stringify(y1));
  const r2 = await say(t, { clipId: "VC-04-2" });
  check(
    "VC-04: 'three five four' → CONFIRM on 354 (digit-by-digit, same digits)",
    r2.outcome === "CONFIRM" && r2.tag === "354" && r2.enteredTag === null,
    JSON.stringify(r2),
  );
  const y2 = await call("voiceConfirm", { yes: true });
  check("VC-04: YES enters 354", y2.entered === "354", JSON.stringify(y2));
  await call("endPtt", { token: t });
}
await clean("VC-04", ["345", "354"]);

// ------------------------------------------------------------- VC-05 ---
log("\n== VC-05 — 345 heard again with 354 live: CONFIRM, both branches ==");
await reset();
await seedWave();
await call("enterTag", { tag: "345", lane: "left", wave: "L1" });
{
  const t = await ptt();
  const r = await say(t, { clipId: "VC-05" });
  check("VC-05: outcome CONFIRM", r.outcome === "CONFIRM", JSON.stringify(r));
  check(
    "VC-05: prompt is the scripted question, naming both tags",
    r.prompt === "345 is already queued in Left — did you mean 354?",
    r.prompt,
  );
  check(
    "VC-05: NOTHING entered while the CONFIRM is pending",
    JSON.stringify(await entryTags()) === '["345"]',
    JSON.stringify(await entryTags()),
  );
  const st = await call("getVoiceState");
  check(
    "VC-05: pending pair held server-side (345 → 354)",
    st.pending?.tag === "345" && st.pending?.suggestedTag === "354",
    JSON.stringify(st.pending),
  );
  const yes = await call("voiceConfirm", { yes: true });
  check(
    "VC-05 YES: 354 entered, outcome corrected",
    yes.entered === "354" && yes.outcome === "corrected",
    JSON.stringify(yes),
  );
  check(
    "VC-05 YES: board holds 345 and 354, one each (no duplicate 345)",
    JSON.stringify((await entryTags()).sort()) === '["345","354"]',
    JSON.stringify(await entryTags()),
  );
  const vl = await voiceLog();
  check(
    "VC-05 YES: voice log records the correction (354, corrected)",
    vl.some((v) => v.tag === "354" && v.outcome === "corrected"),
    JSON.stringify(vl),
  );
  await call("endPtt", { token: t });
}
await clean("VC-05", ["345", "354"]);
// NO branch, fresh seed:
await reset();
await seedWave();
await call("enterTag", { tag: "345", lane: "left", wave: "L1" });
{
  const t = await ptt();
  const r = await say(t, { clipId: "VC-05" });
  check("VC-05 NO-branch: outcome CONFIRM again", r.outcome === "CONFIRM", JSON.stringify(r));
  const no = await call("voiceConfirm", { yes: false });
  check(
    "VC-05 NO: nothing entered, pending cleared",
    no.entered === null && (await call("getVoiceState")).pending === null,
    JSON.stringify(no),
  );
  check(
    "VC-05 NO: 345 still single on the board",
    JSON.stringify(await entryTags()) === '["345"]',
    JSON.stringify(await entryTags()),
  );
  await call("endPtt", { token: t });
}
await clean("VC-05 NO", ["345"]);

// ------------------------------------------------------------- VC-06 ---
log("\n== VC-06 — planted in-set error: known limit, graded on read-back + Undo ==");
await reset();
await seedWave();
{
  const t = await ptt();
  // FIX-1 UPDATE (Fri Oct 30, 100× battery): the entries below were
  // MATCHED; 212 has live confusable tags in the seed wave, so each is
  // now held for the read-back CONFIRM and enters on YES. (Since the
  // Hamming-1 widening later the same day, the prompt names 214 — the
  // confusable tag earliest in queue order — rather than the
  // transposition twin 221; YES still enters the heard tag.) The
  // case's grading net is unchanged — read-back shows what entered,
  // and Undo still leaves zero residue (a re-say after Undo is a
  // fresh CONFIRM, never a DUPLICATE).
  const r = await say(t, { clipId: "VC-06" });
  check(
    "VC-06: the clean in-set transcript is held for read-back (212, CONFIRM — confusable tags live)",
    r.outcome === "CONFIRM" && r.tag === "212" && r.enteredTag === null,
    JSON.stringify(r),
  );
  const y0 = await call("voiceConfirm", { yes: true });
  check("VC-06: YES enters 212 as spoken", y0.entered === "212", JSON.stringify(y0));
  const st = await call("getVoiceState");
  check("VC-06: read-back prominently shows 212", st.lastTag === "212", JSON.stringify(st));
  const undo = await call("voiceUndo");
  check("VC-06: one-tap Undo removes 212", undo.removedTag === "212", JSON.stringify(undo));
  check(
    "VC-06: board is empty after Undo (no residue)",
    (await entryTags()).length === 0,
    JSON.stringify(await entryTags()),
  );
  const again = await say(t, { transcript: "two twelve" });
  check(
    "VC-06: 212 can be entered again cleanly (CONFIRM, not DUPLICATE — Undo left nothing behind)",
    again.outcome === "CONFIRM" && again.tag === "212",
    JSON.stringify(again),
  );
  const y1 = await call("voiceConfirm", { yes: true });
  check("VC-06: YES enters 212 again", y1.entered === "212", JSON.stringify(y1));
  await call("voiceUndo");
  const intended = await say(t, { transcript: "two twenty-one" });
  check(
    "VC-06: the intended 221 then enters (CONFIRM — twin 212 live — YES enters it)",
    intended.outcome === "CONFIRM" &&
      (await call("voiceConfirm", { yes: true })).entered === "221",
    JSON.stringify(intended),
  );
  await call("endPtt", { token: t });
}
await clean("VC-06", ["221"]);

// ------------------------------------------------------------- VC-07 ---
log("\n== VC-07 — 399 is not in the set: ASK-REPEAT, never a silent 359 ==");
await reset();
await seedWave(["212", "359", "401"]);
{
  const t = await ptt();
  const r1 = await say(t, { clipId: "VC-07-1" });
  check("VC-07: outcome ASK-REPEAT", r1.outcome === "ASK-REPEAT", JSON.stringify(r1));
  check(
    "VC-07: nothing entered on the mishear (no silent correction to 359)",
    (await entryTags()).length === 0,
    JSON.stringify(await entryTags()),
  );
  const r2 = await say(t, { clipId: "VC-07-2" });
  check(
    "VC-07: the clean repeat MATCHES 359, entered once",
    r2.outcome === "MATCHED" && r2.enteredTag === "359",
    JSON.stringify(r2),
  );
  await call("endPtt", { token: t });
}
await clean("VC-07", ["359"]);

// ------------------------------------------------------------- VC-08 ---
log("\n== VC-08 — homophone noise: 'for oh one' → 401, no phantom tag ==");
await reset();
await seedWave([...SEED, "401"]);
{
  const t = await ptt();
  const r = await say(t, { clipId: "VC-08" });
  check(
    "VC-08: outcome MATCHED 401 (no ASK-REPEAT, no phantom tag)",
    r.outcome === "MATCHED" && r.enteredTag === "401",
    JSON.stringify(r),
  );
  const r2 = await say(t, { transcript: "tag for 01" });
  check(
    "VC-08 variant 'tag for 01': resolves to the same 401 (DUPLICATE, still one entry)",
    r2.outcome === "DUPLICATE",
    JSON.stringify(r2),
  );
  check(
    "VC-08: board holds exactly one entry, 401",
    JSON.stringify(await entryTags()) === '["401"]',
    JSON.stringify(await entryTags()),
  );
  await call("endPtt", { token: t });
}
await clean("VC-08", ["401"]);

// ------------------------------------------------------------- VC-09 ---
log("\n== VC-09 — duplicate spoken after VOICE entry ==");
await reset();
await seedWave();
{
  const t = await ptt();
  const first = await say(t, { transcript: "two fourteen" });
  // HAMMING-1 UPDATE (Fri Oct 30): the setup entry itself now comes
  // through the read-back CONFIRM (212 live, one digit off 214); YES
  // enters it. The graded duplicate below is untouched.
  check(
    "VC-09 setup: 214 held for read-back CONFIRM (212 live, one digit off)",
    first.outcome === "CONFIRM" && first.tag === "214",
    JSON.stringify(first),
  );
  const firstYes = await call("voiceConfirm", { yes: true });
  check(
    "VC-09 setup: YES enters 214 by voice",
    firstYes.entered === "214" && firstYes.outcome === "corrected",
    JSON.stringify(firstYes),
  );
  const before = (await boardEntries()).find((e) => e.tag === "214");
  const r = await say(t, { clipId: "VC-09" });
  check("VC-09: outcome DUPLICATE", r.outcome === "DUPLICATE", JSON.stringify(r));
  check(
    "VC-09: EX-04 fires through the voice path (behavior consistent with typed duplicates)",
    r.exception?.trigger === "duplicate" && r.exception?.action === "info",
    JSON.stringify(r.exception),
  );
  const entries = (await boardEntries()).filter((e) => e.tag === "214");
  check(
    "VC-09: exactly one 214; original entry untouched (spot/status), attempt counted",
    entries.length === 1 &&
      entries[0].spot === before.spot &&
      entries[0].status === before.status &&
      entries[0].attempts === 2,
    JSON.stringify(entries),
  );
  await call("endPtt", { token: t });
}
await clean("VC-09", ["214"]);

// ------------------------------------------------------------ VC-10 ---
log("\n== VC-10 — duplicate spoken after TYPED entry ==");
await reset();
await seedWave();
await call("enterTag", { tag: "221", lane: "left", wave: "L1" });
{
  const t = await ptt();
  const r = await say(t, { clipId: "VC-10" });
  check(
    "VC-10: outcome DUPLICATE (board state decides, not voice history; the passed twin 212 is no CONFIRM)",
    r.outcome === "DUPLICATE",
    JSON.stringify(r),
  );
  check(
    "VC-10: EX-04 fires, exactly one 221, spot unchanged",
    r.exception?.trigger === "duplicate" &&
      (await entryTags()).filter((x) => x === "221").length === 1 &&
      (await boardEntries()).find((e) => e.tag === "221")?.spot === 3,
    JSON.stringify(r.exception),
  );
  await call("endPtt", { token: t });
}
await clean("VC-10", ["221"]);

// ------------------------------------------------------------ VC-11 ---
log("\n== VC-11 — foreign tag 999: ASK-REPEAT every time, then type-it direction ==");
await reset();
await seedWave();
{
  const t = await ptt();
  const r1 = await say(t, { clipId: "VC-11" });
  const r2 = await say(t, { clipId: "VC-11" });
  const r3 = await say(t, { clipId: "VC-11" });
  check(
    "VC-11: ASK-REPEAT shown each time",
    [r1, r2, r3].every((r) => r.outcome === "ASK-REPEAT"),
    JSON.stringify([r1.outcome, r2.outcome, r3.outcome]),
  );
  check(
    "VC-11: after two failed repeats the walker is directed to type it / check with the office",
    r3.needsTyping === true && /type the tag or check with the office/.test(r3.message),
    r3.message,
  );
  check(
    "VC-11: zero entries across all repeats; no in-set substitute suggested",
    (await entryTags()).length === 0 && r3.suggestedTag === undefined,
    JSON.stringify(await entryTags()),
  );
  const vl = await voiceLog();
  check(
    "VC-11: each failure logged as (repeat, no tag)",
    vl.length === 3 && vl.every((v) => v.outcome === "repeat" && v.tag === null),
    JSON.stringify(vl),
  );
  await call("endPtt", { token: t });
}
await clean("VC-11", []);

// ------------------------------------------------------------ VC-12 ---
log("\n== VC-12 — 347 near the pair but not equal: no auto-correction ==");
await reset();
await seedWave();
{
  const t = await ptt();
  const r1 = await say(t, { clipId: "VC-12-1" });
  check("VC-12: outcome ASK-REPEAT", r1.outcome === "ASK-REPEAT", JSON.stringify(r1));
  check(
    "VC-12: nothing entered (347 was NOT corrected into 345 or 354)",
    (await entryTags()).length === 0,
    JSON.stringify(await entryTags()),
  );
  const r2 = await say(t, { clipId: "VC-12-2" });
  // FIX-1 UPDATE (Fri Oct 30, 100× battery): was "345 MATCHES
  // normally". 345's twin 354 is live in the seed wave, so the clean
  // repeat now enters through the read-back CONFIRM. What the case
  // grades is unchanged: 347 was never corrected into anything, and
  // the clean 345 is what lands.
  check(
    "VC-12: on repeat with transcript 345, CONFIRM (twin live), YES enters 345",
    r2.outcome === "CONFIRM" &&
      (await call("voiceConfirm", { yes: true })).entered === "345",
    JSON.stringify(r2),
  );
  await call("endPtt", { token: t });
}
await clean("VC-12", ["345"]);

// ------------------------------------------------------------ VC-13 ---
log("\n== VC-13 — playground noise, clean read (resolver level) ==");
await reset();
await seedWave();
{
  const t = await ptt();
  const r = await say(t, { clipId: "VC-13" });
  // FIX-1 UPDATE (Fri Oct 30, 100× battery): was MATCHED 212. 212 has
  // live confusable tags in the seed wave, so the clean read now lands
  // on the read-back CONFIRM — still the only non-ASK-REPEAT outcome,
  // which is what this case grades (noise must not degrade a clean
  // read into a repeat request). YES enters 212. (Since the Hamming-1
  // widening, the prompt names 214, the earliest confusable tag in
  // queue order; the case does not grade which neighbor is named.)
  check(
    "VC-13: target transcript → CONFIRM on 212 (twin guard, not a noise ASK-REPEAT), YES enters it",
    r.outcome === "CONFIRM" && r.tag === "212" &&
      (await call("voiceConfirm", { yes: true })).entered === "212",
    JSON.stringify(r),
  );
  await call("endPtt", { token: t });
}
await clean("VC-13", ["212"]);

// ------------------------------------------------------------ VC-14 ---
log("\n== VC-14 — ambient numbers, NO push-to-talk: nothing happens at all ==");
await reset();
await seedWave();
{
  const noToken = await say(null, { clipId: "VC-14" });
  check(
    "VC-14: utterance with no PTT session is refused at the gate",
    typeof noToken.error === "string" && noToken.error.startsWith("ptt_required"),
    JSON.stringify(noToken),
  );
  const bogus = await say("ambient-not-a-session", { clipId: "VC-14" });
  check(
    "VC-14: a non-session token is refused the same way",
    typeof bogus.error === "string" && bogus.error.startsWith("ptt_required"),
    JSON.stringify(bogus),
  );
  // An ended session is equally dead:
  const t = await ptt();
  await call("endPtt", { token: t });
  const ended = await say(t, { clipId: "VC-14" });
  check(
    "VC-14: an ended PTT session takes no input",
    typeof ended.error === "string" && ended.error.startsWith("ptt_required"),
    JSON.stringify(ended),
  );
  check("VC-14: zero entries", (await entryTags()).length === 0);
  check(
    "VC-14: zero resolver events (voice log empty) and zero exception calls",
    (await voiceLog()).length === 0 && (await exceptionLogCount()) === 0,
    `voiceLog=${(await voiceLog()).length} exceptionLog=${await exceptionLogCount()}`,
  );
  const st = await call("getVoiceState");
  check(
    "VC-14: no voice state was created by ambient audio",
    st.pending === null && st.lastTag === null,
    JSON.stringify(st),
  );
}
await clean("VC-14", []);

// ------------------------------------------------------------ VC-15 ---
log("\n== VC-15 — wind-degraded partial '3 4': ASK-REPEAT, no auto-completion ==");
await reset();
await seedWave();
{
  const t = await ptt();
  const r1 = await say(t, { clipId: "VC-15-1" });
  check("VC-15: degraded transcript → ASK-REPEAT", r1.outcome === "ASK-REPEAT", JSON.stringify(r1));
  check(
    "VC-15: no partial entry (the partial was NOT completed into 354 or 345)",
    (await entryTags()).length === 0,
    JSON.stringify(await entryTags()),
  );
  const r2 = await say(t, { clipId: "VC-15-2" });
  // FIX-1 UPDATE (Fri Oct 30, 100× battery): was "clean repeat MATCHES
  // 354". 354's twin 345 is live in the seed wave, so the clean repeat
  // now enters through the read-back CONFIRM; the partial before it
  // still completed into nothing.
  check(
    "VC-15: clean repeat → CONFIRM (twin live), YES enters 354",
    r2.outcome === "CONFIRM" &&
      (await call("voiceConfirm", { yes: true })).entered === "354",
    JSON.stringify(r2),
  );
  await call("endPtt", { token: t });
}
await clean("VC-15", ["354"]);

// ------------------------------------------------------------ VC-16 ---
log("\n== VC-16 — clipped utterance 'two twen': a fragment is not a tag ==");
await reset();
await seedWave();
{
  const t = await ptt();
  const r1 = await say(t, { clipId: "VC-16" });
  check("VC-16: outcome ASK-REPEAT", r1.outcome === "ASK-REPEAT", JSON.stringify(r1));
  const r2 = await say(t, { transcript: "22" });
  check(
    "VC-16: the two-digit fragment '22' also resolves to NOTHING (not padded to 212/221)",
    r2.outcome === "ASK-REPEAT" && (await entryTags()).length === 0,
    JSON.stringify(r2),
  );
  await call("endPtt", { token: t });
}
await clean("VC-16", []);

// ------------------------------------------------------------ VC-17 ---
log("\n== VC-17 — clean Spanish tag, Spanish prompts ==");
await reset();
await seedWave();
{
  const t = await ptt("es");
  const r = await say(t, { clipId: "VC-17" });
  // HAMMING-1 UPDATE (Fri Oct 30): was "MATCHED 214". 212 is live in
  // the seed wave one digit off 214, so the clean Spanish read now
  // lands on the read-back CONFIRM — in Spanish, which is what this
  // case grades (prompts follow the app language). YES enters 214.
  check(
    "VC-17: 'doscientos catorce' → CONFIRM on 214 (212 live, one digit off)",
    r.outcome === "CONFIRM" && r.tag === "214" && r.enteredTag === null,
    JSON.stringify(r),
  );
  check(
    "VC-17: the read-back prompt is the scripted Spanish question (app language)",
    r.prompt === "Escuché 214 — 212 también está en la fila de la izquierda. ¿Registrar 214?" &&
      r.promptLanguage === "es",
    r.prompt,
  );
  const yes = await call("voiceConfirm", { yes: true, language: "es" });
  check(
    "VC-17: YES enters 214, outcome corrected",
    yes.entered === "214" && yes.outcome === "corrected",
    JSON.stringify(yes),
  );
  await call("endPtt", { token: t });
}
await clean("VC-17", ["214"]);

// ------------------------------------------------------------ VC-18 ---
log("\n== VC-18 — clean Spanish sequence, incl. both pair members ==");
await reset();
await seedWave();
{
  const t = await ptt("es");
  // FIX-1 UPDATE (Fri Oct 30, 100× battery): was "MATCHED ×3, zero
  // false CONFIRM prompts". Both pair members are in this sequence,
  // so under the widened rule the CONFIRMs are the twin guard working
  // as designed (in Spanish), not false prompts; each YES enters the
  // heard tag and the sequence still lands in order, one each.
  const outcomes: string[] = [];
  for (const clip of ["VC-18-1", "VC-18-2", "VC-18-3"]) {
    outcomes.push((await say(t, { clipId: clip })).outcome);
    await call("voiceConfirm", { yes: true, language: "es" });
  }
  check(
    "VC-18: CONFIRM ×3 (twin-guarded, Fix 1), zero ASK-REPEATs",
    JSON.stringify(outcomes) === '["CONFIRM","CONFIRM","CONFIRM"]',
    JSON.stringify(outcomes),
  );
  check(
    "VC-18: 212, 345, 354 entered in order, one each ('cuarenta y cinco' ≠ 'cincuenta y cuatro')",
    JSON.stringify(await entryTagsBySpot()) === '["212","345","354"]',
    JSON.stringify(await entryTagsBySpot()),
  );
  await call("endPtt", { token: t });
}
await clean("VC-18", ["212", "345", "354"]);

// ------------------------------------------------------------ VC-19 ---
log("\n== VC-19 — Spanish mishear on the standing pair: CONFIRM in Spanish ==");
await reset();
await seedWave();
await call("enterTag", { tag: "345", lane: "left", wave: "L1" });
{
  const t = await ptt("es");
  const r = await say(t, { clipId: "VC-19" });
  check("VC-19: outcome CONFIRM", r.outcome === "CONFIRM", JSON.stringify(r));
  check(
    "VC-19: prompt is the scripted Spanish question",
    r.prompt === "345 ya está en la fila de la izquierda — ¿quiso decir 354?",
    r.prompt,
  );
  check(
    "VC-19: nothing entered before the walker's YES",
    JSON.stringify(await entryTags()) === '["345"]',
    JSON.stringify(await entryTags()),
  );
  const yes = await call("voiceConfirm", { yes: true, language: "es" });
  check(
    "VC-19 YES: 354 entered, outcome corrected",
    yes.entered === "354" && yes.outcome === "corrected",
    JSON.stringify(yes),
  );
  check(
    "VC-19: no duplicate 345; board holds the pair once each",
    JSON.stringify((await entryTags()).sort()) === '["345","354"]',
    JSON.stringify(await entryTags()),
  );
  await call("endPtt", { token: t });
}
await clean("VC-19", ["345", "354"]);

// ------------------------------------------------------------ VC-20 ---
log("\n== VC-20 — code-switching walker: language is per-utterance ==");
await reset();
await seedWave();
{
  const t = await ptt();
  // FIX-1 UPDATE (Fri Oct 30, 100× battery): the three entries were
  // MATCHED; every tag here has its twin live in the seed wave, so
  // each now enters through the read-back CONFIRM (YES after each).
  // The case's grading is untouched: per-utterance language detection
  // across the switch (read off the utterance results) and the final
  // board order.
  const r1 = await say(t, { clipId: "VC-20-1" });
  await call("voiceConfirm", { yes: true });
  const r2 = await say(t, { clipId: "VC-20-2" });
  await call("voiceConfirm", { yes: true });
  const r3 = await say(t, { clipId: "VC-20-3" });
  await call("voiceConfirm", { yes: true });
  check(
    "VC-20: CONFIRM ×3 across the switch (no ASK-REPEAT caused by language)",
    [r1, r2, r3].every((r) => r.outcome === "CONFIRM"),
    JSON.stringify([r1.outcome, r2.outcome, r3.outcome]),
  );
  check(
    "VC-20: the Spanish utterance was detected as Spanish mid-session, state not reset",
    r1.language === "en" && r2.language === "es" && r3.language === "en",
    JSON.stringify([r1.language, r2.language, r3.language]),
  );
  check(
    "VC-20: 212, 221, 345 entered in order, one each",
    JSON.stringify(await entryTagsBySpot()) === '["212","221","345"]',
    JSON.stringify(await entryTagsBySpot()),
  );
  await call("endPtt", { token: t });
}
await clean("VC-20", ["212", "221", "345"]);

// ---------------------------------------------------------- FIX-100 ---
// Fri Oct 30, 100× battery fixes (SCORECARD-100.md). Three new cases:
// (a) the widened twin CONFIRM in read-back geometry, (b) the "walker"
// call-sign, (c) wave-id validation at creation.
log("\n== FIX100-A — twin BEHIND the said tag: CONFIRM, YES enters the SAID tag ==");
await reset();
await seedWave(["345", "354"]);
{
  const t = await ptt();
  const r = await say(t, { transcript: "three four five" });
  check(
    "FIX100-A: outcome CONFIRM (twin 354 live behind 345 — no silent entry)",
    r.outcome === "CONFIRM" && r.tag === "345" && r.enteredTag === null,
    JSON.stringify(r),
  );
  check(
    "FIX100-A: prompt is the read-back, naming both tags",
    r.prompt === "I heard 345 — 354 is also queued in Left. Enter 345?" &&
      r.suggestedTag === "354",
    r.prompt,
  );
  check(
    "FIX100-A: NOTHING entered while the CONFIRM is pending",
    (await entryTags()).length === 0,
    JSON.stringify(await entryTags()),
  );
  const st = await call("getVoiceState");
  check(
    "FIX100-A: pending pair held server-side (345, twin 354, read-back prompt)",
    st.pending?.tag === "345" && st.pending?.suggestedTag === "354" &&
      st.pending?.prompt === "I heard 345 — 354 is also queued in Left. Enter 345?",
    JSON.stringify(st.pending),
  );
  const yes = await call("voiceConfirm", { yes: true });
  check(
    "FIX100-A YES: the SAID tag 345 enters (not the twin)",
    yes.entered === "345" && yes.outcome === "corrected",
    JSON.stringify(yes),
  );
  check(
    "FIX100-A: board holds exactly [345]",
    JSON.stringify(await entryTags()) === '["345"]',
    JSON.stringify(await entryTags()),
  );
  await call("endPtt", { token: t });
}
await clean("FIX100-A", ["345"]);

log("\n== FIX100-A2 — the battery defect geometry: [354, 345], mishear resolves 345 ==");
await reset();
await seedWave(["354", "345"]);
{
  const t = await ptt();
  // The walker said 354 (the head of the wave); the ASR flip the
  // battery measured returns "345". Before Fix 1 this entered 345
  // silently. Now it must stop at the read-back, and a NO leaves the
  // board untouched.
  const r = await say(t, { transcript: "three four five" });
  check(
    "FIX100-A2: outcome CONFIRM — the mishear no longer enters silently",
    r.outcome === "CONFIRM" && r.enteredTag === null,
    JSON.stringify(r),
  );
  check(
    "FIX100-A2: nothing entered while pending",
    (await entryTags()).length === 0,
    JSON.stringify(await entryTags()),
  );
  const no = await call("voiceConfirm", { yes: false });
  check(
    "FIX100-A2 NO: nothing entered, pending cleared (walker re-says instead)",
    no.entered === null && (await call("getVoiceState")).pending === null &&
      (await entryTags()).length === 0,
    JSON.stringify(no),
  );
  await call("endPtt", { token: t });
}
await clean("FIX100-A2", []);

log("\n== FIX100-B — 'Walker 345.' resolves (role call-sign stripped) ==");
await reset();
await seedWave(["214", "345", "401"]);
{
  const t = await ptt();
  const r = await say(t, { transcript: "Walker 345." });
  check(
    "FIX100-B: outcome MATCHED 345 (the battery's verbatim live transcript)",
    r.outcome === "MATCHED" && r.enteredTag === "345",
    JSON.stringify(r),
  );
  check(
    "FIX100-B: board holds exactly [345]",
    JSON.stringify(await entryTags()) === '["345"]',
    JSON.stringify(await entryTags()),
  );
  await call("endPtt", { token: t });
}
await clean("FIX100-B", ["345"]);

log("\n== FIX100-C — callWave validates the wave id at creation ==");
await reset();
{
  const bad = await call("callWave", { id: "WD", lane: "left", tags: ["101"] });
  check(
    "FIX100-C: id 'WD' is refused at creation (wave_id_invalid, not a later 422 at advise time)",
    typeof bad.error === "string" && bad.error.startsWith("wave_id_invalid"),
    JSON.stringify(bad),
  );
  const good = await call("callWave", { id: "L1", lane: "left", tags: ["101"] });
  check(
    "FIX100-C: id 'L1' is accepted (product convention)",
    good.ok === true && good.wave?.id === "L1",
    JSON.stringify(good),
  );
  await reset();
}
await clean("FIX100-C", []);

// ---------------------------------------------------------- HAMMING ---
// Fri Oct 30, JR-approved guard widening: the read-back CONFIRM now
// also fires for a one-digit-off (Hamming-1) tag live in the wave —
// the hostile battery's hurried-101→102 substitution geometry.
log("\n== HAM-1 — one-digit-off neighbors live: CONFIRM names the earliest in queue ==");
await reset();
await seedWave(["101", "102", "103", "104"]);
{
  const t = await ptt();
  const r = await say(t, { transcript: "one zero one" });
  check(
    "HAM-1: outcome CONFIRM (102/103/104 are each one digit off 101 and live)",
    r.outcome === "CONFIRM" && r.tag === "101" && r.enteredTag === null,
    JSON.stringify(r),
  );
  check(
    "HAM-1: prompt names the heard tag and the EARLIEST near neighbor (102)",
    r.prompt === "I heard 101 — 102 is also queued in Left. Enter 101?" &&
      r.suggestedTag === "102",
    r.prompt,
  );
  check(
    "HAM-1: nothing entered while the CONFIRM is pending",
    (await entryTags()).length === 0,
    JSON.stringify(await entryTags()),
  );
  const yes = await call("voiceConfirm", { yes: true });
  check(
    "HAM-1 YES: the HEARD tag 101 enters, outcome corrected",
    yes.entered === "101" && yes.outcome === "corrected",
    JSON.stringify(yes),
  );
  await call("endPtt", { token: t });
}
await clean("HAM-1", ["101"]);

log("\n== HAM-2 — no confusable tag live: MATCHED unchanged ==");
await reset();
await seedWave(["214", "359", "401"]);
{
  const t = await ptt();
  const r = await say(t, { transcript: "four oh one" });
  check(
    "HAM-2: outcome MATCHED 401 (no transposition twin, no one-digit-off tag live)",
    r.outcome === "MATCHED" && r.enteredTag === "401",
    JSON.stringify(r),
  );
  check(
    "HAM-2: board holds exactly [401]",
    JSON.stringify(await entryTags()) === '["401"]',
    JSON.stringify(await entryTags()),
  );
  await call("endPtt", { token: t });
}
await clean("HAM-2", ["401"]);

log("\n== HAM-3 — exact duplicate still beats the near-match guard ==");
await reset();
await seedWave(["101", "102", "103", "104"]);
await call("enterTag", { tag: "101", lane: "left", wave: "L1" });
{
  const t = await ptt();
  // Duplicate detection fires FIRST and is unchanged: a re-say of an
  // already-entered tag is a DUPLICATE even with one-digit-off tags
  // queued ahead of it. (The suggest CONFIRM still keys on a forward
  // TRANSPOSITION twin only — 102 is not 101's twin — so nothing here
  // asks "did you mean 102?".)
  const r = await say(t, { transcript: "one zero one" });
  check(
    "HAM-3: outcome DUPLICATE, no CONFIRM, despite 102/103/104 live",
    r.outcome === "DUPLICATE",
    JSON.stringify(r),
  );
  check(
    "HAM-3: EX-04 fires; exactly one 101 on the board",
    r.exception?.trigger === "duplicate" &&
      (await entryTags()).filter((x) => x === "101").length === 1,
    JSON.stringify(r.exception),
  );
  await call("endPtt", { token: t });
}
await clean("HAM-3", ["101"]);

// ------------------------------------------------------------- HOLD -----
// Fri Oct 30 safety hardening: HOLD is a hard block at entry. A voice
// utterance resolving to a held tag enters NOTHING and says so.
log("\n== HOLD-V1 — voice entry of a HELD tag: HELD outcome, nothing entered ==");
await reset();
await seedWave(["345", "401", "214"]);
await call("placeHold", { tag: "345" });
{
  const t = await ptt();
  const r = await say(t, { transcript: "three forty-five" });
  check(
    "HOLD-V1: outcome HELD — distinct from matched/corrected/duplicate",
    r.outcome === "HELD" && r.tag === "345" && r.enteredTag === null,
    JSON.stringify(r),
  );
  check(
    "HOLD-V1: the walker message says plainly the tag is on HOLD and was not entered",
    r.message === "345 is on HOLD — it was not entered. The office has to clear the hold first.",
    r.message,
  );
  check(
    "HOLD-V1: nothing entered (no entry row for the held tag)",
    (await entryTags()).length === 0,
    JSON.stringify(await entryTags()),
  );
  const vl = await voiceLog();
  check(
    "HOLD-V1: voice log records (left, 345, held) — tag + outcome only",
    vl.some((v) => v.tag === "345" && v.outcome === "held" && v.lane === "left"),
    JSON.stringify(vl),
  );
  await call("endPtt", { token: t });
}
await clean("HOLD-V1", []);

log("\n== HOLD-V2 — hold lands while a CONFIRM is pending: YES cannot enter ==");
await reset();
await seedWave(["345", "354"]);
{
  const t = await ptt();
  const r = await say(t, { transcript: "three four five" });
  check(
    "HOLD-V2 setup: CONFIRM pending on 345 (twin 354 live)",
    r.outcome === "CONFIRM" && r.tag === "345",
    JSON.stringify(r),
  );
  await call("placeHold", { tag: "345" });
  const yes = await call("voiceConfirm", { yes: true });
  check(
    "HOLD-V2: YES returns outcome held, entered nothing",
    yes.ok === true && yes.entered === null && yes.outcome === "held" && yes.tag === "345",
    JSON.stringify(yes),
  );
  check(
    "HOLD-V2: board still empty and the pending pair cleared",
    (await entryTags()).length === 0 && (await call("getVoiceState")).pending === null,
    JSON.stringify(await entryTags()),
  );
  const vl = await voiceLog();
  check(
    "HOLD-V2: voice log records (345, held)",
    vl.some((v) => v.tag === "345" && v.outcome === "held"),
    JSON.stringify(vl),
  );
  await call("endPtt", { token: t });
}
await clean("HOLD-V2", []);

// ------------------------------------------- persistence hygiene -------
log("\n== Persistence hygiene — no audio/transcript storage anywhere ==");
{
  const tables = (
    await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'copilot_%'",
      args: [],
    })
  ).rows.map((r) => String(r.name));
  const badCols: string[] = [];
  for (const tbl of tables) {
    const cols = (
      await db.execute({ sql: `SELECT name FROM pragma_table_info('${tbl}')`, args: [] })
    ).rows.map((r) => String(r.name));
    for (const c of cols) {
      if (/audio|transcript|raw_text|utterance/i.test(c)) badCols.push(`${tbl}.${c}`);
    }
  }
  check(
    "HYGIENE: no audio/transcript/raw column exists in any copilot table",
    badCols.length === 0,
    badCols.join(",") || `tables=${tables.join(",")}`,
  );
  const logCols = (
    await db.execute({ sql: "SELECT name FROM pragma_table_info('copilot_voice_log')", args: [] })
  ).rows.map((r) => String(r.name));
  check(
    "HYGIENE: voice log columns are exactly (id, school, ts, lane, resolved tag, outcome)",
    JSON.stringify(logCols) ===
      JSON.stringify(["id", "school_id", "ts", "lane", "resolved_tag", "outcome"]),
    logCols.join(","),
  );
  const dbBytes = Buffer.from(await Bun.file(DB_PATH).arrayBuffer());
  const leaked = ["trescientos", "doscientos", "ninety-nine", "twen", "cuarenta"]
    .filter((w) => dbBytes.includes(Buffer.from(w)));
  check(
    "HYGIENE: no transcript text appears anywhere in the DB file",
    leaked.length === 0,
    leaked.join(",") || "clean",
  );
}

// -------------------------------------------------------------- done ---
log(`\nVOICE GATE: ${total - failures}/${total} PASS, ${failures} FAIL`);
log(failures === 0 ? "ALL VOICE CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
mkdirSync(new URL("../test-results/", import.meta.url).pathname, { recursive: true });
writeFileSync(
  new URL("../test-results/voice-scenarios-2026-10-28.txt", import.meta.url).pathname,
  lines.join("\n") + "\n",
);
process.exit(failures === 0 ? 0 : 1);
