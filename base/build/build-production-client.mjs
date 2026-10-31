// Production (Netlify) client build for RiderTap.
//
// This does NOT call @hatch/space-sdk's buildClient() and does NOT set
// HATCH_SPACES_BUILD_DRIVER: that pipeline publishes the Muse web artifact,
// which is not what is happening here. This script compiles the frozen
// artifact SOURCE (with the production transport swapped in) into the
// static bundle Netlify serves, replicating the canonical Bun.build()
// configuration documented in @hatch/space-sdk/build (entrypoint, outdir,
// production NODE_ENV define, asset naming, tailwind plugin, and the
// imported-asset URL re-prefix fixup).

import { rm } from "node:fs/promises";
import { basename } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const ENTRY = "./client/index.html";
const OUTDIR = "./client/dist";

await rm(OUTDIR, { force: true, recursive: true });
const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUTDIR,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("production client build failed; see logged diagnostics");
}

// Same fixup as the canonical build: bare imported-asset URLs -> ./assets/…
const assetFiles = result.outputs
  .filter((output) => output.kind === "asset")
  .map((output) => basename(output.path));
for (const output of result.outputs) {
  if (!/\.(js|css|html)$/.test(output.path)) continue;
  let text = await output.text();
  let changed = false;
  for (const name of assetFiles) {
    const bare = `./${name}`;
    if (text.includes(bare)) {
      text = text.split(bare).join(`./assets/${name}`);
      changed = true;
    }
  }
  if (changed) await Bun.write(output.path, text);
}
console.log(
  `production client built: ${result.outputs.length} outputs -> ${OUTDIR}`,
);
