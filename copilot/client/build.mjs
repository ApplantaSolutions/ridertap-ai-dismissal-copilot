// Client bundle — plain Bun.build (the scaffold does not depend on the
// space SDK the base was built with; same output shape: dist/index.html +
// dist/assets/main.js, which the digest deploy stages into public/).

import { cpSync, mkdirSync, rmSync } from "node:fs";

const result = await Bun.build({
  entrypoints: ["./client/src/main.tsx"],
  outdir: "./dist/assets",
  naming: "[name].js",
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
mkdirSync("./dist", { recursive: true });
cpSync("./client/index.html", "./dist/index.html");
console.log("client built:", result.outputs.map((o) => o.path).join(", "));
