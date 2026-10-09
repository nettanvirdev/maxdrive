const path = require("path");
const { BrowserWindow, Menu, ipcMain, screen } = require("electron");
const settingsStore = require("./settings.cjs");

const isDev = process.env.NODE_ENV === "development";

// design.json targets a 1280px minimum viewport; the restore-down size matches.
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 820;
const MIN_WIDTH = 1100;
const MIN_HEIGHT = 700;

let mainWindow = null;

// Optional mirror of renderer pushes to LAN subscribers (the WebSocket hub).
// Injected by main.cjs so window.cjs stays free of a server dependency.
let lanBroadcast = null;
function setLanBroadcast(fn) {
  lanBroadcast = typeof fn === "function" ? fn : null;
}

function getWindow() {
  return mainWindow;
}

/** Sends to the renderer, tolerating a window that is gone or still loading. */
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
  // The renderer bus is the single choke point for main→renderer pushes, so it
  // is also where whitelisted events fan out to paired LAN clients.
  if (lanBroadcast) lanBroadcast(channel, payload);
}

function sendWindowState(state) {
  send("window-state", state);
}

function createWindow({ startHidden = false } = {}) {
  mainWindow = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    show: false,
    icon: path.join(__dirname, "../../public/assets/logo.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  // Avoids the white flash before React paints. A login-time launch stays
  // hidden so the app lands in the tray rather than interrupting startup.
  mainWindow.once("ready-to-show", () => {
    if (!startHidden) mainWindow.show();
  });

  /**
   * Closing hides to the tray so background transfers survive; only an explicit
   * Quit (tray menu) sets the quitting flag and lets the window really close.
   */
  mainWindow.on("close", (event) => {
    if (settingsStore.state.quitting) return;
    if (!settingsStore.get("minimizeToTray")) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("maximize", () => sendWindowState("maximized"));
  mainWindow.on("unmaximize", () => sendWindowState("normal"));
  mainWindow.on("enter-full-screen", () => sendWindowState("fullscreen"));
  mainWindow.on("leave-full-screen", () => sendWindowState("normal"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  sendWindowState("normal");
  Menu.setApplicationMenu(null);

  return mainWindow;
}

/** Window chrome controls - one-way, kept separate from the app's invoke API. */
function registerWindowIpc() {
  ipcMain.on("window-minimize", () => mainWindow?.minimize());

  ipcMain.on("window-maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.on("window-close", () => mainWindow?.close());

  // Dragging a maximized window restores it and re-centres under the cursor.
  ipcMain.on("window-begin-drag", () => {
    if (!mainWindow) return;
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) return;

    const { workArea } = screen.getPrimaryDisplay();
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
    else mainWindow.unmaximize();

    mainWindow.setBounds({
      x: workArea.x + Math.floor((workArea.width - DEFAULT_WIDTH) / 2),
      y: workArea.y + Math.floor((workArea.height - DEFAULT_HEIGHT) / 2),
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    });
    sendWindowState("normal");
  });
}

/** Brings the window back from the tray, recreating it if it was destroyed. */
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

module.exports = {
  createWindow,
  registerWindowIpc,
  getWindow,
  send,
  setLanBroadcast,
  showWindow,
};
