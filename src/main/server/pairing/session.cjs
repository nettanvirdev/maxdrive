/**
 * The pairing handshake state machine (main-process, stateful).
 *
 * Desktop-initiated: the user opens "Add device", which calls begin() to mint a
 * fresh 6-digit code + salt shown on screen (and encoded in a QR). A client
 * derives secret = PBKDF2(code, salt) and proves it via submitProof(); the code
 * itself never crosses the network. On a correct proof we raise an approval
 * request to the desktop and hold the client's request open until the user
 * clicks Allow/Deny (resolve()).
 *
 * Hardening mirrors the reference server: a single active pairing session, a
 * 3-strike / 60 s lockout, and a 3-minute code lifetime.
 *
 * Only crypto (pure) and node built-ins are imported at the top so the state
 * machine unit-tests without Electron; persistence/identity are lazy-required
 * on the approval path.
 */
const os = require("node:os");
const crypto = require("./crypto.cjs");

const APPROVAL_TIMEOUT_MS = 90_000; // how long a client waits for Allow/Deny

let notify = () => {};

/** @type {{code:string, salt:Buffer, expiresAt:number, timer:NodeJS.Timeout}|null} */
let active = null;
let failedAttempts = 0;
let lockedUntil = 0;
/** deviceId -> pending approval. Single client at a time. */
const pending = new Map();

function setNotifier(fn) {
  notify = typeof fn === "function" ? fn : () => {};
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  e.retryable = false;
  return e;
}

function clearActive() {
  if (active?.timer) clearTimeout(active.timer);
  active = null;
}

/** Start (or restart) a pairing session. Returns what the desktop must show. */
function begin({ ttlMs = crypto.CODE_TTL_MS } = {}) {
  clearActive();
  const code = crypto.generateCode();
  const salt = crypto.generateSalt();
  const expiresAt = Date.now() + ttlMs;
  active = {
    code,
    salt,
    expiresAt,
    timer: setTimeout(() => {
      clearActive();
      notify({ type: "pairingState", active: false, reason: "expired" });
    }, ttlMs),
  };
  notify({ type: "pairingState", active: true, expiresAt });
  return { code, salt: salt.toString("base64"), expiresAt };
}

/** User closed the pairing dialog or cancelled. */
function cancel() {
  clearActive();
  notify({ type: "pairingState", active: false, reason: "cancelled" });
}

function isLocked() {
  return Date.now() < lockedUntil;
}

/** The challenge a client needs before it can compute a proof. */
function getChallenge() {
  if (isLocked()) throw err("PAIR_LOCKED", "Too many attempts. Try again shortly.");
  if (!active || Date.now() >= active.expiresAt)
    throw err("PAIR_NO_SESSION", "No pairing in progress.");
  const identity = require("../identity.cjs");
  return {
    salt: active.salt.toString("base64"),
    serverId: identity.serverId(),
    serverName: os.hostname(),
  };
}

/**
 * Verify a client's proof and, if valid, raise an approval prompt and resolve
 * once the user decides. Resolves to `{ deviceId, name, platform }` on approval;
 * rejects with a coded Error otherwise.
 */
function submitProof({ deviceId, name, platform, proof, remoteIp }) {
  if (isLocked()) throw err("PAIR_LOCKED", "Too many attempts. Try again shortly.");
  if (!active || Date.now() >= active.expiresAt)
    throw err("PAIR_NO_SESSION", "No pairing in progress.");
  if (!deviceId || !name) throw err("PAIR_PROTOCOL", "deviceId and name are required.");

  const expectedSecret = crypto.deriveSecret(active.code, active.salt);
  const proofBuf = Buffer.from(String(proof || ""), "base64");
  if (!crypto.verifyProof(expectedSecret, active.salt, proofBuf)) {
    failedAttempts += 1;
    if (failedAttempts >= crypto.MAX_PAIRING_ATTEMPTS) {
      lockedUntil = Date.now() + crypto.PAIRING_LOCKOUT_MS;
      failedAttempts = 0;
      clearActive();
      notify({ type: "pairingState", active: false, reason: "locked" });
    }
    throw err("PAIR_FAILED", "Wrong pairing code.");
  }

  // Correct proof: consume the code (no other device may reuse it) and wait for
  // the user to approve this specific device.
  failedAttempts = 0;
  const secret = expectedSecret;
  const device = { deviceId, name, platform: platform || "other", remoteIp };
  clearActive();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(deviceId);
      reject(err("PAIR_TIMEOUT", "Pairing was not approved in time."));
    }, APPROVAL_TIMEOUT_MS);

    pending.set(deviceId, { resolve, reject, timer, device, secret });
    // Flatten device fields to the top level so the renderer (and any other
    // consumer) reads deviceId/name/platform/remoteIp consistently, matching the
    // shape of the pairingState events.
    notify({ type: "pairingRequest", ...device });
  });
}

/**
 * Called from IPC when the user clicks Allow/Deny. On allow, persists the device
 * (secret DPAPI-wrapped) and unblocks the waiting client request.
 * @returns {boolean} whether a matching pending request was found.
 */
function resolve(deviceId, allow) {
  const p = pending.get(deviceId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(deviceId);

  if (!allow) {
    p.reject(err("PAIR_DENIED", "Pairing was declined."));
    return true;
  }
  const store = require("./store.cjs");
  const saved = store.save({
    deviceId,
    name: p.device.name,
    platform: p.device.platform,
    secret: p.secret,
  });
  p.resolve({
    deviceId,
    name: saved.name,
    platform: saved.platform,
    tokenVersion: saved.token_version,
  });
  return true;
}

/** Deny every waiting request (used when the server stops). */
function reset() {
  clearActive();
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(err("PAIR_CANCELLED", "Pairing cancelled."));
  }
  pending.clear();
  failedAttempts = 0;
  lockedUntil = 0;
}

function status() {
  return {
    active: Boolean(active),
    expiresAt: active?.expiresAt ?? null,
    locked: isLocked(),
    lockedUntil: isLocked() ? lockedUntil : null,
    pending: [...pending.values()].map((p) => p.device),
  };
}

module.exports = {
  setNotifier,
  begin,
  cancel,
  getChallenge,
  submitProof,
  resolve,
  reset,
  status,
  isLocked,
};
