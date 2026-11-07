import { runCheckedBackup, type BackupOptions } from "./backup.js";
import { backupFiles, filesHealth } from "./files.js";
import { backupHealth, type BackupHealth } from "./runs.js";
import type { D1Like, R2FilesLike, R2Like } from "./types.js";

// A site's whole backup, declared once: the D1 dump, the files passes beside it, the scheduled jobs that run them and the
// health reading of both. Nine sites each wrote the same four functions around runCheckedBackup, backupFiles,
// backupHealth and filesHealth, and the same job list around them.

const MINUTE = 60_000;
const DAY_MINUTES = 1440;

export interface SiteBackupFiles<E> {
  // The pass's name: its copies go under files/<name>/, and its job is "<name>-backup".
  name: string;
  source: (env: E) => R2FilesLike;
  // Only source keys that start with this (backupFiles' prefix).
  prefix?: string;
  // The pass stops itself here and goes on the next night. Default three minutes.
  timeBudgetMs?: number;
  // The job's own limit. Default four minutes: a minute over the pass's budget.
  timeoutMs?: number;
}

export interface SiteBackupSpec<E> {
  db: (env: E) => D1Like;
  // Where the dumps and the files copies go.
  bucket: (env: E) => R2Like & R2FilesLike;
  dump: BackupOptions;
  // The dump job's limit. Default five minutes.
  dumpTimeoutMs?: number;
  files?: SiteBackupFiles<E>[];
}

// A scheduled job in site-runtime's ./cron shape, kept structural so this package depends on nothing.
export interface BackupJob {
  name: string;
  everyMinutes: number;
  timeoutMs: number;
  backup: true;
  run: () => Promise<unknown>;
}

export interface SiteBackupStatus {
  last_ok: BackupHealth["last_ok"];
  age_hours: BackupHealth["age_hours"];
  // One reading for a site with one files pass, the readings by pass name for several, absent for none.
  files?: BackupHealth | Record<string, BackupHealth>;
  warning?: string;
}

export function siteBackup<E>(spec: SiteBackupSpec<E>) {
  const files = spec.files ?? [];
  const budget = (pass: SiteBackupFiles<E>) => ({
    name: pass.name,
    prefix: pass.prefix,
    timeBudgetMs: pass.timeBudgetMs ?? 3 * MINUTE,
  });

  async function runDump(env: E) {
    return runCheckedBackup(spec.db(env), spec.bucket(env), spec.dump);
  }

  async function runFiles(env: E, name: string) {
    const pass = files.find((f) => f.name === name);
    if (!pass) throw new Error(`no files pass named '${name}'`);
    const run = await backupFiles(pass.source(env), spec.bucket(env), budget(pass));
    return { name: run.name, complete: run.complete, ...run.counts };
  }

  // The jobs, for the site's cron list and the operator's run_job: the dump, then each pass.
  function jobs(env: E): BackupJob[] {
    return [
      {
        name: "backup",
        everyMinutes: DAY_MINUTES,
        timeoutMs: spec.dumpTimeoutMs ?? 5 * MINUTE,
        backup: true,
        run: async () => {
          const { dump, pruned } = await runDump(env);
          return { run_id: dump.run_id, ...pruned };
        },
      },
      ...files.map((pass) => ({
        name: `${pass.name}-backup`,
        everyMinutes: DAY_MINUTES,
        timeoutMs: pass.timeoutMs ?? 4 * MINUTE,
        backup: true as const,
        run: () => runFiles(env, pass.name),
      })),
    ];
  }

  // The newest complete dump and each files pass, for /health and the operator API. Never throws.
  async function status(env: E): Promise<SiteBackupStatus> {
    const bucket = spec.bucket(env);
    const [dump, ...passes] = await Promise.all([
      backupHealth(bucket),
      ...files.map((pass) => filesHealth(bucket, { name: pass.name })),
    ]);
    const warnings = [dump.warning, ...passes.map((p) => p.warning)].filter((w): w is string =>
      Boolean(w),
    );
    return {
      ...dump,
      ...(files.length === 1
        ? { files: passes[0] }
        : files.length > 1
          ? { files: Object.fromEntries(files.map((f, i) => [f.name, passes[i]])) }
          : {}),
      ...(warnings.length ? { warning: warnings.join("; ") } : {}),
    };
  }

  return { runDump, runFiles, jobs, status };
}
