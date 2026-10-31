// SAM 3.1 mask codec — decodes the Meta Model API's native segmentation
// text format into binary rasters so the zone pipeline can compute TRUE
// mask centroids (the API's boxes run loose; the masks are the precise
// layer — SPIKE-RESULTS, Oct 29).
//
// Wire format (Meta's SAM 3 protocol, protocol/sam3.md in
// github.com/meta-models/meta-sam): one output_text line per frame,
// records of `id<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>` followed by
// `<|mask;x=0;y=0;data=<H>,<W>,<payload>|>`. The mask raster covers
// exactly the box (H = y2-y1+1, W = x2-x1+1, inclusive wire corners).
//
// Payload: a marker char (`~` = lossless, the API default; `!` = one_bit)
// then base85 digits (printable ASCII `!`..`{` minus the wire delimiters
// `" \ , ; < > |`). After the marker: a 5-digit base85 length prefix
// (byte length of the packed body), then the body packed 4 bytes per
// 5 digits. The body is an arithmetic/range-coded stream:
//   - one_bit: the binary raster coded directly with a 12-bit padded
//     spatial context model.
//   - lossless: per-pixel coverage bytes coded with a zero/nonzero gate
//     plus order-0/1/2 residual models, then a spatial predictor
//     (Paeth/up/left/average/MED, selected by the body's first byte) and
//     zigzag residual reconstruction; the binary mask thresholds the
//     coverage at 129.
//
// This is a from-the-spec port of Meta's reference decoder
// (meta-sam-parser, SAM License) — the arithmetic models must match the
// encoder bit-for-bit or the stream desynchronizes, so every constant
// and update rule below mirrors the reference exactly. Validated against
// the reference implementation's published conformance vectors and
// captured API payloads (see scripts/run-unit-tests.ts).

export class SamMaskDecodeError extends Error {
  constructor(reason: string) {
    super(`sam_mask_decode: ${reason}`);
    this.name = "SamMaskDecodeError";
  }
}
function invalid(reason: string): never {
  throw new SamMaskDecodeError(reason);
}

// ------------------------------------------------------------- base85 ---
const ALPHABET = (() => {
  const excluded = new Set(['"', "\\", ",", ";", "<", ">", "|"]);
  let s = "";
  for (let code = 0x21; code <= 0x7e; code++) {
    const ch = String.fromCharCode(code);
    if (!excluded.has(ch)) s += ch;
  }
  return s;
})();
const RADIX = 85;
const PREFIX_LENGTH = 5;
const CHAR_VALUE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) CHAR_VALUE[ALPHABET.charCodeAt(i)] = i;

function digit(ch: string): number {
  const code = ch.charCodeAt(0);
  const v = code < 128 ? CHAR_VALUE[code] : -1;
  if (v < 0 || v >= RADIX) invalid("payload contains an invalid character");
  return v;
}

const MASK_32 = 0xffffffff;
const u32 = (v: number): number => v >>> 0; // inputs are exact doubles < 2^53

/** Canonical packing (the reference's `_pack`) — used for round-trip checks. */
function packBytes(input: Uint8Array): string {
  const length = input.length;
  let remaining = length;
  const prefix = new Array<string>(PREFIX_LENGTH);
  for (let i = PREFIX_LENGTH - 1; i >= 0; i--) {
    prefix[i] = ALPHABET[remaining % RADIX];
    remaining = Math.floor(remaining / RADIX);
  }
  if (remaining !== 0) invalid("payload is too large");
  const out: string[] = [...prefix];
  const full = length - (length % 4);
  let offset = 0;
  while (offset < full) {
    let value = u32(
      input[offset] * 0x1000000 + input[offset + 1] * 0x10000 +
        input[offset + 2] * 0x100 + input[offset + 3],
    );
    const digits = new Array<number>(5);
    for (let i = 4; i >= 0; i--) {
      digits[i] = value % RADIX;
      value = (value - digits[i]) / RADIX;
    }
    for (const d of digits) out.push(ALPHABET[d]);
    offset += 4;
  }
  const remainder = length - offset;
  if (remainder > 0) {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      value = u32(value * 256 + (i < remainder ? input[offset + i] : 0));
    }
    const digits = new Array<number>(5);
    for (let i = 4; i >= 0; i--) {
      digits[i] = value % RADIX;
      value = (value - digits[i]) / RADIX;
    }
    for (let i = 0; i < remainder + 1; i++) out.push(ALPHABET[digits[i]]);
  }
  return out.join("");
}

/** Base85 unpack with the reference's strict canonical-form check. */
function unpackPayload(payload: string): Uint8Array {
  if (payload.length < PREFIX_LENGTH) invalid("payload is missing its length prefix");
  let length = 0;
  for (let i = 0; i < PREFIX_LENGTH; i++) length = length * RADIX + digit(payload[i]);
  const remainder = length % 4;
  const expected =
    PREFIX_LENGTH + Math.floor(length / 4) * 5 + (remainder === 0 ? 0 : remainder + 1);
  if (payload.length !== expected) invalid("payload length does not match its prefix");

  const output = new Uint8Array(length);
  let source = PREFIX_LENGTH;
  let destination = 0;
  const full = length - remainder;
  while (destination < full) {
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * RADIX + digit(payload[source + i]);
    if (value > MASK_32) invalid("payload contains an out-of-range group");
    source += 5;
    output[destination] = (value >>> 24) & 0xff;
    output[destination + 1] = (value >>> 16) & 0xff;
    output[destination + 2] = (value >>> 8) & 0xff;
    output[destination + 3] = value & 0xff;
    destination += 4;
  }
  if (remainder > 0) {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      value = value * RADIX + (i < remainder + 1 ? digit(payload[source + i]) : RADIX - 1);
    }
    if (value > MASK_32) invalid("payload contains an out-of-range tail");
    for (let i = 0; i < remainder; i++) {
      output[destination + i] = (value >>> (24 - i * 8)) & 0xff;
    }
  }
  if (packBytes(output) !== payload) invalid("payload is not in canonical form");
  return output;
}

// -------------------------------------------------------- range coder ---
const TOP = 1 << 24;
const BOTTOM = 1 << 16;

class RangeDecoder {
  private code = 0;
  private low = 0;
  private range = MASK_32;
  private scaled = 0;
  private position = 0;
  constructor(private readonly input: Uint8Array) {
    if (input.length < 4) invalid("payload is missing its finalization");
    for (let i = 0; i < 4; i++) this.code = u32(this.code * 256 + this.read());
  }
  private read(): number {
    if (this.position >= this.input.length) {
      invalid("payload ended before decoding completed");
    }
    return this.input[this.position++];
  }
  frequency(total: number): number {
    this.scaled = Math.floor(this.range / total);
    if (this.scaled === 0) invalid("payload has invalid coding state");
    const value = Math.floor((this.code - this.low) / this.scaled);
    return value >= total ? total - 1 : value;
  }
  decode(cumulative: number, frequency: number): void {
    this.low = u32(this.low + this.scaled * cumulative);
    this.range = this.scaled * frequency;
    for (;;) {
      if (u32(this.low ^ u32(this.low + this.range)) < TOP) {
        // renorm
      } else if (this.range < BOTTOM) {
        this.range = u32(-this.low) & (BOTTOM - 1);
      } else {
        break;
      }
      this.code = u32(this.code * 256 + this.read());
      this.low = u32(this.low * 256);
      this.range = u32(this.range * 256);
    }
  }
}

class RangeEncoder {
  private low = 0;
  private range = MASK_32;
  private readonly output: number[] = [];
  encode(cumulative: number, frequency: number, total: number): void {
    const scaled = Math.floor(this.range / total);
    this.low = u32(this.low + scaled * cumulative);
    this.range = scaled * frequency;
    for (;;) {
      if (u32(this.low ^ u32(this.low + this.range)) < TOP) {
        // renorm
      } else if (this.range < BOTTOM) {
        this.range = u32(-this.low) & (BOTTOM - 1);
      } else {
        break;
      }
      this.output.push((this.low >>> 24) & 0xff);
      this.low = u32(this.low * 256);
      this.range = u32(this.range * 256);
    }
  }
  finish(): Uint8Array {
    for (let i = 0; i < 4; i++) {
      this.output.push((this.low >>> 24) & 0xff);
      this.low = u32(this.low * 256);
    }
    return Uint8Array.from(this.output);
  }
}

// ------------------------------------------------------------ one_bit ---
const INCREMENT = 14;
const COUNT_LIMIT = 4096;
const CONTEXT_COUNT = 1 << 12;
const PADDING = 2;

function contextAt(
  raster: Uint8Array,
  position: number,
  prior: number,
  earlier: number,
): number {
  return (
    raster[position - 1] |
    (raster[position - 2] << 1) |
    (raster[prior - 2] << 2) |
    (raster[prior - 1] << 3) |
    (raster[prior] << 4) |
    (raster[prior + 1] << 5) |
    (raster[prior + 2] << 6) |
    (raster[earlier - 2] << 7) |
    (raster[earlier - 1] << 8) |
    (raster[earlier] << 9) |
    (raster[earlier + 1] << 10) |
    (raster[earlier + 2] << 11)
  );
}

function updateCounts(counts: Uint16Array, offset: number, bit: number): void {
  counts[offset + bit] = (counts[offset + bit] + INCREMENT) & 0xffff;
  if (counts[offset] + counts[offset + 1] >= COUNT_LIMIT) {
    counts[offset] = (counts[offset] >> 1) || 1;
    counts[offset + 1] = (counts[offset + 1] >> 1) || 1;
  }
}

function decodeOneBitRaster(payload: string, width: number, height: number): Uint8Array {
  const decoder = new RangeDecoder(unpackPayload(payload.slice(1)));
  const counts = new Uint16Array(CONTEXT_COUNT * 2).fill(1);
  const paddedWidth = width + 2 * PADDING;
  const padded = new Uint8Array(paddedWidth * (height + PADDING));
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = (y + PADDING) * paddedWidth + PADDING;
    for (let x = 0; x < width; x++) {
      const position = row + x;
      const context = contextAt(padded, position, position - paddedWidth, position - 2 * paddedWidth);
      const offset = context << 1;
      const zero = counts[offset];
      const one = counts[offset + 1];
      const value = decoder.frequency(zero + one);
      const bit = value < zero ? 0 : 1;
      if (bit === 0) decoder.decode(0, zero);
      else decoder.decode(zero, one);
      padded[position] = bit;
      output[y * width + x] = bit;
      updateCounts(counts, offset, bit);
    }
  }
  return output;
}

function encodeOneBitRaster(input: Uint8Array, width: number, height: number): string {
  const encoder = new RangeEncoder();
  const counts = new Uint16Array(CONTEXT_COUNT * 2).fill(1);
  const paddedWidth = width + 2 * PADDING;
  const padded = new Uint8Array(paddedWidth * (height + PADDING));
  for (let y = 0; y < height; y++) {
    const row = (y + PADDING) * paddedWidth + PADDING;
    for (let x = 0; x < width; x++) {
      const position = row + x;
      const context = contextAt(padded, position, position - paddedWidth, position - 2 * paddedWidth);
      const offset = context << 1;
      const zero = counts[offset];
      const one = counts[offset + 1];
      const bit = input[y * width + x];
      if (bit !== 0 && bit !== 1) invalid("decoded mask is not binary");
      if (bit === 0) encoder.encode(0, zero, zero + one);
      else encoder.encode(zero, one, zero + one);
      padded[position] = bit;
      updateCounts(counts, offset, bit);
    }
  }
  return "!" + packBytes(encoder.finish());
}

// ----------------------------------------------------------- lossless ---
const SYMBOLS = 256;
const TOTAL_INDEX = SYMBOLS;
const SPATIAL_MODES = 5;
const ZERO_INCREMENT = 32;
const ZERO_LIMIT = 16384;
const ORDER_ONE_INCREMENT = 56;
const ORDER_ONE_LIMIT = 8192;
const ORDER_TWO_STEP = 14 * 44;
const ORDER_TWO_LIMIT = 14 * 3584;
const ORDER_ZERO_STEP = 2 * 16;
const ORDER_ZERO_LIMIT = 2 * 2048;
const ORDER_ZERO_INITIAL = 2;
const ORDER_ONE_INITIAL = 1;

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function predictByte(
  output: Uint8Array,
  offset: number,
  x: number,
  y: number,
  mode: number,
  width: number,
): number {
  if (mode < 0 || mode >= SPATIAL_MODES) invalid("lossless payload uses an invalid predictor");
  const left = x > 0 ? output[offset - 1] : 0;
  const up = y > 0 ? output[offset - width] : 0;
  if (mode === 1) return up;
  if (mode === 2) return left;
  if (mode === 3) return (left + up) >> 1;
  const upperLeft = x > 0 && y > 0 ? output[offset - width - 1] : 0;
  if (mode === 0) return paeth(left, up, upperLeft);
  if (upperLeft >= Math.max(left, up)) return Math.min(left, up);
  if (upperLeft <= Math.min(left, up)) return Math.max(left, up);
  return left + up - upperLeft;
}

function unzig(value: number, prediction: number): number {
  const delta = value & 1 ? -((value + 1) >> 1) : value >> 1;
  return (prediction + delta) & 0xff;
}

function zeroContext(
  residuals: Uint8Array,
  offset: number,
  x: number,
  y: number,
  width: number,
): number {
  const left = x > 0 ? (residuals[offset - 1] === 0 ? 1 : 0) : 1;
  const up = y > 0 ? (residuals[offset - width] === 0 ? 1 : 0) : 1;
  const upperLeft = x > 0 && y > 0 ? (residuals[offset - width - 1] === 0 ? 1 : 0) : 1;
  const upperRight = y > 0 && x < width - 1 ? (residuals[offset - width + 1] === 0 ? 1 : 0) : 1;
  return left | (up << 1) | (upperLeft << 2) | (upperRight << 3);
}

function decodeLosslessCoverage(payload: string, width: number, height: number): Uint8Array {
  const packed = unpackPayload(payload.slice(1));
  if (packed.length < 5) invalid("lossless payload is truncated");
  const selector = packed[0];
  const decoder = new RangeDecoder(packed.subarray(1));
  const length = width * height;
  const output = new Uint8Array(length);
  const residuals = new Uint8Array(length);
  const zeroCounts = new Uint32Array(32).fill(1);
  const orderOne = new Uint16Array(SYMBOLS * SYMBOLS).fill(ORDER_ONE_INITIAL);
  const orderOneTotals = new Int32Array(SYMBOLS).fill(SYMBOLS * ORDER_ONE_INITIAL);
  const orderZero = new Uint16Array(SYMBOLS).fill(ORDER_ZERO_INITIAL);
  let orderZeroTotal = SYMBOLS * ORDER_ZERO_INITIAL;
  const orderTwo = new Map<number, Uint16Array>();
  const getOrderTwo = (key: number): Uint16Array => {
    let counts = orderTwo.get(key);
    if (!counts) {
      counts = new Uint16Array(SYMBOLS + 1);
      orderTwo.set(key, counts);
    }
    return counts;
  };
  let previous = 0;

  for (let offset = 0; offset < length; offset++) {
    const x = offset % width;
    const y = Math.floor(offset / width);
    const zeroOffset = zeroContext(residuals, offset, x, y, width) << 1;
    const zero = zeroCounts[zeroOffset];
    const nonzero = zeroCounts[zeroOffset + 1];
    const zeroFrequency = decoder.frequency(zero + nonzero);
    const bit = zeroFrequency < zero ? 0 : 1;
    decoder.decode(bit === 0 ? 0 : zero, bit === 0 ? zero : nonzero);
    zeroCounts[zeroOffset + bit] = (zeroCounts[zeroOffset + bit] + ZERO_INCREMENT) >>> 0;
    if (zeroCounts[zeroOffset] + zeroCounts[zeroOffset + 1] >= ZERO_LIMIT) {
      zeroCounts[zeroOffset] = (zeroCounts[zeroOffset] >> 1) || 1;
      zeroCounts[zeroOffset + 1] = (zeroCounts[zeroOffset + 1] >> 1) || 1;
    }

    let symbol = 0;
    if (bit === 1) {
      const above = offset >= width ? residuals[offset - width] : 0;
      const second = getOrderTwo((previous << 8) | above);
      const firstOffset = previous << 8;
      const excludedZero = second[0] + orderOne[firstOffset] + orderZero[0];
      const total =
        second[TOTAL_INDEX] + orderOneTotals[previous] + orderZeroTotal - excludedZero;
      const target = decoder.frequency(total);
      let cumulative = 0;
      symbol = 1;
      let frequency = second[1] + orderOne[firstOffset + 1] + orderZero[1];
      while (cumulative + frequency <= target) {
        cumulative += frequency;
        symbol += 1;
        if (symbol >= SYMBOLS) invalid("lossless payload is malformed");
        frequency = second[symbol] + orderOne[firstOffset + symbol] + orderZero[symbol];
      }
      decoder.decode(cumulative, frequency);
      second[symbol] = (second[symbol] + ORDER_TWO_STEP) & 0xffff;
      second[TOTAL_INDEX] = (second[TOTAL_INDEX] + ORDER_TWO_STEP) & 0xffff;
      if (second[TOTAL_INDEX] >= ORDER_TWO_LIMIT) {
        let totalAfterScaling = 0;
        for (let v = 0; v < SYMBOLS; v++) {
          second[v] = second[v] >> 1;
          totalAfterScaling += second[v];
        }
        second[TOTAL_INDEX] = totalAfterScaling & 0xffff;
      }
      orderOne[firstOffset + symbol] = (orderOne[firstOffset + symbol] + ORDER_ONE_INCREMENT) & 0xffff;
      orderOneTotals[previous] = (orderOneTotals[previous] + ORDER_ONE_INCREMENT) | 0;
      if (orderOneTotals[previous] >= ORDER_ONE_LIMIT) {
        let totalAfterScaling = 0;
        for (let v = 0; v < SYMBOLS; v++) {
          const scaled = (orderOne[firstOffset + v] >> 1) || 1;
          orderOne[firstOffset + v] = scaled;
          totalAfterScaling += scaled;
        }
        orderOneTotals[previous] = totalAfterScaling | 0;
      }
      orderZero[symbol] = (orderZero[symbol] + ORDER_ZERO_STEP) & 0xffff;
      orderZeroTotal += ORDER_ZERO_STEP;
      if (orderZeroTotal >= ORDER_ZERO_LIMIT) {
        let totalAfterScaling = 0;
        for (let v = 0; v < SYMBOLS; v++) {
          orderZero[v] = orderZero[v] >> 1;
          totalAfterScaling += orderZero[v];
        }
        orderZeroTotal = totalAfterScaling;
      }
    }
    residuals[offset] = symbol;
    output[offset] = unzig(symbol, predictByte(output, offset, x, y, selector, width));
    previous = symbol;
  }
  return output;
}

// ---------------------------------------------------------- public API ---
export type SamMaskEncoding = "one_bit" | "lossless";

/**
 * Decode one mask payload (`~…` lossless / `!…` one_bit) for a
 * width×height box into a row-major binary raster (0/1 per pixel).
 * Throws SamMaskDecodeError on any structural or coding defect — callers
 * must fail closed, never substitute box geometry for a mask.
 */
export function decodeMaskToRaster(
  payload: string,
  width: number,
  height: number,
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    invalid("mask dimensions must be positive integers");
  }
  if (payload.startsWith("~")) {
    const coverage = decodeLosslessCoverage(payload, width, height);
    const raster = new Uint8Array(coverage.length);
    for (let i = 0; i < coverage.length; i++) raster[i] = coverage[i] >= 129 ? 1 : 0;
    return raster;
  }
  if (payload.startsWith("!")) {
    const raster = decodeOneBitRaster(payload, width, height);
    // The reference accepts one_bit only in canonical form: the decoded
    // raster must re-encode to the exact payload (validates finalization).
    if (encodeOneBitRaster(raster, width, height) !== payload) {
      invalid("one_bit payload is not canonical or has invalid finalization");
    }
    return raster;
  }
  return invalid("payload has no recognized encoding marker");
}

export interface SamSegmentBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Frame dimensions the coordinates live in (source pixels). */
  w: number;
  h: number;
}

export interface SamSegment {
  box: SamSegmentBox;
  /** Mask raster dimensions — the box's inclusive pixel size. */
  maskWidth: number;
  maskHeight: number;
  /** Raw payload, marker included, passed through unchanged. */
  payload: string;
}

function parseFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of body.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    fields.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return fields;
}

function fieldInt(fields: Map<string, string>, key: string): number {
  const raw = fields.get(key);
  if (raw === undefined || !/^-?\d+$/.test(raw)) {
    invalid(`segment is missing integer field "${key}"`);
  }
  return Number(raw);
}

/**
 * Split an output_text lane into box+mask segment records, in wire
 * order. Payloads cannot contain the token delimiters, so a token scan
 * is unambiguous. A record is one box token paired with the mask token
 * that follows it.
 */
export function parseSamSegments(outputText: string): SamSegment[] {
  const tokenRe = /<\|(box|mask);([^|]*)\|>/g;
  const segments: SamSegment[] = [];
  let pendingBox: SamSegmentBox | null = null;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(outputText)) !== null) {
    const fields = parseFields(match[2]);
    if (match[1] === "box") {
      pendingBox = {
        x1: fieldInt(fields, "x1"),
        y1: fieldInt(fields, "y1"),
        x2: fieldInt(fields, "x2"),
        y2: fieldInt(fields, "y2"),
        w: fieldInt(fields, "w"),
        h: fieldInt(fields, "h"),
      };
      continue;
    }
    if (!pendingBox) invalid("mask token without a preceding box token");
    const data = fields.get("data");
    if (data === undefined) invalid("mask token is missing its data field");
    const firstComma = data.indexOf(",");
    const secondComma = firstComma < 0 ? -1 : data.indexOf(",", firstComma + 1);
    if (firstComma < 0 || secondComma < 0) invalid("mask data is not an H,W,payload tuple");
    const maskHeight = Number(data.slice(0, firstComma));
    const maskWidth = Number(data.slice(firstComma + 1, secondComma));
    const payload = data.slice(secondComma + 1);
    if (!Number.isInteger(maskHeight) || !Number.isInteger(maskWidth)) {
      invalid("mask data has non-integer dimensions");
    }
    segments.push({ box: pendingBox, maskWidth, maskHeight, payload });
    pendingBox = null;
  }
  return segments;
}

export interface DecodedSamObject {
  box: SamSegmentBox;
  /** Set pixels in the decoded mask. */
  pixelCount: number;
  /** Mask centroid in FRAME pixels (box origin + raster centroid). */
  centroidPx: { x: number; y: number };
}

/**
 * Decode one segment's mask and locate its centroid in frame pixels.
 * Returns null for a structurally valid but EMPTY mask (zero set pixels
 * have no centroid — the caller decides; the zone pipeline skips them:
 * no pixels is no vehicle evidence, and a box center is never invented).
 */
export function decodeSegment(segment: SamSegment): DecodedSamObject | null {
  const raster = decodeMaskToRaster(segment.payload, segment.maskWidth, segment.maskHeight);
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < segment.maskHeight; y++) {
    const rowBase = y * segment.maskWidth;
    for (let x = 0; x < segment.maskWidth; x++) {
      if (raster[rowBase + x] === 1) {
        count++;
        sumX += x;
        sumY += y;
      }
    }
  }
  if (count === 0) return null;
  return {
    box: segment.box,
    pixelCount: count,
    centroidPx: {
      x: segment.box.x1 + sumX / count,
      y: segment.box.y1 + sumY / count,
    },
  };
}
