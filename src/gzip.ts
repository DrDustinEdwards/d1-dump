import { verifyChecksum } from "./checksum.js";
import type { R2Like } from "./types.js";

export const GZIP_TYPE = { httpMetadata: { contentType: "application/gzip" } };

// gzip and gunzip through the platform's streams, which a Worker and Node both have.
export async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// Reads one object of a dump as JSON. A key ending in .gz holds gzip bytes, so a run written with
// `compress` and a run written before it are restored by the same code. With `checksums` (the marker's),
// the stored bytes must hash to the value the marker records for the key, or this throws; a marker
// written before checksums existed has none, and then nothing is checked.
export async function readDumpJson<T>(
  bucket: R2Like,
  key: string,
  missing: (key: string) => string,
  checksums?: Record<string, string>,
): Promise<T> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(missing(key));
  const gz = key.endsWith(".gz");
  if (!gz && !checksums) return JSON.parse(await obj.text()) as T;
  if (!obj.arrayBuffer) throw new Error(`d1-dump: ${key} cannot be read as bytes from this bucket`);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (checksums) await verifyChecksum(key, bytes, checksums[key]);
  return JSON.parse(gz ? await gunzipText(bytes) : new TextDecoder().decode(bytes)) as T;
}
