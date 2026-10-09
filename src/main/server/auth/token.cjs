/**
 * Stateless, signed device tokens and signed media URLs for the LAN server.
 *
 * A token is `v1.<deviceId>.<exp>.<tokenVersion>.<sig>` where
 *   sig = base64url(HMAC-SHA256(signingKey, "v1.<deviceId>.<exp>.<tokenVersion>"))
 * The token carries no secret, so it is safe to hand to a paired device. It is
 * self-validating (signature + expiry) AND checked against the device store on
 * every request, so revoking a device - or bumping its token_version - takes
 * effect immediately even though the token itself is stateless.
 *
 * Signed URLs exist for the handful of consumers that cannot set an
 * Authorization header (an <img>/<video> src): a short-lived `?exp=&sig=` over
 * an opaque node id. Node ids are not personal data, so this does not violate
 * the "no personal data in URLs" rule.
 *
 * PURE: no Electron/DB imports. The caller supplies the signing key.
 */
const crypto = require("node:crypto");

const TOKEN_PREFIX = "v1";
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const URL_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours for signed media links

function b64url(buf) {
  return buf.toString("base64url");
}

function hmac(signingKey, message) {
  return crypto.createHmac("sha256", signingKey).update(message).digest();
}

/** Constant-time string compare that never throws on length mismatch. */
function safeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * @param {{deviceId:string, tokenVersion:number, exp?:number, ttlMs?:number}} claims
 * @param {Buffer|string} signingKey
 */
function sign(claims, signingKey) {
  const exp =
    claims.exp ?? Date.now() + (claims.ttlMs ?? DEFAULT_TTL_MS);
  const tv = claims.tokenVersion ?? 1;
  const payload = `${TOKEN_PREFIX}.${claims.deviceId}.${exp}.${tv}`;
  const sig = b64url(hmac(signingKey, payload));
  return `${payload}.${sig}`;
}

/**
 * Verify signature + expiry. Returns `{deviceId, exp, tokenVersion}` or null.
 * Does NOT check the device store - the caller does that so revocation is live.
 */
function verify(token, signingKey) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 5) return null;
  const [prefix, deviceId, expStr, tvStr, sig] = parts;
  if (prefix !== TOKEN_PREFIX) return null;
  const payload = `${prefix}.${deviceId}.${expStr}.${tvStr}`;
  const expected = b64url(hmac(signingKey, payload));
  if (!safeEqualStr(sig, expected)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return { deviceId, exp, tokenVersion: Number(tvStr) };
}

/**
 * Sign an opaque resource id into an expiring query string.
 * @returns {{exp:number, sig:string}}
 */
function signUrl(id, signingKey, ttlMs = URL_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const sig = b64url(hmac(signingKey, `url.${id}.${exp}`));
  return { exp, sig };
}

/** Verify a signed URL for `id`. Returns true only if the sig matches and is unexpired. */
function verifyUrl(id, exp, sig, signingKey) {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;
  const expected = b64url(hmac(signingKey, `url.${id}.${expNum}`));
  return safeEqualStr(sig, expected);
}

module.exports = {
  DEFAULT_TTL_MS,
  URL_TTL_MS,
  sign,
  verify,
  signUrl,
  verifyUrl,
};
