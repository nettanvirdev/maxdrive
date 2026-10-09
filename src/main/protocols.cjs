/**
 * maxthumb:// - authenticated thumbnail delivery.
 *
 * Drive's thumbnailLink requires an Authorization header and expires within
 * hours, so it can never be a plain <img src>. The renderer instead asks
 * maxthumb://node/<nodeId>?s=<px>; this handler fetches the link with the
 * account's token, caches the bytes on disk, and serves them from there
 * forever after (keyed on md5/modifiedTime so edits refresh the image).
 */
const fs = require("node:fs");
const { protocol } = require("electron");
const { scope } = require("./logger.cjs");
const media = require("./server/media.cjs");

const log = scope("thumbs");

// Must run before app.whenReady - Electron locks the scheme table at ready.
protocol.registerSchemesAsPrivileged([
  { scheme: "maxthumb", privileges: { supportFetchAPI: true, stream: true } },
  {
    scheme: "maxfile",
    privileges: {
      supportFetchAPI: true,
      stream: true, // required for <video>/<audio> to seek
      secure: true,
      standard: true,
      corsEnabled: true,
    },
  },
  {
    scheme: "maxvault",
    privileges: {
      supportFetchAPI: true,
      stream: true,
      secure: true,
      standard: true,
      corsEnabled: true,
    },
  },
]);

function registerHandlers() {
  protocol.handle("maxthumb", async (request) => {
    try {
      const url = new URL(request.url);
      const nodeId = decodeURIComponent(url.pathname.replace(/^\//, ""));

      // getThumbnail clamps the size and rejects nodes without Drive bytes.
      const { nodes } = require("./db/queries.cjs");
      const bytes = await media.getThumbnail(
        nodes.byId(nodeId),
        url.searchParams.get("s"),
      );
      if (!bytes) return new Response("no thumbnail", { status: 404 });

      return new Response(bytes, {
        headers: {
          // Drive returns JPEG for video posters but PNG for many documents —
          // sniff rather than assume, or Chromium refuses to decode it.
          "Content-Type": media.sniffImageType(bytes),
          "Cache-Control": "max-age=86400",
        },
      });
    } catch (err) {
      log.warn(`thumbnail failed: ${err.message}`);
      return new Response("error", { status: 500 });
    }
  });
  /**
   * maxfile://node/<nodeId> - streams the real file bytes straight from Drive.
   *
   * The Range header is proxied in both directions, which is what makes video
   * scrubbing and Chromium's PDF viewer work: they issue partial requests and
   * refuse to seek if the server answers 200 with the whole body.
   */
  protocol.handle("maxfile", async (request) => {
    try {
      const url = new URL(request.url);
      const nodeId = decodeURIComponent(url.pathname.replace(/^\//, ""));

      const { nodes } = require("./db/queries.cjs");
      const proxied = await media.proxyMedia(
        nodes.byId(nodeId),
        request.headers.get("Range"),
      );
      if (!proxied.upstream)
        return new Response(proxied.message, { status: proxied.status });
      return new Response(proxied.upstream.body, {
        status: proxied.status,
        headers: proxied.headers,
      });
    } catch (err) {
      log.warn(`maxfile failed: ${err.message}`);
      return new Response("error", { status: 500 });
    }
  });

  registerVaultProtocol();

  log.info("maxthumb://, maxfile:// and maxvault:// registered");
}

/**
 * maxvault://item/<id> and maxvault://thumb/<id> - decrypted on the fly.
 *
 * Preview cannot go through maxfile: what sits in Drive is ciphertext, and
 * writing a decrypted temp file just to preview it would defeat the point of
 * the vault. Instead a Range request is translated into the chunks that cover
 * it, only those chunks are fetched from Drive, and they are decrypted in
 * memory. A video seek therefore costs one small ranged read, and no plaintext
 * ever touches the disk.
 *
 * Everything here refuses while the vault is locked.
 */
function registerVaultProtocol() {
  const headerCache = new Map();

  /** Reads a byte range of a blob, from the local temp copy or from Drive. */
  const rangeReader = (item, copy, tempPath) => async (start, end) => {
    if (tempPath && fs.existsSync(tempPath)) {
      const fd = fs.openSync(tempPath, "r");
      try {
        const size = fs.statSync(tempPath).size;
        const stop = Math.min(end, size - 1);
        const buffer = Buffer.alloc(Math.max(0, stop - start + 1));
        if (buffer.length) fs.readSync(fd, buffer, 0, buffer.length, start);
        return buffer;
      } finally {
        fs.closeSync(fd);
      }
    }
    const upstream = await media.driveMediaFetch(copy, `bytes=${start}-${end}`);
    if (!upstream.ok && upstream.status !== 206)
      throw new Error(`drive range read failed (${upstream.status})`);
    return Buffer.from(await upstream.arrayBuffer());
  };

  protocol.handle("maxvault", async (request) => {
    try {
      const url = new URL(request.url);
      const kind = url.hostname;
      const id = decodeURIComponent(url.pathname.replace(/^\//, ""));

      const session = require("./vault/session.cjs");
      if (!session.isUnlocked())
        return new Response("vault locked", { status: 403 });
      const vmk = session.getVmk();
      session.touch();

      const { vaultItems, vaultCopies } = require("./db/queries.cjs");
      const item = vaultItems.byId(id);
      if (!item) return new Response("not found", { status: 404 });

      if (kind === "thumb") {
        const vaultCrypto = require("./vault/crypto.cjs");
        const storage = require("./vault/storage.cjs");
        const thumbFile = storage.thumbPath(id);
        if (!fs.existsSync(thumbFile))
          return new Response("no thumbnail", { status: 404 });
        const { png } = vaultCrypto.decryptMeta(
          vmk,
          fs.readFileSync(thumbFile),
        );
        return new Response(Buffer.from(png, "base64"), {
          status: 200,
          headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
        });
      }

      if (kind !== "item") return new Response("bad request", { status: 400 });
      if (item.is_folder)
        return new Response("folders have no bytes", { status: 415 });

      const copy = vaultCopies
        .forItem(id)
        .find((c) => c.state === "ok" && c.drive_file_id);
      const storage = require("./vault/storage.cjs");
      const tempPath = item.blob_uuid
        ? storage.tempBlobPath(item.blob_uuid)
        : null;
      const hasTemp = tempPath && fs.existsSync(tempPath);
      if (!copy && !hasTemp)
        return new Response("no available copy", { status: 404 });

      const blob = require("./vault/blobFormat.cjs");
      const read = rangeReader(item, copy || {}, tempPath);

      let header = headerCache.get(id);
      if (!header) {
        header = blob.parseHeader(await read(0, blob.HEADER_SIZE - 1));
        headerCache.set(id, header);
      }

      const reader = blob.openBlobReader({
        vmk,
        header,
        readCiphertextRange: read,
      });
      const { mimeOf } = require("./vault/mime.cjs");
      const meta = require("./vault/index.cjs").metaOf(item, vmk);
      const contentType =
        meta.mime || mimeOf(meta.name || "") || "application/octet-stream";

      const { status, body, headers } = await media.blobRangeResponse(
        reader,
        request.headers.get("Range"),
        contentType,
      );
      return new Response(body, { status, headers });
    } catch (err) {
      log.warn(`maxvault failed: ${err.message}`);
      return new Response("error", { status: 500 });
    }
  });
}

module.exports = { registerHandlers };
