# RiderTap — Owner Admin Board + Join-Gate Fix (built Oct 24, 2026)

Status: **BUILT AND LOCALLY VERIFIED. NOT DEPLOYED.** This rides the next
Netlify upload batch with everything else pending. The live site, live
function, and JR's Turso data were not touched.

## What shipped in the codebase

### 1. Owner Admin Board
- **Server** (`functions/actions.ts`): new owner-only action
  `adminOverview`, dispatched BEFORE tenant resolution (the owner code
  never resolves to a school). Gate, in order:
  - no code in the call → **401** `admin_code_required`
  - `ADMIN_CODE` env var unset/empty (or normalizes to empty) → **403**
    `admin_disabled` — there is no hardcoded code and no default; the
    action is dead until JR sets the env var
  - code mismatch (including any valid SCHOOL code) → **403**
    `admin_forbidden`
  - match → **200** with the overview payload
  Comparison is normalization-insensitive and fixed-work (`safeEqualCode`).
- **Payload**: `{ generatedAt, schools: [...] }` — per school: profile
  (id, name, district, county, state, schoolType, laneMode, leftLabel,
  rightLabel, spotsPerWave, joinCode, createdAt) + `summary`
  (daysRecorded, totalCarsLoaded, totalNoShows, avgDismissalDurationSec
  over summaries that have both timestamps else null, lastDismissalDate,
  lastDismissalAt) + `today` (activeEntries, byStatus
  {entered, on_board, at_spot, loaded}, activeHolds). Aggregates ONLY —
  no car numbers, no entry rows (asserted in tests).
- **Client** (`build/client/src/App.tsx` + both transports): the join
  gate tries the entered code as the owner code first; on success the
  device opens a read-only **Admin** view (school cards: name, county/
  district/type, JOIN CODE chip, status line "N dismissals run · Avg
  dismissal X · Last dismissal DATE", tiles for on-board-now / holds /
  total cars / spots per wave, lane + per-status footer). EN/ES chrome
  and labels. EXIT ADMIN clears both stored codes and returns to the
  gate. The admin code lives under its own localStorage key
  (`ridertap-admin-code-v1`) and is only ever sent on the wire for
  `adminOverview`; a school code behaves exactly as before.

### 2. Join-gate flicker fix (JR's live defect, Oct 24)
Root cause (confirmed by reproduction + code read): a rejected code
stayed in localStorage; the state query kept failing on its 3 s poll
with React Query retries, and the gate's render condition was
`!schoolCode || (state.isError && !data)` — every flip of `isError`
switched the render between the gate and the main loading shell,
remounting the code input and destroying focus/draft mid-typing.
Fixes:
- On a 401/403 from getState, the client **clears the stored code**
  (which disables the query — no interval, no retries; `retry: false`
  set on the state query) and the gate renders from `!schoolCode`
  alone, with a static error banner. Draft text lives in App state and
  survives; the input is never remounted.
- The offline outbox sync effect is hard-gated on a verified school code
  being stored: unauthenticated devices fire zero API calls.

### 3. Forgiving code entry (normalization)
One rule everywhere: **uppercase, strip all non-alphanumerics**.
Client stores only the normalized form; the server normalizes BOTH the
incoming code and the stored join_code before comparing (tenant
resolution scans the small school registry), and the ADMIN_CODE
comparison uses the same normalization. `RT-KW4W4X`, `RTKW4W4X`,
`rt-kw4w4x`, `RT KW4W4X` all open the same school. Codes provisioned
with dashes (e.g. the live demo `RT-KW4W4X`) keep working unchanged.

## Files changed
- `functions/actions.ts` — adminOverview + gate + normalizeCode +
  normalized tenant resolution (functions-dist zip rebuilt by the
  bundle test — actions.js 23,144 B, includes the new action)
- `build/server/src/actions.ts` — `adminOverviewResponse` zod schema +
  `AdminOverviewResponse` type + typing-only action (typecheck contract)
- `build/client/src/api.ts`, `client-transport/production-api.ts` —
  admin code storage key + wire routing + normalizeCode setters
  (kept in sync; bundle builds from build/client/src/api.ts)
- `build/client/src/App.tsx` — gate rewrite, admin state/query,
  AdminView, EN/ES strings, outbox unauthenticated guard
- `public/` — re-staged from the new client build (`_redirects` and
  `_headers` preserved); staged JS contains the admin view
- New tests: `scripts/admin-board-test.ts`; drive harness in
  /tmp/ridertap-drive (serve.ts + drive.py); screenshots in
  `smoke-shots/admin-board-local.png` and
  `smoke-shots/gate-rejection-stable-local.png`

## Verification evidence
- **Typecheck**: `bun run typecheck` (client + server) — clean.
- **scripts/admin-board-test.ts — 20/20 PASS** (scratch DB, 2 schools,
  hand-computed aggregates: Alpha days 2 / cars 24 / no-shows 3 / avg
  750 s / last 2026-09-17 matched exactly; Beta legacy no-timestamp row
  → avg null; live by-status counts and holds matched; payload proven
  to contain none of the seeded car numbers; gate matrix 401/403/403/
  200 incl. school-code-refused and ADMIN_CODE-unset `admin_disabled`
  with school flow unaffected; 5 code formats all open Alpha;
  cross-school duplicate independence via normalized codes).
- **scripts/final-bundle-test.ts — ALL PASS** (prior suite: two-walker
  interleave, stub parity, tenant isolation, summary/undo/setup, true
  same-moment race 5/5, bundled-zip handler incl. Proof Report fields).
- **Browser drive of the built client (Playwright, 390 px, real
  production function over HTTP) — 14/14 PASS**:
  - outbox seeded + no code → **zero** /api/actions requests in 2.5 s
  - wrong code → error shown, stored code cleared, input node NOT
    remounted over 4.2 s (>1 poll cycle), focus and "WRONG1" draft
    preserved, zero getState refires after rejection
  - `rtkw4w4x` opens Auburn Elementary; stored value is `RTKW4W4X`
  - `owner9x` opens Admin Board listing both schools with join code
    and stats; owner code stored under the admin key only; EXIT ADMIN
    returns to the gate with the admin code forgotten
  - Admin Board screenshot visually inspected — on-system, clean at
    phone width.

## Go-live steps (next deploy batch — do in this order)
1. **JR sets `ADMIN_CODE`** in the Netlify site env vars (site
   ridertap → Site configuration → Environment variables): his OWN
   chosen owner code, same value for all contexts, alongside the two
   existing Turso vars. He picks it; nobody else needs to know it.
   **Until he does this, the Admin Board stays locked
   (`admin_disabled`) even after the new code deploys** — by design.
2. Rebuild happens from the staged sources exactly as in
   DEPLOY_PLAN.md: client already staged in `public/`, function zip
   already rebuilt in `functions-dist/` (rebuild both again if any
   further batch changes land first).
3. Deploy ONE draft via the digest method, smoke it (school code in
   dashless form opens the demo school; wrong code → static gate;
   owner code → admin list shows Auburn Elementary), then promote via
   restore — promotion is not a second upload.
4. After promotion, JR opens the live site on his phone, enters his
   owner code once, and confirms the board; staff flow is unchanged.

Note for JR's phone: his currently-stuck browser has the rejected code
in localStorage — after the deploy, the new client clears it
automatically on the first failed check and the gate holds still.
