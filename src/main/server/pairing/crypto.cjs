/**
 * Pairing key-derivation and proof primitives for the LAN server.
 *
 * Ported verbatim (same parameters) from the reference project's
 * RapidControl.Core/Crypto/PairingCrypto.cs so a future mobile client that
 * already speaks that scheme needs no changes: a 6-digit code shown on the PC
 * is turned into a per-device secret with PBKDF2, and every proof is an HMAC
 * over a server-issued challenge. The code itself never crosses the network -
 * only proofs do (see docs / PROTOCOL).
 *
 * PURE: no Electron, DB or filesystem imports, so it unit-tests like
 * vault/crypto.cjs.
 */
const crypto = require("node:crypto");

/** Shared constants - keep in step with the reference ProtocolConstants.cs. */
const PROTOCOL_VERSION = 1;
const PBKDF2_ITERATIONS = 10_000;
const SECRET_LENGTH = 32; // bytes
const SALT_LENGTH = 16;
const NONCE_LENGTH = 16;
const CODE_DIGITS = 6;
const MAX_PAIRING_ATTEMPTS = 3;
const PAIRING_LOCKOUT_MS = 60_000;
const CODE_TTL_MS = 3 * 60_000; // pairing code lifetime (3 minutes)

/** 6 decimal digits, zero-padded, from a CSPRNG. */
function generateCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(CODE_DIGITS, "0");
}

function generateSalt() {
  return crypto.randomBytes(SALT_LENGTH);
}

function generateNonce() {
  return crypto.randomBytes(NONCE_LENGTH);
}

/** secret = PBKDF2-HMAC-SHA256(code, salt, 10000, 32). */
function deriveSecret(code, salt) {
  return crypto.pbkdf2Sync(
    Buffer.from(String(code), "utf8"),
    salt,
    PBKDF2_ITERATIONS,
    SECRET_LENGTH,
    "sha256",
  );
}

/** proof = HMAC-SHA256(secret, challenge), full 32 bytes. */
function computeProof(secret, challenge) {
  return crypto.createHmac("sha256", secret).update(challenge).digest();
}

/** Constant-time proof comparison. Tolerates malformed / wrong-length input. */
function verifyProof(secret, challenge, proof) {
  const expected = computeProof(secret, challenge);
  if (!Buffer.isBuffer(proof) || proof.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, proof);
}

module.exports = {
  PROTOCOL_VERSION,
  PBKDF2_ITERATIONS,
  SECRET_LENGTH,
  SALT_LENGTH,
  NONCE_LENGTH,
  CODE_DIGITS,
  MAX_PAIRING_ATTEMPTS,
  PAIRING_LOCKOUT_MS,
  CODE_TTL_MS,
  generateCode,
  generateSalt,
  generateNonce,
  deriveSecret,
  computeProof,
  verifyProof,
};
