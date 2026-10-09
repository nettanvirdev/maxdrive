/**
 * Where vault bytes live on this machine.
 *
 * Temp blobs are plaintext-free: a `.mxv` in vault-tmp is already encrypted,
 * so an interrupted upload leaves nothing readable behind. Decrypt targets are
 * the exception, and those are written where the user asked for them.
 */
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { scope } = require("../logger.cjs");

const log = scope("vault");

const dirs = {};

function ensure(name) {
  if (!dirs[name]) {
    dirs[name] = path.join(app.getPath("userData"), name);
    fs.mkdirSync(dirs[name], { recursive: true });
  }
  return dirs[name];
}

/** Encrypted blobs waiting to be uploaded, and blobs pulled down for decrypt. */
const tempDir = () => ensure("vault-tmp");
/** Encrypted thumbnails, one small file per item. */
const thumbDir = () => ensure("vault-thumbs");

const tempBlobPath = (blobUuid) => path.join(tempDir(), `${blobUuid}.mxv`);
const thumbPath = (itemId) => path.join(thumbDir(), `${itemId}.enc`);

function removeQuietly(target) {
  try {
    fs.rmSync(target, { force: true });
  } catch (err) {
    log.warn(`could not remove ${path.basename(target)}: ${err.message}`);
  }
}

/**
 * Startup housekeeping: half-written `.part` files are always garbage, and a
 * temp blob nobody is waiting on is dead weight from a crash.
 */
function sweepTemp(isWanted) {
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(tempDir());
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(tempDir(), entry);
    if (entry.endsWith(".part") || !isWanted(entry)) {
      removeQuietly(full);
      removed += 1;
    }
  }
  if (removed) log.info(`swept ${removed} stale vault temp file(s)`);
  return removed;
}

module.exports = {
  tempDir,
  tempBlobPath,
  thumbPath,
  removeQuietly,
  sweepTemp,
};
