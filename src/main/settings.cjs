const { app } = require("electron");
const { settings } = require("./db/queries.cjs");
const { scope } = require("./logger.cjs");

const log = scope("settings");

const DEFAULTS = {
  theme: "system",
  colorScheme: "graphite",
  viewMode: "list",
  minimizeToTray: true,
  openAtLogin: false,
  autoResumeTransfers: true,
  headroomMb: 200,
  // S3 buckets have no change feed; re-list each one this often (0 = manual only).
  s3RescanMinutes: 15,
  // Vault mode: seal every new upload/folder (vault/sealMode.cjs).
  vaultMode: false,
  sealAutolockMinutes: 10,
  // LAN server (opt-in, off by default). Ports kept clear of other LAN apps.
  serverEnabled: false,
  serverPort: 47821,
  serverDiscoveryPort: 47820,
};

/** Flag set by the tray's Quit item so the close handler stops intercepting. */
const state = { quitting: false };

function all() {
  return { ...DEFAULTS, ...settings.all() };
}

function get(key) {
  return all()[key];
}

/**
 * Windows starts the app with --hidden so a login launch goes straight to the
 * tray instead of popping a window in the user's face.
 */
function applyOpenAtLogin(enabled) {
  if (!app.isPackaged) {
    log.info(`openAtLogin=${Boolean(enabled)} not registered (unpackaged build)`);
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    args: ["--hidden"],
  });
  const applied = app.getLoginItemSettings({ args: ["--hidden"] });
  log.info(`openAtLogin=${Boolean(enabled)} registered (openAtLogin=${applied.openAtLogin})`);
}

function apply(patch) {
  if ("openAtLogin" in patch) applyOpenAtLogin(patch.openAtLogin);
}

function set(patch) {
  for (const [key, value] of Object.entries(patch)) settings.set(key, value);
  apply(patch);
  return all();
}

/** Re-asserts OS-level settings at boot in case the registry entry was removed. */
function syncOnStartup() {
  applyOpenAtLogin(get("openAtLogin"));
}

module.exports = { all, get, set, syncOnStartup, state, DEFAULTS };
