/**
 * The `.mxv` container - what actually sits in Google Drive.
 *
 * Layout:
 *   [ 128-byte header ][ chunk 0 ][ chunk 1 ] … [ chunk n ]
 *
 * Each chunk is `chunkSize` bytes of plaintext encrypted with AES-256-GCM,
 * stored as ciphertext + a 16-byte tag; the final chunk is short. Chunking is
 * not an optimisation, it is what makes preview possible: a video seek maps to
 * a couple of chunks instead of decrypting gigabytes, because chunk k always
 * lives at a computable offset. It also bounds memory - nothing ever holds
 * more than one chunk.
 *
 * The nonce is `filePrefix(8B) || chunkIndex(u32 BE)`, never random. That
 * binds each chunk to its position: reordering or splicing chunks from another
 * file fails the tag rather than silently decrypting to the wrong bytes. The
 * prefix is per-file and the key is per-file, so no (key, nonce) pair is ever
 * reused - the one thing GCM cannot survive.
 *
 * The header carries the wrapped file key, so a blob is self-describing: with
 * the master key alone, a `.mxv` recovered from Drive decrypts even if the
 * local database is gone.
 *
 * Header flag bit 0 marks a SEALED blob (vault mode): its file key is boxed to
 * the vault-mode public key (seal.cjs, 92 bytes) instead of wrapped under the
 * Secure vault's master key, so it can be written while locked.
 *
 * Pure Node - unit-testable without Electron.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const { wrapKey, unwrapKey, generateKey, fail } = require("./crypto.cjs");
const seal = require("./seal.cjs");

const MAGIC = Buffer.from("MXV1", "ascii");
const VERSION = 1;
const HEADER_SIZE = 128;
const DEFAULT_CHUNK = 4 * 1024 * 1024;
const TAG_BYTES = 16;
const PREFIX_BYTES = 8;
const WRAPPED_KEY_BYTES = 12 + 32 + 16; // iv || key || tag
const FLAG_SEALED = 1;


/** Ciphertext bytes a chunk occupies for a given plaintext length. */
const encryptedChunkSize = (plainBytes) => plainBytes + TAG_BYTES;

function chunkNonce(filePrefix, index) {
  const nonce = Buffer.alloc(12);
  Buffer.from(filePrefix).copy(nonce, 0, 0, PREFIX_BYTES);
  nonce.writeUInt32BE(index >>> 0, PREFIX_BYTES);
  return nonce;
}

function buildHeader({ chunkSize, plaintextSize, filePrefix, wrappedFileKey, sealed = false }) {
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 4);
  header.writeUInt8(sealed ? FLAG_SEALED : 0, 5);
  header.writeUInt32BE(chunkSize, 8);
  header.writeBigUInt64BE(BigInt(plaintextSize), 12);
  Buffer.from(filePrefix).copy(header, 20, 0, PREFIX_BYTES);
  const keyBytes = sealed ? seal.SEALED_KEY_BYTES : WRAPPED_KEY_BYTES;
  Buffer.from(wrappedFileKey).copy(header, 28, 0, keyBytes);
  return header;
}

function parseHeader(buf) {
  const header = Buffer.from(buf);
  if (header.length < HEADER_SIZE || !header.subarray(0, 4).equals(MAGIC))
    throw fail("This is not a MaxDrive secure file.", "VAULT_BAD_BLOB");
  const version = header.readUInt8(4);
  if (version !== VERSION)
    throw fail(
      `Secure file version ${version} is not supported.`,
      "VAULT_BAD_BLOB",
    );
  const sealed = (header.readUInt8(5) & FLAG_SEALED) === FLAG_SEALED;
  return {
    version,
    sealed,
    chunkSize: header.readUInt32BE(8),
    plaintextSize: Number(header.readBigUInt64BE(12)),
    filePrefix: header.subarray(20, 20 + PREFIX_BYTES),
    wrappedFileKey: header.subarray(28, 28 + (sealed ? seal.SEALED_KEY_BYTES : WRAPPED_KEY_BYTES)),
  };
}

/** The per-file key: unboxed with the vault-mode key, or unwrapped with the VMK. */
function fileKeyOf(header, { vmk, sealKey }) {
  if (header.sealed) {
    if (!sealKey) throw fail("Vault mode is locked.", "SEAL_LOCKED");
    return seal.openSealed(sealKey, header.wrappedFileKey);
  }
  return unwrapKey(vmk, header.wrappedFileKey);
}

const chunkCountFor = (plaintextSize, chunkSize) =>
  plaintextSize === 0 ? 0 : Math.ceil(plaintextSize / chunkSize);

/* ------------------------------------------------------------- encrypting */

/**
 * Encrypt `srcPath` into `destPath`. Returns everything the caller needs to
 * record the item and verify the upload: the wrapped key and prefix (also in
 * the header), the blob's md5 (Drive echoes md5Checksum, so we can prove the
 * upload arrived intact) and the plaintext's sha256 (so a later decrypt can
 * prove it produced the original bytes).
 *
 * Writes to `.part` and renames, the same atomic discipline downloader.cjs
 * uses - a crash never leaves a half-written blob looking complete.
 */
async function encryptFileToPath({
  srcPath,
  destPath,
  vmk,
  sealTo,
  chunkSize = DEFAULT_CHUNK,
  onProgress,
}) {
  const fileKey = generateKey();
  const filePrefix = crypto.randomBytes(PREFIX_BYTES);
  // `sealTo` (a public key) needs no secret, which is what lets vault mode
  // encrypt uploads while it is locked.
  const sealed = Boolean(sealTo);
  const wrappedFileKey = sealed ? seal.sealTo(sealTo, fileKey) : wrapKey(vmk, fileKey);
  const plaintextSize = fs.statSync(srcPath).size;

  const partPath = `${destPath}.part`;
  const src = fs.openSync(srcPath, "r");
  const out = fs.openSync(partPath, "w");
  const plainHash = crypto.createHash("sha256");
  const blobHash = crypto.createHash("md5");

  const writeAll = (buffer) => {
    let written = 0;
    while (written < buffer.length)
      written += fs.writeSync(out, buffer, written, buffer.length - written);
    blobHash.update(buffer);
  };

  try {
    writeAll(
      buildHeader({ chunkSize, plaintextSize, filePrefix, wrappedFileKey, sealed }),
    );

    const buffer = Buffer.allocUnsafe(chunkSize);
    let index = 0;
    let done = 0;
    for (;;) {
      const read = fs.readSync(src, buffer, 0, chunkSize, null);
      if (read === 0) break;
      const cipher = crypto.createCipheriv(
        "aes-256-gcm",
        fileKey,
        chunkNonce(filePrefix, index),
      );
      const plain = buffer.subarray(0, read);
      plainHash.update(plain);
      writeAll(
        Buffer.concat([
          cipher.update(plain),
          cipher.final(),
          cipher.getAuthTag(),
        ]),
      );
      index += 1;
      done += read;
      onProgress?.(done, plaintextSize);
      // Yield so a large file doesn't freeze timers/IPC in the main process.
      if (index % 4 === 0)
        await new Promise((resolve) => setImmediate(resolve));
    }
    fs.fsyncSync(out);
  } catch (err) {
    fs.closeSync(src);
    fs.closeSync(out);
    fs.rmSync(partPath, { force: true });
    throw err;
  }
  fs.closeSync(src);
  fs.closeSync(out);
  fs.renameSync(partPath, destPath);

  return {
    wrappedFileKey,
    filePrefix,
    chunkSize,
    plaintextSize,
    blobSize: fs.statSync(destPath).size,
    blobMd5: blobHash.digest("hex"),
    plaintextSha256: plainHash.digest("hex"),
  };
}

/* ------------------------------------------------------------- decrypting */

/**
 * Decrypt a whole blob back to a file. Every chunk's tag is checked as it goes
 * (a tampered blob fails at the chunk, not at the end), and the plaintext hash
 * is compared when provided.
 */
async function decryptFileToPath({
  srcPath,
  destPath,
  vmk,
  sealKey,
  expectedSha256 = null,
  signal,
  onProgress,
}) {
  const src = fs.openSync(srcPath, "r");
  let header;
  try {
    const headerBuf = Buffer.alloc(HEADER_SIZE);
    fs.readSync(src, headerBuf, 0, HEADER_SIZE, 0);
    header = parseHeader(headerBuf);
  } catch (err) {
    fs.closeSync(src);
    throw err;
  }

  let fileKey;
  try {
    fileKey = fileKeyOf(header, { vmk, sealKey });
  } catch (err) {
    fs.closeSync(src);
    throw err;
  }
  const partPath = `${destPath}.part`;
  const out = fs.openSync(partPath, "w");
  const plainHash = crypto.createHash("sha256");
  const stride = encryptedChunkSize(header.chunkSize);
  const chunks = chunkCountFor(header.plaintextSize, header.chunkSize);

  try {
    const buffer = Buffer.allocUnsafe(stride);
    let done = 0;
    for (let index = 0; index < chunks; index += 1) {
      if (signal?.aborted) throw fail("Cancelled.", "ABORTED");
      const read = fs.readSync(
        src,
        buffer,
        0,
        stride,
        HEADER_SIZE + index * stride,
      );
      if (read <= TAG_BYTES)
        throw fail("Secure file is truncated.", "VAULT_BAD_BLOB");
      const body = buffer.subarray(0, read - TAG_BYTES);
      const tag = buffer.subarray(read - TAG_BYTES, read);
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        fileKey,
        chunkNonce(header.filePrefix, index),
      );
      decipher.setAuthTag(tag);
      let plain;
      try {
        plain = Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        throw fail("Secure file failed its integrity check.", "VAULT_TAMPERED");
      }
      plainHash.update(plain);
      let written = 0;
      while (written < plain.length)
        written += fs.writeSync(out, plain, written, plain.length - written);
      done += plain.length;
      onProgress?.(done, header.plaintextSize);
      if (index % 4 === 3)
        await new Promise((resolve) => setImmediate(resolve));
    }
    if (expectedSha256 && plainHash.digest("hex") !== expectedSha256)
      throw fail(
        "Decrypted file did not match the original.",
        "VAULT_TAMPERED",
      );
    fs.fsyncSync(out);
  } catch (err) {
    fs.closeSync(src);
    fs.closeSync(out);
    fs.rmSync(partPath, { force: true });
    throw err;
  }
  fs.closeSync(src);
  fs.closeSync(out);
  fs.renameSync(partPath, destPath);
  return { path: destPath, bytes: header.plaintextSize };
}

/* ----------------------------------------------------------- random access */

/**
 * A reader over any ciphertext source - a local temp file or Drive Range
 * requests, whichever the caller supplies as `readCiphertextRange(start, end)`
 * (inclusive, like HTTP). This is what backs `maxvault://`, so a `<video>`
 * seek turns into one small Drive range read instead of a full download.
 */
function openBlobReader({ vmk, sealKey, header, readCiphertextRange }) {
  const fileKey = fileKeyOf(header, { vmk, sealKey });
  const stride = encryptedChunkSize(header.chunkSize);
  const chunks = chunkCountFor(header.plaintextSize, header.chunkSize);

  const decryptChunk = (index, buffer) => {
    const body = buffer.subarray(0, buffer.length - TAG_BYTES);
    const tag = buffer.subarray(buffer.length - TAG_BYTES);
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      fileKey,
      chunkNonce(header.filePrefix, index),
    );
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw fail("Secure file failed its integrity check.", "VAULT_TAMPERED");
    }
  };

  return {
    plaintextSize: header.plaintextSize,
    chunkSize: header.chunkSize,
    /** Plaintext bytes [start, end] inclusive. */
    async readRange(start, end) {
      const from = Math.max(0, start);
      const to = Math.min(end, header.plaintextSize - 1);
      if (header.plaintextSize === 0 || to < from) return Buffer.alloc(0);

      const firstChunk = Math.floor(from / header.chunkSize);
      const lastChunk = Math.min(Math.floor(to / header.chunkSize), chunks - 1);
      const raw = await readCiphertextRange(
        HEADER_SIZE + firstChunk * stride,
        HEADER_SIZE + (lastChunk + 1) * stride - 1,
      );

      const pieces = [];
      for (let index = firstChunk; index <= lastChunk; index += 1) {
        const offset = (index - firstChunk) * stride;
        const slice = Buffer.from(raw).subarray(
          offset,
          Math.min(offset + stride, raw.length),
        );
        if (slice.length <= TAG_BYTES)
          throw fail("Secure file is truncated.", "VAULT_BAD_BLOB");
        pieces.push(decryptChunk(index, slice));
      }
      const joined = Buffer.concat(pieces);
      const skip = from - firstChunk * header.chunkSize;
      return joined.subarray(skip, skip + (to - from + 1));
    },
  };
}

module.exports = {
  HEADER_SIZE,
  DEFAULT_CHUNK,
  buildHeader,
  parseHeader,
  chunkNonce,
  chunkCountFor,
  encryptFileToPath,
  decryptFileToPath,
  openBlobReader,
};
