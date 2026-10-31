// Invoke driver — runs ONE function instance (its own process, its own
// libSQL client/connection) through a scripted list of steps, so the
// final-bundle test can drive the production handler from two truly
// independent invocations, the way two staff phones hit two Netlify
// Function instances backed by one Turso primary.
//
// Usage: TURSO_DATABASE_URL=file:/path/db.sqlite bun invoke-driver.ts
//   stdin: JSON { steps: Step[] }
//   Step = { call: { action, args?, schoolCode? } }   (schoolCode omitted = send none)
//        | { wait: "barrier-file-name" }              (poll until the file exists)
//        | { touch: "file-name" }                     (create the file)
//        | { sleep: ms }
//   stdout: JSON array with one { status, body } per call step, in order.
//
// Env: RIDERTAP_FUNCTION_MODULE — module to invoke (default the TS source
//      ../functions/actions.ts); RIDERTAP_TMP — barrier file directory;
//      RIDERTAP_LAMBDA=1 — invoke the bundle's Lambda `handler` export
//      instead of the fetch-style default export.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TMP = process.env.RIDERTAP_TMP ?? "/tmp";
const modulePath =
  process.env.RIDERTAP_FUNCTION_MODULE ??
  new URL("../functions/actions.ts", import.meta.url).pathname;

const mod: any = await import(modulePath);
const fetchHandler: ((req: Request) => Promise<Response>) | null =
  typeof mod.default === "function"
    ? mod.default
    : typeof mod.default?.default === "function"
      ? mod.default.default
      : null;
const lambdaHandler: any =
  mod.handler ?? mod.default?.handler ?? null;

async function invoke(call: {
  action: string;
  args?: unknown;
  schoolCode?: string | null;
}): Promise<{ status: number; body: any }> {
  const payload: Record<string, unknown> = { action: call.action, args: call.args ?? {} };
  if (call.schoolCode !== undefined && call.schoolCode !== null) {
    payload.schoolCode = call.schoolCode;
  }
  if (process.env.RIDERTAP_LAMBDA === "1") {
    if (!lambdaHandler) throw new Error("no lambda handler export found");
    const res = await lambdaHandler({
      httpMethod: "POST",
      body: JSON.stringify(payload),
      isBase64Encoded: false,
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }
  if (!fetchHandler) throw new Error("no fetch handler export found");
  const res = await fetchHandler(
    new Request("https://ridertap.internal/api/actions", {
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
  } else if (step.wait) {
    const target = join(TMP, step.wait);
    const deadline = Date.now() + 20000;
    while (!existsSync(target)) {
      if (Date.now() > deadline) throw new Error(`barrier timeout: ${step.wait}`);
      await Bun.sleep(10);
    }
  } else if (step.touch) {
    writeFileSync(join(TMP, step.touch), "1");
  } else if (step.sleep) {
    await Bun.sleep(step.sleep);
  }
}
console.log(JSON.stringify(results));
