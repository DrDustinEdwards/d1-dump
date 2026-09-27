import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dumpDatabase } from "../src/index.js";
import { exec, sandbox } from "./helpers.js";

// The failure this package exists to avoid, reproduced with the wrangler the tests pin:
// `wrangler d1 export` refuses any database holding an FTS5 table. It is D1's own
// export that refuses, so the local database shows what the remote one does
// (capsid/core.md, "D1 export is broken by FTS5").

const WRANGLER = join(import.meta.dirname, "..", "node_modules", "wrangler", "bin", "wrangler.js");

function wrangler(dir: string, args: string[]) {
  return spawnSync(process.execPath, [WRANGLER, ...args, "--local"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    timeout: 120_000,
  });
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "d1-dump-repro-"));
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "repro",
      main: "w.js",
      compatibility_date: "2026-07-01",
      d1_databases: [{ binding: "DB", database_name: "sample", database_id: "00000000-0000-0000-0000-000000000000" }],
    })
  );
  writeFileSync(join(dir, "w.js"), "export default { fetch() { return new Response('ok') } }");
  return dir;
}

const NOTES = "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (body) VALUES ('hello')";
const NOTES_FTS = "CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='notes', content_rowid='id'); INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')";

describe("wrangler d1 export on FTS5", { timeout: 240_000 }, () => {
  test("refuses a database with an FTS5 table, and writes no file", () => {
    const dir = project();
    expect(wrangler(dir, ["d1", "execute", "DB", "--command", `${NOTES}; ${NOTES_FTS}`]).status).toBe(0);
    const out = wrangler(dir, ["d1", "export", "DB", "--output", "out.sql"]);
    expect(out.status).toBe(1);
    expect(out.stdout + out.stderr).toMatch(/cannot export databases with Virtual Tables \(fts5\)/);
    expect(existsSync(join(dir, "out.sql"))).toBe(false);
  });

  test("exports the same database once the FTS5 table is gone, so the FTS5 table is the cause", () => {
    const dir = project();
    expect(wrangler(dir, ["d1", "execute", "DB", "--command", NOTES]).status).toBe(0);
    const out = wrangler(dir, ["d1", "export", "DB", "--output", "out.sql"]);
    expect(out.status).toBe(0);
    expect(existsSync(join(dir, "out.sql"))).toBe(true);
  });
});

test("dumpDatabase dumps that same FTS5 database", async () => {
  const { src, bucket, dispose } = await sandbox();
  try {
    await exec(src, [
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)",
      "INSERT INTO notes (body) VALUES ('hello')",
      "CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='notes', content_rowid='id')",
      "INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')",
    ]);
    const result = await dumpDatabase(src, bucket, { now: new Date("2026-09-27T09:00:00.000Z") });
    expect(result.tables.map((t) => [t.name, t.rows])).toEqual([["notes", 1]]);
    expect(result.fts).toEqual([{ name: "notes_fts", mode: "external", content: "notes" }]);
  } finally {
    await dispose();
  }
});
