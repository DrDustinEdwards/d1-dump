import { Miniflare } from "miniflare";
import type { D1Like, R2Like } from "../src/index.js";

// Real D1 (SQLite with FTS5) and R2, in-process, as workerd runs them.
export async function sandbox(): Promise<{ src: D1Like; dst: D1Like; bucket: R2Like; dispose: () => Promise<void> }> {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: ["SRC", "DST"],
    r2Buckets: ["BUCKET"],
  });
  const src = (await mf.getD1Database("SRC")) as unknown as D1Like;
  const dst = (await mf.getD1Database("DST")) as unknown as D1Like;
  const bucket = (await mf.getR2Bucket("BUCKET")) as unknown as R2Like;
  return { src, dst, bucket, dispose: () => mf.dispose() };
}

export async function exec(db: D1Like, statements: string[]): Promise<void> {
  for (const sql of statements) await db.prepare(sql).run();
}

export async function rows(db: D1Like, sql: string): Promise<Array<Record<string, unknown>>> {
  return (await db.prepare(sql).all()).results;
}

// A site-shaped schema: a parent and a child joined by a foreign key, an external-
// content FTS5 index kept in step by triggers, an internal-content FTS5 table, a
// contentless one, a WITHOUT ROWID table, a BLOB column, an index and a view.
export const SITE_SCHEMA = [
  "CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, body TEXT, cover BLOB)",
  "CREATE TABLE comments (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id), text TEXT)",
  "CREATE VIRTUAL TABLE posts_fts USING fts5(body, content='posts', content_rowid='id')",
  "CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN INSERT INTO posts_fts(rowid, body) VALUES (new.id, new.body); END",
  "CREATE VIRTUAL TABLE glossary USING fts5(term, meaning)",
  "CREATE VIRTUAL TABLE hits USING fts5(q, content='')",
  "CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID",
  "CREATE INDEX comments_post ON comments(post_id)",
  "CREATE VIEW post_counts AS SELECT post_id, COUNT(*) AS n FROM comments GROUP BY post_id",
];

export const SITE_ROWS = [
  "INSERT INTO posts (slug, body, cover) VALUES ('first', 'phage capsid packaging', X'00FF10')",
  "INSERT INTO posts (slug, body, cover) VALUES ('second', 'tail fibre binding', NULL)",
  "INSERT INTO comments (id, post_id, text) VALUES (1, 1, 'nice'), (2, 1, 'agreed'), (3, 2, 'hm')",
  "INSERT INTO glossary (rowid, term, meaning) VALUES (7, 'capsid', 'the protein shell'), (9, 'virion', 'a whole particle')",
  "INSERT INTO hits (q) VALUES ('capsid')",
  "INSERT INTO settings (k, v) VALUES ('theme', 'dark'), ('lang', 'en')",
];
