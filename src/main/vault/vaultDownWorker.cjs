/**
 * Queue worker for kind 'vaultDown': pull a blob back from Drive and decrypt
 * it to where the user asked.
 *
 * Two stages, and the order matters: the ciphertext lands in a temp file first
 * (verified against the blob's md5 by the downloader), and only then is it
 * decrypted to the real destination. The decrypt writes through `.part` and
 * renames, so an interrupted restore never leaves a half-file wearing the
 * name of a real one.
 *
 * If another account also holds this blob, a failure here is recoverable: the
 * facade re-queues against the next copy.
 */
const fs = require("node:fs");
const path = require("node:path");
const { vaultCopies, vaultItems } = require("../db/queries.cjs");
const { downloadToPath } = require("../drive/downloader.cjs");
const { scope } = require("../logger.cjs");
const blob = require("./blobFormat.cjs");
const session = require("./session.cjs");
const storage = require("./storage.cjs");

const log = scope("vaultDown");

const { fail } = require("./crypto.cjs");

async function vaultDown(transfer, { signal, meta, onProgress }) {
  const item = vaultItems.byId(meta.itemId);
  if (!item) throw fail("That secure file is gone.", "VAULT_ITEM_GONE");

  // Decryption needs the master key. Locking mid-download is a normal thing to
  // do, so this fails clearly rather than corrupting anything.
  if (!session.isUnlocked())
    throw fail("Unlock the vault to finish this download.", "VAULT_LOCKED");
  const vmk = session.getVmk();

  const accountId = meta.accountId || transfer.account_id;
  const copy = vaultCopies.get(item.id, accountId);
  const driveFileId = meta.driveFileId || copy?.drive_file_id;
  if (!driveFileId) throw fail("No stored copy to download.", "VAULT_NO_COPY");

  const tempPath = path.join(storage.tempDir(), `dl-${item.id}.mxv`);
  const savePath = meta.savePath || transfer.local_path;

  try {
    await downloadToPath(
      {
        accountId,
        driveFileId,
        size: item.blob_size || 0,
        md5: item.blob_md5,
        targetPath: tempPath,
      },
      {
        signal,
        // The queue's progress bar tracks plaintext size; scale the ciphertext
        // byte count onto it so the bar doesn't overshoot.
        onProgress: (bytes) => {
          const scale = item.blob_size ? (item.size || 0) / item.blob_size : 1;
          onProgress(Math.min(item.size || bytes, Math.round(bytes * scale)));
        },
      }
    );

    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    await blob.decryptFileToPath({
      srcPath: tempPath,
      destPath: savePath,
      vmk,
      expectedSha256: item.plaintext_sha256,
      signal,
      onProgress: (done, total) =>
        require("./index.cjs").emitProgress({
          itemId: item.id,
          phase: "decrypt",
          pct: total ? Math.round((done / total) * 100) : 100,
        }),
    });
  } catch (err) {
    // A copy that fails to download or fails its integrity check is suspect;
    // mark it so the reconciler can replace it from a healthy one.
    if (err.code === "VAULT_TAMPERED" || err.code === "CHECKSUM_MISMATCH") {
      vaultCopies.setState(item.id, accountId, "failed", err.message);
    }
    storage.removeQuietly(tempPath);
    // Clear the spinner unconditionally: the queue's backoff can be minutes
    // long, and a frozen "Decrypting 40%" reads as a hang. A retry re-emits
    // progress as soon as it starts.
    require("./index.cjs").emitProgress({
      itemId: item.id,
      phase: "done",
      pct: 0,
    });
    throw err;
  }

  storage.removeQuietly(tempPath);
  log.info(`secure file ${item.id} restored to ${savePath}`);
  require("./index.cjs").emitProgress({ itemId: item.id, phase: "done", pct: 100 });
  return { bytes: item.size || 0 };
}

module.exports = { vaultDown };
