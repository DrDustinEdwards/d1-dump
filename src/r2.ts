import type { R2Like, R2UploadedPartLike } from "./types.js";

// R2 requires every part except the last to be the same size, and at least 5 MiB.
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
// R2's bulk delete refuses more than 1000 keys in one call rather than truncating.
const R2_DELETE_MAX = 1000;

export const JSON_TYPE = { httpMetadata: { contentType: "application/json" } };

// BLOB columns do not survive JSON as they arrive, so they are written as
// {"$blob": "<base64>"} and decoded on restore. A text column never reads back as an
// array or a buffer, so either one here is a BLOB.
// btoa and atob rather than Buffer, which a Worker has only with nodejs_compat.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function encodeValue(_key: string, value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { $blob: toBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) return { $blob: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  if (Array.isArray(value) && value.every((n) => typeof n === "number")) return { $blob: toBase64(Uint8Array.from(value)) };
  return value;
}

export function decodeValue(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { $blob?: unknown }).$blob === "string") {
    return Uint8Array.from(atob((value as { $blob: string }).$blob), (c) => c.charCodeAt(0));
  }
  return value;
}

// Writes `head`, then the rows a page at a time, then "]}", as one multipart object.
// The bytes equal JSON.stringify of the whole object, holding at most one part and one
// page in memory.
export async function putJsonStreamed(bucket: R2Like, key: string, head: string, pages: AsyncIterable<unknown[]>): Promise<number> {
  const upload = await bucket.createMultipartUpload(key, JSON_TYPE);
  const parts: R2UploadedPartLike[] = [];
  const encoder = new TextEncoder();
  let part = new Uint8Array(MULTIPART_PART_BYTES);
  let filled = 0;
  let rows = 0;
  const flush = async () => {
    parts.push(await upload.uploadPart(parts.length + 1, part.slice(0, filled)));
    part = new Uint8Array(MULTIPART_PART_BYTES);
    filled = 0;
  };
  const write = async (text: string) => {
    let bytes = encoder.encode(text);
    while (bytes.length > 0) {
      const n = Math.min(bytes.length, MULTIPART_PART_BYTES - filled);
      part.set(bytes.subarray(0, n), filled);
      filled += n;
      bytes = bytes.subarray(n);
      if (filled === MULTIPART_PART_BYTES) await flush();
    }
  };
  try {
    await write(head);
    for await (const page of pages) {
      for (const row of page) {
        await write((rows === 0 ? "" : ",") + JSON.stringify(row, encodeValue));
        rows++;
      }
    }
    await write("]}");
    if (filled > 0 || parts.length === 0) await flush();
    await upload.complete(parts);
    return rows;
  } catch (err) {
    // The abort's own failure is reported with the cause, never in place of it.
    await upload.abort().catch((abortErr: unknown) => {
      throw new AggregateError([err, abortErr], `d1-dump: writing ${key} failed, and so did aborting its upload`);
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
  for (let i = 0; i < keys.length; i += R2_DELETE_MAX) await bucket.delete(keys.slice(i, i + R2_DELETE_MAX));
  return keys.length;
}
