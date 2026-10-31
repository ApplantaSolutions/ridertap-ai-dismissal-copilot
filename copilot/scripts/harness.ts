// Local harness — invokes the Copilot actions function in-process, the
// same pattern as the base's scripts/invoke-driver.ts (stdin JSON steps
// in, JSON results out). This is the gate surface whenever staging is
// unavailable (C-11/C-12) and the fast loop while building.
//
// Usage:
//   bun scripts/harness.ts steps.json        # file with {steps:[…]}
//   bun scripts/harness.ts                     # steps on stdin
//   Step = { call: { action, args?, schoolCode? } } | { sleep: ms }
// Output: one JSON array, one { status, body } per call step, in order.
//
// Env: COPILOT_DB_URL (default local file), COPILOT_SAM_ADAPTER (stub).

const mod: any = await import(
  process.env.COPILOT_FUNCTION_MODULE ??
    new URL("../functions/actions.ts", import.meta.url).pathname
);
const resolved: ((req: Request) => Promise<Response>) | null =
  typeof mod.default === "function" ? mod.default : null;
if (!resolved) throw new Error("no fetch handler export found in actions module");
const fetchHandler: (req: Request) => Promise<Response> = resolved;

async function invoke(call: {
  action: string;
  args?: unknown;
  schoolCode?: string | null;
}): Promise<{ status: number; body: any }> {
  const payload: Record<string, unknown> = { action: call.action, args: call.args ?? {} };
  if (call.schoolCode !== undefined && call.schoolCode !== null) {
    payload.schoolCode = call.schoolCode;
  }
  const res = await fetchHandler(
    new Request("https://ridertap-copilot.internal/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

const input = Bun.argv[2]
  ? JSON.parse(await Bun.file(Bun.argv[2]).text())
  : JSON.parse(await new Response(Bun.stdin.stream()).text());

const results: Array<{ status: number; body: any }> = [];
for (const step of input.steps as any[]) {
  if (step.call) {
    try {
      results.push(await invoke(step.call));
    } catch (e) {
      results.push({ status: -1, body: { error: String(e) } });
    }
  } else if (step.sleep) {
    await Bun.sleep(step.sleep);
  }
}
console.log(JSON.stringify(results, null, 2));
