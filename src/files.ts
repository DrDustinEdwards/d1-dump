import { JSON_TYPE } from "./r2.js";
import { DEFAULT_STALE_HOURS, ageOf, isLockRefusal, type BackupHealth } from "./runs.js";
import type { R2FilesLike, R2ObjectLike } from "./types.js";

export const FILES_PREFIX = "files/";
export const FILES_COMPLETE = "_complete.json";
export const FILES_PROGRESS = "_progress.json";
// The source etag of the version a backup copy holds, kept in the copy's customMetadata.
// Compared with the source's etag as listed, so a multipart etag compares as well as any.
export const SOURCE_ETAG = "d1-dump-source-etag";
export const DEFAULT_KEEP_DELETED_DAYS = 30;
export const DEFAULT_MAX_OBJECTS = 1000;
export const DEFAULT_TIME_BUDGET_MS = 300_000;

const DAY_MS = 86_400_000;

export interface FilesOptions {
  // The source's name in the backup: its copies go under files/<name>/.
  name: string;
  // An object gone from the source is kept this long after it is first seen gone, then removed.
  keepDeletedDays?: number;
  // Copies and removals one run may make, and how long it may take. A run that reaches
  // either stops, saves where it was, and the next run carries the pass on from there.
  maxObjects?: number;
  timeBudgetMs?: number;
  now?: Date;
}

// Totals for one pass, which may take several runs.
export interface FilesCounts {
  // Source objects examined.
  objects: number;
  copied: number;
  // Already held at the source's etag.
  skipped: number;
  // Listed in the source but gone before it could be read.
  gone: number;
  // Gone from the source and still inside keepDeletedDays.
  kept_deleted: number;
  removed: number;
  // A copy or removal a bucket lock refused; the next pass tries again.
  locked: number;
  // Source keys that are the backup's own bookkeeping names, which cannot be copied.
  reserved: number;
}

export interface FilesComplete extends FilesCounts {
  started_at: string;
  finished_at: string;
}

interface Progress {
  started_at: string | null;
  // The last source key the pass handled; null starts a new pass.
  after: string | null;
  counts: FilesCounts;
  // Source key -> when it was first seen gone. `missing` is the last whole pass's, read;
  // `seen_missing` is this pass's, written, and replaces it when the pass completes.
  missing: Record<string, string>;
  seen_missing: Record<string, string>;
}

export interface FilesResult {
  name: string;
  // Whether this run finished the pass and wrote _complete.json.
  complete: boolean;
  // This run's copies and removals, and the pass's totals so far.
  worked: number;
  counts: FilesCounts;
  // Source keys met this run that could not be copied because they are the backup's own
  // names. A pass that met one is not marked complete, so health warns.
  reserved: string[];
}

const zero = (): FilesCounts => ({ objects: 0, copied: 0, skipped: 0, gone: 0, kept_deleted: 0, removed: 0, locked: 0, reserved: 0 });

// R2 lists keys in UTF-8 byte order, which a JavaScript string comparison does not follow
// past the Basic Multilingual Plane.
const utf8 = new TextEncoder();
function compareKeys(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

async function* listFrom(bucket: R2FilesLike, prefix: string, startAfter: string | undefined): AsyncGenerator<R2ObjectLike> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, startAfter: cursor ? undefined : startAfter, include: ["httpMetadata", "customMetadata"] });
    yield* page.objects;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function readProgress(backup: R2FilesLike, key: string): Promise<Progress | null> {
  const obj = await backup.get(key);
  return obj ? (JSON.parse(await obj.text()) as Progress) : null;
}

// Copies every object of `source` into `backup` under files/<name>/<key>, with its
// httpMetadata and customMetadata, streaming each body. An object whose copy already
// carries its etag is skipped, so a nightly pass copies only what changed. The source is
// walked in key order beside the backup's copies, so a copy with no source object is found
// in the same walk: it is kept keepDeletedDays from when it was first seen gone, then removed.
//
// A run stops at maxObjects copies and removals or at timeBudgetMs, saving the last key it
// handled in files/<name>/_progress.json, and the next run goes on from that key. A key is a
// safer place to resume than a list cursor, which is not documented to outlive a run. When
// the walk reaches the end it writes files/<name>/_complete.json with the pass's times and
// counts, which filesHealth reads.
//
// Nothing here reads or writes the source except its list and get. A copy or removal that a
// bucket lock refuses (R2 error 10069) is counted in `locked` and tried again next pass; any
// other failure throws, leaving the progress of the last saved run.
export async function backupFiles(source: R2FilesLike, backup: R2FilesLike, options: FilesOptions): Promise<FilesResult> {
  const { name } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`d1-dump: a files backup name is letters, digits, '.', '_' and '-', not ${JSON.stringify(name)}`);
  const keepMs = (options.keepDeletedDays ?? DEFAULT_KEEP_DELETED_DAYS) * DAY_MS;
  const maxObjects = options.maxObjects ?? DEFAULT_MAX_OBJECTS;
  const deadline = Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const now = options.now ?? new Date();
  const base = `${FILES_PREFIX}${name}/`;
  const progressKey = `${base}${FILES_PROGRESS}`;
  const completeKey = `${base}${FILES_COMPLETE}`;

  const saved = await readProgress(backup, progressKey);
  const progress: Progress =
    saved && saved.after !== null
      ? saved
      : { started_at: now.toISOString(), after: null, counts: zero(), missing: saved?.missing ?? {}, seen_missing: {} };
  const { counts } = progress;
  const reserved: string[] = [];
  let worked = 0;

  const sources = listFrom(source, "", progress.after ?? undefined);
  const copies = listFrom(backup, base, progress.after === null ? undefined : `${base}${progress.after}`);
  let s = await sources.next();
  let b = await copies.next();
  const nextCopy = async () => {
    do b = await copies.next();
    while (!b.done && (b.value.key === progressKey || b.value.key === completeKey));
  };
  if (!b.done && (b.value.key === progressKey || b.value.key === completeKey)) await nextCopy();

  const locking = async (work: () => Promise<unknown>): Promise<boolean> => {
    worked++;
    try {
      await work();
      return true;
    } catch (err) {
      if (!isLockRefusal(err)) throw err;
      counts.locked++;
      return false;
    }
  };

  while (!s.done || !b.done) {
    if (worked >= maxObjects || Date.now() >= deadline) {
      await backup.put(progressKey, JSON.stringify(progress), JSON_TYPE);
      return { name, complete: false, worked, counts, reserved };
    }
    const copyKey = b.done ? null : b.value.key.slice(base.length);
    const order = s.done ? 1 : copyKey === null ? -1 : compareKeys(s.value.key, copyKey);
    const key = order <= 0 ? (s.value as R2ObjectLike).key : (copyKey as string);

    if (order > 0) {
      // A copy whose source object is gone.
      const since = progress.missing[key] ?? now.toISOString();
      if (now.getTime() - Date.parse(since) < keepMs) {
        progress.seen_missing[key] = since;
        counts.kept_deleted++;
      } else if (await locking(() => backup.delete(`${base}${key}`))) {
        counts.removed++;
      } else {
        progress.seen_missing[key] = since;
      }
      await nextCopy();
    } else {
      const listed = s.value as R2ObjectLike;
      counts.objects++;
      if (key === FILES_PROGRESS || key === FILES_COMPLETE) {
        counts.reserved++;
        reserved.push(key);
      } else if (order === 0 && (b.value as R2ObjectLike).customMetadata?.[SOURCE_ETAG] === listed.etag) {
        counts.skipped++;
      } else {
        // Read again rather than trusting the listing: what is copied is what get returns.
        const obj = await source.get(key);
        if (!obj) counts.gone++;
        else if (
          await locking(() =>
            backup.put(`${base}${key}`, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: { ...obj.customMetadata, [SOURCE_ETAG]: obj.etag } })
          )
        )
          counts.copied++;
      }
      s = await sources.next();
      if (order === 0) await nextCopy();
    }
    progress.after = key;
  }

  const complete = counts.reserved === 0;
  if (complete) {
    const finished: FilesComplete = { started_at: progress.started_at ?? now.toISOString(), finished_at: now.toISOString(), ...counts };
    await backup.put(completeKey, JSON.stringify(finished), JSON_TYPE);
  }
  const next: Progress = { started_at: null, after: null, counts: zero(), missing: progress.seen_missing, seen_missing: {} };
  await backup.put(progressKey, JSON.stringify(next), JSON_TYPE);
  return { name, complete, worked, counts, reserved };
}

// The age of the newest complete files pass, in backupHealth's shape, for /health. Never throws.
export async function filesHealth(backup: R2FilesLike, options: { name: string; now?: Date; staleHours?: number }): Promise<BackupHealth> {
  const staleHours = options.staleHours ?? DEFAULT_STALE_HOURS;
  let marker: FilesComplete | null;
  try {
    const obj = await backup.get(`${FILES_PREFIX}${options.name}/${FILES_COMPLETE}`);
    marker = obj ? (JSON.parse(await obj.text()) as FilesComplete) : null;
  } catch (err) {
    return { last_ok: null, age_hours: null, warning: `files backup freshness unreadable: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` };
  }
  if (!marker) return { last_ok: null, age_hours: null, warning: `no complete files pass of ${options.name} found` };
  return ageOf(marker.finished_at, options.now ?? new Date(), staleHours, "files pass");
}

export interface RestoreFilesOptions {
  // The files backup to restore from: the copies under files/<name>/.
  name: string;
  // Only keys starting with this, as the source named them ("" for the whole backup).
  prefix?: string;
  // False (the default) is a dry run: nothing is written, and the result says what would be.
  apply?: boolean;
  // A target object that exists and differs from its copy is left alone unless this is set.
  overwrite?: boolean;
  // Go on from a key a stopped run returned in `after`.
  after?: string;
  // Writes one run may make, and how long it may take (backupFiles' defaults).
  maxObjects?: number;
  timeBudgetMs?: number;
}

export interface RestoreFilesCounts {
  // Copies examined.
  objects: number;
  // Absent from the target: restored, or would be on a dry run.
  missing: number;
  // Present in the target at the copy's source etag: nothing to do.
  same: number;
  // Present with other bytes: left alone, or overwritten (or would be) with `overwrite`.
  differs: number;
  // Writes made (always 0 on a dry run).
  written: number;
}

export interface RestoreFilesResult {
  name: string;
  applied: boolean;
  // Whether the walk reached the end. If not, run again with `after`.
  complete: boolean;
  after: string | null;
  counts: RestoreFilesCounts;
  // The first 100 keys restored or that would be, and the first 100 that differ.
  restore: string[];
  differ: string[];
}

const LISTED = 100;

// Copies a files backup's copies back into a bucket: files/<name>/<key> to <key>, with the
// httpMetadata and customMetadata it was backed up with (less d1-dump's own etag field), each
// body streamed. A dry run unless `apply` is true. A key already in the target at the same
// version is left; one that differs is left unless `overwrite` is set, so a restore into the
// live bucket only puts back what is missing. The target is walked beside the copies in key
// order, so it is listed once rather than read per key. Like backupFiles, a run stops at
// maxObjects writes or timeBudgetMs and returns `after` to go on from.
export async function restoreFiles(backup: R2FilesLike, target: R2FilesLike, options: RestoreFilesOptions): Promise<RestoreFilesResult> {
  const { name, prefix = "", apply = false, overwrite = false } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`d1-dump: a files backup name is letters, digits, '.', '_' and '-', not ${JSON.stringify(name)}`);
  const maxObjects = options.maxObjects ?? DEFAULT_MAX_OBJECTS;
  const deadline = Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const base = `${FILES_PREFIX}${name}/`;
  const own = new Set([`${base}${FILES_PROGRESS}`, `${base}${FILES_COMPLETE}`]);
  const counts: RestoreFilesCounts = { objects: 0, missing: 0, same: 0, differs: 0, written: 0 };
  const restore: string[] = [];
  const differ: string[] = [];
  let after = options.after ?? null;

  const copies = listFrom(backup, `${base}${prefix}`, after === null ? undefined : `${base}${after}`);
  const targets = listFrom(target, prefix, after ?? undefined);
  let t = await targets.next();
  for await (const copy of copies) {
    if (own.has(copy.key)) continue;
    if (counts.written >= maxObjects || Date.now() >= deadline) {
      return { name, applied: apply, complete: false, after, counts, restore, differ };
    }
    const key = copy.key.slice(base.length);
    while (!t.done && compareKeys(t.value.key, key) < 0) t = await targets.next();
    const held = !t.done && t.value.key === key ? t.value : null;
    counts.objects++;
    let write = false;
    if (!held) {
      counts.missing++;
      if (restore.length < LISTED) restore.push(key);
      write = true;
    } else if (held.etag === copy.customMetadata?.[SOURCE_ETAG]) {
      counts.same++;
    } else {
      counts.differs++;
      if (differ.length < LISTED) differ.push(key);
      write = overwrite;
    }
    if (write && apply) {
      const obj = await backup.get(copy.key);
      if (obj) {
        const { [SOURCE_ETAG]: _etag, ...customMetadata } = obj.customMetadata ?? {};
        await target.put(key, obj.body, { httpMetadata: obj.httpMetadata, customMetadata });
        counts.written++;
      }
    }
    after = key;
  }
  return { name, applied: apply, complete: true, after: null, counts, restore, differ };
}
