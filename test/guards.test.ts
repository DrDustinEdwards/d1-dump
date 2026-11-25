import { afterEach, beforeEach, expect, test } from "vitest";
import { cloudflareBucket, cloudflareScratch } from "../src/cloudflare.js";
import {
  COMPLETE_MARKER,
  dumpDatabase,
  readDumpJson,
  restoreDump,
  type CompleteMarker,
  type D1Like,
  type R2Like,
} from "../src/index.js";
import { gzipText } from "../src/gzip.js";
import { SITE_ROWS, SITE_SCHEMA, exec, sandbox } from "./helpers.js";

let src: D1Like;
let dst: D1Like;
let bucket: R2Like;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ src, dst, bucket, dispose } = await sandbox());
  await exec(src, [...SITE_SCHEMA, ...SITE_ROWS]);
});
afterEach(async () => dispose());

// The run's marker without its checksums, as a run written before 0.16.0 had it.
async function dropChecksums(prefix: string): Promise<void> {
  const key = `${prefix}${COMPLETE_MARKER}`;
  const marker = JSON.parse((await (await bucket.get(key))!.text()) as string) as CompleteMarker;
  delete marker.checksums;
  await bucket.put(key, JSON.stringify(marker));
}

test("a marker without checksums is refused unless the caller allows an unchecked run", async () => {
  const run = await dumpDatabase(src, bucket);
  await dropChecksums(run.prefix);
  await expect(restoreDump(dst, bucket, run.prefix)).rejects.toThrow(/no checksums/);
  expect(
    (await restoreDump(dst, bucket, run.prefix, { allowUnchecked: true })).tables.length,
  ).toBeGreaterThan(0);
});

test("a schema entry that is not the CREATE its type names is refused, and so is a target that is not empty", async () => {
  const run = await dumpDatabase(src, bucket);
  await dropChecksums(run.prefix);
  const key = `${run.prefix}_schema.json`;
  const sidecar = JSON.parse((await (await bucket.get(key))!.text()) as string);
  sidecar.schema.push({
    type: "table",
    name: "x",
    tbl_name: "x",
    sql: "ATTACH DATABASE ':memory:' AS x",
  });
  await bucket.put(key, JSON.stringify(sidecar));
  await expect(restoreDump(dst, bucket, run.prefix, { allowUnchecked: true })).rejects.toThrow(
    /not a CREATE TABLE/,
  );
  // The first CREATEs ran before the bad entry, so the target is no longer empty: discard it.
  await expect(restoreDump(dst, bucket, run.prefix, { allowUnchecked: true })).rejects.toThrow(
    /not empty/,
  );
});

test("a gzip object that expands past the cap is refused", async () => {
  await bucket.put("big.json.gz", await gzipText(`{"rows":["${"0".repeat(70 * 1024 * 1024)}"]}`));
  await expect(readDumpJson(bucket, "big.json.gz", (k) => k)).rejects.toThrow(/expands past/);
});

test("the REST clients refuse a dot segment and encode the account id", async () => {
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    return Response.json({ success: true, result: { uuid: "u" } });
  }) as unknown as typeof fetch;
  const rest = cloudflareBucket("acct", "tok", "b", fake);
  await expect(rest.get("files/../../../buckets/OTHER/objects/secret")).rejects.toThrow(
    /dot segment/,
  );
  expect(urls).toEqual([]);
  await cloudflareScratch("a/../b", "tok", fake)("restore-drill-x");
  expect(urls[0]).toContain("/accounts/a%2F..%2Fb/d1/database");
});
