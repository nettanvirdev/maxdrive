/**
 * Authenticated fetch against Google APIs.
 *
 * Owns the refresh mutex: concurrent callers whose token has expired all await
 * the same refresh promise instead of firing five refreshes and having Google
 * invalidate four of them.
 */
const tokenStore = require("./tokenStore.cjs");
const oauth = require("./oauthFlow.cjs");
const { accounts } = require("../db/queries.cjs");
const { scope } = require("../logger.cjs");

const log = scope("google");

/** Refresh a minute early so a request never starts with a token about to die. */
const SKEW_MS = 60_000;
const inFlight = new Map();

/** Transient by status alone - the request provably did not take effect. */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * 403 is ambiguous: it covers rate limiting *and* terminal conditions like
 * storageQuotaExceeded. Only these reasons are worth another attempt; anything
 * else must surface immediately so the uploader can re-allocate.
 */
const RETRY_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "sharingRateLimitExceeded",
  "backendError",
  "internalError",
]);

/**
 * 429 and rate-limit 403s mean the call was rejected before doing anything, so
 * every method is safe to repeat. A 5xx is different - the write may well have
 * landed and only the response was lost, and repeating a POST would create a
 * second folder or a second permission. Restrict those to methods that are
 * idempotent here: GET reads, and the resumable PUT whose Content-Range makes
 * it address a fixed byte offset rather than append.
 */
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT"]);
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 32_000;

/** Google sends either a seconds count or an HTTP date. */
function retryAfterMs(res) {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal) {
  const err = new Error(String(signal?.reason || "aborted"));
  err.name = "AbortError";
  return err;
}

/**
 * Peek at an error body without consuming the one the caller will read. Only
 * ever called for 4xx/5xx, which carry small JSON payloads - never for media.
 */
async function reasonOf(res) {
  try {
    const body = await res.clone().json();
    return body?.error?.errors?.[0]?.reason || null;
  } catch {
    return null;
  }
}

async function accessToken(accountId) {
  const tokens = tokenStore.get(accountId);
  if (!tokens) {
    const err = new Error("This account is not connected.");
    err.code = "NO_TOKENS";
    throw err;
  }
  if (tokens.access_token && tokens.expires_at - SKEW_MS > Date.now()) {
    return tokens.access_token;
  }

  let pending = inFlight.get(accountId);
  if (!pending) {
    pending = (async () => {
      try {
        const next = await oauth.refresh(tokens.refresh_token);
        tokenStore.set(accountId, next);
        accounts.setAuthState(accountId, "ok");
        return next.access_token;
      } catch (err) {
        if (err.code === "invalid_grant") {
          // Revoked, expired, or the Cloud project changed. Recoverable only
          // by re-consent, so flag it and let the UI offer Reconnect.
          accounts.setAuthState(accountId, "reauth_required");
          err.code = "REAUTH_REQUIRED";
        }
        throw err;
      } finally {
        inFlight.delete(accountId);
      }
    })();
    inFlight.set(accountId, pending);
  }
  return pending;
}

/**
 * @param {string|null} accountId  null means "use this raw token" (first call
 *   during connect, before the account row exists).
 */
async function request(accountId, url, { token, retry = true, ...init } = {}) {
  const method = (init.method || "GET").toUpperCase();
  let refreshed = false;

  for (let attempt = 1; ; attempt += 1) {
    const bearer = token || (await accessToken(accountId));
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${bearer}`, ...(init.headers || {}) },
    });

    if (res.status === 401 && retry && accountId && !token && !refreshed) {
      // Force a refresh by expiring the cached token, then try once more.
      refreshed = true;
      tokenStore.set(accountId, { expires_at: 0 });
      continue;
    }

    if (res.ok || !retry || attempt >= MAX_ATTEMPTS) return res;

    // Work out whether another attempt is honest, rather than just hopeful.
    let transient = RETRY_STATUS.has(res.status);
    if (res.status === 403) transient = RETRY_REASONS.has(await reasonOf(res));
    if (transient && res.status >= 500 && !IDEMPOTENT.has(method))
      transient = false;
    if (!transient) return res;

    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));
    const wait = retryAfterMs(res) ?? backoff + Math.random() * 1000;
    log.warn(
      `${method} ${url} → ${res.status}, retrying in ${Math.round(wait)}ms (${attempt}/${MAX_ATTEMPTS})`,
    );
    await sleep(wait, init.signal);
  }
}

async function json(accountId, url, init) {
  const res = await request(accountId, url, init);
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error bodies fall through to the message below */
  }
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason;
    const err = new Error(
      body?.error?.message || text.slice(0, 200) || res.statusText,
    );
    err.code = reason || `HTTP_${res.status}`;
    err.status = res.status;
    log.warn(`${url} → ${res.status} ${err.code}`);
    throw err;
  }
  return body;
}

module.exports = { accessToken, request, json };
