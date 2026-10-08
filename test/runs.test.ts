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

test("flat prune (retentionDays or minKept given) keeps by age with a floor of the newest complete runs, and an incomplete run holds no slot", async () => {
  // Twenty daily complete runs, the newest 2026-09-20, plus two old incomplete ones.
  for (let d = 1; d <= 20; d++) await run(`2026-06-${String(d).padStart(2, "0")}T09:00:00.000Z`, true);
  await run("2026-05-01T09:00:00.000Z", false);
  await run("2026-06-21T09:00:00.000Z", false);
  // 2026-09-27 less 90 days is 2026-06-29: every run is past retention, so only the
  // floor survives: the 14 newest complete runs, 06-07 to 06-20.
  const result = await pruneDumps(bucket, { now: new Date("2026-09-27T12:00:00.000Z"), retentionDays: 90, minKept: 14 });
  expect(result).toEqual({ kept: 14, pruned: 8 });
  const left = await runIds();
  expect(left[0]).toBe("2026-06-07T09-00-00-000Z");
  expect(left.at(-1)).toBe("2026-06-20T09-00-00-000Z");
});

test("flat prune keeps a run inside retention even past the floor", async () => {
  for (let d = 1; d <= 20; d++) await run(`2026-09-${String(d).padStart(2, "0")}T09:00:00.000Z`, true);
  expect(await pruneDumps(bucket, { now: new Date("2026-09-27T12:00:00.000Z"), retentionDays: 90, minKept: 14 })).toEqual({ kept: 20, pruned: 0 });
});

test("prune deletes nothing while no complete run exists, which is what a wrong bucket looks like", async () => {
  await run("2026-01-01T09:00:00.000Z", false);
  expect(await pruneDumps(bucket, { now: new Date("2026-09-27T12:00:00.000Z") })).toEqual({ kept: 1, pruned: 0 });
  expect(await runIds()).toEqual(["2026-01-01T09-00-00-000Z"]);
});

// Graduated retention (the default): 14 daily, 8 weekly (ISO, Monday to Sunday), 6 monthly.

// One complete run at 09:00 UTC on every day from `from` to `to`, both inclusive, except
// the days named in `skip`.
async function daily(from: string, to: string, skip: string[] = []): Promise<void> {
  for (let ms = Date.parse(`${from}T00:00:00.000Z`); ms <= Date.parse(`${to}T00:00:00.000Z`); ms += 86_400_000) {
    const day = new Date(ms).toISOString().slice(0, 10);
    if (!skip.includes(day)) await run(`${day}T09:00:00.000Z`, true);
  }
}
const days = (ids: string[]) => ids.map((id) => id.slice(0, 10));

test("graduated prune keeps exactly the expected set over a 200 day history with a missing day and a second run in one day", async () => {
  // 2026-03-11 to 2026-09-27 is 200 days. 2026-09-27 is a Sunday. 2026-08-31 is missing,
  // so August's monthly copy falls to 08-30. 09-20 has an earlier run that must go.
  await daily("2026-03-11", "2026-09-27", ["2026-08-31"]);
  await run("2026-09-20T02:00:00.000Z", true);
  await pruneDumps(bucket, { now: new Date("2026-09-27T12:00:00.000Z") });
  const left = days(await runIds());
  expect(left).toEqual([
    "2026-04-30", // monthly, April
    "2026-05-31", // monthly, May
    "2026-06-30", // monthly, June
    "2026-07-31", // monthly, July
    "2026-08-09", // weekly, Monday 08-03
    "2026-08-16", // weekly, Monday 08-10
    "2026-08-23", // weekly, Monday 08-17
    "2026-08-30", // weekly, Monday 08-24, and August's monthly copy since 08-31 is missing
    "2026-09-06", // weekly, Monday 08-31
    "2026-09-13", // weekly, Monday 09-07
    ...Array.from({ length: 14 }, (_, k) => `2026-09-${String(14 + k).padStart(2, "0")}`), // the 14 dailies
  ]);
  expect(left).toHaveLength(24);
  // The 09-20 pair keeps the later run only.
  const keys = (await bucket.list({ prefix: P })).objects.map((o) => o.key);
  expect(keys.some((k) => k.includes("2026-09-20T02-00-00-000Z"))).toBe(false);
  expect(keys.some((k) => k.includes("2026-09-20T09-00-00-000Z"))).toBe(true);
});

test("graduated prune crosses a year boundary: December's copy and the week of New Year both survive", async () => {
  // 2027-01-03 is a Sunday, so its ISO week began Monday 2026-12-28.
  await daily("2026-06-01", "2027-01-03");
  await pruneDumps(bucket, { now: new Date("2027-01-03T12:00:00.000Z") });
  const left = days(await runIds());
  expect(left).toEqual([
    "2026-08-31", // monthly, August
    "2026-09-30", // monthly, September
    "2026-10-31", // monthly, October
    "2026-11-15", // weekly, Monday 11-09
    "2026-11-22", // weekly, Monday 11-16
    "2026-11-29", // weekly, Monday 11-23
    "2026-11-30", // monthly, November
    "2026-12-06", // weekly, Monday 11-30
    "2026-12-13", // weekly, Monday 12-07
    "2026-12-20", // weekly, Monday 12-14
    ...Array.from({ length: 11 }, (_, k) => `2026-12-${String(21 + k).padStart(2, "0")}`), // dailies, and December's copy 12-31
    "2027-01-01",
    "2027-01-02",
    "2027-01-03",
  ]);
  expect(left).toHaveLength(24);
});

test("graduated prune never removes the newest complete run, even when it is old, and ages out old incomplete runs only", async () => {
  await run("2026-01-05T09:00:00.000Z", true);
  await run("2026-01-04T09:00:00.000Z", false);
  await run("2026-09-26T09:00:00.000Z", false);
  const result = await pruneDumps(bucket, { now: new Date("2026-09-27T12:00:00.000Z") });
  // The only complete run is nine months old and is kept; the old incomplete run is not
  // in any window and goes; the incomplete run from yesterday is inside the daily window.
  expect(days(await runIds())).toEqual(["2026-01-05", "2026-09-26"]);
  expect(result).toEqual({ kept: 2, pruned: 1 });
});

test("graduated prune takes its windows from a policy the caller passes", async () => {
  await daily("2026-09-01", "2026-09-27");
  await pruneDumps(bucket, { now: new Date("2026-09-27T12:00:00.000Z"), policy: { daily: 3, weekly: 0, monthly: 0 } });
  expect(days(await runIds())).toEqual(["2026-09-25", "2026-09-26", "2026-09-27"]);
});
