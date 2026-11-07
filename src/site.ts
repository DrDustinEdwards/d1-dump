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

// The dump's BackupHealth, and when the site has files passes, each pass's under `files` by its name.
export type SiteBackupStatus = BackupHealth & { files?: Record<string, BackupHealth> };

export interface SiteBackup<Env> {
  // The checked dump: dump, check, mark complete, prune. Throws BackupIncomplete on a failed check.
  // `now` is the run's clock, for a site whose cron hands it one.
  runBackup(env: Env, now?: Date): Promise<BackupResult>;
  // One files pass for each named backup (all of them when none is named), in the order given,
  // each going on where its last run stopped. Naming one the config lacks throws.
  runFilesBackup(env: Env, names?: string[], now?: Date): Promise<{ files: FilesPassSummary[] }>;
  // The dump's health with every files pass's under `files` by name, and one `warning` joining
  // each stale part's ("; "; a pass's is prefixed "<name> files: "). Never throws.
  status(env: Env, now?: Date): Promise<SiteBackupStatus>;
}

const DEFAULT_ENV = (env: unknown, field: string) => (env as Record<string, unknown>)[field];

export function createSiteBackup<Env>(config: SiteBackupConfig<Env>): SiteBackup<Env> {
  const db = config.db ?? ((env: Env) => DEFAULT_ENV(env, "DB") as D1Like);
  const bucket =
    config.bucket ?? ((env: Env) => DEFAULT_ENV(env, "BACKUPS") as R2Like & R2FilesLike);
  const passes = config.files ?? [];
  const names = new Set<string>();
  for (const pass of passes) {
    if (names.has(pass.name)) throw new Error(`d1-dump: two files backups are named ${pass.name}`);
    names.add(pass.name);
  }

  return {
    runBackup: (env, now) =>
      runCheckedBackup(db(env), bucket(env), now ? { ...config.dump, now } : config.dump),
    async runFilesBackup(env, only, now) {
      const chosen = only
        ? only.map((name) => {
            const pass = passes.find((p) => p.name === name);
            if (!pass) throw new Error(`d1-dump: no files backup named ${name}`);
            return pass;
          })
        : passes;
      const files: FilesPassSummary[] = [];
      for (const { source, ...options } of chosen) {
        const run = await backupFiles(
          source(env),
          bucket(env),
          now ? { ...options, now } : options,
        );
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
      const warnings = [
        dump.warning,
        ...passes.map(
          (pass, i) => healths[i]?.warning && `${pass.name} files: ${healths[i].warning}`,
        ),
      ].filter(Boolean);
      return {
        ...dump,
        ...(passes.length > 0
          ? {
              files: Object.fromEntries(
                passes.map((pass, i) => [pass.name, healths[i] as BackupHealth]),
              ),
            }
          : {}),
        ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
      };
    },
  };
}
