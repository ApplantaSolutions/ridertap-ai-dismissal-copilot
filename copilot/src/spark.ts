// Spark adapter — the seam between the exception service and Meta's
// Muse Spark, mirroring src/sam.ts (Build 1's SAM seam).
//
// The exception service NEVER talks to the Meta Model API directly; it
// calls this interface. Two implementations:
//   - StubSparkAdapter: returns the SCRIPTED ACCEPTABLE LINE for the
//     trigger (test-assets/EXCEPTION-SCRIPTS.md), composed from the
//     payload's own tag/count/wave values. This is the grading
//     implementation (the scenario harnesses force it via
//     COPILOT_SPARK_ADAPTER=stub).
//   - LiveSparkAdapter: the real Muse Spark call, built to the contract
//     the Oct 29 live spike MEASURED on JR's account
//     (spikes/SPIKE-RESULTS.md): POST /v1/chat/completions,
//     NON-STREAMING (streaming + json_schema returned empty content),
//     strict json_schema output, reasoning_effort minimal, and
//     max_tokens ≥ 1000 — at 200 the model spent ~198 tokens reasoning
//     and emitted nothing. Median warm latency ~2.55s sits at the design
//     edge, so the exception service's 3s hard cap + verbatim rule
//     fallback (src/exceptions.ts, src/fallbacks.ts) remain the primary
//     path for safety-shaped cases; this adapter only ever ADDS a line
//     when it answers in time and in shape. Any failure — no key, HTTP
//     error, timeout, empty or malformed completion — throws
//     `live_adapter_error` and the service falls back; the adapter never
//     fabricates a line and never falls back to the stub silently.
//
// STANDARD MODEL ID ONLY (spec v2, non-negotiable): the standard Muse
// Spark ID is `muse-spark-1.3`. A Contributor-priced model ID trains on
// prompts and is FORBIDDEN anywhere in this product — the literal ID is
// kept out of this file on purpose, and the live adapter refuses to run
// if the configured ID even names that pricing tier (fail closed).

import type { BoardStateSummary, ExceptionAction, ExceptionLine } from "./exceptions";

export interface SparkAdviceResult extends ExceptionLine {
  latencyMs: number;
  modelId: string;
  source: "stub" | "live";
}

export interface SparkAdapter {
  readonly kind: "stub" | "live";
  readonly modelId: string;
  advise(payload: BoardStateSummary): Promise<SparkAdviceResult>;
}

// ------------------------------------------------------------- helpers ---
const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve",
];
function word(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}
function capWord(n: number): string {
  const w = word(n);
  return w.charAt(0).toUpperCase() + w.slice(1);
}
function laneName(lane: string): string {
  return lane === "main" ? "Main" : lane.charAt(0).toUpperCase() + lane.slice(1);
}
/** "L1" -> "1", "R2" -> "2" (the scripted duplicate line says "Wave 1"). */
function waveNumber(waveId: string): string {
  return waveId.replace(/^[A-Za-z]+/, "");
}
/** ["201","202","204"] -> "201, 202, and 204" (scripted list style). */
function tagList(tags: string[]): string {
  if (tags.length <= 1) return tags.join("");
  if (tags.length === 2) return `${tags[0]} and ${tags[1]}`;
  return `${tags.slice(0, -1).join(", ")}, and ${tags[tags.length - 1]}`;
}

// ---------------------------------------------------------------- stub ---
// Each branch composes the case's scripted ACCEPTABLE line from the
// payload — the reference wording in EXCEPTION-SCRIPTS.md, with the
// payload's tags/counts/wave in the slots. The service still validates
// every line (one sentence, ≤140 chars, action enum, prohibited guard);
// the stub does not get a free pass.
export class StubSparkAdapter implements SparkAdapter {
  readonly kind = "stub" as const;
  readonly modelId = "stub:muse-spark-scripted";
  private readonly delayMs: number;

  constructor(opts: { delayMs?: number } = {}) {
    // Harness-only artificial delay (timeout drill): the gate constructs
    // the stub with delayMs past the 3s cap, or sets the env var. Never
    // set in any deployed environment.
    this.delayMs =
      opts.delayMs ?? Number(process.env.COPILOT_SPARK_STUB_DELAY_MS ?? 0);
  }

  async advise(payload: BoardStateSummary): Promise<SparkAdviceResult> {
    const started = performance.now();
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    const line = this.compose(payload);
    return {
      ...line,
      latencyMs: Math.round(performance.now() - started),
      modelId: this.modelId,
      source: "stub",
    };
  }

  private compose(p: BoardStateSummary): ExceptionLine {
    switch (p.trigger) {
      case "zone_mismatch": {
        const zone = p.zone!;
        const wave = p.wave!;
        if (zone.count > zone.expected) {
          return {
            instruction:
              `${capWord(zone.count)} cars in the zone but Wave ${wave.id} has ${word(zone.expected)} — ` +
              "hold the wave and check for an extra car before loading.",
            action: "hold_wave" as ExceptionAction,
          };
        }
        return {
          instruction:
            `Only ${word(zone.count)} cars in the zone for Wave ${wave.id}'s ${word(zone.expected)} tags — ` +
            "check which called car is missing before loading.",
          action: "check_tag" as ExceptionAction,
        };
      }
      case "out_of_order": {
        const arrived = String(p.detail?.arrived_tag ?? "");
        const skipped = String(p.detail?.skipped_tag ?? "");
        return {
          instruction:
            `${arrived} arrived before ${skipped} — keep the board order and call ` +
            `${skipped}'s student with this wave as planned.`,
          action: "info",
        };
      }
      case "duplicate": {
        const entry = p.entries?.[0];
        const tag = String(p.detail?.attempted_tag ?? entry?.tag ?? "");
        const lane = String(p.detail?.attempted_lane ?? entry?.lane ?? "");
        return {
          instruction:
            `${tag} is already queued in ${laneName(lane)}, Wave ${waveNumber(entry?.wave ?? "")}, ` +
            `spot ${entry?.spot ?? "—"} — don't enter it again; the first entry stands.`,
          action: "info",
        };
      }
      case "hold_placed": {
        const tag = p.holds?.[0] ?? "";
        const wave = p.wave!;
        if (wave.status === "loading") {
          const others = (p.entries ?? [])
            .filter((e) => e.tag !== tag)
            .map((e) => e.tag);
          return {
            instruction:
              `${tag} is now on hold mid-wave — stop ${tag} here and finish loading ` +
              `${tagList(others)} around it.`,
            action: "keep_out_of_wave",
          };
        }
        return {
          instruction:
            `${tag} is on hold — keep it out of Wave ${wave.id}'s loading ` +
            "until the office clears the hold.",
          action: "keep_out_of_wave",
        };
      }
      case "walk_up": {
        const tag = String(p.detail?.walk_up_tag ?? p.entries?.[0]?.tag ?? "");
        return {
          instruction:
            `${tag} is a walk-up, not a car — call the student to the pickup point ` +
            "and keep them out of the vehicle waves.",
          action: "keep_out_of_wave",
        };
      }
      case "no_show_candidate": {
        const tags = (p.detail?.still_waiting_tags as string[] | undefined) ?? [];
        const tag = tags[0] ?? p.entries?.[0]?.tag ?? "";
        return {
          instruction:
            `${tag} never arrived — office should contact the guardian; ` +
            "mark it no-show only when you confirm.",
          action: "sweep",
        };
      }
      default:
        throw new Error(`stub_adapter_unknown_trigger: ${String((p as { trigger: unknown }).trigger)}`);
    }
  }
}

// ---------------------------------------------------------------- live ---
const META_BASE_URL = process.env.META_API_BASE_URL ?? "https://api.meta.ai/v1";
/**
 * Reasoning tokens bill INSIDE max_tokens: the spike measured ~287–354
 * reasoning tokens per call at minimal effort, and a 200 cap starved the
 * answer entirely (empty content, HTTP 200). 1500 leaves the measured
 * headroom several times over.
 */
export const SPARK_MAX_TOKENS = 1500;
export const SPARK_EFFORT = "minimal";
/**
 * The service races the adapter against its own 3s cap and discards a
 * late line; this longer fetch ceiling only exists so an abandoned
 * request dies instead of hanging the function.
 */
const SPARK_FETCH_TIMEOUT_MS = 10_000;

/** The product action enum (exceptions.ts) — the schema's allowed set. */
const SPARK_ACTIONS: readonly string[] = [
  "hold_wave", "check_tag", "keep_out_of_wave", "sweep", "info",
];

/**
 * Strict structured-output schema, same shape as spikes/spark-spike.ts
 * (name / strict / instruction ≤140 / confidence 0..1 / all required),
 * with the action enum set to the PRODUCT's advisory enum from
 * EXCEPTION-SCRIPTS.md — the spike's probe enum (release_wave /
 * call_office / proceed) names actions this product forbids, and the
 * exception service discards any line carrying one.
 */
export const SPARK_RESPONSE_SCHEMA = {
  name: "exception_instruction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      instruction: { type: "string", maxLength: 140 },
      action: { type: "string", enum: [...SPARK_ACTIONS] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["instruction", "action", "confidence"],
  },
} as const;

const SPARK_SYSTEM_PROMPT =
  "You are the dismissal copilot for a school car-rider line. Given the board state, " +
  "return ONE plain-language instruction (max 140 characters) for the dismissal lead, " +
  "a machine action code, and your confidence. The instruction is a single sentence " +
  "naming the tag number(s) involved. You are advisory only: never place or lift a " +
  "hold yourself, never release a wave, never load a held tag, and never put a " +
  "walk-up in a vehicle wave.";

/**
 * Per-trigger scenario semantics for the live model — the context the
 * compact payload alone cannot carry. Written from EXCEPTION-SCRIPTS.md;
 * they describe the situation, never the wording (the deterministic
 * fallback texts in src/fallbacks.ts are untouched and stay primary for
 * safety-shaped cases).
 *
 * The walk_up brief carries the B8 fix: in the Oct 29 10× battery, Spark
 * answered a walk-up on a zone-VERIFIED wave with hold_wave. EX-07's
 * semantics are the opposite — a walk-up is a person, not a vehicle; it
 * does not change the expected vehicle count, and a verified wave is not
 * held for it. The instruction belongs to the walk-up tag and the walker
 * procedure (keep_out_of_wave), never to the wave.
 */
export const SPARK_SCENARIO_BRIEFS: Record<BoardStateSummary["trigger"], string> = {
  zone_mismatch:
    "The camera count for the wave's lane disagrees with the number of tags called " +
    "for the wave. Vision counts vehicles only and cannot know WHICH car is extra " +
    "or missing, so never blame a specific tag. More cars than expected: hold the " +
    "wave and check the extra car. Fewer: check for the missing car before loading.",
  duplicate:
    "A tag that is already on the board was entered again. The first entry stands: " +
    "the duplicate is never entered and the original entry is never removed or replaced.",
  hold_placed:
    "A human has ALREADY placed a safety hold on the tag — the hold is live and " +
    "never waited on you. The held tag stays out of loading until the office clears " +
    "the hold. If the wave is actively loading, the rest of the wave continues " +
    "around the held tag; the hold changes nothing else.",
  out_of_order:
    "A tag arrived ahead of an earlier-queued tag in the same wave. Board order is " +
    "kept as planned; the skipped tag's student is called with this wave. Never " +
    "reorder the wave, move a tag to another wave, or drop a tag.",
  walk_up:
    "A parent is on foot collecting their child — a walk-up, flagged by a human. " +
    "A walk-up is a person, not a vehicle: it does NOT change the number of " +
    "vehicles expected in the zone. If the zone count matches the expected count, " +
    "the wave is verified and must NOT be held for the walk-up. The instruction " +
    "concerns only the walk-up tag: direct it to the pickup point / walker " +
    "procedure and keep the walk-up out of the vehicle waves.",
  no_show_candidate:
    "The dismissal lead opened the Still Waiting sweep and these called tags never " +
    "arrived. The office contacts the guardian; a tag is marked no-show only by a " +
    "human after that contact, never by you.",
};

/** The exact request body the live adapter sends (unit-test surface). */
export function buildSparkRequest(modelId: string, payload: BoardStateSummary) {
  return {
    model: modelId,
    reasoning_effort: SPARK_EFFORT,
    max_tokens: SPARK_MAX_TOKENS,
    response_format: { type: "json_schema", json_schema: SPARK_RESPONSE_SCHEMA },
    messages: [
      { role: "system", content: SPARK_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          scenario: SPARK_SCENARIO_BRIEFS[payload.trigger],
          board_state: payload,
        }),
      },
    ],
  };
}

/**
 * Parse a chat-completion result into an exception line, or null when
 * the completion is empty, non-JSON, or off-shape (wrong types, over
 * length, action outside the product enum, confidence out of range).
 * Null is the adapter's fallback trigger: the exception service shows
 * the verbatim rule-fallback line instead. (The service additionally
 * re-validates the line — sentence shape and prohibited instructions —
 * before anything is displayed.)
 */
export function parseSparkCompletion(json: unknown): ExceptionLine | null {
  const content = (
    json as { choices?: Array<{ message?: { content?: unknown } }> }
  )?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { instruction, action, confidence } = parsed as Record<string, unknown>;
  if (typeof instruction !== "string") return null;
  const line = instruction.trim();
  if (line === "" || line.length > 140) return null;
  if (typeof action !== "string" || !SPARK_ACTIONS.includes(action)) return null;
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return null;
  return { instruction: line, action: action as ExceptionAction };
}

function liveError(reason: string): Error {
  return new Error(`live_adapter_error: ${reason}`);
}

export class LiveSparkAdapter implements SparkAdapter {
  readonly kind = "live" as const;
  readonly modelId = process.env.COPILOT_SPARK_MODEL_ID ?? "muse-spark-1.3";

  async advise(payload: BoardStateSummary): Promise<SparkAdviceResult> {
    // Fail closed on a Contributor-priced ID before anything else: that
    // tier trains on prompts and is forbidden for this product (spec v2).
    if (/contributor/i.test(this.modelId)) {
      throw new Error(
        "contributor_model_forbidden: the configured Spark model ID names the " +
          "Contributor pricing tier, which trains on prompts. Standard model ID only.",
      );
    }
    const started = performance.now();
    const key = process.env.META_API_KEY;
    if (!key) {
      throw liveError(
        "META_API_KEY is not configured — the live Spark adapter cannot run. " +
          "The exception service will show the rule-fallback line.",
      );
    }
    let res: Response;
    try {
      res = await fetch(`${META_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(buildSparkRequest(this.modelId, payload)),
        signal: AbortSignal.timeout(SPARK_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      throw liveError(`Spark request failed (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!res.ok) {
      throw liveError(`Spark returned HTTP ${res.status}`);
    }
    const json: unknown = await res.json().catch(() => null);
    const line = parseSparkCompletion(json);
    if (!line) {
      // Measured failure mode (Oct 29): HTTP 200 with empty content.
      // That is a fallback trigger, never a line.
      throw liveError("Spark returned an empty or malformed completion");
    }
    return {
      ...line,
      latencyMs: Math.round(performance.now() - started),
      modelId: this.modelId,
      source: "live",
    };
  }
}

export function selectSparkAdapter(): SparkAdapter {
  const kind = (process.env.COPILOT_SPARK_ADAPTER ?? "live").toLowerCase();
  if (kind === "live") return new LiveSparkAdapter();
  if (kind !== "stub") {
    throw new Error(`unknown COPILOT_SPARK_ADAPTER value: ${kind}`);
  }
  return new StubSparkAdapter();
}
