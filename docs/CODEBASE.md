# MaxDrive - Codebase Map

A file-by-file map of the whole project, written so a change can be planned
without re-exploring the tree. Companion to [ARCHITECTURE.md](ARCHITECTURE.md),
which covers the invariants and edge-case behaviour; this file covers _where
everything lives and how it connects_.

Stack: Electron 43 (main process in plain `.cjs`, since package.json is
`"type": "module"`), React 18 + Vite 5 renderer, Tailwind 3 + CSS variables,
Zustand 5, better-sqlite3, electron-log. No TypeScript, no React Router, no
Redux. Tests: Vitest + jsdom.

```
src/main/          Electron main process - ALL Google/DB/FS access
src/main/localBackup/  local→cloud folder backup engine (see §2b)
src/main/vault/        Secure Storage: encrypted vault (see §2c)
src/renderer/      React renderer - talks only through window.maxdrive
docs/              ARCHITECTURE.md (invariants), CODEBASE.md (this file)
scripts/           icon generation + UI screenshot capture (dev tools)
tests/             vitest unit tests (pure logic only)
release/           electron-builder output (git-ignored)
```

---

## 1. Process model and the IPC contract

Everything Google-facing lives in the main process. The renderer is a pure UI
over two bridges defined in [preload.cjs](../src/main/preload.cjs):

- **`window.electronAPI`** - window chrome only (minimize/maximize/close/
  beginDrag, `onWindowState`), one-way `ipcRenderer.send`.
- **`window.maxdrive`** - the whole feature API via `ipcRenderer.invoke`.
  Every handler returns an `{ ok, data } | { ok:false, error }` envelope;
  the preload `call()` helper unwraps it and throws an `Error` with `.code`.
  Also `window.maxdrive.getPathForFile(file)` (sync, webUtils) - the only way
  to get a dropped file's path since Electron 32.

**`window.maxdrive` domains** (channel = `domain:method`):

| Domain        | Methods                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app`         | `info`                                                                                                                                                                                                                                                                                                                                                                                           |
| `settings`    | `get`, `set(patch)`                                                                                                                                                                                                                                                                                                                                                                              |
| `auth`        | `credentials` → `{ready,source}`, `setCredentials({clientId,clientSecret})` (write-only)                                                                                                                                                                                                                                                                                                                                               |
| `accounts`    | `list`, `connect`, `reauth`, `disconnect(id,purge)`, `disconnectImpact`, `refreshQuota(id,force)`                                                                                                                                                                                                                                                                                                |
| `sync`        | `scan(accountId?)`, `status`                                                                                                                                                                                                                                                                                                                                                                     |
| `index`       | `backupNow`, `status`, `listRestoreCandidates`, `restoreFrom(accountId,fileId,name)`                                                                                                                                                                                                                                                                                                             |
| `share`       | `createLink`, `revoke`, `listPermissions`, `addPerson(id,email,role,notify)`, `removePermission`                                                                                                                                                                                                                                                                                                 |
| `ops`         | `mkdir`, `rename`, `move`, `copy`, `trash`, `restore`, `deleteForever`, `star`                                                                                                                                                                                                                                                                                                                   |
| `transfers`   | `list`, `enqueuePaths`, `enqueueDownload`, `enqueueMigration`, `pause`, `resume`, `cancel`, `retry`, `remove`, `clearCompleted`, `pauseAll`, `resumeAll`                                                                                                                                                                                                      |
| `nodes`       | `children(parentId,sort)`, `roots`, `get`, `path`, `search`, `recent`, `starred`, `trashed`, `activity`                                                                                                                                                                                                                                                                                          |
| `localBackup` | `listSets`, `createSet`, `updateSet`, `deleteSet(id,removeRemote)`, `runNow`, `confirmDeletions`, `pauseSet`, `resumeSet`, `setGlobalPaused`, `status`, `tree(setId,prefix)`, `restore({setId,paths,overwrite,includeTrashed})`                                                                                                               |
| `vault`       | `status`, `setup(password)`, `unlock(secret,recovery)`, `lock`, `changePassword`, `regenerateRecoveryKey`, `saveRecoveryKey`, `list(parentId)`, `details`, `newFolder`, `rename`, `remove(ids)`, `upload(paths,parentId)`, `download(ids,destDir?)`, `accounts`, `addAccount`, `removalImpact`, `removeAccount(id,mode,deleteRemote)`, `getSettings`, `setSettings`, `recoverScan`, `recoverRun` |
| `shell`       | `openExternal` (http/https only), `showInFolder`                                                                                                                                                                                                                                                                                                                                                 |
| `dialog`      | `pickFiles`, `pickFolder`                                                                                                                                                                                                                                                                                                                                                                        |

**Events pushed main → renderer** (subscribe via `window.maxdrive.on.*`, each
returns an unsubscribe fn). All emitted through `window.cjs` `send()`; wiring
lives in [main.cjs](../src/main/main.cjs) (notifier callbacks + queue event
forwarders):

| Channel                        | Fired when                                                         |
| ------------------------------ | ------------------------------------------------------------------ |
| `accounts:changed`             | connect / disconnect / quota refresh                               |
| `nodes:changed`                | any index mutation: ops, scanner page, poller drain, transfer done |
| `transfers:progress`           | coalesced byte progress (250 ms batches)                           |
| `transfers:state`              | transfer state change or queue membership change                   |
| `sync:status`                  | scanner progress                                                   |
| `backup:status`                | INDEX backup lifecycle (sync/backup.cjs)                           |
| `localBackup:changed`          | backup-set config or run list changed                              |
| `localBackup:progress`         | run-level backup progress (coalesced 500 ms)                       |
| `vault:changed`                | vault items, accounts or settings changed                          |
| `vault:progress`               | per-item encrypt/upload/decrypt progress (coalesced 400 ms)        |
| `vault:lockChanged`            | vault unlocked or locked (incl. idle auto-lock)                    |
| `window-state` | window chrome (via `electronAPI`)                                  |

**Custom protocols** ([protocols.cjs](../src/main/protocols.cjs), registered
pre-ready at require time):

- `maxthumb://node/<nodeId>?s=<px>` - authenticated Drive thumbnail, disk-cached
  in `userData/thumbs/`, 4-fetch semaphore. Used by grid view.
- `maxvault://item/<id>` - decrypts the chunks covering the requested Range and
  serves 206 with the real mime; `maxvault://thumb/<id>` serves the encrypted
  thumbnail. Both 403 while the vault is locked. See §2c.
- `maxfile://node/<nodeId>` - streams file bytes with Range proxied both ways
  (video scrubbing, PDF viewer). Used by PreviewModal. Both are CSP-whitelisted
  in [index.html](../src/renderer/index.html).

---

## 2. Main process (`src/main/`)

### Boot sequence ([main.cjs](../src/main/main.cjs))

`env.load()` → single-instance lock → `whenReady:` db open (integrity check +
migrations + seed) → `settings.syncOnStartup` → token reconcile → window IPC +
feature IPC → queue event forwarders → protocol handlers → `queue.setWorkers`

- `queue.start({autoResume})` (crash recovery **before** scans) → notifiers for
  ops/scanner/backup/changePoller → fire-and-forget `scanner.scanAll({onlyStale})`
  → `backup.start()` (6 h periodic) → `changePoller.start()` →
  `refreshAllQuotas()` → powerMonitor suspend/resume hooks → tray → window
  (`--hidden` argv → start in tray). `before-quit` flushes progress, stops
  pollers, closes the DB.

### Files

| File                                         | Responsibility                                                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [main.cjs](../src/main/main.cjs)             | Entry; boot order above; owns powerMonitor + lifecycle handlers; wires all cross-module notifiers                                                                                                                      |
| [env.cjs](../src/main/env.cjs)               | Hand-rolled `.env` loader. Search order: `$MAXDRIVE_ENV_FILE` → exe dir → resources → userData → app path. Never overwrites real env vars                                                                              |
| [logger.cjs](../src/main/logger.cjs)         | electron-log wrapper; `scope(name)` per subsystem                                                                                                                                                                      |
| [settings.cjs](../src/main/settings.cjs)     | Settings facade over the DB `settings` table. DEFAULTS: theme system, viewMode list, minimizeToTray true, openAtLogin false, autoResumeTransfers true, headroomMb 200. Holds shared `state.quitting` flag              |
| [window.cjs](../src/main/window.cjs)         | The single BrowserWindow: **frameless, transparent**, 1280×820, min 1100×700, close-to-tray. `send()` = all main→renderer pushes. One-way chrome IPC                                                                   |
| [tray.cjs](../src/main/tray.cjs)             | Tray icon + menu with live transfer counts, pause/resume all, Quit (sets `quitting`)                                                                                                                                   |
| [protocols.cjs](../src/main/protocols.cjs)   | `maxthumb://` + `maxfile://` (see §1)                                                                                                                                                                                  |
| [ipc.cjs](../src/main/ipc.cjs)               | All ~45 `ipcMain.handle` registrations, `{ok,data}` envelope; also `enqueueFolderTree` (local folder → vfolders + upload jobs) and `descendantFiles` (subtree flatten for migration)                                   |
| [allocation.cjs](../src/main/allocation.cjs) | **Worst-fit** account picker at transfer start. `free = quota_limit − quota_usage − SUM(size−bytes_done of non-terminal writes)`. Pin = preference, still space-checked. Throws non-retryable `NO_ACCOUNTS`/`NO_SPACE` |
| [ops.cjs](../src/main/ops.cjs)               | All node mutations: mkdir/rename/move (cycle guard)/copy (server-side)/trash/restore (cascade)/deleteForever (remote-first)/star, `uniqueName` dedup. vfolder ops index-only; managed/mirrored also hit Drive          |
| [preload.cjs](../src/main/preload.cjs)       | The two contextBridge surfaces (§1)                                                                                                                                                                                    |

**auth/**

| File                                                      | Responsibility                                                                                                                                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [accountService.cjs](../src/main/auth/accountService.cjs) | connect/reauth/disconnect/quota. Identity = Google `permissionId` (PK, idempotent upsert). Reauth verifies same account. Disconnect: keep (`orphaned`) or purge. Quota TTL 15 min                         |
| [oauthFlow.cjs](../src/main/auth/oauthFlow.cjs)           | PKCE S256 + loopback on port 0, verified state, 180 s timeout; token exchange/refresh/revoke. Scope: full `auth/drive`                                                                                    |
| [tokenStore.cjs](../src/main/auth/tokenStore.cjs)         | Per-account tokens, DPAPI (`safeStorage`) → `tokens.bin`; unreadable file moved aside, write-then-rename; plaintext fallback if DPAPI missing                                                             |
| [sealedFile.cjs](../src/main/auth/sealedFile.cjs)         | `readSealed`/`writeSealed`: DPAPI-encrypted JSON in userData, write-then-rename. Used by tokenStore and credentials |
| [credentials.cjs](../src/main/auth/credentials.cjs)       | OAuth _client_ id/secret entered in Settings (`auth:setCredentials`, write-only) → DPAPI `oauth-client.bin`; dev `.env` fallback. Renderer sees `{ready,source}` only                                                                                          |
| [googleClient.cjs](../src/main/auth/googleClient.cjs)     | Authenticated fetch + **all retry/backoff** (Retry-After, 429/408/5xx, 403 only for rate-limit, 5xx only idempotent, one refresh on 401, refresh mutex). `invalid_grant` → `auth_state='reauth_required'` |

**db/**

| File                                            | Responsibility                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [database.cjs](../src/main/db/database.cjs)     | Opens SQLite (WAL, FK ON). Corrupt file renamed `.corrupt-<ts>`. Downgrade guard. Transactional migrations. Seeds `root-managed` vfolder. `replaceWith` for restore |
| [migrations.cjs](../src/main/db/migrations.cjs) | V1–V3, `LATEST_VERSION=3`. Schema in §4                                                                                                                             |
| [queries.cjs](../src/main/db/queries.cjs)       | Lazy prepared statements grouped: `settings`, `accounts`, `syncState`, `nodes`, `activity`. Shared `NODE_SELECT` projection. `resetStatementCache` after restore    |

**drive/**

| File                                               | Responsibility                                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [driveApi.cjs](../src/main/drive/driveApi.cjs)     | Thin Drive v3 REST client; every endpoint has a `fields` projection. `ensureAppFolders` creates `MaxDrive/` + `.index/`                                  |
| [uploader.cjs](../src/main/drive/uploader.cjs)     | Resumable uploads, 8 MiB chunks, session persisted; `probeSession` on resume; single `finalize()` for all completion paths; quota-exceeded → re-allocate |
| [downloader.cjs](../src/main/drive/downloader.cjs) | Range-resume onto `.maxdrivepart`, length+md5 verify, fsync, rename                                                                                      |
| [migrate.cjs](../src/main/drive/migrate.cjs)       | Cross-account move: download → verify → upload → verify → repoint index row + children → delete source last                                              |
| [share.cjs](../src/main/drive/share.cjs)           | Link + per-person permissions; refuses vfolders                                                                                                          |
| [cleanup.cjs](../src/main/drive/cleanup.cjs)       | Cancel cleanup: discard Drive session / partial file                                                                                                     |

**sync/**

| File                                                  | Responsibility                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [scanner.cjs](../src/main/sync/scanner.cjs)           | Per-account full scan, two-pass (rows then `linkParents`), per-page checkpointed `scan_cursor`, synthetic `g:<acct>:root` node, skips `.index`, sequential across accounts (quota safety), `pruneMissing`                                                                                                |
| [changePoller.cjs](../src/main/sync/changePoller.cjs) | `changes.list` per account; 45 s focused / 5 min blurred; non-overlapping; `pollSoon` (2.5 s coalesced echo-swallow); removed/trashed branches by origin (mirrored deleted, managed → `missing_remote`); only 410/`invalidPageToken` triggers rescan                                                     |
| [backup.cjs](../src/main/sync/backup.cjs)             | `VACUUM INTO` → gzip → upload to `.index/` in every account; sha256 in filename; fingerprint-gated; 3 generations; 5 min debounce + 6 h periodic. Restore: checksum → integrity → schema-version checks on staging before swap, then null all page tokens. Post-wipe discovery falls back to token store |

### §2b - Local→cloud backup (`src/main/localBackup/`)

One-way backup of user-picked local folders into a hidden `MaxDrive/.backup/`
area, per set, with scheduling, filtering, pause/resume, crash re-attach and
restore (incl. Drive-trash recovery). Rides the transfer queue via kinds
`backup` (write) and `restore` (read); those kinds are filtered out of
`queue.listVisible()` (Transfers page, LAN API) and surface run-level in the Backup tab instead.

| File                                                       | Responsibility                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.cjs`                                                | Facade + service layer for IPC; 60 s scheduler tick (one run at a time globally, catch-up on boot, global pause via settings key `localBackupPaused`); progress coalescing                                                                                                   |
| `runner.cjs`                                               | Mirror-run lifecycle: walk → diff → renames-as-PATCH → deletions per policy (`trash`\|`keep`) → wave-enqueue (≤20 in flight, priority −10) → finalize. Mass-delete guard (`DELETIONS_HELD`, >20 files and >25% → user confirm). Crash `reattach()` rebuilds runs from tables |
| `rules.cjs` / `walker.cjs` / `differ.cjs` / `schedule.cjs` | Pure logic (unit-tested in tests/backup\*.test.js): include/exclude compilation (dotfile-aware ext matching), iterative pruned walk, diff classification (2 s mtime tolerance, unique-pair rename detection), `computeNextRun`                                               |
| `folders.cjs`                                              | Drive folder-skeleton ensure per (set, account); backup_folders doubles as the scanner hide-list                                                                                                                                                                             |
| `backupWorker.cjs`                                         | Queue worker: md5-before-upload, create vs update (same fileId → Drive revisions) sessions via uploadCore, entry marked `ok` only after Drive md5 matches, sticky-with-spill on quota-exceeded; archive-part branch                                                          |
| `restoreWorker.cjs`                                        | Queue worker over `downloadToPath`; missing-only re-check, overwrite via temp+swap                                                                                                                                                                                           |
| `restore.cjs`                                              | Tree browse from backup_entries (or archive manifest), restore planning                                                                                                                                                                             |
| `archive.cjs` / `archiveRestore.cjs`                       | Archive mode: one streaming zip per run (yazl), byte-split into parts sized to free slots (temp = 1 part via backpressure), sha256 per part, manifest JSON (local + per part-holding account), keep last 2 runs; restore = download parts → verify → stitch → yauzl extract  |

Identity: entry PK = `(set_id, rel_path)`. Hidden from the unified index by
`scanner.hiddenFolderIds()` (index/backup folder ids + all backup_folders) plus
a post-scan recursive prune (`pruneHiddenTree`) for DB-loss rescans.

### §2c - Secure Storage / the vault (`src/main/vault/`)

An encrypted store that is a parallel plane to `nodes`: its own tables, its own
hidden `MaxDrive/.vault/` folder per chosen account, its own queue kinds
(`vaultUp` write / `vaultDown` read, both filtered out of `queue.listVisible()` -
the Transfers page and the LAN API - so file names can't leak there), its own protocol and its own page. Files are
encrypted **before** any upload; Drive only ever sees `<uuid>.mxv` blobs.

**Crypto model.** A random 256-bit Vault Master Key (VMK) is wrapped with
AES-256-GCM under `scrypt(password)` and, separately, under
`scrypt(recoveryKey)` - two secrets, one key, which is why a password change is
a 32-byte re-wrap and never touches a file. GCM's tag is the password verifier;
there is no stored hash. Per file: a random file key wrapped by the VMK,
content in 4 MiB AES-256-GCM chunks with nonce `filePrefix(8B)||chunkIndex`, so
chunks cannot be reordered or spliced between files and any chunk is directly
addressable. The 128-byte header carries the wrapped file key, making a blob
self-describing - a `.mxv` recovered from Drive decrypts with the VMK alone.

| File                  | Responsibility                                                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto.cjs`          | Key wrap/unwrap, scrypt KDF, `createConfig`/`unlockConfig`/`rewrapPassword`/`rewrapRecovery`, RFC-4648 base32 recovery keys (0/O and 1/I forgiven on input), `encryptMeta`/`decryptMeta`, `vault.cfg` serialize/parse. Pure                    |
| `blobFormat.cjs`      | The `.mxv` container: header build/parse, streaming `encryptFileToPath`/`decryptFileToPath` (`.part`+rename), `openBlobReader` (range→chunk math over any ciphertext source), size arithmetic. Pure                                            |
| `planner.cjs`         | Pure placement rules → `replicate`/`deleteCopy`/`drainComplete`/`blocked` actions. Never deletes a last copy; an unreachable account still counts as holding its copies; free-space budget is decremented within a pass                        |
| `session.cjs`         | The only holder of the live VMK. Unlock (with rate limiting: 5 free tries then exponential delay to 5 min, persisted in settings), idle auto-lock (default 10 min), `lock()` zero-fills the buffer                                             |
| `index.cjs`           | Facade for IPC: setup/unlock/changePassword, item CRUD, upload (encrypt → enqueue per replica), download, account add/remove with `removalImpact`, reconcile (10 min tick), debounced encrypted `index.snap` publish, crash sweep on `start()` |
| `storage.cjs`         | `vault-tmp` (ciphertext only) and `vault-thumbs` paths, startup temp sweep                                                                        |
| `vaultUpWorker.cjs`   | Queue worker; uploads ciphertext, verifies Drive md5 against the blob's md5 before a copy counts as `ok`. Needs no key, so it works while locked                                                                                               |
| `vaultDownWorker.cjs` | Queue worker; `downloadToPath` → verify → `decryptFileToPath` to the user's chosen path. Fails `VAULT_LOCKED` rather than half-writing                                                                                                         |
| `recovery.cjs`        | Rebuild from Drive alone: newest `vault.cfg` by `rev` → verify secret → newest `index.snap` → items + copies; blobs missing from the snapshot are registered as `Recovered <uuid>` (header holds their key)                                    |
| `mime.cjs`            | Extension→MIME. Needed because Drive can't sniff an opaque blob, and preview depends on the type                                                                                                                                               |

Identity: `vault_items.id` (uuid); the Drive filename is `blob_uuid`. Names and
mimes exist **only** inside `meta_ct`, so the sqlite file leaks nothing while
locked. `maxvault://item/<id>` translates a Range request into the covering
chunks, fetches only those from Drive and decrypts in memory - video scrub and
PDF paging work without any plaintext reaching disk. Hidden from the unified
index by `accounts.vault_folder_id` in `scanner.hiddenFolderIds()` plus
`pruneHiddenTree` for DB-loss rescans.

**transfers/**

[queue.cjs](../src/main/transfers/queue.cjs) - `queue` singleton
(EventEmitter), DB-backed. States: `queued → running → done|failed|canceled|paused`
(an `allocating` state exists in SQL but no worker sets it). Concurrency:
global 3, reads (download+migrate) 2, writes (upload+migrate) 1 per account;
unallocated uploads share the `"*"` key so only one is in flight (this
serialises allocation). Retry: 8 attempts, exp backoff capped 64 s + jitter,
`retryable=false` errors fail immediately. `paused_by` distinguishes
`'user'` (never auto-resumed) from `'system'` (crash/sleep/offline —
auto-resumed). Offline parks without consuming an attempt; a 15 s network
poller re-queues. Progress coalesced at 250 ms. Workers injected via
`setWorkers({upload,download,migrate})`.

### Cross-module patterns

- **Notifier injection**: modules that need to push to the renderer expose
  `setNotifier(fn)`; main.cjs wires them to `window.send`. No module imports
  window.cjs directly except ipc/tray/main.
- **No `Promise.all` in src/main** - deliberate, keeps Drive traffic sequential.
- **Vault mode**: [vault/seal.cjs](../src/main/vault/seal.cjs) (X25519 box,
  recovery-key-derived private key, password wrap) +
  [vault/sealMode.cjs](../src/main/vault/sealMode.cjs) (setup/unlock/lock,
  `sealMeta`, `reveal`, `searchSealed`) + `vault/keySession.cjs` (lock state,
  auto-lock, brute-force backoff; shared with the Secure vault). Sealed uploads:
  `queue.enqueueUpload` stamps `meta.sealed`; `drive/uploader.cjs` encrypts once
  to `userData/seal-tmp/<transfer>.mxv` and uploads `<uuid>.mxv`. Sealed
  download/preview decrypt via `blobFormat` (`sealKey`); `media.blobRangeResponse`
  is shared with `maxvault://`. Schema V8: `seal_config`, `nodes.seal_meta`.
- **Providers**: [providers/index.cjs](../src/main/providers/index.cjs)
  `providerFor(account)` → [gdrive.cjs](../src/main/providers/gdrive.cjs) |
  [s3.cjs](../src/main/providers/s3.cjs), one interface (`upload`, `openRange`,
  `remove`, `rename`, `copy`, `setTrashed`, `setStarred`, `abortUpload`,
  `caps`). Used by uploader, downloader, migrate, cleanup, ops, media. S3 core in
  `src/main/s3/`: `sigv4` (signing), `xml`, `client` (signed fetch + retry +
  error codes), `api` (list/head/get/put/multipart/copy/delete), `keys`
  (object keys → synthesized folder tree). S3 accounts: `accounts.provider='s3'`,
  `config` JSON, id `s3_<hash>`, keys in tokens.bin, connect/edit in
  accountService (`connectS3`/`updateS3`, IPC `accounts:connectS3|updateS3`).
- **Errors**: throw `Error` with `.code` (and optionally `.retryable=false`);
  the IPC envelope and the queue both honour it.

---

## 3. Renderer (`src/renderer/`)

### Shell and navigation

- [main.jsx](../src/renderer/main.jsx) applies the stored theme **before**
  mounting (no light flash), then mounts `<App/>`.
- [App.jsx](../src/renderer/App.jsx) - CSS grid
  `[238px sidebar | main] / [64px header | content]`. Owns `accounts` +
  `rootFolders` state; subscribes to the five main events and refreshes.
  Mounts `<KeyboardManager/>` + `<OverlayHost/>` once. Bottom-right corner
  stack = Toaster above TransferTray. Drag-drop upload on `<main>`.
- **No router.** `useUiStore` holds `view` (`home|browse|search|transfers|
storage|settings|accounts|recent|starred|trash`) with manual history/future
  stacks. `recent/starred/trash/search/browse` all render `FilesPage` with a
  `source` prop.
- Layout: [Sidebar.jsx](../src/renderer/components/layout/Sidebar.jsx) (nav +
  expandable MaxDrive/Accounts trees, backup freshness row, storage meter),
  [HeaderBar.jsx](../src/renderer/components/layout/HeaderBar.jsx) (doubles as
  the frameless titlebar - `titlebar-drag`/`titlebar-no-drag` classes; search
  input tagged `data-search-input`; window buttons via `electronAPI`),
  [PageShell.jsx](../src/renderer/components/layout/PageShell.jsx) (card
  surface, only children scroll), [NewMenu.jsx](../src/renderer/components/layout/NewMenu.jsx)
  (every item just runs a command).

### Command system - the single source of truth

All behaviour is a **command** in
[commands/registry.js](../src/renderer/commands/registry.js) (~50 commands:
`id, title, category, icon, when(ctx), run(ctx)`). Keyboard, ⋮ menu, toolbar,
New button and palette are all just triggers:

- [commands/context.js](../src/renderer/commands/context.js) - `buildContext()`
  snapshots every store (selection, overlays, transfers, clipboard, view) so
  commands run without React.
- [commands/dispatch.js](../src/renderer/commands/dispatch.js) —
  `runCommand(id, ctx)` (errors → toast) and `resolveChord` (context-aware:
  Space = preview in file view, toggle in transfers; page-scope bindings stand
  down while overlays are open).
- [shortcuts/defaults.js](../src/renderer/shortcuts/defaults.js) —
  `DEFAULT_BINDINGS` (**order matters** for shared chords) + browser-default
  suppression list. [shortcuts/keys.js](../src/renderer/shortcuts/keys.js) —
  chord normalisation (`mod` = Ctrl/Cmd). [shortcuts/useShortcutStore.js](../src/renderer/shortcuts/useShortcutStore.js)
  - per-command overrides persisted in settings under `"shortcuts"`, conflict
    detection. [shortcuts/KeyboardManager.jsx](../src/renderer/shortcuts/KeyboardManager.jsx)
  - the app's **only** global key listener (capture phase; no Electron
    globalShortcut). [useShortcutLabels.js](../src/renderer/shortcuts/useShortcutLabels.js)
  - commandId → display chord for menu hints.
- [command/OverlayHost.jsx](../src/renderer/components/command/OverlayHost.jsx)
  - renders palette, shortcut help, the active dialog (from overlay store) +
    inline `DeleteForeverDialog`/`NewFolderDialog`.
    [CommandPalette.jsx](../src/renderer/components/command/CommandPalette.jsx)
    (Ctrl+P, fuzzy rank, disabled shown greyed),
    [ShortcutHelp.jsx](../src/renderer/components/command/ShortcutHelp.jsx) (F1),
    [ShortcutSettings.jsx](../src/renderer/components/command/ShortcutSettings.jsx)
    (click-to-record rebinding, embedded in SettingsPage).

**To add a feature action**: add a command to registry.js (with `when`), add a
binding to defaults.js if needed, surface it in ItemMenu `GROUPS` /
FileActions `TOOLBAR` / NewMenu - never re-implement in a component.

### Stores (`stores/`, all Zustand)

| Store               | Holds                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useUiStore`        | view/folderId/query/viewMode/windowState + history/future (the router)                                                                                      |
| `useSettingsStore`  | persisted settings mirror; `cycleTheme`; OS dark-mode listener                                                                                              |
| `useSelectionStore` | `ids/anchorId/focusId/list` - pages publish their list via `setList` so commands can resolve selection without props. Range/toggle/arrow/Home-End semantics |
| `useClipboardStore` | file cut/copy entries (separate from OS clipboard)                                                                                                          |
| `useOverlayStore`   | dialog kind (`rename\|move\|share\|details\|deleteForever\|newFolder`), preview, palette, shortcutHelp + LIFO `stack` for Escape          |
| `useTransfersStore` | transfers list, EMA speeds (α=0.35), tray open state, focus; action wrappers call IPC then refresh                                                          |
| `useToastStore`     | toast list + `toast.{info,success,error}` singleton                                                                                                         |

### Hooks

- [useIpcQuery.js](../src/renderer/hooks/useIpcQuery.js) -
  `useIpcQuery(fetcher, deps, events)` → `{data, loading, error, reload}`;
  fetch via `window.maxdrive`, refetch on `on.*` events. **The data-loading
  pattern** for new features.
- [useNodes.js](../src/renderer/hooks/useNodes.js) - source→IPC mapping on
  top of `useIpcQuery`, refetch on `nodes:changed`; also `useBreadcrumbs`.
- [useFileRows.js](../src/renderer/hooks/useFileRows.js) - roving tabindex +
  arrow-key selection shared by list/grid.
- [useDropUpload.js](../src/renderer/hooks/useDropUpload.js) - depth-counted
  drag state, `getPathForFile` → `enqueuePaths`.
- [useConnectAccount.js](../src/renderer/hooks/useConnectAccount.js) - OAuth
  start with busy/error state.

### Pages

| Page                                                         | Notes                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [HomePage.jsx](../src/renderer/pages/HomePage.jsx)           | Suggested folders/files; **RestoreNotice** - detects fresh-install-over-existing-Drive and offers cloud index restore                                                                                                                                                                                                                 |
| [FilesPage.jsx](../src/renderer/pages/FilesPage.jsx)         | One component for browse/recent/starred/trash/search; publishes rows to selection store; breadcrumbs; FileActions toolbar when 1 selected                                                                                                                                                                                             |
| [AccountsPage.jsx](../src/renderer/pages/AccountsPage.jsx)   | connect/reauth/rescan/disconnect per row                                                                                                                                                                                                                                                                                              |
| [StoragePage.jsx](../src/renderer/pages/StoragePage.jsx)     | aggregate + per-account quota; `largestSlot` = biggest single-file upload possible                                                                                                                                                                                                                                                    |
| [TransfersPage.jsx](../src/renderer/pages/TransfersPage.jsx) | active/finished split; exports `TransferRow`                                                                                                                                                                                                                                                                                          |
| [BackupPage.jsx](../src/renderer/pages/BackupPage.jsx)       | backup-set cards, live run progress, restore browser (see §2b)                                                                                                                                                                                                                                                                        |
| [SecurePage.jsx](../src/renderer/pages/SecurePage.jsx)       | Three states in one page - no vault / locked / open. While locked it renders nothing but the password card, and that is enforced in main (`vault:items:list` throws `VAULT_LOCKED`), not by the UI. Uses `components/vault/` views + dialogs and its own lightweight list/grid (not `FileListView`, which is bound to node semantics) |
| [SettingsPage.jsx](../src/renderer/pages/SettingsPage.jsx)   | appearance/startup/headroom/Google-client status/restore/shortcuts/about                                                                                                                                                                                                                                                              |

### Files UI (`components/files/`)

`FileListView` (6-col grid, sticky header) / `FileGridView` (auto-fill cards,
ResizeObserver-derived column count for arrow nav, `maxthumb://` thumbs) share
`useFileRows`. `FileActions` (toolbar) and `ItemMenu` (⋮/right-click, two-page
with "Move to another account" → migration) are both built from command-id
lists. Dialogs (Rename/Move/Share/Details + Preview) all sit on
[ui/Modal.jsx](../src/renderer/components/ui/Modal.jsx). `UnavailableBadge`
marks `orphaned`/`missing_remote` rows.

### UI primitives and styling conventions

- [ui/Modal.jsx](../src/renderer/components/ui/Modal.jsx) - **the** dialog
  foundation (portalled; exports `ModalButton`, `ModalSection`, `ModalError`,
  `inputClass`). [ui/Menu.jsx](../src/renderer/components/ui/Menu.jsx) —
  portalled dropdown with edge-flip. [ui/ConfirmDialog.jsx](../src/renderer/components/ui/ConfirmDialog.jsx)
  replaces `window.confirm`. [ui/Toaster.jsx](../src/renderer/components/ui/Toaster.jsx),
  [ui/CollapsibleSection.jsx](../src/renderer/components/ui/CollapsibleSection.jsx).
  Match the hand-rolled Tailwind pill style around you.
- Theming: CSS variables in [globals.css](../src/renderer/styles/globals.css)
  (one light + `.dark` block per `[data-scheme]`: graphite (default), drive, midnight; shadcn names + `--surface-variant`, `--hover-overlay`,
  `--selected-overlay`, file-type accents), mapped in
  [tailwind.config.js](../tailwind.config.js) (`drive-*` colors, `gcard/gdrop/
gfloat` shadows, `ease-standard`, `animate-fade-in/dialog-in/scrim-in`).
  **Never hard-code hex** - add a variable to every scheme block (light and `.dark`). Scheme = `colorScheme` setting → `html[data-scheme]`.
  Theme applied by [lib/theme.js](../src/renderer/lib/theme.js) (`.dark` class
  - localStorage mirror for pre-paint).
- `lib/`: `format.js` (bytes/dates), `mime.js` (mime → type/icon/color),
  `utils.js` (`cn()`).

---

## 4. Database schema (v3)

`%APPDATA%/maxdrive/maxdrive.db`, WAL, `foreign_keys=ON`. Defined in
[migrations.cjs](../src/main/db/migrations.cjs).

Schema is **v5**. V4 added the local-backup tables (`accounts.backup_folder_id`,
`transfers.meta` JSON, `backup_sets`/`backup_entries`/`backup_folders`/
`backup_runs`/`backup_archive_parts`). V5 added Secure Storage:
`accounts.vault_folder_id` plus `vault_config` (single row: KDF params, salt,
wrapped VMK, recovery wrap, `rev`), `vault_items` (uuid PK, `meta_ct` holds the
encrypted name/mime - never a plain name column, `blob_uuid`/`blob_md5`/
`plaintext_sha256`/`wrapped_file_key`), `vault_copies` (PK `(item_id,
account_id)`, state `pending|uploading|ok|failed|missing`) and `vault_accounts`
(chosen hosts, `state active|draining`, health stamps).

- **accounts** - PK `id` = Google permissionId. email (UNIQUE), display_name,
  photo_url, app_folder_id, index_folder_id, backup_folder_id, vault_folder_id,
  quota_limit/usage/usage_drive,
  quota_refreshed_at, auth_state (`ok|reauth_required|disconnected`), added_at,
  sort_order.
- **nodes** - PK `id` (`root-managed` | `g:<acct>:<fileId>` | `g:<acct>:root` |
  UUID for vfolders). parent_id (FK CASCADE), **origin**
  (`vfolder|managed|mirrored` - the central discriminator), account_id (FK SET
  NULL), drive_file_id, drive_parent_id, name, is_folder, mime, size, md5,
  is_google_doc, web_view_link, created_at, modified_at, starred, trashed,
  status (`ok|orphaned|missing_remote`), thumb_state, thumb_version,
  share_link, share_permission_id, updated_at. Indexes: (parent_id,trashed),
  (account_id,drive_file_id) + partial UNIQUE, (origin).
- **nodes_fts** - FTS5 external-content on `name`, trigger-synced. Search uses
  LIKE under 3 chars, MATCH otherwise.
- **transfers** - PK uuid. kind (`upload|download|migrate`), state, node_id,
  account_id, local_path, dest_parent_node_id, name, size, bytes_done,
  session_uri, session_expires_at, temp_path, error_code/message, attempts,
  priority, created_at, updated_at, **paused_by** (`user|system|NULL`, v3).
  Index (state, priority DESC, created_at).
- **sync_state** - PK account_id. page_token, full_scan_done, scan_cursor,
  full_scan_at, last_poll_at, last_error.
- **backup_log** - generation, created_at, sha256, size, uploaded_to.
- **settings** - key/value (JSON text).
- **activity** (v2) - node_id, account_id, kind, detail, at. Index
  (node_id, at DESC).

Seed row: vfolder `root-managed` "MaxDrive" (`MANAGED_ROOT_ID`).

---

## 5. Build, config, tests, scripts

- **Dev**: `bun run dev` = Vite (5173, strictPort) + Electron concurrently.
  `.claude/launch.json` has `maxdrive-renderer` for the Vite half.
- **Build/dist**: `bun run build` → `dist/`; `bun run dist` → NSIS installer in
  `release/`. No `.env` or OAuth client is shipped; better-sqlite3 asar-unpacked;
  `postinstall` rebuilds native deps.
- **Vite** ([vite.config.js](../vite.config.js)): `root: src/renderer`,
  `base: "./"` (file:// loading), alias `@ → src/renderer` (mirrored in
  jsconfig.json). **Vitest** ([vitest.config.js](../vitest.config.js)) is
  separate because vite's `root` would hide `tests/`; jsdom +
  [tests/setup.js](../tests/setup.js) (stubs matchMedia, window.maxdrive,
  ResizeObserver).
- **Tests**: [tests/shortcuts.test.js](../tests/shortcuts.test.js) only —
  chord parsing, bindings sanity (every binding maps to a real command, no hard
  conflicts), context-aware dispatch, palette ranking, selection store, overlay
  stack. Pure logic, no Electron.
- **scripts/**: `generate-icons.cjs` (Electron rasterises logo.svg → temp; temp
  staging works around Windows Controlled Folder Access), `install-icons.cjs`
  (node copies staged PNG into public/).
- **.env** (dev only, optional): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` - used when Settings has none saved.
  git-ignored; `.env.example` tracked.

---

## 6. Known quirks and open items

- **`viewMode` lives in two stores** - `useSettingsStore` (persisted) and
  `useUiStore` (session); HomePage and FilesPage read different ones, so
  list/grid can diverge between pages.
- **No virtualization** - list/grid render every row.
- **`allocating` transfer state** exists in SQL/recovery but no worker sets it.
- **ARCHITECTURE.md line anchors are stale** - its prose and behavioural claims
  were verified correct, but many `file:line` citations have drifted (e.g.
  worst-fit is now allocation.cjs:64-72, session persistence queue.cjs:313-318,
  backup upload loop backup.cjs:141-155).
- **Git**: only starter-template commits exist; the entire app is uncommitted
  working-tree state.
