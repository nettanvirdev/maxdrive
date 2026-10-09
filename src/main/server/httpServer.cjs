/**
 * Minimal HTTP request handler for the LAN API: route matching, bearer /
 * signed-URL auth, JSON `{ok,data}` envelope, and error→status mapping. No
 * Express - the route table lives in routes.cjs and the media reuse in
 * media.cjs. Range streaming is done by the media handlers writing to `res`.
 */
const { scope } = require("../logger.cjs");
const token = require("./auth/token.cjs");
const store = require("./pairing/store.cjs");
const { ROUTES, RAW } = require("./routes.cjs");

const log = scope("server-http");

const MAX_BODY_BYTES = 2 * 1024 * 1024; // pairing/ops bodies are tiny

/** Map a coded error to an HTTP status. */
const CODE_STATUS = {
  PAIR_NO_SESSION: 409,
  PAIR_LOCKED: 423,
  PAIR_FAILED: 401,
  PAIR_DENIED: 403,
  PAIR_TIMEOUT: 408,
  PAIR_CANCELLED: 409,
  PAIR_PROTOCOL: 400,
  AUTH_NO_CHALLENGE: 409,
  AUTH_FAILED: 401,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
};

/** Compile ":param" paths into matchers once. */
const COMPILED = ROUTES.map((r) => {
  const keys = [];
  const pattern = r.path.replace(/:[^/]+/g, (m) => {
    keys.push(m.slice(1));
    return "([^/]+)";
  });
  return { ...r, regex: new RegExp(`^${pattern}$`), keys };
});

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
  };
}

/** Verify an `Authorization: Bearer` header against the device store. Returns row or null. */
function authenticateBearer(authHeader, signingKey) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const claims = token.verify(authHeader.slice(7).trim(), signingKey);
  if (!claims) return null;
  const row = store.byId(claims.deviceId);
  if (!row || row.revoked) return null;
  if (row.token_version !== claims.tokenVersion) return null; // revoked/rotated
  return row;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function createRequestHandler(signingKey) {
  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return sendJson(res, 400, { ok: false, error: { code: "BAD_URL" } });
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);

    // Match route (order in the table matters: specific before generic).
    let route = null;
    let params = {};
    for (const r of COMPILED) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(url.pathname);
      if (!m) continue;
      route = r;
      params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      break;
    }
    if (!route) {
      return sendJson(res, 404, { ok: false, error: { code: "NO_ROUTE" } });
    }

    // Authenticate.
    let device = null;
    if (route.auth === "device" || route.auth === "media") {
      device = authenticateBearer(req.headers.authorization, signingKey);
      if (!device && route.auth === "media") {
        const ok = token.verifyUrl(
          params.id,
          url.searchParams.get("exp"),
          url.searchParams.get("sig"),
          signingKey,
        );
        if (!ok) {
          return sendJson(res, 401, {
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Bad or missing token." },
          });
        }
      } else if (!device) {
        return sendJson(res, 401, {
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Bad or missing token." },
        });
      }
      if (device) store.touch(device.id);
    }

    try {
      const ctx = {
        req,
        res,
        params,
        query: url.searchParams,
        device,
        remoteIp: req.socket.remoteAddress,
        signingKey,
        // Raw routes (streamed uploads) read the body themselves; everyone else
        // gets the parsed JSON body for POST.
        body: req.method === "POST" && !route.raw ? await readBody(req) : {},
      };
      const result = await route.handler(ctx);
      if (result === RAW) return; // handler already wrote the response
      sendJson(res, 200, { ok: true, data: result });
    } catch (err) {
      const status = err.status || CODE_STATUS[err.code] || 500;
      if (status >= 500) log.warn(`${req.method} ${url.pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) {
        sendJson(res, status, {
          ok: false,
          error: { code: err.code || "INTERNAL", message: err.message },
        });
      }
    }
  };
}

module.exports = { createRequestHandler, authenticateBearer };
