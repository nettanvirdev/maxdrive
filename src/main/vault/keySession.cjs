/**
 * An unlocked-key session: the only place a master key exists in the clear,
 * and only in main-process memory. The renderer never receives it - it asks
 * for decrypted *results*, never the key.
 *
 * Two instances exist: the Secure vault's (session.cjs, holds the VMK) and
 * vault mode's (sealSession.cjs, holds the X25519 private key). Each has its
 * own lock state, idle auto-lock and brute-force counter.
 *
 * Locking zero-fills the buffer rather than dropping the reference, so the key
 * doesn't linger in a heap page waiting to be garbage collected (or written
 * into a crash dump).
 *
 * Brute-force defence: failures are counted and delayed, and the counter lives
 * in the settings table, so quitting the app doesn't reset the penalty.
 */
const { settings: settingsQ } = require("../db/queries.cjs");
const { scope } = require("../logger.cjs");
const { fail } = require("./crypto.cjs");

const FREE_ATTEMPTS = 5;
const MAX_DELAY_MS = 5 * 60 * 1000;

/** Delay after n failures: 2s, 4s, 8s … capped at five minutes. */
function penaltyFor(failures) {
  if (failures <= FREE_ATTEMPTS) return 0;
  return Math.min(MAX_DELAY_MS, 2 ** (failures - FREE_ATTEMPTS) * 1000);
}

/**
 * @param {object} o
 * @param {string} o.name           log scope and messages ("vault", "vault mode")
 * @param {string} o.settingsPrefix prefix for the persisted failure counters
 * @param {string} o.lockedCode     error code when the key is needed but locked
 * @param {(configRow, secret, {recovery}) => {key, usedRecovery}} o.open
 * @param {number} o.defaultAutolockMinutes
 */
function createKeySession({ name, settingsPrefix, lockedCode, open, defaultAutolockMinutes = 10 }) {
  const log = scope(settingsPrefix);
  const FAILURE_KEY = `${settingsPrefix}UnlockFailures`;
  const RETRY_KEY = `${settingsPrefix}RetryAfter`;
  const state = {
    key: null,
    unlockedAt: null,
    idleTimer: null,
    autolockMinutes: defaultAutolockMinutes,
    notify: () => {},
  };

  function failureState() {
    const failures = Number(settingsQ.get(FAILURE_KEY, 0)) || 0;
    const retryAfter = Number(settingsQ.get(RETRY_KEY, 0)) || 0;
    return { failures, retryAfter, retryAfterMs: Math.max(0, retryAfter - Date.now()) };
  }

  function recordFailure() {
    const failures = failureState().failures + 1;
    settingsQ.set(FAILURE_KEY, failures);
    const penalty = penaltyFor(failures);
    if (penalty > 0) settingsQ.set(RETRY_KEY, Date.now() + penalty);
    return penalty;
  }

  function clearFailures() {
    settingsQ.set(FAILURE_KEY, 0);
    settingsQ.set(RETRY_KEY, 0);
  }

  function clearTimer() {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }

  /** Any activity postpones the auto-lock. 0 minutes = never idle-lock. */
  function touch() {
    clearTimer();
    if (!state.key || !state.autolockMinutes) return;
    state.idleTimer = setTimeout(() => {
      log.info(`${name} auto-locked after idle timeout`);
      lock("idle");
    }, state.autolockMinutes * 60 * 1000);
    state.idleTimer.unref?.();
  }

  function lock(reason = "user") {
    clearTimer();
    if (state.key) {
      state.key.fill(0);
      state.key = null;
      state.unlockedAt = null;
      state.notify({ type: "lockChanged", unlocked: false, reason });
    }
  }

  /** Take ownership of a key that was verified elsewhere (setup/recovery). */
  function adopt(key) {
    if (state.key && state.key !== key) state.key.fill(0);
    state.key = key;
    state.unlockedAt = Date.now();
    touch();
    state.notify({ type: "lockChanged", unlocked: true });
  }

  return {
    setNotifier(fn) {
      state.notify = fn || (() => {});
    },
    setAutolockMinutes(minutes) {
      state.autolockMinutes = Number(minutes) > 0 ? Number(minutes) : 0;
      if (state.key) touch();
    },
    /**
     * Verify a secret against the stored config and hold the resulting key.
     * `secret` is the password, or the printed recovery key when `recovery`.
     */
    unlock(configRow, secret, { recovery = false } = {}) {
      const { retryAfterMs } = failureState();
      if (retryAfterMs > 0) {
        const err = fail(`Too many attempts. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`, "VAULT_RATE_LIMITED");
        err.retryAfterMs = retryAfterMs;
        throw err;
      }
      let result;
      try {
        result = open(configRow, secret, { recovery });
      } catch (err) {
        const penalty = recordFailure();
        if (penalty > 0) err.retryAfterMs = penalty;
        throw err;
      }
      clearFailures();
      adopt(result.key);
      return { usedRecovery: result.usedRecovery };
    },
    adopt,
    lock,
    touch,
    isUnlocked: () => Boolean(state.key),
    getKey() {
      if (!state.key) throw fail(`${name[0].toUpperCase()}${name.slice(1)} is locked.`, lockedCode);
      return state.key;
    },
    status() {
      const { retryAfterMs } = failureState();
      return {
        unlocked: Boolean(state.key),
        unlockedAt: state.unlockedAt,
        retryAfterMs,
        autolockMinutes: state.autolockMinutes,
      };
    },
    DEFAULT_AUTOLOCK_MIN: defaultAutolockMinutes,
  };
}

module.exports = { createKeySession };
