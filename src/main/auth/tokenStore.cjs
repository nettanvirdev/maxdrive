/**
 * Per-account OAuth tokens, encrypted at rest with Electron safeStorage
 * (Windows DPAPI). The blob is bound to the Windows user account, so a fresh
 * Windows install cannot decrypt it - that is expected and is what triggers
 * the reconnect flow rather than an error.
 */
const fs = require("fs");
const path = require("path");
const { scope } = require("../logger.cjs");
const { sealedPath, readSealed, writeSealed } = require("./sealedFile.cjs");

const log = scope("tokens");

let cache = null;

function file() {
  return sealedPath("tokens.bin");
}

function readAll() {
  if (cache) return cache;
  try {
    cache = readSealed(file()) || {};
  } catch (err) {
    // Starting empty is correct - a fresh Windows install genuinely cannot
    // decrypt the previous user's DPAPI blob. But the next set() would then
    // write an empty store over the top, destroying every account's tokens
    // including any that were merely unreadable right now. Move the original
    // aside first so a bad read can never become a permanent loss.
    const target = file();
    try {
      if (fs.existsSync(target)) {
        const aside = `${target}.unreadable-${Date.now()}`;
        fs.renameSync(target, aside);
        log.warn(
          `token store unreadable, kept as ${path.basename(aside)}: ${err.message}`,
        );
      } else {
        log.warn(`token store unreadable: ${err.message}`);
      }
    } catch (moveErr) {
      log.warn(`could not preserve unreadable token store: ${moveErr.message}`);
    }
    cache = {};
  }
  return cache;
}

function writeAll(next) {
  cache = next;
  writeSealed(file(), next);
}

function get(accountId) {
  return readAll()[accountId] || null;
}

/**
 * Google omits refresh_token on refresh responses; keeping the existing one is
 * mandatory or the account would need re-consent on every token expiry.
 */
function set(accountId, tokens) {
  const all = { ...readAll() };
  all[accountId] = { ...(all[accountId] || {}), ...tokens };
  writeAll(all);
}

function remove(accountId) {
  const all = { ...readAll() };
  delete all[accountId];
  writeAll(all);
}

function ids() {
  return Object.keys(readAll());
}

module.exports = { get, set, remove, ids };
