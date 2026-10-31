# RiderTap Phase 2 — Deploy Results (Oct 24, 2026)

## Outcome: DRAFT DEPLOYED + FULLY SMOKE-TESTED (11/11) — **NOT PROMOTED**
Promotion is blocked by ONE defect in the draft as deployed (see Deviation).
The fix is staged; promoting requires one corrected draft upload — a
parent/JR decision per the one-shot rule.

## What was done
1. Retrieved `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` from the Netlify
   site env via the API (connector credential). Values were used only
   in-process — never printed, logged, or written anywhere.
2. Applied `schema/0001_production_schema.sql` to JR's Turso DB.
   (First-pass splitter broke on semicolons inside schema comments and
   applied everything except `schools`; an idempotent repair pass applied
   just the `schools` table. Final state verified: all 6 tables + indexes.)
3. Provisioned tenants:
   - **Demo: "Auburn Elementary School"** (Barrow County, GA, dual lane,
     4 spots/wave) — id `sch_6aa175ceba40c1db`, **join code `RT-KW4W4X`**.
   - Throwaway "Smoke Test School" for isolation check 8 — deleted after
     the test; its code now returns 403.
4. Fired the ONE draft deploy via `scripts/netlify-digest-deploy.py`:
   - **Deploy ID: `6adcbbde7a52134ecf0e4701`**
   - **Draft URL: https://6adcbbde7a52134ecf0e4701--ridertap.netlify.app**
   - Site: `ridertap` (`92bdda35-c5a0-48ad-9342-04fff1372d85`). No other
     deploys were created. Nothing promoted; the site's published deploy
     is still none.
5. Ran the full 11-point smoke test (POST_DEPLOY_SMOKE_TEST.md) — see below.
6. Cleaned the smoke residue out of the demo tenant: board was already
   purged by End Dismissal; the smoke day-summary was deleted so JR's
   demo Proof Report starts empty. Verified via the live function:
   demo getState = profile intact, 0 entries / 0 waves / 0 holds /
   0 summaries.

## Smoke test results (draft function + Turso + exact deployed client bytes)
1. Join gate renders; demo profile loads — PASS
2. Session B: same school, same empty board — PASS
3. Two-walker run (A left 101–105 / B right 201–205 interleaved):
   exact per-lane wave/spot assignment, 10/10 — PASS
4. Duplicate guard cross-session: B re-entering 101 and A re-entering 201
   both refused with "ALREADY CALLED" + original lane/wave/spot; exactly
   one row each — PASS
5. Release independence: Left W1 released on its count; Right W1 release
   stayed disabled until its count matched, then released — PASS
6. HOLD on 205 (Office, session A): red/blocked on B's Board, blocked in
   Loader, Walker B entering 205 got the hold alert — PASS
7. Latency: A's first entry appeared on B's board in **2.05 s** (one poll
   cycle) — PASS
8. Tenant isolation: throwaway tenant saw none of the demo data — PASS
9. Offline: 2 numbers queued, queue survived a mid-queue page reload,
   synced in original order (301 → Left W2 S2, 302 → Left W2 S3) — PASS
10. End Dismissal: summary exact (8 loaded, 0 no-show, 2 waves,
    1 hold placed, 4 still waiting; startedAt = first entry), board
    purged, other tenant untouched — PASS (see harness note)
11. Proof Report: Office shows "Dismissal complete in 2 min · 8 cars ·
    2 waves · 4 still waiting", Holds placed: 1, Semester section —
    PASS (see harness note)

Harness notes (honest adaptations, environment-forced):
- Checks 10/11 initially "failed" on the harness's case-sensitive string
  match — the app renders those headings in ALL CAPS. Re-verified with
  corrected assertions against the live post-dismissal state: PASS, with
  screenshots (`smoke-shots/draft-10-summary.png`,
  `draft-11-proof-report-verified.png`). The underlying data was exact in
  the original run already.
- This VM's Chromium cannot traverse the sandbox egress proxy
  (ERR_TUNNEL_CONNECTION_FAILED in every configuration; curl/urllib work
  fine). Page loads therefore came from a local mirror of the EXACT
  deployed bytes in `production/public/` (Netlify's serving of those
  bytes independently verified: GET / on the draft URL = 200), while all
  API traffic hit the REAL draft function + REAL Turso DB.
- The client's `/api/actions` calls were route-shimmed to the function's
  native path inside the test browser contexts only (see Deviation).

## Deviation — why promotion is blocked
As deployed, the draft's client cannot reach its API: `POST /api/actions`
returns **404** on the draft URL. The function itself is live and correct
at `/.netlify/functions/actions` (verified directly — getState returns
the demo tenant). Root cause: the redirect rules live in
`production/netlify.toml`, which the API file-digest deploy never carries.
Digest deploys take redirect rules from a `_redirects` file inside the
published files, and Phase 1 staged none.

**Fix (staged, ready):** `production/public/_redirects` and
`production/public/_headers` now exist with the exact rules from
netlify.toml:
```
/api/actions /.netlify/functions/actions 200!
/* /index.html 200
```
Next step when approved: ONE more run of
`netlify-digest-deploy.py --deploy` (creates corrected draft 2), a quick
re-smoke (steps 1–3 + a direct `POST /api/actions` 200 check, no shim),
then `--promote <new_deploy_id>`. The current draft stays as-is until
then; production remains undeployed.
