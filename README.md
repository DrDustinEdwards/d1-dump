# d1-dump

A per-table D1 dump into a site's own R2 bucket, with a restore and a backup-age reading for health. It works where `wrangler d1 export` does not: D1 refuses to export any database that holds an FTS5 table (`D1 Export error: cannot export databases with Virtual Tables (fts5)`, reproduced in `test/reproduce.test.ts`).

It is Capsid's nightly dump (`src/backup.ts` in DrDustinEdwards/capsid), made into a package each site installs. D1 Time Travel already restores any minute of the last 30 days in place. This covers what Time Travel does not: a restore into a copy you can inspect first, history past 30 days, and a copy you can take outside the account.

## Install

Installed by git tag, never from a registry:

```sh
npm install github:DrDustinEdwards/d1-dump#v0.1.1
```

npm builds `dist/` on install through the `prepare` script. It needs no Cloudflare type package and no `nodejs_compat`.

## Dump nightly

```ts
import { dumpDatabase, pruneDumps } from "@dustinedwards/d1-dump";

export default {
  async scheduled(_event, env) {
    await dumpDatabase(env.DB, env.BACKUPS); // the site's own D1 and R2 bindings
    await pruneDumps(env.BACKUPS);           // 90 days, the 14 newest complete runs always kept
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

`restoreDump` creates the tables, inserts the rows parents first under `PRAGMA defer_foreign_keys`, rebuilds external FTS5 indexes, and only then creates indexes, triggers and views, so no trigger fires on restored rows. It checks every table's count against the marker and throws on a mismatch.

**Size limit.** `restoreDump` reads one table's file whole and holds it with its parsed rows. Paging applies only to the dump. A Worker isolate has 128 MB for the JavaScript heap and WebAssembly together (developers.cloudflare.com/workers/platform/limits). So a table whose file approaches that size, which is what `paged` exists for, will not restore inside a Worker. Restore it from Node instead, against a local D1 through Miniflare as the tests do, or split the file. The restore holds one table at a time, so it is the largest table that sets the limit, not the whole database.

## Complete only after your own checks

```ts
import { dumpDatabase, writeCompleteMarker } from "@dustinedwards/d1-dump";

const dump = await dumpDatabase(env.DB, env.BACKUPS, { markComplete: false });
if (await looksHealthy(env.DB)) await writeCompleteMarker(env.BACKUPS, dump);
```

A run left without its marker keeps its objects as evidence of what the database held that day. It is never the newest dump `latestDump` returns, and it holds no slot in the retention floor.

## Tests

`npm test` runs every check against real D1 and R2 in Miniflare, including a dump restored into a scratch database and compared row for row.
