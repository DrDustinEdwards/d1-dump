// The weekly mutation run of the code-map workflow (.github/workflows/code-map.yml), one chunk at a
// time; never a gate. Each chunk writes reports/mutation/<chunk>.json and its own incremental file.
import { chunkedStryker } from "@dustinedwards/devkit/stryker";

const CHUNKS = {
  drill: ["src/drill.ts"],
  dump: ["src/dump.ts", "src/schema.ts"],
  restore: ["src/restore.ts", "src/r2.ts"],
  runs: ["src/runs.ts"],
};

export default chunkedStryker({
  all: [
    ...Object.values(CHUNKS).flat(),
    "src/cli.ts",
    "src/cloudflare.ts",
    "src/index.ts",
    "src/node.ts",
    "src/types.ts",
  ],
  chunks: CHUNKS,
  timeoutMS: 60000,
});
