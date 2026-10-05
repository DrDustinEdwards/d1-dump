import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from "vitest";
import { D1_MAX_STATEMENT_BYTES, dumpDatabase, restoreDump, runRestoreDrill, writeCompleteMarker, type D1Like, type DrillResult, type R2Like } from "../src/index.js";
import { pickBackend, sqliteScratch } from "../src/node.js";
import { SITE_ROWS, SITE_SCHEMA, exec, rows, sandbox } from "./helpers.js";

// The same drill against the tokenless backend: a local SQLite file (node:sqlite).

let src: D1Like;
let dst: D1Like;
let bucket: R2Like;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ src, dst, bucket, dispose } = await sandbox());
  await exec(src, [...SITE_SCHEMA, ...SITE_ROWS]);
});
afterEach(async () => dispose());

const NOW = new Date("2026-09-27T09:00:00.000Z");
const LATER = new Date("2026-09-27T10:00:00.000Z");

function checkOf(result: DrillResult, name: string) {
  const c = result.checks.find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} check ran: ${result.checks.map((x) => x.name).join(", ")}`);
  return c;
}

// A sqlite scratch backend that can rewrite statements, and reads a query from the copy
// just before the drill deletes it.
function scratchWith(options: { rewrite?: (sql: string) => string; readBeforeDelete?: string } = {}) {
  const make = sqliteScratch();
  const out = { names: [] as string[], read: undefined as unknown };
  return {
    out,
    createScratch: async (name: string) => {
      const scratch = await make(name);
      out.names.push(name);
      const { rewrite } = options;
      const db: D1Like = rewrite ? { prepare: (sql) => scratch.db.prepare(rewrite(sql)), batch: (s) => scratch.db.batch(s) } : scratch.db;
      return {
        db,
        delete: async () => {
          if (options.readBeforeDelete) out.read = (await scratch.db.prepare(options.readBeforeDelete).all()).results;
          return scratch.delete();
        },
      };
    },
  };
}

const REBUILD = (sql: string) => sql.includes("VALUES ('rebuild')");

test("sqlite: a good dump passes every check, and a BLOB comes back as a BLOB", async () => {
  await dumpDatabase(src, bucket, { now: NOW });
  const scratch = scratchWith({ readBeforeDelete: "SELECT typeof(cover) AS t, hex(cover) AS h FROM posts WHERE id = 1" });
  const result = await runRestoreDrill(bucket, { ...scratch, now: LATER, pid: 77 });
  expect(result.checks.filter((c) => !c.ok)).toEqual([]);
  expect(result.checks.map((c) => c.name)).toEqual(["dump", "restore", "counts", "fts", "search", "statements", "scratch"]);
  expect(result.scratch).toBe("restore-drill-2026-09-27-77");
  expect(scratch.out.read).toEqual([{ t: "blob", h: "00FF10" }]);
  expect(checkOf(result, "fts").detail).toMatch(/3 FTS5 tables, 4 indexed documents/);
});

test("sqlite: a 141 KB value with newlines restores byte for byte and no statement is over the cap", async () => {
  const paper = ("Phage isolation: it's 'quoted' \"twice\"\nline two\r\nline three\\n\n" + "capsid ".repeat(40)).repeat(420);
  await exec(src, ["CREATE TABLE papers (id INTEGER PRIMARY KEY, body TEXT)"]);
  await src.prepare("INSERT INTO papers (body) VALUES (?1)").bind(paper).run();
  await dumpDatabase(src, bucket, { now: NOW });
  const scratch = scratchWith({ readBeforeDelete: "SELECT body FROM papers" });
  const result = await runRestoreDrill(bucket, { ...scratch, now: LATER });
  expect(result.checks.filter((c) => !c.ok)).toEqual([]);
  expect(scratch.out.read).toEqual([{ body: paper }]);
  expect(result.stats!.maxStatementBytes).toBeLessThan(D1_MAX_STATEMENT_BYTES);
  expect(result.stats!.maxBoundValue).toBe(paper.length);
});

test("sqlite: a dropped FTS5 rebuild fails the fts and search checks", async () => {
  await dumpDatabase(src, bucket, { now: NOW });
  const result = await runRestoreDrill(bucket, { ...scratchWith({ rewrite: (sql) => (REBUILD(sql) ? "SELECT 1" : sql) }), now: LATER });
  expect(checkOf(result, "restore").ok).toBe(true);
  expect(checkOf(result, "fts")).toMatchObject({ ok: false });
  expect(checkOf(result, "fts").detail).toMatch(/posts_fts indexes 0 documents, posts holds 2/);
  expect(checkOf(result, "search")).toMatchObject({ ok: false });
});

test("sqlite: a row lost after the restore's own count check fails the recount, and the scratch file is still removed", async () => {
  await dumpDatabase(src, bucket, { now: NOW });
  const scratch = scratchWith({ rewrite: (sql) => (REBUILD(sql) ? 'DELETE FROM "comments" WHERE "id" = 3' : sql) });
  const result = await runRestoreDrill(bucket, { ...scratch, now: LATER });
  expect(checkOf(result, "counts")).toMatchObject({ ok: false, detail: "comments has 2, the marker says 3" });
  expect(checkOf(result, "scratch").ok).toBe(true);
  expect(scratch.out.names.length).toBe(1);
});

test("sqlite: the scratch directory is removed, and only a restore-drill name is created", async () => {
  const make = sqliteScratch();
  const scratch = await make("restore-drill-x");
  await scratch.db.prepare("CREATE TABLE t (a)").run();
  await scratch.delete();
  await expect(make("production")).rejects.toThrow(/refusing to create "production"/);
  expect(existsSync("restore-drill-x")).toBe(false);
});

test("sqlite: a batch is one transaction, so a failed statement leaves none of it", async () => {
  const s = await sqliteScratch()("restore-drill-t");
  await s.db.prepare("CREATE TABLE t (a INTEGER PRIMARY KEY)").run();
  await expect(s.db.batch([s.db.prepare("INSERT INTO t (a) VALUES (1)"), s.db.prepare("INSERT INTO t (a) VALUES (1)")])).rejects.toThrow();
  expect((await s.db.prepare("SELECT COUNT(*) AS n FROM t").all()).results).toEqual([{ n: 0 }]);
  await s.delete();
});

test("the backend is sqlite without credentials, d1 with them, and either can be asked for", () => {
  expect(pickBackend(undefined, false)).toEqual({ backend: "sqlite", why: "no Cloudflare credentials are set" });
  expect(pickBackend(undefined, true)).toEqual({ backend: "d1", why: "Cloudflare credentials are set" });
  expect(pickBackend("sqlite", true)).toEqual({ backend: "sqlite", why: "asked for" });
  expect(pickBackend("d1", false)).toEqual({ error: "--backend d1 needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment" });
  expect(pickBackend("oracle", false)).toMatchObject({ error: expect.stringContaining("sqlite or d1") });
});

// A column dropped from EVERY row of a table: row 0 agrees with its siblings, so only the
// schema can say it is missing.
test("a column missing from every row of a table is refused, naming it", async () => {
  const dumped = await dumpDatabase(src, bucket, { now: NOW, markComplete: false });
  const key = dumped.tables.find((t) => t.name === "comments")!.key;
  const file = JSON.parse(await (await bucket.get(key))!.text());
  for (const row of file.rows) delete row.text;
  await bucket.put(key, JSON.stringify(file));
  await writeCompleteMarker(bucket, dumped);
  await expect(restoreDump(dst, bucket, dumped.prefix)).rejects.toThrow(/comments row 0 does not match the schema's columns \(lacks: text;/);
});

test("a column the schema does not have is refused too, and an FTS5 table that carries a rowid is not", async () => {
  const dumped = await dumpDatabase(src, bucket, { now: NOW });
  const key = dumped.tables.find((t) => t.name === "settings")!.key;
  const file = JSON.parse(await (await bucket.get(key))!.text());
  for (const row of file.rows) row.extra = 1;
  await bucket.put(key, JSON.stringify(file));
  await expect(restoreDump(dst, bucket, dumped.prefix)).rejects.toThrow(/settings row 0 .*not in the schema: extra/);

  const clean = await sandbox();
  try {
    await exec(clean.src, [...SITE_SCHEMA, ...SITE_ROWS]);
    const ok = await dumpDatabase(clean.src, clean.bucket, { now: NOW });
    await restoreDump(clean.dst, clean.bucket, ok.prefix);
    expect((await rows(clean.dst, "SELECT rowid FROM glossary ORDER BY rowid")).map((r) => r.rowid)).toEqual([7, 9]);
  } finally {
    await clean.dispose();
  }
});
