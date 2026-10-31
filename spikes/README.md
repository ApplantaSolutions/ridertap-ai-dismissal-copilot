# Spikes — ready, not run

One-shot measurement scripts for the Meta Model API (PREBUILD-REVIEW
R-05). They exist so the minute JR's API key lands, the three unknowns
that Tue/Wed/Thu each bet a build day on become measured facts in one
short session — recorded in `SPIKE-RESULTS.md` in this folder.

| Script | Model | The one question it answers first |
|---|---|---|
| `sam-spike.ts` | SAM 3.1 (`sam-3.1`) | Real end-to-end latency on a real still → sync vs async zone-check (C-01) |
| `spark-spike.ts` | Muse Spark (`muse-spark-1.3`, STANDARD only) | TTFT + total latency + structured-output validity at minimal effort → the C-04 reading |
| `transcribe-spike.ts` | Muse Voice Transcribe (`muse-voice-transcribe-1.0`) | The real input contract (streaming? file? biasing param?) → the C-07 decision |

Rules (enforced in `lib.ts`):
- Key from `META_API_KEY` env only; never printed, never written anywhere.
- No key → the script explains itself and exits 2 with **zero** network calls.
- Minimum calls: one per spike (SAM accepts `--image` for a real still;
  without it, a labeled 1×1 contract probe).
- Model IDs are env-overridable (`COPILOT_SAM_MODEL_ID`,
  `COPILOT_SPARK_MODEL_ID`, `COPILOT_TRANSCRIBE_MODEL_ID`) because R-05
  requires the allowlist to be written from JR's live catalog, not from
  research — if the catalog spells an ID differently, set it and record it.
