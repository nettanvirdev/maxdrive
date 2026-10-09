/**
 * AWS Signature Version 4 for S3, header-signed.
 *
 * Pure (node:crypto only) so it can be checked against AWS's published
 * examples. Callers pass the exact encoded path and query they will send:
 * signing a URL that the HTTP stack later re-encodes differently is the
 * classic SignatureDoesNotMatch, so encoding happens in exactly one place -
 * here, via `encode`.
 */
const crypto = require("node:crypto");

const sha256Hex = (data) =>
  crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

const EMPTY_SHA256 = sha256Hex("");

/** RFC 3986 strict encoding, as SigV4 requires. `keepSlash` for object paths. */
function encode(value, keepSlash = false) {
  const out = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? out.replace(/%2F/g, "/") : out;
}

/** {a: "1", b: ""} → "a=1&b=" sorted by encoded key (the canonical form). */
function canonicalQuery(query = {}) {
  return Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [encode(k), encode(String(v))])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** 2013-05-24T00:00:00.000Z → 20130524T000000Z */
const amzDate = (date) => date.toISOString().replace(/[-:]|\.\d{3}/g, "");

/**
 * @returns the headers to send: the caller's, plus x-amz-date,
 *   x-amz-content-sha256 and Authorization. `host` is signed but not returned -
 *   fetch derives it from the URL.
 */
function sign({
  method,
  host,
  path,
  query,
  headers = {},
  payloadHash = EMPTY_SHA256,
  region,
  accessKeyId,
  secretAccessKey,
  date = new Date(),
}) {
  const stamp = amzDate(date);
  const day = stamp.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;

  const all = {
    ...headers,
    host,
    "x-amz-date": stamp,
    "x-amz-content-sha256": payloadHash,
  };
  const lower = {};
  for (const [k, v] of Object.entries(all)) {
    lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  }
  const names = Object.keys(lower).sort();
  const signedHeaders = names.join(";");

  const canonical = [
    method,
    path,
    canonicalQuery(query),
    names.map((n) => `${n}:${lower[n]}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");

  const toSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    sha256Hex(canonical),
  ].join("\n");

  const key = ["s3", "aws4_request"].reduce(
    (k, part) => hmac(k, part),
    hmac(hmac(`AWS4${secretAccessKey}`, day), region),
  );
  const signature = crypto.createHmac("sha256", key).update(toSign).digest("hex");

  const { host: _host, ...sent } = all;
  return {
    ...sent,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

module.exports = { sign, encode, canonicalQuery, sha256Hex, EMPTY_SHA256 };
