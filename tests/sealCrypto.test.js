import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import seal from "../src/main/vault/seal.cjs";
import blob from "../src/main/vault/blobFormat.cjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maxdrive-seal-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

describe("seal key", () => {
  const { configRow, privateKey, recoveryKey } = seal.createSealConfig("correct horse");

  it("boxes and opens with the matching key only", () => {
    const box = seal.sealTo(configRow.public_key, Buffer.from("secret"));
    expect(box.length).toBe(32 + 12 + 6 + 16);
    expect(seal.openSealed(privateKey, box).toString()).toBe("secret");
    const other = seal.createSealConfig("another one").privateKey;
    expect(() => seal.openSealed(other, box)).toThrow(expect.objectContaining({ code: "VAULT_TAMPERED" }));
    // Two seals of the same plaintext never look alike (fresh ephemeral key).
    expect(seal.sealTo(configRow.public_key, Buffer.from("secret")).equals(box)).toBe(false);
  });

  it("unlocks with the password or the recovery key alone", () => {
    expect(seal.unlockSealConfig(configRow, "correct horse").key.equals(privateKey)).toBe(true);
    const viaRecovery = seal.unlockSealConfig(configRow, recoveryKey.toLowerCase(), { recovery: true });
    expect(viaRecovery.key.equals(privateKey)).toBe(true);
    expect(() => seal.unlockSealConfig(configRow, "wrong")).toThrow(expect.objectContaining({ code: "WRONG_PASSWORD" }));
    const foreign = seal.createSealConfig("x".repeat(8)).recoveryKey;
    expect(() => seal.unlockSealConfig(configRow, foreign, { recovery: true })).toThrow(
      expect.objectContaining({ code: "WRONG_PASSWORD" }),
    );
  });

  it("changes the password without changing the key", () => {
    const next = seal.rewrapSealPassword(configRow, privateKey, "new password!");
    expect(seal.unlockSealConfig(next, "new password!").key.equals(privateKey)).toBe(true);
    expect(() => seal.unlockSealConfig(next, "correct horse")).toThrow();
    expect(Buffer.from(next.public_key).equals(Buffer.from(configRow.public_key))).toBe(true);
  });

  it("seals JSON metadata", () => {
    const box = seal.sealJson(configRow.public_key, { name: "Q3 report.pdf", size: 12 });
    expect(seal.openJson(privateKey, box)).toEqual({ name: "Q3 report.pdf", size: 12 });
  });
});

describe("sealed .mxv blobs", () => {
  const { configRow, privateKey } = seal.createSealConfig("blob password");
  const src = path.join(dir, "plain.bin");
  fs.writeFileSync(src, crypto.randomBytes(3 * 1024 * 1024 + 123));

  it("encrypts with only the public key and decrypts with the private key", async () => {
    const out = path.join(dir, "sealed.mxv");
    const info = await blob.encryptFileToPath({ srcPath: src, destPath: out, sealTo: configRow.public_key, chunkSize: 1024 * 1024 });
    const header = blob.parseHeader(fs.readFileSync(out).subarray(0, blob.HEADER_SIZE));
    expect(header.sealed).toBe(true);

    const back = path.join(dir, "back.bin");
    await blob.decryptFileToPath({ srcPath: out, destPath: back, sealKey: privateKey, expectedSha256: info.plaintextSha256 });
    expect(sha256(back)).toBe(sha256(src));

    // Random access (preview) over the same blob.
    const fd = fs.openSync(out, "r");
    const reader = blob.openBlobReader({
      sealKey: privateKey,
      header,
      readCiphertextRange: async (start, end) => {
        const buf = Buffer.alloc(end - start + 1);
        const n = fs.readSync(fd, buf, 0, buf.length, start);
        return buf.subarray(0, n);
      },
    });
    const slice = await reader.readRange(1024 * 1024 - 5, 1024 * 1024 + 5);
    expect(slice.equals(fs.readFileSync(src).subarray(1024 * 1024 - 5, 1024 * 1024 + 6))).toBe(true);
    fs.closeSync(fd);
  });

  it("refuses to open a sealed blob while locked", async () => {
    const out = path.join(dir, "sealed2.mxv");
    await blob.encryptFileToPath({ srcPath: src, destPath: out, sealTo: configRow.public_key });
    await expect(
      blob.decryptFileToPath({ srcPath: out, destPath: path.join(dir, "nope.bin") }),
    ).rejects.toMatchObject({ code: "SEAL_LOCKED" });
  });
});
