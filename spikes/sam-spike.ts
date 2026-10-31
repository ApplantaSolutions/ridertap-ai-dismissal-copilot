// SPIKE — SAM 3.1 image count (R-05). READY, NOT RUN (no key exists yet).
//
// Answers, with ONE call:
//   - Does model "sam-3.1" answer on JR's account via the Responses API?
//   - End-to-end latency on a real zone still → decides sync vs async
//     zone-check (C-01: p95 > 8s or any timeout ⇒ async pattern).
//   - The raw response shape: where boxes/encoded masks live, and what
//     decoding (meta-sam-parser) the live adapter will need.
//
// Usage (the minute JR's key exists):
//   META_API_KEY=… bun spikes/sam-spike.ts --image path/to/ST-05.jpg
//   META_API_KEY=… COPILOT_SAM_MODEL_ID=<catalog id> bun spikes/sam-spike.ts --image …
// Without --image it sends a 1×1 contract probe and labels it as such —
// that measures auth/endpoint/shape ONLY, never representative latency.
// Model ID default comes from the Oct 25 research; R-05 requires writing
// the ID exactly as it appears in JR's account catalog into
// SPIKE-RESULTS.md and correcting this default if the catalog differs.

import { authHeaders, BASE_URL, requireKey, shapeOf, timedFetch } from "./lib";

const MODEL = process.env.COPILOT_SAM_MODEL_ID ?? "sam-3.1";
const PROMPT = "car"; // locked test configuration (STILLS-PLAN §1)

const imgArg = process.argv.indexOf("--image");
const imagePath = imgArg >= 0 ? process.argv[imgArg + 1] : undefined;

// 1×1 white JPEG — contract probe only.
const PROBE_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==";

let imageB64 = PROBE_JPEG_B64;
let imageNote = "1x1 CONTRACT PROBE (not a real still — latency is NOT representative)";
if (imagePath) {
  imageB64 = Buffer.from(await Bun.file(imagePath).arrayBuffer()).toString("base64");
  imageNote = `real still: ${imagePath}`;
}

const key = requireKey();
console.log(`SAM spike — model=${MODEL} prompt="${PROMPT}" image=${imageNote}`);
console.log(`endpoint: POST ${BASE_URL}/responses`);

const body = {
  model: MODEL,
  input: [
    {
      role: "user",
      content: [
        { type: "input_text", text: PROMPT },
        { type: "input_image", image_url: `data:image/jpeg;base64,${imageB64}` },
      ],
    },
  ],
};

const { res, ms } = await timedFetch(`${BASE_URL}/responses`, {
  method: "POST",
  headers: { ...authHeaders(key), "content-type": "application/json" },
  body: JSON.stringify(body),
});

const text = await res.text();
console.log(`HTTP ${res.status} · total latency ${ms} ms`);
let json: unknown = null;
try {
  json = JSON.parse(text);
} catch {
  console.log(`response is not JSON; first 800 chars:\n${text.slice(0, 800)}`);
  process.exit(res.ok ? 0 : 1);
}
console.log(`response shape: ${shapeOf(json)}`);
console.log(`response excerpt: ${text.slice(0, 800)}`);
if (!res.ok) process.exit(1);
console.log(
  "\nRecord in SPIKE-RESULTS.md: exact catalog model ID, this latency, the shape above,\n" +
    "where the encoded masks live, and (after decoding with meta-sam-parser) the mask count\n" +
    "vs the still's ground truth. Then make the C-01 sync/async call.",
);
