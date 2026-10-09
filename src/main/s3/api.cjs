/**
 * The S3 operations MaxDrive uses, over client.cjs. Every function takes the
 * account row (with parsed `config`) and an object key; nothing here knows
 * about nodes or transfers.
 */
const crypto = require("node:crypto");
const { s3Request, toError, s3Error } = require("./client.cjs");
const { encode } = require("./sigv4.cjs");
const { tag, blocks, escape } = require("./xml.cjs");

const md5Base64 = (buf) => crypto.createHash("md5").update(buf).digest("base64");
const unquote = (etag) => (etag || "").replace(/"/g, "");

/** One ListObjectsV2 page under `prefix`. */
async function listPage(account, prefix, continuationToken, signal) {
  const res = await s3Request(account, {
    query: {
      "list-type": 2,
      prefix: prefix || undefined,
      "continuation-token": continuationToken || undefined,
      "max-keys": 1000,
    },
    signal,
  });
  const xml = await res.text();
  return {
    objects: blocks(xml, "Contents").map((c) => ({
      key: tag(c, "Key"),
      size: Number(tag(c, "Size") || 0),
      etag: unquote(tag(c, "ETag")),
      lastModified: Date.parse(tag(c, "LastModified")) || null,
    })),
    next: tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : null,
  };
}

/** Object metadata, or null when it does not exist. */
async function head(account, key, signal) {
  const res = await s3Request(account, { method: "HEAD", key, signal, raw: true });
  if (res.status === 404) return null;
  if (!res.ok) throw await toError(account, res);
  return {
    size: Number(res.headers.get("content-length") || 0),
    etag: unquote(res.headers.get("etag")),
    lastModified: Date.parse(res.headers.get("last-modified")) || Date.now(),
    contentType: res.headers.get("content-type"),
  };
}

/** Ranged GET, returned raw so callers see 200/206/416 as-is. */
function getRange(account, key, range, signal) {
  return s3Request(account, {
    key,
    headers: range ? { Range: range } : {},
    signal,
    raw: true,
  });
}

/** Single-request upload; Content-MD5 makes the server verify the bytes. */
async function putObject(account, key, buffer, { contentType, signal } = {}) {
  const res = await s3Request(account, {
    method: "PUT",
    key,
    body: buffer,
    headers: {
      "Content-Type": contentType || "application/octet-stream",
      "Content-MD5": md5Base64(buffer),
    },
    signal,
  });
  return unquote(res.headers.get("etag"));
}

async function createMultipart(account, key, contentType, signal) {
  const res = await s3Request(account, {
    method: "POST",
    key,
    query: { uploads: "" },
    headers: { "Content-Type": contentType || "application/octet-stream" },
    signal,
  });
  const uploadId = tag(await res.text(), "UploadId");
  if (!uploadId) throw s3Error("The bucket did not start the upload.", "S3_NO_UPLOAD_ID", res.status, true);
  return uploadId;
}

async function uploadPart(account, key, uploadId, partNumber, buffer, signal) {
  const res = await s3Request(account, {
    method: "PUT",
    key,
    query: { partNumber, uploadId },
    body: buffer,
    headers: { "Content-MD5": md5Base64(buffer) },
    signal,
  });
  return unquote(res.headers.get("etag"));
}

/** Parts already stored for an upload - how a resumed upload skips them. */
async function listParts(account, key, uploadId, signal) {
  const parts = [];
  let marker;
  do {
    const res = await s3Request(account, {
      key,
      query: { uploadId, "part-number-marker": marker },
      signal,
    });
    const xml = await res.text();
    for (const p of blocks(xml, "Part")) {
      parts.push({
        partNumber: Number(tag(p, "PartNumber")),
        etag: unquote(tag(p, "ETag")),
        size: Number(tag(p, "Size") || 0),
      });
    }
    marker = tag(xml, "IsTruncated") === "true" ? tag(xml, "NextPartNumberMarker") : null;
  } while (marker);
  return parts;
}

async function completeMultipart(account, key, uploadId, parts, signal) {
  const body =
    "<CompleteMultipartUpload>" +
    parts
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${escape(p.etag)}"</ETag></Part>`)
      .join("") +
    "</CompleteMultipartUpload>";
  const res = await s3Request(account, {
    method: "POST",
    key,
    query: { uploadId },
    body,
    headers: { "Content-Type": "application/xml" },
    signal,
  });
  // S3 can answer 200 and still put an <Error> in the body.
  const xml = await res.text();
  if (/<Error>/.test(xml)) {
    throw s3Error(tag(xml, "Message") || "Completing the upload failed.", tag(xml, "Code") || "S3_COMPLETE_FAILED", 200, true);
  }
}

async function abortMultipart(account, key, uploadId) {
  const res = await s3Request(account, { method: "DELETE", key, query: { uploadId }, raw: true });
  if (!res.ok && res.status !== 404) throw await toError(account, res);
}

/** Server-side copy within the bucket (single request: objects up to 5 GB). */
async function copyObject(account, fromKey, toKey) {
  const res = await s3Request(account, {
    method: "PUT",
    key: toKey,
    headers: { "x-amz-copy-source": `/${encode(account.config.bucket)}/${encode(fromKey, true)}` },
  });
  const xml = await res.text();
  if (/<Error>/.test(xml)) {
    throw s3Error(tag(xml, "Message") || "Copy failed.", tag(xml, "Code") || "S3_COPY_FAILED", 200, true);
  }
}

/** Delete; a missing object counts as success (S3 itself mostly agrees). */
async function deleteObject(account, key) {
  const res = await s3Request(account, { method: "DELETE", key, raw: true });
  if (!res.ok && res.status !== 404) throw await toError(account, res);
}

module.exports = {
  listPage,
  head,
  getRange,
  putObject,
  createMultipart,
  uploadPart,
  listParts,
  completeMultipart,
  abortMultipart,
  copyObject,
  deleteObject,
};
