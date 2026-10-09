/**
 * Desktop OAuth: PKCE + an ephemeral loopback listener.
 *
 * Google retired the out-of-band redirect, so the only supported desktop flow
 * is a localhost server on an OS-assigned port. The server handles exactly one
 * callback and shuts down, whatever the outcome.
 */
const http = require("node:http");
const crypto = require("node:crypto");
const { shell } = require("electron");
const credentials = require("./credentials.cjs");
const { scope } = require("../logger.cjs");

const log = scope("oauth");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SCOPE = "https://www.googleapis.com/auth/drive";
const TIMEOUT_MS = 180_000;

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function pkce() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:Segoe UI,system-ui,sans-serif;background:#F8FAFD;color:#1F1F1F;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
div{text-align:center}h1{font-size:20px;font-weight:500}p{color:#444746;font-size:14px}</style>
<div><h1>${title}</h1><p>${body}</p></div>`;
}

/** Starts the listener first so the redirect URI is known before we open the browser. */
function listen() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/**
 * Opens the consent screen and resolves with the raw token response.
 * `loginHint` pins the flow to one Gmail when reconnecting.
 */
async function authorize({ loginHint } = {}) {
  const { clientId, clientSecret } = credentials.get();
  if (!clientId || !clientSecret) {
    const err = new Error(
      "Google client ID or secret is missing. Add them in Settings → Google connection.",
    );
    err.code = "NO_CREDENTIALS";
    throw err;
  }

  const server = await listen();
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const { verifier, challenge } = pkce();
  const state = base64url(crypto.randomBytes(24));

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    // select_account lets the user pick which Gmail; consent guarantees a
    // refresh token even for an account that has authorised before.
    prompt: "consent select_account",
    include_granted_scopes: "true",
  });
  if (loginHint) params.set("login_hint", loginHint);

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish();
      const err = new Error("Timed out waiting for Google sign-in.");
      err.code = "OAUTH_TIMEOUT";
      reject(err);
    }, TIMEOUT_MS);

    let done = false;
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
    }

    server.on("request", (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");

      const error = url.searchParams.get("error");
      if (error) {
        res.end(
          page(
            "Sign-in cancelled",
            "You can close this tab and try again in MaxDrive.",
          ),
        );
        finish();
        const err = new Error(`Google returned "${error}".`);
        err.code = "OAUTH_DENIED";
        reject(err);
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.end(
          page(
            "Something went wrong",
            "The sign-in response could not be verified.",
          ),
        );
        finish();
        const err = new Error(
          "OAuth state mismatch - the response was not for this request.",
        );
        err.code = "OAUTH_STATE";
        reject(err);
        return;
      }
      res.end(
        page(
          "MaxDrive is connected",
          "You can close this tab and return to the app.",
        ),
      );
      finish();
      resolve(url.searchParams.get("code"));
    });

    log.info(`waiting for callback on 127.0.0.1:${port}`);
    shell.openExternal(`${AUTH_URL}?${params.toString()}`);
  });

  return exchange({ code, verifier, redirectUri, clientId, clientSecret });
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* Google returns HTML on some infrastructure errors */
  }
  if (!res.ok) {
    const err = new Error(
      json.error_description || json.error || text.slice(0, 200),
    );
    err.code = json.error || `HTTP_${res.status}`;
    throw err;
  }
  return json;
}

async function exchange({
  code,
  verifier,
  redirectUri,
  clientId,
  clientSecret,
}) {
  const json = await postForm(TOKEN_URL, {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  if (!json.refresh_token) {
    // Without one the account would silently die in an hour.
    const err = new Error(
      "Google did not return a refresh token. Try again and approve all prompts.",
    );
    err.code = "NO_REFRESH_TOKEN";
    throw err;
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
    scope: json.scope,
  };
}

async function refresh(refreshToken) {
  const { clientId, clientSecret } = credentials.get();
  const json = await postForm(TOKEN_URL, {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  return {
    access_token: json.access_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
    ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}),
  };
}

async function revoke(token) {
  try {
    await postForm(REVOKE_URL, { token });
  } catch (err) {
    // An already-invalid token is the desired end state anyway.
    log.warn(`revoke failed (ignored): ${err.message}`);
  }
}

module.exports = { authorize, refresh, revoke, SCOPE };
