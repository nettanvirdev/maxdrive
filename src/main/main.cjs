const { app, BrowserWindow, powerMonitor } = require("electron");
const { scope } = require("./logger.cjs");
// Before anything reads process.env - credentials.cjs depends on this.
require("./env.cjs").load();
const database = require("./db/database.cjs");
const settingsStore = require("./settings.cjs");
const { queue } = require("./transfers/queue.cjs");
const { createTray, destroyTray } = require("./tray.cjs");
const {
  createWindow,
  registerWindowIpc,
  getWindow,
  showWindow,
  send,
  setLanBroadcast,
} = require("./window.cjs");
const { registerIpc } = require("./ipc.cjs");
const accountService = require("./auth/accountService.cjs");
const scanner = require("./sync/scanner.cjs");
const ops = require("./ops.cjs");
const uploader = require("./drive/uploader.cjs");
const downloader = require("./drive/downloader.cjs");
const migrateWorker = require("./drive/migrate.cjs");
const backup = require("./sync/backup.cjs");
const changePoller = require("./sync/changePoller.cjs");
const localBackup = require("./localBackup/index.cjs");
const backupWorker = require("./localBackup/backupWorker.cjs");
const restoreWorker = require("./localBackup/restoreWorker.cjs");
const vault = require("./vault/index.cjs");
const vaultUpWorker = require("./vault/vaultUpWorker.cjs");
const vaultDownWorker = require("./vault/vaultDownWorker.cjs");
const lanServer = require("./server/index.cjs");
// Requiring this registers the maxthumb:// scheme, which must happen pre-ready.
const protocols = require("./protocols.cjs");

const log = scope("main");

// A second instance would race the first on the database and transfer queue.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    log.info(`MaxDrive ${app.getVersion()} starting`);
    database.open();
    settingsStore.syncOnStartup();

    // Tokens can be unreadable after a Windows reinstall; flag those accounts
    // as reauth_required before the UI asks them for anything.
    accountService.setNotifier(() => send("accounts:changed", {}));
    accountService.reconcileTokensOnStartup();

    registerWindowIpc();
    registerIpc();

    // Forward queue activity to whichever window is open at the time.
    queue.on("progress", (batch) => send("transfers:progress", batch));
    queue.on("state", (payload) => {
      send("transfers:state", payload);
      // A finished upload or migration writes node rows directly, bypassing
      // ops.setNotifier - without this the folder you uploaded into stays empty
      // on screen until the next change poll.
      if (payload.state === "done") {
        send("nodes:changed", { parentIds: [] });
        backup.poke();
      }
    });
    queue.on("changed", () => send("transfers:state", { changed: true }));

    protocols.registerHandlers();

    queue.setWorkers({
      upload: uploader.upload,
      download: downloader.download,
      migrate: migrateWorker.migrate,
      backup: backupWorker.backup,
      restore: restoreWorker.restore,
      vaultUp: vaultUpWorker.vaultUp,
      vaultDown: vaultDownWorker.vaultDown,
    });
    queue.start({ autoResume: settingsStore.get("autoResumeTransfers") });

    ops.setNotifier((payload) => {
      send("nodes:changed", payload);
      backup.poke(); // every index mutation nudges the backup debounce
      changePoller.pollSoon(); // swallow the echo of our own Drive write
    });
    scanner.setNotifier((payload) => {
      send("sync:status", payload);
      // The tree only gains rows once a page is committed, so tell the browse
      // views to refetch as the scan progresses rather than only at the end.
      send("nodes:changed", { parentIds: [] });
    });
    backup.setNotifier((payload) => send("backup:status", payload));
    changePoller.setNotifier(() => send("nodes:changed", { parentIds: [] }));

    // Anything indexed before the app was last closed may be stale.
    scanner
      .scanAll({ onlyStale: true })
      .catch((err) => log.warn(`startup scan failed: ${err.message}`));

    backup.start();
    changePoller.start();

    // Local→cloud backup: re-attach interrupted runs (the queue has already
    // recovered their transfers), then start the schedule tick.
    localBackup.setNotifier((event) => {
      if (event.type === "progress") send("localBackup:progress", event);
      else send("localBackup:changed", {});
    });
    localBackup.start();

    // Secure Storage: sweep temp files left by an interrupted encrypt/upload.
    // The vault itself stays locked - it only opens when the user types the
    // master password.
    vault.setNotifier((event) => {
      if (event.type === "progress") send("vault:progress", event);
      else if (event.type === "lockChanged") send("vault:lockChanged", event);
      else send("vault:changed", {});
    });
    vault.start();

    // Vault mode: its own key session. A lock change re-renders file lists so
    // sealed names appear/disappear at once.
    const sealMode = require("./vault/sealMode.cjs");
    sealMode.setNotifier(() => {
      send("seal:changed", {});
      send("nodes:changed", { parentIds: [] });
    });
    sealMode.start();

    // LAN server (opt-in): pairing lifecycle + status changes flow to the
    // renderer as server:* events; whitelisted renderer pushes fan out to
    // paired clients through window.send's LAN mirror. Nothing binds a socket
    // unless the user has enabled the server in Settings.
    lanServer.setNotifier((evt) => send(`server:${evt.type}`, evt));
    setLanBroadcast((channel, payload) => lanServer.broadcast(channel, payload));
    lanServer.startIfEnabled();

    // Quotas go stale while the app is closed; refresh in the background so the
    // storage gauge is honest by the time the window paints.
    accountService.refreshAllQuotas().catch((err) => log.warn(err.message));

    // Sleeping drops every socket at once. Stepping aside deliberately keeps a
    // long upload from spending its retry budget discovering that, and picks it
    // back up when the machine wakes.
    powerMonitor.on("suspend", () => {
      log.info("system suspending, holding transfers");
      queue.systemPause("SUSPENDED");
    });
    powerMonitor.on("resume", () => {
      log.info("system resumed");
      queue.systemResume();
      changePoller.pollSoon(3000);
    });

    createTray(showWindow);

    // --hidden is passed by the Windows login item so startup goes to the tray.
    const startHidden = process.argv.includes("--hidden");
    createWindow({ startHidden });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // With a tray present, closing the last window must not quit the app —
  // background uploads and downloads keep running.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !settingsStore.get("minimizeToTray")) {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    settingsStore.state.quitting = true;
    queue.flushProgress();
    backup.stop();
    changePoller.stop();
    localBackup.stop();
    vault.stop(); // zero-fills the master key
    require("./vault/sealMode.cjs").stop(); // and vault mode's private key
    lanServer.stop();
    destroyTray();
    database.close();
  });
}

module.exports = { getWindow };
