import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SCRATCH_PREFIX, type Scratch } from "./drill.js";
import type { D1Like, D1Statement, R2Like } from "./types.js";

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

export type Backend = "sqlite" | "d1";

// sqlite unless Cloudflare credentials are set; either can be asked for. Says why, so the
// drill's output shows which one ran. asking for d1 without credentials is an error.
export function pickBackend(asked: string | undefined, credentials: boolean): { backend: Backend; why: string } | { error: string } {
  if (asked !== undefined && asked !== "sqlite" && asked !== "d1") return { error: `--backend is sqlite or d1, not ${JSON.stringify(asked)}` };
  const backend: Backend = asked ?? (credentials ? "d1" : "sqlite");
  if (backend === "d1" && !credentials) return { error: "--backend d1 needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment" };
  return { backend, why: asked ? "asked for" : credentials ? "Cloudflare credentials are set" : "no Cloudflare credentials are set" };
}

// A scratch database in a local SQLite file, for a drill that must hold no Cloudflare
// credential. node:sqlite is built into Node (unflagged since 22.13; this package
// already needs 24.14.1) and carries FTS5. The file lives in a directory of its own,
// named restore-drill-<date>-<pid>, and delete() closes it and removes the directory,
// then checks it is gone.
export function sqliteScratch(): (name: string) => Promise<Scratch> {
  return async (name) => {
    if (!name.startsWith(SCRATCH_PREFIX)) throw new Error(`d1-dump: refusing to create ${JSON.stringify(name)}: a scratch database starts with ${SCRATCH_PREFIX}`);
    const dir = mkdtempSync(join(tmpdir(), `${name}-`));
    const file = join(dir, `${name}.sqlite`);
    const sqlite = new DatabaseSync(file);

    // D1 binds a BLOB as an array of byte values and refuses undefined; SQLite takes bytes.
    const sqlValues = (values: unknown[]): SQLInputValue[] =>
      values.map((v) => (Array.isArray(v) ? Uint8Array.from(v as number[]) : (v as SQLInputValue)));
    const rowsOf = (sql: string, values: unknown[]) =>
      sqlite
        .prepare(sql)
        .all(...sqlValues(values))
        .map((r) => ({ ...r }));

    const statement = (sql: string, values: unknown[] = []): D1Statement & { exec(): { results: unknown[] } } => ({
      bind: (...next) => statement(sql, next),
      all: (async <T>() => ({ results: rowsOf(sql, values) as T[] })) as D1Statement["all"],
      run: async () => sqlite.prepare(sql).run(...sqlValues(values)),
      exec: () => ({ results: rowsOf(sql, values) }),
    });
    const db: D1Like = {
      prepare: (sql) => statement(sql),
      // One batch is one transaction, as D1's is: all of it lands or none of it does.
      batch: async <T>(statements: D1Statement[]) => {
        sqlite.exec("BEGIN");
        try {
          const out = statements.map((s) => (s as ReturnType<typeof statement>).exec() as { results: T[] });
          sqlite.exec("COMMIT");
          return out;
        } catch (err) {
          sqlite.exec("ROLLBACK");
          throw err;
        }
      },
    };
    return {
      db,
      delete: async () => {
        sqlite.close();
        rmSync(dir, { recursive: true, force: true });
        if (existsSync(dir)) throw new Error(`${dir} is still there after the delete`);
      },
    };
  };
}
