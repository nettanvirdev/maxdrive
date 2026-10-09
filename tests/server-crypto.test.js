import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import pairing from "../src/main/server/pairing/crypto.cjs";
import token from "../src/main/server/auth/token.cjs";

describe("pairing crypto", () => {
  it("generates zero-padded 6-digit codes", () => {
    for (let i = 0; i < 200; i++) {
      const code = pairing.generateCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("derives a 32-byte secret matching an independent PBKDF2", () => {
    const salt = Buffer.from("0123456789abcdef", "utf8"); // 16 bytes
    const got = pairing.deriveSecret("123456", salt);
    const expected = crypto.pbkdf2Sync("123456", salt, 10000, 32, "sha256");
    expect(got.length).toBe(32);
    expect(got.equals(expected)).toBe(true);
  });

  it("verifies a correct proof and rejects a wrong one (constant-time-safe)", () => {
    const salt = pairing.generateSalt();
    const secret = pairing.deriveSecret("654321", salt);
    const proof = pairing.computeProof(secret, salt);
    expect(pairing.verifyProof(secret, salt, proof)).toBe(true);

    const wrong = pairing.deriveSecret("000000", salt);
    expect(pairing.verifyProof(wrong, salt, proof)).toBe(false);
    // malformed / wrong-length proof must not throw
    expect(pairing.verifyProof(secret, salt, Buffer.alloc(4))).toBe(false);
    expect(pairing.verifyProof(secret, salt, "not-a-buffer")).toBe(false);
  });
});

describe("device tokens", () => {
  const key = crypto.randomBytes(32);

  it("round-trips claims and rejects tampering", () => {
    const t = token.sign({ deviceId: "dev-1", tokenVersion: 3 }, key);
    const claims = token.verify(t, key);
    expect(claims).toMatchObject({ deviceId: "dev-1", tokenVersion: 3 });
    expect(claims.exp).toBeGreaterThan(Date.now());

    // Wrong signing key → null.
    expect(token.verify(t, crypto.randomBytes(32))).toBeNull();
    // Tampered payload → null.
    const tampered = t.replace("dev-1", "dev-2");
    expect(token.verify(tampered, key)).toBeNull();
    // Garbage → null, never throws.
    expect(token.verify("x.y.z", key)).toBeNull();
    expect(token.verify(null, key)).toBeNull();
  });

  it("rejects expired tokens", () => {
    const t = token.sign({ deviceId: "dev-1", tokenVersion: 1, exp: Date.now() - 1 }, key);
    expect(token.verify(t, key)).toBeNull();
  });

  it("signs and verifies media URLs, rejecting expiry and tampering", () => {
    const { exp, sig } = token.signUrl("node-abc", key, 60_000);
    expect(token.verifyUrl("node-abc", exp, sig, key)).toBe(true);
    // Different id → invalid.
    expect(token.verifyUrl("node-xyz", exp, sig, key)).toBe(false);
    // Expired → invalid.
    expect(token.verifyUrl("node-abc", Date.now() - 1, sig, key)).toBe(false);
    // Wrong sig → invalid.
    expect(token.verifyUrl("node-abc", exp, "deadbeef", key)).toBe(false);
  });
});
