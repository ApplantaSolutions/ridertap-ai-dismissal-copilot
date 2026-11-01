# BEFORE — the frozen RiderTap base (pre-Copilot snapshot)

Snapshot taken: **Tue Oct 27, 2026** (Meta Global AI Developer Hackathon build window, Oct 26 – Nov 4, 2026).
Baseline commit: the commit carrying this file, tagged **`baseline-pre-copilot`**.
Entrant: Rudolph Miller (Applanta Solutions), Startup Track.

This file is the disclosure anchor for the entry: everything under `base/` existed
and was LIVE before the Copilot was built. Everything under `copilot/` and
`spikes/` is new code written inside the hackathon window, in dated commits
after the baseline tag. Production RiderTap is **never modified or deployed**
during the event; the Copilot ships to a separate staging surface.

---

## What the base is

**RiderTap** — a school-dismissal board that runs a car-rider line with tag
numbers only. Schools onboard themselves (school name, district, dismissal
settings, per-school join code). Staff on phones enter the car tag number as
each car arrives; the board groups cars into loading waves per lane, staff
check students off as loaded, and waves release when every car in the wave is
loaded or marked no-show. End Dismissal purges the day's detail rows and keeps
aggregate summaries only (counts and durations — never a car number).

Privacy shape (by design, verified in `base/schema/0001_production_schema.sql`):
there is deliberately **no name, roster, or photo column anywhere** in the
schema. The school keeps the number→child mapping itself, as it does today.
HOLDs are reason-free flags on a tag number.

### Demo school (live tenant)
- **Auburn Elementary School**, Barrow County, GA — dual lane ("Left Line" /
  "Right Line"), **4 spots per wave**, dismissal 14:15–15:00.
- Join code: **RT-KW4W4X** (staff enter it once per device; it is the tenant
  key — the same code the Copilot staging tests use against a *local* staging
  database, never against production).

### Live deployment (the frozen surface)
- URL: **https://ridertap.netlify.app** (Netlify site id `92bdda35-c5a0-48ad-9342-04fff1372d85`)
- Live since **Oct 24, 2026**; final fix deploy (Draft 2, `6adcbe405ebecefbcbf06d0a`)
  promoted Oct 24 — see `base/FINAL_DEPLOY_RESULTS.md`.
- Deploy method of record: Netlify API **file-digest** method
  (`base/scripts/netlify-digest-deploy.py`). The ZIP deploy route is banned:
  it does not bundle functions.

## Stack (base)
- **Client:** React 19 + TypeScript (Bun build via the platform SDK),
  single-screen PWA-style app, ~3-second state poll. Source: `base/build/client/`,
  built output: `base/build/client/dist/`, staged publish dir: `base/public/`.
- **Server:** ONE Netlify Function, `actions`
  (`base/functions/actions.ts` — the deployed port; artifact source in
  `base/build/server/src/actions.ts`), dispatching on
  `{action, args, schoolCode}` over POST `/api/actions`. Exports both a
  fetch-style handler (local tests) and a Lambda `handler` (the bundled zip).
  Bundled artifact: `base/functions-dist/actions.zip`.
- **Database:** Turso / libSQL (SQLite dialect), multi-tenant by `school_id`;
  tenant resolved from the per-school join code on every request. Schema:
  `base/schema/0001_production_schema.sql`. Duplicate entries are rejected by
  a partial unique index at the database level, not by app convention.
- **Actions in the base:** getState, saveSetup, addEntry, undoLastEntry,
  advanceEntry, markNoShow, releaseWave, setHold, clearHold, endDismissal,
  plus an owner-only `adminOverview` gated by a separate ADMIN_CODE
  (aggregates only). `seedDemo`/`resetDemo` were deliberately NOT ported to
  production.

## What the snapshot contains
- `base/` — a byte-exact copy of `~/workspace/ridertap/production/` as of
  Oct 27, 2026, EXCLUDING only dependency caches (`node_modules/`,
  `build/.bun-cache/`) — 62 files, ~12 MB. No file was edited in the copy.
- `BASELINE-MANIFEST.sha256` — SHA-256 of every file under `base/`
  (paths relative to this repo's root; verify with
  `sha256sum -c BASELINE-MANIFEST.sha256` from the repo root), generated at
  snapshot time. Any later claim about the frozen base can be re-verified
  against this manifest.

## Workspace-vs-live drift check (R-01) — performed Oct 27, 2026

Method: fetched the live site's assets over HTTPS and compared SHA-256 hashes
against both staging copies in the workspace (`base/public/` — the digest
deploy's publish dir — and `base/build/client/dist/`), then read live board
state through the production function (read-only `getState`).

| Asset | Live SHA-256 (first 16) | Matches `public/` | Matches `dist/` |
|---|---|---|---|
| `/index.html` (2,399 B) | `938d74e295f1cc9f` | ✅ identical | ✅ identical |
| `/assets/index-1pxmzkgg.js` (289,486 B) | `e0de5fa988f9baaa` | ✅ identical | ✅ identical |
| `/assets/index-jr5frjn0.css` (21,242 B) | `2282af556e0744de` | ✅ identical | ✅ identical |

- Live root serves `Content-Type: text/html; charset=UTF-8`, HTTP 200.
- Live function (read-only `getState`, code RT-KW4W4X) returns Auburn
  Elementary School — dual lane, 4 spots/wave, Left/Right Line labels,
  dismissal 14:15–15:00, empty board, no summaries — exactly the demo-school
  profile the base provisions.
- **Verdict: NO DRIFT.** Every fetchable live asset is byte-identical to the
  workspace copy snapshotted here, including the Oct 24 fix deploy (the
  promoted Draft 2 bundle). The workspace tree is a truthful baseline of
  record.
- Limitation, stated plainly: the deployed function bundle cannot be
  hash-compared over HTTP (Netlify does not serve function source). Its
  observable behavior (school profile, board state, wire shape) matches the
  base source; `base/functions-dist/actions.zip` is the bundle of record
  from the Oct 24 deploy run.

## What the Copilot adds (built in-window, in `copilot/`)
1. **Vision zone check** — the zone phone crops a still to the loading zone
   on-device (~every 5 s); the server counts vehicles in the crop via SAM 3.1
   (Meta Model API, prompt "car"); a count that disagrees with the wave's
   expected count on **2 consecutive stills** raises a MISMATCH flag on the
   board (VERIFIED / CHECKING / MISMATCH chip). Frames are discarded after
   counting — count-only persistence, no image is ever stored.
2. **Exception agent** — Muse Spark (standard model ID only) reads board
   state and gives the dismissal lead one plain-language line for off-script
   events (out-of-order, duplicate, HOLD, walk-up), behind a deterministic
   rule fallback. Advisory only: a human confirms every action; a safety
   hold never waits on the model.
3. **Voice entry** — the walker speaks tag numbers (Muse Voice Transcribe);
   resolution is closed-set against the live queue — never a guess, never a
   double-queue.
4. **Replay mode** — recorded stills fed through the same functions and the
   same real API calls, so the judged demo and the Nov 9 live final run
   deterministically.
