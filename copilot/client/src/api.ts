// Copilot client transport — the base's production pattern, unchanged:
// POST /api/actions { action, args, schoolCode }; the join code is the
// tenant key, entered once per device and kept in localStorage.

const SCHOOL_CODE_KEY = "ridertap-copilot-school-code-v1";

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function getSchoolCode(): string | null {
  try {
    return localStorage.getItem(SCHOOL_CODE_KEY);
  } catch {
    return null;
  }
}

export function setSchoolCode(code: string) {
  try {
    localStorage.setItem(SCHOOL_CODE_KEY, normalizeCode(code));
  } catch {
    // storage unavailable — code must be re-entered per session
  }
}

export async function call<T = any>(action: string, args: unknown = {}): Promise<T> {
  const res = await fetch("/api/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, args, schoolCode: getSchoolCode() }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error ?? `copilot api ${action} failed: ${res.status}`);
  }
  return body as T;
}

export interface ZoneLaneState {
  lane: string;
  status: "VERIFIED" | "CHECKING" | "MISMATCH";
  count: number | null;
  expected: number;
  flagCount: number;
  updatedAt: string | null;
}

export interface ZoneCheckResult {
  ok: true;
  lane: string;
  count: number;
  expected: number;
  status: "VERIFIED" | "CHECKING" | "MISMATCH";
  flagRaised: boolean;
  streak: number;
  adapter: string;
  modelId: string;
  latencyMs: number;
}

export type ExceptionAction =
  | "hold_wave"
  | "check_tag"
  | "keep_out_of_wave"
  | "sweep"
  | "info";

export interface ExceptionRecord {
  trigger: string;
  instruction: string;
  action: ExceptionAction;
  source: "spark" | "rule-fallback";
  latencyMs: number;
  status: "open" | "confirmed" | "dismissed";
  createdAt: string;
}

export type VoiceOutcome = "MATCHED" | "CONFIRM" | "ASK-REPEAT" | "DUPLICATE" | "HELD";

export interface VoiceUtteranceResult {
  outcome: VoiceOutcome;
  tag: string | null;
  enteredTag: string | null;
  suggestedTag?: string;
  prompt?: string;
  message: string;
  language: "en" | "es";
  promptLanguage: "en" | "es";
  readBack: string | null;
  needsTyping?: boolean;
  exception?: ExceptionRecord;
}

export interface VoiceStateView {
  pending: { tag: string; suggestedTag: string; prompt: string } | null;
  lastTag: string | null;
  lastOutcome: string | null;
}
