# RiderTap — Production Deployment Plan

**Status: STAGED, NOT DEPLOYED** (prepared Oct 24, 2026, per JR's approval:
"Add the Principal's Proof Report, then deploy"). No Netlify upload has been
made, the `ridertap` artifact has not been modified by this work, and the
production bundle is built only AFTER the Proof Report lands and the
artifact's action list freezes.

---

## 1. Architecture decision

**Netlify static hosting (client) + ONE Netlify Function (`actions`) +
Turso (libSQL) as the database.** All on JR's existing Netlify "Applanta
Tech" team; the only new account is a free Turso account (see Blockers).

```
Phones (staff) ──HTTPS──> Netlify CDN ── static client (React bundle)
                    │
                    └── POST /api/actions {action, args, schoolCode}
                          └─> Netlify Function "actions"
                                └─> Turso primary (libSQL) — one DB, all schools,
                                    every row scoped by school_id
```

Why this shape:

- **The client already polls.** `App.tsx` refetches `getState` every 3,000 ms
  (verified in source) and pauses offline. No websockets exist or are
  needed — a request/response function + a strongly-consistent primary is a
  perfect fit. Cross-device updates appear within one poll cycle (~3 s),
  which is what "live board" means for this app.
- **The artifact's backend is already libSQL/SQLite.** The hosted runtime
  serves the actions from a Drizzle (sqlite-core) schema over SQLite
  (`app.db`). Turso *is* hosted libSQL — the schema, the SQL dialect, and
  the Drizzle driver family carry over. Porting risk is minimal: swap the
  driver, add `school_id`, done. Nothing else in the category offers that.
- **Numbers-only model is preserved exactly.** The production schema
  (`schema/0001_production_schema.sql`) has the same five data tables plus a
  schools registry. There is still no name/roster/photo column anywhere in
  the system.

### Why NOT Netlify Blobs (evaluated first, rejected on Netlify's own docs)

- Default consistency is **eventual**: updates/deletions "propagated to all
  edge locations within 60 seconds." A holder could stare at a board missing
  the last minute of entries. Unacceptable at a dismissal curb.
- Strong consistency is opt-in per store/read — but Netlify's docs state
  plainly: **"There is no concurrency control built in, last write wins."**
  Blobs has no transactions, no compare-and-swap, no unique constraints.
  RiderTap's state is one shared, constantly-rewritten board: two walkers
  writing concurrently = lost updates by design, and the duplicate guard
  (check-then-insert) cannot be made atomic. **Blobs cannot preserve the
  two properties §3 requires. Rejected as the state store.** (It remains
  fine for static assets, which the CDN already handles.)

### Alternatives considered

| Option | Verdict |
|---|---|
| **Turso (libSQL), free tier** | **CHOSEN.** Same engine/dialect as the artifact; real transactions + unique indexes; remote-only client reads/writes hit the primary (no replica lag in functions). Free tier is far beyond pilot scale (sources checked Oct 24 2026: ~100–500 databases, 5–9 GB storage, 500M–1B row reads/mo — dwarfing a dismissal app's footprint). |
| Netlify DB / Neon Postgres | Viable fallback. Real transactions too, and it lives inside Netlify — but the port changes SQL dialect (sqlite-core → pg-core, timestamp handling, migration rewrite) for zero functional gain, adding risk to a one-shot deploy. Choose only if JR prefers no second vendor at any cost. Needs the same kind of connection-string handoff as Turso. |
| Self-hosted libSQL server | Same engine, but Applanta becomes a hosting operator (uptime at 2:45 p.m. on JR). Rejected. |
| Keep artifact runtime | Single-instance by design; not multi-device/multi-school production. Rejected (already established). |

### Consistency & latency — the honest tradeoffs

- **Single primary, serialized writers.** SQLite/libSQL allows one writer
  at a time. `addEntry` runs its whole check→assign→insert inside one
  `BEGIN IMMEDIATE` write transaction, so concurrent entries queue for
  *milliseconds* at the primary and commit in arrival order. Dismissal
  scale (worst case ~10 staff phones, a burst of a few entries/second) is
  nowhere near this limit. The cost: write latency includes one network
  round trip to the Turso primary per transaction — pick the Turso
  location closest to Netlify's function region (US East; Turso `iad`) at
  creation time, and it stays in the tens-of-ms range.
- **Read-after-write is immediate.** Functions use the remote-only libSQL
  client — no embedded replicas — so a walker's committed entry is visible
  to the next `getState` poll from any phone. No sync window, no stale
  board beyond the client's own 3 s poll interval.
- **What this is NOT:** it is not sub-second push. If a future requirement
  demands instant push, that's a client poll-interval change (cheap) before
  it's an infrastructure change.

## 2. The two properties the store MUST preserve — and how it does

Proven locally on the artifact (TWO_WALKER_SIM_TEST.md): (a) per-lane
append-only entries with independent wave/spot assignment; (b) server-side
duplicate rejection across sessions. Production preserves both, and
*strengthens* (b):

- **(a) Per-lane independence.** Wave lookup/creation and spot counting are
  scoped `(school_id, lane)` inside the entry's own write transaction.
  Lanes never share a wave row, so Left and Right fill in parallel exactly
  as in the local sim. Verified in the local shape test (§6): interleaved
  A:101…105 / B:201…205 produced Left W1 S1–4 + W2 S1, Right identical,
  zero lost/duplicated/misassigned.
- **(b) Atomic duplicate rejection.** Two independent mechanisms, either of
  which alone suffices:
  1. The duplicate check runs **inside** the `BEGIN IMMEDIATE` transaction
     — no second writer can interleave between check and insert.
  2. A **partial unique index** —
     `UNIQUE(school_id, number) WHERE status NOT IN ('departed','no_show')`
     — makes the database engine itself reject a second active row for the
     same number, even in a same-millisecond race the app layer missed.
     The function catches the constraint error and returns the client's
     existing `{ok:false, reason:"duplicate", existing:{…}}` response.
  The partial index exactly encodes the app rule "a number is blocked while
  active, reusable after departure/no-show" — verified in §6 (raw racing
  insert rejected; number reusable after `departed`).
- Tenant isolation rides the same index design: uniqueness is per
  `(school_id, number)`, so two schools can both have a car 101 without
  ever seeing each other (verified in §6).

## 3. Deploy mechanics — what actually exists

Verified live Oct 24 2026 (read-only API calls through the connector's
stored `custom.netlify` credential — the credential **works**):

- Account: **Applanta Tech** (slug `applanta-dev`), **41 sites** visible.
  **No `ridertap` site exists yet** — site creation is step 0 of execution
  (`POST /api/v1/sites`, same credential; name availability is confirmed at
  creation; fallbacks if `ridertap` is taken globally: `ridertap-app`,
  `ridertap-dismissal`).
- **The existing connector deploy tool (`bin/netlify-deploy.py`) cannot
  deploy RiderTap.** It performs a ZIP deploy, and per Netlify's own
  support/docs, a ZIP deploy "won't bundle the functions — it's only useful
  to fully static websites." RiderTap would ship with a dead API. Do not
  use it for this app.
- **The route that will be used: the API file-digest method.**
  `POST /sites/{id}/deploys` with `files{path: SHA1}` +
  `functions{"actions": SHA256 of the bundled function zip}` and
  `draft: true`; then PUT each `required` file and
  `PUT /deploys/{id}/functions/actions?runtime=js`. Fully scripted in
  `scripts/netlify-digest-deploy.py` (dry-run mode verified safe — it makes
  no API writes). Same stored credential as the ZIP tool; **no new token
  needed for Netlify.**
- **Netlify CLI is not installed on this VM**, and CLI auth would need a raw
  personal access token we neither hold nor should invent. CLI/drag-and-drop
  remain JR-interactive fallbacks only.
- Functions must be **pre-bundled** (single JS file, zipped) before the
  digest is computed — the bundling step (Bun/esbuild, both present on this
  VM) is part of the execution checklist, and the digest script refuses to
  run without `public/index.html` and `functions-dist/actions.zip` present.

### Access model (Truth Mode)

Production v1 gates each school by a **shared join code** (per school,
stored on each staff phone after first entry; every API call carries it).
That is proportionate for a pilot whose entire data set is car numbers —
there is nothing sensitive to steal — and it keeps the staff experience at
zero logins, which the dismissal floor needs. It is NOT individual staff
authentication: anyone holding a school's code can see that school's live
board of numbers. Codes are rotatable (change the row, phones re-enter).
Per-staff PINs are a post-pilot upgrade if a district's IT review asks;
the schema and dispatch already have the seam for it.

`seedDemo`/`resetDemo` are **not** ported as public actions — in production
they'd let anyone wipe a school. Provisioning follows
`scripts/provision-school.md` (one registry row per school + join code;
plus one Applanta-held demo tenant matching the fictional Auburn Elementary
profile, so sales/walkthroughs never touch a real school's deployment).

## 4. Server action inventory — port map (12 artifact actions)

Source of truth: `server/src/actions.ts` in the hosted project (frozen once the
Proof Report lands). Reference port staged at `functions/actions.ts`.

| Artifact action | Production disposition |
|---|---|
| `getState` | Port 1:1 + `school_id` filter; returns per-tenant state incl. `lastSummary` |
| `addEntry` | Port + write-transaction hardening + partial-unique-index catch (§2) |
| `undoLastEntry` | Port 1:1 + tenant filter |
| `advanceEntry` | Port 1:1 + tenant filter (hold check included) |
| `markNoShow` | Port 1:1 + tenant filter |
| `releaseWave` | Port 1:1 + tenant filter (count-check semantics unchanged) |
| `setHold` / `clearHold` | Port 1:1 + tenant-scoped `UNIQUE(school_id, number)` |
| `endDismissal` | Port 1:1 + per-tenant purge; also records `total_holds` into the summary (Proof Report input) |
| `saveSetup` | Port: updates the tenant's `schools` registry row |
| `seedDemo` / `resetDemo` | **Not ported** — replaced by gated provisioning (§3) |
| *(Proof Report action(s), TBD at freeze)* | Slots into the same dispatch table as a read over `day_summaries` scoped by `school_id` (history/duration/trend). `day_summaries` already stores everything it needs: per-day duration is `endedAt − firstCarAt`, plus cars, waves, holds, no-shows. |

Client changes at bundle time (and nothing else): replace
`client/src/api.ts` with `client-transport/production-api.ts` (same call
sites, fetch transport, join-code storage) and add the one-time join-code
entry to the existing no-school state. The offline outbox already lives in
device localStorage and is untouched — on reconnect it replays against the
function in original order, and the server-side duplicate guard absorbs any
replay collisions.

## 5. One-shot execution checklist (run AFTER Proof Report freeze)

Deploy credits are scarce (~2–3): this sequence uploads **exactly once**,
as a **draft**, and promotes the tested draft — promotion is not a new
upload.

1. [ ] Freeze: confirm the artifact's final action list (Proof Report in).
2. [ ] Regenerate/verify the function port against the frozen actions;
       typecheck client + function.
3. [ ] JR creates the free Turso account + database (location: US East /
       `iad`) and the URL + auth token are set as Netlify env vars
       `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (+ a self-chosen
       `PROVISIONING_TOKEN`) — via the Netlify dashboard or the API using
       the approved credential flow. **Tokens never transit chat.**
4. [ ] Apply `schema/0001_production_schema.sql` to the Turso database.
5. [ ] Provision the demo tenant + join code (`scripts/provision-school.md`).
6. [ ] Build the production client (artifact build tooling; swap in the
       production transport first) → stage into `production/public/`.
7. [ ] Bundle `functions/actions.ts` → single JS → zip →
       `production/functions-dist/actions.zip`.
8. [ ] `netlify-digest-deploy.py --dry-run` — eyeball every digest.
9. [ ] `netlify-digest-deploy.py --deploy` — creates the `ridertap` site
       if needed and uploads ONE draft deploy. **← the single upload.**
10. [ ] Run `POST_DEPLOY_SMOKE_TEST.md` against the **draft URL** (two
        sessions, demo tenant). All boxes must pass.
11. [ ] `netlify-digest-deploy.py --promote <deploy_id>` — same deploy goes
        live; re-run smoke steps 1–3 on the production URL.
12. [ ] ONLY THEN: production multi-phone test on real school Wi-Fi
        (several phones entering at once) before any pilot — unchanged
        standing requirement.

**Watch item (not a blocker):** function invocations scale with polling —
~6 devices × 20 polls/min × a ~45-minute dismissal ≈ 5–6k invocations per
school per dismissal day, drawn from the team's shared Netlify pool. Fine
at pilot scale; if the pool ever tightens, the fix is a longer poll
interval outside the dismissal window, not new infrastructure.

## 6. Local production-shape test — DONE (Oct 24 2026)

`scripts/local-shape-test.ts` ran the production schema + the exact
production `addEntry` algorithm against a shared SQLite file through TWO
independent connections (two would-be function invocations), WAL mode:
**7/7 checks passed** — full results in `LOCAL_SHAPE_TEST_RESULTS.txt`.

- Interleaved two-walker entry (4 spots/wave): all 10 accepted; per-lane
  assignment matches the artifact sim exactly (L: W1 S1–4 + W2 S1; R: same).
- Duplicate attempted from the *other* connection: rejected; exactly one
  row for the number afterward.
- A raw insert bypassing the app check: rejected by the partial unique
  index (the atomic guarantee).
- Number reusable after `departed`; same number in a second school fully
  independent (tenant isolation).

Build tooling inventory (verified without building, per the hosted
project's AGENTS.md — non-builder sessions don't run the artifact build):
Bun 1.4.4 and Node 24 present on the VM; the project's client build entry
(`client/build.mjs` via the platform SDK) and server bundle script exist,
and a prior SDK build output (`client/dist/` with `index.html` + assets)
is present, confirming the tooling runs in this environment.

## 7. Rollback

- **First deploy:** it lands as a draft; production simply doesn't exist
  until promotion. A failed smoke test costs zero credits and changes
  nothing public — fix, re-bundle, upload a new draft (that *would* be a
  second upload: another reason the checklist front-loads verification).
- **Any later deploy:** previous deploys are retained by Netlify; rollback
  is one API call — `POST /sites/{site_id}/deploys/{previous_id}/restore` —
  no re-upload. Keep the last-known-good deploy id recorded after each
  release.
- **Database:** the production schema is additive over the artifact's; a
  rolled-back function keeps working against it. Never ship a destructive
  schema change in the same deploy as the code that needs it.

## 8. Blockers — what JR must supply (plainly)

1. **A free Turso account and one database** (2–3 minutes at turso.tech;
   choose the US East / `iad` location), and the resulting
   **database URL + auth token** delivered through the secure credential
   flow or pasted by JR into the Netlify site's env-var settings —
   `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`. Nothing else external is
   needed; the Netlify side (account, credential, deploy route) is
   verified working with what we already have.
2. **The Proof Report build must land and freeze** (parallel task) — the
   bundle is built from the frozen artifact, once.
3. **A join code per pilot school** is generated at provisioning (not JR's
   burden), but JR delivers URL + code to the school — that handoff is
   part of the walk-in play, not this deploy.

Nothing else blocks. No new paid service, no Netlify plan change, no raw
Netlify token required.
