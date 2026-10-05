import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { R2Like } from "./types.js";

// A downloaded dump as an R2Like, read only, for a drill run from Node. `root` holds the
// keys as paths: <root>/backups/json/<run id>/<table>.json. Not exported from the package
// entry, which has to stay free of node: imports so a Worker can bundle it.
export function directoryBucket(root: string): R2Like {
  const readOnly = async (): Promise<never> => {
    throw new Error("d1-dump: a directory bucket is read only");
  };
  const keysUnder = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await keysUnder(path)));
      else out.push(relative(root, path).split(sep).join("/"));
    }
    return out;
  };
  return {
    get: async (key) => {
      const path = join(root, ...key.split("/"));
      if (relative(root, path).startsWith("..")) throw new Error(`d1-dump: ${key} is outside ${root}`);
      const text = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      return text === null ? null : { text: async () => text };
    },
    list: async ({ prefix = "" }) => ({ objects: (await keysUnder(root)).filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false }),
    put: readOnly,
    delete: readOnly,
    createMultipartUpload: readOnly,
  };
}
