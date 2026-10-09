/**
 * Vault mode's key: an X25519 key pair, so content can be encrypted with only
 * the PUBLIC key (always available - uploads work while locked) and opened
 * only with the PRIVATE key (held by sealSession while unlocked).
 *
 * The private key is derived from the recovery key (HKDF), so the printed
 * recovery key alone regenerates it even if every local file is lost. The
 * password wraps the same private key (scrypt KEK + AES-GCM, as the vault
 * does), so a password change re-wraps 32 bytes and touches no file.
 *
 * `sealTo` is an ECIES-style box: a fresh ephemeral key pair per message,
 * ECDH with the recipient, HKDF bound to both public keys, AES-256-GCM.
 * Output: ephemeralPublic(32) || iv(12) || ciphertext || tag(16).
 *
 * Pure node:crypto - no Electron, no DB.
 */
const crypto = require("node:crypto");
const {
  fail,
  DEFAULT_KDF,
  generateKey,
  deriveKek,
  wrapKey,
  unwrapKey,
  formatRecoveryKey,
  parseRecoveryKey,
} = require("./crypto.cjs");

const VERSION = 1;
const PUBLIC_BYTES = 32;
// DER prefixes that turn raw 32-byte X25519 keys into PKCS#8 / SPKI.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const privateKeyObject = (raw) =>
  crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
const publicKeyObject = (raw) =>
  crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
const rawPublic = (keyObject) =>
  keyObject.export({ format: "der", type: "spki" }).subarray(-PUBLIC_BYTES);

/** The public half of a raw private key. */
const publicKeyOf = (privateRaw) =>
  rawPublic(crypto.createPublicKey(privateKeyObject(privateRaw)));

/** The recovery key is the root secret: the private key is derived from it. */
const privateKeyFromRecovery = (recoveryRaw) =>
  Buffer.from(crypto.hkdfSync("sha256", recoveryRaw, Buffer.alloc(0), "maxdrive-seal-x25519", 32));

function boxKey(shared, ephemeralPublic, recipientPublic) {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      shared,
      Buffer.concat([ephemeralPublic, recipientPublic]),
      "maxdrive-seal-v1",
      32,
    ),
  );
}

/** Encrypt `plaintext` so only the holder of `publicKey`'s private half can read it. */
function sealTo(publicKey, plaintext) {
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const ephemeralPublic = rawPublic(ephemeral.publicKey);
  const shared = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: publicKeyObject(publicKey),
  });
  return Buffer.concat([
    ephemeralPublic,
    wrapKey(boxKey(shared, ephemeralPublic, Buffer.from(publicKey)), plaintext),
  ]);
}

/** Inverse of sealTo. Wrong key or tampered box → VAULT_TAMPERED. */
function openSealed(privateKey, sealed) {
  const box = Buffer.from(sealed);
  const ephemeralPublic = box.subarray(0, PUBLIC_BYTES);
  const shared = crypto.diffieHellman({
    privateKey: privateKeyObject(privateKey),
    publicKey: publicKeyObject(ephemeralPublic),
  });
  try {
    return unwrapKey(boxKey(shared, ephemeralPublic, publicKeyOf(privateKey)), box.subarray(PUBLIC_BYTES));
  } catch {
    throw fail("This encrypted item can't be opened with this key.", "VAULT_TAMPERED");
  }
}

const sealJson = (publicKey, value) => sealTo(publicKey, Buffer.from(JSON.stringify(value), "utf8"));
const openJson = (privateKey, sealed) => JSON.parse(openSealed(privateKey, sealed).toString("utf8"));

/** A new vault-mode key. The recovery key is returned once, in printable form. */
function createSealConfig(password) {
  const recoveryRaw = generateKey();
  const privateKey = privateKeyFromRecovery(recoveryRaw);
  const salt = crypto.randomBytes(32);
  return {
    configRow: {
      version: VERSION,
      kdf_params: JSON.stringify(DEFAULT_KDF),
      salt,
      wrapped_priv: wrapKey(deriveKek(password, salt, DEFAULT_KDF), privateKey),
      public_key: publicKeyOf(privateKey),
    },
    privateKey,
    recoveryKey: formatRecoveryKey(recoveryRaw),
  };
}

/** Password → unwrap; recovery key → re-derive and check it matches this config. */
function unlockSealConfig(configRow, secret, { recovery = false } = {}) {
  if (recovery) {
    const privateKey = privateKeyFromRecovery(parseRecoveryKey(secret));
    if (!publicKeyOf(privateKey).equals(Buffer.from(configRow.public_key))) {
      throw fail("That recovery key doesn't belong to this vault mode.", "WRONG_PASSWORD");
    }
    return { key: privateKey, usedRecovery: true };
  }
  const params = JSON.parse(configRow.kdf_params || "{}");
  const key = unwrapKey(deriveKek(secret, configRow.salt, params), configRow.wrapped_priv);
  return { key, usedRecovery: false };
}

/** Password change: fresh salt, same private key. Nothing else is re-encrypted. */
function rewrapSealPassword(configRow, privateKey, newPassword) {
  const salt = crypto.randomBytes(32);
  return {
    ...configRow,
    salt,
    kdf_params: JSON.stringify(DEFAULT_KDF),
    wrapped_priv: wrapKey(deriveKek(newPassword, salt, DEFAULT_KDF), privateKey),
  };
}

module.exports = {
  SEALED_KEY_BYTES: PUBLIC_BYTES + 12 + 32 + 16,
  sealTo,
  openSealed,
  sealJson,
  openJson,
  publicKeyOf,
  createSealConfig,
  unlockSealConfig,
  rewrapSealPassword,
};
