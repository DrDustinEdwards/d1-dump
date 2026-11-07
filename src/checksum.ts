// A dump object's checksum, recorded in the run's marker and checked whenever the object is read back.
//
// SHA-256 of the stored bytes (the gzip, for a compressed table). An object of one chunk is plain SHA-256, the
// value `sha256sum` prints, written "sha256:<hex>". A larger one is hashed the way S3 hashes a multipart
// upload: SHA-256 of each 8 MiB chunk, then SHA-256 of those digests joined, written "sha256-<chunks>:<hex>".
// The chunks are the multipart upload's parts, so a streamed table is hashed as it is written, one part in
// memory at a time (WebCrypto has no incremental digest).
export const CHUNK_BYTES = 8 * 1024 * 1024;

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The checksum of an object whose chunks hash to `digests`, in order (one empty chunk for an empty object). */
export async function combineDigests(digests: Uint8Array[]): Promise<string> {
  if (digests.length <= 1) return `sha256:${hex(digests[0] ?? (await digest(new Uint8Array(0))))}`;
  const joined = new Uint8Array(digests.length * 32);
  digests.forEach((d, i) => joined.set(d, i * 32));
  return `sha256-${digests.length}:${hex(await digest(joined))}`;
}

/** SHA-256 of one chunk (at most CHUNK_BYTES), for combineDigests. */
export const chunkDigest = digest;

export async function checksumOf(bytes: Uint8Array): Promise<string> {
  const digests: Uint8Array[] = [];
  for (let at = 0; at === 0 || at < bytes.length; at += CHUNK_BYTES)
    digests.push(await digest(bytes.subarray(at, at + CHUNK_BYTES)));
  return combineDigests(digests);
}

/** Throws, naming the key, unless `bytes` hash to `expected`. */
export async function verifyChecksum(
  key: string,
  bytes: Uint8Array,
  expected: string | undefined,
): Promise<void> {
  if (expected === undefined) throw new Error(`d1-dump: the marker records no checksum for ${key}`);
  const actual = await checksumOf(bytes);
  if (actual !== expected)
    throw new Error(
      `d1-dump: ${key} does not match its checksum (read ${actual}, marker has ${expected})`,
    );
}
