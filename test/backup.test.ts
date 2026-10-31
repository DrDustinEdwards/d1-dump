import { afterEach, beforeEach, expect, test } from "vitest";
import {
  BackupIncomplete,
  COMPLETE_MARKER,
  backupFiles,
  filesHealth,
  latestDump,
  restoreFiles,
  runCheckedBackup,
  runIdFor,
  type D1Like,
  type R2FilesLike,
  type R2Like,
} from "../src/index.js";
import { SITE_ROWS, SITE_SCHEMA, exec, sandbox } from "./helpers.js";

let src: D1Like;
let bucket: R2Like;
let media: R2FilesLike;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ src, bucket, media, dispose } = await sandbox());
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

test("a counted table must match its live count, and all counted tables empty is refused", async () => {
  // A row written between the dump and the count, as a lost row would look.
  let counting = false;
  const racing: D1Like = {
    prepare: (sql) => ((counting ||= sql.startsWith("SELECT COUNT(*) AS n FROM")), src.prepare(sql)),
    batch: async (statements) => {
      if (counting) await exec(src, ["INSERT INTO comments (id, post_id, text) VALUES (4, 2, 'late')"]);
      return src.batch(statements);
    },
  };
  const err = (await runCheckedBackup(racing, bucket, { now: NOW, counted: ["posts", "comments"] }).catch((e: unknown) => e)) as BackupIncomplete;
  expect(err.problems).toEqual(["comments dumped 3 rows but has 4"]);
  expect(await hasMarker(runIdFor(NOW))).toBe(false);

  await exec(src, ["DELETE FROM comments", "DELETE FROM posts"]);
  const empty = (await runCheckedBackup(src, bucket, { now: NOW, counted: ["posts", "comments"] }).catch((e: unknown) => e)) as BackupIncomplete;
  expect(empty.problems).toEqual(["every counted table dumped empty"]);
  expect((await runCheckedBackup(src, bucket, { now: NOW, counted: ["settings"] })).dump.run_id).toBe(runIdFor(NOW));
});

test("files are copied once, re-copied when changed, and a deleted one is kept for its window, then removed", async () => {
  const backup = bucket as unknown as R2FilesLike;
  // Miniflare's proxy from Node back into workerd drops a stream's length, which a Worker's
  // own R2 body keeps and put requires, so here the copy is handed the bytes.
  const source: R2FilesLike = {
    list: (o) => media.list(o),
    put: (k, v, o) => media.put(k, v, o),
    delete: (k) => media.delete(k),
    get: async (k) => {
      const o = await media.get(k);
      if (!o) return null;
      const bytes = await new Response(o.body as ReadableStream).arrayBuffer();
      return { key: o.key, etag: o.etag, size: o.size, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, body: bytes, text: async () => "" };
    },
  };
  const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
  const photo = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
  await media.put("a.txt", "first", { httpMetadata: { contentType: "text/plain" }, customMetadata: { alt: "a note" } });
  await media.put("img/photo.jpg", photo, { httpMetadata: { contentType: "image/jpeg" } });

  // A run that reaches its budget saves where it was, and the next carries the pass on.
  const first = await backupFiles(source, backup, { name: "media", now: day(0), maxObjects: 1 });
  expect([first.complete, first.counts.copied]).toEqual([false, 1]);
  expect(await filesHealth(backup, { name: "media", now: day(0) })).toMatchObject({ last_ok: null });
  const rest = await backupFiles(source, backup, { name: "media", now: day(0) });
  expect([rest.complete, rest.counts.copied]).toEqual([true, 2]);
  const copy = await backup.get("files/media/a.txt");
  expect([await copy?.text(), copy?.httpMetadata?.contentType, copy?.customMetadata?.alt]).toEqual(["first", "text/plain", "a note"]);
  expect(new Uint8Array(await new Response((await backup.get("files/media/img/photo.jpg"))?.body as ReadableStream).arrayBuffer())).toEqual(photo);

  expect((await backupFiles(source, backup, { name: "media", now: day(1) })).counts).toMatchObject({ objects: 2, copied: 0, skipped: 2 });

  await media.put("a.txt", "second");
  await media.delete("img/photo.jpg");
  expect((await backupFiles(source, backup, { name: "media", now: day(2) })).counts).toMatchObject({ copied: 1, skipped: 0, kept_deleted: 1 });
  expect(await (await backup.get("files/media/a.txt"))?.text()).toBe("second");

  // A bucket lock refuses the removal: counted, kept, and tried again by the next pass.
  const lock: R2FilesLike = {
    list: (o) => backup.list(o),
    get: (k) => backup.get(k),
    put: (k, v, o) => backup.put(k, v, o),
    delete: async () => {
      throw new Error("delete: Object is locked by bucket policy (10069)");
    },
  };
  expect((await backupFiles(source, lock, { name: "media", now: day(32) })).counts).toMatchObject({ removed: 0, locked: 1 });
  expect((await backupFiles(source, backup, { name: "media", now: day(33) })).counts).toMatchObject({ objects: 1, removed: 1, locked: 0 });
  expect(await backup.get("files/media/img/photo.jpg")).toBeNull();
  expect(await filesHealth(backup, { name: "media", now: day(34) })).toEqual({ last_ok: day(33).toISOString(), age_hours: 24 });
});

// Miniflare's proxy drops a stream's length, which put needs, so a get here hands over the bytes.
function bytesOut(r2: R2FilesLike): R2FilesLike {
  return {
    list: (o) => r2.list(o),
    put: (k, v, o) => r2.put(k, v, o),
    delete: (k) => r2.delete(k),
    get: async (k) => {
      const o = await r2.get(k);
      if (!o) return null;
      const bytes = await new Response(o.body as ReadableStream).arrayBuffer();
      return { key: o.key, etag: o.etag, size: o.size, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, body: bytes, text: async () => "" };
    },
  };
}

test("restoreFiles is a dry run by default, puts back what is missing, and overwrites a changed file only when asked", async () => {
  const backup = bytesOut(bucket as unknown as R2FilesLike);
  await media.put("a.txt", "first", { httpMetadata: { contentType: "text/plain" }, customMetadata: { alt: "a note" } });
  await media.put("img/b.txt", "kept");
  await media.put("img/c.txt", "original");
  await backupFiles(bytesOut(media), backup, { name: "media", now: NOW });
  await media.delete("a.txt");
  await media.put("img/c.txt", "edited since");

  const dry = await restoreFiles(backup, media, { name: "media" });
  expect([dry.applied, dry.complete, dry.counts, dry.restore, dry.differ]).toEqual([
    false, true, { objects: 3, missing: 1, same: 1, differs: 1, written: 0 }, ["a.txt"], ["img/c.txt"],
  ]);
  expect(await media.get("a.txt")).toBeNull();

  expect((await restoreFiles(backup, media, { name: "media", apply: true })).counts.written).toBe(1);
  const back = await media.get("a.txt");
  expect([await back?.text(), back?.httpMetadata?.contentType, back?.customMetadata]).toEqual(["first", "text/plain", { alt: "a note" }]);
  expect(await (await media.get("img/c.txt"))?.text()).toBe("edited since");

  const only = await restoreFiles(backup, media, { name: "media", prefix: "img/", apply: true, overwrite: true });
  expect(only.counts).toEqual({ objects: 2, missing: 0, same: 1, differs: 1, written: 1 });
  expect(await (await media.get("img/c.txt"))?.text()).toBe("original");
});

test("excludeIfPresent excludes a table only while it exists, and credentials refuses a credential column unless allowed", async () => {
  await exec(src, ["CREATE TABLE preview_links (id INTEGER PRIMARY KEY, token_hash TEXT)", "INSERT INTO preview_links (token_hash) VALUES ('sample')"]);
  const kept = await runCheckedBackup(src, bucket, { now: NOW, excludeIfPresent: ["preview_links", "session"], credentials: true });
  expect(kept.dump.excluded).toEqual(["preview_links"]);
  const err = (await runCheckedBackup(src, bucket, { now: new Date("2026-10-21T03:17:00.000Z"), credentials: true }).catch((e: unknown) => e)) as BackupIncomplete;
  expect(err).toBeInstanceOf(BackupIncomplete);
  expect(err.problems).toEqual([expect.stringMatching(/^preview_links has credential-looking column\(s\) token_hash/)]);
  const allowed = await runCheckedBackup(src, bucket, {
    now: new Date("2026-10-22T03:17:00.000Z"),
    credentials: { allow: { "preview_links.token_hash": "a sample reason" } },
  });
  expect(allowed.dump.complete).toBe(true);
});
