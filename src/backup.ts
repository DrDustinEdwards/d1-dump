import { dumpDatabase, writeCompleteMarker, type DumpOptions, type DumpResult } from "./dump.js";
import { pruneDumps, type PruneResult, type RetentionPolicy } from "./runs.js";
import type { D1Like, R2Like } from "./types.js";

export interface BackupOptions extends Omit<DumpOptions, "markComplete"> {
  // Tables that must be in the dump: the ones that hold what exists nowhere else.
  required?: string[];
  // The site's own checks, run after the standard ones. Each string is one failed check.
  check?: (dump: DumpResult) => string[] | Promise<string[]>;
  // Passed to pruneDumps. The default is its graduated retention.
  retention?: { policy?: RetentionPolicy; retentionDays?: number; minKept?: number };
}

export interface BackupResult {
  dump: DumpResult;
  pruned: PruneResult;
}

// A run that failed its checks. Its objects stay as evidence, without the marker, so it is
// never the newest dump and the health age keeps growing until a good run lands.
export class BackupIncomplete extends Error {
  constructor(
    readonly dump: DumpResult,
    readonly problems: string[]
  ) {
    super(`dump ${dump.run_id} was left incomplete: ${problems.join("; ")}`);
    this.name = "BackupIncomplete";
  }
}

// The checks every site makes: something was dumped, no excluded table is in it, and every
// required table is. One message per failed check; empty means the dump may be marked complete.
export function standardProblems(dump: DumpResult, options: { exclude?: string[]; required?: string[] } = {}): string[] {
  const problems: string[] = [];
  const names = new Set(dump.tables.map((t) => t.name));
  const rows = dump.tables.reduce((sum, t) => sum + t.rows, 0);
  if (dump.tables.length === 0 || rows === 0) problems.push(`the dump holds ${dump.tables.length} tables and ${rows} rows`);
  for (const name of options.exclude ?? []) if (names.has(name)) problems.push(`${name} is in the dump but must be excluded`);
  for (const name of options.required ?? []) if (!names.has(name)) problems.push(`${name} is missing from the dump`);
  return problems;
}

// The nightly backup: dump without the marker, run the standard and the site's checks, then
// write the marker and prune. Prune runs only after a marker, so a failing night deletes nothing.
export async function runCheckedBackup(db: D1Like, bucket: R2Like, options: BackupOptions = {}): Promise<BackupResult> {
  const { required, check, retention, ...dumpOptions } = options;
  const dump = await dumpDatabase(db, bucket, { ...dumpOptions, markComplete: false });
  const problems = [...standardProblems(dump, { exclude: dumpOptions.exclude, required }), ...((await check?.(dump)) ?? [])];
  if (problems.length > 0) throw new BackupIncomplete(dump, problems);
  await writeCompleteMarker(bucket, dump);
  const pruned = await pruneDumps(bucket, { prefix: dumpOptions.prefix, now: dumpOptions.now, ...retention });
  return { dump, pruned };
}
