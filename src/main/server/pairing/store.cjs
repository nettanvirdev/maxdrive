/**
 * Paired-device persistence: a thin layer over the `devices` queries that
 * wraps/unwraps the per-device secret and shapes rows for the UI. Secrets never
 * leave this module in plaintext except to the pairing/auth verifiers.
 */
const { devices } = require("../../db/queries.cjs");
const identity = require("../identity.cjs");

/** Persist a freshly paired device (or re-pair, which rotates its token). */
function save({ deviceId, name, platform, secret }) {
  devices.insert({
    id: deviceId,
    name,
    platform: platform || "other",
    secret_enc: identity.wrapSecret(secret),
  });
  return devices.byId(deviceId);
}

/** The per-device secret Buffer, or null if the device is unknown/unreadable. */
function getSecret(deviceId) {
  const row = devices.byId(deviceId);
  if (!row || row.revoked) return null;
  return identity.unwrapSecret(row.secret_enc);
}

function touch(deviceId) {
  devices.touch(deviceId);
}

function revoke(deviceId) {
  devices.revoke(deviceId);
}

function byId(deviceId) {
  return devices.byId(deviceId);
}

/** UI-safe list: never includes the secret blob. */
function list() {
  return devices.list().map((d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    createdAt: d.created_at,
    lastSeenAt: d.last_seen_at,
    revoked: Boolean(d.revoked),
  }));
}

module.exports = { save, getSecret, touch, revoke, byId, list };
