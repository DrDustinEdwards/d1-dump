import type { R2Like } from "./types.js";

export const GZIP_TYPE = { httpMetadata: { contentType: "application/gzip" } };

// gzip and gunzip through the platform's streams, which a Worker and Node both have.
export async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// Reads one object of a dump as JSON. A key ending in .gz holds gzip bytes, so a run written with
// `compress` and a run written before it are restored by the same code.
export async function readDumpJson<T>(bucket: R2Like, key: string, missing: (key: string) => string): Promise<T> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(missing(key));
  if (!key.endsWith(".gz")) return JSON.parse(await obj.text()) as T;
  if (!obj.arrayBuffer) throw new Error(`d1-dump: ${key} is gzip, and this bucket cannot read an object's bytes`);
  return JSON.parse(await gunzipText(await obj.arrayBuffer())) as T;
}
