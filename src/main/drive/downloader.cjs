/**
 * Range-resumable download worker.
 *
 * Bytes land in a `.maxdrivepart` file and are renamed only on success, so an
 * interrupted download can never be mistaken for a complete one.
 *
 * The core (`downloadToPath`) is keyed by {accountId, driveFileId} rather than
 * an index row, so the local-backup restore path can reuse it for files that
 * deliberately have no nodes entry.
 */
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const { nodes, activity, accounts } = require("../db/queries.cjs");
const { hashFile, fail } = require("./uploadCore.cjs");
const { providerFor } = require("../providers/index.cjs");
const sealMode = require("../vault/sealMode.cjs");
const blob = require("../vault/blobFormat.cjs");
const { scope } = require("../logger.cjs");

const log = scope("download");

/**
 * Refuses to promote a partial file to the real filename unless it is provably
 * the whole thing. A stream can end early without erroring, and Drive's md5 is
 * the only way to catch bytes that arrived corrupted rather than missing.
 *
 * Both failures delete the partial and are retryable, so the queue restarts the
 * download cleanly instead of leaving a plausible-looking broken file behind.
 */
async function verify(partial, total, md5) {
  const actual = fs.statSync(partial).size;
  if (total && actual !== total) {
    fs.rmSync(partial, { force: true });
    throw fail(
      `Download was cut short (${actual} of ${total} bytes); retrying.`,
      "INCOMPLETE",
    );
  }

  if (!md5) return; // Google-native files and shortcuts have no checksum.

  if ((await hashFile(partial)) !== md5) {
    fs.rmSync(partial, { force: true });
    throw fail(
      "The downloaded copy did not match the original; retrying.",
      "CHECKSUM_MISMATCH",
    );
  }
}

/**
 * Download one Drive file to an exact local path, resumable and verified.
 * Needs only {accountId, driveFileId, size, md5} - no index row.
 */
async function downloadToPath(
  { accountId, driveFileId, size = 0, md5 = null, targetPath },
  { signal, onProgress = () => {} } = {},
) {
  const target = targetPath;
  const partial = `${target}.maxdrivepart`;
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let done = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  const total = size || 0;
  if (total && done > total) {
    // A partial larger than the file means the remote copy changed underneath us.
    fs.rmSync(partial, { force: true });
    done = 0;
  }

  // Restores after a wipe can run before the account row exists again.
  const account = accounts.byId(accountId) || { id: accountId };
  const res = await providerFor(account).openRange(
    account,
    driveFileId,
    done ? `bytes=${done}-` : null,
    signal,
  );

  if (res.status === 416) {
    // Range beyond the end: we already hold every byte - provided a partial
    // actually exists. Renaming blind here threw ENOENT.
    if (!fs.existsSync(partial)) {
      if (fs.existsSync(target)) {
        onProgress(total);
        return { path: target, bytes: total };
      }
      throw fail("The download state was lost; starting over.", "NO_PARTIAL");
    }
    await verify(partial, total, md5);
    fs.renameSync(partial, target);
    onProgress(total);
    return { path: target, bytes: total };
  }
  if (!res.ok)
    throw fail(`Download failed (${res.status}).`, `HTTP_${res.status}`);
  // A server that ignores Range restarts the file, so the partial must go.
  if (done && res.status !== 206) {
    fs.rmSync(partial, { force: true });
    done = 0;
  }

  let received = done;
  const sink = fs.createWriteStream(partial, { flags: done ? "a" : "w" });
  const source = Readable.fromWeb(res.body);
  source.on("data", (chunk) => {
    received += chunk.length;
    onProgress(received);
  });

  await pipeline(source, sink);

  // Flush to disk before the rename, so a power cut cannot leave a file with
  // the final name and unwritten contents.
  const fd = fs.openSync(partial, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  await verify(partial, total, md5);
  fs.renameSync(partial, target);
  onProgress(received);

  return { path: target, bytes: received };
}

/**
 * Vault mode: fetch the ciphertext (verified against the ciphertext md5) into
 * seal-tmp, then decrypt straight to the destination. Plaintext only ever
 * lands at the file the user asked for.
 */
async function downloadSealed(transfer, node, { signal, onProgress }) {
  if (!sealMode.isUnlocked()) {
    throw fail("Unlock vault mode to download this file.", "SEAL_LOCKED", false);
  }
  const cipherPath = path.join(sealMode.tempDir(), `dl-${transfer.id}.mxv`);
  try {
    await downloadToPath(
      {
        accountId: node.account_id,
        driveFileId: node.drive_file_id,
        size: node.size || 0,
        md5: node.md5,
        targetPath: cipherPath,
      },
      { signal, onProgress: (n) => onProgress(Math.floor(n * 0.9)) },
    );
    const result = await blob.decryptFileToPath({
      srcPath: cipherPath,
      destPath: transfer.local_path,
      sealKey: sealMode.privateKey(),
      signal,
    });
    onProgress(transfer.size || result.bytes);
    activity.log(node.id, node.account_id, "downloaded");
    log.info(`downloaded a sealed file → ${result.path}`);
    return { path: result.path, bytes: result.bytes };
  } finally {
    fs.rmSync(cipherPath, { force: true });
    fs.rmSync(`${cipherPath}.maxdrivepart`, { force: true });
  }
}

async function download(transfer, { signal, onProgress }) {
  const node = nodes.byId(transfer.node_id);
  if (!node?.drive_file_id)
    throw fail("That file is no longer indexed.", "NO_NODE", false);
  if (node.is_google_doc) {
    throw fail(
      "Google Docs open in the browser rather than downloading.",
      "GOOGLE_DOC",
      false,
    );
  }

  if (node.seal_meta) return downloadSealed(transfer, node, { signal, onProgress });

  const result = await downloadToPath(
    {
      accountId: node.account_id,
      driveFileId: node.drive_file_id,
      size: transfer.size || node.size || 0,
      md5: node.md5,
      targetPath: transfer.local_path,
    },
    { signal, onProgress },
  );

  activity.log(node.id, node.account_id, "downloaded");
  log.info(`downloaded ${node.name} → ${result.path}`);
  return result;
}

module.exports = { download, downloadToPath };
