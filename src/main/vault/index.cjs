/**
 * Secure Storage facade - the service layer behind every `vault:*` IPC call.
 *
 * The shape mirrors localBackup/index.cjs (setNotifier/start/stop plus service
 * methods) but the plane is entirely separate: vault rows never touch `nodes`,
 * vault blobs live in a hidden `.vault` folder, and nothing here returns key
 * material to the renderer - only decrypted results.
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { nativeImage } = require("electron");
const {
  accounts,
  vaultAccounts,
  vaultConfig,
  vaultCopies,
  vaultItems,
  settings: settingsQ,
} = require("../db/queries.cjs");
const { queue } = require("../transfers/queue.cjs");
const accountService = require("../auth/accountService.cjs");
const drive = require("../drive/driveApi.cjs");
const allocation = require("../allocation.cjs");
const { freeName } = require("../ops.cjs");
const { scope } = require("../logger.cjs");
const crypto = require("./crypto.cjs");
const blob = require("./blobFormat.cjs");
const session = require("./session.cjs");
const storage = require("./storage.cjs");
const planner = require("./planner.cjs");
const { mimeOf } = require("./mime.cjs");
const settingsStore = require("../settings.cjs");

const log = scope("vault");

const COPIES_KEY = "vaultCopies";
const AUTOLOCK_KEY = "vaultAutolockMinutes";
const PROGRESS_COALESCE_MS = 400;
const RECONCILE_MS = 10 * 60 * 1000;
const UPLOAD_PRIORITY = -5;
const THUMB_WIDTH = 320;

let notify = () => {};
let pendingProgress = new Map();
let progressTimer = null;
let reconcileTimer = null;

function setNotifier(fn) {
  notify = fn || (() => {});
}

const { fail } = crypto;

/** Per-item progress, coalesced so encrypting many files can't flood IPC. */
function emitProgress(event) {
  pendingProgress.set(event.itemId, event);
  if (progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = null;
    const batch = [...pendingProgress.values()];
    pendingProgress = new Map();
    for (const item of batch) notify({ type: "progress", ...item });
  }, PROGRESS_COALESCE_MS);
}

const changed = () => notify({ type: "changed" });

/* ------------------------------------------------------------- settings */

const desiredCopies = () =>
  Math.max(1, Number(settingsQ.get(COPIES_KEY, 1)) || 1);
const autolockMinutes = () => {
  const value = settingsQ.get(AUTOLOCK_KEY, session.DEFAULT_AUTOLOCK_MIN);
  return Number.isFinite(Number(value))
    ? Number(value)
    : session.DEFAULT_AUTOLOCK_MIN;
};

function getSettings() {
  return { copies: desiredCopies(), autolockMinutes: autolockMinutes() };
}

function setSettings({ copies, autolockMinutes: minutes } = {}) {
  if (copies != null)
    settingsQ.set(COPIES_KEY, Math.max(1, Number(copies) || 1));
  if (minutes != null) {
    const value = Math.max(0, Number(minutes) || 0);
    settingsQ.set(AUTOLOCK_KEY, value);
    session.setAutolockMinutes(value);
  }
  changed();
  return getSettings();
}

/* --------------------------------------------------------------- config */

const configured = () => Boolean(vaultConfig.get());

function persistConfig(configRow) {
  vaultConfig.upsert(configRow);
}

/**
 * Create the vault. Returns the recovery key exactly once - it is derived
 * here, wrapped, and then forgotten; there is no way to print it again.
 */
async function setup(password) {
  if (configured()) throw fail("The vault already exists.", "VAULT_EXISTS");
  if (!password || String(password).length < 8)
    throw fail("Use at least 8 characters.", "WEAK_PASSWORD");

  const { configRow, vmk, recoveryKey } = crypto.createConfig(password);
  persistConfig(configRow);
  session.adopt(vmk);

  // Seed the vault onto the account with the most room unless the user has
  // already made a choice.
  if (!vaultAccounts.ids().length) {
    const usable = accounts.active().filter((a) => a.provider !== "s3");
    if (usable.length) {
      const best = usable
        .slice()
        .sort(
          (a, b) =>
            (b.quota_limit || Infinity) -
            (b.quota_usage || 0) -
            ((a.quota_limit || Infinity) - (a.quota_usage || 0)),
        )[0];
      vaultAccounts.insert({ account_id: best.id });
    }
  }
  await publishConfig().catch((err) =>
    log.warn(`vault config not yet uploaded: ${err.message}`),
  );
  changed();
  return { recoveryKey };
}

/** Push vault.cfg to every vault account so the vault survives a reinstall. */
async function publishConfig() {
  const row = vaultConfig.get();
  if (!row) return;
  const buffer = crypto.serializeCfgFile(row);
  for (const entry of vaultAccounts.list()) {
    if (entry.auth_state !== "ok") continue;
    try {
      const folderId = await accountService.ensureVaultFolder(entry.account_id);
      // Replace rather than accumulate: old revisions would confuse recovery.
      const existing = await drive.listChildren(entry.account_id, folderId);
      for (const file of existing.filter((f) => f.name === "vault.cfg")) {
        await drive.deleteFile(entry.account_id, file.id).catch(() => {});
      }
      await drive.uploadSmall(entry.account_id, {
        name: "vault.cfg",
        parentId: folderId,
        buffer,
        mimeType: "application/json",
      });
      vaultAccounts.update(entry.account_id, {
        last_ok_at: Date.now(),
        last_error: null,
      });
    } catch (err) {
      vaultAccounts.update(entry.account_id, { last_error: err.message });
      log.warn(
        `could not publish vault config to ${entry.email}: ${err.message}`,
      );
    }
  }
}

function unlock(secret, { recovery = false } = {}) {
  const row = vaultConfig.get();
  if (!row) throw fail("No vault has been created yet.", "VAULT_MISSING");
  const result = session.unlock(row, secret, { recovery });
  changed();
  return result;
}

function lock() {
  session.lock("user");
  changed();
}

/**
 * Password change re-wraps the master key; files are never touched.
 *
 * The current secret may be the old password *or* the recovery key — a user who
 * has forgotten their password needs exactly this to get back to a usable
 * vault, and the recovery key already proves the same thing the password does.
 */
async function changePassword(oldSecret, newPassword, { recovery = false } = {}) {
  const row = vaultConfig.get();
  if (!row) throw fail("No vault has been created yet.", "VAULT_MISSING");
  if (!newPassword || String(newPassword).length < 8)
    throw fail("Use at least 8 characters.", "WEAK_PASSWORD");
  const { vmk } = crypto.unlockConfig(row, oldSecret, { recovery });
  const next = crypto.rewrapPassword(row, vmk, newPassword);
  persistConfig(next);
  session.adopt(vmk);
  await publishConfig().catch((err) =>
    log.warn(`config publish failed: ${err.message}`),
  );
  changed();
  return { ok: true };
}

/**
 * Issue a replacement recovery key, invalidating the previous one. Accepts the
 * old recovery key as proof too, so a key that has been seen by someone else
 * can be rotated out without knowing the password.
 */
async function regenerateRecoveryKey(secret, { recovery = false } = {}) {
  const row = vaultConfig.get();
  if (!row) throw fail("No vault has been created yet.", "VAULT_MISSING");
  const { vmk } = crypto.unlockConfig(row, secret, { recovery });
  const { configRow, recoveryKey } = crypto.rewrapRecovery(row, vmk);
  persistConfig(configRow);
  await publishConfig().catch((err) =>
    log.warn(`config publish failed: ${err.message}`),
  );
  return { recoveryKey };
}

/* ---------------------------------------------------------------- items */

const metaOf = (item, vmk) => {
  if (!item.meta_ct) return { name: "Untitled", mime: null };
  try {
    return crypto.decryptMeta(vmk, item.meta_ct);
  } catch {
    return { name: "Unreadable item", mime: null };
  }
};

/** Shape an item for the renderer - decrypted name/mime, never key material. */
function present(item, vmk, copiesByItem) {
  const meta = metaOf(item, vmk);
  const copies = copiesByItem?.get(item.id) || vaultCopies.forItem(item.id);
  const ok = copies.filter((c) => c.state === "ok");
  return {
    id: item.id,
    parentId: item.parent_id,
    isFolder: Boolean(item.is_folder),
    name: meta.name,
    mime: meta.mime || null,
    size: item.size,
    createdAt: item.created_at,
    modifiedAt: item.modified_at,
    state: item.state,
    hasThumb: !item.is_folder && fs.existsSync(storage.thumbPath(item.id)),
    copies: copies.length,
    copiesOk: ok.length,
    // A file with no confirmed copy anywhere can't be opened right now: either
    // it is still uploading, or every account holding it is unreachable.
    available: Boolean(item.is_folder) || ok.length > 0,
    accounts: ok.map((c) => c.account_id),
  };
}

function list(parentId = null) {
  const vmk = session.getVmk();
  session.touch();
  const rows = vaultItems.list(parentId);
  const copiesByItem = new Map();
  for (const copy of vaultCopies.all()) {
    if (!copiesByItem.has(copy.item_id)) copiesByItem.set(copy.item_id, []);
    copiesByItem.get(copy.item_id).push(copy);
  }
  return rows
    .map((row) => present(row, vmk, copiesByItem))
    .sort((a, b) =>
      a.isFolder === b.isFolder
        ? a.name.localeCompare(b.name, undefined, { numeric: true })
        : a.isFolder
          ? -1
          : 1,
    );
}

/** Breadcrumb trail from the vault root down to `itemId`. */
function breadcrumbs(itemId) {
  if (!itemId) return [];
  const vmk = session.getVmk();
  const trail = [];
  let current = vaultItems.byId(itemId);
  const guard = new Set();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    trail.unshift({ id: current.id, name: metaOf(current, vmk).name });
    current = current.parent_id ? vaultItems.byId(current.parent_id) : null;
  }
  return trail;
}

function details(itemId) {
  const vmk = session.getVmk();
  session.touch();
  const item = vaultItems.byId(itemId);
  if (!item) throw fail("That item is gone.", "VAULT_NOT_FOUND");
  const copies = vaultCopies.forItem(itemId).map((copy) => ({
    accountId: copy.account_id,
    email: accounts.byId(copy.account_id)?.email || copy.account_id,
    state: copy.state,
    error: copy.error,
  }));
  return {
    ...present(item, vmk, null),
    chunkSize: item.chunk_size,
    blobSize: item.blob_size,
    encryption: "AES-256-GCM",
    copyDetail: copies,
  };
}

function createFolder(parentId, name) {
  const vmk = session.getVmk();
  session.touch();
  const clean = String(name || "").trim();
  if (!clean) throw fail("Give the folder a name.", "BAD_NAME");
  const id = randomUUID();
  vaultItems.insert({
    id,
    parent_id: parentId || null,
    is_folder: 1,
    meta_ct: crypto.encryptMeta(vmk, { name: clean, mime: "folder" }),
  });
  changed();
  return { id };
}

function rename(itemId, name) {
  const vmk = session.getVmk();
  session.touch();
  const item = vaultItems.byId(itemId);
  if (!item) throw fail("That item is gone.", "VAULT_NOT_FOUND");
  const clean = String(name || "").trim();
  if (!clean) throw fail("Give it a name.", "BAD_NAME");
  const meta = metaOf(item, vmk);
  // Renaming touches only local metadata: the Drive blob keeps its opaque
  // uuid name, so nothing about the change is visible in Drive.
  vaultItems.update(itemId, {
    meta_ct: crypto.encryptMeta(vmk, { ...meta, name: clean }),
    modified_at: Date.now(),
  });
  changed();
  return { id: itemId, name: clean };
}

/** Depth-first list of an item and everything under it. */
function descendants(itemId) {
  const out = [];
  const walk = (id) => {
    const item = vaultItems.byId(id);
    if (!item) return;
    for (const child of vaultItems.list(id)) walk(child.id);
    out.push(item);
  };
  walk(itemId);
  return out;
}

async function remove(itemIds) {
  session.getVmk();
  session.touch();
  const targets = [];
  for (const id of itemIds) targets.push(...descendants(id));

  let removed = 0;
  for (const item of targets) {
    for (const copy of vaultCopies.forItem(item.id)) {
      if (!copy.drive_file_id) continue;
      try {
        await drive.deleteFile(copy.account_id, copy.drive_file_id);
      } catch (err) {
        // A blob we can't reach right now is not a reason to keep the item —
        // it is unreadable without the key anyway. Log and move on.
        log.warn(
          `could not delete vault blob on ${copy.account_id}: ${err.message}`,
        );
      }
    }
    if (item.blob_uuid)
      storage.removeQuietly(storage.tempBlobPath(item.blob_uuid));
    storage.removeQuietly(storage.thumbPath(item.id));
    vaultItems.remove(item.id);
    removed += 1;
  }
  changed();
  scheduleSnapshot();
  return { removed };
}

/* --------------------------------------------------------------- upload */

/** Small encrypted preview image, so the grid has thumbnails while unlocked. */
function makeThumbnail(itemId, srcPath, vmk) {
  try {
    const image = nativeImage.createFromPath(srcPath);
    if (image.isEmpty()) return false;
    const resized = image.resize({ width: THUMB_WIDTH, quality: "good" });
    const png = resized.toPNG();
    if (!png?.length) return false;
    fs.writeFileSync(
      storage.thumbPath(itemId),
      crypto.encryptMeta(vmk, { png: png.toString("base64") }),
    );
    return true;
  } catch (err) {
    log.warn(`thumbnail failed: ${err.message}`);
    return false;
  }
}

/**
 * Encrypt each file locally, then hand the ciphertext to the transfer queue.
 * Plaintext never leaves this machine - by the time a transfer exists, the
 * bytes on disk are already unreadable without the master key.
 */
async function uploadFiles(paths, parentId = null) {
  const vmk = session.getVmk();
  session.touch();
  const hosts = vaultAccounts.list().filter((a) => a.auth_state === "ok");
  if (!hosts.length)
    throw fail(
      "Choose at least one Google Drive account to hold the vault.",
      "VAULT_NO_ACCOUNTS",
    );

  const created = [];
  for (const source of paths) {
    let stat;
    try {
      stat = fs.statSync(source);
    } catch {
      log.warn(`skipping unreadable file: ${source}`);
      continue;
    }
    if (stat.isDirectory()) {
      // Recurse so dropping a folder keeps its shape inside the vault.
      const folder = createFolder(parentId, path.basename(source));
      const children = fs
        .readdirSync(source)
        .map((entry) => path.join(source, entry));
      const nested = await uploadFiles(children, folder.id);
      created.push(...nested.items);
      continue;
    }

    const id = randomUUID();
    const blobUuid = randomUUID();
    const name = path.basename(source);
    vaultItems.insert({
      id,
      parent_id: parentId || null,
      is_folder: 0,
      meta_ct: crypto.encryptMeta(vmk, { name, mime: mimeOf(source) }),
      size: stat.size,
      blob_uuid: blobUuid,
      state: "uploading",
      created_at: Date.now(),
      modified_at: stat.mtimeMs,
    });
    changed();

    let encrypted;
    try {
      emitProgress({ itemId: id, phase: "encrypt", pct: 0 });
      encrypted = await blob.encryptFileToPath({
        srcPath: source,
        destPath: storage.tempBlobPath(blobUuid),
        vmk,
        onProgress: (done, total) =>
          emitProgress({
            itemId: id,
            phase: "encrypt",
            pct: total ? Math.round((done / total) * 100) : 100,
          }),
      });
    } catch (err) {
      vaultItems.remove(id);
      changed();
      throw err;
    }

    vaultItems.update(id, {
      blob_size: encrypted.blobSize,
      chunk_size: encrypted.chunkSize,
      blob_md5: encrypted.blobMd5,
      plaintext_sha256: encrypted.plaintextSha256,
      wrapped_file_key: encrypted.wrappedFileKey,
      file_prefix: encrypted.filePrefix,
    });
    makeThumbnail(id, source, vmk);

    enqueueCopies(vaultItems.byId(id));
    created.push({ id, name });
  }

  changed();
  return { items: created };
}

/** Queue one upload transfer per account this item should live on. */
function enqueueCopies(item) {
  const actions = planner.plan({
    items: [item],
    copies: vaultCopies.forItem(item.id),
    accounts: accountSnapshot(),
    desiredCopies: desiredCopies(),
  });

  let queued = 0;
  for (const action of actions) {
    if (action.type !== "replicate") {
      if (action.type === "blocked") {
        log.warn(`vault item ${item.id} blocked: ${action.reason}`);
      }
      continue;
    }
    vaultCopies.upsert({
      item_id: item.id,
      account_id: action.toAccountId,
      state: "pending",
    });
    queue.enqueue({
      kind: "vaultUp",
      name: `secure-${item.blob_uuid}.mxv`,
      size: item.blob_size || 0,
      localPath: storage.tempBlobPath(item.blob_uuid),
      accountId: action.toAccountId,
      priority: UPLOAD_PRIORITY,
      meta: {
        itemId: item.id,
        accountId: action.toAccountId,
        blobUuid: item.blob_uuid,
        blobMd5: item.blob_md5,
      },
    });
    queued += 1;
  }
  if (!queued) {
    vaultItems.update(item.id, { state: "active" });
  }
  return queued;
}

/**
 * Accounts as the planner wants them. Free space carries the same headroom the
 * normal allocator applies, so the vault never fills a Drive to the brim.
 */
function accountSnapshot() {
  const headroom = (settingsStore.get("headroomMb")) * 1024 * 1024;
  const free = new Map(allocation.snapshot().map((a) => [a.id, a.free]));
  return vaultAccounts.list().map((entry) => {
    const available = free.get(entry.account_id);
    return {
      accountId: entry.account_id,
      state: entry.state,
      health: entry.auth_state === "ok" ? "ok" : "unavailable",
      freeBytes:
        available == null
          ? null
          : Number.isFinite(available)
            ? Math.max(0, available - headroom)
            : available,
    };
  });
}

/* ------------------------------------------------------------- download */

/**
 * Fetch the ciphertext from whichever account has it and decrypt to `destDir`.
 * Enqueued rather than run inline so it shares the queue's retry, resume and
 * offline handling with every other transfer.
 */
function download(itemIds, destDir) {
  const vmk = session.getVmk();
  session.touch();
  const queued = [];
  for (const id of itemIds) {
    for (const item of descendants(id)) {
      if (item.is_folder) continue;
      const copy = vaultCopies
        .forItem(item.id)
        .find((c) => c.state === "ok" && c.drive_file_id);
      if (!copy) {
        log.warn(`no available copy of vault item ${item.id}`);
        continue;
      }
      const meta = metaOf(item, vmk);
      // "report.pdf" -> "report (2).pdf" when the destination already has one.
      const target = path.join(
        destDir,
        freeName(meta.name, (n) => fs.existsSync(path.join(destDir, n))),
      );
      queue.enqueue({
        kind: "vaultDown",
        name: meta.name,
        size: item.size || 0,
        localPath: target,
        accountId: copy.account_id,
        meta: {
          itemId: item.id,
          accountId: copy.account_id,
          driveFileId: copy.drive_file_id,
          savePath: target,
        },
      });
      queued.push({ id: item.id, name: meta.name, path: target });
    }
  }
  return { queued };
}

/* -------------------------------------------------------------- accounts */

function accountsStatus() {
  const counts = vaultCopies.countsByAccount();
  const free = new Map(allocation.snapshot().map((a) => [a.id, a.free]));
  const chosen = vaultAccounts.list().map((entry) => ({
    accountId: entry.account_id,
    email: entry.email,
    state: entry.state,
    health: entry.auth_state === "ok" ? "ok" : "unavailable",
    authState: entry.auth_state,
    freeBytes: free.get(entry.account_id) ?? null,
    okCopies: counts[entry.account_id]?.ok || 0,
    pendingCopies:
      (counts[entry.account_id]?.pending || 0) +
      (counts[entry.account_id]?.uploading || 0),
    failedCopies: counts[entry.account_id]?.failed || 0,
    lastOkAt: entry.last_ok_at,
    lastError: entry.last_error,
  }));
  const chosenIds = new Set(chosen.map((c) => c.accountId));
  const available = accounts
    .list()
    .filter((a) => !chosenIds.has(a.id))
    .map((a) => ({ accountId: a.id, email: a.email, authState: a.auth_state }));
  return { accounts: chosen, available };
}

async function addAccount(accountId) {
  const account = accounts.byId(accountId);
  if (!account) throw fail("Unknown account.", "NO_ACCOUNT");
  if (vaultAccounts.get(accountId)) return accountsStatus();
  await accountService.ensureVaultFolder(accountId);
  vaultAccounts.insert({ account_id: accountId });
  await publishConfig().catch((err) =>
    log.warn(`config publish failed: ${err.message}`),
  );
  changed();
  reconcile().catch((err) => log.warn(`reconcile failed: ${err.message}`));
  return accountsStatus();
}

/** What the user is about to lose - surfaced before anything is touched. */
function removalImpact(accountId) {
  const vmk = session.isUnlocked() ? session.getVmk() : null;
  const impact = planner.removalImpact({
    items: vaultItems.all(),
    copies: vaultCopies.all(),
    accountId,
  });
  const others = vaultAccounts
    .list()
    .filter((a) => a.account_id !== accountId && a.auth_state === "ok");
  return {
    totalHere: impact.totalHere,
    soleCount: impact.soleItems.length,
    // Names only when unlocked; a locked vault must not leak file names.
    soleNames: vmk
      ? impact.soleItems.slice(0, 8).map((i) => metaOf(i, vmk).name)
      : [],
    canDrain: others.length > 0,
  };
}

/**
 * `drain` re-replicates elsewhere first and removes the account once nothing
 * of ours is left; `force` removes it now and accepts the loss of access.
 */
async function removeAccount(
  accountId,
  { mode = "drain", deleteRemote = false } = {},
) {
  const entry = vaultAccounts.get(accountId);
  if (!entry) return accountsStatus();

  if (mode === "drain") {
    vaultAccounts.update(accountId, { state: "draining" });
    changed();
    reconcile().catch((err) => log.warn(`drain failed: ${err.message}`));
    return accountsStatus();
  }

  if (deleteRemote) {
    for (const copy of vaultCopies.forAccount(accountId)) {
      if (!copy.drive_file_id) continue;
      await drive
        .deleteFile(accountId, copy.drive_file_id)
        .catch((err) =>
          log.warn(`could not delete vault blob: ${err.message}`),
        );
    }
  }
  for (const copy of vaultCopies.forAccount(accountId)) {
    // Keep the row when the blob survives - recovery can still find it.
    if (deleteRemote) vaultCopies.remove(copy.item_id, accountId);
    else
      vaultCopies.setState(
        copy.item_id,
        accountId,
        "missing",
        "account removed from vault",
      );
  }
  vaultAccounts.remove(accountId);
  changed();
  return accountsStatus();
}

/* ------------------------------------------------------------ reconcile */

let reconciling = false;

/**
 * Bring reality in line with the plan: create missing replicas, retire
 * surplus ones, finish drains. Runs sequentially - Drive traffic in this app
 * is deliberately one request at a time.
 */
async function reconcile() {
  if (reconciling) return;
  reconciling = true;
  try {
    const actions = planner.plan({
      items: vaultItems.all(),
      copies: vaultCopies.all(),
      accounts: accountSnapshot(),
      desiredCopies: desiredCopies(),
    });
    for (const action of actions) {
      if (action.type === "drainComplete") {
        vaultAccounts.remove(action.accountId);
        log.info(`vault account ${action.accountId} drained and removed`);
        changed();
      } else if (action.type === "deleteCopy") {
        const copy = vaultCopies.get(action.itemId, action.accountId);
        if (copy?.drive_file_id) {
          await drive
            .deleteFile(action.accountId, copy.drive_file_id)
            .catch((err) =>
              log.warn(`could not remove surplus copy: ${err.message}`),
            );
        }
        vaultCopies.remove(action.itemId, action.accountId);
        changed();
      } else if (action.type === "replicate") {
        await startReplication(action);
      }
    }
  } finally {
    reconciling = false;
  }
}

/**
 * Copy an existing blob to another account. This works on ciphertext, so it
 * runs happily while the vault is locked - no master key involved.
 */
async function startReplication(action) {
  const item = vaultItems.byId(action.itemId);
  if (!item || item.is_folder) return;
  const tempPath = storage.tempBlobPath(item.blob_uuid);

  if (!fs.existsSync(tempPath)) {
    if (!action.fromAccountId) return; // nothing to copy from yet
    const source = vaultCopies.get(item.id, action.fromAccountId);
    if (!source?.drive_file_id) return;
    const { downloadToPath } = require("../drive/downloader.cjs");
    await downloadToPath(
      {
        accountId: action.fromAccountId,
        driveFileId: source.drive_file_id,
        size: item.blob_size || 0,
        md5: item.blob_md5,
        targetPath: tempPath,
      },
      {},
    );
  }

  vaultCopies.upsert({
    item_id: item.id,
    account_id: action.toAccountId,
    state: "pending",
  });
  queue.enqueue({
    kind: "vaultUp",
    name: `secure-${item.blob_uuid}.mxv`,
    size: item.blob_size || 0,
    localPath: tempPath,
    accountId: action.toAccountId,
    priority: UPLOAD_PRIORITY,
    meta: {
      itemId: item.id,
      accountId: action.toAccountId,
      blobUuid: item.blob_uuid,
      blobMd5: item.blob_md5,
      replica: true,
    },
  });
}

/**
 * Called by the upload worker when a copy lands. Once no copy of an item is
 * still in flight the shared temp blob has no further readers.
 */
function onCopyComplete(itemId) {
  const item = vaultItems.byId(itemId);
  if (!item) return;
  const copies = vaultCopies.forItem(itemId);
  const inFlight = copies.some(
    (c) => c.state === "pending" || c.state === "uploading",
  );
  if (!inFlight) {
    vaultItems.update(itemId, { state: "active" });
    if (item.blob_uuid)
      storage.removeQuietly(storage.tempBlobPath(item.blob_uuid));
    scheduleSnapshot();
    // The renderer keys its spinner off the progress map, not off item state,
    // so the row would keep saying "Uploading" until the page remounted.
    emitProgress({ itemId, phase: "done", pct: 100 });
  }
  changed();
}

/**
 * The other terminal outcome. The temp blob is deliberately kept: it is what a
 * retry uploads from, so deleting it here would turn a failed upload into a
 * lost file.
 */
function onCopyFailed(itemId) {
  const item = vaultItems.byId(itemId);
  if (!item) return;
  const inFlight = vaultCopies
    .forItem(itemId)
    .some((c) => c.state === "pending" || c.state === "uploading");
  if (!inFlight) {
    vaultItems.update(itemId, { state: "failed" });
    emitProgress({ itemId, phase: "done", pct: 0 });
  }
  changed();
}

/* -------------------------------------------------------------- snapshot */

let snapshotTimer = null;
const SNAPSHOT_DEBOUNCE_MS = 30_000;

/**
 * The encrypted index uploaded alongside the blobs. Without it a recovered
 * vault would have the file contents but not their names or folder shape.
 */
function scheduleSnapshot() {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    publishSnapshot().catch((err) =>
      log.warn(`snapshot failed: ${err.message}`),
    );
  }, SNAPSHOT_DEBOUNCE_MS);
  snapshotTimer.unref?.();
}

async function publishSnapshot() {
  if (!session.isUnlocked()) return; // needs the key to encrypt the index
  const vmk = session.getVmk();
  const items = vaultItems.all().map((item) => ({
    id: item.id,
    parentId: item.parent_id,
    isFolder: item.is_folder,
    meta: metaOf(item, vmk),
    size: item.size,
    blobUuid: item.blob_uuid,
    blobSize: item.blob_size,
    chunkSize: item.chunk_size,
    blobMd5: item.blob_md5,
    plaintextSha256: item.plaintext_sha256,
    createdAt: item.created_at,
    modifiedAt: item.modified_at,
  }));
  const payload = crypto.encryptMeta(vmk, {
    version: 1,
    at: Date.now(),
    items,
  });

  for (const entry of vaultAccounts.list()) {
    if (entry.auth_state !== "ok") continue;
    try {
      const folderId = await accountService.ensureVaultFolder(entry.account_id);
      const existing = await drive.listChildren(entry.account_id, folderId);
      await drive.uploadSmall(entry.account_id, {
        name: "index.snap",
        parentId: folderId,
        buffer: payload,
      });
      for (const file of existing.filter((f) => f.name === "index.snap")) {
        await drive.deleteFile(entry.account_id, file.id).catch(() => {});
      }
      vaultAccounts.update(entry.account_id, {
        last_ok_at: Date.now(),
        last_error: null,
      });
    } catch (err) {
      vaultAccounts.update(entry.account_id, { last_error: err.message });
      log.warn(`snapshot to ${entry.email} failed: ${err.message}`);
    }
  }
}

/* --------------------------------------------------------------- status */

function status() {
  const sessionStatus = session.status();
  return {
    configured: configured(),
    ...sessionStatus,
    settings: getSettings(),
    ...accountsStatus(),
    itemCount: configured() ? vaultItems.count() : 0,
  };
}

/* ------------------------------------------------------- lifecycle */

function start() {
  session.setNotifier((event) => notify(event));
  session.setAutolockMinutes(autolockMinutes());

  // Periodic reconcile catches the cases no single event covers: an account
  // that came back online, a copy deleted from Drive by hand, a replication
  // that was blocked on quota when it was first planned. It works on
  // ciphertext, so it runs whether or not the vault is unlocked.
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = setInterval(() => {
    if (!configured() || !vaultAccounts.ids().length) return;
    reconcile().catch((err) => log.warn(`reconcile failed: ${err.message}`));
  }, RECONCILE_MS);
  reconcileTimer.unref?.();

  // A temp blob is only wanted while some copy of its item is still in flight.
  const wanted = new Set();
  for (const item of vaultItems.all()) {
    if (!item.blob_uuid) continue;
    const copies = vaultCopies.forItem(item.id);
    if (copies.some((c) => c.state === "pending" || c.state === "uploading"))
      wanted.add(`${item.blob_uuid}.mxv`);
  }
  storage.sweepTemp((name) => wanted.has(name));

  // Items whose upload died with the app: without a temp blob there is nothing
  // to resume from, so mark them clearly rather than leaving a ghost row.
  for (const item of vaultItems.byState("uploading")) {
    if (!item.blob_uuid) continue;
    if (fs.existsSync(storage.tempBlobPath(item.blob_uuid))) continue;
    const copies = vaultCopies.forItem(item.id);
    if (copies.some((c) => c.state === "ok")) {
      vaultItems.update(item.id, { state: "active" });
    } else {
      for (const copy of copies)
        vaultCopies.setState(
          item.id,
          copy.account_id,
          "failed",
          "interrupted before upload",
        );
      vaultItems.update(item.id, { state: "failed" });
    }
  }
}

function stop() {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = null;
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = null;
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  session.lock("quit");
}

module.exports = {
  setNotifier,
  start,
  stop,
  status,
  // lifecycle
  setup,
  unlock,
  lock,
  changePassword,
  regenerateRecoveryKey,
  // items
  list,
  breadcrumbs,
  details,
  createFolder,
  rename,
  remove,
  uploadFiles,
  download,
  // accounts + placement
  accountsStatus,
  addAccount,
  removalImpact,
  removeAccount,
  onCopyComplete,
  onCopyFailed,
  // settings
  getSettings,
  setSettings,
  emitProgress,
  metaOf,
};
