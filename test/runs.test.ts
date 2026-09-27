import { afterEach, beforeEach, expect, test } from "vitest";
import { COMPLETE_MARKER, backupHealth, latestDump, pruneDumps, runIdFor, type R2Like } from "../src/index.js";
import { sandbox } from "./helpers.js";

let bucket: R2Like;
let dispose: () => Promise<void>;
beforeEach(async () => ({ bucket, dispose } = await sandbox()));
afterEach(async () => dispose());

const P = "backups/json/";

// A run as the dump leaves it: one table file, and the marker when complete.
async function run(at: string, complete: boolean): Promise<string> {
  const id = runIdFor(new Date(at));
  await bucket.put(`${P}${id}/posts.json`, JSON.stringify({ exported_at: at, table: "posts", rows: [] }));
  if (complete) await bucket.put(`${P}${id}/${COMPLETE_MARKER}`, JSON.stringify({ exported_at: at, keys: [], tables: [], fts: [], excluded: [] }));
  return id;
}

async function runIds(): Promise<string[]> {
  const keys = (await bucket.list({ prefix: P })).objects.map((o) => o.key);
  return [...new Set(keys.map((k) => k.slice(P.length).split("/")[0]))].sort();
}

test("backup health reports the newest complete dump in Capsid's /health shape, and skips an incomplete newer run", async () => {
  await run("2026-09-26T09:00:00.000Z", true);
  await run("2026-09-27T09:00:00.000Z", false);
  const now = new Date("2026-09-27T12:00:00.000Z");
  expect(await backupHealth(bucket, { now })).toEqual({ last_ok: "2026-09-26T09:00:00.000Z", age_hours: 27, warning: "last complete dump was 27h ago, over the 26h threshold" });
  expect(await backupHealth(bucket, { now: new Date("2026-09-26T21:30:00.000Z") })).toEqual({ last_ok: "2026-09-26T09:00:00.000Z", age_hours: 12.5 });
  expect((await latestDump(bucket))?.run_id).toBe("2026-09-26T09-00-00-000Z");
});

test("backup health with no complete dump is a warning, not a missing field", async () => {
  expect(await backupHealth(bucket)).toEqual({ last_ok: null, age_hours: null, warning: "no complete dump found" });
  await run("2026-09-27T09:00:00.000Z", false);
  expect(await backupHealth(bucket)).toEqual({ last_ok: null, age_hours: null, warning: "no complete dump found" });
});

test("backup health that cannot read the bucket says so rather than throwing", async () => {
  const broken = { ...bucket, list: async () => { throw new Error("bucket unbound"); } } as R2Like;
  expect(await backupHealth(broken)).toEqual({ last_ok: null, age_hours: null, warning: "backup freshness unreadable: bucket unbound" });
});

test("prune keeps by age with a floor of the newest complete runs, and an incomplete run holds no slot", async () => {
  // Twenty daily complete runs, the newest 2026-09-20, plus two old incomplete ones.
  for (let d = 1; d <= 20; d++) await run(`2026-06-${String(d).padStart(2, "0")}T09:00:00.000Z`, true);
  await run("2026-05-01T09:00:00.000Z", false);
  await run("2026-06-21T09:00:00.000Z", false);
  // 2026-09-27 less 90 days is 2026-06-29: every run is past retention, so only the
  // floor survives: the 14 newest complete runs, 06-07 to 06-20.
  const result = await pruneDumps(bucket, { now: new Date("2026-09-27T12:00:00.000Z") });
  expect(result).toEqual({ kept: 14, pruned: 8 });
  const left = await runIds();
  expect(left[0]).toBe("2026-06-07T09-00-00-000Z");
  expect(left.at(-1)).toBe("2026-06-20T09-00-00-000Z");
});

test("prune keeps a run inside retention even past the floor", async () => {
  for (let d = 1; d <= 20; d++) await run(`2026-09-${String(d).padStart(2, "0")}T09:00:00.000Z`, true);
  expect(await pruneDumps(bucket, { now: new Date("2026-09-27T12:00:00.000Z") })).toEqual({ kept: 20, pruned: 0 });
});

test("prune deletes nothing while no complete run exists, which is what a wrong bucket looks like", async () => {
  await run("2026-01-01T09:00:00.000Z", false);
  expect(await pruneDumps(bucket, { now: new Date("2026-09-27T12:00:00.000Z") })).toEqual({ kept: 1, pruned: 0 });
  expect(await runIds()).toEqual(["2026-01-01T09-00-00-000Z"]);
});
