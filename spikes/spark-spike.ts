// SPIKE — Muse Spark exception one-liner (R-05). READY, NOT RUN.
//
// Answers, with ONE streaming call on the SC-04 board state:
//   - Does the STANDARD model ID answer on JR's account? (Default from
//     research: "muse-spark-1.3". Contributor-priced IDs are FORBIDDEN
//     for this product — if the catalog only offers a contributor ID,
//     STOP and record that; do not spike on it.)
//   - At reasoning_effort=minimal: time-to-first-token and total latency
//     vs the product's ~2.5s design target (the C-04 trigger reads these).
//   - Does structured output hold (instruction ≤140 chars, action enum,
//     confidence present)? Is the confidence field reliable enough to be
//     a fallback trigger, or do we drop it (timeout + schema-validity
//     only)? — R-05 requires this decided from THIS run's evidence.
//
// Usage:
//   META_API_KEY=… bun spikes/spark-spike.ts [--effort low]

import { authHeaders, BASE_URL, requireKey, shapeOf } from "./lib";

const MODEL = process.env.COPILOT_SPARK_MODEL_ID ?? "muse-spark-1.3";
const effortArg = process.argv.indexOf("--effort");
const EFFORT = effortArg >= 0 ? process.argv[effortArg + 1] : "minimal";
const DESIGN_TARGET_MS = 2500;

// The SC-04 board state, in the compact shape the exception function sends.
const BOARD_STATE = {
  scenario: "zone_mismatch_plus_one",
  lane: "left",
  wave: 1,
  expected: 4,
  zoneCount: 5,
  tags: ["101", "102", "103", "104"],
  holds: [],
};

const SCHEMA = {
  name: "exception_instruction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      instruction: { type: "string", maxLength: 140 },
      action: {
        type: "string",
        enum: ["hold_wave", "release_wave", "check_tag", "call_office", "proceed"],
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["instruction", "action", "confidence"],
  },
};

const key = requireKey();
console.log(`Spark spike — model=${MODEL} reasoning_effort=${EFFORT} streaming=true`);
console.log(`endpoint: POST ${BASE_URL}/chat/completions`);

const started = performance.now();
const res = await fetch(`${BASE_URL}/chat/completions`, {
  method: "POST",
  headers: { ...authHeaders(key), "content-type": "application/json" },
  body: JSON.stringify({
    model: MODEL,
    reasoning_effort: EFFORT,
    stream: true,
    max_tokens: 200,
    response_format: { type: "json_schema", json_schema: SCHEMA },
    messages: [
      {
        role: "system",
        content:
          "You are the dismissal copilot for a school car-rider line. Given the board state, return ONE plain-language instruction (max 140 characters) for the dismissal lead, a machine action code, and your confidence. You are advisory only: never place or lift a hold yourself.",
      },
      { role: "user", content: JSON.stringify(BOARD_STATE) },
    ],
  }),
});
console.log(`HTTP ${res.status} · headers after ${Math.round(performance.now() - started)} ms`);
if (!res.ok || !res.body) {
  console.log(`error body: ${(await res.text()).slice(0, 800)}`);
  process.exit(1);
}

let ttftMs: number | null = null;
let content = "";
let finishReason: string | null = null;
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") continue;
    try {
      const chunk = JSON.parse(data);
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta && ttftMs === null) ttftMs = Math.round(performance.now() - started);
      content += delta;
      finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
    } catch {
      // non-JSON stream line (keep-alive etc.) — not spike data
    }
  }
}
const totalMs = Math.round(performance.now() - started);
console.log(`TTFT: ${ttftMs ?? "n/a"} ms · total: ${totalMs} ms · finish_reason: ${finishReason}`);
console.log(`raw content shape: ${shapeOf(content)}`);
console.log(`raw content: ${content.slice(0, 500)}`);

let schemaValid = false;
let parsed: any = null;
try {
  parsed = JSON.parse(content);
  schemaValid =
    typeof parsed.instruction === "string" &&
    parsed.instruction.length <= 140 &&
    SCHEMA.schema.properties.action.enum.includes(parsed.action) &&
    typeof parsed.confidence === "number";
} catch {
  schemaValid = false;
}
console.log(`structured output valid: ${schemaValid}`);
if (parsed) console.log(`parsed: ${JSON.stringify(parsed)}`);
console.log(
  `\ndesign target ≈${DESIGN_TARGET_MS} ms total → this run: ${totalMs <= DESIGN_TARGET_MS ? "INSIDE" : "OUTSIDE"} budget at effort=${EFFORT}.\n` +
    "Record in SPIKE-RESULTS.md: exact catalog model ID, TTFT, total, schema validity,\n" +
    "whether confidence was present and sane, and the C-04 reading (rule-first if slow).",
);
