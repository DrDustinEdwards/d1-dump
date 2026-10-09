import { COMPLETE_MARKER, DEFAULT_PREFIX, type CompleteMarker } from "./dump.js";
import { deleteInChunks, listAllKeys } from "./r2.js";
import type { R2Like } from "./types.js";

// A daily dump plus a 2 hour grace, as Capsid's /health uses.
export const DEFAULT_STALE_HOURS = 26;
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_MIN_KEPT = 14;

// Run id -> its keys, newest run first. A run id is the ISO time with ':' and '.'
// replaced, so it sorts as the time does.
async function runsOf(bucket: R2Like, prefix: string): Promise<Array<{ id: string; keys: string[]; complete: boolean }>> {
  const byRun = new Map<string, string[]>();
  for (const key of await listAllKeys(bucket, prefix)) {
    const id = key.slice(prefix.length).split("/")[0];
    if (!id || !key.slice(prefix.length).includes("/")) continue;
    byRun.set(id, [...(byRun.get(id) ?? []), key]);
  }
  return [...byRun.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([id, keys]) => ({ id, keys, complete: keys.includes(`${prefix}${id}/${COMPLETE_MARKER}`) }));
}

export interface LatestDump {
  run_id: string;
  prefix: string;
  exported_at: string;
}

// The newest complete dump, or null when there is none.
export async function latestDump(bucket: R2Like, options: { prefix?: string } = {}): Promise<LatestDump | null> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  for (const run of await runsOf(bucket, prefix)) {
    const obj = await bucket.get(`${prefix}${run.id}/${COMPLETE_MARKER}`);
    if (!obj) continue;
    const marker = JSON.parse(await obj.text()) as CompleteMarker;
    return { run_id: run.id, prefix: `${prefix}${run.id}/`, exported_at: marker.exported_at };
  }
  return null;
}

// The shape Capsid's /health reports under `backup`, which the console's operations
// page reads as backup.age_hours. A failure to read is a warning, never an exception,
// so a health route that calls this still answers.
export interface BackupHealth {
  last_ok: string | null;
  age_hours: number | null;
  warning?: string;
}

export async function backupHealth(
  bucket: R2Like,
  options: { prefix?: string; now?: Date; staleHours?: number } = {}
): Promise<BackupHealth> {
  const staleHours = options.staleHours ?? DEFAULT_STALE_HOURS;
  let latest: LatestDump | null;
  try {
    latest = await latestDump(bucket, { prefix: options.prefix });
  } catch (err) {
    return { last_ok: null, age_hours: null, warning: `backup freshness unreadable: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` };
  }
  if (!latest) return { last_ok: null, age_hours: null, warning: "no complete dump found" };
  const stamped = Date.parse(latest.exported_at);
  if (Number.isNaN(stamped)) return { last_ok: latest.exported_at, age_hours: null, warning: `the newest dump's time is not parseable: ${String(latest.exported_at).slice(0, 40)}` };
  const ageMs = (options.now ?? new Date()).getTime() - stamped;
  const ageHours = Math.round((ageMs / 3_600_000) * 10) / 10;
  const result: BackupHealth = { last_ok: latest.exported_at, age_hours: ageHours };
  if (ageMs > staleHours * 3_600_000) result.warning = `last complete dump was ${ageHours}h ago, over the ${staleHours}h threshold`;
  return result;
}

export interface PruneResult {
  kept: number;
  pruned: number;
}

// Graduated retention, the default (capsid/rulings/shared-homes-2026-10-06.md): the
// newest complete run of each of the last `daily` UTC days, of each of the last
// `weekly` ISO weeks (Monday to Sunday) and of each of the last `monthly` calendar
// months, counting the current one in each case. The three sets overlap, so the default
// 14 + 8 + 6 keeps about 25 runs from a daily history and reaches back six months.
export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}
export const DEFAULT_RETENTION: RetentionPolicy = { daily: 14, weekly: 8, monthly: 6 };

const DAY_MS = 86_400_000;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
// The Monday of the ISO week a UTC day falls in, as a day string. Keyed this way the
// year boundary needs no week-number arithmetic.
function mondayOf(day: string): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return dayOf(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS);
}

function wantedKeys(now: Date, policy: RetentionPolicy): { days: Set<string>; weeks: Set<string>; months: Set<string> } {
  const today = Date.parse(`${dayOf(now.getTime())}T00:00:00.000Z`);
  const days = new Set<string>();
  for (let k = 0; k < policy.daily; k++) days.add(dayOf(today - k * DAY_MS));
  const thisMonday = Date.parse(`${mondayOf(dayOf(today))}T00:00:00.000Z`);
  const weeks = new Set<string>();
  for (let k = 0; k < policy.weekly; k++) weeks.add(dayOf(thisMonday - k * 7 * DAY_MS));
  const months = new Set<string>();
  const here = new Date(today);
  for (let k = 0; k < policy.monthly; k++) {
    months.add(new Date(Date.UTC(here.getUTCFullYear(), here.getUTCMonth() - k, 1)).toISOString().slice(0, 7));
  }
  return { days, weeks, months };
}

export interface RunRef {
  id: string;
  complete: boolean;
}

export interface SelectOptions {
  now?: Date;
  policy?: RetentionPolicy;
  retentionDays?: number;
  minKept?: number;
}

// Which runs retention deletes, from a list of run ids and the time. Pure: no bucket, no
// disk, so a caller that holds its runs some other way (a directory of run folders) uses
// the same rule pruneDumps does. With no retentionDays or minKept it applies the
// graduated policy (options.policy, DEFAULT_RETENTION). Passing retentionDays or minKept
// asks for the older flat rule instead: a run older than retentionDays is deleted whole,
// except that the minKept newest COMPLETE runs are kept whatever their age.
//
// Either way: the newest complete run is never pruned; an incomplete run holds no slot
// and is kept only while it is inside the daily window (flat: inside retentionDays), so
// it stays as evidence for a while and then ages out; and nothing is selected while no
// complete run exists, since that is what an emptied or misbound bucket looks like.
// Returns the ids to delete, newest first; the input order does not matter.
export function selectStaleRuns(runs: RunRef[], options: SelectOptions = {}): string[] {
  const now = options.now ?? new Date();
  const sorted = [...runs].sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
  const complete = sorted.filter((r) => r.complete);
  if (complete.length === 0) return [];

  let stale: RunRef[];
  if (options.retentionDays !== undefined || options.minKept !== undefined) {
    const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const minKept = options.minKept ?? DEFAULT_MIN_KEPT;
    const floor = new Set(complete.slice(0, minKept).map((r) => r.id));
    const cutoffDay = new Date(now.getTime() - retentionDays * DAY_MS).toISOString().slice(0, 10);
    stale = sorted.filter((r) => !floor.has(r.id) && r.id.slice(0, 10) < cutoffDay);
  } else {
    const policy = options.policy ?? DEFAULT_RETENTION;
    const { days, weeks, months } = wantedKeys(now, policy);
    const keep = new Set<string>([complete[0].id]);
    // `complete` is newest first, so the first run seen for a key is the newest of it.
    const seenDay = new Set<string>();
    const seenWeek = new Set<string>();
    const seenMonth = new Set<string>();
    for (const r of complete) {
      const day = r.id.slice(0, 10);
      const week = mondayOf(day);
      const month = day.slice(0, 7);
      if (days.has(day) && !seenDay.has(day)) keep.add(r.id);
      if (weeks.has(week) && !seenWeek.has(week)) keep.add(r.id);
      if (months.has(month) && !seenMonth.has(month)) keep.add(r.id);
      seenDay.add(day);
      seenWeek.add(week);
      seenMonth.add(month);
    }
    stale = sorted.filter((r) => !keep.has(r.id) && !(!r.complete && days.has(r.id.slice(0, 10))));
  }
  return stale.map((r) => r.id);
}

// Prunes dumps in a bucket: selectStaleRuns over the runs under the prefix, each stale run
// deleted whole.
export async function pruneDumps(
  bucket: R2Like,
  options: { prefix?: string; now?: Date; policy?: RetentionPolicy; retentionDays?: number; minKept?: number } = {}
): Promise<PruneResult> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const runs = await runsOf(bucket, prefix);
  const gone = new Set(selectStaleRuns(runs, options));
  const stale = runs.filter((r) => gone.has(r.id));
  await deleteInChunks(bucket, stale.flatMap((r) => r.keys));
  return { kept: runs.length - stale.length, pruned: stale.length };
}
