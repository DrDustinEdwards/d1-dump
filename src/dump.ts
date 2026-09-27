import { JSON_TYPE, putJsonStreamed } from "./r2.js";
import { quoteIdent, readPlan, type FtsTable, type SchemaEntry } from "./schema.js";
import type { D1Like, R2Like } from "./types.js";

export const DEFAULT_PREFIX = "backups/json/";
// Written last, and only when every other object of the run is written. A run without
// it is incomplete: latestDump skips it and pruneDumps gives it no slot in the floor.
export const COMPLETE_MARKER = "_complete.json";
export const SCHEMA_SIDECAR = "_schema.json";

export interface PagedTable {
  // An INTEGER column that only grows (AUTOINCREMENT) on a table whose rows are never
  // updated or deleted after insert. Rows up to its MAX, read inside the snapshot, are
  // then read in pages without breaking the snapshot.
  idColumn: string;
  pageRows: number;
}

export interface DumpOptions {
  // Where runs are written: <prefix><run id>/<table>.json. Defaults to backups/json/.
  prefix?: string;
  now?: Date;
  // Tables too large to hold in the isolate at once. Every other table is read whole.
  paged?: Record<string, PagedTable>;
  // Tables left out on purpose. A name that is not a table fails the run, so the list
  // cannot outlive a dropped table unnoticed.
  exclude?: string[];
  // Extra JSON objects written as _<name>.json beside the tables, before the marker.
  sidecars?: Record<string, unknown>;
  // false leaves the marker unwritten, so the caller can run its own checks on the dump
  // and then call writeCompleteMarker, or leave the run incomplete when a check fails.
  // Defaults to true.
  markComplete?: boolean;
}

export interface DumpedTable {
  name: string;
  rows: number;
  key: string;
}

export interface DumpResult {
  run_id: string;
  prefix: string;
  exported_at: string;
  keys: string[];
  tables: DumpedTable[];
  fts: FtsTable[];
  excluded: string[];
  shadow_skipped: string[];
  // Whether _complete.json was written. When false, `keys` lists every object written
  // and no marker.
  complete: boolean;
}

export interface CompleteMarker {
  exported_at: string;
  keys: string[];
  tables: DumpedTable[];
  fts: FtsTable[];
  excluded: string[];
}

export interface SchemaSidecar {
  exported_at: string;
  schema: SchemaEntry[];
}

export function runIdFor(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function* pages(db: D1Like, table: string, idColumn: string, maxId: number, pageRows: number): AsyncGenerator<unknown[]> {
  let after = -Number.MAX_SAFE_INTEGER;
  const id = quoteIdent(idColumn);
  while (true) {
    const { results } = await db
      .prepare(`SELECT * FROM ${quoteIdent(table)} WHERE ${id} > ?1 AND ${id} <= ?2 ORDER BY ${id} LIMIT ?3`)
      .bind(after, maxId, pageRows)
      .all<Record<string, number>>();
    if (results.length === 0) return;
    yield results;
    after = results[results.length - 1][idColumn];
  }
}

// Dumps every table of `db` into `bucket`, one JSON object per table, which works on a
// database holding FTS5 tables where `wrangler d1 export` exits 1.
//
// All reads that are not paged run in one D1 batch, which is one transaction, so the
// dump describes one instant. Throws on any failure, and then writes no marker.
export async function dumpDatabase(db: D1Like, bucket: R2Like, options: DumpOptions = {}): Promise<DumpResult> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const now = options.now ?? new Date();
  const exportedAt = now.toISOString();
  const runId = runIdFor(now);
  const runPrefix = `${prefix}${runId}/`;
  const plan = await readPlan(db);
  const paged = options.paged ?? {};
  const exclude = options.exclude ?? [];

  const internalFts = plan.fts.filter((f) => f.mode === "internal").map((f) => f.name);
  const known = new Set([...plan.tables, ...internalFts]);
  for (const name of [...exclude, ...Object.keys(paged)]) {
    if (!known.has(name)) throw new Error(`d1-dump: ${name} is named in the options but is not a dumpable table`);
  }
  const targets = [...plan.tables, ...internalFts].filter((t) => !exclude.includes(t));
  for (const name of Object.keys(sidecarsOf(options))) {
    if (targets.includes(name.slice(1, -".json".length))) throw new Error(`d1-dump: sidecar ${name} would overwrite a table`);
  }

  const snapshot = await db.batch(
    targets.map((t) => {
      const p = paged[t];
      if (p) return db.prepare(`SELECT MAX(${quoteIdent(p.idColumn)}) AS max_id FROM ${quoteIdent(t)}`);
      // An internal FTS5 table is read with its rowid, which the restore needs to keep
      // any join on it.
      return db.prepare(internalFts.includes(t) ? `SELECT rowid AS "rowid", * FROM ${quoteIdent(t)}` : `SELECT * FROM ${quoteIdent(t)}`);
    })
  );

  const keys: string[] = [];
  const tables: DumpedTable[] = [];
  for (let i = 0; i < targets.length; i++) {
    const table = targets[i];
    const key = `${runPrefix}${table}.json`;
    const results = snapshot[i]?.results ?? [];
    const p = paged[table];
    let rows: number;
    if (p) {
      const maxId = Number((results[0] as { max_id: number | null } | undefined)?.max_id ?? Number.NaN);
      const head = `{"exported_at":${JSON.stringify(exportedAt)},"table":${JSON.stringify(table)},"rows":[`;
      rows = Number.isNaN(maxId)
        ? await putJsonStreamed(bucket, key, head, (async function* () {})())
        : await putJsonStreamed(bucket, key, head, pages(db, table, p.idColumn, maxId, p.pageRows));
    } else {
      await bucket.put(key, JSON.stringify({ exported_at: exportedAt, table, rows: results }), JSON_TYPE);
      rows = results.length;
    }
    keys.push(key);
    tables.push({ name: table, rows, key });
    // Dropped as soon as it is written, so one serialized table is alive at a time.
    if (snapshot[i]) snapshot[i] = { results: [] };
  }

  const schemaKey = `${runPrefix}${SCHEMA_SIDECAR}`;
  await bucket.put(schemaKey, JSON.stringify({ exported_at: exportedAt, schema: plan.schema } satisfies SchemaSidecar), JSON_TYPE);
  keys.push(schemaKey);
  for (const [file, value] of Object.entries(sidecarsOf(options))) {
    const key = `${runPrefix}${file}`;
    await bucket.put(key, JSON.stringify({ exported_at: exportedAt, ...(value as object) }), JSON_TYPE);
    keys.push(key);
  }

  const result: DumpResult = {
    run_id: runId,
    prefix: runPrefix,
    exported_at: exportedAt,
    keys,
    tables,
    fts: plan.fts,
    excluded: exclude,
    shadow_skipped: plan.shadow,
    complete: false,
  };
  if (options.markComplete ?? true) await writeCompleteMarker(bucket, result);
  return result;
}

// Writes the run's _complete.json, listing every object the run wrote, and marks the
// result complete. For a dump made with markComplete: false once the caller's own
// checks pass. Refuses a result already marked.
export async function writeCompleteMarker(bucket: R2Like, result: DumpResult): Promise<string> {
  if (result.complete) throw new Error(`d1-dump: ${result.prefix} is already marked complete`);
  const key = `${result.prefix}${COMPLETE_MARKER}`;
  const marker: CompleteMarker = { exported_at: result.exported_at, keys: [...result.keys], tables: result.tables, fts: result.fts, excluded: result.excluded };
  await bucket.put(key, JSON.stringify(marker), JSON_TYPE);
  result.keys.push(key);
  result.complete = true;
  return key;
}

function sidecarsOf(options: DumpOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(options.sidecars ?? {})) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`d1-dump: sidecar name ${name} must be lowercase letters, digits and dashes`);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`d1-dump: sidecar ${name} must be an object`);
    const file = `_${name}.json`;
    if (file === COMPLETE_MARKER || file === SCHEMA_SIDECAR) throw new Error(`d1-dump: sidecar name ${name} is reserved`);
    out[file] = value;
  }
  return out;
}
