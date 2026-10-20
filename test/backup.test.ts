import { afterEach, beforeEach, expect, test } from "vitest";
import { BackupIncomplete, COMPLETE_MARKER, latestDump, runCheckedBackup, runIdFor, type D1Like, type R2Like } from "../src/index.js";
import { SITE_ROWS, SITE_SCHEMA, exec, sandbox } from "./helpers.js";

let src: D1Like;
let bucket: R2Like;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ src, bucket, dispose } = await sandbox());
  await exec(src, [...SITE_SCHEMA, ...SITE_ROWS]);
});
afterEach(async () => dispose());

const NOW = new Date("2026-10-20T03:17:00.000Z");

async function hasMarker(runId: string): Promise<boolean> {
  return (await bucket.get(`backups/json/${runId}/${COMPLETE_MARKER}`)) !== null;
}

test("a dump that passes every check is marked complete and pruned", async () => {
  const { dump, pruned } = await runCheckedBackup(src, bucket, { now: NOW, exclude: ["settings"], required: ["posts", "comments"] });
  expect(await hasMarker(dump.run_id)).toBe(true);
  expect((await latestDump(bucket))?.run_id).toBe(dump.run_id);
  expect(pruned).toEqual({ kept: 1, pruned: 0, locked: 0 });
});

test("a missing required table leaves the run without its marker and throws", async () => {
  const err = await runCheckedBackup(src, bucket, { now: NOW, required: ["posts", "journal"] }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BackupIncomplete);
  expect((err as BackupIncomplete).problems).toEqual(["journal is missing from the dump"]);
  expect(await hasMarker(runIdFor(NOW))).toBe(false);
  expect(await latestDump(bucket)).toBeNull();
});

test("an emptied database is refused, though it dumps cleanly", async () => {
  await exec(src, ["DELETE FROM comments", "DELETE FROM posts", "DELETE FROM glossary", "DELETE FROM settings"]);
  const err = (await runCheckedBackup(src, bucket, { now: NOW }).catch((e: unknown) => e)) as BackupIncomplete;
  expect(err.problems).toEqual([expect.stringMatching(/ and 0 rows$/)]);
});

test("the site's own check runs after the standard ones and can refuse the run", async () => {
  const seen: string[] = [];
  const err = (await runCheckedBackup(src, bucket, {
    now: NOW,
    check: (dump) => {
      seen.push(dump.run_id);
      return dump.tables.find((t) => t.name === "posts")?.rows === 2 ? ["posts dumped 2 rows but has 3"] : [];
    },
  }).catch((e: unknown) => e)) as BackupIncomplete;
  expect(seen).toEqual([runIdFor(NOW)]);
  expect(err.problems).toEqual(["posts dumped 2 rows but has 3"]);
  expect(await hasMarker(runIdFor(NOW))).toBe(false);
});

test("a failing night prunes nothing, so older complete runs survive it", async () => {
  const old = await runCheckedBackup(src, bucket, { now: new Date("2026-09-01T03:17:00.000Z") });
  await runCheckedBackup(src, bucket, { now: NOW, required: ["nope"] }).catch(() => undefined);
  expect(await hasMarker(old.dump.run_id)).toBe(true);
  expect((await latestDump(bucket))?.run_id).toBe(old.dump.run_id);
});
