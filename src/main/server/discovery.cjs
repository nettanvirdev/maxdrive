/**
 * UDP discovery responder so a LAN client can find this PC without typing an IP.
 * Adapted from the reference project's DiscoveryResponder.cs, with MaxDrive's
 * own magic and port (clear of other LAN apps):
 *
 *   probe (client → broadcast)  : "MAXDRV?" (7 bytes) || version (1 byte)
 *   reply (server → unicast)    : UTF-8 JSON, magic "MAXDRV!"
 *
 * The probe is accepted when length ≥ 8, magic matches, and version ≤ current.
 * The parse/build helpers are pure and unit-tested; only start()/stop() touch
 * the socket.
 */
const dgram = require("node:dgram");
const os = require("node:os");
const { scope } = require("../logger.cjs");
const identity = require("./identity.cjs");
const { PROTOCOL_VERSION } = require("./pairing/crypto.cjs");

const log = scope("server-discovery");

const PROBE_MAGIC = "MAXDRV?";
const REPLY_MAGIC = "MAXDRV!";

/** True if the datagram is a valid discovery probe we should answer. */
function isProbe(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < PROBE_MAGIC.length + 1) return false;
  if (buf.subarray(0, PROBE_MAGIC.length).toString("ascii") !== PROBE_MAGIC)
    return false;
  const version = buf[PROBE_MAGIC.length];
  return version <= PROTOCOL_VERSION; // tolerate older, ignore newer
}

/**
 * Build the JSON reply payload advertising this server. `serverId` is injected
 * (resolved once at start) so this stays a pure, testable function.
 */
function buildReply({ apiPort, version = 0, serverId = "" } = {}) {
  return {
    magic: REPLY_MAGIC,
    version: PROTOCOL_VERSION,
    name: os.hostname(),
    app: "MaxDrive",
    appVersion: version,
    apiPort,
    serverId,
  };
}

let socket = null;

function start({ port, apiPort, appVersion }) {
  stop();
  const serverId = identity.serverId(); // resolve once, not per datagram
  socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("error", (err) => {
    log.warn(`discovery socket error: ${err.message}`);
    stop();
  });

  socket.on("message", (msg, rinfo) => {
    if (!isProbe(msg)) return;
    const reply = Buffer.from(
      JSON.stringify(buildReply({ apiPort, version: appVersion, serverId })),
    );
    socket.send(reply, rinfo.port, rinfo.address, (err) => {
      if (err) log.warn(`discovery reply failed: ${err.message}`);
    });
  });

  socket.bind(port, () => {
    try {
      socket.setBroadcast(true);
    } catch {
      /* not fatal - unicast replies still work */
    }
    log.info(`discovery listening on udp/${port}`);
  });
}

function stop() {
  if (socket) {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
    socket = null;
  }
}

module.exports = { PROBE_MAGIC, REPLY_MAGIC, isProbe, buildReply, start, stop };
