/**
 * Shared media access for Drive-backed nodes: thumbnail fetch+disk-cache and
 * the authenticated `alt=media` Range proxy. Extracted from protocols.cjs so
 * the custom protocols (renderer) and the LAN HTTP routes (mobile / AI) serve
 * the exact same bytes through one implementation and one thumbnail semaphore.
 */
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

/* --------------------------------------------------------------- thumbnails */

const inFlight = new Map();

/**
 * Thumbnail misses cost two API calls each. Scrolling into a folder of a few
 * hundred uncached files would fire them all at once - the only unbounded
 * fan-out in the main process. Four at a time keeps the grid filling without a
 * request storm. (Preserved verbatim from protocols.cjs.)
 */
const MAX_THUMB_FETCHES = 4;
let thumbActive = 0;
const thumbWaiting = [];

function acquireThumbSlot() {
  if (thumbActive < MAX_THUMB_FETCHES) {
    thumbActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => thumbWaiting.push(resolve));
}

function releaseThumbSlot() {
  const next = thumbWaiting.shift();
  if (next) next();
  else thumbActive -= 1;
}

function sniffImageType(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  if (buffer.slice(8, 12).toString() === "WEBP") return "image/webp";
  return "application/octet-stream";
}

function cachePath(node, size) {
  const dir = path.join(
    app.getPath("userData"),
    "thumbs",
    node.account_id || "local",
  );
  fs.mkdirSync(dir, { recursive: true });
  const version = (node.md5 || node.modified_at || "0").toString().slice(0, 12);
  return path.join(dir, `${node.drive_file_id}-${version}-s${size}.img`);
}

async function fetchThumbnail(node, size) {
  const { json, accessToken } = require("../auth/googleClient.cjs");
  // thumbnailLink is not stored (it expires); one cheap files.get per miss.
  const meta = await json(
    node.account_id,
    `https://www.googleapis.com/drive/v3/files/${node.drive_file_id}?fields=thumbnailLink`,
  );
  if (!meta.thumbnailLink) return null;
  const sized = meta.thumbnailLink.replace(/=s\d+(-c)?$/, `=s${size}`);
  const token = await accessToken(node.account_id);
  const res = await fetch(sized, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Returns cached thumbnail bytes for a node (fetching+caching on a miss), or
 * null if the node has no usable thumbnail. Coalesces concurrent requests.
 */
async function getThumbnail(node, size) {
  if (!node?.drive_file_id || !node.account_id) return null;
  if (node.seal_meta) return null; // a thumbnail would be plaintext
  const { providerFor } = require("../providers/index.cjs");
  if (!providerFor(node.account_id).caps.thumbnails) return null;
  const clamped = Math.min(Number(size) || 440, 1600);
  const cached = cachePath(node, clamped);
  if (!fs.existsSync(cached)) {
    const key = `${node.id}:${clamped}`;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = acquireThumbSlot()
        .then(() => fetchThumbnail(node, clamped))
        .then((buf) => {
          if (buf) fs.writeFileSync(cached, buf);
          return buf;
        })
        .finally(() => {
          releaseThumbSlot();
          inFlight.delete(key);
        });
      inFlight.set(key, pending);
    }
    const buf = await pending;
    if (!buf) return null;
  }
  return fs.readFileSync(cached);
}

/* --------------------------------------------------------------- file bytes */

/**
 * Authenticated `alt=media` fetch with the Range header proxied through, which
 * is what lets video scrubbing and PDF paging work. Returns the raw fetch
 * Response (web body) so each caller adapts it to its own transport.
 * @throws Error with .code MEDIA_GOOGLE_DOC when the node has no raw bytes.
 */
async function driveMediaFetch(node, rangeHeader) {
  if (node.is_google_doc) {
    const e = new Error("google-native files have no raw bytes");
    e.code = "MEDIA_GOOGLE_DOC";
    throw e;
  }
  const { providerFor } = require("../providers/index.cjs");
  const { accounts } = require("../db/queries.cjs");
  const account = accounts.byId(node.account_id) || { id: node.account_id };
  return providerFor(account).openRange(account, node.drive_file_id, rangeHeader || null);
}

/**
 * The transport-neutral half of a file proxy, shared by maxfile:// and the
 * LAN routes. Returns {status, message} for anything that can't be streamed,
 * else {status, upstream, headers} with the Range-relevant headers copied.
 */
/**
 * Serves plaintext from an encrypted .mxv reader (blobFormat.openBlobReader),
 * honouring a Range header - shared by maxvault:// and vault-mode previews.
 */
async function blobRangeResponse(reader, rangeHeader, contentType) {
  const total = reader.plaintextSize;
  const headers = {
    "Content-Type": contentType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (rangeHeader) {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : total - 1;
    const body = await reader.readRange(start, end);
    headers["Content-Length"] = String(body.length);
    headers["Content-Range"] = `bytes ${start}-${start + body.length - 1}/${total}`;
    return { status: 206, body, headers };
  }
  const body = await reader.readRange(0, total - 1);
  headers["Content-Length"] = String(body.length);
  return { status: 200, body, headers };
}

const sealedHeaders = new Map(); // node id → parsed .mxv header

/** Vault-mode file: decrypt the requested range on the fly; 403 while locked. */
async function proxySealed(node, rangeHeader) {
  const sealMode = require("../vault/sealMode.cjs");
  if (!sealMode.isUnlocked()) return { status: 403, message: "vault mode is locked" };
  const blob = require("../vault/blobFormat.cjs");
  const { providerFor } = require("../providers/index.cjs");
  const { accounts } = require("../db/queries.cjs");
  const account = accounts.byId(node.account_id) || { id: node.account_id };

  const read = async (start, end) => {
    const res = await providerFor(account).openRange(account, node.drive_file_id, `bytes=${start}-${end}`);
    if (!res.ok && res.status !== 206) throw new Error(`range read failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  };
  const cacheKey = `${node.id}:${node.md5 || node.size}`;
  let header = sealedHeaders.get(cacheKey);
  if (!header) {
    header = blob.parseHeader(await read(0, blob.HEADER_SIZE - 1));
    sealedHeaders.set(cacheKey, header);
  }
  const reader = blob.openBlobReader({ sealKey: sealMode.privateKey(), header, readCiphertextRange: read });
  const { status, body, headers } = await blobRangeResponse(reader, rangeHeader, sealMode.realMeta(node).mime);
  return { status, upstream: new Response(body), headers };
}

async function proxyMedia(node, rangeHeader) {
  if (!node?.drive_file_id || !node.account_id)
    return { status: 404, message: "not found" };
  if (node.seal_meta) return proxySealed(node, rangeHeader);
  let upstream;
  try {
    upstream = await driveMediaFetch(node, rangeHeader);
  } catch (e) {
    if (e.code === "MEDIA_GOOGLE_DOC") return { status: 415, message: e.message };
    throw e;
  }
  if (!upstream.ok && upstream.status !== 206)
    return { status: upstream.status, message: "upstream error" };

  const headers = {
    "Content-Type": node.mime || "application/octet-stream",
    "Accept-Ranges": "bytes",
  };
  const len = upstream.headers.get("content-length");
  if (len) headers["Content-Length"] = len;
  const range = upstream.headers.get("content-range");
  if (range) headers["Content-Range"] = range;
  return { status: upstream.status, upstream, headers };
}

module.exports = {
  sniffImageType,
  getThumbnail,
  driveMediaFetch,
  proxyMedia,
  blobRangeResponse,
};
