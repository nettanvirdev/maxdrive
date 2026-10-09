/**
 * Restore: cloud backup → original local paths.
 *
 * The browse tree and the restore plan come from backup_entries - the local
 * record of what the cloud holds - so browsing costs zero API calls. The
 * entries are trustworthy because the worker only marks them 'ok' after
 * Drive's md5 matched the local file.
 */
const fs = require("node:fs");
const path = require("node:path");
const { backupSets, backupEntries, backupRuns } = require("../db/queries.cjs");
const { queue } = require("../transfers/queue.cjs");
const drive = require("../drive/driveApi.cjs");
const { matchesSelection, manifestDir } = require("./folders.cjs");
const { scope } = require("../logger.cjs");

const log = scope("restore");

/** Entry states that have a cloud copy to restore from. */
const RESTORABLE = new Set(["ok", "deleted_local", "trashed"]);

/** Archive sets browse via the locally-saved manifest of the newest run. */
function archiveManifestRows(set) {
  const run = backupRuns.latestComplete(set.id);
  if (!run) return [];
  try {
    const manifestPath = path.join(manifestDir(), `${run.id}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return (manifest.files || []).map((f) => ({
      rel_path: f.relPath,
      size: f.size,
      mtime: f.mtime,
      state: "ok",
    }));
  } catch {
    return []; // manifest lost locally - restore-all still works from the parts
  }
}

/**
 * One level of the backup tree under `prefix` ("" = the set root):
 * directories (derived from deeper paths) first, then files at this level.
 */
function tree(setId, prefix = "") {
  const set = backupSets.byId(setId);
  if (!set) throw new Error("Backup set not found.");
  const norm = prefix ? `${prefix.replace(/\/+$/, "")}/` : "";

  const rows =
    set.mode === "archive"
      ? archiveManifestRows(set)
      : backupEntries
          .allForSet(setId)
          .filter(
            (e) =>
              RESTORABLE.has(e.state) ||
              e.state === "pending" ||
              e.state === "error",
          );

  const dirs = new Map(); // name -> {files, bytes}
  const files = [];
  for (const entry of rows) {
    if (norm && !entry.rel_path.startsWith(norm)) continue;
    const rest = entry.rel_path.slice(norm.length);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      const missing = !fs.existsSync(path.join(set.local_root, entry.rel_path));
      files.push({
        name: rest,
        relPath: entry.rel_path,
        isFolder: false,
        size: entry.size,
        mtime: entry.mtime,
        state: entry.state,
        missingLocally: missing,
      });
    } else {
      const dirName = rest.slice(0, slash);
      const agg = dirs.get(dirName) || { files: 0, bytes: 0 };
      agg.files += 1;
      agg.bytes += entry.size || 0;
      dirs.set(dirName, agg);
    }
  }

  return [
    ...[...dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, agg]) => ({
        name,
        relPath: norm + name,
        isFolder: true,
        files: agg.files,
        size: agg.bytes,
      })),
    ...files.sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

/**
 * Queue restore downloads for the selection.
 * @param paths null = whole set; otherwise rel paths (files or dir prefixes)
 * @param overwrite false = missing-files-only (the accidental-deletion case)
 * @param includeTrashed also recover entries whose cloud copy sits in Drive's
 *   trash: untrash first, then download.
 */
async function restore({
  setId,
  paths = null,
  overwrite = false,
  includeTrashed = false,
}) {
  const set = backupSets.byId(setId);
  if (!set) throw new Error("Backup set not found.");
  if (set.mode === "archive") {
    return require("./archiveRestore.cjs").restoreFromArchive({
      set,
      paths,
      overwrite,
    });
  }

  let queued = 0;
  let skipped = 0;
  let untrashed = 0;

  for (const entry of backupEntries.allForSet(setId)) {
    if (!entry.drive_file_id || !matchesSelection(entry.rel_path, paths))
      continue;
    if (!RESTORABLE.has(entry.state)) continue;

    if (entry.state === "trashed") {
      if (!includeTrashed) continue;
      try {
        await drive.patchFile(entry.account_id, entry.drive_file_id, {
          trashed: false,
        });
        // 'ok' - the file is about to exist locally again; leaving it
        // 'deleted_local' would make the next run re-upload it needlessly,
        // and leaving 'trashed' would re-trash it.
        backupEntries.setState(setId, entry.rel_path, "ok");
        untrashed += 1;
      } catch (err) {
        log.warn(`untrash failed for ${entry.rel_path}: ${err.message}`);
        continue;
      }
    }

    const target = path.join(set.local_root, entry.rel_path);
    if (!overwrite && fs.existsSync(target)) {
      skipped += 1;
      continue;
    }

    queue.enqueue({
      kind: "restore",
      name: entry.rel_path.slice(entry.rel_path.lastIndexOf("/") + 1),
      size: entry.size,
      localPath: target,
      accountId: entry.account_id,
      meta: {
        setId,
        relPath: entry.rel_path,
        accountId: entry.account_id,
        driveFileId: entry.drive_file_id,
        md5: entry.md5,
        overwrite,
      },
    });
    queued += 1;
  }

  log.info(
    `restore for ${set.name}: ${queued} queued, ${skipped} present, ${untrashed} untrashed`,
  );
  return { queued, skipped, untrashed };
}

module.exports = { tree, restore };
