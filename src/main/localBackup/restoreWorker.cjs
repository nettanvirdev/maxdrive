/**
 * Queue worker for kind 'restore': one cloud backup file → its original local
 * path. A thin shell over the downloader core - the transfer's meta carries
 * everything, no nodes row involved.
 */
const fs = require("node:fs");
const { downloadToPath } = require("../drive/downloader.cjs");
const { scope } = require("../logger.cjs");

const log = scope("restoreWorker");

const { fail } = require("../drive/uploadCore.cjs");
async function restore(transfer, { signal, meta, onProgress }) {
  if (!meta.accountId || !meta.driveFileId) {
    throw fail("Restore job is missing its source.", "BAD_META", false);
  }

  const target = transfer.local_path;
  const exists = fs.existsSync(target);
  if (exists && !meta.overwrite) {
    // The default "missing only" mode re-checks at execution time: the file
    // may have reappeared (or been restored by hand) since it was queued.
    log.info(`${target} already exists; skipping restore`);
    return { bytes: 0 };
  }

  // Overwrite mode downloads beside the original and swaps only after the
  // verified copy fully exists - a failed download must never cost the local
  // file it was supposed to replace.
  const downloadTarget = exists ? `${target}.maxdriverestore` : target;
  const result = await downloadToPath(
    {
      accountId: meta.accountId,
      driveFileId: meta.driveFileId,
      size: transfer.size || 0,
      md5: meta.md5 || null,
      targetPath: downloadTarget,
    },
    { signal, onProgress },
  );
  if (downloadTarget !== target) {
    fs.rmSync(target, { force: true }); // Windows refuses rename-over-existing
    fs.renameSync(downloadTarget, target);
  }
  log.info(`restored ${target}`);
  return result;
}

module.exports = { restore };
