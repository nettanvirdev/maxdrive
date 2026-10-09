import { describe, expect, it } from "vitest";
import {
  createConfig,
  decryptMeta,
  deriveKek,
  encryptMeta,
  formatRecoveryKey,
  generateKey,
  parseCfgFile,
  parseRecoveryKey,
  rewrapPassword,
  rewrapRecovery,
  serializeCfgFile,
  unlockConfig,
  unwrapKey,
  wrapKey,
} from "../src/main/vault/crypto.cjs";

// scrypt at production cost would make this suite crawl; the code under test
// is identical, only the work factor differs.
const FAST = { algo: "scrypt", N: 1024, r: 8, p: 1 };

describe("key wrapping", () => {
  it("round-trips a key", () => {
    const kek = generateKey();
    const key = generateKey();
    expect(unwrapKey(kek, wrapKey(kek, key)).equals(key)).toBe(true);
  });

  it("rejects the wrong key with WRONG_PASSWORD", () => {
    const wrapped = wrapKey(generateKey(), generateKey());
    expect(() => unwrapKey(generateKey(), wrapped)).toThrowError(/Incorrect password/);
  });

  it("rejects a tampered wrap", () => {
    const kek = generateKey();
    const wrapped = wrapKey(kek, generateKey());
    wrapped[20] ^= 0xff;
    expect(() => unwrapKey(kek, wrapped)).toThrowError(/Incorrect password/);
  });

  it("derives the same kek from the same password and salt", () => {
    const salt = generateKey();
    expect(deriveKek("hunter2", salt, FAST).equals(deriveKek("hunter2", salt, FAST))).toBe(true);
  });

  it("derives different keks per salt", () => {
    expect(
      deriveKek("hunter2", generateKey(), FAST).equals(deriveKek("hunter2", generateKey(), FAST))
    ).toBe(false);
  });
});

describe("vault config", () => {
  it("unlocks with the right password", () => {
    const { configRow, vmk } = createConfig("correct horse", FAST);
    expect(unlockConfig(configRow, "correct horse").vmk.equals(vmk)).toBe(true);
  });

  it("refuses the wrong password", () => {
    const { configRow } = createConfig("correct horse", FAST);
    expect(() => unlockConfig(configRow, "correct hoarse")).toThrowError(/Incorrect password/);
  });

  it("unlocks with the recovery key", () => {
    const { configRow, vmk, recoveryKey } = createConfig("pw", FAST);
    const result = unlockConfig(configRow, recoveryKey, { recovery: true });
    expect(result.vmk.equals(vmk)).toBe(true);
    expect(result.usedRecovery).toBe(true);
  });

  it("keeps the same master key across a password change", () => {
    const { configRow, vmk } = createConfig("old pw", FAST);
    const rotated = rewrapPassword(configRow, vmk, "new pw");
    expect(unlockConfig(rotated, "new pw").vmk.equals(vmk)).toBe(true);
    expect(() => unlockConfig(rotated, "old pw")).toThrowError(/Incorrect password/);
    expect(rotated.rev).toBe(configRow.rev + 1);
  });

  it("keeps the recovery key working after a password change", () => {
    const { configRow, vmk, recoveryKey } = createConfig("old pw", FAST);
    const rotated = rewrapPassword(configRow, vmk, "new pw");
    expect(unlockConfig(rotated, recoveryKey, { recovery: true }).vmk.equals(vmk)).toBe(true);
  });

  // The whole point of a recovery key: a user who has forgotten the password
  // must be able to get back to a vault they can open normally again.
  it("lets the recovery key stand in for a forgotten password", () => {
    const { configRow, vmk, recoveryKey } = createConfig("forgotten pw", FAST);

    const recovered = unlockConfig(configRow, recoveryKey, { recovery: true });
    expect(recovered.vmk.equals(vmk)).toBe(true);
    expect(recovered.usedRecovery).toBe(true);

    const rotated = rewrapPassword(configRow, recovered.vmk, "brand new pw");
    expect(unlockConfig(rotated, "brand new pw").vmk.equals(vmk)).toBe(true);
    expect(() => unlockConfig(rotated, "forgotten pw")).toThrowError(
      /Incorrect password/
    );
    expect(unlockConfig(rotated, recoveryKey, { recovery: true }).vmk.equals(vmk)).toBe(
      true
    );
  });

  // Rotating a key that may have been seen by someone else must not require
  // the password, or a user who only has the key is stuck with it forever.
  it("rotates the recovery key using the old recovery key as proof", () => {
    const { configRow, vmk, recoveryKey } = createConfig("pw", FAST);
    const proof = unlockConfig(configRow, recoveryKey, { recovery: true });
    const { configRow: rotated, recoveryKey: fresh } = rewrapRecovery(
      configRow,
      proof.vmk
    );
    expect(unlockConfig(rotated, fresh, { recovery: true }).vmk.equals(vmk)).toBe(true);
    expect(() => unlockConfig(rotated, recoveryKey, { recovery: true })).toThrowError(
      /Incorrect password/
    );
    expect(unlockConfig(rotated, "pw").vmk.equals(vmk)).toBe(true);
  });

  it("invalidates the old recovery key when a new one is issued", () => {
    const { configRow, vmk, recoveryKey } = createConfig("pw", FAST);
    const { configRow: rotated, recoveryKey: fresh } = rewrapRecovery(configRow, vmk);
    expect(unlockConfig(rotated, fresh, { recovery: true }).vmk.equals(vmk)).toBe(true);
    expect(() => unlockConfig(rotated, recoveryKey, { recovery: true })).toThrowError(
      /Incorrect password/
    );
  });
});

describe("recovery key encoding", () => {
  it("round-trips 32 bytes", () => {
    const raw = generateKey();
    expect(parseRecoveryKey(formatRecoveryKey(raw)).equals(raw)).toBe(true);
  });

  it("is grouped and readable", () => {
    const text = formatRecoveryKey(generateKey());
    expect(text).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{1,5})+$/);
  });

  it("forgives casing, spacing and the 0/O and 1/I mix-ups", () => {
    const raw = generateKey();
    const text = formatRecoveryKey(raw);
    const mangled = text.toLowerCase().replace(/-/g, " ").replace(/o/g, "0").replace(/i/g, "1");
    expect(parseRecoveryKey(mangled).equals(raw)).toBe(true);
  });

  it("rejects an impossible character", () => {
    expect(() => parseRecoveryKey(`${formatRecoveryKey(generateKey())}$`)).toThrowError(
      /isn't valid/
    );
  });

  it("rejects a truncated key", () => {
    expect(() => parseRecoveryKey("ABCDE-FGHIJ")).toThrowError(/isn't valid/);
  });
});

describe("metadata encryption", () => {
  it("round-trips a value", () => {
    const vmk = generateKey();
    const meta = { name: "Passport scan.pdf", mime: "application/pdf" };
    expect(decryptMeta(vmk, encryptMeta(vmk, meta))).toEqual(meta);
  });

  it("leaks nothing readable", () => {
    const vmk = generateKey();
    const blob = encryptMeta(vmk, { name: "Passport scan.pdf" });
    expect(blob.toString("latin1")).not.toContain("Passport");
  });

  it("fails under the wrong master key", () => {
    const blob = encryptMeta(generateKey(), { name: "x" });
    expect(() => decryptMeta(generateKey(), blob)).toThrowError(/could not be read/);
  });
});

describe("vault.cfg file", () => {
  it("survives a serialize/parse round-trip", () => {
    const { configRow, vmk } = createConfig("pw", FAST);
    const parsed = parseCfgFile(serializeCfgFile(configRow));
    expect(parsed.rev).toBe(configRow.rev);
    expect(unlockConfig(parsed, "pw").vmk.equals(vmk)).toBe(true);
  });

  it("carries the recovery wrap too", () => {
    const { configRow, vmk, recoveryKey } = createConfig("pw", FAST);
    const parsed = parseCfgFile(serializeCfgFile(configRow));
    expect(unlockConfig(parsed, recoveryKey, { recovery: true }).vmk.equals(vmk)).toBe(true);
  });

  it("rejects a foreign file", () => {
    expect(() => parseCfgFile(Buffer.from('{"format":"something-else"}'))).toThrowError(
      /Not a MaxDrive vault config/
    );
  });
});
