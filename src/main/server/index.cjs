/**
 * LAN server facade - the only surface main.cjs and ipc.cjs talk to.
 *
 * Owns the HTTP server, the WebSocket event hub and the UDP discovery
 * responder, plus the pairing service methods the renderer drives (start
 * pairing, approve/deny, list/revoke devices). Opt-in: nothing binds a socket
 * until the user enables the server in Settings.
 *
 * Lifecycle mirrors vault/localBackup: setNotifier(fn) + start()/stop().
 */
const http = require("node:http");
const os = require("node:os");
const { app } = require("electron");
const { scope } = require("../logger.cjs");
const settingsStore = require("../settings.cjs");
const crypto = require("node:crypto");
const identity = require("./identity.cjs");
const token = require("./auth/token.cjs");
const { createRequestHandler } = require("./httpServer.cjs");
const ws = require("./ws.cjs");
const discovery = require("./discovery.cjs");
const session = require("./pairing/session.cjs");
const store = require("./pairing/store.cjs");

const log = scope("server");

let notify = () => {};
let server = null; // http.Server
let running = false;

/** Channels mirrored from the renderer bus to LAN subscribers. */
const LAN_CHANNELS = new Set([
  "nodes:changed",
  "transfers:state",
  "transfers:progress",
  "accounts:changed",
  "sync:status",
]);

function setNotifier(fn) {
  notify = typeof fn === "function" ? fn : () => {};
  // Pairing lifecycle events flow straight through to the renderer.
  session.setNotifier((evt) => notify(evt));
}

/** Primary non-internal IPv4 address, for display and the QR host. */
function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "127.0.0.1";
}

function port() {
  return Number(settingsStore.get("serverPort")) || 47821;
}

function discoveryPort() {
  return Number(settingsStore.get("serverDiscoveryPort")) || 47820;
}

/* ------------------------------------------------------------- lifecycle */

function start() {
  if (running) return status();
  const signingKey = identity.signingKey();
  ws.start(signingKey);

  server = http.createServer(createRequestHandler(signingKey));
  server.on("upgrade", (req, socket, head) => ws.handleUpgrade(req, socket, head));
  server.on("error", (err) => {
    log.error(`http server error: ${err.message}`);
    running = false;
    notify({ type: "changed" });
  });

  server.listen(port(), "0.0.0.0", () => {
    running = true;
    log.info(`LAN API listening on http://${lanAddress()}:${port()}`);
    discovery.start({
      port: discoveryPort(),
      apiPort: port(),
      appVersion: app.getVersion(),
    });
    notify({ type: "changed" });
  });
  return status();
}

function stop() {
  discovery.stop();
  ws.stop();
  session.reset();
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    server = null;
  }
  running = false;
  notify({ type: "changed" });
}

/** Start only if the user has enabled it (called at boot). */
function startIfEnabled() {
  if (settingsStore.get("serverEnabled")) start();
}

function enable() {
  settingsStore.set({ serverEnabled: true });
  start();
  return status();
}

function disable() {
  settingsStore.set({ serverEnabled: false });
  stop();
  return status();
}

/** Broadcast a whitelisted renderer event to LAN subscribers. */
function broadcast(channel, payload) {
  if (running && LAN_CHANNELS.has(channel)) ws.broadcast(channel, payload);
}

/* --------------------------------------------------------------- pairing */

/** Build the QR payload the desktop renders next to the digits. */
function pairUri(code) {
  const params = new URLSearchParams({
    h: lanAddress(),
    p: String(port()),
    c: code,
    sid: identity.serverId(),
    n: os.hostname(),
  });
  return `maxdrive://pair?${params.toString()}`;
}

/** Called by the "Add device" command. Ensures the server is up first. */
function startPairing() {
  if (!running) start();
  const { code, expiresAt } = session.begin();
  return {
    code,
    expiresAt,
    qr: pairUri(code),
    address: `${lanAddress()}:${port()}`,
  };
}

function cancelPairing() {
  session.cancel();
  return { ok: true };
}

function approvePairing(deviceId) {
  const found = session.resolve(deviceId, true);
  notify({ type: "changed" });
  return { ok: found };
}

function denyPairing(deviceId) {
  const found = session.resolve(deviceId, false);
  return { ok: found };
}

function listDevices() {
  return store.list();
}

function revokeDevice(id) {
  store.revoke(id);
  notify({ type: "changed" });
  return { ok: true };
}

/**
 * Register an AI assistant as a paired device and mint its bearer token. Unlike
 * phone pairing there is no QR/approval step: the desktop user is the one
 * clicking the button, which is itself the authorization. Returns the token and
 * a ready-to-run `claude mcp add` command.
 */
function createMcpToken(name = "AI assistant") {
  if (!running) start();
  const deviceId = crypto.randomUUID();
  const secret = crypto.randomBytes(32); // not used for MCP, but keeps the row uniform
  const row = store.save({ deviceId, name, platform: "mcp", secret });
  const bearer = token.sign(
    { deviceId, tokenVersion: row.token_version },
    identity.signingKey(),
  );
  const url = `http://${lanAddress()}:${port()}/mcp`;
  notify({ type: "changed" });
  return {
    token: bearer,
    url,
    deviceId,
    command: `claude mcp add --transport http maxdrive ${url} --header "Authorization: Bearer ${bearer}"`,
  };
}

function status() {
  return {
    enabled: Boolean(settingsStore.get("serverEnabled")),
    running,
    address: lanAddress(),
    port: port(),
    discoveryPort: discoveryPort(),
    clients: ws.clientCount(),
    deviceCount: store.list().filter((d) => !d.revoked).length,
    pairing: session.status(),
  };
}

module.exports = {
  setNotifier,
  start,
  stop,
  startIfEnabled,
  enable,
  disable,
  broadcast,
  startPairing,
  cancelPairing,
  approvePairing,
  denyPairing,
  listDevices,
  revokeDevice,
  createMcpToken,
  status,
};
