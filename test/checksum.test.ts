import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { CHUNK_BYTES, checksumOf } from "../src/checksum.js";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();

test("one chunk is plain SHA-256, more are S3's composite of the chunks' digests", async () => {
  const small = new TextEncoder().encode("rows");
  expect(await checksumOf(small)).toBe(`sha256:${sha(small).toString("hex")}`);
  expect(await checksumOf(new Uint8Array(0))).toBe(
    `sha256:${sha(new Uint8Array(0)).toString("hex")}`,
  );

  const big = new Uint8Array(CHUNK_BYTES + 5).fill(7);
  const joined = Buffer.concat([sha(big.subarray(0, CHUNK_BYTES)), sha(big.subarray(CHUNK_BYTES))]);
  expect(await checksumOf(big)).toBe(`sha256-2:${sha(joined).toString("hex")}`);
});
