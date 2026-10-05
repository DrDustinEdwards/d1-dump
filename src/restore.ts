import { COMPLETE_MARKER, SCHEMA_SIDECAR, type CompleteMarker, type SchemaSidecar } from "./dump.js";
import { quoteIdent } from "./schema.js";
import type { D1Like, D1Statement, R2Like } from "./types.js";

// D1 binds at most 100 parameters to one statement.
const D1_MAX_PARAMS = 100;
const DEFAULT_BATCH_ROWS = 100;
// A batch is also cut by the size of the values it binds, so a table of large rows is
// not sent as one huge request. A single row over this is a batch of its own.
const DEFAULT_BATCH_BYTES = 1_000_000;

export interface RestoreOptions {
  // Rows inserted per D1 batch. Each batch is one transaction.
  batchRows?: number;
  // Bound text and BLOB size after which a batch is sent, whatever its row count.
  batchBytes?: number;
}

export interface RestoreResult {
  tables: Array<{ name: string; rows: number }>;
  // External-content FTS5 tables, rebuilt from their content tables.
  rebuilt: string[];
  // Contentless FTS5 tables, created empty: the dump held no text for them.
  empty: string[];
}

// Characters of a text value, bytes of a BLOB (an array of byte values), 8 for the rest.
// An estimate for batching, not a measurement.
function boundSize(v: unknown): number {
  return typeof v === "string" || Array.isArray(v) ? v.length : 8;
}

async function readJson<T>(bucket: R2Like, key: string): Promise<T> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`d1-dump: ${key} is missing from the dump`);
  return JSON.parse(await obj.text()) as T;
}

// Rebuilds one complete dump into `db`, which should be empty. Tables and FTS5 tables
// first, then the rows (parents before children), then each external FTS5 index is
// rebuilt, then indexes, triggers and views, so no trigger fires on restored rows.
// Every table's count is checked against the marker, and a mismatch throws.
export async function restoreDump(db: D1Like, bucket: R2Like, runPrefix: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  const prefix = runPrefix.endsWith("/") ? runPrefix : `${runPrefix}/`;
  const marker = await readJson<CompleteMarker>(bucket, `${prefix}${COMPLETE_MARKER}`).catch((err: Error) => {
    throw new Error(`d1-dump: ${prefix} has no readable ${COMPLETE_MARKER}, so it is not a complete dump (${err.message})`);
  });
  const { schema } = await readJson<SchemaSidecar>(bucket, `${prefix}${SCHEMA_SIDECAR}`);
  const batchRows = options.batchRows ?? DEFAULT_BATCH_ROWS;
  const batchBytes = options.batchBytes ?? DEFAULT_BATCH_BYTES;

  for (const e of schema.filter((s) => s.type === "table")) await db.prepare(e.sql).run();

  const restored: RestoreResult["tables"] = [];
  for (const table of marker.tables) {
    const { rows } = await readJson<{ rows: Array<Record<string, unknown>> }>(bucket, table.key);
    if (rows.length !== table.rows) throw new Error(`d1-dump: ${table.key} holds ${rows.length} rows, the marker says ${table.rows}`);
    if (rows.length > 0) {
      const columns = Object.keys(rows[0]);
      if (columns.length > D1_MAX_PARAMS) throw new Error(`d1-dump: ${table.name} has ${columns.length} columns, over D1's ${D1_MAX_PARAMS} bound parameters`);
      const sql = `INSERT INTO ${quoteIdent(table.name)} (${columns.map(quoteIdent).join(", ")}) VALUES (${columns.map((_, i) => `?${i + 1}`).join(", ")})`;
      let statements: D1Statement[] = [];
      let bytes = 0;
      const flush = async () => {
        if (statements.length === 0) return;
        await db.batch([db.prepare("PRAGMA defer_foreign_keys = ON"), ...statements]);
        statements = [];
        bytes = 0;
      };
      for (const row of rows) {
        const values = columns.map((c) => row[c]);
        statements.push(db.prepare(sql).bind(...values));
        bytes += values.reduce<number>((n, v) => n + boundSize(v), 0);
        if (statements.length >= batchRows || bytes >= batchBytes) await flush();
      }
      await flush();
    }
    const { results } = await db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table.name)}`).all<{ n: number }>();
    if (results[0]?.n !== table.rows) throw new Error(`d1-dump: ${table.name} restored ${results[0]?.n} rows, the dump holds ${table.rows}`);
    restored.push({ name: table.name, rows: table.rows });
  }

  const rebuilt: string[] = [];
  const empty: string[] = [];
  for (const f of marker.fts) {
    if (f.mode === "external") {
      await db.prepare(`INSERT INTO ${quoteIdent(f.name)} (${quoteIdent(f.name)}) VALUES ('rebuild')`).run();
      rebuilt.push(f.name);
    } else if (f.mode === "contentless") {
      empty.push(f.name);
    }
  }

  for (const type of ["index", "trigger", "view"] as const) {
    for (const e of schema.filter((s) => s.type === type)) await db.prepare(e.sql).run();
  }
  return { tables: restored, rebuilt, empty };
}
