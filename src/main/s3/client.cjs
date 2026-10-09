/**
 * Signed HTTP for one S3-compatible account.
 *
 * The S3 counterpart of auth/googleClient.cjs: credentials from tokens.bin,
 * retries for throttling and server errors (Retry-After honoured, idempotent
 * methods only for 5xx), and errors that carry `.code` / `.status` /
 * `.retryable` so the transfer queue treats them like Drive's. A rejected key
 * flags the account `reauth_required` the way an `invalid_grant` does.
 */
const { setTimeout: sleep } = require("node:timers/promises");
const tokenStore = require("../auth/tokenStore.cjs");
const { accounts } = require("../db/queries.cjs");
const { sign, encode, canonicalQuery, sha256Hex, EMPTY_SHA256 } = require("./sigv4.cjs");
const { tag } = require("./xml.cjs");

const MAX_ATTEMPTS = 5;
const RETRY_CODES = new Set(["SlowDown", "RequestTimeout", "InternalError", "ServiceUnavailable"]);
const AUTH_CODES = new Set(["InvalidAccessKeyId", "SignatureDoesNotMatch"]);
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE"]);

function s3Error(message, code, status, retryable = false) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.retryable = retryable;
  return err;
}

/** Where requests go. Path-style keeps the bucket in the path (MinIO etc.). */
function target(config, key) {
  const region = config.region || "us-east-1";
  const base = new URL(config.endpoint || `https://s3.${region}.amazonaws.com`);
  const basePath = base.pathname.replace(/\/+$/, "");
  const keyPath = key ? encode(key, true) : "";
  if (config.pathStyle) {
    return {
      origin: `${base.protocol}//${base.host}`,
      host: base.host,
      path: `${basePath}/${encode(config.bucket)}${key ? `/${keyPath}` : ""}`,
    };
  }
  const host = `${config.bucket}.${base.host}`;
  return { origin: `${base.protocol}//${host}`, host, path: `${basePath}/${keyPath}` };
}

function credentialsFor(account) {
  const creds = account.credentials || tokenStore.get(account.id);
  if (!creds?.accessKeyId || !creds?.secretAccessKey) {
    throw s3Error("This storage account has no saved access keys.", "S3_AUTH", 401);
  }
  return creds;
}

/** Turns a failed response into an Error with S3's own <Code>. */
async function toError(account, res) {
  const body = res.status === 404 && !res.headers.get("content-type") ? "" : await res.text().catch(() => "");
  const code = tag(body, "Code") || (res.status === 404 ? "NotFound" : `HTTP_${res.status}`);
  const message = tag(body, "Message") || `S3 request failed (${res.status}).`;

  if (AUTH_CODES.has(code)) {
    // Only the saved keys failing means the account is broken; a probe with
    // candidate keys (connect, or edit) just reports.
    if (!account.credentials && accounts.byId(account.id)) {
      accounts.setAuthState(account.id, "reauth_required");
    }
    return s3Error("The bucket rejected the access keys.", "S3_AUTH", res.status);
  }
  if (code === "NoSuchBucket") return s3Error("That bucket does not exist.", "S3_NO_BUCKET", res.status);
  if (code === "AccessDenied") return s3Error(`Access denied: ${message}`, "S3_ACCESS_DENIED", res.status);
  return s3Error(message, code, res.status, res.status >= 500 || RETRY_CODES.has(code));
}

/**
 * One signed request. `body` is a Buffer/string (hashed and signed) or absent.
 * With `raw`, any non-retryable response is returned instead of thrown - the
 * Range readers need 206/416 untouched.
 */
async function s3Request(
  account,
  { method = "GET", key, query, headers = {}, body, signal, raw = false } = {},
) {
  const config = account.config || {};
  const creds = credentialsFor(account);
  const { origin, host, path } = target(config, key);
  const qs = canonicalQuery(query);
  const url = `${origin}${path}${qs ? `?${qs}` : ""}`;
  const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;

  for (let attempt = 1; ; attempt++) {
    const signed = sign({
      method,
      host,
      path,
      query,
      headers,
      payloadHash,
      region: config.region || "us-east-1",
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    });

    let res;
    try {
      res = await fetch(url, { method, headers: signed, body, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      // A dropped connection: safe to repeat only when the method is.
      if (attempt >= MAX_ATTEMPTS || !IDEMPOTENT.has(method)) {
        throw s3Error(`Could not reach the storage endpoint (${err.cause?.code || err.message}).`, "S3_UNREACHABLE", 0, true);
      }
      await sleep(backoff(attempt), undefined, { signal });
      continue;
    }

    const retryable =
      (res.status === 503 || res.status === 500 || res.status === 429) &&
      (IDEMPOTENT.has(method) || res.status !== 500);
    if (retryable && attempt < MAX_ATTEMPTS) {
      await res.body?.cancel().catch(() => {});
      await sleep(retryAfter(res) ?? backoff(attempt), undefined, { signal });
      continue;
    }

    if (raw || res.ok) return res;
    throw await toError(account, res);
  }
}

const backoff = (attempt) =>
  Math.min(32_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 500);

function retryAfter(res) {
  const value = res.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

module.exports = { s3Request, toError, s3Error, target };
