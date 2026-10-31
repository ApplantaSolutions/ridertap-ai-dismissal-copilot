# SPIKE-RESULTS — Meta Model API measured facts (R-05)

## READ THIS FIRST — current state (Fri Oct 30, 2026)
This file stacks TWO rounds from the same evening in order, and the rough
round comes first — read the state here, not the order of the sections.

- **Round 1 (~17:45 EDT) — first-contact probes, one call each, run to FIND
  problems.** They found three: Spark returned empty because our request
  capped it at 200 tokens and the model spends ~198 thinking (fix: bigger
  budget — proven same evening); the first test photo was too small for
  Meta's decoder to read (the model itself was fine); the voice endpoint we
  guessed at doesn't exist (404 — the real door was pinned from Meta's docs
  the same evening: POST /v1/asr/transcribe). Every failure below from this
  round has its diagnosis and fix written next to it.
- **Round 2 (~18:00–20:00 EDT) — the proof runs + the 10× battery JR watched
  before bed.** Proof: SAM counted 3/3 cars exactly on a real photo; Spark
  returned a valid one-line instruction; Voice heard the tag words exactly.
  Battery (30 tests, scorecard: spike-run/battery-results/SCORECARD.md):
  EYES 10/10, EARS 10/10, BRAIN 10/10 schema + 9/10 semantics (one genuine
  miss: a walk-up case where Spark held a verified wave — it fails SAFE, and
  the adapter wording fix is Friday work). Safety invariant 10/10.
- **Governing result = Round 2.** Total spend for the whole evening: about
  seven cents of the $150 credits (JR's console showed $149.98 remaining
  mid-evening; his console is the ground truth).

Status: **RUN — Thu Oct 29, 2026** (see Run header). The three unknowns the
build days bet on are now measured facts or explicitly unpinned, below.
Live gates per model follow as each adapter goes live (adapter env flips +
the follow-ups at the bottom).

---

## Run header
- Date/time (ET): Thu Oct 29, 2026, ~17:43–17:47 EDT (sitting: key set → redeploy → spikes)
- Run by: Nova (key fetched in-memory from the staging Netlify env via the stored credential; never printed, logged, or written anywhere)
- Account: JR's Meta Model API account (Team ID noted in-session, never in this file)
- Credits: balance before $150.00 (JR's Billing screenshot, 17:03 EDT) / after: not read by Nova (Billing is JR's console surface). Estimated spend of this run: **< $0.05** (published unit prices × measured usage below) — JR's ~$10 test ceiling was never approached; ≥$149.95 of the credits remain preserved for the competition period.
- Calls made (total, all spikes): **9** (8 POSTs + 1 GET /models catalog read)

## Catalog model IDs (exact strings, copied from JR's account catalog)
| Model | Research ID | Exact catalog ID | Standard or Contributor? |
|---|---|---|---|
| SAM | `sam-3.1` | `sam-3.1` | Standard |
| Muse Spark | `muse-spark-1.3` | `muse-spark-1.3` | **Standard** (a `muse-spark-1.3-contributor` ID also exists in the catalog — FORBIDDEN for this product, never called) |
| Muse Voice Transcribe | `muse-voice-transcribe-1.0` | `muse-voice-transcribe-1.0` | Standard |

How verified: `GET https://api.meta.ai/v1/models` on JR's account returned 9 models: muse-wonder-1.0, sam-3.1, muse-spark-1.3-contributor, muse-voice-transcribe-1.0, muse-spark-1.3, muse-image-1.0, muse-spark-1.2-contributor, muse-spark-1.2, muse-spark-1.1. All three research IDs match the catalog exactly — no respelling needed.

## SAM 3.1 (spikes/sam-spike.ts)
- Endpoint + surface that answered: `POST https://api.meta.ai/v1/responses` — HTTP 200, status "completed" on a real still. (The 1×1 contract probe first returned HTTP 400 "invalid image data… could not be decoded" — the probe JPEG was too minimal for their decoder; auth itself passed, as the request reached image validation.)
- Still used: promo hook aerial (photoreal car-line aerial), converted to JPEG 1152×2048, 744,522 bytes — deliberately oversized vs production zone crops.
- Latency per call: 4,340 ms (n=1, real still). 1×1 probe: 1,182 ms (error path, not representative).
- p50 / p95: NOT YET — n≥3 on real production-size crops is measured at the live vision gate.
- Response shape (where boxes + encoded masks live): `output[0].content[0]` is `output_text` carrying segment records: `<|box;x1=…;y1=…;x2=…;y2=…;w=1152;h=2048|>` followed by `<|mask;x=0;y=0;data=…|>` per detected object. `usage.images_processed: 1`; token usage fields are 0 (image-priced).
- Decoder needed: a parser for this segment text format (meta-sam-parser or an equivalent hand parser) in the live adapter — as the architecture planned.
- Decoded mask count vs the still's ground truth: NOT YET — at least one car object was returned (first box visible in the response); the decoded count vs ground truth is graded at the live vision gate against the STILLS-PLAN set.
- >16-objects-in-frame behavior: not observed this run.
- **DECISION — zone-check sync or async (C-01):** the sampled-stills, async-tolerant design is CONFIRMED as the right pattern (single call 4.3s on an oversized still; the 5s sampling cadence + 2-still debounce absorbs it; production crops are far smaller). Final sync/async lock after p95 is measured at the live gate.

## Muse Spark (spikes/spark-spike.ts + isolation probes)
- Endpoint + surface that answered: `POST https://api.meta.ai/v1/chat/completions` — HTTP 200 on every attempt.
- Effort tested: minimal ☑ (default-effort isolation calls also run)
- TTFT (streaming): not measurable on the two streaming runs because content was empty (see below). Warm non-streaming totals: 1,293–1,689 ms (isolation), **2,591 ms** (confirmation call, full spike shape). FIRST-EVER call on the account: headers 24,232 ms / total 25,034 ms — a cold-start outlier, not the warm behavior.
- Structured output valid on first call? NO on the spike as written — and the cause is measured, not guessed: with `max_tokens: 200`, the model spent **198 of 200 completion tokens on reasoning_tokens** and emitted nothing (`content: null`, finish_reason "length"). Isolation calls (plain, and schema-without-effort) reproduced it exactly.
- Confirmation call (spike shape + `reasoning_effort: minimal` + `max_tokens: 1500`): **VALID structured output** — instruction "Left lane Wave 1: 4 tags present but 5 zones counted — verify extra vehicle tag before release." (97 chars), action `check_tag` (in enum), confidence 0.85. Usage: 409 completion tokens (354 reasoning + ~55 answer), 211 prompt tokens.
- Confidence field returned reliably / sane values?: present and sane on the valid call (0.85). One valid sample — treated as a signal, not a gate.
- **DECISION — confidence as a fallback trigger:** DROP as a trigger; keep as a logged signal. Fallback triggers remain timeout + schema-validity only (a safety hold never waits on a confidence score).
- **DECISION — C-04 reading:** Spark is viable inside the design budget WHEN WARM and WHEN the token budget is fixed (warm totals 1.3–2.6s). Architecture unchanged: streaming, minimal effort, **timeout + deterministic rule fallback stay primary for anything safety-shaped** — the 25s cold first call is exactly the failure the fallback exists for.
- Timeout value locked for the exception function: 3,000 ms (as built).
- **ADAPTER FIX REQUIRED (from this spike):** the live Spark adapter must request a generous max_tokens (≥1000) — reasoning tokens are billed inside the same budget, and the stub-era 200 would starve every live answer. This was caught by the spike on Thu, not at the demo.

## Muse Voice Transcribe (spikes/transcribe-spike.ts → spikes/transcribe-stream-spike.ts)
- Endpoint + surface that answered: `POST https://api.meta.ai/v1/audio/transcriptions` (OpenAI-style multipart, 0.25s silent WAV) → **HTTP 404, empty non-JSON body**. That endpoint is NOT the contract on this API.
- **Real input contract: PINNED (Thu Oct 29 evening, official-docs dig — full write-up: `~/workspace/ridertap/hackathon/TRANSCRIBE-CONTRACT.md`).** Sources: Meta's launch guide (developer.meta.com blog) + Meta's official cookbook repo (`meta-models/meta-model-cookbook`, `06_muse_voice/01_voice_api_fundamentals` — the client source is the wire reference). The model serves TWO transports:
  - **Streaming:** `wss://api.meta.ai/v1/asr/realtime`. Handshake = one JSON frame carrying the credential (`authorization.accessToken` — no Authorization header), `mode`, `audioEncoding` (`PCM_24KHZ` native / `PCM_16KHZ`), `model`, `partialMode: "CUMULATIVE"`, optional `keywords` / `languageBias`. Server acks with `{"sessionId": …}` before audio. Audio = raw PCM s16 mono as binary frames, **paced at real time** (>5s backlog → close 1008; below-real-time ingress 10s → 1008; session cap 60 min → 1011; rate limit → 1013). End with `{"type":"endStream"}`. Events: `transcript` (cumulative partials, `final: true` completes), `speechStart`/`speechEnd`/`speechComplete` (correlate by `turnId`; `speechComplete` is async), `speaker` (bare-letter label, DIARIZATION), `error`.
  - **One-shot:** `POST https://api.meta.ai/v1/asr/transcribe` — `Authorization: Bearer` header (opposite of streaming), multipart with a JSON **`request` part** (`{mode, model, audioEncoding: "WAV", keywords?, languageBias?}`) + the WAV as the `audio` part. Response: `{sessionId, transcript, audioDurationMs, turns[]}`. **Caps: ≤10 min audio and ≤32 MB** (413 over size, 400 over length).
- Modes (both endpoints): `PUSH_TO_TALK` (default; caller delimits the turn), `ENDPOINTING` (in-model VAD), `DIARIZATION` (+ speaker labels, non-overlapping speech). Mode fixed at handshake.
- Accepted audio formats + limits: mono 16-bit PCM/WAV at 24 kHz (native) or 16 kHz; streaming session ≤60 min; one-shot ≤10 min / ≤32 MB.
- **Keyword biasing: EXISTS — parameter name `keywords`** (list of strings, both endpoints), plus `languageBias`. Both nudge rather than constrain — the closed-set resolver remains the guarantee. (Client samples cap keywords at 50; server cap unpublished.)
- Pricing: $0.18/audio-hour ($3.00 per 1,000 minutes) — a walker clip is fractions of a cent.
- Transcript on a real spoken-tag clip: not yet run against the pinned endpoints. **New spike `spikes/transcribe-stream-spike.ts` implements the pinned contract (streaming default; `--once` for the one-shot POST) — ready, not run.** The original spike's job (probing the guessed endpoint) is done; it stays unmodified.
- Latency: 436 ms (404 path only — meaningless). Live latency gets measured when the new spike runs through the staging-env path.
- **DECISION — voice transport (C-07):** the pre-decision governs unchanged — push-to-talk only (no ambient listening) + the closed-set resolver (a transcript may only resolve to a tag in the live queue). `PUSH_TO_TALK` is the API's own default mode name, so the design maps 1:1. Adapter transport recommendation from the contract: **one-shot POST for recorded walker clips** (one request, no WebSocket to hold open inside a serverless function, no pacing rules); streaming stays available if live partials are ever wanted. The voice build's stub-gated behavior is unaffected until the adapter flips live.

## Follow-ups created by this spike
- [ ] Adapter `modelId` defaults corrected to catalog IDs: sam.ts default is the placeholder `sam-3.1-unverified` → set `COPILOT_SAM_MODEL_ID=sam-3.1` in staging env (or correct the default); transcribe.ts default `muse-voice-transcribe-unverified` → `muse-voice-transcribe-1.0`; spark.ts default already `muse-spark-1.3` ✓
- [ ] Live Spark adapter: max_tokens ≥1000 (reasoning-token starvation fix, measured above)
- [ ] LiveSamAdapter implementation notes: parse the `output_text` segment format (`<|box;…|>` + `<|mask;…|>`) for boxes/masks; count via mask centroids inside the crop, as designed
- [x] Transcribe contract pinning from Meta docs/console — DONE Thu Oct 29 (evening dig): both transports pinned with endpoints, handshake, pacing rules, event schemas, `keywords` biasing parameter, caps and price → `~/workspace/ridertap/hackathon/TRANSCRIBE-CONTRACT.md`; spike built as `spikes/transcribe-stream-spike.ts` (ready, not run). Remaining unknown: anything published only on the login-gated dev.meta.ai API-reference portal (fetcher blocked here) — only chase it if the live gate hits a wall the contract doesn't explain.
- [ ] Adapter env flips (COPILOT_SAM_ADAPTER / COPILOT_SPARK_ADAPTER / COPILOT_TRANSCRIBE_ADAPTER = live) are JR's Netlify dashboard taps, followed by a redeploy — then the live gates run per model
- [x] Anything the spike disproved, recorded in BUILD-LOG the same day: the 200-token starvation, the 25s cold first call, and the Transcribe 404 are all in the Oct 29 BUILD-LOG entry

---
## MEASURED RUN — Thu Oct 29, 2026 (evening, run from main chat by Nova)
- Run by: Nova, server-side via a temporary function on staging DRAFT deploys (key stayed in Netlify env; never read/printed). 4 calls total. Spend ≈ $0.01 (SAM 2 images + Spark 2 calls) of $150 credits.
- SAM: model "sam-3.1" answered on JR's account. POST /v1/responses. Latencies: 1,230 ms and 822 ms (n=2). Still: Commons photo zone-crop 640×335, ground truth 3 cars → parsed 3 boxes + 3 masks (Meta native text format in output_text: <|box;...|> <|mask;...|>). DECISION C-01: sync viable (≈1s vs 8s ceiling), keep measuring.
- Spark: model "muse-spark-1.3" (STANDARD). Streaming + json_schema returned EMPTY content (HTTP 200, finish stop, 1,454 ms). Non-streaming returned schema-valid JSON in 2,575 ms: action check_tag, confidence 0.85, instruction 97 chars. DECISION: exception function calls Spark NON-streaming; 2.58s at minimal effort (287 reasoning tokens) is at the design edge → rule fallback stays armed (C-04 conservative reading).
- Transcribe: NOT RUN tonight — Fri integration.

## MEASURED RUN — Transcribe live (Thu Oct 29, 2026, evening, from main chat)
- One-shot POST /v1/asr/transcribe per TRANSCRIBE-CONTRACT.md §3, run server-side from a staging draft (key in Netlify env only). Clip: TTS "Three four five." 1.07s WAV, keywords = demo in-play tags, mode PUSH_TO_TALK.
- HTTP 200 · 1,118 ms · audioDurationMs 1120 · transcript "three four five?" — words exact; trailing "?" is model punctuation (resolver maps words→tag 345; punctuation never trusted). turns[] empty in PUSH_TO_TALK (top-level transcript is the surface). Session: voyager/transcribe/2F7F6B11B05C433587BE19823D6EAF56. Raw: ~/workspace/ridertap/hackathon/spike-run/voice-result.json.
- Status: contract CONFIRMED live. Remaining validation (JR's standard): n≥3 repeats + LiveTranscribeAdapter wiring + end-to-end live gate — Fri/Sat work blocks.
