# RiderTap — FINAL deploy results (Oct 24, 2026)

## Outcome: **LIVE at https://ridertap.netlify.app**
JR approved the fix upload; the corrected draft was deployed, re-smoked
with NO test shim, promoted, and fully validated on the public origin.

## Deploys
- Draft 1 (Phase 2): `6adcbbde7a52134ecf0e4701` — 11/11 smoke PASS,
  NOT promoted (client→API 404: digest deploy lacked `_redirects`).
- Draft 2 (fix): **`6adcbe405ebecefbcbf06d0a`** — manifest includes
  `/_redirects` + `/_headers`; uploaded via `netlify-digest-deploy.py
  --deploy`. **Promoted** via restore (not a new upload).
- Total deploys created in the finish run: exactly ONE (the approved fix).

## Draft 2 re-smoke — real HTTP, no shim, no mirror
- GET / → 200 HTML (2,399 B); JS asset → 200 (283,452 B); CSS → 200
  (20,739 B).
- **POST /api/actions getState (RT-KW4W4X) → 200** with Auburn
  Elementary state — the exact path a teacher's phone hits. The 404
  defect is gone.
- POST with no code → 401 `school_code_required`; wrong code → 403
  `unknown_school`.
- Smoke 1: join-gate state = demo profile, empty board — PASS.
- Smoke 2: second independent session → identical school + board — PASS.
- Smoke 3: two-walker interleave (two concurrent threads) A-left
  101–105 / B-right 201–205 — 10/10 ok, exact per-lane wave/spot
  (W1 S1–4 + W2 S1 per lane) — PASS.

## Post-promotion validation on https://ridertap.netlify.app
- GET / → 200; JS/CSS assets → 200 at byte sizes identical to the
  staged bundle.
- getState via live function → Auburn Elementary School.
- Residue from draft re-smoke cleared by a live End Dismissal.
- **Live mini-dismissal through the public function:** entered 301 +
  302 (left W1 S1/S2) and 401 (right W1 S1); advanced 301/302 to
  Loaded; released left wave (in=2, ready=2); End Dismissal summary
  landed exactly — totalLoaded 2, totalNoShow 0, wavesRun 1,
  stillWaiting 1, startedAt = first entry 2026-10-24T14:25:31Z.
  Proof Report data path confirmed on the live tenant.
- **Demo tenant reset to pristine** (direct Turso cleanup of the 2
  validation summaries, Phase-2 pattern; creds fetched in-process from
  Netlify env, never printed/written). Verified THROUGH THE LIVE
  FUNCTION: profile intact; entries [], waves [], holds [],
  summaries [], lastSummary null.

## Deviation (environment, not product)
- Phone-viewport screenshot of the live site could NOT be captured
  from this VM: Chromium fails with ERR_TUNNEL_CONNECTION_FAILED
  through the sandbox egress proxy (same limit Phase 2 documented,
  re-confirmed with explicit proxy settings). Substitute evidence:
  the live origin serves byte-size-identical HTML/JS/CSS to the staged
  bundle whose join gate and full flow were screenshotted in Phase 2
  (`smoke-shots/draft-01-gate.png` etc.), and every functional check
  above ran against the real live function + DB.

## Quick Reference (Drive) — updated + read back
- Doc `RiderTap — Quick Reference` (RiderTap → 03 — Quick Reference):
  - `LIVE APP STATUS: LIVE as of Oct 24, 2026 — https://ridertap.netlify.app`
  - `DEMO JOIN CODE: RT-KW4W4X`
- Read-back confirmed both lines; no stale "activates today" /
  "Added at go-live" text remains.

## Addendum — env-snapshot redeploy (Oct 24, 2026, later)
The admin batch deploy `6adcc4388708784f980e472d` was created seconds
BEFORE JR saved the `ADMIN_CODE` site env var, so its function snapshot
predated the variable and live `adminOverview` returned
`admin_disabled` (baseline probe confirmed: DUMMY-WRONG → 403
`admin_disabled`; all other checks already green).
- Redeploy of the UNCHANGED staged bundle (same digests; nothing
  rebuilt): draft **`6adcc599bbf51829e002ba56`**, promoted via restore.
- Draft + production read-only smoke — ALL PASS on both:
  GET / 200; JS sha256 `e0de5fa9…b482` unchanged; getState `RTKW4W4X`
  → 200 Auburn Elementary, entries 0; adminOverview no code → 401
  `admin_code_required`; **adminOverview DUMMY-WRONG → 403
  `admin_forbidden`** (was `admin_disabled`) and demo school code →
  403 `admin_forbidden` — the live function now sees `ADMIN_CODE`;
  getState wrong code → 403.
- No dismissals run, no tenant mutation; demo tenant left pristine.
- Remaining manual step: JR enters his own owner code on the site and
  confirms the Admin Board renders.

## Standing facts
- Live URL: https://ridertap.netlify.app
- Demo school: Auburn Elementary School (Barrow County, GA)
- Demo join code: RT-KW4W4X
- Separate pending item (unchanged): real multi-phone test over school
  Wi-Fi before any pilot.
