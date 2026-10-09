/**
 * Tidies up after a cancelled transfer.
 *
 * Cancelling used to be purely a state change, which left two things behind: a
 * half-written `.maxdrivepart` file on disk, and an open resumable session on
 * Drive that a later retry could accidentally resume into. Neither is reachable
 * once the row is cancelled, so both are ours to release.
 *
 * Everything here is best-effort - a cancel must never fail because cleanup did.
 */
const fs = require("node:fs");
const { accounts } = require("../db/queries.cjs");
const { providerFor } = require("../providers/index.cjs");
const { scope } = require("../logger.cjs");

const log = scope("cleanup");

/** Releases an unfinished upload (Drive session / S3 multipart) so its bytes aren't held. */
async function discardSession(accountId, sessionUri) {
  if (!sessionUri || !accountId) return;
  try {
    const account = accounts.byId(accountId) || { id: accountId };
    await providerFor(account).abortUpload(account, sessionUri);
  } catch (err) {
    // A dead session is exactly what we wanted anyway.
    log.warn(`could not discard upload session: ${err.message}`);
  }
}

/** Removes the partial file a download was streaming into. */
function discardPartial(localPath) {
  if (!localPath) return;
  try {
    fs.rmSync(`${localPath}.maxdrivepart`, { force: true });
  } catch (err) {
    log.warn(`could not remove partial file: ${err.message}`);
  }
}

async function discardTransfer(transfer) {
  if (!transfer) return;
  // Restores and vault downloads stream into a partial like downloads; backups
  // and vault uploads hold a resumable session like uploads. A vault upload's
  // local_path is a shared temp blob (several accounts may be uploading the
  // same one), so only the session is discarded here - the vault service owns
  // that file's lifetime.
  if (
    transfer.kind === "download" ||
    transfer.kind === "restore" ||
    transfer.kind === "vaultDown"
  ) {
    discardPartial(transfer.local_path);
    return;
  }
  await discardSession(transfer.account_id, transfer.session_uri);
}

module.exports = { discardTransfer, discardSession, discardPartial };
