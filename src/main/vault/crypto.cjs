/**
 * Vault key management - zero-knowledge by construction.
 *
 * A random 256-bit Vault Master Key (VMK) encrypts everything. The VMK itself
 * is never stored bare: it is wrapped with AES-256-GCM under a key derived
 * from the user's password (scrypt), and optionally a second time under the
 * recovery key. That indirection is what makes a password change cheap - we
 * re-wrap 32 bytes instead of re-encrypting every file - and it is why two
 * different secrets can open the same vault.
 *
 * GCM's authentication tag doubles as the password verifier: if the tag fails
 * the password was wrong. There is deliberately no separate "password hash"
 * anywhere, so an attacker with the database learns nothing to attack offline
 * beyond the same scrypt work the real unlock costs.
 *
 * Pure Node `crypto` - no Electron, no DB imports, so it unit-tests directly.
 */
const crypto = require("node:crypto");

const VERSION = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * scrypt cost. N=2^15 lands around 100 ms on a typical desktop - slow enough
 * to hurt brute force, fast enough that unlocking doesn't feel broken. Stored
 * per-vault in the config so these can be raised later without stranding
 * existing vaults.
 */
const DEFAULT_KDF = { algo: "scrypt", N: 1 << 15, r: 8, p: 1 };
const MAXMEM = 128 * 1024 * 1024;

/** Coded error, non-retryable by default - shared by the vault modules. */
function fail(message, code, retryable = false) {
  const err = new Error(message);
  err.code = code;
  err.retryable = retryable;
  return err;
}

function generateKey(bytes = KEY_BYTES) {
  return crypto.randomBytes(bytes);
}

/** Derive a key-encryption key from a human secret. */
function deriveKek(secret, salt, params = DEFAULT_KDF) {
  if (params.algo && params.algo !== "scrypt")
    throw fail(`Unsupported KDF: ${params.algo}`, "VAULT_KDF_UNSUPPORTED");
  const material = Buffer.isBuffer(secret)
    ? secret
    : Buffer.from(String(secret), "utf8");
  return crypto.scryptSync(material, salt, KEY_BYTES, {
    N: params.N ?? DEFAULT_KDF.N,
    r: params.r ?? DEFAULT_KDF.r,
    p: params.p ?? DEFAULT_KDF.p,
    maxmem: MAXMEM,
  });
}

/** AES-256-GCM wrap: iv || ciphertext || tag, in one buffer. */
function wrapKey(kek, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv);
  const ct = Buffer.concat([cipher.update(key), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

/** Inverse of wrapKey. A bad key or tampered blob throws WRONG_PASSWORD. */
function unwrapKey(kek, wrapped) {
  const buf = Buffer.from(wrapped);
  if (buf.length < IV_BYTES + TAG_BYTES + 1)
    throw fail("Vault key material is corrupt.", "VAULT_CORRUPT");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", kek, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw fail("Incorrect password.", "WRONG_PASSWORD");
  }
}

/* -------------------------------------------------------------- recovery */

// RFC 4648 base32. Digits 0/1 are absent from the alphabet, which is what
// makes the O/0 and I/1 mix-ups below safe to auto-correct on input.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 32 random bytes as 8 groups of 5 chars, e.g. "ABCDE-FGHJK-…". */
function formatRecoveryKey(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.match(/.{1,5}/g).join("-");
}

/**
 * Accept what the user actually types: any casing, dashes or spaces as
 * separators, and the two letter/digit pairs people habitually mistype.
 * Anything else is rejected loudly - a silently skipped character would
 * produce a different key and an unexplainable "wrong key" later.
 */
function parseRecoveryKey(text) {
  const chars = String(text)
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I");
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const ch of chars) {
    const idx = B32.indexOf(ch);
    if (idx < 0)
      throw fail("That recovery key isn't valid.", "BAD_RECOVERY_KEY");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const buf = Buffer.from(bytes);
  if (buf.length < KEY_BYTES)
    throw fail("That recovery key isn't valid.", "BAD_RECOVERY_KEY");
  return buf.subarray(0, KEY_BYTES);
}

/* ---------------------------------------------------------------- config */

/**
 * Create a brand-new vault. Returns the row to persist, the live VMK, and the
 * recovery key - the only moment the recovery key exists in printable form.
 */
function createConfig(password, params = DEFAULT_KDF) {
  const vmk = generateKey();
  const salt = crypto.randomBytes(SALT_BYTES);
  const recoverySalt = crypto.randomBytes(SALT_BYTES);
  const recoveryRaw = generateKey();

  const configRow = {
    version: VERSION,
    rev: 1,
    kdf_params: JSON.stringify(params),
    salt,
    wrapped_vmk: wrapKey(deriveKek(password, salt, params), vmk),
    recovery_salt: recoverySalt,
    wrapped_vmk_recovery: wrapKey(
      deriveKek(recoveryRaw, recoverySalt, params),
      vmk,
    ),
  };
  return { configRow, vmk, recoveryKey: formatRecoveryKey(recoveryRaw) };
}

function paramsOf(configRow) {
  try {
    return JSON.parse(configRow.kdf_params) || DEFAULT_KDF;
  } catch {
    return DEFAULT_KDF;
  }
}

/**
 * Try the password wrap first, then the recovery wrap. Both failing is
 * reported identically - a caller can't learn which secret was "closer".
 */
function unlockConfig(configRow, secret, { recovery = false } = {}) {
  const params = paramsOf(configRow);
  if (!recovery) {
    const vmk = unwrapKey(
      deriveKek(secret, configRow.salt, params),
      configRow.wrapped_vmk,
    );
    return { vmk, usedRecovery: false };
  }
  if (!configRow.wrapped_vmk_recovery)
    throw fail("This vault has no recovery key.", "NO_RECOVERY_KEY");
  const raw = parseRecoveryKey(secret);
  const vmk = unwrapKey(
    deriveKek(raw, configRow.recovery_salt, params),
    configRow.wrapped_vmk_recovery,
  );
  return { vmk, usedRecovery: true };
}

/** Password change: fresh salt + wrap around the same VMK. Files untouched. */
function rewrapPassword(configRow, vmk, newPassword) {
  const params = paramsOf(configRow);
  const salt = crypto.randomBytes(SALT_BYTES);
  return {
    ...configRow,
    rev: (configRow.rev || 1) + 1,
    salt,
    wrapped_vmk: wrapKey(deriveKek(newPassword, salt, params), vmk),
  };
}

/** Issue a replacement recovery key, invalidating the old one. */
function rewrapRecovery(configRow, vmk) {
  const params = paramsOf(configRow);
  const recoverySalt = crypto.randomBytes(SALT_BYTES);
  const raw = generateKey();
  return {
    configRow: {
      ...configRow,
      rev: (configRow.rev || 1) + 1,
      recovery_salt: recoverySalt,
      wrapped_vmk_recovery: wrapKey(deriveKek(raw, recoverySalt, params), vmk),
    },
    recoveryKey: formatRecoveryKey(raw),
  };
}

/* ------------------------------------------------------- metadata blobs */

/** Encrypt a small JSON value (file name, mime, index snapshot) under the VMK. */
function encryptMeta(vmk, value) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", vmk, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

function decryptMeta(vmk, blob) {
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", vmk, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    throw fail("Vault metadata could not be read.", "VAULT_CORRUPT");
  }
}

/* ------------------------------------------------- vault.cfg on Drive */

/**
 * The config file uploaded to each vault account. Base64 everywhere so it
 * survives as plain JSON; `rev` decides which copy wins during recovery.
 */
function serializeCfgFile(configRow) {
  return Buffer.from(
    JSON.stringify({
      format: "maxdrive-vault-config",
      version: configRow.version ?? VERSION,
      rev: configRow.rev ?? 1,
      kdfParams: configRow.kdf_params,
      salt: Buffer.from(configRow.salt).toString("base64"),
      wrappedVmk: Buffer.from(configRow.wrapped_vmk).toString("base64"),
      recoverySalt: configRow.recovery_salt
        ? Buffer.from(configRow.recovery_salt).toString("base64")
        : null,
      wrappedVmkRecovery: configRow.wrapped_vmk_recovery
        ? Buffer.from(configRow.wrapped_vmk_recovery).toString("base64")
        : null,
    }),
    "utf8",
  );
}

function parseCfgFile(buffer) {
  let json;
  try {
    json = JSON.parse(Buffer.from(buffer).toString("utf8"));
  } catch {
    throw fail("Vault config file is unreadable.", "VAULT_CORRUPT");
  }
  if (json.format !== "maxdrive-vault-config")
    throw fail("Not a MaxDrive vault config.", "VAULT_CORRUPT");
  return {
    version: json.version,
    rev: json.rev || 1,
    kdf_params: json.kdfParams,
    salt: Buffer.from(json.salt, "base64"),
    wrapped_vmk: Buffer.from(json.wrappedVmk, "base64"),
    recovery_salt: json.recoverySalt
      ? Buffer.from(json.recoverySalt, "base64")
      : null,
    wrapped_vmk_recovery: json.wrappedVmkRecovery
      ? Buffer.from(json.wrappedVmkRecovery, "base64")
      : null,
  };
}

module.exports = {
  fail,
  DEFAULT_KDF,
  generateKey,
  deriveKek,
  wrapKey,
  unwrapKey,
  formatRecoveryKey,
  parseRecoveryKey,
  createConfig,
  unlockConfig,
  rewrapPassword,
  rewrapRecovery,
  encryptMeta,
  decryptMeta,
  serializeCfgFile,
  parseCfgFile,
};
