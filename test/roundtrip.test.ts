import { afterEach, beforeEach, expect, test } from "vitest";
import { COMPLETE_MARKER, dumpDatabase, readPlan, restoreDump, type D1Like, type R2Like } from "../src/index.js";
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

test("every table is dumped, FTS5 shadow tables are not, and each FTS5 table is classified", async () => {
  const result = await dumpDatabase(src, bucket, { now: NOW });
  expect(result.tables.map((t) => [t.name, t.rows]).sort()).toEqual(
    [["comments", 3], ["glossary", 2], ["posts", 2], ["settings", 2]].sort()
  );
  expect(result.fts).toEqual([
    { name: "posts_fts", mode: "external", content: "posts" },
    { name: "glossary", mode: "internal" },
    { name: "hits", mode: "contentless" },
  ]);
  // The shadow tables exist in the source, and none of them was written.
  expect(result.shadow_skipped.length).toBeGreaterThanOrEqual(12);
  for (const shadow of result.shadow_skipped) expect(result.keys.some((k) => k.endsWith(`/${shadow}.json`))).toBe(false);
  expect(result.keys.at(-1)).toBe(`backups/json/2026-09-27T09-00-00-000Z/${COMPLETE_MARKER}`);
});

test("a dump restored into a scratch database matches the source, row for row", async () => {
  const dumped = await dumpDatabase(src, bucket, { now: NOW });
  const restored = await restoreDump(dst, bucket, dumped.prefix);
  expect(restored.rebuilt).toEqual(["posts_fts"]);
  expect(restored.empty).toEqual(["hits"]);
  for (const sql of [
    "SELECT id, slug, body, hex(cover) AS cover FROM posts ORDER BY id",
    "SELECT * FROM comments ORDER BY id",
    "SELECT rowid, term, meaning FROM glossary ORDER BY rowid",
    "SELECT * FROM settings ORDER BY k",
    "SELECT * FROM post_counts ORDER BY post_id",
  ]) {
    expect(await rows(dst, sql)).toEqual(await rows(src, sql));
  }
  // Search works on the copy: the external index rebuilt, the internal one restored.
  expect(await rows(dst, "SELECT rowid FROM posts_fts WHERE posts_fts MATCH 'capsid'")).toEqual([{ rowid: 1 }]);
  expect(await rows(dst, "SELECT rowid FROM glossary WHERE glossary MATCH 'shell'")).toEqual([{ rowid: 7 }]);
  // Triggers were created after the rows, and work on new ones.
  await exec(dst, ["INSERT INTO posts (slug, body) VALUES ('third', 'portal vertex')"]);
  expect(await rows(dst, "SELECT rowid FROM posts_fts WHERE posts_fts MATCH 'portal'")).toEqual([{ rowid: 3 }]);
  // AUTOINCREMENT carried on from the restored ids rather than restarting.
  expect(await rows(dst, "SELECT id FROM posts WHERE slug = 'third'")).toEqual([{ id: 3 }]);
});

// 9.6 MB in six rows, over one 8 MiB part. Few large rows rather than many small ones,
// because Miniflare on Windows writes many rows slowly (1200 rows took a minute).
test("a large append-only table is paged and streamed as a multipart object, and restores whole", { timeout: 180_000 }, async () => {
  await exec(src, ["CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, detail TEXT)"]);
  const detail = "x".repeat(1_600_000);
  for (let i = 0; i < 6; i++) await src.prepare("INSERT INTO audit (detail) VALUES (?1)").bind(detail).run();
  const dumped = await dumpDatabase(src, bucket, { now: NOW, paged: { audit: { idColumn: "id", pageRows: 2 } } });
  expect(dumped.tables.find((t) => t.name === "audit")?.rows).toBe(6);
  const restored = await restoreDump(dst, bucket, dumped.prefix, { batchRows: 1 });
  expect(restored.tables.find((t) => t.name === "audit")?.rows).toBe(6);
  expect(await rows(dst, "SELECT MIN(id) AS lo, MAX(id) AS hi, SUM(length(detail)) AS bytes FROM audit")).toEqual([{ lo: 1, hi: 6, bytes: 9_600_000 }]);
});

test("a failed write leaves no marker, so the run is not a complete dump", async () => {
  let puts = 0;
  const failing: R2Like = {
    ...bucket,
    get: (k) => bucket.get(k),
    list: (o) => bucket.list(o),
    delete: (k) => bucket.delete(k),
    createMultipartUpload: (k, o) => bucket.createMultipartUpload(k, o),
    put: async (key, value, opts) => {
      if (++puts === 2) throw new Error("planted R2 failure");
      return bucket.put(key, value, opts);
    },
  };
  await expect(dumpDatabase(src, failing, { now: NOW })).rejects.toThrow("planted R2 failure");
  const listed = (await bucket.list({ prefix: "backups/json/" })).objects.map((o) => o.key);
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.some((k) => k.endsWith(COMPLETE_MARKER))).toBe(false);
  await expect(restoreDump(dst, bucket, "backups/json/2026-09-27T09-00-00-000Z/")).rejects.toThrow(/not a complete dump/);
});

test("a restore whose table file lost rows is refused", async () => {
  const dumped = await dumpDatabase(src, bucket, { now: NOW });
  const key = dumped.tables.find((t) => t.name === "comments")!.key;
  const file = JSON.parse(await (await bucket.get(key))!.text());
  file.rows.pop();
  await bucket.put(key, JSON.stringify(file));
  await expect(restoreDump(dst, bucket, dumped.prefix)).rejects.toThrow(/comments\.json holds 2 rows, the marker says 3/);
});

test("options that name no table are refused, so an exclude list cannot rot", async () => {
  await expect(dumpDatabase(src, bucket, { exclude: ["no_such_table"] })).rejects.toThrow(/no_such_table is named in the options/);
  await expect(dumpDatabase(src, bucket, { paged: { gone: { idColumn: "id", pageRows: 10 } } })).rejects.toThrow(/gone is named/);
  const dumped = await dumpDatabase(src, bucket, { now: NOW, exclude: ["settings"] });
  expect(dumped.tables.map((t) => t.name)).not.toContain("settings");
});

test("sidecars are written before the marker and listed in it", async () => {
  const dumped = await dumpDatabase(src, bucket, { now: NOW, sidecars: { kv: { keys: { mode: "off" } } } });
  const marker = JSON.parse(await (await bucket.get(`${dumped.prefix}${COMPLETE_MARKER}`))!.text());
  expect(marker.keys).toContain(`${dumped.prefix}_kv.json`);
  expect(JSON.parse(await (await bucket.get(`${dumped.prefix}_kv.json`))!.text())).toEqual({ exported_at: NOW.toISOString(), keys: { mode: "off" } });
  await expect(dumpDatabase(src, bucket, { sidecars: { complete: {} } })).rejects.toThrow(/reserved/);
});

test("the plan puts a parent table before the tables that reference it", async () => {
  await exec(src, [
    "CREATE TABLE a_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES z_parent(id))",
    "CREATE TABLE z_parent (id INTEGER PRIMARY KEY)",
  ]);
  const { tables } = await readPlan(src);
  expect(tables.indexOf("z_parent")).toBeLessThan(tables.indexOf("a_child"));
});
