# L-02 — Published evaluation table (assembled Fri Oct 30, 2026)

Every number below comes from a gate log, a battery results file, or a live
run through the deployed app — nothing is estimated. Sources are named per
row so any figure can be re-derived. This table goes in the public repo
(Mon Nov 2, L-16) and backs the submission writeup's measured claims.

## Deterministic gate suites (stub adapters, reproducible)

| Suite | Cases | Result | What it proves |
|---|---|---|---|
| Vision gate (Build 1) | 42 | 42/42 PASS | Mask label+centroid counting, 2-still debounce, count-only persistence (byte-verified) |
| Exception gate (Build 2) | 127 | 127/127 PASS | EX-01…EX-08 scenarios, payload hygiene (injected student_name fails on sight), malicious-line guard, 3 s timeout drill 8/8 (verbatim fallback lands ~3.0 s, late model line never overwrites) |
| Voice gate (Build 3) | 118 | 118/118 PASS | VC-01…VC-20: closed-set resolution, CONFIRM pair held server-side, DUPLICATE through the board guard, 3rd failed repeat routes to type-it |
| Voice gate after Fri fixes | 144 | 144/144 PASS | + FIX100-A/A2 (twin CONFIRM at any queue position; NO leaves board untouched), FIX100-B ("Walker 345." resolves), FIX100-C (wave-ID validation at creation) |
| Exception/board gate after hardening round 2 | 154 | 154/154 PASS | + HB-0…HB-4: a held tag cannot be entered (no entry row, no agent line) and cannot be advanced to a loading status (422 `tag_on_hold`); non-advancing statuses unaffected; entry recovers once the office clears the hold |
| Voice gate after hardening round 2 | 175 | 175/175 PASS | + HAM-1…HAM-3 (one-digit-off neighbor in the wave → read-back CONFIRM naming the earliest confusable tag; no confusable live → clean MATCHED; duplicate still beats near-match), HOLD-V1/V2 (voice entry of a held tag → HELD outcome, nothing entered). 13 pre-existing checks flipped, all from the single 212↔214 one-digit-off pair in the seed wave — each flip is the new guard working as specified |
| Live-adapter unit suite | 40 checks | ALL PASS | SAM mask codec vs Meta's published vector + a verbatim captured live payload (bit-exact); parser vs a real live response (3 boxes / 3 masks, centroids match an independent oracle to 1e-9); no-key fail-closed for all three adapters; WAV encoder checks for the phone recorder |

## Live batteries (through the deployed app's own actions, staging URL)

| Run | Model | Result | Latency |
|---|---|---|---|
| 10× battery (Thu Oct 29) | SAM 3.1 | 10/10 counts exact (GT 3/1/0), zero false positives | median 881 ms |
| 10× battery | Muse Voice Transcribe | 10/10 resolved to the exact tag (incl. "one zero for" → 104) | median 632 ms |
| 10× battery | Muse Spark | schema 10/10 · instructions 10/10 · safety invariant 10/10 (one over-cautious walk-up hold — the B8 finding, fixed Fri via scenario briefs) | median 2,551 ms |
| 100× battery (Fri Oct 30) | SAM 3.1 | **100/100** counts exact across 4 ground-truthed scenes (3/1/0/0 cars) | median 764 ms · p95 1,351 ms · max 2,378 ms |
| 100× battery | Muse Spark | **100/100** events produced a valid, safe instruction inside the 3 s cap — zone-mismatch ×40 (34 model / 6 rule fallback), duplicate ×20 + hold ×20 + walk-up ×20 (60/60 model-served after a test-data correction, see scorecard); walk-up wrongly held **0/20** | mismatch median 2,511 ms; other triggers ~0.9–1.5 s |
| 100× battery | Muse Voice Transcribe | 0 wrong entries in 100 utterances; 18 fail-safe ASK-REPEATs on garbled transcripts (asked again, never guessed); deep-dive found the ASR itself flips twin 354→"345" (~2 of 6 probes) | — |

## Post-fix live proofs (Fri Oct 30, deployed build 6ae48810)

| Proof | Result |
|---|---|
| Twin CONFIRM, twin behind the said tag (the battery's defect geometry) | Clip "three four five" → CONFIRM: *"I heard 345 — 354 is also queued in Left. Enter 345?"* → YES entered **345**, the heard tag |
| "Walker 345." call-sign clip, twin-free wave | MATCHED, 345 entered, live transcription, 1,202 ms round trip |
| Wave-ID validation | callWave `"WD"` → HTTP 422 `wave_id_invalid`; `"L1"` → 200 |
| End-to-end smoke (Fri AM, pre-fix build) | Vision match + 2-still mismatch sequence exact; voice clip MATCHED 345 in 1,643 ms; Spark's own line landed on a live flag in 2,345 ms reading the real board |

## Post-hardening live proofs (Fri Oct 30, round 2, deployed build 6ae49e34)

| Proof | Result |
|---|---|
| One-digit-off voice guard, clean clip | "One zero one" with 102 live in the wave → CONFIRM: *"I heard 101 — 102 is also queued in Left. Enter 101?"* → YES entered **101**, the heard tag |
| One-digit-off voice guard, the hostile battery's failing clip | The exact hurried clip behind the 1-in-92 wrong entry → CONFIRM, nothing entered; NO left the board untouched |
| HOLD as a hard block, typed path | enterTag on held tag 354 → `{held: true}`, no entry created |
| HOLD as a hard block, voice path | Voice clip "three five four" on the held tag → outcome HELD: *"354 is on HOLD — it was not entered. The office has to clear the hold first."* |
| HOLD as a hard block, loading path | setEntryStatus → `loaded` on the held tag → HTTP 422 `tag_on_hold`; after the office cleared the hold, entry and progression worked again |
| Full replay after the change | Demo storyline re-run end-to-end on the new build: **9/9 PASS** (the 101 step now exercises the widened guard) |

## Real-phone proof (Fri Oct 30, JR's Android phone, live staging deploy 6ae4fa3c)

| Proof | Result |
|---|---|
| Voice entry, typed fallback on the real phone | Typed "one zero two" → CONFIRM: *"I heard 102 — 101 is also queued in Left. Enter 102?"* → YES entered **102** (spot 4, outcome `corrected`), server-verified |
| Voice entry, SPOKEN on the real phone mic | JR held the button and said "three four five" → live transcription resolved **345** → CONFIRM (transposition twin 354 also queued) → YES entered **345** (spot 1, outcome `corrected`), server-verified. The full chain — phone mic → WAV → Muse Voice Transcribe → closed-set resolver → human confirm → board — is proven on real hardware |
| Exception agent, organic catch | The out-of-order entry of 102 fired an unprompted INFO advisory naming skipped tag 345 — a live, unscripted exception, handled correctly |
| Mic failure is never silent | The first capture engine (ScriptProcessor) delivered zero buffers on this phone and the press vanished without a trace. The shipped client (a) reports a no-sound press in plain words and (b) captures on MediaRecorder. A failed press can no longer look like a successful one |

## Hardening batteries (Fri Oct 30, JR's "no exceptions" pass)

| Run | Result |
|---|---|
| Vision breadth — 4 GT scenes × 6 simulated conditions (dusk, glare, rain, low light, flip, JPEG crush) × 5 | **120/120 counts exact**, zero false positives on empty scenes under every condition |
| Voice hostile — 92 utterances (4 voices, 1.3× hurry, lot noise at 10/5 dB SNR, call-signs, Spanish), twin geometry throughout | 77 correct · 4 mishears CAUGHT at the read-back · 10 fail-safe ask-agains · **1 wrong entry** (one-digit-off decoy, announced with Undo) · Spanish 8/8 |
| Spark mismatch re-battery after the early-fire + slim fix (40 flags, deployed build) | **37/40 model-served** (was 34/40), 40/40 valid inside the 3 s cap |

## Honest limitations (also L-17, for the writeup)

- Spark's zone-mismatch latency sits at the design edge (median ~2.5 s
  against a 3 s cap); the deterministic rule fallback is a permanent part of
  the design, not an apology — the product never waits on the model. The
  Fri early-fire fix raised model-served mismatch flags from 85% to 92.5%;
  the residual is the model's slow tail, and we do not claim 100%.
- The transcription model can mishear sound-alike tags; the closed-set
  resolver plus read-back CONFIRM plus one-tap Undo are the layered answer.
  It asks again rather than guessing on unclear audio (18/100 clean battery,
  10/92 hostile battery). In the hostile battery exactly one wrong entry in
  92 utterances occurred — a one-digit-off tag in the same wave, announced
  on the read-back with Undo available. **That path is now closed** (Fri
  Oct 30, round 2): the read-back CONFIRM fires for ANY confusable tag live
  in the wave — a digit transposition OR one digit different — and the
  exact clip that produced the wrong entry now stops at CONFIRM on the
  deployed build (proof above). One bounded scope note: the re-say
  "suggest" branch still keys on transposition twins only, because exact
  duplicate detection governs that branch and refuses the entry either way
  — it cannot produce a silent wrong entry.
- At the time of these runs, staging ran on an ephemeral local database;
  a cold start re-seeded the demo school. RESOLVED (Oct 30): staging now
  runs on a persistent Turso (libSQL) database — see the re-verification
  below. Production RiderTap is untouched by all of the above.

Raw evidence: `copilot/test-results/` (gate logs),
`spike-run/battery-results/SCORECARD.md` (10×),
`spike-run/battery100/SCORECARD-100.md` + results/diagnostics JSONL (100×).

## Post-reskin re-verification — Fri Oct 30, 2026 (deploy 6ae4fdb9)

A presentation-only reskin of the staging client (dark theme, official
Applanta logo, gradient status/exception/read-back cards — commit e07ff6d,
diff-audited: no handler, attribute, API, copy, or layout changes) shipped
Oct 30 at JR's direction. The full verification stack was re-run on the
reskinned build before it was called done:

- Gates, identical to pre-reskin: vision 42/42 · exceptions/board 154/154 ·
  voice 175/175 · unit ALL PASS · tsc clean.
- Live end-to-end chain on the deployed build (wave → typed voice entry →
  CONFIRM 102-vs-101 → entry → out-of-order exception fired): PASS.
- Full replay of the demo storyline against the deployed build: **9/9 PASS
  in 47.9s**, all three models live, and all three exception advisories in
  the run were served by Muse Spark inside the 3s cap (2,409 / 1,903 /
  1,952 ms). Transcript: `replay/proof-run-transcript.txt`.
- Transport note, measured the same day: Netlify's edge intermittently
  drops a function response's closing frame after the full body arrived
  (the 302-byte health body verified complete and valid while a strict
  HTTP client reported it incomplete). Browsers and curl are unaffected —
  the real-phone proofs above ran through it without a visible failure.
  The replay driver was hardened in response (partial-body salvage +
  bounded, transcript-logged retries; a mutating call is never retried on
  a partial reply), which is the configuration that produced the 9/9 run.

## Battery-1000 — Fri Oct 30, 2026 evening (SCORECARD: spike-run/battery1000/SCORECARD-1000.md)

~1,030 live model calls against the deployed staging app (SAM 495 · Spark
events 173 · Transcribe 362), paced, est. spend ≤ ~$1.85, no rate limits hit.

- **Wrong entries: 0** — across 250 hostile voice cases and 62 twin-flip
  attempts. The transcription flipped the hardest twin clip (354 heard as
  345) in ~41% of resolved hearings (20/49); the widened CONFIRM guard
  stopped every resolved attempt (49 CONFIRM · 4 ASK-REPEAT · 0 direct).
- **Voice varied (250):** 226 correct · 3 mishears caught at CONFIRM ·
  21 fail-safe ask-agains · 0 wrong entries.
- **Spark:** 50/50 exceptions produced, 0 invalid; model-served 41/50
  (82%), the rest served by the rule fallback at the 3 s cap by design.
  Two-day combined: 78/90 (87%) model-served, 100% valid.
- **Vision:** 248/248 exact counts on fresh degraded variants of the 4
  ground-truth scenes (dusk/glare/rain/lowlight/flip/crush + clean);
  zero false positives/negatives; median 620 ms.
- **Replay:** 24/25 full storylines passed; the single abort was a
  fail-safe ask-again on the twin voice step (nothing entered).
- **Known residual at the time (staging-only):** per-instance ephemeral
  state could split a session across function instances (9/62 twin-leg
  attempts hit HTTP 422 on PTT tokens in one window; 0/250 in a later
  window). Resolved by the persistent Turso database (re-verification
  below); it was never a product logic defect.

## Persistent database (Turso) — Oct 30 evening
Staging moved from the ephemeral per-instance local file to a persistent Turso (libSQL) database — the fix for the battery-1000 instance-split finding (9 of 62 leg-1 PTT attempts had died on tokens minted on a different function instance). Verified live on the promoted build: health reports db "connected (libsql-remote)"; the full voice chain (PTT token → utterance → twin CONFIRM → yes → entry) stays consistent across separate invocations; wave + entry state SURVIVES a full redeploy/promote cycle (previously a guaranteed wipe); full replay PASS 9/9 in 43.3s on the final build.

## Battery-1000 POST-TURSO rerun — Oct 30 evening
The identical 1,000-call battery re-run on the Turso-backed build (scorecard: spike-run/battery1000-turso/SCORECARD-1000-TURSO.md). PTT-session 422s: 9 → **0** (leg 1 resolved 50/50; the instance-split failure class is closed by measurement, not just by design). Replay 24/25 → **25/25**. Spark model-served 90% (45/50, 100% valid; two-night combined 88%). Twin-flip rate 28% on the hardest clip, guard stopped 100%. Vision: 245/245 answered checks exact (3 of 248 calls returned no answer on a heavy transport-clipping night — fail-closed, zone stays unverified). Voice varied: **wrong entries 0** (13 utterances transport-dead, nothing entered). Two-battery cumulative: ~2,000+ live model calls, zero wrong entries, zero invalid instructions.
