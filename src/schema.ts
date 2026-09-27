import type { D1Like } from "./types.js";

// What a dump holds, read from sqlite_master rather than typed by each site, so a
// table added by a migration is dumped without anyone editing a list.

export interface SchemaEntry {
  type: "table" | "index" | "trigger" | "view";
  name: string;
  tbl_name: string;
  sql: string;
}

// internal: the text lives in the FTS table's own shadow tables, so the FTS table is
//   dumped through its columns and restored by inserting them.
// external: content='<table>', so the text is in an ordinary table the dump already
//   holds, and the restore rebuilds the index from it.
// contentless: content='', so SQLite keeps no text at all. Nothing can be dumped; the
//   restore creates the table empty and reports it.
export type FtsMode = "internal" | "external" | "contentless";

export interface FtsTable {
  name: string;
  mode: FtsMode;
  content?: string;
}

export interface Plan {
  // Ordinary tables, parents before the tables whose foreign keys name them.
  tables: string[];
  fts: FtsTable[];
  // The FTS5 shadow tables left out of the dump; SQLite creates them with their table.
  shadow: string[];
  // Everything the restore creates, shadow tables and SQLite's own left out.
  schema: SchemaEntry[];
}

const FTS5_SHADOW_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"];

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// SQLite's own tables and Cloudflare's (_cf_KV, _cf_METADATA): neither is the site's
// data, and D1 refuses reads of the second.
function isInternal(name: string): boolean {
  return name.startsWith("sqlite_") || name.startsWith("_cf_");
}

function ftsMode(sql: string): { mode: FtsMode; content?: string } {
  const m = /\bcontent\s*=\s*(?:'((?:[^']|'')*)'|"((?:[^"]|"")*)"|([A-Za-z_]\w*))/i.exec(sql);
  if (!m) return { mode: "internal" };
  const content = (m[1] ?? m[2] ?? m[3] ?? "").replace(/''/g, "'").replace(/""/g, '"');
  return content === "" ? { mode: "contentless" } : { mode: "external", content };
}

// Parents first, by the REFERENCES clauses in each CREATE TABLE, so a restore inserting
// one table per batch never inserts a child before its parent. A cycle keeps the
// schema's own order for the tables in it.
function parentsFirst(tables: SchemaEntry[]): string[] {
  const names = new Set(tables.map((t) => t.name));
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const refs = new Set<string>();
    for (const m of t.sql.matchAll(/\bREFERENCES\s+(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_]\w*))/gi)) {
      const ref = (m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/""/g, '"');
      if (ref !== t.name && names.has(ref)) refs.add(ref);
    }
    deps.set(t.name, refs);
  }
  const order: string[] = [];
  const placed = new Set<string>();
  let progress = true;
  while (order.length < tables.length && progress) {
    progress = false;
    for (const t of tables) {
      if (placed.has(t.name)) continue;
      if ([...(deps.get(t.name) ?? [])].every((d) => placed.has(d))) {
        order.push(t.name);
        placed.add(t.name);
        progress = true;
      }
    }
  }
  for (const t of tables) if (!placed.has(t.name)) order.push(t.name);
  return order;
}

export async function readPlan(db: D1Like): Promise<Plan> {
  const { results } = await db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid")
    .all<SchemaEntry>();
  const entries = results.filter((e) => !isInternal(e.name) && !isInternal(e.tbl_name));

  const fts: FtsTable[] = [];
  const shadow = new Set<string>();
  for (const e of entries) {
    if (e.type !== "table" || !/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(e.sql)) continue;
    // Any other virtual table (rtree, fts3, fts4) is refused rather than skipped: the
    // dump would otherwise report success without it.
    if (!/\bUSING\s+fts5\s*\(/i.test(e.sql)) throw new Error(`d1-dump: ${e.name} is a virtual table that is not FTS5; this package dumps FTS5 only`);
    fts.push({ name: e.name, ...ftsMode(e.sql) });
    for (const suffix of FTS5_SHADOW_SUFFIXES) shadow.add(e.name + suffix);
  }
  const ftsNames = new Set(fts.map((f) => f.name));
  const schema = entries.filter((e) => !shadow.has(e.name) && !(e.type !== "table" && shadow.has(e.tbl_name)));
  const ordinary = schema.filter((e) => e.type === "table" && !ftsNames.has(e.name));
  return {
    tables: parentsFirst(ordinary),
    fts,
    shadow: entries.filter((e) => e.type === "table" && shadow.has(e.name)).map((e) => e.name),
    schema,
  };
}
