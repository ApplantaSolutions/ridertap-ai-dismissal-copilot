// Shared spike helpers. Rules for every spike in this folder:
//   - The API key comes from the META_API_KEY env var ONLY. It is never
//     printed, never logged, never written to a file by these scripts.
//   - Minimum calls: each spike makes the smallest number of requests
//     that answers its R-05 questions (default: exactly one).
//   - Every spike prints: the exact model ID sent, wall-clock latency,
//     HTTP status, and the raw response SHAPE (top-level keys + a short
//     excerpt) — the facts SPIKE-RESULTS.md is filled from.
//   - No key → the spike explains itself and exits 2 WITHOUT any network
//     call. "Ready, not run" is a valid state; a fake run is not.

export const BASE_URL = process.env.META_API_BASE_URL ?? "https://api.meta.ai/v1";

export function requireKey(): string {
  const key = process.env.META_API_KEY;
  if (!key) {
    console.error(
      [
        "META_API_KEY is not set — spike NOT run (no network call made).",
        "When JR's key exists, run:",
        "  META_API_KEY=<key from staging env> bun spikes/<this-spike>.ts",
        "The key is set by JR in the staging Netlify env; it never travels",
        "through chat and is never committed.",
      ].join("\n"),
    );
    process.exit(2);
  }
  return key;
}

export function shapeOf(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0
      ? "[]"
      : `[${value.length} × ${shapeOf(value[0], depth + 1)}]`;
  }
  if (typeof value === "object") {
    if (depth > 2) return "{…}";
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${shapeOf(v, depth + 1)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  if (typeof value === "string") {
    return value.length > 60 ? `string(${value.length})` : `string "${value}"`;
  }
  return `${typeof value} ${String(value)}`;
}

export async function timedFetch(
  url: string,
  init: RequestInit,
): Promise<{ res: Response; ms: number }> {
  const started = performance.now();
  const res = await fetch(url, init);
  return { res, ms: Math.round(performance.now() - started) };
}

export function authHeaders(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}
