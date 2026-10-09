/**
 * Cross-account migration: move a file's bytes from one storage account to
 * another (Drive or S3, either direction) while its place in the virtual tree
 * stays fixed.
 *
 * Order matters: download → upload → md5 verify → only then delete the source.
 * Any failure before the final delete leaves the original untouched, so the
 * worst case is a duplicate on the target, never a lost file.
 */
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { nodes, accounts, activity } = require("../db/queries.cjs");
const { downloadToPath } = require("./downloader.cjs");
const core = require("./uploadCore.cjs");
const { providerFor } = require("../providers/index.cjs");
const accountService = require("../auth/accountService.cjs");
const { nodeId } = require("../sync/scanner.cjs");
const { scope } = require("../logger.cjs");

const log = scope("migrate");
const { fail } = core;

/** Queue worker: transfer.node_id is the source node, transfer.account_id the TARGET. */
async function migrate(transfer, { signal, onProgress, setSession }) {
  const node = nodes.byId(transfer.node_id);
  if (!node?.drive_file_id) throw fail("That file is no longer indexed.", "NO_NODE", false);
  if (node.is_google_doc) throw fail("Google Docs can't be moved between accounts.", "GOOGLE_DOC", false);

  const sourceAccountId = node.account_id;
  const targetAccountId = transfer.account_id;
  if (sourceAccountId === targetAccountId) throw fail("The file is already there.", "SAME_ACCOUNT", false);
  const target = accounts.byId(targetAccountId);
  if (!target) throw fail("The target account is gone.", "NO_ACCOUNT", false);
  const source = accounts.byId(sourceAccountId) || { id: sourceAccountId };

  const size = node.size ?? 0;
  const temp = path.join(os.tmpdir(), `maxdrive-migrate-${transfer.id}`);

  try {
    // 1. Download from the source account. Counts as the first half of progress.
    await downloadToPath(
      {
        accountId: sourceAccountId,
        driveFileId: node.drive_file_id,
        size,
        md5: null, // checked below so a bad copy keeps its MD5_MISMATCH code
        targetPath: temp,
      },
      { signal, onProgress: (received) => onProgress(Math.floor(received / 2)) },
    );

    // 2. Verify what we downloaded before uploading it anywhere.
    if (node.md5 && (await core.hashFile(temp)) !== node.md5) {
      throw fail("Downloaded copy failed verification.", "MD5_MISMATCH", true);
    }

    // 3. Upload to the target account; the session is persisted on the
    // transfer row so a retry resumes it.
    const tempSize = fs.statSync(temp).size;
    const uploaded = await providerFor(target).upload(target, {
      localPath: temp,
      size: tempSize,
      // A sealed file moves as the same ciphertext under a fresh random name.
      name: node.seal_meta ? `${randomUUID()}.mxv` : node.name,
      mime: node.seal_meta ? "application/octet-stream" : node.mime || null,
      session: { uri: transfer.session_uri, expiresAt: transfer.session_expires_at },
      signal,
      onProgress: (done) => onProgress(Math.floor(size / 2 + done / 2)),
      setSession,
    });
    if (!uploaded?.id) {
      setSession(null, null);
      throw fail("Upload ended without a completion response.", "INCOMPLETE", true);
    }

    // 4. Verify the uploaded copy against the same checksum.
    if (node.md5 && uploaded.md5Checksum && uploaded.md5Checksum !== node.md5) {
      setSession(null, null); // that session's file is about to be deleted
      await providerFor(target).remove(target, uploaded.id).catch(() => {});
      throw fail("Uploaded copy failed verification.", "MD5_MISMATCH", true);
    }

    // 5. Point the index row at the new physical location, THEN delete the source.
    const newId = nodeId(targetAccountId, uploaded.id);
    nodes.rekey(node.id, {
      id: newId,
      accountId: targetAccountId,
      fileId: uploaded.id,
      name: node.seal_meta ? undefined : uploaded.name,
    });

    // The move already succeeded; a leftover source copy is an annoyance, not a loss.
    await providerFor(source)
      .remove(source, node.drive_file_id)
      .catch((err) => log.warn(`source copy of ${node.name} could not be deleted (${err.message})`));

    activity.log(newId, targetAccountId, "migrated", `from ${accounts.byId(sourceAccountId)?.email}`);
    await accountService.refreshQuota(sourceAccountId, { force: true });
    await accountService.refreshQuota(targetAccountId, { force: true });
    onProgress(size);
    log.info(`migrated ${node.name}: ${sourceAccountId} → ${targetAccountId}`);
    return { nodeId: newId };
  } finally {
    fs.rmSync(temp, { force: true });
    fs.rmSync(`${temp}.maxdrivepart`, { force: true });
  }
}

module.exports = { migrate };
