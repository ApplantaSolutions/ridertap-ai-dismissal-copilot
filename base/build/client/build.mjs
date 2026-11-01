// Client bundle for the hosted project.
//
// Bundling is owned by the SDK so every hosted project produces an
// identical production-mode React bundle. See the platform SDK's build
// module for the canonical Bun.build() configuration (entrypoint,
// outdir, NODE_ENV define, asset naming, tailwind plugin).

import { buildClient } from "@hatch/space-sdk/build";

await buildClient();
