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

// Retention by age with a floor, never by count: a run older than retentionDays is
// deleted whole, except that the minKept newest COMPLETE runs are kept whatever their
// age. An incomplete run holds no slot in the floor and ages out like any other.
// Refuses to delete anything while no complete run exists, since that is what an
// emptied or misbound bucket looks like.
export async function pruneDumps(
  bucket: R2Like,
  options: { prefix?: string; now?: Date; retentionDays?: number; minKept?: number } = {}
): Promise<PruneResult> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const minKept = options.minKept ?? DEFAULT_MIN_KEPT;
  const runs = await runsOf(bucket, prefix);
  const complete = runs.filter((r) => r.complete);
  if (complete.length === 0) return { kept: runs.length, pruned: 0 };
  const floor = new Set(complete.slice(0, minKept).map((r) => r.id));
  const cutoffDay = new Date(now.getTime() - retentionDays * 86_400_000).toISOString().slice(0, 10);
  const stale = runs.filter((r) => !floor.has(r.id) && r.id.slice(0, 10) < cutoffDay);
  await deleteInChunks(bucket, stale.flatMap((r) => r.keys));
  return { kept: runs.length - stale.length, pruned: stale.length };
}
