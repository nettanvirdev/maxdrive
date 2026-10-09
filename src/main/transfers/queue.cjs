/**
 * Background transfer queue.
 *
 * Lives entirely in the main process and is driven by the database, so it keeps
 * running while the window is hidden in the tray and picks up where it left off
 * after a crash or reboot. The actual byte-moving is delegated to workers
 * registered by the drive layer, which keeps this file free of API details.
 */
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("events");
const { randomUUID } = require("crypto");
const { net } = require("electron");
const { get } = require("../db/database.cjs");
const { scope } = require("../logger.cjs");

const log = scope("transfers");

/** Assume online if Electron won't say - never make the queue worse than before. */
function isOnline() {
  try {
    if (typeof net.online === "boolean") return net.online;
    if (typeof net.isOnline === "function") return net.isOnline();
  } catch {
    /* fall through */
  }
  return true;
}

/** A transfer row's JSON meta; a missing or corrupt blob reads as {}. */
function parseMeta(transfer) {
  try {
    return JSON.parse(transfer.meta || "{}");
  } catch {
    return {};
  }
}

const NETWORK_POLL_MS = 15_000;

const MAX_CONCURRENT = 3;
// One write per account at a time - Drive throttles parallel writes to a single
// account far harder than reads. Enforced by the busy-account set in pickNext.
const MAX_DOWNLOADS = 2;
const PROGRESS_INTERVAL = 250;

// Never listed to users. Backup and restore jobs are surfaced run-level on the
// Backup page (hundreds of per-file rows would drown the user's own transfers);
// vault rows carry decrypted names, which would leak what is in the vault.
const HIDDEN_KINDS = new Set(["backup", "restore", "vaultUp", "vaultDown"]);
const MAX_ATTEMPTS = 8;

const ACTIVE = ["queued", "allocating", "running", "paused"];

class TransferQueue extends EventEmitter {
  constructor() {
    super();
    this.workers = {};
    this.running = new Map(); // transferId -> { controller, accountId, kind }
    this.pendingProgress = new Map();
    this.progressTimer = null;
    this.networkTimer = null;
    this.started = false;
    this.paused = false;
  }

  /** Phase 3/5 register { upload, download } here. */
  setWorkers(workers) {
    this.workers = { ...this.workers, ...workers };
    this.pump();
  }

  /**
   * Recovers state left behind by a crash: anything mid-flight becomes paused,
   * then optionally resumes so a reboot doesn't strand a half-finished upload.
   */
  start({ autoResume = true } = {}) {
    if (this.started) return;
    this.started = true;

    const stranded = get()
      .prepare(
        "SELECT id FROM transfers WHERE state IN ('running','allocating')",
      )
      .all();
    if (stranded.length) {
      get()
        .prepare(
          `UPDATE transfers SET state = 'paused', paused_by = 'system', updated_at = ?
           WHERE state IN ('running','allocating')`,
        )
        .run(Date.now());
      log.info(`recovered ${stranded.length} interrupted transfer(s)`);
    }

    if (autoResume) {
      // Only what the crash stopped. A transfer the user paused stays paused —
      // resuming it behind their back is the opposite of what they asked for.
      get()
        .prepare(
          `UPDATE transfers SET state = 'queued', paused_by = NULL, updated_at = ?
           WHERE state = 'paused' AND (paused_by IS NULL OR paused_by = 'system')`,
        )
        .run(Date.now());
    }

    this.pump();
  }

  /** What the Transfers page, the LAN API and MCP may show. */
  listVisible() {
    return this.list().filter((t) => !HIDDEN_KINDS.has(t.kind));
  }

  getVisible(id) {
    const t = this.get(id);
    return t && !HIDDEN_KINDS.has(t.kind) ? t : null;
  }

  list() {
    return get()
      .prepare(
        `SELECT t.*, a.email AS account_email FROM transfers t
         LEFT JOIN accounts a ON a.id = t.account_id
         ORDER BY
           CASE WHEN t.state IN ('running','allocating','queued','paused') THEN 0 ELSE 1 END,
           t.priority DESC, t.created_at`,
      )
      .all();
  }

  /** A single transfer row (with account email) by id, or undefined. */
  get(id) {
    return get()
      .prepare(
        `SELECT t.*, a.email AS account_email FROM transfers t
         LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`,
      )
      .get(id);
  }

  enqueue({
    kind,
    name,
    size = 0,
    localPath = null,
    accountId = null,
    nodeId = null,
    destParentNodeId = null,
    priority = 0,
    meta = null,
  }) {
    const id = randomUUID();
    const now = Date.now();
    get()
      .prepare(
        `INSERT INTO transfers
           (id, kind, state, node_id, account_id, local_path, dest_parent_node_id,
            name, size, bytes_done, attempts, priority, meta, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        kind,
        nodeId,
        accountId,
        localPath,
        destParentNodeId,
        name,
        size,
        priority,
        meta ? JSON.stringify(meta) : null,
        now,
        now,
      );

    this.emitState(id, "queued");
    this.pump();
    return id;
  }

  /**
   * Queue one local file for upload into a virtual folder - the single entry
   * point the IPC, REST and MCP surfaces share. `size` defaults to a fresh stat.
   */
  enqueueUpload(
    localPath,
    destParentNodeId,
    { name = path.basename(localPath), size } = {},
  ) {
    // Vault mode decides at enqueue: a file queued while it is on stays
    // sealed even if the mode is switched off before it uploads.
    const sealed = require("../vault/sealMode.cjs").enabled();
    return this.enqueue({
      kind: "upload",
      name,
      size: size ?? fs.statSync(localPath).size,
      localPath,
      destParentNodeId,
      meta: sealed ? { sealed: true } : null,
    });
  }

  pause(id) {
    const active = this.running.get(id);
    if (active) active.controller.abort("paused");
    this.setState(id, "paused", { paused_by: "user" });
    this.pump();
  }

  resume(id) {
    this.setState(id, "queued", {
      error_code: null,
      error_message: null,
      paused_by: null,
    });
    this.pump();
  }

  cancel(id) {
    const active = this.running.get(id);
    if (active) active.controller.abort("cancelled");
    const transfer = get()
      .prepare("SELECT * FROM transfers WHERE id = ?")
      .get(id);
    this.setState(id, "canceled", { session_uri: null });
    // Give back the half-written file and the server-side session; neither is
    // reachable again once the row is canceled.
    if (transfer) {
      require("../drive/cleanup.cjs")
        .discardTransfer(transfer)
        .catch((err) =>
          log.warn(`cleanup after cancel failed: ${err.message}`),
        );
    }
    this.pump();
  }

  retry(id) {
    get()
      .prepare(
        `UPDATE transfers SET state = 'queued', attempts = 0, error_code = NULL,
                error_message = NULL, paused_by = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
    this.emitState(id, "queued");
    this.pump();
  }

  /** Pauses the whole queue (tray menu) without losing any progress. */
  pauseAll() {
    this.paused = true;
    for (const [id, active] of this.running) {
      active.controller.abort("paused");
      this.setState(id, "paused", { paused_by: "user" });
    }
    this.emit("changed");
  }

  /** The explicit counterpart to pauseAll, so it does release user pauses. */
  resumeAll() {
    this.paused = false;
    get()
      .prepare(
        `UPDATE transfers SET state = 'queued', paused_by = NULL, updated_at = ?
         WHERE state = 'paused'`,
      )
      .run(Date.now());
    this.emit("changed");
    this.pump();
  }

  /**
   * Drops a single finished row from the list. Refuses while it is still
   * active - removing a running transfer would orphan the worker rather than
   * stop it, which is what `cancel` is for.
   */
  remove(id) {
    const row = get()
      .prepare("SELECT state FROM transfers WHERE id = ?")
      .get(id);
    if (!row) return false;
    if (ACTIVE.includes(row.state)) return false;
    get().prepare("DELETE FROM transfers WHERE id = ?").run(id);
    this.emit("changed");
    return true;
  }

  clearCompleted() {
    get()
      .prepare(
        "DELETE FROM transfers WHERE state IN ('done','canceled','failed')",
      )
      .run();
    this.emit("changed");
  }

  /* --------------------------------------------------------------- internals */

  setState(id, state, extra = {}) {
    const fields = ["state = ?", "updated_at = ?"];
    const values = [state, Date.now()];
    for (const [key, value] of Object.entries(extra)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
    values.push(id);
    get()
      .prepare(`UPDATE transfers SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
    this.emitState(id, state, extra);
  }

  emitState(id, state, extra = {}) {
    this.emit("state", { id, state, ...extra });
  }

  /** Progress is coalesced so a fast upload can't flood the renderer. */
  reportProgress(id, bytesDone) {
    this.pendingProgress.set(id, bytesDone);
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      const batch = [...this.pendingProgress.entries()].map(([tid, bytes]) => ({
        id: tid,
        bytes_done: bytes,
      }));
      this.pendingProgress.clear();
      if (!batch.length) return;

      const update = get().prepare(
        "UPDATE transfers SET bytes_done = ?, updated_at = ? WHERE id = ?",
      );
      const now = Date.now();
      get().transaction(() => {
        for (const item of batch) update.run(item.bytes_done, now, item.id);
      })();

      this.emit("progress", batch);
    }, PROGRESS_INTERVAL);
  }

  /** Picks the next eligible transfers and starts them, respecting the limits. */
  pump() {
    if (!this.started || this.paused) return;

    while (this.running.size < MAX_CONCURRENT) {
      const candidate = this.pickNext();
      if (!candidate) break;
      this.run(candidate);
    }
  }

  pickNext() {
    // A migration is a download and an upload at once: it reads from the source
    // account and writes to the target. Counting it as neither let migrations
    // run unbounded and let one land on an account already busy uploading.
    // Backup uploads and restore downloads obey the same budgets as their
    // user-facing counterparts - Drive doesn't care why the bytes move.
    const writesTo = (kind) =>
      kind === "upload" ||
      kind === "migrate" ||
      kind === "backup" ||
      kind === "vaultUp";
    const readsFrom = (kind) =>
      kind === "download" ||
      kind === "migrate" ||
      kind === "restore" ||
      kind === "vaultDown";

    const busyUploadAccounts = new Set();
    let downloads = 0;
    for (const active of this.running.values()) {
      if (writesTo(active.kind))
        busyUploadAccounts.add(active.accountId ?? "*");
      if (readsFrom(active.kind)) downloads += 1;
    }

    const queued = get()
      .prepare(
        `SELECT * FROM transfers WHERE state = 'queued'
         ORDER BY priority DESC, created_at LIMIT 25`,
      )
      .all();

    for (const transfer of queued) {
      if (this.running.has(transfer.id)) continue;
      if (!this.workers[transfer.kind]) continue;
      if (readsFrom(transfer.kind) && downloads >= MAX_DOWNLOADS) continue;
      if (writesTo(transfer.kind)) {
        // An account with no id yet is still being allocated; treat it as one slot.
        const key = transfer.account_id ?? "*";
        if (busyUploadAccounts.has(key)) continue;
      }
      return transfer;
    }
    return null;
  }

  async run(transfer) {
    const controller = new AbortController();
    this.running.set(transfer.id, {
      controller,
      accountId: transfer.account_id,
      kind: transfer.kind,
    });
    this.setState(transfer.id, "running");

    const worker = this.workers[transfer.kind];
    try {
      const result = await worker(transfer, {
        signal: controller.signal,
        meta: parseMeta(transfer),
        onProgress: (bytes) => this.reportProgress(transfer.id, bytes),
        /**
         * Workers call this when Drive hands back a new resumable session, and
         * with (null, null) to forget one that died.
         */
        setSession: (uri, expiresAt) =>
          get()
            .prepare(
              "UPDATE transfers SET session_uri = ?, session_expires_at = ? WHERE id = ?",
            )
            .run(uri, expiresAt, transfer.id),
        setAccount: (accountId) =>
          get()
            .prepare("UPDATE transfers SET account_id = ? WHERE id = ?")
            .run(accountId, transfer.id),
      });

      this.flushProgress();
      // Prefer what the worker actually moved: the row's size was measured at
      // enqueue time and the file may have changed on disk since.
      this.setState(transfer.id, "done", {
        bytes_done: result?.bytes ?? transfer.size,
        session_uri: null,
      });
      log.info(`${transfer.kind} finished: ${transfer.name}`);
    } catch (err) {
      this.flushProgress();
      const reason = controller.signal.reason;
      if (reason === "cancelled") {
        this.setState(transfer.id, "canceled");
      } else if (reason === "paused") {
        this.setState(transfer.id, "paused");
      } else if (!isOnline()) {
        // Losing Wi-Fi is not the transfer's fault. Spending retry attempts on
        // it means an overnight outage fails everything permanently, so hold
        // the work instead and wait for the connection to come back.
        this.setState(transfer.id, "paused", {
          paused_by: "system",
          error_code: "OFFLINE",
          error_message: "Waiting for a connection.",
        });
        log.info(`${transfer.name} held: offline`);
        this.waitForNetwork();
      } else {
        const attempts = transfer.attempts + 1;
        const retryable = err.retryable !== false && attempts < MAX_ATTEMPTS;
        this.setState(transfer.id, retryable ? "queued" : "failed", {
          attempts,
          error_code: err.code ?? "TRANSFER_FAILED",
          error_message: err.message,
        });
        if (retryable) {
          // Exponential backoff with jitter, capped at a minute.
          const delay =
            Math.min(64000, 1000 * 2 ** (attempts - 1)) + Math.random() * 1000;
          log.warn(
            `${transfer.name} failed (${err.message}); retry in ${Math.round(delay)}ms`,
          );
          setTimeout(() => this.pump(), delay);
        } else {
          log.error(`${transfer.name} gave up after ${attempts} attempts`, err);
        }
      }
    } finally {
      this.running.delete(transfer.id);
      this.emit("changed");
      this.pump();
    }
  }

  /**
   * Suspend/resume hooks. A sleeping laptop drops every socket at once, so the
   * queue steps aside deliberately rather than letting each transfer discover
   * the same broken connection and burn an attempt on it.
   */
  systemPause(reason) {
    for (const [id, active] of this.running) {
      active.controller.abort("paused");
      this.setState(id, "paused", { paused_by: "system", error_code: reason });
    }
  }

  systemResume() {
    const result = get()
      .prepare(
        `UPDATE transfers SET state = 'queued', paused_by = NULL, error_code = NULL,
                error_message = NULL, updated_at = ?
          WHERE state = 'paused' AND paused_by = 'system'`,
      )
      .run(Date.now());
    if (result.changes) log.info(`resumed ${result.changes} transfer(s)`);
    this.emit("changed");
    this.pump();
  }

  /** Polls for connectivity and releases everything held by the offline branch. */
  waitForNetwork() {
    if (this.networkTimer) return;
    this.networkTimer = setInterval(() => {
      if (!isOnline()) return;
      clearInterval(this.networkTimer);
      this.networkTimer = null;
      log.info("connection is back");
      this.systemResume();
    }, NETWORK_POLL_MS);
  }

  flushProgress() {
    if (!this.progressTimer) return;
    clearTimeout(this.progressTimer);
    this.progressTimer = null;
    const batch = [...this.pendingProgress.entries()].map(([id, bytes]) => ({
      id,
      bytes_done: bytes,
    }));
    this.pendingProgress.clear();
    if (batch.length) {
      const update = get().prepare(
        "UPDATE transfers SET bytes_done = ?, updated_at = ? WHERE id = ?",
      );
      const now = Date.now();
      get().transaction(() => {
        for (const item of batch) update.run(item.bytes_done, now, item.id);
      })();
      this.emit("progress", batch);
    }
  }
}

const queue = new TransferQueue();

module.exports = { queue, isOnline };
