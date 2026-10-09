/**
 * Mirror-mode backup run lifecycle: walk → diff → metadata ops → wave-enqueue
 * uploads → finalize.
 *
 * Crash-safety model: durable state (backup_entries / backup_runs) advances
 * only when its effect is real - an entry becomes 'ok' inside the worker's
 * finalize, never before. The in-memory ActiveRun holds nothing that can't be
 * rebuilt from those tables plus the transfers table, which is what
 * `reattach()` does after a restart.
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  backupSets,
  backupEntries,
  backupRuns,
  backupFolders,
} = require("../db/queries.cjs");
const { queue } = require("../transfers/queue.cjs");
const drive = require("../drive/driveApi.cjs");
const core = require("../drive/uploadCore.cjs");
const { walkTree } = require("./walker.cjs");
const { compileRules } = require("./rules.cjs");
const { diff, deletionsHeld } = require("./differ.cjs");
const { ensureFolderChain, relDirOf } = require("./folders.cjs");
const { computeNextRun } = require("./schedule.cjs");
const { scope } = require("../logger.cjs");
const { randomUUID } = require("node:crypto");

const log = scope("localBackup");

/** Keep at most this many backup transfers in the queue table at once. */
const WAVE_SIZE = 20;
/** Backup jobs always yield to the user's own transfers (priority 0). */
const BACKUP_PRIORITY = -10;
/** Drive purges its trash after ~30 days; our bookkeeping follows. */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60_000;

let notify = () => {};
function setNotifier(fn) {
  notify = fn;
}

/** runId -> ActiveRun */
const active = new Map();

let subscribed = false;
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  queue.on("state", ({ id, state }) => {
    if (!["done", "failed", "canceled"].includes(state)) return;
    for (const run of active.values()) {
      if (run.inFlight.has(id)) {
        onTransferSettled(run, id, state).catch((err) =>
          log.error(`backup run ${run.runId} settle failed`, err),
        );
        return;
      }
    }
  });
}

function progressOf(run) {
  return {
    runId: run.runId,
    setId: run.setId,
    state: run.state,
    reason: run.reason,
    filesTotal: run.filesTotal,
    filesDone: run.filesDone,
    bytesTotal: run.bytesTotal,
    bytesDone: run.bytesDone,
    heldDeletions: run.heldDeletions || 0,
  };
}

function persistCounters(run) {
  backupRuns.update(run.runId, {
    files_done: run.filesDone,
    bytes_done: run.bytesDone,
    files_total: run.filesTotal,
    bytes_total: run.bytesTotal,
  });
}

async function onTransferSettled(run, transferId, state) {
  const job = run.inFlight.get(transferId);
  run.inFlight.delete(transferId);
  if (job) {
    run.filesDone += 1;
    if (state === "done") run.bytesDone += job.size;
    if (state === "failed") {
      const row = require("../db/database.cjs")
        .get()
        .prepare("SELECT error_message FROM transfers WHERE id = ?")
        .get(transferId);
      backupEntries.setState(
        run.setId,
        job.relPath,
        "error",
        row?.error_message || "upload failed",
      );
    }
    // canceled: the entry stays 'pending' and the next run picks it up.
  }
  persistCounters(run);
  notify(progressOf(run));
  await topUp(run);
}

/**
 * Feed the queue from the pending list, keeping at most WAVE_SIZE in flight.
 * Thousands of per-file rows in the transfers table would bloat it and its
 * crash-recovery path for no benefit.
 */
async function topUp(run) {
  if (run.toppingUp) return;
  run.toppingUp = true;
  try {
    while (
      !run.canceled &&
      run.inFlight.size < WAVE_SIZE &&
      run.pendingRel.length
    ) {
      const relPath = run.pendingRel.shift();
      const entry = backupEntries.get(run.setId, relPath);
      if (!entry || entry.state !== "pending") continue;

      const set = backupSets.byId(run.setId);
      if (!set) break;
      const absPath = path.join(set.local_root, relPath);

      let accountId;
      try {
        const allocation = require("../allocation.cjs");
        accountId = allocation.pickAccountForUpload(
          entry.size,
          set.primary_account_id,
        ).accountId;
      } catch (err) {
        backupEntries.setState(run.setId, relPath, "error", err.message);
        run.filesDone += 1;
        continue;
      }

      let driveParentId;
      try {
        driveParentId = await ensureFolderChain(
          run.setId,
          accountId,
          relDirOf(relPath),
        );
      } catch (err) {
        backupEntries.setState(
          run.setId,
          relPath,
          "error",
          `folder: ${err.message}`,
        );
        run.filesDone += 1;
        continue;
      }

      const transferId = queue.enqueue({
        kind: "backup",
        name: relPath.slice(relPath.lastIndexOf("/") + 1),
        size: entry.size,
        localPath: absPath,
        accountId,
        priority: BACKUP_PRIORITY,
        meta: {
          setId: run.setId,
          runId: run.runId,
          relPath,
          op: entry.drive_file_id ? "update" : "new",
          fileId: entry.drive_file_id || null,
          driveParentId,
        },
      });
      run.inFlight.set(transferId, { relPath, size: entry.size });
    }
  } finally {
    run.toppingUp = false;
  }

  if (!run.pendingRel.length && run.inFlight.size === 0 && !run.finished) {
    await finalizeRun(run);
  } else {
    persistCounters(run);
  }
}

async function finalizeRun(run) {
  run.finished = true;
  const counts = backupEntries.countByState(run.setId);
  const problems = (counts.error?.count || 0) + (counts.skipped?.count || 0);

  let state;
  if (run.canceled) state = "canceled";
  else if (run.heldDeletions) state = "partial";
  else if (problems || run.walkSkipped) state = "partial";
  else state = "done";

  backupRuns.update(run.runId, {
    state,
    finished_at: Date.now(),
    files_done: run.filesDone,
    bytes_done: run.bytesDone,
    error: run.heldDeletions
      ? "DELETIONS_HELD"
      : problems
        ? `${problems} file(s) had problems`
        : null,
  });

  const set = backupSets.byId(run.setId);
  if (set) {
    backupSets.update(run.setId, {
      last_run_at: Date.now(),
      last_run_status: state,
      next_run_at: computeNextRun(set.schedule, Date.now()),
    });
  }

  active.delete(run.runId);
  run.state = state;
  notify(progressOf(run));
  log.info(
    `run ${run.runId} for set ${run.setId}: ${state} (${run.filesDone}/${run.filesTotal})`,
  );
  if (onRunFinishedHook) onRunFinishedHook(run);
}

let onRunFinishedHook = null;
function onRunFinished(fn) {
  onRunFinishedHook = fn;
}

/** Confirmed renames become Drive-side PATCHes: zero bytes uploaded. */
async function applyRenames(set, candidates) {
  const applied = new Set();
  for (const { from, to } of candidates) {
    try {
      const absTo = path.join(set.local_root, to.relPath);
      if (!from.md5 || !fs.existsSync(absTo)) continue;
      const md5 = await core.hashFile(absTo);
      if (md5 !== from.md5) continue;

      const oldParent = backupFolders.get(
        set.id,
        from.account_id,
        relDirOf(from.rel_path),
      );
      const newParent = await ensureFolderChain(
        set.id,
        from.account_id,
        relDirOf(to.relPath),
      );
      const newName = to.relPath.slice(to.relPath.lastIndexOf("/") + 1);
      await drive.patchFile(from.account_id, from.drive_file_id, {
        name: newName,
        ...(oldParent && oldParent !== newParent
          ? { addParents: newParent, removeParents: oldParent }
          : {}),
      });
      backupEntries.rename(set.id, from.rel_path, to.relPath);
      backupEntries.upsert({
        set_id: set.id,
        rel_path: to.relPath,
        size: to.size,
        mtime: to.mtime,
        state: "ok",
      });
      applied.add(from.rel_path);
      applied.add(to.relPath);
      log.info(
        `rename detected: ${from.rel_path} → ${to.relPath} (no re-upload)`,
      );
    } catch (err) {
      // Fall back to delete+upload - correctness over cleverness.
      log.warn(`rename patch failed for ${from.rel_path}: ${err.message}`);
    }
  }
  return applied;
}

async function applyDeletions(set, deletions) {
  for (const entry of deletions) {
    try {
      if (set.deletion_policy === "keep") {
        backupEntries.setState(set.id, entry.rel_path, "deleted_local");
      } else {
        await drive.patchFile(entry.account_id, entry.drive_file_id, {
          trashed: true,
        });
        backupEntries.markTrashed(set.id, entry.rel_path);
      }
    } catch (err) {
      backupEntries.setState(
        set.id,
        entry.rel_path,
        "error",
        `delete: ${err.message}`,
      );
    }
  }
}

/**
 * Run one backup set. Resolves when the scan phase is over and transfers are
 * underway (or the run finished with nothing to do) - completion is signalled
 * through run events, not this promise.
 */
async function runSet(
  setId,
  reason = "manual",
  { confirmDeletions = false } = {},
) {
  subscribe();
  const set = backupSets.byId(setId);
  if (!set) throw new Error("Backup set not found.");
  if (activeRunForSet(setId)) return activeRunForSet(setId).runId;
  if (set.mode === "archive") {
    return require("./archive.cjs").runArchive(set, reason, {
      active,
      notify,
      progressOf,
    });
  }

  const runId = randomUUID();
  const run = {
    runId,
    setId,
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
    toppingUp: false,
  };
  backupRuns.insert({
    id: runId,
    set_id: setId,
    mode: "mirror",
    reason,
    state: "scanning",
  });
  active.set(runId, run);
  notify(progressOf(run));

  try {
    if (!fs.existsSync(set.local_root)) {
      // Never interpreted as "everything was deleted" - see the mass-delete
      // guard below for the softer version of the same defence.
      const err = new Error(`Backup folder is missing: ${set.local_root}`);
      err.code = "ROOT_MISSING";
      throw err;
    }

    const rules = compileRules(set.rules);
    const { files, skipped } = await walkTree(set.local_root, rules);
    run.walkSkipped = skipped.length;
    for (const miss of skipped) {
      log.warn(`skipped ${miss.relPath}: ${miss.error}`);
    }

    const entries = backupEntries.allForSet(setId);
    const d = diff(files, entries);

    // Renames first: every confirmed pair removes one upload AND one deletion.
    const renamed = await applyRenames(set, d.renameCandidates);
    const uploads = d.uploads.filter((u) => !renamed.has(u.relPath));
    const deletions = d.deletions.filter((e) => !renamed.has(e.rel_path));

    // Rows that never reached the cloud and are gone locally: nothing to keep.
    for (const entry of d.forgets) backupEntries.remove(setId, entry.rel_path);

    const okCount = entries.filter((e) => e.state === "ok").length;
    if (!confirmDeletions && deletionsHeld(deletions, okCount)) {
      run.heldDeletions = deletions.length;
      log.warn(
        `set ${set.name}: holding ${deletions.length} deletion(s) pending confirmation`,
      );
    } else {
      await applyDeletions(set, deletions);
    }

    backupEntries.purgeExpiredTrash(setId, Date.now() - TRASH_RETENTION_MS);

    // Everything that needs bytes moved becomes a 'pending' entry; the wave
    // machinery owns it from here.
    for (const u of uploads) {
      backupEntries.upsert({
        set_id: setId,
        rel_path: u.relPath,
        size: u.size,
        mtime: u.mtime,
        state: "pending",
        error: null,
        trashed_at: null,
      });
      run.pendingRel.push(u.relPath);
    }
    run.filesTotal = uploads.length;
    run.bytesTotal = uploads.reduce((sum, u) => sum + (u.size || 0), 0);

    run.state = "transferring";
    backupRuns.update(runId, {
      state: "transferring",
      files_total: run.filesTotal,
      bytes_total: run.bytesTotal,
    });
    notify(progressOf(run));

    await topUp(run); // finalizes immediately when there is nothing to upload
    return runId;
  } catch (err) {
    run.finished = true;
    active.delete(runId);
    backupRuns.update(runId, {
      state: "failed",
      finished_at: Date.now(),
      error: err.message,
    });
    backupSets.update(setId, {
      last_run_at: Date.now(),
      last_run_status: "failed",
      next_run_at: computeNextRun(set.schedule, Date.now()),
    });
    run.state = "failed";
    notify(progressOf(run));
    log.error(`run for set ${set.name} failed`, err);
    throw err;
  }
}

function activeRunForSet(setId) {
  for (const run of active.values()) if (run.setId === setId) return run;
  return null;
}

function activeRuns() {
  return [...active.values()].map(progressOf);
}

async function cancelRun(runId) {
  const run = active.get(runId);
  if (!run) return false;
  run.canceled = true;
  run.pendingRel = [];
  for (const transferId of run.inFlight.keys()) queue.cancel(transferId);
  if (run.inFlight.size === 0 && !run.finished) await finalizeRun(run);
  return true;
}

/**
 * Boot re-attach. The queue has already recovered this run's transfers; we
 * rebuild the in-memory run from the tables and resume feeding the wave.
 */
async function reattach() {
  subscribe();
  const db = require("../db/database.cjs").get();
  for (const row of backupRuns.nonTerminal()) {
    const set = backupSets.byId(row.set_id);
    if (!set) {
      backupRuns.update(row.id, {
        state: "failed",
        finished_at: Date.now(),
        error: "SET_GONE",
      });
      continue;
    }

    if (row.state === "scanning" || row.mode === "archive") {
      // The scan (or archive build) never survives a restart - restart cleanly.
      backupRuns.update(row.id, {
        state: "failed",
        finished_at: Date.now(),
        error: "INTERRUPTED",
      });
      runSet(row.set_id, "catchup").catch((err) =>
        log.warn(`re-run after interrupt failed: ${err.message}`),
      );
      continue;
    }

    const run = {
      runId: row.id,
      setId: row.set_id,
      reason: row.reason,
      state: "transferring",
      pendingRel: [],
      inFlight: new Map(),
      filesTotal: row.files_total,
      filesDone: row.files_done,
      bytesTotal: row.bytes_total,
      bytesDone: row.bytes_done,
      heldDeletions: row.error === "DELETIONS_HELD" ? 1 : 0,
      walkSkipped: 0,
      canceled: false,
      finished: false,
      toppingUp: false,
    };

    // Transfers the queue recovered for this run are still ours.
    const rows = db
      .prepare(
        `SELECT id, meta, size FROM transfers
          WHERE kind = 'backup' AND state IN ('queued','allocating','running','paused')`,
      )
      .all();
    const claimed = new Set();
    for (const t of rows) {
      try {
        const meta = JSON.parse(t.meta || "{}");
        if (meta.runId === row.id) {
          run.inFlight.set(t.id, { relPath: meta.relPath, size: t.size });
          claimed.add(meta.relPath);
        }
      } catch {
        /* unparseable meta - leave it to the queue */
      }
    }
    for (const entry of backupEntries.byState(row.set_id, "pending")) {
      if (!claimed.has(entry.rel_path)) run.pendingRel.push(entry.rel_path);
    }

    active.set(row.id, run);
    log.info(
      `re-attached run ${row.id}: ${run.inFlight.size} in flight, ${run.pendingRel.length} pending`,
    );
    await topUp(run);
  }
}

module.exports = {
  runSet,
  cancelRun,
  reattach,
  activeRuns,
  activeRunForSet,
  onRunFinished,
  setNotifier,
};
