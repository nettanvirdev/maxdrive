const path = require("path");
const { app, Menu, Tray, nativeImage } = require("electron");
const { queue } = require("./transfers/queue.cjs");
const settingsStore = require("./settings.cjs");
const { scope } = require("./logger.cjs");

const log = scope("tray");

let tray = null;
let showWindow = null;

function iconPath() {
  return path.join(__dirname, "../../public/assets/logo.png");
}

function buildMenu() {
  const active = queue
    .list()
    .filter((t) =>
      ["queued", "allocating", "running", "paused"].includes(t.state),
    );
  const label = active.length
    ? `${active.length} transfer${active.length === 1 ? "" : "s"} in progress`
    : "No active transfers";

  return Menu.buildFromTemplate([
    { label: "Open MaxDrive", click: () => showWindow?.() },
    { type: "separator" },
    { label, enabled: false },
    {
      label: queue.paused ? "Resume transfers" : "Pause transfers",
      enabled: active.length > 0 || queue.paused,
      click: () => {
        if (queue.paused) queue.resumeAll();
        else queue.pauseAll();
      },
    },
    { type: "separator" },
    {
      label: "Quit MaxDrive",
      click: () => {
        settingsStore.state.quitting = true;
        app.quit();
      },
    },
  ]);
}

function refresh() {
  if (!tray) return;
  const active = queue
    .list()
    .filter((t) => ["queued", "allocating", "running"].includes(t.state));
  tray.setToolTip(
    active.length
      ? `MaxDrive - ${active.length} transfer(s) running`
      : "MaxDrive",
  );
  tray.setContextMenu(buildMenu());
}

function createTray(onShow) {
  showWindow = onShow;

  const image = nativeImage.createFromPath(iconPath());
  // Windows wants a small tray bitmap; the 512px source needs downscaling.
  tray = new Tray(
    image.isEmpty() ? image : image.resize({ width: 16, height: 16 }),
  );
  tray.setToolTip("MaxDrive");
  tray.setContextMenu(buildMenu());
  tray.on("click", () => showWindow?.());
  tray.on("double-click", () => showWindow?.());

  queue.on("changed", refresh);
  queue.on("state", refresh);

  log.info("tray created");
  return tray;
}

function destroyTray() {
  tray?.destroy();
  tray = null;
}

module.exports = { createTray, destroyTray };
