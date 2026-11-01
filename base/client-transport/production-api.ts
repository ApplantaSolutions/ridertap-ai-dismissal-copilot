// PRODUCTION transport shim — drop-in replacement for client/src/api.ts
// (staged Oct 24 2026; applied to the production client copy at bundle time,
// AFTER the Proof Report lands and the artifact's final source is frozen).
//
// The hosted artifact's api.ts builds a proxy over the platform SDK that POSTs
// {action, args} to ./actions. Production keeps the EXACT same call sites in
// App.tsx (api.getState({}), api.addEntry({number, lane}), ...) — only the
// transport changes:
//   - POST /api/actions  (netlify.toml redirects to the actions function)
//   - body: { action, args, schoolCode }
//   - schoolCode: the school's join code, entered once per device and kept
//     in localStorage (same pattern the app already uses for its offline
//     outbox). It is the tenant key AND the v1 access gate — see
//     DEPLOY_PLAN.md "Access model" for the honest limits of that.
//
// Types still come from the server actions module, so every call site keeps
// full type checking with zero changes.

import type { Actions } from "../../server/src/actions";

type ActionName = keyof Actions;

const SCHOOL_CODE_KEY = "ridertap-school-code-v1";

// Codes are forgiving on entry: case, dashes, and spaces don't matter.
// Stored form is uppercase alphanumerics only; the server normalizes
// identically before comparing.
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
// never in the school-code slot. adminOverview carries it in the same
// wire field school actions use for the join code; the function gates
// that action on ADMIN_CODE and refuses school codes there.
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

async function call<Action extends ActionName>(
  action: Action,
  args: unknown,
): Promise<unknown> {
  const res = await fetch("/api/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action,
      args,
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
) as {
  [K in ActionName]: (args: unknown) => Promise<unknown>;
};

export type { ApiRequest, ApiResponse } from "@hatch/space-sdk/client";
