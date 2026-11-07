import { runCheckedBackup, type BackupOptions, type BackupResult } from "./backup.js";
import { backupFiles, filesHealth, type FilesCounts, type FilesOptions } from "./files.js";
import { backupHealth, type BackupHealth } from "./runs.js";
import type { D1Like, R2FilesLike, R2Like } from "./types.js";

// What a site's backup module repeated: the nightly dump, a files pass per bucket, and the
// status /health and the operator API read. The site says WHAT (its tables, its buckets); this
// holds the wiring, so the same call backs up and reports every site.

export interface SiteFilesBackup<Env> extends FilesOptions {
  // The bucket to copy, read from the Worker's env.
  source: (env: Env) => R2FilesLike;
  // The name this pass has in the status. The first pass is `files` and the others take their
  // `name` unless this says otherwise, so a site's /health keeps the keys it already reports.
  key?: string;
  // Prefixes this pass's warning in the combined one ("journal files: ...") when it is not the
  // only pass.
  label?: string;
}

export interface SiteBackupConfig<Env> {
  // The site's own D1 and the backups bucket. The defaults are env.DB and env.BACKUPS.
  db?: (env: Env) => D1Like;
  bucket?: (env: Env) => R2Like & R2FilesLike;
  // runCheckedBackup's options: exclude, required, counted, credentials, check and the rest.
  dump: BackupOptions;
  files?: Array<SiteFilesBackup<Env>>;
}

export interface FilesPassSummary extends FilesCounts {
  name: string;
  complete: boolean;
}

// BackupHealth for the dump, and one more BackupHealth under each files pass's key.
export type SiteBackupStatus = BackupHealth & Record<string, unknown>;

export interface SiteBackup<Env> {
  // The checked dump: dump, check, mark complete, prune. Throws BackupIncomplete on a failed check.
  runBackup(env: Env): Promise<BackupResult>;
  // One files pass for each named backup (all of them when none is named), in the order given,
  // each going on where its last run stopped. Naming one the config lacks throws.
  runFilesBackup(env: Env, names?: string[]): Promise<{ files: FilesPassSummary[] }>;
  // The dump's health with every files pass's under its key, and one `warning` that is the
  // first of them. Never throws.
  status(env: Env, now?: Date): Promise<SiteBackupStatus>;
}

const DEFAULT_ENV = (env: unknown, field: string) => (env as Record<string, unknown>)[field];

export function createSiteBackup<Env>(config: SiteBackupConfig<Env>): SiteBackup<Env> {
  const db = config.db ?? ((env: Env) => DEFAULT_ENV(env, "DB") as D1Like);
  const bucket =
    config.bucket ?? ((env: Env) => DEFAULT_ENV(env, "BACKUPS") as R2Like & R2FilesLike);
  const passes = config.files ?? [];
  const keyOf = (pass: SiteFilesBackup<Env>, index: number) =>
    pass.key ?? (index === 0 ? "files" : pass.name);
  const names = new Set<string>();
  for (const pass of passes) {
    if (names.has(pass.name)) throw new Error(`d1-dump: two files backups are named ${pass.name}`);
    names.add(pass.name);
  }
  const keys = passes.map(keyOf);
  if (new Set(keys).size !== keys.length)
    throw new Error(`d1-dump: two files backups report as ${keys.join(", ")}`);

  return {
    runBackup: (env) => runCheckedBackup(db(env), bucket(env), config.dump),
    async runFilesBackup(env, only) {
      const chosen = only
        ? only.map((name) => {
            const pass = passes.find((p) => p.name === name);
            if (!pass) throw new Error(`d1-dump: no files backup named ${name}`);
            return pass;
          })
        : passes;
      const files: FilesPassSummary[] = [];
      for (const { source, key: _key, label: _label, ...options } of chosen) {
        const run = await backupFiles(source(env), bucket(env), options);
        files.push({ name: run.name, complete: run.complete, ...run.counts });
      }
      return { files };
    },
    async status(env, now) {
      const target = bucket(env);
      const [dump, ...healths] = await Promise.all([
        backupHealth(target, { now, prefix: config.dump.prefix }),
        ...passes.map((p) => filesHealth(target, { name: p.name, now })),
      ]);
      let warning = dump.warning;
      passes.forEach((pass, i) => {
        const w = healths[i]?.warning;
        if (!warning && w) warning = passes.length > 1 && pass.label ? `${pass.label}: ${w}` : w;
      });
      const out: SiteBackupStatus = { ...dump };
      passes.forEach((_, i) => {
        out[keys[i] as string] = healths[i];
      });
      if (warning) out.warning = warning;
      return out;
    },
  };
}
