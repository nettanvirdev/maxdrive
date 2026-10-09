/**
 * Local→cloud backup facade: the service layer the IPC handlers talk to, plus
 * the scheduler tick. Everything stateful below delegates to runner.cjs.
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { get: db } = require("../db/database.cjs");
const {
  backupSets,
  backupEntries,
  backupRuns,
  backupFolders,
  accounts,
} = require("../db/queries.cjs");
const { queue, isOnline } = require("../transfers/queue.cjs");
const settingsStore = require("../settings.cjs");
const drive = require("../drive/driveApi.cjs");
const runner = require("./runner.cjs");
const { computeNextRun } = require("./schedule.cjs");
const { DEFAULT_IGNORE_DIRS, DEFAULT_EXCLUDE_EXTS } = require("./rules.cjs");
const { scope } = require("../logger.cjs");

const log = scope("localBackup");

const TICK_MS = 60_000;
const PROGRESS_COALESCE_MS = 500;

let notify = () => {};
let tickTimer = null;
let pendingProgress = null;
let progressTimer = null;

function setNotifier(fn) {
  notify = fn;
}

/** Run-level progress, coalesced so a fast wave can't flood the renderer. */
function onRunnerProgress(progress) {
  pendingProgress = progress;
  if (progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = null;
    const p = pendingProgress;
    pendingProgress = null;
    if (p) notify({ type: "progress", ...p });
    // Terminal states also refresh the set list (last run status changed).
    if (p && ["done", "partial", "failed", "canceled"].includes(p.state)) {
      notify({ type: "changed" });
    }
  }, PROGRESS_COALESCE_MS);
}

/* ------------------------------------------------------------------- sets */

function decorateSet(set) {
  const counts = backupEntries.countByState(set.id);
  const activeRun = runner.activeRunForSet(set.id);
  const lastRun = backupRuns.forSet(set.id, 1)[0] || null;
  return {
    ...set,
    rules: JSON.parse(set.rules || "{}"),
    schedule: JSON.parse(set.schedule || "{}"),
    counts,
    lastRun,
    activeRun: activeRun
      ? { runId: activeRun.runId, state: activeRun.state }
      : null,
  };
}

function listSets() {
  return backupSets.list().map(decorateSet);
}

function defaultRules() {
  return {
    ignoreDirs: [...DEFAULT_IGNORE_DIRS],
    excludeExts: [...DEFAULT_EXCLUDE_EXTS],
    includeExts: null,
  };
}

function createSet({
  name,
  localRoot,
  mode = "mirror",
  deletionPolicy = "trash",
  rules,
  schedule,
  primaryAccountId = null,
}) {
  if (
    !localRoot ||
    !fs.existsSync(localRoot) ||
    !fs.statSync(localRoot).isDirectory()
  ) {
    throw new Error("Choose an existing folder to back up.");
  }
  const root = path.resolve(localRoot);

  // Overlapping roots double-upload and fight over deletions - warn, don't block.
  const overlaps = backupSets
    .list()
    .filter((s) => {
      const other = path.resolve(s.local_root);
      return (
        root === other ||
        root.toLowerCase().startsWith(other.toLowerCase() + path.sep) ||
        other.toLowerCase().startsWith(root.toLowerCase() + path.sep)
      );
    })
    .map((s) => s.name);

  const id = randomUUID();
  const scheduleJson = JSON.stringify(schedule || {});
  backupSets.insert({
    id,
    name: name?.trim() || path.basename(root),
    local_root: root,
    mode,
    deletion_policy: deletionPolicy,
    rules: JSON.stringify(rules || defaultRules()),
    schedule: scheduleJson,
    primary_account_id: primaryAccountId,
    next_run_at: computeNextRun(scheduleJson, Date.now()),
  });
  notify({ type: "changed" });
  return { set: decorateSet(backupSets.byId(id)), overlaps };
}

function updateSet(id, patch = {}) {
  const set = backupSets.byId(id);
  if (!set) throw new Error("Backup set not found.");
  const mapped = {};
  if ("name" in patch)
    mapped.name = String(patch.name || "").trim() || set.name;
  if ("mode" in patch)
    mapped.mode = patch.mode === "archive" ? "archive" : "mirror";
  if ("deletionPolicy" in patch)
    mapped.deletion_policy = patch.deletionPolicy === "keep" ? "keep" : "trash";
  if ("rules" in patch) mapped.rules = JSON.stringify(patch.rules || {});
  if ("primaryAccountId" in patch)
    mapped.primary_account_id = patch.primaryAccountId || null;
  if ("enabled" in patch) mapped.enabled = patch.enabled ? 1 : 0;
  if ("schedule" in patch) {
    mapped.schedule = JSON.stringify(patch.schedule || {});
    mapped.next_run_at = computeNextRun(mapped.schedule, Date.now());
  }
  backupSets.update(id, mapped);
  notify({ type: "changed" });
  return decorateSet(backupSets.byId(id));
}

async function deleteSet(id, { removeRemote = false } = {}) {
  const set = backupSets.byId(id);
  if (!set) return { removed: false };

  const activeRun = runner.activeRunForSet(id);
  if (activeRun) await runner.cancelRun(activeRun.runId);

  if (removeRemote) {
    // Trashing the set's root folder trashes the whole subtree - one call per
    // account, and everything stays recoverable for 30 days.
    for (const folder of backupFolders.forSet(id)) {
      if (folder.rel_path !== "") continue;
      try {
        await drive.patchFile(folder.account_id, folder.drive_folder_id, {
          trashed: true,
        });
      } catch (err) {
        log.warn(`could not trash remote backup folder: ${err.message}`);
      }
    }
  }

  backupSets.remove(id); // entries/folders/runs cascade
  notify({ type: "changed" });
  return { removed: true };
}

/* ------------------------------------------------------------- run control */

/** Vault mode promises nothing plaintext leaves the PC; backups upload plaintext. */
function pausedByVaultMode() {
  return require("../vault/sealMode.cjs").enabled();
}

async function runNow(setId, reason = "manual", opts = {}) {
  if (pausedByVaultMode()) {
    const err = new Error("Backups are paused while vault mode is on.");
    err.code = "VAULT_MODE";
    err.retryable = false;
    throw err;
  }
  const runId = await runner.runSet(setId, reason, opts);
  notify({ type: "changed" });
  return { runId };
}

async function confirmDeletions(setId) {
  return runNow(setId, "manual", { confirmDeletions: true });
}

/** Transfers belonging to a set, matched through their meta JSON. */
function transferIdsForSet(setId, states) {
  const rows = db()
    .prepare(
      `SELECT id, meta FROM transfers
        WHERE kind = 'backup' AND state IN (${states.map(() => "?").join(",")})`,
    )
    .all(...states);
  const out = [];
  for (const row of rows) {
    try {
      if (JSON.parse(row.meta || "{}").setId === setId) out.push(row.id);
    } catch {
      /* skip */
    }
  }
  return out;
}

function pauseSet(setId) {
  backupSets.update(setId, { paused: 1 });
  for (const id of transferIdsForSet(setId, ["queued", "running"]))
    queue.pause(id);
  notify({ type: "changed" });
}

function resumeSet(setId) {
  backupSets.update(setId, { paused: 0 });
  for (const id of transferIdsForSet(setId, ["paused"])) queue.resume(id);
  notify({ type: "changed" });
}

function setGlobalPaused(paused) {
  settingsStore.set({ localBackupPaused: Boolean(paused) });
  notify({ type: "changed" });
}

function status() {
  return {
    globalPaused: Boolean(settingsStore.get("localBackupPaused")),
    vaultMode: pausedByVaultMode(),
    activeRuns: runner.activeRuns(),
    accounts: accounts
      .active()
      .filter((a) => a.provider !== "s3")
      .map((a) => ({ id: a.id, email: a.email })),
  };
}

/* -------------------------------------------------------------- scheduler */

async function tick() {
  if (settingsStore.get("localBackupPaused")) return;
  if (pausedByVaultMode()) return;
  if (!isOnline()) return; // starting a run offline just parks every transfer
  if (runner.activeRuns().length) return; // one run at a time, globally

  const due = backupSets.due(Date.now());
  if (!due.length) return;
  const set = due[0]; // oldest next_run_at first; the rest go on later ticks
  const reason =
    Date.now() - set.next_run_at > TICK_MS * 2 ? "catchup" : "schedule";
  try {
    await runner.runSet(set.id, reason);
  } catch (err) {
    log.warn(`scheduled run for ${set.name} failed: ${err.message}`);
  }
}

function start() {
  if (tickTimer) return;
  runner.setNotifier(onRunnerProgress);
  runner.onRunFinished(() => {
    // More sets may already be due - chain them without waiting a full tick.
    setTimeout(() => tick().catch(() => {}), 2000);
  });
  runner
    .reattach()
    .catch((err) => log.warn(`backup re-attach failed: ${err.message}`));
  tickTimer = setInterval(
    () => tick().catch((err) => log.warn(`tick failed: ${err.message}`)),
    TICK_MS,
  );
  log.info("local backup scheduler started");
}

function stop() {
  if (tickTimer) clearInterval(tickTimer);
  if (progressTimer) clearTimeout(progressTimer);
  tickTimer = progressTimer = null;
}

module.exports = {
  start,
  stop,
  setNotifier,
  listSets,
  createSet,
  updateSet,
  deleteSet,
  runNow,
  confirmDeletions,
  pauseSet,
  resumeSet,
  setGlobalPaused,
  status,
};
