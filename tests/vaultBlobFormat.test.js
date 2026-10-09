import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKey } from "../src/main/vault/crypto.cjs";
import {
  DEFAULT_CHUNK,
  HEADER_SIZE,
  buildHeader,
  chunkCountFor,
  chunkNonce,
  decryptFileToPath,
  encryptFileToPath,
  openBlobReader,
  parseHeader,
} from "../src/main/vault/blobFormat.cjs";

let dir;
const CHUNK = 1024; // small chunks keep multi-chunk cases fast

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "maxvault-test-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name, buf) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
};

/** Encrypt then decrypt a buffer, asserting the bytes survive exactly. */
async function roundTrip(name, plain, chunkSize = CHUNK) {
  const vmk = generateKey();
  const src = write(`${name}.in`, plain);
  const blob = path.join(dir, `${name}.mxv`);
  const out = path.join(dir, `${name}.out`);
  const meta = await encryptFileToPath({ srcPath: src, destPath: blob, vmk, chunkSize });
  await decryptFileToPath({
    srcPath: blob,
    destPath: out,
    vmk,
    expectedSha256: meta.plaintextSha256,
  });
  return { meta, vmk, blob, result: fs.readFileSync(out) };
}

describe("header", () => {
  it("round-trips its fields", () => {
    const header = buildHeader({
      chunkSize: DEFAULT_CHUNK,
      plaintextSize: 123456789,
      filePrefix: Buffer.alloc(8, 7),
      wrappedFileKey: Buffer.alloc(60, 3),
    });
    expect(header.length).toBe(HEADER_SIZE);
    const parsed = parseHeader(header);
    expect(parsed.chunkSize).toBe(DEFAULT_CHUNK);
    expect(parsed.plaintextSize).toBe(123456789);
    expect(parsed.filePrefix.equals(Buffer.alloc(8, 7))).toBe(true);
  });

  it("rejects a file that isn't ours", () => {
    expect(() => parseHeader(Buffer.alloc(HEADER_SIZE))).toThrowError(/not a MaxDrive secure file/i);
  });

  it("binds the nonce to the chunk index", () => {
    const prefix = Buffer.alloc(8, 1);
    expect(chunkNonce(prefix, 0).equals(chunkNonce(prefix, 1))).toBe(false);
    expect(chunkNonce(prefix, 5).readUInt32BE(8)).toBe(5);
  });
});

describe("size arithmetic", () => {
  it("counts chunks", () => {
    expect(chunkCountFor(0, CHUNK)).toBe(0);
    expect(chunkCountFor(CHUNK, CHUNK)).toBe(1);
    expect(chunkCountFor(CHUNK + 1, CHUNK)).toBe(2);
  });
});

describe("encrypt / decrypt", () => {
  it("round-trips an empty file", async () => {
    const { result, meta } = await roundTrip("empty", Buffer.alloc(0));
    expect(result.length).toBe(0);
    expect(meta.blobSize).toBe(HEADER_SIZE);
  });

  it("round-trips a partial chunk", async () => {
    const plain = Buffer.from("the vault holds this exactly");
    const { result } = await roundTrip("small", plain);
    expect(result.equals(plain)).toBe(true);
  });

  it("round-trips an exact chunk multiple", async () => {
    const plain = Buffer.alloc(CHUNK * 3, 0xab);
    const { result } = await roundTrip("exact", plain);
    expect(result.equals(plain)).toBe(true);
  });

  it("round-trips chunk-size + 1", async () => {
    const plain = Buffer.concat([Buffer.alloc(CHUNK, 1), Buffer.from([9])]);
    const { result } = await roundTrip("plusone", plain);
    expect(result.equals(plain)).toBe(true);
  });

  it("produces ciphertext that reveals nothing of the plaintext", async () => {
    const plain = Buffer.from("SECRET-MARKER-STRING".repeat(20));
    const { blob } = await roundTrip("opaque", plain);
    expect(fs.readFileSync(blob).toString("latin1")).not.toContain("SECRET-MARKER");
  });

  it("refuses the wrong master key", async () => {
    const { blob } = await roundTrip("wrongkey", Buffer.from("abc"));
    await expect(
      decryptFileToPath({ srcPath: blob, destPath: path.join(dir, "no.out"), vmk: generateKey() })
    ).rejects.toThrowError(/Incorrect password/);
  });

  it("detects a flipped ciphertext bit", async () => {
    const { blob, vmk } = await roundTrip("tamper", Buffer.alloc(CHUNK * 2, 5));
    const bytes = fs.readFileSync(blob);
    bytes[HEADER_SIZE + 10] ^= 0xff;
    fs.writeFileSync(blob, bytes);
    await expect(
      decryptFileToPath({ srcPath: blob, destPath: path.join(dir, "tamper.out"), vmk })
    ).rejects.toThrowError(/integrity check/);
  });

  it("detects swapped chunks", async () => {
    const plain = Buffer.concat([Buffer.alloc(CHUNK, 1), Buffer.alloc(CHUNK, 2)]);
    const { blob, vmk } = await roundTrip("swap", plain);
    const bytes = fs.readFileSync(blob);
    const stride = CHUNK + 16;
    const a = Buffer.from(bytes.subarray(HEADER_SIZE, HEADER_SIZE + stride));
    const b = Buffer.from(bytes.subarray(HEADER_SIZE + stride, HEADER_SIZE + stride * 2));
    b.copy(bytes, HEADER_SIZE);
    a.copy(bytes, HEADER_SIZE + stride);
    fs.writeFileSync(blob, bytes);
    await expect(
      decryptFileToPath({ srcPath: blob, destPath: path.join(dir, "swap.out"), vmk })
    ).rejects.toThrowError(/integrity check/);
  });

  it("detects a plaintext hash mismatch", async () => {
    const { blob, vmk } = await roundTrip("hash", Buffer.from("hello"));
    await expect(
      decryptFileToPath({
        srcPath: blob,
        destPath: path.join(dir, "hash.out"),
        vmk,
        expectedSha256: "0".repeat(64),
      })
    ).rejects.toThrowError(/did not match the original/);
  });

  it("leaves no output file behind when it fails", async () => {
    const { blob } = await roundTrip("cleanup", Buffer.from("abc"));
    const out = path.join(dir, "cleanup.fail");
    await expect(
      decryptFileToPath({ srcPath: blob, destPath: out, vmk: generateKey() })
    ).rejects.toThrow();
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(`${out}.part`)).toBe(false);
  });
});

describe("random access reader", () => {
  const plain = Buffer.from(
    Array.from({ length: CHUNK * 3 + 77 }, (_, i) => i % 251)
  );

  /** Reader backed by the local blob file, the same shape the protocol uses. */
  async function reader() {
    const vmk = generateKey();
    const src = write("range.in", plain);
    const blob = path.join(dir, "range.mxv");
    await encryptFileToPath({ srcPath: src, destPath: blob, vmk, chunkSize: CHUNK });
    const header = parseHeader(fs.readFileSync(blob).subarray(0, HEADER_SIZE));
    return openBlobReader({
      vmk,
      header,
      readCiphertextRange: async (start, end) => {
        const fd = fs.openSync(blob, "r");
        const size = fs.statSync(blob).size;
        const stop = Math.min(end, size - 1);
        const buf = Buffer.alloc(Math.max(0, stop - start + 1));
        if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        return buf;
      },
    });
  }

  it("reports the plaintext size", async () => {
    expect((await reader()).plaintextSize).toBe(plain.length);
  });

  it("reads the whole file", async () => {
    const r = await reader();
    expect((await r.readRange(0, plain.length - 1)).equals(plain)).toBe(true);
  });

  it("reads a range inside one chunk", async () => {
    const r = await reader();
    expect((await r.readRange(10, 20)).equals(plain.subarray(10, 21))).toBe(true);
  });

  it("reads a range spanning a chunk boundary", async () => {
    const r = await reader();
    const start = CHUNK - 5;
    const end = CHUNK + 5;
    expect((await r.readRange(start, end)).equals(plain.subarray(start, end + 1))).toBe(true);
  });

  it("reads a range spanning several chunks", async () => {
    const r = await reader();
    expect((await r.readRange(100, CHUNK * 2 + 50)).equals(plain.subarray(100, CHUNK * 2 + 51)))
      .toBe(true);
  });

  it("reads the short final chunk", async () => {
    const r = await reader();
    const start = CHUNK * 3;
    expect((await r.readRange(start, plain.length - 1)).equals(plain.subarray(start))).toBe(true);
  });

  it("clamps a range past the end", async () => {
    const r = await reader();
    expect((await r.readRange(plain.length - 3, plain.length + 999)).equals(plain.subarray(-3)))
      .toBe(true);
  });
});
