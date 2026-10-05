import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { cloudflareScratch } from "../src/cloudflare.js";
import { directoryBucket } from "../src/node.js";
import { D1_MAX_STATEMENT_BYTES, dumpDatabase, guardStatements, runRestoreDrill, scratchName, type D1Like, type DrillResult, type R2Like } from "../src/index.js";
import { SITE_ROWS, SITE_SCHEMA, exec, rows, sandbox } from "./helpers.js";

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

// A scratch database that records whether the drill deleted it.
function scratchOf(db: D1Like) {
  const state = { names: [] as string[], deleted: 0 };
  return {
    state,
    createScratch: async (name: string) => {
      state.names.push(name);
      return { db, delete: async () => void state.deleted++ };
    },
  };
}

// Passes every statement on, except that `rewrite` may swap one for another.
function tamper(db: D1Like, rewrite: (sql: string) => string): D1Like {
  return {
    prepare: (sql) => db.prepare(rewrite(sql)),
    batch: (statements) => db.batch(statements),
  };
}

test("a good dump passes every check, and the scratch database is deleted", async () => {
  await dumpDatabase(src, bucket, { now: NOW });
  const scratch = scratchOf(dst);
  const result = await runRestoreDrill(bucket, { ...scratch, now: LATER, pid: 4242 });
  expect(result.checks.filter((c) => !c.ok)).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.scratch).toBe("restore-drill-2026-09-27-4242");
  expect(scratch.state).toEqual({ names: ["restore-drill-2026-09-27-4242"], deleted: 1 });
  expect(result.checks.map((c) => c.name)).toEqual(["dump", "restore", "counts", "fts", "search", "statements", "scratch"]);
  // Each check says what it read, so "ok" cannot mean "read nothing".
  expect(checkOf(result, "counts").detail).toMatch(/4 tables, 9 rows/);
  expect(checkOf(result, "fts").detail).toMatch(/3 FTS5 tables, 4 indexed documents/);
  expect(checkOf(result, "search").detail).toMatch(/found 1 document/);
  expect(scratchName(NOW, 7)).toBe("restore-drill-2026-09-27-7");
});

// The case that broke dustinedwards-info #347 (merge b692758f): wrangler's SQL export wrote
// a 141 KB paper as one literal INSERT, over D1's 100 KB statement cap. The JSON dump
// binds each value, so the same row goes in as a short statement.
test("a 141 KB value with newlines and quotes restores byte for byte, and no statement sent is over the cap", { timeout: 120_000 }, async () => {
  const paper = ("Phage isolation: it's 'quoted' \"twice\"\nline two\r\nline three\\n\n" + "capsid ".repeat(40)).repeat(420);
  expect(new TextEncoder().encode(paper).length).toBeGreaterThan(141_000);
  const big = "tail fibre\n".repeat(140_000);
  await exec(src, ["CREATE TABLE papers (id INTEGER PRIMARY KEY, body TEXT)"]);
  await src.prepare("INSERT INTO papers (body) VALUES (?1)").bind(paper).run();
  await src.prepare("INSERT INTO papers (body) VALUES (?1)").bind(big).run();
  await dumpDatabase(src, bucket, { now: NOW });

  // The cap is live in this environment: the same 141 KB value as a literal is refused.
  await expect(dst.prepare(`INSERT INTO settings (k, v) VALUES ('x', '${"y".repeat(141_000)}')`).run()).rejects.toThrow(/statement too long|SQLITE_TOOBIG/);

  const result = await runRestoreDrill(bucket, { ...scratchOf(dst), now: LATER, pid: 1 });
  expect(result.checks.filter((c) => !c.ok)).toEqual([]);
  expect(await rows(dst, "SELECT id, body FROM papers ORDER BY id")).toEqual([
    { id: 1, body: paper },
    { id: 2, body: big },
  ]);
  const stats = result.stats!;
  expect(stats.maxStatementBytes).toBeLessThan(D1_MAX_STATEMENT_BYTES);
  expect(stats.maxBoundValue).toBe(big.length);
  expect(stats.maxBoundValue).toBeGreaterThan(1_000_000);
  // Rows of that size are sent a batch each, not a hundred to a request.
  expect(stats.maxBatchBound).toBeLessThan(2 * big.length);
});

test("the guard throws on a statement over the cap before it reaches the database", async () => {
  const sent: string[] = [];
  const spy: D1Like = { prepare: (sql) => (sent.push(sql), dst.prepare(sql)), batch: (s) => dst.batch(s) };
  const { db, stats } = guardStatements(spy);
  db.prepare("SELECT 1");
  expect(() => db.prepare(`SELECT '${"y".repeat(D1_MAX_STATEMENT_BYTES)}'`)).toThrow(/over D1's 100000 byte cap and was not sent/);
  // Multi-byte text counts in bytes: 34,000 of 3 bytes is 102,000.
  expect(() => db.prepare(`SELECT '${"€".repeat(34_000)}'`)).toThrow(/was not sent/);
  expect(sent).toEqual(["SELECT 1"]);
  expect(stats.maxStatementBytes).toBe("SELECT 1".length);
});

test("a restore that loses a row fails the drill, and the scratch database is still deleted", async () => {
  await dumpDatabase(src, bucket, { now: NOW });
  const scratch = scratchOf(tamper(dst, (sql) => (sql.startsWith('INSERT INTO "comments"') ? 'INSERT INTO "comments" ("id", "post_id", "text") SELECT ?1, ?2, ?3 WHERE ?1 < 3' : sql)));
  const result = await runRestoreDrill(bucket, { ...scratch, now: LATER });
  expect(result.ok).toBe(false);
  expect(checkOf(result, "restore").detail).toMatch(/comments restored 2 rows, the dump holds 3/);
  expect(result.checks.map((c) => c.name)).not.toContain("counts");
  expect(scratch.state.deleted).toBe(1);
});

test("a dropped FTS5 rebuild fails the fts and search checks, though every table restored", async () => {
  await dumpDatabase(src, bucket, { now: NOW });
  const scratch = scratchOf(tamper(dst, (sql) => (sql.includes("VALUES ('rebuild')") ? "SELECT 1" : sql)));
  const result = await runRestoreDrill(bucket, { ...scratch, now: LATER });
  expect(checkOf(result, "restore").ok).toBe(true);
  expect(checkOf(result, "counts").ok).toBe(true);
  expect(checkOf(result, "fts")).toMatchObject({ ok: false });
  expect(checkOf(result, "fts").detail).toMatch(/posts_fts indexes 0 documents, posts holds 2/);
  expect(checkOf(result, "search")).toMatchObject({ ok: false });
  expect(result.ok).toBe(false);
});

test("a stale dump fails the drill, and maxAgeHours: null turns the check off", async () => {
  await dumpDatabase(src, bucket, { now: NOW });
  const late = new Date("2026-09-29T09:00:00.000Z");
  const stale = await runRestoreDrill(bucket, { ...scratchOf(dst), now: late });
  expect(checkOf(stale, "dump")).toMatchObject({ ok: false });
  expect(checkOf(stale, "dump").detail).toMatch(/48\.0h before the drill, over 26h/);
  // The stale drill still restored into dst, so the second run needs an empty database.
  const fresh = await sandbox();
  try {
    const off = await runRestoreDrill(bucket, { ...scratchOf(fresh.dst), now: late, maxAgeHours: null });
    expect(off.ok).toBe(true);
  } finally {
    await fresh.dispose();
  }
});

test("an empty bucket fails the drill without creating a scratch database", async () => {
  const scratch = scratchOf(dst);
  const result = await runRestoreDrill(bucket, { ...scratch, now: LATER });
  expect(result.ok).toBe(false);
  expect(result.checks).toEqual([{ name: "dump", ok: false, detail: "no complete dump found" }]);
  expect(scratch.state.names).toEqual([]);
});

test("a scratch database that cannot be deleted is reported by name", async () => {
  await dumpDatabase(src, bucket, { now: NOW });
  const result = await runRestoreDrill(bucket, {
    createScratch: async () => ({ db: dst, delete: async () => Promise.reject(new Error("API 500")) }),
    now: LATER,
    pid: 9,
  });
  expect(checkOf(result, "scratch")).toEqual({ name: "scratch", ok: false, detail: "restore-drill-2026-09-27-9 was NOT deleted, delete it by hand: API 500" });
});

test("a row lost after the restore's own count check fails the drill's recount", async () => {
  await dumpDatabase(src, bucket, { now: NOW });
  // The rebuild runs after every table's count is checked, so a row it deletes is one only the drill's recount can see.
  const scratch = scratchOf(tamper(dst, (sql) => (sql.includes("VALUES ('rebuild')") ? 'DELETE FROM "comments" WHERE "id" = 3' : sql)));
  const result = await runRestoreDrill(bucket, { ...scratch, now: LATER });
  expect(checkOf(result, "restore").ok).toBe(true);
  expect(checkOf(result, "counts")).toMatchObject({ ok: false, detail: "comments has 2, the marker says 3" });
  expect(result.ok).toBe(false);
});

// Copies a dump out of the bucket into a directory, as `wrangler r2 object get` would.
async function download(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "d1-dump-drill-"));
  for (const obj of (await bucket.list({ prefix: "backups/" })).objects) {
    const file = join(root, ...obj.key.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, await (await bucket.get(obj.key))!.text());
  }
  return root;
}

test("a downloaded directory is a read-only bucket the drill runs from", async () => {
  const dumped = await dumpDatabase(src, bucket, { now: NOW });
  const dir = directoryBucket(await download());
  expect((await dir.list({ prefix: "backups/json/" })).objects.map((o) => o.key).sort()).toEqual([...dumped.keys].sort());
  expect(await dir.get("backups/json/none/_complete.json")).toBeNull();
  await expect(dir.get("../outside.json")).rejects.toThrow(/outside/);
  await expect(dir.put("k", "v")).rejects.toThrow(/read only/);
  const result = await runRestoreDrill(dir, { ...scratchOf(dst), now: LATER });
  expect(result.checks.filter((c) => !c.ok)).toEqual([]);
});

// Cloudflare's D1 REST API, answered by the Miniflare database, so the adapter's requests
// are read by something that runs them. It does not enforce the real API's limits.
function fakeCloudflare(target: D1Like, calls: Array<{ method: string; path: string; auth: string | null; body: unknown }>): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method: init.method!, path, auth: new Headers(init.headers).get("authorization"), body });
    const reply = (result: unknown, success = true, status = 200) => new Response(JSON.stringify({ success, result, errors: success ? [] : [{ message: "nope" }] }), { status });
    if (init.method === "POST" && path.endsWith("/d1/database")) return reply({ uuid: "scratch-uuid" });
    if (init.method === "DELETE") return reply({});
    const run = async (q: { sql: string; params?: unknown[] }) => ({ results: (await target.prepare(q.sql).bind(...(q.params ?? [])).all()).results });
    if (body.batch) {
      const out = [];
      for (const q of body.batch) out.push(await run(q));
      return reply(out);
    }
    return reply([await run(body)]);
  }) as unknown as typeof fetch;
}

test("the REST scratch adapter creates, fills and deletes a database named restore-drill-*", async () => {
  await exec(src, ["UPDATE posts SET cover = NULL"]);
  await dumpDatabase(src, bucket, { now: NOW });
  const calls: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
  const create = cloudflareScratch("acct", "tok", fakeCloudflare(dst, calls));
  const result = await runRestoreDrill(bucket, { createScratch: create, now: LATER, pid: 5 });
  expect(result.checks.filter((c) => !c.ok)).toEqual([]);
  expect(calls[0]).toMatchObject({ method: "POST", path: "/client/v4/accounts/acct/d1/database", auth: "Bearer tok", body: { name: "restore-drill-2026-09-27-5" } });
  expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/client/v4/accounts/acct/d1/database/scratch-uuid" });
  expect(calls.some((c) => c.path.endsWith("/scratch-uuid/query"))).toBe(true);
  expect((await rows(dst, "SELECT COUNT(*) AS n FROM comments"))[0].n).toBe(3);
});

test("the REST adapter refuses a name that is not a scratch name, and never echoes the token", async () => {
  const calls: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
  const create = cloudflareScratch("acct", "secret-token", fakeCloudflare(dst, calls));
  await expect(create("dustinedwards")).rejects.toThrow(/refusing to create "dustinedwards"/);
  expect(calls).toEqual([]);
  const failing = cloudflareScratch("acct", "secret-token", (async () => new Response(JSON.stringify({ success: false, result: null, errors: [{ message: "bad token" }] }), { status: 403 })) as unknown as typeof fetch);
  const err = await failing("restore-drill-x").catch((e: Error) => e);
  expect((err as Error).message).toBe("d1-dump: POST /d1/database failed (403): bad token");
  expect((err as Error).message).not.toContain("secret-token");
});

test("a table holding a BLOB cannot be bound over REST, and says so", async () => {
  await dumpDatabase(src, bucket, { now: NOW });
  const scratch = await cloudflareScratch("acct", "tok", fakeCloudflare(dst, []))("restore-drill-b");
  expect(() => scratch.db.prepare("INSERT INTO posts (cover) VALUES (?1)").bind([0, 255])).toThrow(/cannot bind a BLOB/);
});

test("only node.ts imports node:, so the package entry bundles into a Worker", () => {
  const dir = join(import.meta.dirname, "..", "src");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  expect(files.length).toBeGreaterThanOrEqual(11);
  const withNode = files.filter((f) => /from "node:/.test(readFileSync(join(dir, f), "utf8")));
  expect(withNode.sort()).toEqual(["node.ts"]);
  expect(readFileSync(join(dir, "index.ts"), "utf8")).not.toMatch(/\.\/(cli|node)\.js/);
});
