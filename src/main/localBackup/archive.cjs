/**
 * Archive-mode backup: one streaming zip per run, byte-split into parts sized
 * to fit the accounts' free slots, so a backup larger than any single account
 * spans several. A JSON manifest records parts and contents.
 *
 * Temp-disk discipline: the zip stream is written into ONE part file at a
 * time; when a part fills, the stream backpressure-stalls while that part
 * uploads, then the temp file is deleted and the next part begins. Peak temp
 * usage is a single part, never the whole archive.
 *
 * Full snapshot per run (incremental archive chains are future work);
 * retention keeps the last two complete runs, older runs go to Drive's trash.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Writable } = require("node:stream");
const { randomUUID } = require("node:crypto");
const yazl = require("yazl");
const {
  backupSets,
  backupRuns,
  archiveParts,
  backupFolders,
} = require("../db/queries.cjs");
const { queue } = require("../transfers/queue.cjs");
const allocation = require("../allocation.cjs");
const settingsStore = require("../settings.cjs");
const drive = require("../drive/driveApi.cjs");
const { fail } = require("../drive/uploadCore.cjs");
const { walkTree } = require("./walker.cjs");
const { compileRules } = require("./rules.cjs");
const { ensureFolderChain, backupTmpDir, manifestDir } = require("./folders.cjs");
const { computeNextRun } = require("./schedule.cjs");
const { scope } = require("../logger.cjs");

const log = scope("archive");

const MAX_PART_BYTES = 8 * 1024 * 1024 * 1024; // stay far below Drive's 5 TB cap
const MIN_PART_BYTES = 64 * 1024 * 1024; // absurdly small slots aren't worth striping
const KEEP_RUNS = 2;

/** Enqueue one part upload and resolve when the queue settles it. */
function uploadPartAndWait(run, part, partPath) {
  return new Promise((resolve, reject) => {
    const transferId = queue.enqueue({
      kind: "backup",
      name: part.name,
      size: part.size,
      localPath: partPath,
      accountId: null, // allocator decides at start, preferring the primary
      priority: -10,
      meta: {
        setId: run.setId,
        runId: run.runId,
        archivePartId: part.id,
        sha256: part.sha256,
      },
    });
    run.inFlight.set(transferId, { relPath: part.name, size: part.size });

    const onState = ({ id, state }) => {
      if (id !== transferId) return;
      if (!["done", "failed", "canceled"].includes(state)) return;
      queue.off("state", onState);
      run.inFlight.delete(transferId);
      if (state === "done") resolve();
      else reject(fail(`part upload ${state}`, state === "canceled" ? "CANCELED" : "PART_FAILED", false));
    };
    queue.on("state", onState);
  });
}

/**
 * Writable that splits an incoming byte stream into fixed-size part files,
 * hashing each, and awaits `onPart` between parts (this is where the upload
 * happens, which is what keeps temp usage at one part).
 */
class PartSplitter extends Writable {
  constructor({ partSize, dir, baseName, onPart }) {
    super({ highWaterMark: 1 << 20 });
    this.partSize = partSize;
    this.dir = dir;
    this.baseName = baseName;
    this.onPart = onPart;
    this.index = 0;
    this.fd = null;
    this.currentSize = 0;
    this.hash = null;
    this.currentPath = null;
  }

  openPart() {
    this.index += 1;
    this.currentPath = path.join(this.dir, `${this.baseName}-part-${this.index}.zippart`);
    this.fd = fs.openSync(this.currentPath, "w");
    this.currentSize = 0;
    this.hash = crypto.createHash("sha256");
  }

  async closePart() {
    if (this.fd == null) return;
    fs.fsyncSync(this.fd);
    fs.closeSync(this.fd);
    this.fd = null;
    const finished = {
      index: this.index,
      path: this.currentPath,
      size: this.currentSize,
      sha256: this.hash.digest("hex"),
    };
    await this.onPart(finished);
  }

  async append(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.fd == null) this.openPart();
      const room = this.partSize - this.currentSize;
      const take = Math.min(room, chunk.length - offset);
      const slice = chunk.subarray(offset, offset + take);
      fs.writeSync(this.fd, slice);
      this.hash.update(slice);
      this.currentSize += take;
      offset += take;
      if (this.currentSize >= this.partSize) await this.closePart();
    }
  }

  _write(chunk, _enc, callback) {
    this.append(chunk).then(() => callback(), callback);
  }

  _final(callback) {
    this.closePart().then(() => callback(), callback);
  }
}

async function runArchive(set, reason, { active, notify, progressOf }) {
  const runId = randomUUID();
  const run = {
    runId,
    setId: set.id,
    reason,
    state: "scanning",
    pendingRel: [],
    inFlight: new Map(),
    filesTotal: 0,
    filesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    heldDeletions: 0,
    walkSkipped: 0,
    canceled: false,
    finished: false,
  };
  backupRuns.insert({ id: runId, set_id: set.id, mode: "archive", reason, state: "scanning" });
  active.set(runId, run);
  notify(progressOf(run));

  const cleanupPaths = [];
  try {
    if (!fs.existsSync(set.local_root)) {
      throw fail(`Backup folder is missing: ${set.local_root}`, "ROOT_MISSING", false);
    }

    const rules = compileRules(set.rules);
    const { files, skipped } = await walkTree(set.local_root, rules);
    run.walkSkipped = skipped.length;
    const fileList = [...files.entries()].map(([relPath, info]) => ({ relPath, ...info }));
    const rawTotal = fileList.reduce((sum, f) => sum + f.size, 0);
    run.filesTotal = fileList.length;
    run.bytesTotal = rawTotal;

    // Conservative space check: assume no compression. Parts are placed by the
    // normal allocator, so headroom and reservations apply per part.
    const headroom = (settingsStore.get("headroomMb")) * 1024 * 1024;
    const slots = allocation.snapshot().map((s) => Math.max(0, s.free - headroom));
    const sumFree = slots.reduce((a, b) => a + b, 0);
    const maxSlot = Math.max(0, ...slots);
    if (!slots.length || rawTotal > sumFree) {
      throw fail(
        `Not enough cloud space: need up to ${Math.ceil(rawTotal / 1e6)} MB, ` +
          `${Math.floor(sumFree / 1e6)} MB free across all accounts.`,
        "NO_SPACE",
        false
      );
    }
    const partSize = Math.max(MIN_PART_BYTES, Math.min(MAX_PART_BYTES, maxSlot));

    run.state = "transferring";
    backupRuns.update(runId, {
      state: "transferring",
      files_total: run.filesTotal,
      bytes_total: run.bytesTotal,
    });
    notify(progressOf(run));

    // Make sure the set root folder exists everywhere it may be needed lazily;
    // parts create their chain on whatever account the allocator picks.
    const baseName = `run-${runId.slice(0, 8)}`;
    const parts = [];

    const splitter = new PartSplitter({
      partSize,
      dir: backupTmpDir(),
      baseName,
      onPart: async (finished) => {
        if (run.canceled) throw fail("Canceled.", "CANCELED", false);
        const part = {
          id: randomUUID(),
          name: `${baseName}-part-${finished.index}.zippart`,
          size: finished.size,
          sha256: finished.sha256,
        };
        archiveParts.insert({
          id: part.id,
          run_id: runId,
          set_id: set.id,
          part_index: finished.index,
          size: finished.size,
          sha256: finished.sha256,
          state: "building",
        });
        cleanupPaths.push(finished.path);
        await uploadPartAndWait(run, part, finished.path);
        archiveParts.update(part.id, { state: "uploaded" });
        fs.rmSync(finished.path, { force: true });
        run.bytesDone += finished.size;
        parts.push(part);
        notify(progressOf(run));
      },
    });

    const zip = new yazl.ZipFile();
    const zipDone = new Promise((resolve, reject) => {
      splitter.on("finish", resolve);
      splitter.on("error", reject);
      zip.outputStream.on("error", reject);
    });
    zip.outputStream.pipe(splitter);

    for (const file of fileList) {
      if (run.canceled) throw fail("Canceled.", "CANCELED", false);
      zip.addFile(path.join(set.local_root, file.relPath), file.relPath, {
        mtime: new Date(file.mtime),
        compress: true,
      });
      run.filesDone += 1;
    }
    zip.end();
    await zipDone;

    // Manifest: uploaded to every account holding a part (and recorded rows
    // already ride the index snapshot). Small, so multipart upload is fine.
    const partRows = archiveParts.forRun(runId);
    const manifest = {
      version: 1,
      runId,
      setId: set.id,
      setName: set.name,
      createdAt: Date.now(),
      partSize,
      parts: partRows.map((p) => ({
        index: p.part_index,
        name: `${baseName}-part-${p.part_index}.zippart`,
        size: p.size,
        sha256: p.sha256,
        accountId: p.account_id,
        fileId: p.drive_file_id,
      })),
      files: fileList.map((f) => ({ relPath: f.relPath, size: f.size, mtime: f.mtime })),
    };
    const manifestBuffer = Buffer.from(JSON.stringify(manifest));
    // Local copy powers the restore browser without an API call.
    fs.writeFileSync(path.join(manifestDir(), `${runId}.json`), manifestBuffer);
    const manifestAccounts = [...new Set(partRows.map((p) => p.account_id).filter(Boolean))];
    for (const accountId of manifestAccounts) {
      try {
        const parentId = await ensureFolderChain(set.id, accountId, "");
        await drive.uploadSmall(accountId, {
          name: `${baseName}-manifest.json`,
          parentId,
          buffer: manifestBuffer,
          mimeType: "application/json",
        });
      } catch (err) {
        log.warn(`manifest upload to ${accountId} failed: ${err.message}`);
      }
    }

    await pruneOldRuns(set);

    run.finished = true;
    run.state = run.walkSkipped ? "partial" : "done";
    backupRuns.update(runId, {
      state: run.state,
      finished_at: Date.now(),
      files_done: run.filesDone,
      bytes_done: run.bytesDone,
      error: run.walkSkipped ? `${run.walkSkipped} file(s) unreadable` : null,
    });
    backupSets.update(set.id, {
      last_run_at: Date.now(),
      last_run_status: run.state,
      next_run_at: computeNextRun(set.schedule, Date.now()),
    });
    active.delete(runId);
    notify(progressOf(run));
    log.info(`archive run ${runId}: ${parts.length} part(s), ${run.bytesDone} bytes`);
    return runId;
  } catch (err) {
    run.finished = true;
    active.delete(runId);
    for (const p of cleanupPaths) fs.rmSync(p, { force: true });
    const state = err.code === "CANCELED" ? "canceled" : "failed";
    backupRuns.update(runId, { state, finished_at: Date.now(), error: err.message });
    backupSets.update(set.id, {
      last_run_at: Date.now(),
      last_run_status: state,
      next_run_at: computeNextRun(set.schedule, Date.now()),
    });
    run.state = state;
    notify(progressOf(run));
    if (state === "failed") log.error(`archive run for ${set.name} failed`, err);
    throw err;
  }
}

/** Keep the newest KEEP_RUNS complete archive runs; trash older parts/manifests. */
async function pruneOldRuns(set) {
  const complete = backupRuns
    .forSet(set.id, 50)
    .filter((r) => r.mode === "archive" && (r.state === "done" || r.state === "partial"));
  for (const old of complete.slice(KEEP_RUNS)) {
    for (const part of archiveParts.forRun(old.id)) {
      if (!part.drive_file_id || !part.account_id) continue;
      try {
        await drive.patchFile(part.account_id, part.drive_file_id, { trashed: true });
      } catch (err) {
        log.warn(`could not trash old part: ${err.message}`);
      }
    }
    // Manifests share the run prefix; find them beside the parts.
    const accounts = [...new Set(archiveParts.forRun(old.id).map((p) => p.account_id).filter(Boolean))];
    const prefix = `run-${old.id.slice(0, 8)}-manifest`;
    for (const accountId of accounts) {
      try {
        const folderId = backupFolders.get(set.id, accountId, "");
        if (!folderId) continue;
        for (const child of await drive.listChildren(accountId, folderId)) {
          if (child.name.startsWith(prefix)) {
            await drive.patchFile(accountId, child.id, { trashed: true });
          }
        }
      } catch (err) {
        log.warn(`could not trash old manifest: ${err.message}`);
      }
    }
  }
}

module.exports = { runArchive };
