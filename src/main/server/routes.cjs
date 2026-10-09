/**
 * The /v1 LAN API route table. Handlers stay thin: they call the SAME
 * main-process services the IPC layer uses (db/queries, ops, queue) and return
 * plain JSON. Media handlers stream to `ctx.res` directly and return RAW.
 *
 * Auth levels per route:
 *   'none'   - open (health, pairing, auth challenge)
 *   'device' - valid bearer token for an active paired device
 *   'media'  - device bearer OR a signed ?exp=&sig= URL (for <img>/<video>)
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable, pipeline } = require("node:stream");
const { promisify } = require("node:util");
const { app } = require("electron");
const { nodes, accounts } = require("../db/queries.cjs");
const { MANAGED_ROOT_ID } = require("../db/database.cjs");
const ops = require("../ops.cjs");
const { queue } = require("../transfers/queue.cjs");
const session = require("./pairing/session.cjs");
const store = require("./pairing/store.cjs");
const token = require("./auth/token.cjs");
const identity = require("./identity.cjs");
const media = require("./media.cjs");
const serialize = require("./serialize.cjs");
const pairingCrypto = require("./pairing/crypto.cjs");
const mcp = require("./mcp/endpoint.cjs");

const streamPipeline = promisify(pipeline);

/** Sentinel a handler returns when it has already written to ctx.res. */
const RAW = Symbol("raw-response");

/** Short-lived re-auth nonces: deviceId -> { nonce: Buffer, exp } */
const authNonces = new Map();
const NONCE_TTL_MS = 60_000;

function httpError(code, status, message) {
  const e = new Error(message || code);
  e.code = code;
  e.status = status;
  return e;
}

function serverName() {
  return require("node:os").hostname();
}

/* --------------------------------------------------------------- handlers */

function health() {
  return {
    app: "MaxDrive",
    version: app.getVersion(),
    protocol: pairingCrypto.PROTOCOL_VERSION,
    serverId: identity.serverId(),
    serverName: serverName(),
  };
}

function pairChallenge() {
  return session.getChallenge();
}

async function pairProof(ctx) {
  const { deviceId, name, platform, proof } = ctx.body || {};
  const result = await session.submitProof({
    deviceId,
    name,
    platform,
    proof,
    remoteIp: ctx.remoteIp,
  });
  const bearer = token.sign(
    { deviceId: result.deviceId, tokenVersion: result.tokenVersion },
    ctx.signingKey,
  );
  return {
    token: bearer,
    serverId: identity.serverId(),
    serverName: serverName(),
    apiBase: "/v1",
  };
}

/** Re-auth: hand an already-paired device a nonce to prove its secret against. */
function authChallenge(ctx) {
  const deviceId = ctx.query.get("deviceId");
  const row = deviceId && store.byId(deviceId);
  if (!row || row.revoked) throw httpError("NOT_FOUND", 404, "Unknown device.");
  const nonce = crypto.randomBytes(pairingCrypto.NONCE_LENGTH);
  authNonces.set(deviceId, { nonce, exp: Date.now() + NONCE_TTL_MS });
  return { nonce: nonce.toString("base64") };
}

/** Re-auth: verify proof over the nonce and mint a fresh token. */
function authToken(ctx) {
  const { deviceId, proof } = ctx.body || {};
  const entry = deviceId && authNonces.get(deviceId);
  if (!entry || entry.exp < Date.now()) {
    authNonces.delete(deviceId);
    throw httpError("AUTH_NO_CHALLENGE", 409, "Request a challenge first.");
  }
  authNonces.delete(deviceId);
  const secret = store.getSecret(deviceId);
  if (!secret) throw httpError("UNAUTHORIZED", 401, "Unknown device.");
  const proofBuf = Buffer.from(String(proof || ""), "base64");
  if (!pairingCrypto.verifyProof(secret, entry.nonce, proofBuf)) {
    throw httpError("AUTH_FAILED", 401, "Bad proof.");
  }
  const row = store.byId(deviceId);
  store.touch(deviceId);
  return {
    token: token.sign(
      { deviceId, tokenVersion: row.token_version },
      ctx.signingKey,
    ),
    apiBase: "/v1",
  };
}

function whoami(ctx) {
  return {
    id: ctx.device.id,
    name: ctx.device.name,
    platform: ctx.device.platform,
  };
}

/* ----- read routes ----- */

function listChildren(ctx) {
  const parentId = ctx.query.get("parentId") || MANAGED_ROOT_ID;
  const sort = ctx.query.get("sort") || "name";
  return serialize.nodes(nodes.children(parentId, sort));
}

function roots() {
  return serialize.nodes(nodes.roots());
}

function getNode(ctx) {
  const n = nodes.byId(ctx.params.id);
  if (!n) throw httpError("NOT_FOUND", 404, "No such node.");
  return serialize.node(n);
}

function getPath(ctx) {
  return serialize.nodes(nodes.path(ctx.params.id));
}

function search(ctx) {
  const q = ctx.query.get("q") || "";
  const limit = Math.min(Number(ctx.query.get("limit")) || 200, 1000);
  return serialize.nodes(nodes.search(q, limit));
}

function recent(ctx) {
  const limit = Math.min(Number(ctx.query.get("limit")) || 50, 500);
  return serialize.nodes(nodes.recent(limit));
}

function starred(ctx) {
  const limit = Math.min(Number(ctx.query.get("limit")) || 200, 1000);
  return serialize.nodes(nodes.starred(limit));
}

function trashed(ctx) {
  const limit = Math.min(Number(ctx.query.get("limit")) || 500, 2000);
  return serialize.nodes(nodes.trashed(limit));
}

function listAccounts() {
  return serialize.accounts(accounts.list());
}

function storage() {
  return serialize.storage(accounts.list());
}

/** Mint a short-lived signed URL for header-less media consumers. */
function fileLink(ctx) {
  const n = nodes.byId(ctx.params.id);
  if (!n) throw httpError("NOT_FOUND", 404, "No such node.");
  const { exp, sig } = token.signUrl(n.id, ctx.signingKey);
  return {
    url: `/v1/file/${encodeURIComponent(n.id)}?exp=${exp}&sig=${encodeURIComponent(sig)}`,
    exp,
  };
}

function thumbLink(ctx) {
  const n = nodes.byId(ctx.params.id);
  if (!n) throw httpError("NOT_FOUND", 404, "No such node.");
  const size = ctx.query.get("s") || "440";
  const { exp, sig } = token.signUrl(n.id, ctx.signingKey);
  return {
    url: `/v1/thumb/${encodeURIComponent(n.id)}?s=${size}&exp=${exp}&sig=${encodeURIComponent(sig)}`,
    exp,
  };
}

async function serveThumb(ctx) {
  // getThumbnail returns null for nodes without Drive bytes.
  const size = ctx.query.get("s") || 440;
  const bytes = await media.getThumbnail(nodes.byId(ctx.params.id), size);
  if (!bytes) {
    ctx.res.writeHead(404).end("no thumbnail");
    return RAW;
  }
  ctx.res.writeHead(200, {
    "Content-Type": media.sniffImageType(bytes),
    "Cache-Control": "max-age=86400",
    "Content-Length": bytes.length,
  });
  ctx.res.end(bytes);
  return RAW;
}

async function serveFile(ctx) {
  const n = nodes.byId(ctx.params.id);
  const proxied = await media.proxyMedia(n, ctx.req.headers.range || null);
  if (!proxied.upstream) {
    ctx.res.writeHead(proxied.status).end(proxied.message);
    return RAW;
  }
  const { upstream } = proxied;
  const headers = { ...proxied.headers, "Cache-Control": "private, max-age=3600" };
  if (ctx.query.get("dl")) {
    headers["Content-Disposition"] =
      `attachment; filename*=UTF-8''${encodeURIComponent(n.name)}`;
  }

  ctx.res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    ctx.res.end();
    return RAW;
  }
  Readable.fromWeb(upstream.body).pipe(ctx.res);
  return RAW;
}

/* ----- write routes (bearer) ----- */

function opMkdir(ctx) {
  const { parentId, name } = ctx.body || {};
  return serialize.node(ops.mkdir({ parentId: parentId || MANAGED_ROOT_ID, name }));
}

async function opRename(ctx) {
  const { id, name } = ctx.body || {};
  return serialize.node(await ops.rename({ id, name }));
}

function opMove(ctx) {
  const { ids, newParentId } = ctx.body || {};
  return ops.move({ ids, newParentId: newParentId || MANAGED_ROOT_ID });
}

function opTrash(ctx) {
  return ops.trash({ ids: (ctx.body || {}).ids });
}

function opRestore(ctx) {
  return ops.restore({ ids: (ctx.body || {}).ids });
}

function opStar(ctx) {
  const { id, starred } = ctx.body || {};
  return ops.star({ id, starred: Boolean(starred) });
}

/**
 * Streamed upload: the raw request body is written to a temp file, then handed
 * to the transfer queue, which picks the account with the most room (worst-fit
 * allocation) exactly as a desktop upload would. This is the path a mobile
 * client uses to back up a photo or video.
 */
async function upload(ctx) {
  const rawName = ctx.req.headers["x-upload-name"];
  const name = rawName ? decodeURIComponent(rawName) : `upload-${Date.now()}`;
  const parentId = ctx.query.get("parentId") || MANAGED_ROOT_ID;

  const dir = path.join(app.getPath("temp"), "maxdrive-uploads");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${crypto.randomUUID()}-${path.basename(name)}`);

  await streamPipeline(ctx.req, fs.createWriteStream(tmp));
  const size = fs.statSync(tmp).size;

  const transferId = queue.enqueueUpload(tmp, parentId, {
    name: path.basename(name),
    size,
  });
  return { transferId, name: path.basename(name), size };
}

/* ----- transfers (read status; control lands in M2) ----- */

function transfersList() {
  return serialize.transfers(queue.listVisible());
}

function transferGet(ctx) {
  const t = queue.getVisible(ctx.params.id);
  if (!t) throw httpError("NOT_FOUND", 404, "No such transfer.");
  return serialize.transfer(t);
}

/* ----- MCP endpoint ----- */

function mcpHandle(ctx) {
  return mcp.handle(ctx, RAW);
}

/* --------------------------------------------------------------- table */

const ROUTES = [
  { method: "GET", path: "/v1/health", auth: "none", handler: health },

  { method: "GET", path: "/v1/pair/challenge", auth: "none", handler: pairChallenge },
  { method: "POST", path: "/v1/pair/proof", auth: "none", handler: pairProof },
  { method: "GET", path: "/v1/auth/challenge", auth: "none", handler: authChallenge },
  { method: "POST", path: "/v1/auth/token", auth: "none", handler: authToken },

  { method: "GET", path: "/v1/whoami", auth: "device", handler: whoami },
  { method: "GET", path: "/v1/nodes/roots", auth: "device", handler: roots },
  { method: "GET", path: "/v1/nodes/children", auth: "device", handler: listChildren },
  { method: "GET", path: "/v1/nodes/:id/path", auth: "device", handler: getPath },
  { method: "GET", path: "/v1/nodes/:id", auth: "device", handler: getNode },
  { method: "GET", path: "/v1/search", auth: "device", handler: search },
  { method: "GET", path: "/v1/recent", auth: "device", handler: recent },
  { method: "GET", path: "/v1/starred", auth: "device", handler: starred },
  { method: "GET", path: "/v1/trashed", auth: "device", handler: trashed },
  { method: "GET", path: "/v1/accounts", auth: "device", handler: listAccounts },
  { method: "GET", path: "/v1/storage", auth: "device", handler: storage },

  { method: "GET", path: "/v1/file/:id/link", auth: "device", handler: fileLink },
  { method: "GET", path: "/v1/thumb/:id/link", auth: "device", handler: thumbLink },
  { method: "GET", path: "/v1/thumb/:id", auth: "media", handler: serveThumb },
  { method: "GET", path: "/v1/download/:id", auth: "media", handler: serveFile },
  { method: "GET", path: "/v1/file/:id", auth: "media", handler: serveFile },

  // Writes (bearer).
  { method: "POST", path: "/v1/ops/mkdir", auth: "device", handler: opMkdir },
  { method: "POST", path: "/v1/ops/rename", auth: "device", handler: opRename },
  { method: "POST", path: "/v1/ops/move", auth: "device", handler: opMove },
  { method: "POST", path: "/v1/ops/trash", auth: "device", handler: opTrash },
  { method: "POST", path: "/v1/ops/restore", auth: "device", handler: opRestore },
  { method: "POST", path: "/v1/ops/star", auth: "device", handler: opStar },
  { method: "POST", path: "/v1/uploads", auth: "device", raw: true, handler: upload },

  // Transfers (read status).
  { method: "GET", path: "/v1/transfers", auth: "device", handler: transfersList },
  { method: "GET", path: "/v1/transfers/:id", auth: "device", handler: transferGet },

  // MCP (bearer). POST carries JSON-RPC (parsed body); GET/DELETE are no-ops.
  { method: "POST", path: "/mcp", auth: "device", handler: mcpHandle },
  { method: "GET", path: "/mcp", auth: "device", handler: mcpHandle },
  { method: "DELETE", path: "/mcp", auth: "device", handler: mcpHandle },
];

module.exports = { ROUTES, RAW };
