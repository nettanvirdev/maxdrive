# MaxDrive LAN protocol

The contract between the MaxDrive desktop app (**server**) and a **client**
(mobile app, AI assistant, or any tool). LAN only; no cloud, no account, no
relay. All pairing crypto matches the reference `PhoneAsController` project so a
client that already speaks that scheme needs no changes.

- **Discovery:** UDP **47820**
- **API + WebSocket + MCP:** TCP **47821** (HTTP/1.1)
- All bodies are JSON unless noted. The REST envelope is `{ ok, data }` or
  `{ ok:false, error:{ code, message } }`.

## 1. Discovery

The client broadcasts a probe; every MaxDrive server on the subnet unicasts a
JSON reply to the probe's source.

```
probe : "MAXDRV?" (7 bytes ASCII) || version (1 byte, 0x01)   → UDP 47820 broadcast
reply : { "magic":"MAXDRV!", "version":1, "name":"<hostname>",
          "app":"MaxDrive", "appVersion":"<x.y.z>",
          "apiPort":47821, "serverId":"<uuid>" }
```

`serverId` is stable across IP changes, so a client can keep recognising a PC.
Probes with a newer version byte are ignored; older ones are tolerated.

## 2. Pairing (device trust)

Trust is established once per device with a 6-digit code shown on the PC. The
**code never crosses the network** - the client derives a secret from it and
sends only a proof. The desktop user must explicitly approve the device.

Crypto (identical to the reference):

| Parameter | Value |
|---|---|
| Code | 6 decimal digits, CSPRNG, shown on the PC (and in a QR) |
| Salt | 16 random bytes, per pairing session |
| Secret | `PBKDF2-HMAC-SHA256(code, salt, 10000, 32 bytes)` |
| Proof | `HMAC-SHA256(secret, salt)`, base64 |
| Hardening | 3 wrong proofs → 60 s lockout; code expires after 3 min |

Flow (desktop-initiated - the user opens "Add device" first):

1. `GET /v1/pair/challenge` → `{ salt, serverId, serverName }` (409 if no
   pairing session is open).
2. Client computes `secret = PBKDF2(code, salt)` and
   `proof = HMAC(secret, salt)`.
3. `POST /v1/pair/proof` `{ deviceId, name, platform, proof }`. The request
   **blocks** until the desktop user approves. On approval → `200
   { token, serverId, serverName, apiBase }`. Wrong proof → 401; too many →
   423; denied → 403; timed out → 408.

`deviceId` is a client-generated UUID the client persists; it is the identity
the secret is bound to. `token` is a bearer token (see §3).

The QR shown on the PC encodes:
`maxdrive://pair?h=<ip>&p=47821&c=<code>&sid=<serverId>&n=<hostname>`.
Parse leniently; reject a payload without a 6-digit `c`.

### Re-auth (rotate a token without re-pairing)

1. `GET /v1/auth/challenge?deviceId=<id>` → `{ nonce }`.
2. `POST /v1/auth/token` `{ deviceId, proof }` where
   `proof = HMAC(secret, nonce)` → `{ token, apiBase }`.

## 3. Authentication

Every `/v1` route except `/v1/health` and `/v1/pair/*` and `/v1/auth/*`
requires the bearer token:

```
Authorization: Bearer <token>
```

Tokens are signed and self-expiring (30 days) but are ALSO checked against the
device store on every request, so a revoke from the desktop takes effect
immediately. A revoked or rotated token returns 401.

**Media without headers.** For an `<img>`/`<video>` that cannot set headers, ask
an authenticated endpoint for a signed URL:
`GET /v1/file/:id/link` or `/v1/thumb/:id/link` → `{ url, exp }`. The URL carries
`?exp=&sig=` and works with no Authorization header until it expires.

## 4. WebSocket events

`GET /v1/events` (Upgrade). Authenticate with the bearer header, or - for
browser clients that cannot set WS headers - `?token=<bearer>`. The server
pushes JSON frames `{ type, payload, at }` for `nodes:changed`,
`transfers:state`, `transfers:progress`, `accounts:changed`, `sync:status`. A
client keeps its cached index live while the desktop is running, and falls back
to the cache when it is not.

## 5. MCP

`POST /mcp` speaks JSON-RPC 2.0 (Model Context Protocol, Streamable HTTP
profile) with the same bearer auth. `initialize`, `tools/list`, `tools/call`,
`ping`. Responses are `application/json`; notifications get `202`. See the app's
tool catalog in ../SKILL.md.
