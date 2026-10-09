# MaxDrive

Windows Electron app that unifies multiple storage accounts (Google Drive and
any S3-compatible bucket) into one virtual drive: one file tree, one search,
uploads auto-placed on whichever account has room. React 18 + Vite renderer, plain-`.cjs` main process (package
is `"type":"module"`), better-sqlite3 index, Zustand, Tailwind + CSS variables.
No TypeScript, no router, no Redux.

**Read these before non-trivial changes:**

- [docs/FEATURES.md](docs/FEATURES.md) - one-line inventory of every
  user-facing feature, grouped by area. Read first to know what already exists
  before building anything new.
- [docs/CODEBASE.md](docs/CODEBASE.md) - full file-by-file map: IPC contract,
  DB schema, boot sequence, renderer conventions, known quirks. Start here to
  find where anything lives.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - the six invariants and
  edge-case behaviour (sync, recovery, allocation, quotas). Behaviour claims
  are verified accurate; its `file:line` anchors have drifted, trust the prose.
- [docs/development.md](docs/development.md) - setup, testing, build and
  release. User-facing guides live in `docs/guides/` (update the matching
  guide, FEATURES.md and CHANGELOG.md when behaviour changes).

## Commands

- `bun run dev` - Vite (port 5173) + Electron together
- `bun run test` - Vitest (config is separate: `vitest.config.js`)
- `bun run build` / `bun run dist` - renderer build / setup + portable exe
  (`release/`); CI = `.github/workflows/ci.yml`, tag `v*` = `release.yml`
- Google OAuth client is entered in Settings → Google connection (stored
  DPAPI-encrypted in `oauth-client.bin`); a dev `.env` with
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` is the fallback (docs/guides/google-cloud-setup.md)

## Hard rules

- **All Google/DB/filesystem access lives in `src/main/`.** The renderer talks
  only through `window.maxdrive` (invoke, `{ok,data}` envelope) and
  `window.electronAPI` (window chrome), defined in `src/main/preload.cjs`.
  New IPC: add handler in `src/main/ipc.cjs`, expose in preload, done.
- **No `Promise.all` in `src/main`** - Drive traffic is deliberately
  sequential to stay inside Google's per-project quota. Keep it that way.
- **Identity is IDs, never names/paths**: nodes are `g:<accountId>:<fileId>`,
  accounts are Google `permissionId`. `nodes.origin`
  (`vfolder|managed|mirrored`) is the central discriminator.
- **Renderer behaviour = commands.** Any user-facing action goes in
  `src/renderer/commands/registry.js` (with `when`/`run`); menus
  (`ItemMenu` GROUPS), toolbar (`FileActions` TOOLBAR), NewMenu, palette and
  shortcuts (`shortcuts/defaults.js` - order matters for shared chords) are
  all just triggers into it. Never re-implement an action in a component.
- **Dialogs** go through `useOverlayStore` (add a `kind`) and render in
  `OverlayHost`, built on `ui/Modal.jsx` (`ModalButton`/`ModalError`/
  `inputClass`). Confirms via `ui/ConfirmDialog`; notifications via the
  `toast` singleton from `useToastStore`.
- **Styling**: Tailwind + CSS variables only, never hard-coded hex. New colors
  go in `styles/globals.css` in every color scheme block (`[data-scheme]` light + `.dark`; graphite/drive/midnight). Use the existing
  tokens (`drive-*`, `--hover-overlay`, `shadow-gcard`, `ease-standard`,
  `animate-dialog-in`). Match the hand-rolled pill-button style around you.
- **Data loading pattern**: hook that fetches via `window.maxdrive` and
  re-fetches on the matching `on.*` event - use `hooks/useIpcQuery.js`.
- Main-process errors: throw `Error` with `.code` (and `.retryable=false`
  where retrying can't help); the IPC envelope and transfer queue honour it.
- Modules that push to the renderer expose `setNotifier(fn)`; wiring lives in
  `main.cjs` only.

- **Local folder backup** lives in `src/main/localBackup/` (engine, scheduler,
  restore; queue kinds `backup`/`restore`; hidden `MaxDrive/.backup/` Drive
  area; IPC namespace `localBackup:*`; UI in `pages/BackupPage.jsx`). Pure
  logic (rules/differ/schedule) is unit-tested - keep it dependency-free.
  Details in docs/CODEBASE.md §2b. Don't confuse it with `sync/backup.cjs`,
  which is the INDEX cloud backup (`index:*` channels, `backup:status` event).

- **Secure Storage (the vault)** lives in `src/main/vault/` (queue kinds
  `vaultUp`/`vaultDown`; hidden `MaxDrive/.vault/` Drive area; IPC namespace
  `vault:*`; UI in `pages/SecurePage.jsx` + `components/vault/`). Rules that
  are not negotiable: **the master key never leaves `vault/session.cjs`** (the
  renderer receives decrypted results, never keys); **nothing plaintext is ever
  written to Drive or to a temp file** - `vault-tmp` holds only `.mxv`
  ciphertext; item names/mimes live encrypted in `vault_items.meta_ct`, so no
  query may `SELECT` a name. Pure logic (`crypto`, `blobFormat`, `planner`) is
  unit-tested and must stay free of Electron/DB imports. Details in
  docs/CODEBASE.md §2c.

- **Vault mode** (Settings → "Encrypt everything") seals every NEW upload and
  folder with its own X25519 key pair, independent of the Secure vault:
  `vault/seal.cjs` (pure crypto; private key = HKDF of the recovery key,
  password-wrapped), `vault/sealMode.cjs` (service + its own `keySession`
  instance), `seal_config` table, `nodes.seal_meta` (sealed {name,mime,size}).
  Rules: uploads seal with the **public key only** (they work while locked);
  sealed rows keep a **placeholder** in `nodes.name` - the real name is revealed
  in memory by `sealMode.reveal`, which every IPC result passes through
  (`ipc.cjs handle`) and `serialize.node` uses - **never write a revealed name
  back to the DB**; remote objects are `<uuid>.mxv` (sealed flag in the
  `.mxv` header); the index snapshot scrubs sealed transfer rows; local
  backups pause while it's on. IPC `seal:*`, event `seal:changed`.
  `vault/session.cjs` is now an instance of `vault/keySession.cjs`.

- **Storage providers** live in `src/main/providers/` (`index.cjs` =
  `providerFor(account)` + the interface; `gdrive.cjs` adapter over
  `drive/*`; `s3.cjs`). `accounts.provider` (`gdrive|s3`) picks the module;
  `accounts.config` holds non-secret settings, secrets go in `tokens.bin`.
  File ops, uploads, downloads, migration, cancel cleanup and media go through
  the provider - **never call driveApi/googleClient for a node directly**.
  S3 core is `src/main/s3/` (hand-rolled SigV4 + XML, no AWS SDK; pure
  `sigv4`/`xml`/`keys` are unit-tested in `tests/s3.test.js`). For S3, node
  ids stay `g:<accountId>:<objectKey>`, rename = copy+delete+`nodes.rekey`,
  trash/star are index-only, there is no change feed (the poller re-lists every
  15 min), and the user-set GB limit is `quota_limit` with usage = indexed
  bytes. Allocation includes S3 only for user files (`{userFiles:true}`); local
  backup, vault and index snapshots stay Drive-only.

- **LAN server (remote access + device pairing)** lives in `src/main/server/`
  (HTTP/WS/discovery facade `index.cjs`; `pairing/` = crypto/session/store;
  `auth/token.cjs` signed tokens; `routes.cjs` the `/v1` API; `media.cjs`
  shared thumbnail+range logic also used by `protocols.cjs`). **Opt-in, off by
  default** (`serverEnabled` setting); ports UDP 47820 (discovery) + TCP 47821
  (API), clear of other LAN apps. Trust model is **device pairing only** - a
  6-digit code + QR, PBKDF2(code,salt) → per-device secret, proof-only over the
  wire, explicit desktop approval, 3-strike/60 s lockout (ported from the
  reference `PhoneAsController`). Rules: **the pairing code never crosses the
  network**; per-device secrets are DPAPI-wrapped like `auth/tokenStore.cjs`;
  tokens are stateless-signed but checked against the store each request so a
  revoke is immediate. Routes call the SAME services as `ipc.cjs`
  (`db/queries`, `ops`, `queue`) - never duplicate logic. Renderer drives it
  through `window.maxdrive.server` + `on.server*`; pairing UI is
  `components/server/` (overlay kind `pairDevice`). Pure logic
  (`pairing/crypto`, `auth/token`, `discovery` parse, `mcp` dispatch) is
  unit-tested in `tests/server-*.test.js` and must stay free of Electron/DB
  imports. The **in-app MCP server** is `server/mcp/endpoint.cjs` - hand-rolled
  JSON-RPC 2.0 at `POST /mcp` (bearer-authed, tools call the same services);
  `server.createMcpToken()` mints a paired `mcp` device token + `claude mcp add`
  command. Write REST routes (`POST /v1/ops/*`, streamed `POST /v1/uploads`) and
  the client-facing `skills/` folder (Agent Skill + stdio bridge + API/PROTOCOL
  references) are built. Still to come: the offline mobile delta feed
  (`/v1/index/delta`) + native clients.

## Gotchas

- Frameless transparent window - `HeaderBar.jsx` IS the titlebar
  (`titlebar-drag` / `titlebar-no-drag` classes).
- Custom protocols `maxthumb://node/<id>` (thumbnails), `maxfile://node/<id>`
  (preview streaming with Range) and `maxvault://item|thumb/<id>` (decrypts
  vault chunks on the fly, 403 while locked); all CSP-whitelisted in
  `index.html` and registered pre-`app.whenReady` in `protocols.cjs`.
- Dropped files: `window.maxdrive.getPathForFile(file)` - `File.path` no
  longer exists in Electron 32+.
- `viewMode` exists in both `useSettingsStore` (persisted) and `useUiStore`
  (session) - they can diverge.
- Lists render all rows (no virtualization).
