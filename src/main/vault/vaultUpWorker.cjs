/**
 * Queue worker for kind 'vaultUp': one already-encrypted blob → one account's
 * hidden `.vault` folder.
 *
 * Everything this worker touches is ciphertext. It never needs the master key,
 * which is why replication and resumed uploads keep working while the vault is
 * locked. The blob's name in Drive is its uuid, so nothing about the original
 * file - not even its extension - is visible there.
 */
const fs = require("node:fs");
const { vaultCopies, vaultItems } = require("../db/queries.cjs");
const accountService = require("../auth/accountService.cjs");
const drive = require("../drive/driveApi.cjs");
const core = require("../drive/uploadCore.cjs");
const { scope } = require("../logger.cjs");

const log = scope("vaultUp");
const { fail } = core;

async function vaultUp(transfer, { signal, meta, onProgress, setSession }) {
  const item = vaultItems.byId(meta.itemId);
  if (!item) throw fail("That secure file is gone.", "VAULT_ITEM_GONE", false);

  const accountId = transfer.account_id || meta.accountId;
  if (!accountId)
    throw fail("No account for this secure upload.", "VAULT_NO_ACCOUNT", false);

  if (!transfer.local_path || !fs.existsSync(transfer.local_path)) {
    // The encrypted temp is gone (crash, or cleaned while queued). Another
    // copy can rebuild it later; this transfer has nothing to send.
    vaultCopies.setState(
      item.id,
      accountId,
      "failed",
      "encrypted copy was lost",
    );
    require("./index.cjs").onCopyComplete(item.id);
    throw fail(
      "The encrypted copy was lost before upload.",
      "VAULT_BLOB_MISSING",
      false,
    );
  }

  const size = fs.statSync(transfer.local_path).size;
  vaultCopies.upsert({
    item_id: item.id,
    account_id: accountId,
    state: "uploading",
  });

  const folderId = await accountService.ensureVaultFolder(accountId);
  const name = `${item.blob_uuid}.mxv`;

  let uploaded;
  try {
    const result = await core.uploadResumable({
      accountId,
      localPath: transfer.local_path,
      size,
      createSession: () =>
        core.openSession(accountId, {
          url: core.createFileSessionUrl(),
          method: "POST",
          size,
          // Declared as opaque bytes so Drive doesn't try to interpret,
          // transcode or preview them.
          mimeType: "application/octet-stream",
          body: { name, parents: [folderId] },
        }),
      session: {
        uri: transfer.session_uri,
        expiresAt: transfer.session_expires_at,
      },
      onSessionInvalid: () => setSession(null, null),
      signal,
      onProgress: (bytes) => {
        onProgress(bytes);
        require("./index.cjs").emitProgress({
          itemId: item.id,
          phase: "upload",
          pct: size ? Math.round((bytes / size) * 100) : 100,
        });
      },
      setSession,
    });
    uploaded = result.file;
  } catch (err) {
    vaultCopies.setState(
      item.id,
      accountId,
      err.retryable === false ? "failed" : "pending",
      err.message,
    );
    // Only a give-up is terminal; a retryable failure leaves the copy pending
    // and the row should keep showing progress until the queue is done with it.
    if (err.retryable === false) require("./index.cjs").onCopyFailed(item.id);
    throw err;
  }

  // Drive occasionally finalizes without echoing metadata; the uuid name makes
  // it unambiguous to find again.
  if (!uploaded?.id) {
    const children = await drive.listChildren(
      accountId,
      folderId,
      "md5Checksum",
    );
    uploaded = children.find((f) => f.name === name) || null;
  }
  if (!uploaded?.id) {
    vaultCopies.setState(item.id, accountId, "pending", "upload not confirmed");
    throw fail(
      "Drive did not confirm the secure upload.",
      "NO_CONFIRMATION",
      true,
    );
  }

  // Prove the bytes arrived intact before this copy is allowed to count as one
  // the vault can restore from.
  if (
    uploaded.md5Checksum &&
    item.blob_md5 &&
    uploaded.md5Checksum !== item.blob_md5
  ) {
    await drive.deleteFile(accountId, uploaded.id).catch(() => {});
    vaultCopies.setState(item.id, accountId, "pending", "checksum mismatch");
    throw fail(
      "The secure upload arrived corrupted; will retry.",
      "CHECKSUM_MISMATCH",
      true,
    );
  }

  vaultCopies.upsert({
    item_id: item.id,
    account_id: accountId,
    drive_file_id: uploaded.id,
    state: "ok",
    error: null,
  });
  accountService.refreshQuota(accountId, { force: true }).catch(() => {});
  log.info(`secure blob ${item.blob_uuid} stored on ${accountId}`);

  require("./index.cjs").onCopyComplete(item.id);
  return { bytes: size };
}

module.exports = { vaultUp };
