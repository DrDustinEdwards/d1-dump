# d1-dump

A per-table D1 dump into a site's own R2 bucket, with a restore and a backup-age reading for health. It works where `wrangler d1 export` does not: D1 refuses to export any database that holds an FTS5 table (`D1 Export error: cannot export databases with Virtual Tables (fts5)`, reproduced in `test/reproduce.test.ts`).

It is Capsid's nightly dump (`src/backup.ts` in DrDustinEdwards/capsid), made into a package each site installs. D1 Time Travel already restores any minute of the last 30 days in place. This covers what Time Travel does not: a restore into a copy you can inspect first, history past 30 days, and a copy you can take outside the account.

## Install

Installed by git tag, never from a registry:

```sh
npm install github:DrDustinEdwards/d1-dump#v0.3.0
```

npm builds `dist/` on install through the `prepare` script. It needs no Cloudflare type package and no `nodejs_compat`.

## Dump nightly

```ts
import { dumpDatabase, pruneDumps } from "@dustinedwards/d1-dump";

export default {
  async scheduled(_event, env) {
    await dumpDatabase(env.DB, env.BACKUPS); // the site's own D1 and R2 bindings
    await pruneDumps(env.BACKUPS);           // 14 daily, 8 weekly, 6 monthly; the newest complete run always kept
  },
};
```

Each run writes `backups/json/<run id>/<table>.json` (`{exported_at, table, rows}`) for every table, `_schema.json` (the CREATE statements), and then `_complete.json`. The marker is written last, so a run without it did not finish. The tables are read from `sqlite_master`, so a table added by a migration is dumped with no list to edit.

- **FTS5.** Shadow tables are never dumped. An external-content FTS5 table (`content='posts'`) is rebuilt from its content table on restore. An internal-content one is dumped through its columns with its rowid. A contentless one (`content=''`) holds no text, so it is restored empty and reported. Any other virtual table fails the run.
- **One instant.** Every table is read in one D1 batch, which is one transaction. A table too large to hold in memory can be named in `paged` if it is append-only with a growing integer id. Its rows up to the snapshot's `MAX(id)` are then read in pages and streamed to R2 as a multipart object.
- **Options.** `prefix`, `paged`, `exclude` (a name that is not a table fails the run), and `sidecars` (extra `_<name>.json` objects written before the marker).
- **BLOBs** are written as D1 returns them, an array of byte values, which D1 stores back as a BLOB. Integers beyond 2^53 lose precision, as they do everywhere in D1's JavaScript API.

## Report its age

```ts
import { backupHealth } from "@dustinedwards/d1-dump";

// In GET /health: { last_ok, age_hours, warning? }, the shape Capsid's /health uses
// and the Capsid console reads as backup.age_hours.
const backup = await backupHealth(env.BACKUPS);
```

It warns past 26 hours by default (`staleHours`), and never throws.

## Restore

```ts
import { latestDump, restoreDump } from "@dustinedwards/d1-dump";

const latest = await latestDump(env.BACKUPS);
await restoreDump(env.SCRATCH_DB, env.BACKUPS, latest.prefix); // into an EMPTY database
```

`restoreDump` creates the tables, refuses any table whose rows do not carry exactly the columns its `CREATE` statement in `_schema.json` has (a column missing from every row is caught, not only one missing from some), inserts the rows parents first under `PRAGMA defer_foreign_keys`, rebuilds external FTS5 indexes, and only then creates indexes, triggers and views, so no trigger fires on restored rows. It checks every table's count against the marker and throws on a mismatch.

**Size limit.** `restoreDump` reads one table's file whole and holds it with its parsed rows. Paging applies only to the dump. A Worker isolate has 128 MB for the JavaScript heap and WebAssembly together (developers.cloudflare.com/workers/platform/limits). So a table whose file approaches that size, which is what `paged` exists for, will not restore inside a Worker. Restore it from Node instead, against a local D1 through Miniflare as the tests do, or split the file. The restore holds one table at a time, so it is the largest table that sets the limit, not the whole database.

## Complete only after your own checks

```ts
import { dumpDatabase, writeCompleteMarker } from "@dustinedwards/d1-dump";

const dump = await dumpDatabase(env.DB, env.BACKUPS, { markComplete: false });
if (await looksHealthy(env.DB)) await writeCompleteMarker(env.BACKUPS, dump);
```

A run left without its marker keeps its objects as evidence of what the database held that day. It is never the newest dump `latestDump` returns, and it holds no slot in the retention policy. It is deleted once it falls outside the daily window.

## Restore drill

A backup is proven by restoring it. The drill restores a dump into a scratch database it creates, checks the copy, and deletes the scratch database whatever the outcome. It replaces the restore rehearsals each site kept for itself. It has two backends: **sqlite**, a local SQLite file that needs no credential, for the weekly run; and **d1**, a scratch D1 database, for a run by hand.

```ts
import { runRestoreDrill } from "@dustinedwards/d1-dump";

const result = await runRestoreDrill(env.BACKUPS, {
  createScratch: async (name) => ({ db: scratchDb(name), delete: () => dropDb(name) }), // name is restore-drill-<date>-<pid>
});
if (!result.ok) throw new Error(result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; "));
```

From Node or CI, against a dump downloaded to a directory (`<dir>/backups/json/<run id>/...`):

```sh
npx d1-dump drill --dir ./dump                                  # sqlite, no credential
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npx d1-dump drill --dir ./dump --backend d1
```

With no `--backend`, the drill uses sqlite unless both Cloudflare variables are set, and its first output line says which ran and why (`backend: sqlite (no Cloudflare credentials are set)`). `--backend d1` without the variables is an error. The sqlite backend uses `node:sqlite`, built into Node (unflagged since 22.13; this package already requires Node 24.14.1), so it adds no dependency. Its scratch file lives in its own temporary directory, named `restore-drill-<date>-<pid>`, and the `scratch` check fails if the directory is still there after the delete. A batch is one transaction, as D1's is, and a BLOB comes back as a BLOB.

The d1 backend's token needs to create and delete D1 databases, and that permission covers every database in the account, so keep it out of scheduled CI. It is read from the environment, sent only as the Authorization header, and never printed. `--prefix backups/json/<run id>/` pins a run (the newest complete one is used otherwise) and `--max-age-hours off` skips the freshness check. The exit code is 1 when any check fails.

Seven checks run, and each reports what it read, so "ok" cannot mean "read nothing":

| Check | Fails when |
| --- | --- |
| `dump` | no complete run, or its marker is more than 26 hours old |
| `restore` | `restoreDump` throws, which includes its own count check against the marker |
| `counts` | a table, counted again after the restore, differs from the marker, or the copy holds no rows |
| `fts` | an external FTS5 index holds fewer documents than its content table (counted through `_docsize`, because `COUNT(*)` on an external-content FTS5 table reads through to the content table and cannot disagree), or an internal one fewer than the dump held |
| `search` | a word taken from a restored row is not found through the index, or no FTS5 table held a word to search for |
| `statements` | any statement sent was over D1's 100,000 byte cap, or none was sent |
| `scratch` | the scratch database was not deleted; the detail names it |

**No statement over the cap is ever sent.** Every statement passes through `guardStatements`, which measures the SQL text in UTF-8 bytes and throws on one over 100,000 before it reaches the database. Rows go in as short `INSERT ... VALUES (?1, ?2, ...)` statements with the values bound, so a row of any size is a short statement. This is the case that broke dustinedwards-info #347 (merge b692758f): `wrangler d1 export` wrote a 141 KB paper as one literal `INSERT`. `test/drill.test.ts` restores a 141 KB value with newlines, quotes and carriage returns, and a 1.5 MB value, byte for byte, and reads the longest statement and the largest bound value from the guard. The same test shows the cap is live in the test runtime by sending a 141 KB value as a literal, which is refused.

**Does D1 cap a single bound value?** Yes, at the row. D1's limits page lists "Maximum string, BLOB or table row size: 2,000,000 bytes (2 MB)" and "Maximum SQL statement length: 100,000 bytes", and does not say whether bound values count toward the second. Measured against the D1 that Miniflare 4.20260701.0 runs (workerd): a 141,000 character bound value is accepted, so is a 2,100,000 character one, and a 5,000,000 character one is refused with `string or blob too big: SQLITE_TOOBIG`. The same 141,000 characters as a literal in the statement is refused with `statement too long: SQLITE_TOOBIG`. So locally bound values do not count toward the 100 KB statement length, and they are capped by the string size instead. Not yet measured against Cloudflare's remote D1: the first real drill over a dump that holds a value over 100 KB is that measurement (see the seat steps). A value over 2 MB cannot be in a dump, because D1 would not have accepted it.

**Batches.** A batch is cut at 100 rows or at about 1 MB of bound text and BLOB, whichever comes first (`batchRows`, `batchBytes`), so a table of large rows is not sent a hundred rows to a request. A row over 1 MB is a batch of its own.

**Largest table it can restore.** `restoreDump` holds one table file as a string and as parsed rows at the same time. Measured in Node 24 (V8, as a Worker runs it) on a 20 MB file: the parsed rows took 1.18 times the file's size for many small rows and 1.0 times for a few large strings, so the string and the rows together are about 2.2 times the file. The R2 body that `text()` decodes can be live beside them, which makes 3 times the file the safe figure. A Worker isolate has 128 MB for everything, so budget about 40 MB for one table file inside a Worker, and never more than about 58 MB (128 / 2.2) before the runtime's own use. That is the table's JSON file, not the database: tables are restored one at a time, so the largest table sets the limit. From Node (the CLI) the limit is the heap, 4.5 GB by default on Node 24 (`v8.getHeapStatistics().heap_size_limit`), and the longest string V8 will build, 536,870,888 characters, so a table file over about 512 MB cannot be read at all. Neither figure has been run against a real dump of that size.

**What the sqlite backend cannot prove.** The checks are the same on both backends, and the 100,000 byte statement guard runs on both, but on sqlite it enforces the documented number against SQLite, not against D1. So sqlite does not show that D1 accepts every statement and value the restore sends: D1's remote bound-value cap (measured only against Miniflare's D1, above), its request and batch size limits, the REST API's own limits, or any difference between D1's SQLite build and Node's (FTS5 version, compile options). It is enough for a weekly check because the weekly question is whether this dump rebuilds into the right rows, a consistent FTS5 index and a working search, and none of that depends on D1's platform limits. Every row in a dump was accepted by D1 when it was written, and the restore sends values bound, never as literals. The d1 backend answers the platform question, and is run by hand, quarterly and after any change to the restore.

**Over REST.** The d1 backend cannot bind a BLOB through the REST API, so a table holding one fails the `restore` check with a message saying so. The sqlite backend restores BLOBs. To drill such a database against D1 itself, run the drill from a Worker with a binding.

**Running the d1 backend by hand.** It needs a token and creates a database, so it is run from the seat's machine, not scheduled. Download the newest complete run, then drill it:

```sh
npx wrangler r2 object get <bucket>/backups/json/<run id>/_complete.json --file dump/backups/json/<run id>/_complete.json   # once per object in the run
CLOUDFLARE_ACCOUNT_ID=<account id> CLOUDFLARE_API_TOKEN=<token> npx d1-dump drill --dir dump --backend d1
```

A d1 drill that dies before its `finally` leaves a database named `restore-drill-<date>-<pid>`. List them with `npx wrangler d1 list` and delete with `npx wrangler d1 delete <name>`.

## Tests

`npm test` runs every check against real D1 and R2 in Miniflare, including a dump restored into a scratch database and compared row for row, and the restore drill on both backends (`test/drill.test.ts`, `test/sqlite.test.ts`).

## Retention

`pruneDumps` keeps the newest complete run of each of the last 14 UTC days, each of the last 8 ISO weeks (Monday to Sunday) and each of the last 6 calendar months, counting the current day, week and month. The three sets overlap, so a daily history leaves about 25 runs and reaches back six months. The newest complete run is never deleted, and nothing is deleted while the bucket holds no complete run, which is what a wrong or emptied bucket looks like.

Pass another policy per caller:

```ts
await pruneDumps(env.BACKUPS, { policy: { daily: 7, weekly: 4, monthly: 12 } });
```

Passing `retentionDays` or `minKept` asks for the older flat rule instead: a run older than `retentionDays` (default 90) is deleted, except that the `minKept` (default 14) newest complete runs are kept whatever their age.
