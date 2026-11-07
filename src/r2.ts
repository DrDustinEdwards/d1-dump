import { CHUNK_BYTES, checksumOf, chunkDigest, combineDigests } from "./checksum.js";
import { GZIP_TYPE } from "./gzip.js";
import type { R2Like, R2UploadedPartLike } from "./types.js";

// R2 requires every part except the last to be the same size, and at least 5 MiB. The checksum's chunks are these parts.
const MULTIPART_PART_BYTES = CHUNK_BYTES;
// R2's bulk delete refuses more than 1000 keys in one call rather than truncating.
const R2_DELETE_MAX = 1000;

export const JSON_TYPE = { httpMetadata: { contentType: "application/json" } };

/**
 * Writes one object and returns its checksum. An object of one chunk is also sent with its SHA-256, which R2
 * checks against what it received (developers.cloudflare.com/r2/api/workers/workers-api-reference/, put options).
 */
export async function putChecked(
  bucket: R2Like,
  key: string,
  value: string | Uint8Array,
  options: { httpMetadata?: { contentType?: string } },
): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const checksum = await checksumOf(bytes);
  const whole = checksum.startsWith("sha256:") ? checksum.slice("sha256:".length) : undefined;
  await bucket.put(key, bytes, { ...options, ...(whole ? { sha256: whole } : {}) });
  return checksum;
}

// Writes `head`, then the rows a page at a time, then "]}", as one multipart object.
// The bytes equal JSON.stringify of the whole object, holding at most one part and one
// page in memory. With `gzip` the same bytes are compressed as they stream, and the object
// holds the gzip of them.
export async function putJsonStreamed(
  bucket: R2Like,
  key: string,
  head: string,
  pages: AsyncIterable<unknown[]>,
  gzip = false,
): Promise<{ rows: number; checksum: string }> {
  const upload = await bucket.createMultipartUpload(key, gzip ? GZIP_TYPE : JSON_TYPE);
  const parts: R2UploadedPartLike[] = [];
  const encoder = new TextEncoder();
  let part = new Uint8Array(MULTIPART_PART_BYTES);
  let filled = 0;
  let rows = 0;
  const digests: Uint8Array[] = [];
  const flush = async () => {
    const bytes = part.slice(0, filled);
    digests.push(await chunkDigest(bytes));
    parts.push(await upload.uploadPart(parts.length + 1, bytes));
    part = new Uint8Array(MULTIPART_PART_BYTES);
    filled = 0;
  };
  const append = async (input: Uint8Array) => {
    let bytes = input;
    while (bytes.length > 0) {
      const n = Math.min(bytes.length, MULTIPART_PART_BYTES - filled);
      part.set(bytes.subarray(0, n), filled);
      filled += n;
      bytes = bytes.subarray(n);
      if (filled === MULTIPART_PART_BYTES) await flush();
    }
  };
  // Text goes to the parts as UTF-8, or through a gzip stream whose output is read as it appears.
  const gz = gzip ? new CompressionStream("gzip") : null;
  const gzWriter = gz?.writable.getWriter();
  const pump = gz
    ? (async () => {
        const reader = gz.readable.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          await append(value);
        }
      })()
    : null;
  pump?.catch(() => {});
  const write = async (text: string) => {
    const bytes = encoder.encode(text);
    if (gzWriter) await gzWriter.write(bytes);
    else await append(bytes);
  };
  try {
    await write(head);
    for await (const page of pages) {
      for (const row of page) {
        await write((rows === 0 ? "" : ",") + JSON.stringify(row));
        rows++;
      }
    }
    await write("]}");
    if (gzWriter) {
      await gzWriter.close();
      await pump;
    }
    if (filled > 0 || parts.length === 0) await flush();
    await upload.complete(parts);
    return { rows, checksum: await combineDigests(digests) };
  } catch (err) {
    await gzWriter?.abort(err).catch(() => {});
    // The abort's own failure is reported with the cause, never in place of it.
    await upload.abort().catch((abortErr: unknown) => {
      throw new AggregateError(
        [err, abortErr],
        `d1-dump: writing ${key} failed, and so did aborting its upload`,
      );
    });
    throw err;
  }
}

export async function listAllKeys(bucket: R2Like, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function deleteInChunks(bucket: R2Like, keys: string[]): Promise<number> {
  for (let i = 0; i < keys.length; i += R2_DELETE_MAX)
    await bucket.delete(keys.slice(i, i + R2_DELETE_MAX));
  return keys.length;
}
