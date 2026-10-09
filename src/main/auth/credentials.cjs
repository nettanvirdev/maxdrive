/**
 * Google OAuth client credentials.
 *
 * These identify the *application*, not the user, and they are deliberately
 * separate from the account tokens. Changing them later costs nothing but a
 * re-login: the files themselves live in the Google accounts, and the index
 * backup sits in a visible MaxDrive/.index folder rather than the OAuth-bound
 * appDataFolder, so it stays reachable across credential changes.
 *
 * Entered in Settings and stored encrypted (DPAPI) in oauth-client.bin, so no
 * build ships a client. GOOGLE_CLIENT_ID/SECRET from .env (env.cjs) are a dev
 * fallback, used only while nothing is saved.
 *
 * A "Desktop app" client secret is not a true secret - Google's own docs note
 * that installed apps cannot keep one confidential, which is why the flow also
 * uses PKCE.
 */
const { scope } = require("../logger.cjs");
const { sealedPath, readSealed, writeSealed } = require("./sealedFile.cjs");

const log = scope("credentials");

function file() {
  return sealedPath("oauth-client.bin");
}

function stored() {
  try {
    return readSealed(file());
  } catch (err) {
    // A fresh Windows install cannot decrypt the previous user's DPAPI blob;
    // the user simply enters the credentials again.
    log.warn(`could not read stored client credentials: ${err.message}`);
    return null;
  }
}

function fromEnv() {
  const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function get() {
  return stored() || fromEnv() || { clientId: "", clientSecret: "" };
}

/**
 * What the renderer is allowed to know: whether sign-in can work and where the
 * credentials came from. Never the ID or the secret - the Settings screen is
 * visible to anyone this app is shared with.
 */
function status() {
  const source = stored() ? "stored" : fromEnv() ? "env" : null;
  return { ready: Boolean(source), source };
}

function set({ clientId, clientSecret } = {}) {
  const id = String(clientId || "").trim();
  const secret = String(clientSecret || "").trim();
  if (!id.endsWith(".apps.googleusercontent.com") || !secret) {
    const err = new Error(
      "Enter the Client ID (ending in .apps.googleusercontent.com) and the Client secret.",
    );
    err.code = "INVALID_CREDENTIALS";
    err.retryable = false;
    throw err;
  }
  writeSealed(file(), { clientId: id, clientSecret: secret });
  log.info("client credentials saved");
  return status();
}

module.exports = { get, status, set };
