/**
 * Central IPC registry. Handlers stay thin: validate, delegate, return.
 * Every handler resolves to { ok: true, data } or { ok: false, error }.
 */
const fs = require("node:fs");
const path = require("node:path");
const { ipcMain, shell, dialog, app } = require("electron");
const { accounts, nodes, activity, NODE_SELECT } = require("./db/queries.cjs");
const sealMode = require("./vault/sealMode.cjs");
const { MANAGED_ROOT_ID } = require("./db/database.cjs");
const scanner = require("./sync/scanner.cjs");
const backup = require("./sync/backup.cjs");
const localBackup = require("./localBackup/index.cjs");
const localRestore = require("./localBackup/restore.cjs");
const vault = require("./vault/index.cjs");
const vaultRecovery = require("./vault/recovery.cjs");
const share = require("./drive/share.cjs");
const ops = require("./ops.cjs");
const { getWindow } = require("./window.cjs");
const settingsStore = require("./settings.cjs");
const credentials = require("./auth/credentials.cjs");
const accountService = require("./auth/accountService.cjs");
const { queue } = require("./transfers/queue.cjs");
const lanServer = require("./server/index.cjs");
const { scope } = require("./logger.cjs");

const log = scope("ipc");

/**
 * Every result passes through sealMode.reveal: vault-mode rows lose their
 * sealed blob and, while unlocked, get their real names back. One choke point,
 * so no node-returning channel can forget it.
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: sealMode.reveal(await fn(payload ?? {})) };
    } catch (err) {
      log.error(`${channel} failed`, err);
      return {
        ok: false,
        error: {
          code: err.code || "INTERNAL",
          message: err.message,
          retryAfterMs: err.retryAfterMs,
        },
      };
    }
  });
}

/**
 * Mirrors a local folder tree into virtual folders and queues every file in it.
 * @returns {number} how many files were queued
 */
function enqueueFolderTree(folderPath, destParentId) {
  const root = ops.mkdir({
    parentId: destParentId,
    name: path.basename(folderPath),
  });
  let queued = 0;

  const walk = (dir, parentNodeId) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, ops.mkdir({ parentId: parentNodeId, name: entry.name }).id);
      } else if (entry.isFile()) {
        queue.enqueueUpload(full, parentNodeId);
        queued += 1;
      }
    }
  };
  walk(folderPath, root.id);
  return queued;
}

/** Every non-folder node beneath a folder, at any depth. */
function descendantFiles(rootId) {
  return ops.subtree(rootId).filter((n) => !n.is_folder && !n.trashed);
}

function registerIpc() {
  /* ------------------------------------------------------------------ app */

  handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath("userData"),
    managedRootId: MANAGED_ROOT_ID,
  }));

  /* ------------------------------------------------------------- settings */

  handle("settings:get", () => settingsStore.all());

  handle("settings:set", (patch) => settingsStore.set(patch));

  /* ------------------------------------------------------------ transfers */

  handle("transfers:list", () => queue.listVisible());

  /**
   * Picked or dropped paths, a mixed bag of files and folders. Sorting them out
   * here rather than in the renderer keeps the filesystem probing in one place.
   */
  handle("transfers:enqueuePaths", ({ paths = [], destParentId }) => {
    destParentId = destParentId || MANAGED_ROOT_ID; // null slips past defaults
    let files = 0;
    let folders = 0;

    for (const target of paths) {
      let stat;
      try {
        stat = fs.statSync(target);
      } catch {
        continue; // vanished between the drop and now
      }
      if (stat.isDirectory()) {
        folders += 1;
        files += enqueueFolderTree(target, destParentId);
      } else if (stat.isFile()) {
        queue.enqueueUpload(target, destParentId, { size: stat.size });
        files += 1;
      }
    }

    return { files, folders };
  });

  handle("transfers:enqueueDownload", async ({ nodeId, targetDir }) => {
    const node = nodes.byId(nodeId);
    if (!node) throw new Error("That file is no longer indexed.");
    const dir = targetDir || app.getPath("downloads");
    // A sealed file's real name only exists while vault mode is unlocked;
    // realMeta throws SEAL_LOCKED otherwise, which the UI turns into a prompt.
    const name = node.seal_meta ? sealMode.realMeta(node).name : node.name;
    const id = queue.enqueue({
      kind: "download",
      name,
      size: node.size ?? 0,
      localPath: path.join(dir, name),
      accountId: node.account_id,
      nodeId,
      meta: node.seal_meta ? { sealed: true } : null,
    });
    return { id };
  });

  handle("transfers:pause", ({ id }) => queue.pause(id));

  handle("transfers:resume", ({ id }) => queue.resume(id));

  handle("transfers:cancel", ({ id }) => queue.cancel(id));

  handle("transfers:retry", ({ id }) => queue.retry(id));

  handle("transfers:remove", ({ id }) => ({ removed: queue.remove(id) }));

  handle("transfers:clearCompleted", () => queue.clearCompleted());

  handle("transfers:pauseAll", () => queue.pauseAll());

  handle("transfers:resumeAll", () => queue.resumeAll());

  /* ------------------------------------------------------------ vault mode */

  handle("seal:status", () => sealMode.status());

  // The recovery key comes back once, here, and is never stored.
  handle("seal:setup", ({ password }) => sealMode.setup(password));

  handle("seal:unlock", ({ secret, recovery }) =>
    sealMode.unlock(secret, { recovery: Boolean(recovery) }),
  );

  handle("seal:lock", () => sealMode.lock());

  handle("seal:changePassword", ({ current, next }) =>
    sealMode.changePassword(current, next),
  );

  handle("seal:setEnabled", ({ enabled }) => sealMode.setEnabled(Boolean(enabled)));

  handle("seal:setAutolock", ({ minutes }) => sealMode.setAutolock(minutes));

  /* ---------------------------------------------------- oauth credentials */

  // The renderer can write credentials but only ever reads back
  // { ready, source } - never the ID or the secret.
  handle("auth:credentials", () => credentials.status());

  handle("auth:setCredentials", (input) => credentials.set(input));

  /* ------------------------------------------------------------- accounts */

  handle("accounts:list", () => accounts.list());

  handle("accounts:connect", () => accountService.connect());

  // S3 secrets go in, never come back out: rows carry only the non-secret config.
  handle("accounts:connectS3", (input) => accountService.connectS3(input));

  handle("accounts:updateS3", (input) => accountService.updateS3(input));

  handle("accounts:reauth", ({ accountId }) =>
    accountService.reauth({ accountId }),
  );

  handle("accounts:disconnect", ({ accountId, purge }) =>
    accountService.disconnect({ accountId, purge }),
  );

  handle("accounts:disconnectImpact", ({ accountId }) =>
    accountService.disconnectImpact(accountId),
  );

  handle("accounts:refreshQuota", ({ accountId, force } = {}) =>
    accountId
      ? accountService.refreshQuota(accountId, { force })
      : accountService.refreshAllQuotas({ force }),
  );

  /* ----------------------------------------------------------------- sync */

  handle("sync:scan", ({ accountId } = {}) =>
    accountId ? scanner.scanAccount(accountId) : scanner.scanAll(),
  );

  /* ------------------------------------------------------------------ ops */

  handle("ops:mkdir", ({ parentId, name }) => ops.mkdir({ parentId, name }));

  handle("ops:rename", ({ id, name }) => ops.rename({ id, name }));

  handle("ops:move", ({ ids, newParentId }) => ops.move({ ids, newParentId }));

  handle("ops:copy", ({ ids, newParentId }) => ops.copy({ ids, newParentId }));

  handle("ops:trash", ({ ids }) => ops.trash({ ids }));

  handle("ops:restore", ({ ids }) => ops.restore({ ids }));

  handle("ops:deleteForever", ({ ids }) => ops.deleteForever({ ids }));

  handle("ops:star", ({ id, starred }) => ops.star({ id, starred }));

  handle("nodes:activity", ({ id }) => activity.forNode(id));

  /* ---------------------------------------------------------------- nodes */

  handle("nodes:children", ({ parentId = MANAGED_ROOT_ID, sort = "name" }) => {
    const rows = nodes.children(parentId, sort);
    // SQL sorted sealed rows by their placeholder; re-sort on the real names.
    if (sort !== "name" || !sealMode.isUnlocked() || !rows.some((r) => r.seal_meta)) {
      return rows;
    }
    return sealMode
      .reveal(rows)
      .sort(
        (a, b) =>
          b.is_folder - a.is_folder ||
          a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
      );
  });

  handle("nodes:path", ({ id }) => nodes.path(id));

  // Sealed names are never in the DB, so they're matched in memory while unlocked.
  handle("nodes:search", ({ q = "", limit = 200 }) =>
    [...sealMode.searchSealed(q, NODE_SELECT), ...nodes.search(q, limit)].slice(0, limit),
  );

  handle("nodes:recent", ({ limit = 50 } = {}) => nodes.recent(limit));

  handle("nodes:starred", ({ limit = 200 } = {}) => nodes.starred(limit));

  handle("nodes:trashed", ({ limit = 500 } = {}) => nodes.trashed(limit));

  /* ---------------------------------------------------------------- index */

  handle("index:backupNow", () => backup.backupNow("manual"));

  handle("index:status", () => backup.status());

  handle("index:listRestoreCandidates", () => backup.listRestoreCandidates());

  handle("index:restoreFrom", async ({ accountId, fileId, name }) => {
    const result = await backup.restoreFrom({ accountId, fileId, name });
    // The restored index predates this moment; reconcile it against reality.
    scanner
      .scanAll()
      .catch((err) => log.warn(`post-restore scan: ${err.message}`));
    return result;
  });

  /* --------------------------------------------------- local folder backup */

  handle("localBackup:listSets", () => localBackup.listSets());

  handle("localBackup:createSet", (payload) => localBackup.createSet(payload));

  handle("localBackup:updateSet", ({ id, patch }) =>
    localBackup.updateSet(id, patch),
  );

  handle("localBackup:deleteSet", ({ id, removeRemote }) =>
    localBackup.deleteSet(id, { removeRemote }),
  );

  handle("localBackup:runNow", ({ setId }) => localBackup.runNow(setId));

  handle("localBackup:confirmDeletions", ({ setId }) =>
    localBackup.confirmDeletions(setId),
  );

  handle("localBackup:pauseSet", ({ setId }) => localBackup.pauseSet(setId));

  handle("localBackup:resumeSet", ({ setId }) => localBackup.resumeSet(setId));

  handle("localBackup:setGlobalPaused", ({ paused }) =>
    localBackup.setGlobalPaused(paused),
  );

  handle("localBackup:status", () => localBackup.status());

  handle("localBackup:tree", ({ setId, prefix }) =>
    localRestore.tree(setId, prefix),
  );

  handle("localBackup:restore", ({ setId, paths, overwrite, includeTrashed }) =>
    localRestore.restore({ setId, paths, overwrite, includeTrashed }),
  );

  /* --------------------------------------------------------- secure vault */

  handle("vault:status", () => vault.status());

  handle("vault:setup", ({ password }) => vault.setup(password));

  handle("vault:unlock", ({ secret, recovery }) =>
    vault.unlock(secret, { recovery }),
  );

  handle("vault:lock", () => vault.lock());

  handle("vault:changePassword", ({ oldSecret, newPassword, recovery }) =>
    vault.changePassword(oldSecret, newPassword, { recovery }),
  );

  handle("vault:regenerateRecoveryKey", ({ secret, recovery }) =>
    vault.regenerateRecoveryKey(secret, { recovery }),
  );

  handle("vault:saveRecoveryKey", async ({ recoveryKey, kind = "vault" }) => {
    const label = kind === "seal" ? "Vault mode" : "Secure Storage";
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: `Save your ${label} recovery key`,
      defaultPath: `MaxDrive ${label} recovery key.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (canceled || !filePath) return { saved: false };
    fs.writeFileSync(
      filePath,
      [
        `MaxDrive - ${label} recovery key`,
        "",
        "This key unlocks it if you forget the password.",
        "Anyone holding it can open your encrypted files. Keep it offline.",
        "",
        recoveryKey,
        "",
        `Saved ${new Date().toLocaleString()}`,
        "",
      ].join("\r\n"),
      "utf8",
    );
    return { saved: true, path: filePath };
  });

  handle("vault:items:list", ({ parentId }) => ({
    items: vault.list(parentId || null),
    breadcrumbs: vault.breadcrumbs(parentId || null),
  }));

  handle("vault:items:details", ({ id }) => vault.details(id));

  handle("vault:items:newFolder", ({ parentId, name }) =>
    vault.createFolder(parentId || null, name),
  );

  handle("vault:items:rename", ({ id, name }) => vault.rename(id, name));

  handle("vault:items:delete", ({ ids }) => vault.remove(ids));

  handle("vault:upload", ({ paths, parentId }) =>
    vault.uploadFiles(paths, parentId || null),
  );

  handle("vault:download", async ({ ids, destDir }) => {
    let target = destDir;
    if (!target) {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: "Where should the files go?",
        properties: ["openDirectory", "createDirectory"],
      });
      if (canceled || !filePaths?.length) return { queued: [] };
      [target] = filePaths;
    }
    return vault.download(ids, target);
  });

  handle("vault:accounts:list", () => vault.accountsStatus());

  handle("vault:accounts:add", ({ accountId }) => vault.addAccount(accountId));

  handle("vault:accounts:removalImpact", ({ accountId }) =>
    vault.removalImpact(accountId),
  );

  handle("vault:accounts:remove", ({ accountId, mode, deleteRemote }) =>
    vault.removeAccount(accountId, { mode, deleteRemote }),
  );

  handle("vault:settings:get", () => vault.getSettings());

  handle("vault:settings:set", (patch) => vault.setSettings(patch));

  handle("vault:recover:scan", () => vaultRecovery.scan());

  handle("vault:recover:run", ({ secret, recovery, accountId }) =>
    vaultRecovery.run({ secret, recovery, accountId }),
  );

  /* ---------------------------------------------------------------- share */

  handle("share:createLink", ({ nodeId }) => share.createLink({ nodeId }));

  handle("share:revoke", ({ nodeId }) => share.revoke({ nodeId }));

  handle("share:listPermissions", ({ nodeId }) =>
    share.listPermissions({ nodeId }),
  );

  handle("share:addPerson", ({ nodeId, email, role, notify }) =>
    share.addPerson({ nodeId, email, role, notify }),
  );

  handle("share:removePermission", ({ nodeId, permissionId }) =>
    share.removePermission({ nodeId, permissionId }),
  );

  /* -------------------------------------------------------------- migrate */

  handle("transfers:enqueueMigration", ({ nodeId, targetAccountId }) => {
    const node = nodes.byId(nodeId);
    if (!node) throw new Error("That item is no longer indexed.");

    // A folder migrates as one job per file inside it. The virtual tree stays
    // exactly where it is - only the bytes change accounts.
    const files = node.is_folder ? descendantFiles(nodeId) : [node];
    const movable = files.filter(
      (f) =>
        f.drive_file_id && !f.is_google_doc && f.account_id !== targetAccountId,
    );
    if (!movable.length) {
      throw new Error(
        node.is_folder
          ? "Nothing in that folder can be moved (empty, already there, or Google Docs)."
          : "That file can't be moved between accounts.",
      );
    }

    const ids = movable.map((file) =>
      queue.enqueue({
        kind: "migrate",
        name: file.name,
        size: file.size ?? 0,
        accountId: targetAccountId, // target; the source is on the node itself
        nodeId: file.id,
      }),
    );
    return { queued: ids.length, skipped: files.length - movable.length, ids };
  });

  /* -------------------------------------------------- LAN server / devices */

  handle("server:status", () => lanServer.status());

  handle("server:enable", () => lanServer.enable());

  handle("server:disable", () => lanServer.disable());

  handle("server:startPairing", () => lanServer.startPairing());

  handle("server:cancelPairing", () => lanServer.cancelPairing());

  handle("server:approvePairing", ({ deviceId }) =>
    lanServer.approvePairing(deviceId),
  );

  handle("server:denyPairing", ({ deviceId }) =>
    lanServer.denyPairing(deviceId),
  );

  handle("server:listDevices", () => lanServer.listDevices());

  handle("server:revokeDevice", ({ id }) => lanServer.revokeDevice(id));

  handle("server:createMcpToken", ({ name } = {}) =>
    lanServer.createMcpToken(name),
  );

  /* ---------------------------------------------------------------- shell */

  handle("shell:openExternal", ({ url }) => {
    // Only ever hand http(s) to the OS browser.
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`refusing to open ${parsed.protocol} url`);
    }
    return shell.openExternal(url);
  });

  handle("shell:showInFolder", ({ path: target }) => {
    shell.showItemInFolder(target);
  });

  /* --------------------------------------------------------------- dialog */

  handle("dialog:pickFiles", async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: ["openFile", "multiSelections"],
    });
    return result.canceled ? [] : result.filePaths;
  });

  handle("dialog:pickFolder", async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  log.info("ipc handlers registered");
}

module.exports = { registerIpc };
