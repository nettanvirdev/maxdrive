# MaxDrive REST API (`/v1`)

Base URL `http://<pc-ip>:47821`. Envelope: `{ ok:true, data }` or
`{ ok:false, error:{ code, message } }`. All routes need
`Authorization: Bearer <token>` except where noted. See PROTOCOL.md for pairing,
discovery, WebSocket and signed URLs.

## Node shape

```jsonc
{
  "id": "g:<acct>:<fileId>",
  "parentId": "…|null",
  "name": "Report.pdf",
  "isFolder": false,
  "origin": "vfolder|managed|mirrored",
  "mime": "application/pdf",
  "size": 12345,
  "md5": "…|null",
  "createdAt": 0, "modifiedAt": 0,
  "starred": false, "trashed": false,
  "status": "ok|orphaned|missing_remote",
  "isGoogleDoc": false,
  "webViewLink": "…|null",
  "accountId": "…", "accountEmail": "…",
  "hasThumbnail": true, "hasBytes": true
}
```

## Endpoints

### Meta / auth (no bearer)
- `GET /v1/health` → `{ app, version, protocol, serverId, serverName }`
- `GET /v1/pair/challenge`, `POST /v1/pair/proof`,
  `GET /v1/auth/challenge`, `POST /v1/auth/token` — see PROTOCOL.md §2

### Read (bearer)
- `GET /v1/whoami` → `{ id, name, platform }`
- `GET /v1/nodes/roots`
- `GET /v1/nodes/children?parentId=&sort=name|modified|size`
- `GET /v1/nodes/:id`
- `GET /v1/nodes/:id/path`
- `GET /v1/search?q=&limit=`
- `GET /v1/recent?limit=`
- `GET /v1/starred?limit=`
- `GET /v1/trashed?limit=`
- `GET /v1/accounts`
- `GET /v1/storage` → `{ accounts:[…], totals:{ limit, usage, free } }`

### Media (bearer OR signed URL)
- `GET /v1/file/:id` — streams bytes, honours `Range` (206 + `Content-Range`).
  Add `?dl=1` for a `Content-Disposition: attachment`.
- `GET /v1/download/:id` — same, always as an attachment.
- `GET /v1/thumb/:id?s=<px>` — cached thumbnail image.
- `GET /v1/file/:id/link` / `GET /v1/thumb/:id/link` (bearer) →
  `{ url, exp }` — a signed URL for header-less consumers.

### Write (bearer)
- `POST /v1/ops/mkdir` `{ parentId?, name }`
- `POST /v1/ops/rename` `{ id, name }`
- `POST /v1/ops/move` `{ ids:[…], newParentId? }`
- `POST /v1/ops/trash` `{ ids:[…] }`
- `POST /v1/ops/restore` `{ ids:[…] }`
- `POST /v1/ops/star` `{ id, starred }`
- `POST /v1/uploads?parentId=<id>` — **raw body** = the file bytes; set header
  `X-Upload-Name: <url-encoded filename>`. Streams to the transfer queue, which
  picks an account by free space. → `{ transferId, name, size }`

### Events
- `GET /v1/events` — WebSocket; see PROTOCOL.md §4.

## Errors

`error.code` is stable for programmatic handling; `error.message` is
human-readable. Common: `UNAUTHORIZED` (401), `NOT_FOUND` (404),
`PAIR_NO_SESSION` (409), `PAIR_FAILED` (401), `PAIR_LOCKED` (423),
`NO_SPACE`/`NO_ACCOUNTS` (from uploads).
