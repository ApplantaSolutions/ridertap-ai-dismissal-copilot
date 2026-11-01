# RiderTap AI Dismissal Copilot

School dismissal is the one part of the school day still run on memory,
walkie-talkies, and group texts — where one mistyped tag number sends the
wrong car forward, and nothing catches it. **RiderTap** is a dismissal
board that runs a car-rider line on tag numbers only. The **AI Dismissal
Copilot** is the layer built for the Meta Global AI Developer Hackathon:
it watches the loading zone, speaks with the staff walking the line, and
flags every off-script event the moment it happens — while a human
confirms every action it suggests.

- **Entrant:** Applanta Solutions — Startup Track, "Build for Your World"
- **Live staging demo:** https://ridertap-copilot-staging.netlify.app
  (join code: **RT-KW4W4X**)
- **Full evaluation record:** [EVAL-TABLE.md](EVAL-TABLE.md)

## Judges — start here (60 seconds)

1. Open https://ridertap-copilot-staging.netlify.app, enter the join code
   **RT-KW4W4X**, and tap **"Open board"**. You land on the demo board —
   two lanes (Left Line, Right Line), each expecting a wave of 4, both
   reading VERIFIED.
2. **"Walker"** tab — Wave L1 is already called on the Left Line, with
   the film's queue (212, 214, 221, 345, 354). Hold **"🎤 Hold to talk"**
   and say *"three four five"*. Only tags queued in a called wave can be
   entered, and the walker never guesses: because the sound-alike 354 is
   queued in the same wave, it stops at a read-back — "I heard 345 — 354
   is also queued in Left. Enter 345?" — tap **"Yes"** to enter 345, or
   **"No"** to enter nothing.
3. **"Zone phone"** tab — no camera needed: tap **"Use sample lot
   photo"**. A sample photo of a lot (3 cars) fills the frame; the check
   crops it to the yellow rectangle and sends only the crop, exactly
   like a live frame. Against the wave of 4, the first check reads
   **CHECKING**; tap **"Check sample photo again"** and the second
   consecutive mismatch raises **MISMATCH** — Muse Spark's instruction
   appears right there and as the exception card on the Board tab. (With
   a real camera: **"Open camera"** and **"Start zone check (every
   5s)"** run the same check on live frames.) Either way, the frame is
   counted and discarded — only the count is kept.
4. Watch the **"Board"**: verdicts land on the lane chips, and a
   mismatch raises the exception card with one plain-language
   instruction — **"Confirm"** or **"Dismiss"**.

Under the hood: **SAM 3.1** counts the zone · **Muse Spark** writes the
exception instruction · **Muse Voice Transcribe** hears the tags. The
dismissal in the demo film ran through these same screens and this same
code path.

## Built before / built during the event

- **`base/` — RiderTap, pre-existing and frozen.** The production
  dismissal board, live since **October 24, 2026** at
  ridertap.netlify.app. It was snapshotted before the Copilot work began,
  hash-manifested file by file (`BASELINE-MANIFEST.sha256`, verify with
  `sha256sum -c`), and never modified or redeployed during the event.
  [BEFORE.md](BEFORE.md) is the disclosure record, including the
  workspace-vs-live drift check performed at snapshot time.
- **`copilot/` — the Copilot layer, built October 26 – November 4, 2026**
  for this hackathon: the three model integrations, the safety guards,
  the gate suites, and the replay mode described below.
- **`spikes/` — the model-contract spikes** run before the build to pin
  down each Meta Model API surface against live responses.

## The three Meta AI models

| Piece | Model | What it does |
|---|---|---|
| Vision zone check | **SAM 3.1** (`sam-3.1`) | The zone phone crops a still to the loading zone on-device (~every 5 s). The server counts vehicles in the crop from mask centroids. A count that disagrees with the wave's expected count on **2 consecutive stills** raises a MISMATCH flag (VERIFIED / CHECKING / MISMATCH). The frame is discarded after counting — only the count is kept. |
| Exception agent | **Muse Spark** (`muse-spark-1.3`) | Reads board state and gives the dismissal lead one plain-language line for off-script events — out-of-order entries, duplicates, safety holds, walk-ups. Non-streaming, structured output, hard 3-second cap, deterministic rule fallback. Advisory only: a human confirms every action, and a hold never waits on the model. |
| Voice entry | **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`) | The walker presses to talk and speaks the tag number. Resolution is **closed-set** against the live queue: any confusable tag in the wave (a transposition, or one digit different) triggers a read-back CONFIRM; unclear audio asks again. It never guesses an entry. |

Standard model IDs only, in every call. Every adapter **fails closed**:
with no API key configured, no model call is attempted and the product
runs on its deterministic rules alone — the Copilot can be unplugged and
dismissal still works.

**Replay mode** feeds recorded stills and utterances through the same
functions and the same live API calls, so the judged demo and the live
final run deterministically.

## Measured results

Every figure below is from a gate log, a battery scorecard, or a live run
through the deployed app — nothing is estimated. The complete record,
including the failures found and fixed along the way, is in
[EVAL-TABLE.md](EVAL-TABLE.md).

- **Deterministic gate suites:** vision **42/42** · exceptions & board
  **154/154** · voice **175/175** · live-adapter unit suite all-pass
  (the SAM mask codec verified bit-exact against a captured live
  payload).
- **Live batteries:** two independent 1,000-call batteries against the
  deployed staging app — **~2,000+ live model calls in total, zero wrong
  entries, zero invalid instructions.** SAM counts exact on every
  answered check across four ground-truthed scenes and degraded variants
  (dusk, glare, rain, low light, flip, JPEG crush); the transcription
  model flipped the hardest sound-alike clip in up to ~41% of hearings
  and the read-back CONFIRM guard stopped every attempt.
- **Replay:** 25/25 full demo storylines passed on the final build.
- **Real hardware:** the full voice chain — phone microphone → WAV →
  Muse Voice Transcribe → closed-set resolver → human confirm → board —
  proven on a real Android phone against the live deployment.

## Repository layout

```
base/       Frozen production RiderTap (client, function, schema, manifest)
copilot/    The Copilot layer
  client/     React + TypeScript single-screen app (board, walker, zone phone)
  functions/  One Netlify Function dispatching {action, args, schoolCode}
  src/        Zone check, exception agent, voice resolver, board, persistence
  scripts/    Gate runners, scenario suites, seed, deploy tooling
  test-results/  Gate logs from the verification runs
spikes/     Pre-build model-contract spikes and their results
EVAL-TABLE.md   The audited evaluation record
BEFORE.md       The frozen-base disclosure
```

## Running it

The Copilot is a Bun + TypeScript project deploying to Netlify (static
client + a single `actions` function, `/api/actions`).

```bash
cd copilot
bun install
bun run test:vision        # deterministic vision gate
bun run test:exceptions    # exception / board gate
bun run test:voice         # voice-resolver gate
bun run test:unit          # live-adapter unit suite
bun run typecheck
```

Configuration is by environment variable (names only — values are set in
the hosting environment, never in this repository):

- `META_API_KEY` — Meta Model API key. Without it, all three adapters
  stay in their fail-closed stub mode and the gate suites still run.
- `COPILOT_DB_URL` / `COPILOT_DB_TOKEN`, or `TURSO_DATABASE_URL` /
  `TURSO_AUTH_TOKEN` — the libSQL (Turso) database for board state.
- `COPILOT_SAM_ADAPTER`, `COPILOT_SPARK_ADAPTER`,
  `COPILOT_TRANSCRIBE_ADAPTER` — `live` or `stub` per model.
- Model IDs default to the standard IDs above and can be overridden with
  `COPILOT_SAM_MODEL_ID`, `COPILOT_SPARK_MODEL_ID`,
  `COPILOT_TRANSCRIBE_MODEL_ID`.

## Privacy, by design

- **Numbers only.** There is deliberately no name, roster, or photo
  column anywhere in the schema. The school keeps the number→child
  mapping itself, exactly as it does today.
- **The camera counts vehicles — nothing else.** Cropping happens
  on-device; the frame is discarded after counting and no image is ever
  stored. No faces, no plates, no child matching.
- **What persists is a count, a tag number, and an outcome.** Ending
  dismissal purges the day's detail rows and keeps aggregate summaries
  only.
- **Advisory only.** The exception agent can suggest; only a human can
  act. A safety HOLD is a hard block that no model output can soften.

---

RiderTap and the AI Dismissal Copilot are built by **Applanta
Solutions**. The Copilot layer was created for the Meta Global AI
Developer Hackathon (October 26 – November 4, 2026).
