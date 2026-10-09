const { contextBridge, ipcRenderer, webUtils } = require("electron");

/** Unwraps the { ok, data | error } envelope so callers can just await a value. */
async function call(channel, payload) {
  const res = await ipcRenderer.invoke(channel, payload);
  if (res?.ok) return res.data;
  const err = new Error(res?.error?.message || `${channel} failed`);
  err.code = res?.error?.code || "INTERNAL";
  if (res?.error?.retryAfterMs) err.retryAfterMs = res.error.retryAfterMs;
  throw err;
}

/** Subscribes to a main-process event; returns an unsubscribe function. */
function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Window chrome - unchanged one-way channels used by the titlebar.
contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  isDev: process.env.NODE_ENV === "development",
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
  beginDrag: () => ipcRenderer.send("window-begin-drag"),
  onWindowState: (callback) => on("window-state", callback),
});

contextBridge.exposeInMainWorld("maxdrive", {
  app: {
    info: () => call("app:info"),
  },

  settings: {
    get: () => call("settings:get"),
    set: (patch) => call("settings:set", patch),
  },

  auth: {
    // Resolve to { ready, source } - never the client ID or secret.
    credentials: () => call("auth:credentials"),
    setCredentials: (input) => call("auth:setCredentials", input),
  },

  // Vault mode: its own key, separate from the Secure vault. The renderer
  // only ever sees status and decrypted results - never key material.
  seal: {
    status: () => call("seal:status"),
    setup: (password) => call("seal:setup", { password }),
    unlock: (secret, recovery = false) => call("seal:unlock", { secret, recovery }),
    lock: () => call("seal:lock"),
    changePassword: (current, next) => call("seal:changePassword", { current, next }),
    setEnabled: (enabled) => call("seal:setEnabled", { enabled }),
    setAutolock: (minutes) => call("seal:setAutolock", { minutes }),
  },

  accounts: {
    list: () => call("accounts:list"),
    connect: () => call("accounts:connect"),
    connectS3: (input) => call("accounts:connectS3", input),
    updateS3: (accountId, patch) =>
      call("accounts:updateS3", { accountId, ...patch }),
    reauth: (accountId) => call("accounts:reauth", { accountId }),
    disconnect: (accountId, purge) =>
      call("accounts:disconnect", { accountId, purge }),
    disconnectImpact: (accountId) =>
      call("accounts:disconnectImpact", { accountId }),
    refreshQuota: (accountId, force) =>
      call("accounts:refreshQuota", { accountId, force }),
  },

  sync: {
    scan: (accountId) => call("sync:scan", { accountId }),
  },

  index: {
    backupNow: () => call("index:backupNow"),
    status: () => call("index:status"),
    listRestoreCandidates: () => call("index:listRestoreCandidates"),
    restoreFrom: (accountId, fileId, name) =>
      call("index:restoreFrom", { accountId, fileId, name }),
  },

  localBackup: {
    listSets: () => call("localBackup:listSets"),
    createSet: (payload) => call("localBackup:createSet", payload),
    updateSet: (id, patch) => call("localBackup:updateSet", { id, patch }),
    deleteSet: (id, removeRemote) =>
      call("localBackup:deleteSet", { id, removeRemote }),
    runNow: (setId) => call("localBackup:runNow", { setId }),
    confirmDeletions: (setId) =>
      call("localBackup:confirmDeletions", { setId }),
    pauseSet: (setId) => call("localBackup:pauseSet", { setId }),
    resumeSet: (setId) => call("localBackup:resumeSet", { setId }),
    setGlobalPaused: (paused) =>
      call("localBackup:setGlobalPaused", { paused }),
    status: () => call("localBackup:status"),
    tree: (setId, prefix) => call("localBackup:tree", { setId, prefix }),
    restore: (payload) => call("localBackup:restore", payload),
  },

  // Secure Storage. Note what is absent: nothing here returns a key, and the
  // master password only ever travels one way (renderer → main).
  vault: {
    status: () => call("vault:status"),
    setup: (password) => call("vault:setup", { password }),
    unlock: (secret, recovery = false) =>
      call("vault:unlock", { secret, recovery }),
    lock: () => call("vault:lock"),
    // `oldSecret` is either the current password or the recovery key.
    changePassword: (oldSecret, newPassword, recovery = false) =>
      call("vault:changePassword", { oldSecret, newPassword, recovery }),
    regenerateRecoveryKey: (secret, recovery = false) =>
      call("vault:regenerateRecoveryKey", { secret, recovery }),
    saveRecoveryKey: (recoveryKey, kind = "vault") =>
      call("vault:saveRecoveryKey", { recoveryKey, kind }),
    list: (parentId) => call("vault:items:list", { parentId }),
    details: (id) => call("vault:items:details", { id }),
    newFolder: (parentId, name) =>
      call("vault:items:newFolder", { parentId, name }),
    rename: (id, name) => call("vault:items:rename", { id, name }),
    remove: (ids) => call("vault:items:delete", { ids }),
    upload: (paths, parentId) => call("vault:upload", { paths, parentId }),
    download: (ids, destDir) => call("vault:download", { ids, destDir }),
    accounts: () => call("vault:accounts:list"),
    addAccount: (accountId) => call("vault:accounts:add", { accountId }),
    removalImpact: (accountId) =>
      call("vault:accounts:removalImpact", { accountId }),
    removeAccount: (accountId, mode, deleteRemote) =>
      call("vault:accounts:remove", { accountId, mode, deleteRemote }),
    getSettings: () => call("vault:settings:get"),
    setSettings: (patch) => call("vault:settings:set", patch),
    recoverScan: () => call("vault:recover:scan"),
    recoverRun: (secret, recovery = false) =>
      call("vault:recover:run", { secret, recovery }),
  },

  share: {
    createLink: (nodeId) => call("share:createLink", { nodeId }),
    revoke: (nodeId) => call("share:revoke", { nodeId }),
    listPermissions: (nodeId) => call("share:listPermissions", { nodeId }),
    addPerson: (nodeId, email, role, notify) =>
      call("share:addPerson", { nodeId, email, role, notify }),
    removePermission: (nodeId, permissionId) =>
      call("share:removePermission", { nodeId, permissionId }),
  },

  ops: {
    mkdir: (parentId, name) => call("ops:mkdir", { parentId, name }),
    rename: (id, name) => call("ops:rename", { id, name }),
    move: (ids, newParentId) => call("ops:move", { ids, newParentId }),
    copy: (ids, newParentId) => call("ops:copy", { ids, newParentId }),
    trash: (ids) => call("ops:trash", { ids }),
    restore: (ids) => call("ops:restore", { ids }),
    deleteForever: (ids) => call("ops:deleteForever", { ids }),
    star: (id, starred) => call("ops:star", { id, starred }),
  },

  transfers: {
    list: () => call("transfers:list"),
    // Picked or dropped files and folders, sorted out in the main process.
    enqueuePaths: (paths, destParentId) =>
      call("transfers:enqueuePaths", { paths, destParentId }),
    enqueueDownload: (nodeId, targetDir) =>
      call("transfers:enqueueDownload", { nodeId, targetDir }),
    enqueueMigration: (nodeId, targetAccountId) =>
      call("transfers:enqueueMigration", { nodeId, targetAccountId }),
    pause: (id) => call("transfers:pause", { id }),
    resume: (id) => call("transfers:resume", { id }),
    cancel: (id) => call("transfers:cancel", { id }),
    retry: (id) => call("transfers:retry", { id }),
    remove: (id) => call("transfers:remove", { id }),
    clearCompleted: () => call("transfers:clearCompleted"),
    pauseAll: () => call("transfers:pauseAll"),
    resumeAll: () => call("transfers:resumeAll"),
  },

  nodes: {
    children: (parentId, sort) => call("nodes:children", { parentId, sort }),
    path: (id) => call("nodes:path", { id }),
    search: (q, limit) => call("nodes:search", { q, limit }),
    recent: (limit) => call("nodes:recent", { limit }),
    starred: (limit) => call("nodes:starred", { limit }),
    trashed: (limit) => call("nodes:trashed", { limit }),
    activity: (id) => call("nodes:activity", { id }),
  },

  // LAN server + device pairing. No secrets cross this bridge - the renderer
  // drives pairing and sees only device metadata + connection status.
  server: {
    status: () => call("server:status"),
    enable: () => call("server:enable"),
    disable: () => call("server:disable"),
    startPairing: () => call("server:startPairing"),
    cancelPairing: () => call("server:cancelPairing"),
    approvePairing: (deviceId) => call("server:approvePairing", { deviceId }),
    denyPairing: (deviceId) => call("server:denyPairing", { deviceId }),
    listDevices: () => call("server:listDevices"),
    revokeDevice: (id) => call("server:revokeDevice", { id }),
    createMcpToken: (name) => call("server:createMcpToken", { name }),
  },

  shell: {
    openExternal: (url) => call("shell:openExternal", { url }),
    showInFolder: (path) => call("shell:showInFolder", { path }),
  },

  dialog: {
    pickFiles: () => call("dialog:pickFiles"),
    pickFolder: () => call("dialog:pickFolder"),
  },

  // File.path was removed in Electron 32; this is the only way to turn a
  // dropped File into a path, and it must happen here in the preload.
  getPathForFile: (file) => webUtils.getPathForFile(file),

  on: {
    accountsChanged: (cb) => on("accounts:changed", cb),
    nodesChanged: (cb) => on("nodes:changed", cb),
    transfersProgress: (cb) => on("transfers:progress", cb),
    transfersState: (cb) => on("transfers:state", cb),
    syncStatus: (cb) => on("sync:status", cb),
    backupStatus: (cb) => on("backup:status", cb),
    localBackupChanged: (cb) => on("localBackup:changed", cb),
    localBackupProgress: (cb) => on("localBackup:progress", cb),
    vaultChanged: (cb) => on("vault:changed", cb),
    vaultProgress: (cb) => on("vault:progress", cb),
    vaultLockChanged: (cb) => on("vault:lockChanged", cb),
    sealChanged: (cb) => on("seal:changed", cb),
    serverChanged: (cb) => on("server:changed", cb),
    serverPairingState: (cb) => on("server:pairingState", cb),
    serverPairingRequest: (cb) => on("server:pairingRequest", cb),
  },
});
