/**
 * WebSocket event hub for the LAN API (`/v1/events`). Authenticates the upgrade
 * with the same bearer token as the REST API, then forwards the very events the
 * renderer already receives (index changes, transfer progress, account/quota
 * changes) so a mobile client's cached index can stay live while the desktop is
 * running. Uses the `ws` library.
 */
const { WebSocketServer } = require("ws");
const { scope } = require("../logger.cjs");
const { authenticateBearer } = require("./httpServer.cjs");

const log = scope("server-ws");

let wss = null;
let signingKey = null;

function start(key) {
  signingKey = key;
  wss = new WebSocketServer({ noServer: true });
}

/** Attach to an http.Server's upgrade event; only handles /v1/events. */
function handleUpgrade(req, socket, head) {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== "/v1/events") {
    socket.destroy();
    return;
  }
  // Token may come as a header (native clients) or ?token= (browsers can't set
  // WS headers). The query form is a bearer token, not a secret URL, and the
  // connection is LAN-only.
  const url = new URL(req.url, "http://localhost");
  const auth =
    req.headers.authorization ||
    (url.searchParams.get("token") ? `Bearer ${url.searchParams.get("token")}` : null);
  const device = authenticateBearer(auth, signingKey);
  if (!device) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    client.deviceId = device.id;
    client.send(JSON.stringify({ type: "hello", deviceId: device.id }));
    log.info(`device ${device.name} subscribed to events`);
  });
}

/** Broadcast an event to every connected client. */
function broadcast(type, payload) {
  if (!wss) return;
  const frame = JSON.stringify({ type, payload, at: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      try {
        client.send(frame);
      } catch {
        /* a dead socket will be reaped by ws */
      }
    }
  }
}

function clientCount() {
  return wss ? wss.clients.size : 0;
}

function stop() {
  if (!wss) return;
  for (const client of wss.clients) {
    try {
      client.close(1001, "server stopping");
    } catch {
      /* ignore */
    }
  }
  wss.close();
  wss = null;
}

module.exports = { start, handleUpgrade, broadcast, clientCount, stop };
