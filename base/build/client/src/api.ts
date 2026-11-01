// PRODUCTION transport — replaces the hosted platform SDK RPC client.
//
// Call sites in App.tsx are unchanged (api.getState({}), api.addEntry({...}),
// ...). Only the transport differs from the artifact build:
//   - POST /api/actions  (netlify.toml redirects to the actions function)
//   - body: { action, args, schoolCode }
//   - schoolCode: the school's join code, entered once per device and kept
//     in localStorage (same storage pattern the app already uses for its
//     offline outbox). It is the tenant key AND the v1 access gate — see
//     production/DEPLOY_PLAN.md "Access model (Truth Mode)".
//
// Typing is identical to the artifact client: `api` is an
// ActionClient<typeof Actions>, so ApiResponse<typeof api, "getState">
// resolves exactly as before and every call site keeps full type checking.

import type { Actions } from "../../server/src/actions";
import type { ActionClient } from "@hatch/space-sdk/client";

type ActionName = keyof typeof Actions;

const SCHOOL_CODE_KEY = "ridertap-school-code-v1";

// Codes are forgiving on entry: case, dashes, and spaces don't matter.
// The stored form is uppercase alphanumerics only, and the server
// normalizes the same way before comparing — RT-KW4W4X, RTKW4W4X, and
// rt-kw4w4x are the same code everywhere in the system.
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

export function clearSchoolCode() {
  try {
    localStorage.removeItem(SCHOOL_CODE_KEY);
  } catch {
    // storage unavailable — nothing to clear
  }
}

// Owner Admin Board: JR's ADMIN_CODE lives under its OWN storage key —
// it is never written into the school-code slot, so the function's school
// dispatch can never mistake it for a tenant (and vice versa). The
// function gates adminOverview on it; a school code sent to that action
// is refused server-side.
const ADMIN_CODE_KEY = "ridertap-admin-code-v1";

export function getAdminCode(): string | null {
  try {
    return localStorage.getItem(ADMIN_CODE_KEY);
  } catch {
    return null;
  }
}

export function setAdminCode(code: string) {
  try {
    localStorage.setItem(ADMIN_CODE_KEY, normalizeCode(code));
  } catch {
    // storage unavailable — code must be re-entered per session
  }
}

export function clearAdminCode() {
  try {
    localStorage.removeItem(ADMIN_CODE_KEY);
  } catch {
    // storage unavailable — nothing to clear
  }
}

async function call(action: ActionName, args: unknown): Promise<unknown> {
  const res = await fetch("/api/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action,
      args,
      // adminOverview carries the OWNER code in the same wire field the
      // school actions use for the join code; every other action carries
      // the school code exactly as before.
      schoolCode: action === "adminOverview" ? getAdminCode() : getSchoolCode(),
    }),
  });
  if (!res.ok) {
    // Match the artifact client's behavior of surfacing failures as thrown
    // errors so React Query retries / the offline outbox takes over.
    throw new Error(`ridertap api ${String(action)} failed: ${res.status}`);
  }
  return res.json();
}

// Proxy with the same shape as createActionClient<typeof Actions>().
export const api = new Proxy(
  {},
  {
    get(_target, prop: string) {
      return (args: unknown) => call(prop as ActionName, args ?? {});
    },
  },
) as unknown as ActionClient<typeof Actions>;

export type { ApiRequest, ApiResponse } from "@hatch/space-sdk/client";
