/**
 * Classifies the difference between a disk snapshot and the recorded entries
 * of a backup set. Pure module - no filesystem, no database - so the logic is
 * unit-testable and the runner stays a thin orchestrator.
 *
 * Entry states it reasons about:
 *   ok            uploaded and current as of the last run
 *   pending/uploading/error/skipped   needs (re)upload
 *   deleted_local / trashed           gone locally; policy already applied
 */

/** FAT/exFAT store mtimes at 2 s granularity; below that is noise, not an edit. */
const MTIME_TOLERANCE_MS = 2000;

function changed(entry, info, tolerance) {
  if (entry.size !== info.size) return true;
  return Math.abs((entry.mtime || 0) - info.mtime) > tolerance;
}

/**
 * @param {Map<string,{size,mtime}>} diskMap from walker.cjs
 * @param {Array} entryRows backup_entries rows for the set
 * @returns {{
 *   uploads: Array<{relPath,size,mtime,op:'new'|'update',fileId:?string}>,
 *   deletions: Array<entryRow>,          // uploaded files now gone locally
 *   forgets: Array<entryRow>,            // never-uploaded rows gone locally
 *   renameCandidates: Array<{from:entryRow,to:{relPath,size,mtime}}>,
 *   unchanged: number,
 * }}
 *
 * Rename detection proposes a pair only when a deleted entry and an added file
 * match on (size, mtime) uniquely on BOTH sides - two same-size files moved at
 * once degrade to delete+upload rather than guessing. The runner still has to
 * confirm each proposal by hashing the local file against the entry's md5.
 */
function diff(
  diskMap,
  entryRows,
  { mtimeToleranceMs = MTIME_TOLERANCE_MS } = {},
) {
  const entries = new Map(entryRows.map((e) => [e.rel_path, e]));
  const uploads = [];
  const deletions = [];
  const forgets = [];
  let unchanged = 0;

  const addedInfos = []; // candidates for the rename pairing

  for (const [relPath, info] of diskMap) {
    const entry = entries.get(relPath);
    if (
      !entry ||
      entry.state === "deleted_local" ||
      entry.state === "trashed"
    ) {
      // New - or deleted earlier and now re-added. A trashed entry's old Drive
      // copy stays in Drive's trash until it expires; re-uploading fresh is
      // simpler and safer than resurrecting it.
      uploads.push({ relPath, ...info, op: "new", fileId: null });
      addedInfos.push({ relPath, ...info });
    } else if (entry.state === "ok") {
      if (changed(entry, info, mtimeToleranceMs)) {
        uploads.push({
          relPath,
          ...info,
          op: "update",
          fileId: entry.drive_file_id,
        });
      } else {
        unchanged += 1;
      }
    } else {
      // pending / uploading / error / skipped: still owed an upload. Keep the
      // existing file identity if one exists so we upload a revision.
      uploads.push({
        relPath,
        ...info,
        op: entry.drive_file_id ? "update" : "new",
        fileId: entry.drive_file_id || null,
      });
    }
  }

  for (const entry of entryRows) {
    if (diskMap.has(entry.rel_path)) continue;
    if (entry.state === "deleted_local" || entry.state === "trashed") continue;
    if (entry.drive_file_id) deletions.push(entry);
    else forgets.push(entry); // never made it to the cloud; nothing to propagate
  }

  // Unique (size, mtime-bucket) pairing between deletions and additions.
  const key = (size, mtime) =>
    `${size}:${Math.round(mtime / mtimeToleranceMs)}`;
  const deletedByKey = new Map();
  for (const entry of deletions) {
    const k = key(entry.size, entry.mtime || 0);
    deletedByKey.set(k, deletedByKey.has(k) ? null : entry); // null = ambiguous
  }
  const addedByKey = new Map();
  for (const info of addedInfos) {
    const k = key(info.size, info.mtime);
    addedByKey.set(k, addedByKey.has(k) ? null : info);
  }

  const renameCandidates = [];
  for (const [k, entry] of deletedByKey) {
    if (!entry || entry.size === 0) continue; // empty files all look alike
    const to = addedByKey.get(k);
    if (!to) continue;
    renameCandidates.push({ from: entry, to });
  }

  return { uploads, deletions, forgets, renameCandidates, unchanged };
}

/**
 * The mass-deletion guard: a vanished or renamed root must never mass-trash a
 * cloud backup. Held deletions require an explicit user confirmation.
 */
function deletionsHeld(
  deletions,
  okEntryCount,
  { minCount = 20, maxFraction = 0.25 } = {},
) {
  if (deletions.length <= minCount) return false;
  return deletions.length > okEntryCount * maxFraction;
}

module.exports = { diff, deletionsHeld };
