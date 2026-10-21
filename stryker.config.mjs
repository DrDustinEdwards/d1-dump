// The weekly mutation run of the code-map workflow (.github/workflows/code-map.yml), one chunk at a
// time; never a gate. Each chunk writes reports/mutation/<chunk>.json and its own incremental file.
import process from "node:process";

const CHUNKS = {
  drill: ["src/drill.ts"],
  dump: ["src/dump.ts", "src/schema.ts"],
  restore: ["src/restore.ts", "src/r2.ts"],
  runs: ["src/runs.ts"],
  rest: ["src/cli.ts", "src/cloudflare.ts", "src/index.ts", "src/node.ts", "src/types.ts"],
};
const chunk = process.env.STRYKER_CHUNK;
if (chunk && !CHUNKS[chunk]) throw new Error(`Unknown STRYKER_CHUNK "${chunk}"`);
const name = chunk ?? "mutation";

export default {
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  disableBail: true,
  incremental: true,
  incrementalFile: `reports/stryker-incremental-${name}.json`,
  mutate: [...(chunk ? CHUNKS[chunk] : Object.values(CHUNKS).flat()), "!**/*.d.ts"],
  ignoreStatic: true,
  reporters: ["json", "clear-text", "progress"],
  jsonReporter: { fileName: `reports/mutation/${name}.json` },
  concurrency: 4,
  timeoutMS: 60000,
  tempDirName: ".stryker-tmp",
};
