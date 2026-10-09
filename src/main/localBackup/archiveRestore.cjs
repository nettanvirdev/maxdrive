/**
 * Restore from an archive-mode backup: download every part of the newest
 * complete run, verify each sha256, stitch them back into one zip, and extract
 * the selection to the set's local root.
 *
 * Parts are downloaded through downloadToPath (range-resumable + verified);
 * temp disk peaks at the full archive size - random access is required for
 * extraction, so streaming through isn't an option.
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const yauzl = require("yauzl");
const { backupRuns, archiveParts } = require("../db/queries.cjs");
const { downloadToPath } = require("../drive/downloader.cjs");
const { hashFile, fail } = require("../drive/uploadCore.cjs");
const { matchesSelection, backupTmpDir } = require("./folders.cjs");
const { scope } = require("../logger.cjs");

const log = scope("archiveRestore");

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) =>
      err ? reject(err) : resolve(zip),
    );
  });
}

function extractEntry(zip, entry, targetPath) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const partial = `${targetPath}.maxdrivepart`;
      const sink = fs.createWriteStream(partial);
      stream.on("error", reject);
      sink.on("error", reject);
      sink.on("finish", () => {
        try {
          fs.rmSync(targetPath, { force: true });
          fs.renameSync(partial, targetPath);
          resolve();
        } catch (renameErr) {
          reject(renameErr);
        }
      });
      stream.pipe(sink);
    });
  });
}

async function restoreFromArchive({ set, paths = null, overwrite = false }) {
  const run = backupRuns.latestComplete(set.id);
  if (!run || run.mode !== "archive") {
    throw fail(
      "No completed archive backup exists for this folder.",
      "NO_ARCHIVE",
      false,
    );
  }
  const parts = archiveParts
    .forRun(run.id)
    .filter((p) => p.state === "uploaded");
  if (!parts.length) throw fail("The archive's parts are missing.", "NO_PARTS", false);

  const dir = backupTmpDir();
  const zipPath = path.join(dir, `restore-${run.id.slice(0, 8)}.zip`);
  const partPaths = [];

  try {
    // 1. Fetch and verify every part.
    for (const part of parts) {
      const partPath = path.join(
        dir,
        `restore-${run.id.slice(0, 8)}-part-${part.part_index}`,
      );
      await downloadToPath(
        {
          accountId: part.account_id,
          driveFileId: part.drive_file_id,
          size: part.size,
          md5: null, // integrity comes from our own sha256 below
          targetPath: partPath,
        },
        { signal: new AbortController().signal, onProgress: () => {} },
      );
      const digest = await hashFile(partPath, "sha256");
      if (part.sha256 && digest !== part.sha256) {
        throw fail(
          `Part ${part.part_index} failed its checksum.`,
          "PART_CORRUPT",
          false,
        );
      }
      partPaths.push(partPath);
    }

    // 2. Stitch the parts back into one zip.
    const out = fs.createWriteStream(zipPath);
    for (const partPath of partPaths) {
      await new Promise((resolve, reject) => {
        const src = fs.createReadStream(partPath);
        src.on("error", reject);
        src.on("end", resolve);
        src.pipe(out, { end: false });
      });
    }
    await new Promise((resolve, reject) => {
      out.on("close", resolve);
      out.on("error", reject);
      out.end();
    });
    for (const partPath of partPaths) fs.rmSync(partPath, { force: true });

    // 3. Extract the selection.
    let restored = 0;
    let skipped = 0;
    const zip = await openZip(zipPath);
    await new Promise((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        const relPath = entry.fileName;
        const isDir = /\/$/.test(relPath);
        if (isDir || !matchesSelection(relPath, paths)) {
          zip.readEntry();
          return;
        }
        const target = path.join(set.local_root, relPath);
        if (!overwrite && fs.existsSync(target)) {
          skipped += 1;
          zip.readEntry();
          return;
        }
        extractEntry(zip, entry, target)
          .then(() => {
            restored += 1;
            zip.readEntry();
          })
          .catch(reject);
      });
      zip.readEntry();
    });
    zip.close();

    log.info(
      `archive restore for ${set.name}: ${restored} restored, ${skipped} present`,
    );
    return { queued: 0, restored, skipped, untrashed: 0, fromRun: run.id };
  } finally {
    fs.rmSync(zipPath, { force: true });
    for (const partPath of partPaths) fs.rmSync(partPath, { force: true });
    await fsp.rm(`${zipPath}.maxdrivepart`, { force: true }).catch(() => {});
  }
}

module.exports = { restoreFromArchive };
