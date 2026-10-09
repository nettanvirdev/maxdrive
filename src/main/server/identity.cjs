/**
 * Stable server identity for the LAN API: a persistent serverId (advertised in
 * discovery so a client keeps recognising this PC across IP changes) and a
 * token signing key (used to sign bearer tokens and media URLs). Both are
 * generated once and kept in the `settings` table.
 *
 * DPAPI helpers for wrapping a per-device secret at rest mirror the pattern in
 * auth/tokenStore.cjs: encrypt with safeStorage when available, fall back to
 * plaintext otherwise (a fresh Windows install simply cannot read the old blob,
 * which is the intended re-pair trigger, not an error).
 */
const crypto = require("node:crypto");
const { safeStorage } = require("electron");
const { settings } = require("../db/queries.cjs");
const { scope } = require("../logger.cjs");

const log = scope("server-identity");

function serverId() {
  let id = settings.get("serverId");
  if (!id) {
    id = crypto.randomUUID();
    settings.set("serverId", id);
    log.info("generated serverId");
  }
  return id;
}

/** Returns the token signing key as a Buffer, generating it on first use. */
function signingKey() {
  let b64 = settings.get("serverSigningKey");
  if (!b64) {
    b64 = crypto.randomBytes(32).toString("base64");
    settings.set("serverSigningKey", b64);
    log.info("generated token signing key");
  }
  return Buffer.from(b64, "base64");
}

/** DPAPI-wrap a raw secret Buffer for storage as a BLOB. */
function wrapSecret(secret) {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(secret.toString("base64"));
  }
  // Marked so unwrap knows it is not a DPAPI blob.
  return Buffer.concat([Buffer.from("PLAIN:"), secret]);
}

/** Reverse of wrapSecret. Returns a Buffer, or null if unreadable. */
function unwrapSecret(blob) {
  try {
    if (blob.length >= 6 && blob.subarray(0, 6).toString() === "PLAIN:") {
      return blob.subarray(6);
    }
    if (safeStorage.isEncryptionAvailable()) {
      return Buffer.from(safeStorage.decryptString(blob), "base64");
    }
    return null;
  } catch (err) {
    log.warn(`device secret unreadable: ${err.message}`);
    return null;
  }
}

module.exports = { serverId, signingKey, wrapSecret, unwrapSecret };
