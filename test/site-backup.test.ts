import { afterEach, beforeEach, expect, test } from "vitest";
import { siteBackup, type D1Like, type R2FilesLike, type R2Like } from "../src/index.js";
import { SITE_ROWS, SITE_SCHEMA, exec, sandbox } from "./helpers.js";

let env: { db: D1Like; backups: R2Like & R2FilesLike; media: R2FilesLike };
let dispose: () => Promise<void>;

beforeEach(async () => {
  const sb = await sandbox();
  dispose = sb.dispose;
  await exec(sb.src, [...SITE_SCHEMA, ...SITE_ROWS]);
  env = { db: sb.src, backups: sb.bucket as R2Like & R2FilesLike, media: sb.media };
});
afterEach(async () => dispose());

test("the jobs run the dump and the files pass, and status reads both", async () => {
  const backup = siteBackup<typeof env>({
    db: (e) => e.db,
    bucket: (e) => e.backups,
    dump: { exclude: ["settings"], required: ["posts"] },
    files: [{ name: "media", source: (e) => e.media }],
  });

  const jobs = backup.jobs(env);
  expect(jobs.map((j) => j.name)).toEqual(["backup", "media-backup"]);
  expect(jobs.every((j) => j.backup && j.everyMinutes === 1440)).toBe(true);
  for (const job of jobs) await job.run();

  const status = await backup.status(env);
  expect(status.warning).toBeUndefined();
  expect(status.last_ok).not.toBeNull();
  expect(status.files).toMatchObject({ last_ok: expect.any(String) });
});

test("status warns before the first run, and keys several passes by name", async () => {
  const backup = siteBackup<typeof env>({
    db: (e) => e.db,
    bucket: (e) => e.backups,
    dump: {},
    files: [
      { name: "audio", source: (e) => e.media },
      { name: "images", source: (e) => e.media },
    ],
  });
  const status = await backup.status(env);
  expect(Object.keys(status.files ?? {})).toEqual(["audio", "images"]);
  expect(status.warning).toBeTruthy();
});
