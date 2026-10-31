// SAM adapter — the seam between the zone-check pipeline and Meta's SAM 3.1.
//
// The pipeline NEVER talks to the Meta Model API directly; it calls this
// interface. Two implementations:
//   - StubSamAdapter: scripted mask sets keyed by STILLS-PLAN asset IDs.
//     This is the grading/replay implementation (the scenario harnesses
//     force it via COPILOT_SAM_ADAPTER=stub). Ground truth comes from
//     test-assets/STILLS-PLAN.md §1; every mask set below is authored to
//     that table, and the graded count is what the PIPELINE computes from
//     the masks (label filter + centroid-in-crop rule), never a number the
//     stub hands over — the stub cannot cheat the count.
//   - LiveSamAdapter: the real SAM 3.1 call, built to the contract the
//     Oct 29 live spike MEASURED on JR's account (spikes/SPIKE-RESULTS.md):
//     POST /v1/responses, the cropped still as a base64 data URL, and the
//     answer as native segment text in output_text — boxes plus encoded
//     masks, decoded by src/sam-mask.ts into true mask centroids (the
//     boxes run loose; centroids come from the masks, never box centers).
//     It FAILS CLOSED: no key, an HTTP error, a timeout, or an
//     undecodable mask throws `live_adapter_error` before anything is
//     counted or persisted — a failed call produces no count and no flag,
//     never a fabricated number and never a silent stub substitution.
//
// Coordinate system (LOCK DEFAULT, Oct 27): the ROI *is* the on-device
// crop. The phone crops the still to the loading zone before upload, so
// every mask centroid is expressed in the CROPPED frame's normalized
// coordinates (0..1 on each axis). A vehicle whose centroid falls outside
// the crop (x or y outside 0..1) is not in the zone and does not count —
// that is the ST-11/ST-12 boundary pair, and why masks below may carry
// centroids slightly outside the frame.

export interface SamMask {
  /** What the mask is. The pipeline counts only masks matching the prompt. */
  label: string;
  /** Mask centroid, normalized to the cropped frame. May lie outside 0..1. */
  centroid: { x: number; y: number };
  /** Mask area as a fraction of the frame (0..1). Recorded, not graded. */
  area: number;
}

export interface SamCountInput {
  /** Asset ID when the still comes from the test/replay set (e.g. "ST-05"). */
  stillId?: string;
  /** Cropped still bytes (base64) when the still comes from a live phone. */
  imageBase64?: string;
  /** Lane this crop belongs to: 'left' | 'right' | 'main'. */
  lane: string;
  /** Text prompt for the segmentation call. Locked: "car". */
  prompt: string;
}

export interface SamCountResult {
  masks: SamMask[];
  latencyMs: number;
  modelId: string;
  source: "stub" | "live" | "replay";
}

export interface SamAdapter {
  readonly kind: "stub" | "live";
  readonly modelId: string;
  countVehicles(input: SamCountInput): Promise<SamCountResult>;
}

// ---------------------------------------------------------------- stub ---
// Scripted mask sets from STILLS-PLAN ground truth (§1). Car positions are
// spread across the crop the way staged cars sit in a loading zone; the
// non-car and boundary cases carry exactly the masks their table rows
// describe, so the pipeline's two filters (label, centroid-in-crop) are
// what produce the expected counts.

function car(x: number, y: number, area = 0.09): SamMask {
  return { label: "car", centroid: { x, y }, area };
}
function other(label: string, x: number, y: number, area = 0.05): SamMask {
  return { label, centroid: { x, y }, area };
}
/** n cars in a row-ish zone layout, centroids well inside the crop. */
function carsInZone(n: number): SamMask[] {
  const spots: Array<[number, number]> = [
    [0.16, 0.52], [0.34, 0.5], [0.52, 0.52], [0.7, 0.5], [0.88, 0.52],
    [0.16, 0.78], [0.34, 0.76], [0.52, 0.78], [0.7, 0.76], [0.88, 0.78],
  ];
  return spots.slice(0, n).map(([x, y]) => car(x, y));
}

/** stillId -> masks. Dual-lane stills (ST-13/14/15) are keyed `ST-13:left`. */
const SCRIPTED: Record<string, SamMask[]> = {
  // A. Count ladder (single-lane zone crop)
  "ST-01": [],
  "ST-02": carsInZone(1),
  "ST-03": carsInZone(2),
  "ST-04": carsInZone(3),
  "ST-05": carsInZone(4),
  "ST-06": carsInZone(5),
  "ST-07": carsInZone(6),
  "ST-08": carsInZone(7),
  "ST-09": carsInZone(8),
  "ST-10": carsInZone(9),
  // B. Partial entry — the centroid rule decides
  // ST-11: 5th car nosed in, centroid still OUTSIDE the crop edge → not counted.
  "ST-11": [...carsInZone(4), car(1.05, 0.5)],
  // ST-12: 5th car pulled in, centroid INSIDE the crop though bumper crosses → counted.
  "ST-12": [...carsInZone(4), car(0.96, 0.5)],
  // C. Dual-lane views (per-lane crops)
  "ST-13:left": carsInZone(4),
  "ST-13:right": carsInZone(4),
  "ST-14:left": carsInZone(3),
  "ST-14:right": carsInZone(5),
  // ST-15: approach-lane cars sit beyond the crop — they never reach the
  // adapter as in-frame masks; both lanes grade 4.
  "ST-15:left": carsInZone(4),
  "ST-15:right": carsInZone(4),
  // D. Empty-zone variants — reflections/shadows are not masks.
  "ST-16": [],
  "ST-17": [],
  // E. Non-car objects that must NOT count (label filter is graded here)
  "ST-18": [...carsInZone(3), other("traffic cone", 0.45, 0.85, 0.01), other("sign", 0.6, 0.85, 0.02)],
  "ST-19": [...carsInZone(2), other("person", 0.45, 0.45, 0.03), other("person", 0.6, 0.5, 0.03), other("person", 0.3, 0.6, 0.03)],
  "ST-20": [...carsInZone(4), other("bicycle", 0.97, 0.2, 0.02)],
  // Bus is on the road behind the zone — outside the crop entirely.
  "ST-21": [other("bus", 0.5, -0.25, 0.2)],
  // Parked car beyond the zone's end line — outside the crop.
  "ST-22": [...carsInZone(4), car(0.5, 1.08)],
  // F. Replay / demo frames
  "ST-23": carsInZone(5),
  "ST-24": [car(0.85, 0.5)], // one car mid-exit, centroid still inside
};

export class StubSamAdapter implements SamAdapter {
  readonly kind = "stub" as const;
  readonly modelId = "stub:sam-3.1-scripted";

  async countVehicles(input: SamCountInput): Promise<SamCountResult> {
    const started = performance.now();
    if (!input.stillId) {
      throw new Error(
        "stub_adapter_requires_still_id: the stub grades test-asset stills; live stills need the live adapter (not yet enabled)",
      );
    }
    const key = SCRIPTED[`${input.stillId}:${input.lane}`] !== undefined
      ? `${input.stillId}:${input.lane}`
      : input.stillId;
    const masks = SCRIPTED[key];
    if (!masks) {
      throw new Error(`stub_adapter_unknown_still: ${input.stillId} (lane ${input.lane})`);
    }
    // Return copies so a caller can never mutate the scripted ground truth.
    return {
      masks: masks.map((m) => ({ ...m, centroid: { ...m.centroid } })),
      latencyMs: Math.round(performance.now() - started),
      modelId: this.modelId,
      source: "stub",
    };
  }
}

// ---------------------------------------------------------------- live ---
import { parseSamSegments, decodeSegment } from "./sam-mask";

const META_BASE_URL = process.env.META_API_BASE_URL ?? "https://api.meta.ai/v1";
/** Measured worst case was ~4.3s on a 1152×2048 still (crops run ~1s). */
const SAM_TIMEOUT_MS = 20_000;

function liveError(reason: string): Error {
  return new Error(`live_adapter_error: ${reason}`);
}

/** The output_text lane of a Responses API result (first text part wins). */
export function extractSamOutputText(json: unknown): string | null {
  const output = (json as { output?: unknown })?.output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    const content = (item as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as { type?: unknown; text?: unknown };
      if (p?.type === "output_text" && typeof p.text === "string") return p.text;
    }
  }
  return null;
}

/**
 * Convert an output_text lane into pipeline masks: parse the segment
 * records, decode every mask, and express each mask's TRUE centroid
 * (from its decoded pixels, never the box center) and area in the
 * frame's normalized coordinates. ANY undecodable mask throws — a
 * partial decode would undercount, and an undercount is a fabricated
 * number. A structurally valid but empty mask (zero set pixels) is
 * skipped: it has no centroid and is no vehicle evidence.
 */
export function masksFromSamOutputText(text: string, prompt: string): SamMask[] {
  const masks: SamMask[] = [];
  for (const segment of parseSamSegments(text)) {
    const obj = decodeSegment(segment);
    if (!obj) continue;
    masks.push({
      label: prompt,
      centroid: {
        x: obj.centroidPx.x / segment.box.w,
        y: obj.centroidPx.y / segment.box.h,
      },
      area: obj.pixelCount / (segment.box.w * segment.box.h),
    });
  }
  return masks;
}

export class LiveSamAdapter implements SamAdapter {
  readonly kind = "live" as const;
  readonly modelId = process.env.COPILOT_SAM_MODEL_ID ?? "sam-3.1";

  async countVehicles(input: SamCountInput): Promise<SamCountResult> {
    const started = performance.now();
    const key = process.env.META_API_KEY;
    if (!key) {
      throw liveError(
        "META_API_KEY is not configured — the live SAM adapter cannot run. " +
          "Failing closed: no count is produced from a failed call.",
      );
    }
    if (!input.imageBase64) {
      throw liveError(
        "the live SAM adapter needs the cropped still bytes (imageBase64); " +
          "still IDs are the stub/replay path.",
      );
    }
    const imageUrl = input.imageBase64.startsWith("data:")
      ? input.imageBase64
      : `data:image/jpeg;base64,${input.imageBase64}`;

    let res: Response;
    try {
      res = await fetch(`${META_BASE_URL}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelId,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: input.prompt },
                { type: "input_image", image_url: imageUrl },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(SAM_TIMEOUT_MS),
      });
    } catch (e) {
      throw liveError(`SAM request failed (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!res.ok) {
      throw liveError(`SAM returned HTTP ${res.status}`);
    }
    const json: unknown = await res.json().catch(() => null);
    const text = extractSamOutputText(json);
    if (text === null) {
      throw liveError("SAM response carried no output_text lane");
    }

    // Decode every segment's mask (masksFromSamOutputText throws on
    // any undecodable mask — a partial decode would undercount, and an
    // undercount is a fabricated number). The frame bytes end their life
    // here — only the masks' centroids/areas cross into the pipeline,
    // and only the count crosses into persistence (zone.ts).
    let masks: SamMask[];
    try {
      masks = masksFromSamOutputText(text, input.prompt);
    } catch (e) {
      throw liveError(
        `SAM response could not be decoded (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const responseModel = (json as { model?: unknown })?.model;
    return {
      masks,
      latencyMs: Math.round(performance.now() - started),
      modelId: typeof responseModel === "string" ? responseModel : this.modelId,
      source: "live",
    };
  }
}

export function selectSamAdapter(): SamAdapter {
  const kind = (process.env.COPILOT_SAM_ADAPTER ?? "live").toLowerCase();
  if (kind === "live") return new LiveSamAdapter();
  if (kind !== "stub") {
    throw new Error(`unknown COPILOT_SAM_ADAPTER value: ${kind}`);
  }
  return new StubSamAdapter();
}
