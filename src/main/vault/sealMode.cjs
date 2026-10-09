/**
 * Vault mode: when enabled, every NEW upload and folder is sealed to the
 * vault-mode public key (vault/seal.cjs) - so encryption needs no unlock and
 * works from drag-drop, tray, LAN and MCP alike. The private key, held by this
 * module's own key session, is only needed to see names and open content.
 *
 * Sealed rows live in the normal `nodes` tree with a placeholder name and the
 * real {name, mime, size} sealed in `nodes.seal_meta`. Names are revealed here,
 * in memory, while unlocked - never written back to the DB, so neither the WAL
 * nor the index snapshot uploaded to Drive ever holds them.
 *
 * Independent of the Secure vault: own password, recovery key, auto-lock and
 * brute-force counter (settings prefix "seal").
 */
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { sealConfig } = require("../db/queries.cjs");
const { get: db } = require("../db/database.cjs");
const settingsStore = require("../settings.cjs");
const seal = require("./seal.cjs");
const { fail } = require("./crypto.cjs");
const { createKeySession } = require("./keySession.cjs");
const { scope } = require("../logger.cjs");

const log = scope("seal");

const PLACEHOLDER = { file: "Encrypted file", folder: "Encrypted folder" };
const MIN_PASSWORD = 8;

const session = createKeySession({
  name: "vault mode",
  settingsPrefix: "seal",
  lockedCode: "SEAL_LOCKED",
  open: seal.unlockSealConfig,
});

/** Revealed metadata, keyed by the box's unique ephemeral key. Cleared on lock. */
const revealed = new Map();

let notify = () => {};
function setNotifier(fn) {
  notify = fn || (() => {});
}
session.setNotifier((event) => {
  if (!event.unlocked) revealed.clear();
  notify(event);
});

const configured = () => Boolean(sealConfig.get());
const enabled = () => configured() && Boolean(settingsStore.get("vaultMode"));

function publicKey() {
  const config = sealConfig.get();
  if (!config) throw fail("Vault mode isn't set up yet.", "SEAL_NOT_SET_UP");
  return config.public_key;
}

function status() {
  const s = session.status();
  return {
    configured: configured(),
    enabled: enabled(),
    unlocked: s.unlocked,
    retryAfterMs: s.retryAfterMs,
    autolockMinutes: s.autolockMinutes,
  };
}

function checkPassword(password) {
  if (String(password || "").length < MIN_PASSWORD) {
    throw fail(`Use at least ${MIN_PASSWORD} characters.`, "WEAK_PASSWORD");
  }
}

/** Creates the key; the recovery key is returned this once and never stored. */
function setup(password) {
  if (configured()) throw fail("Vault mode is already set up.", "SEAL_EXISTS");
  checkPassword(password);
  const { configRow, privateKey, recoveryKey } = seal.createSealConfig(password);
  sealConfig.upsert(configRow);
  session.adopt(privateKey);
  log.info("vault mode set up");
  notify({ type: "changed" });
  return { recoveryKey };
}

function unlock(secret, { recovery = false } = {}) {
  const config = sealConfig.get();
  if (!config) throw fail("Vault mode isn't set up yet.", "SEAL_NOT_SET_UP");
  session.unlock(config, secret, { recovery });
  return status();
}

function lock() {
  session.lock("user");
  return status();
}

/** Verifies the current password through the rate-limited unlock path. */
function changePassword(current, next) {
  checkPassword(next);
  const config = sealConfig.get();
  if (!config) throw fail("Vault mode isn't set up yet.", "SEAL_NOT_SET_UP");
  session.unlock(config, current);
  sealConfig.upsert(seal.rewrapSealPassword(config, session.getKey(), next));
  log.info("vault mode password changed");
  notify({ type: "changed" });
  return status();
}

function setEnabled(on) {
  if (on && !configured()) throw fail("Set up vault mode first.", "SEAL_NOT_SET_UP");
  settingsStore.set({ vaultMode: Boolean(on) });
  log.info(`vault mode ${on ? "enabled" : "disabled"}`);
  notify({ type: "changed" });
  return status();
}

function setAutolock(minutes) {
  const value = Math.max(0, Number(minutes) || 0);
  settingsStore.set({ sealAutolockMinutes: value });
  session.setAutolockMinutes(value);
  notify({ type: "changed" });
  return status();
}

/* ------------------------------------------------------------ content */

/** Seals {name, mime, size} with the public key - no unlock needed. */
const sealMeta = (meta) => seal.sealJson(publicKey(), meta);

const placeholder = (isFolder) => (isFolder ? PLACEHOLDER.folder : PLACEHOLDER.file);

function metaOf(sealMetaBlob) {
  const box = Buffer.from(sealMetaBlob);
  const id = box.subarray(0, 32).toString("hex");
  let meta = revealed.get(id);
  if (!meta) {
    meta = seal.openJson(session.getKey(), box);
    revealed.set(id, meta);
  }
  return meta;
}

/** The real metadata of a sealed node; throws SEAL_LOCKED while locked. */
function realMeta(node) {
  session.touch();
  return metaOf(node.seal_meta);
}

/**
 * Output filter for node rows: strips the sealed blob and, while unlocked,
 * restores the real name/mime/size. Rows without `seal_meta` pass untouched.
 */
function revealRow(row) {
  if (!row || typeof row !== "object" || !("seal_meta" in row)) return row;
  const { seal_meta: blob, ...rest } = row;
  if (!blob) return { ...rest, sealed: false, sealLocked: false };
  if (!session.isUnlocked()) return { ...rest, sealed: true, sealLocked: true };
  try {
    const meta = metaOf(blob);
    return {
      ...rest,
      name: meta.name ?? rest.name,
      mime: meta.mime ?? rest.mime,
      size: meta.size ?? rest.size,
      sealed: true,
      sealLocked: false,
    };
  } catch (err) {
    log.warn(`could not reveal ${row.id}: ${err.message}`);
    return { ...rest, sealed: true, sealLocked: true };
  }
}

/** Walks an IPC/API result (arrays, plain objects one level deep) revealing node rows. */
function reveal(value) {
  if (Array.isArray(value)) return value.map(reveal);
  if (!value || typeof value !== "object" || value.constructor !== Object) return value;
  if ("seal_meta" in value) return revealRow(value);
  let changed = false;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = Array.isArray(v) || (v && v.constructor === Object && "seal_meta" in v) ? reveal(v) : v;
    if (out[k] !== v) changed = true;
  }
  return changed ? out : value;
}

/** Search over sealed names - only possible while unlocked, and only in memory. */
function searchSealed(query, nodeSelect) {
  const q = String(query || "").trim().toLowerCase();
  if (!q || !session.isUnlocked()) return [];
  const rows = db()
    .prepare(`${nodeSelect} WHERE n.seal_meta IS NOT NULL AND n.trashed = 0`)
    .all();
  return rows.map(revealRow).filter((r) => !r.sealLocked && r.name.toLowerCase().includes(q));
}

/* ------------------------------------------------------------ temp files */

/** Ciphertext-only staging for sealed uploads/downloads. */
function tempDir() {
  const dir = path.join(app.getPath("userData"), "seal-tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function start() {
  session.setAutolockMinutes(settingsStore.get("sealAutolockMinutes") ?? 10);
}

function stop() {
  session.lock("quit");
}

module.exports = {
  PLACEHOLDER,
  setNotifier,
  status,
  setup,
  unlock,
  lock,
  changePassword,
  setEnabled,
  setAutolock,
  enabled,
  configured,
  publicKey,
  sealMeta,
  placeholder,
  realMeta,
  privateKey: () => session.getKey(),
  isUnlocked: () => session.isUnlocked(),
  reveal,
  searchSealed,
  tempDir,
  start,
  stop,
};
