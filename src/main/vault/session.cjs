/**
 * The Secure vault's unlocked session (holds the VMK). Mechanics live in
 * keySession.cjs; this instance keeps the vault's original API and settings
 * keys (vaultUnlockFailures / vaultRetryAfter).
 */
const { createKeySession } = require("./keySession.cjs");
const crypto = require("./crypto.cjs");

const session = createKeySession({
  name: "the vault",
  settingsPrefix: "vault",
  lockedCode: "VAULT_LOCKED",
  open: (configRow, secret, opts) => {
    const { vmk, usedRecovery } = crypto.unlockConfig(configRow, secret, opts);
    return { key: vmk, usedRecovery };
  },
});

module.exports = { ...session, getVmk: session.getKey };
