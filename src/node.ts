import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { cloudflareBucket, cloudflareScratch, type RestBucket } from "./cloudflare.js";
import { COMPLETE_MARKER, DEFAULT_PREFIX, type CompleteMarker } from "./dump.js";
import { SCRATCH_PREFIX, runRestoreDrill, type Scratch } from "./drill.js";
import { FILES_COMPLETE, FILES_PREFIX, FILES_PROGRESS, restoreFiles } from "./files.js";
import { latestDump } from "./runs.js";
import type { D1Like, D1Statement, R2FilesLike, R2Like, R2ObjectLike } from "./types.js";

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
      const bytes = await readFile(path).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      if (bytes === null) return null;
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return { text: async () => bytes.toString("utf8"), arrayBuffer: async () => copy };
    },
    list: async ({ prefix = "" }) => ({ objects: (await keysUnder(root)).filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false }),
    put: readOnly,
    delete: readOnly,
    createMultipartUpload: readOnly,
  };
}

type Backend = "sqlite" | "d1";

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

// Downloads the newest complete run under `prefix`, and only that run, into `root` as the
// keys' paths, for a drill through directoryBucket(root). Its objects are the ones its marker
// lists, then the marker. A listed object that is missing is left out, so the drill's own
// checks fail on it. null when the bucket holds no complete run.
export async function downloadLatestRun(bucket: RestBucket, root: string, prefix: string = DEFAULT_PREFIX): Promise<{ prefix: string; objects: number } | null> {
  const latest = await latestDump(bucket, { prefix });
  if (!latest) return null;
  const markerKey = `${latest.prefix}${COMPLETE_MARKER}`;
  const marker = JSON.parse((await (await bucket.get(markerKey))?.text()) ?? "{}") as Partial<CompleteMarker>;
  let objects = 0;
  for (const key of [...(marker.keys ?? []).filter((k) => k !== markerKey), markerKey]) {
    if (!key.startsWith(latest.prefix) || key.split("/").includes("..")) throw new Error(`d1-dump: ${markerKey} lists ${key}, outside its run`);
    const body = await bucket.stream(key);
    if (!body) continue;
    const path = join(root, ...key.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), createWriteStream(path));
    objects++;
  }
  return { prefix: latest.prefix, objects };
}

export interface BucketDrillOptions {
  accountId: string | undefined;
  apiToken: string | undefined;
  bucket: string;
  // Where the runs are in the bucket. Defaults to backups/json/.
  prefix?: string;
  // sqlite unless d1 is asked for: the R2 credentials this needs do not ask for a D1 drill.
  backend?: string;
  maxAgeHours?: number | null;
  fetchImpl?: typeof fetch;
}

// The weekly drill in one call: the newest complete run downloaded from the bucket over the
// R2 REST API into a temporary directory, drilled, and the directory removed. code is 0 when
// every check passes, 1 when one fails, and 3 when the drill could not run (no credentials,
// an API error); the first line says which. The token is sent only as the Authorization
// header and is never in a line.
export async function drillFromBucket(options: BucketDrillOptions): Promise<{ code: 0 | 1 | 3; lines: string[] }> {
  const { accountId, apiToken } = options;
  const backend = options.backend ?? "sqlite";
  const cannot = (why: string) => ({ code: 3 as const, lines: [`restore drill could not run: ${why}`] });
  if (backend !== "sqlite" && backend !== "d1") return cannot(`--backend is sqlite or d1, not ${JSON.stringify(backend)}`);
  if (!accountId || !apiToken) return cannot("--bucket needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment");
  const root = mkdtempSync(join(tmpdir(), "d1-dump-bucket-"));
  try {
    const bucket = cloudflareBucket(accountId, apiToken, options.bucket, options.fetchImpl);
    const downloaded = await downloadLatestRun(bucket, root, options.prefix);
    const result = await runRestoreDrill(directoryBucket(root), {
      createScratch: backend === "d1" ? cloudflareScratch(accountId, apiToken, options.fetchImpl) : sqliteScratch(),
      prefix: downloaded?.prefix,
      maxAgeHours: options.maxAgeHours,
    });
    return {
      code: result.ok ? 0 : 1,
      lines: [
        `restore drill ${result.ok ? "PASSED" : "FAILED"}: ${result.run ?? "no dump"} into ${result.scratch} (${backend})`,
        `downloaded ${downloaded ? `${downloaded.objects} objects of ${downloaded.prefix}` : "nothing: no complete run"} from ${options.bucket}`,
        ...result.checks.map((c) => `  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`),
      ],
    };
  } catch (err) {
    return cannot(err instanceof Error ? err.message : String(err));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export interface FilesDrillOptions {
  accountId: string | undefined;
  apiToken: string | undefined;
  bucket: string;
  // The files backups to drill (files/<name>/). Every one the bucket holds when not given.
  names?: string[];
  // Copies restored per backup, spread evenly over its keys. Default 5.
  sample?: number;
  fetchImpl?: typeof fetch;
}

// Hashes a file: its SHA-256 and MD5 in hex and its length.
async function digest(path: string): Promise<{ sha256: string; md5: string; bytes: number }> {
  const sha = createHash("sha256");
  const md5 = createHash("md5");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    sha.update(chunk as Buffer);
    md5.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: sha.digest("hex"), md5: md5.digest("hex"), bytes };
}

// Every key under a prefix, over the REST list, page by page.
async function keysOf(bucket: RestBucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

// A directory as an R2FilesLike: list and get read the files under root, put writes one. Its
// objects carry no metadata, which the drill does not check.
function directoryFiles(root: string): R2FilesLike {
  const pathOf = (key: string) => {
    const path = join(root, ...key.split("/"));
    if (relative(root, path).startsWith("..")) throw new Error(`d1-dump: ${key} is outside ${root}`);
    return path;
  };
  const all = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await all(path)));
      else out.push(relative(root, path).split(sep).join("/"));
    }
    return out;
  };
  const object = (key: string): R2ObjectLike => ({ key, etag: "", size: 0, httpMetadata: {}, customMetadata: {} });
  return {
    list: async ({ prefix = "", startAfter }) => ({
      objects: (await all(root))
        .filter((k) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter))
        .sort()
        .map(object),
      truncated: false,
    }),
    get: async (key) => {
      const path = pathOf(key);
      if (!existsSync(path)) return null;
      return { ...object(key), body: Readable.toWeb(createReadStream(path)), text: () => readFile(path, "utf8") };
    },
    put: async (key, value) => {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      const body = value instanceof Uint8Array || typeof value === "string" ? Readable.from([value]) : Readable.fromWeb(value as NodeReadableStream<Uint8Array>);
      await pipeline(body, createWriteStream(path));
    },
    delete: async () => {
      throw new Error("d1-dump: the drill deletes nothing");
    },
  };
}

// R3, the files drill: for each files backup in the bucket, a sample of its copies is
// downloaded over the R2 REST API, restored with restoreFiles (apply, into a scratch directory,
// never a bucket), and each restored file's bytes are checked against the copy's: the same
// SHA-256 and length, and the MD5 the API's etag names when it is a single-part etag. code is 0
// when every check passes, 1 when one fails (or a named backup holds no copy), 3 when it could
// not run. The token is only the Authorization header, never in a line.
export async function drillFilesFromBucket(options: FilesDrillOptions): Promise<{ code: 0 | 1 | 3; lines: string[] }> {
  const { accountId, apiToken } = options;
  const sample = options.sample ?? 5;
  if (!accountId || !apiToken) return { code: 3, lines: ["files drill could not run: --bucket needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment"] };
  if (!Number.isInteger(sample) || sample < 1) return { code: 3, lines: [`files drill could not run: --sample is a whole number from 1, not ${sample}`] };
  const scratch = mkdtempSync(join(tmpdir(), "d1-dump-files-"));
  const lines: string[] = [];
  let failed = false;
  try {
    const bucket = cloudflareBucket(accountId, apiToken, options.bucket, options.fetchImpl);
    const all = await keysOf(bucket, FILES_PREFIX);
    const found = [...new Set(all.map((k) => k.slice(FILES_PREFIX.length).split("/")[0]).filter(Boolean))].sort();
    const names = options.names?.length ? options.names : found;
    if (!names.length) return { code: 0, lines: [`files drill: ${options.bucket} holds no files backup, so there is nothing to drill`] };
    for (const name of names) {
      const base = `${FILES_PREFIX}${name}/`;
      const copies = all.filter((k) => k.startsWith(base) && k !== `${base}${FILES_PROGRESS}` && k !== `${base}${FILES_COMPLETE}`).sort();
      if (!copies.length) {
        failed = true;
        lines.push(`  FAIL ${name}: no copies under ${base}`);
        continue;
      }
      if (!all.includes(`${base}${FILES_COMPLETE}`)) lines.push(`  note ${name}: no complete pass yet (${base}${FILES_COMPLETE}); drilling the copies there are`);
      const step = copies.length / Math.min(sample, copies.length);
      const picked = [...new Set(Array.from({ length: Math.min(sample, copies.length) }, (_, i) => copies[Math.floor(i * step)]))];
      const from = join(scratch, name, "backup");
      const into = join(scratch, name, "restored");
      const held = new Map<string, { etag: string | null }>();
      for (const key of picked) {
        const res = await bucket.response(key);
        if (!res?.body) throw new Error(`${key} was listed and then could not be read`);
        const path = join(from, ...key.split("/"));
        await mkdir(dirname(path), { recursive: true });
        await pipeline(Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>), createWriteStream(path));
        held.set(key, { etag: res.headers.get("etag")?.replace(/^W\//, "").replace(/"/g, "") ?? null });
      }
      const result = await restoreFiles(directoryFiles(from), directoryFiles(into), { name, apply: true });
      const restored = result.counts.written === picked.length;
      if (!restored) failed = true;
      lines.push(`  ${restored ? "ok  " : "FAIL"} ${name}: restoreFiles wrote ${result.counts.written} of ${picked.length} sampled copies (of ${copies.length})`);
      for (const key of picked) {
        const copy = await digest(join(from, ...key.split("/")));
        const target = join(into, ...key.slice(base.length).split("/"));
        const back = existsSync(target) ? await digest(target) : null;
        const etag = held.get(key)?.etag ?? null;
        const problems: string[] = [];
        if (!back) problems.push("not restored");
        else {
          if (back.sha256 !== copy.sha256 || back.bytes !== copy.bytes) problems.push(`restored ${back.bytes} bytes (sha256 ${back.sha256.slice(0, 12)}), the copy has ${copy.bytes} (${copy.sha256.slice(0, 12)})`);
          if (etag && /^[0-9a-f]{32}$/i.test(etag) && etag.toLowerCase() !== back.md5) problems.push(`MD5 ${back.md5} is not the etag ${etag}`);
        }
        if (problems.length) failed = true;
        lines.push(`    ${problems.length ? "FAIL" : "ok  "} ${key.slice(base.length)}: ${problems.length ? problems.join("; ") : `${back?.bytes} bytes match${etag && /^[0-9a-f]{32}$/i.test(etag) ? " and the etag" : ""}`}`);
      }
    }
    return { code: failed ? 1 : 0, lines: [`files drill ${failed ? "FAILED" : "PASSED"}: ${names.join(", ")} from ${options.bucket}, ${sample} sampled each, restored into a scratch directory`, ...lines] };
  } catch (err) {
    return { code: 3, lines: [`files drill could not run: ${err instanceof Error ? err.message : String(err)}`] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
