import { COMPLETE_MARKER, SCHEMA_SIDECAR, type CompleteMarker, type SchemaSidecar } from "./dump.js";
import { restoreDump, type RestoreOptions, type RestoreResult } from "./restore.js";
import { DEFAULT_STALE_HOURS, latestDump } from "./runs.js";
import { quoteIdent } from "./schema.js";
import type { D1Like, D1Statement, R2Like } from "./types.js";

// D1 refuses one SQL statement over 100,000 bytes (developers.cloudflare.com/d1/platform/limits).
export const D1_MAX_STATEMENT_BYTES = 100_000;
export const SCRATCH_PREFIX = "restore-drill-";

export interface StatementStats {
  statements: number;
  batches: number;
  // The longest SQL text prepared, in UTF-8 bytes. Bound values are not part of it.
  maxStatementBytes: number;
  // The largest single bound text or BLOB, in characters or bytes.
  maxBoundValue: number;
  // The most text and BLOB the statements of one batch bound together.
  maxBatchBound: number;
}

function boundOf(values: unknown[]): number {
  return values.reduce<number>((n, v) => n + (typeof v === "string" || Array.isArray(v) ? v.length : 0), 0);
}

// Wraps a database so every statement is measured before it is sent. A statement over
// D1's cap throws here and is never sent, so a drill that finishes is a drill in which
// none was.
export function guardStatements(db: D1Like): { db: D1Like; stats: StatementStats } {
  const stats: StatementStats = { statements: 0, batches: 0, maxStatementBytes: 0, maxBoundValue: 0, maxBatchBound: 0 };
  // Each wrapper maps back to the statement it stands for, and to the size it bound.
  const real = new WeakMap<D1Statement, { inner: D1Statement; bound: number }>();
  const wrap = (inner: D1Statement, bound: number): D1Statement => {
    const stmt: D1Statement = {
      bind: (...values) => {
        for (const v of values) if (typeof v === "string" || Array.isArray(v)) stats.maxBoundValue = Math.max(stats.maxBoundValue, v.length);
        return wrap(inner.bind(...values), boundOf(values));
      },
      all: ((): Promise<{ results: never[] }> => {
        stats.statements++;
        return inner.all() as Promise<{ results: never[] }>;
      }) as D1Statement["all"],
      run: () => {
        stats.statements++;
        return inner.run();
      },
    };
    real.set(stmt, { inner, bound });
    return stmt;
  };
  const guarded: D1Like = {
    prepare: (sql) => {
      const bytes = new TextEncoder().encode(sql).length;
      if (bytes > D1_MAX_STATEMENT_BYTES) throw new Error(`d1-dump: a statement of ${bytes} bytes is over D1's ${D1_MAX_STATEMENT_BYTES} byte cap and was not sent`);
      stats.maxStatementBytes = Math.max(stats.maxStatementBytes, bytes);
      return wrap(db.prepare(sql), 0);
    },
    batch: (statements) => {
      const parts = statements.map((s) => real.get(s) ?? { inner: s, bound: 0 });
      stats.batches++;
      stats.statements += statements.length;
      stats.maxBatchBound = Math.max(stats.maxBatchBound, parts.reduce((n, p) => n + p.bound, 0));
      return db.batch(parts.map((p) => p.inner));
    },
  };
  return { db: guarded, stats };
}

export interface Scratch {
  db: D1Like;
  delete(): Promise<void>;
}

export interface DrillOptions {
  // Creates an empty scratch database with this name. The name always starts with
  // restore-drill-, so a leaked one is recognisable and nothing else is ever written.
  createScratch: (name: string) => Promise<Scratch>;
  // A pinned run prefix, e.g. backups/json/<run id>/. Defaults to the newest complete run.
  prefix?: string;
  now?: Date;
  pid?: number;
  // A dump older than this many hours fails the drill. null turns the check off.
  maxAgeHours?: number | null;
  restore?: RestoreOptions;
}

export interface DrillCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DrillResult {
  ok: boolean;
  scratch: string;
  run: string | null;
  checks: DrillCheck[];
  restored: RestoreResult | null;
  stats: StatementStats | null;
}

export function scratchName(now: Date, pid: number): string {
  return `${SCRATCH_PREFIX}${now.toISOString().slice(0, 10)}-${pid}`;
}

async function readJson<T>(bucket: R2Like, key: string): Promise<T> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`${key} is missing`);
  return JSON.parse(await obj.text()) as T;
}

async function count(db: D1Like, table: string): Promise<number> {
  const { results } = await db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).all<{ n: number }>();
  return results[0]?.n ?? Number.NaN;
}

// A word of four or more letters from the first text a table holds, to search for.
function wordIn(rows: Array<Record<string, unknown>>, column: string): string | null {
  for (const row of rows) {
    const v = row[column];
    const m = typeof v === "string" ? /[A-Za-z]{4,}/.exec(v) : null;
    if (m) return m[0];
  }
  return null;
}

// Restores the newest complete dump (or a pinned run) into a scratch database it
// creates, checks the copy, and deletes the scratch database whatever happened. It
// reports failed checks rather than throwing, so a caller sees every one.
//
// Checks, each carrying what it read so "ok" cannot mean "read nothing":
//   dump      the run is complete and no older than maxAgeHours
//   restore   restoreDump finished, which itself checks each table against the marker
//   counts    every table's rows, counted again in the copy, equal the marker's
//   fts       each external FTS5 index holds as many documents as its content table
//             (counted through _docsize: COUNT(*) on the FTS table reads through to the
//             content table and cannot disagree), and each internal one its dumped rows
//   search    a word taken from a restored row is found through the rebuilt index
//   statements  no statement sent was over D1's cap
//   scratch   the scratch database is deleted
export async function runRestoreDrill(bucket: R2Like, options: DrillOptions): Promise<DrillResult> {
  const now = options.now ?? new Date();
  const name = scratchName(now, options.pid ?? (globalThis as { process?: { pid?: number } }).process?.pid ?? 0);
  const checks: DrillCheck[] = [];
  const check = (n: string, ok: boolean, detail: string) => checks.push({ name: n, ok, detail });
  let run: string | null = null;
  let restored: RestoreResult | null = null;
  let stats: StatementStats | null = null;

  const latest = options.prefix ? null : await latestDump(bucket);
  const prefix = options.prefix ?? latest?.prefix ?? null;
  let marker: CompleteMarker | null = null;
  if (!prefix) {
    check("dump", false, "no complete dump found");
  } else {
    run = prefix;
    try {
      marker = await readJson<CompleteMarker>(bucket, `${prefix}${COMPLETE_MARKER}`);
      await readJson<SchemaSidecar>(bucket, `${prefix}${SCHEMA_SIDECAR}`);
      const maxAge = options.maxAgeHours === undefined ? DEFAULT_STALE_HOURS : options.maxAgeHours;
      const ageHours = (now.getTime() - Date.parse(marker.exported_at)) / 3_600_000;
      if (maxAge !== null && !(ageHours <= maxAge)) {
        check("dump", false, `exported ${marker.exported_at}, ${ageHours.toFixed(1)}h before the drill, over ${maxAge}h`);
      } else {
        check("dump", true, `${prefix} exported ${marker.exported_at}, ${marker.tables.length} tables`);
      }
    } catch (err) {
      marker = null;
      check("dump", false, (err as Error).message);
    }
  }

  if (prefix && marker) {
    const scratch = await options.createScratch(name);
    try {
      const guarded = guardStatements(scratch.db);
      stats = guarded.stats;
      try {
        restored = await restoreDump(guarded.db, bucket, prefix, options.restore);
        check("restore", true, `${restored.tables.length} tables, ${restored.rebuilt.length} FTS5 indexes rebuilt, ${restored.empty.length} contentless left empty`);
      } catch (err) {
        check("restore", false, (err as Error).message);
      }
      if (restored) await verify(guarded.db, bucket, marker, check);
      check(
        "statements",
        stats.statements > 0 && stats.maxStatementBytes <= D1_MAX_STATEMENT_BYTES,
        `${stats.statements} statements in ${stats.batches} batches, longest ${stats.maxStatementBytes} bytes of ${D1_MAX_STATEMENT_BYTES}; largest bound value ${stats.maxBoundValue}, most bound by one batch ${stats.maxBatchBound}`
      );
    } finally {
      try {
        await scratch.delete();
        check("scratch", true, `${name} deleted`);
      } catch (err) {
        check("scratch", false, `${name} was NOT deleted, delete it by hand: ${(err as Error).message}`);
      }
    }
  }
  return { ok: checks.every((c) => c.ok), scratch: name, run, checks, restored, stats };
}

async function verify(db: D1Like, bucket: R2Like, marker: CompleteMarker, check: (n: string, ok: boolean, detail: string) => void): Promise<void> {
  let total = 0;
  const wrong: string[] = [];
  for (const t of marker.tables) {
    const n = await count(db, t.name);
    total += n;
    if (n !== t.rows) wrong.push(`${t.name} has ${n}, the marker says ${t.rows}`);
  }
  check("counts", wrong.length === 0 && total > 0, wrong.length > 0 ? wrong.join("; ") : total === 0 ? "the copy holds no rows at all" : `${marker.tables.length} tables, ${total} rows, all equal to the marker`);

  const behind: string[] = [];
  let indexed = 0;
  for (const f of marker.fts) {
    if (f.mode === "external" && f.content) {
      const docs = await count(db, `${f.name}_docsize`);
      const rows = await count(db, f.content);
      indexed += docs;
      if (docs !== rows) behind.push(`${f.name} indexes ${docs} documents, ${f.content} holds ${rows}`);
    } else if (f.mode === "internal") {
      const dumped = marker.tables.find((t) => t.name === f.name)?.rows;
      const docs = await count(db, `${f.name}_docsize`);
      indexed += docs;
      if (docs !== dumped) behind.push(`${f.name} indexes ${docs} documents, the dump held ${dumped}`);
    }
  }
  check("fts", behind.length === 0, behind.length > 0 ? behind.join("; ") : `${marker.fts.length} FTS5 tables, ${indexed} indexed documents`);

  // One search: the first external or internal index that holds a document.
  for (const f of marker.fts) {
    if (f.mode === "contentless") continue;
    const source = f.mode === "external" ? f.content! : f.name;
    const file = marker.tables.find((t) => t.name === source);
    if (!file || file.rows === 0) continue;
    const { results: cols } = await db.prepare(`PRAGMA table_info(${quoteIdent(f.name)})`).all<{ name: string }>();
    const { rows } = await readJson<{ rows: Array<Record<string, unknown>> }>(bucket, file.key);
    for (const col of cols) {
      const word = wordIn(rows, col.name);
      if (!word) continue;
      const { results } = await db.prepare(`SELECT rowid FROM ${quoteIdent(f.name)} WHERE ${quoteIdent(f.name)} MATCH ?1`).bind(`"${word}"`).all();
      check("search", results.length > 0, results.length > 0 ? `"${word}" found ${results.length} document(s) in ${f.name}.${col.name}` : `"${word}" is in a restored ${source} row but ${f.name} does not find it`);
      return;
    }
  }
  check("search", false, "no FTS5 table held a word to search for, so no search ran");
}
