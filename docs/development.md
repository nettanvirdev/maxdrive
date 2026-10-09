# Development guide

Everything you need to work on MaxDrive itself: setup, how the code is laid
out, the conventions it relies on, testing, and how releases are built.

## Setup

Requirements: Windows 10/11 (x64), [Bun](https://bun.sh) 1.2+,
[Node.js](https://nodejs.org) 20+, Git.

```bash
bun install
```

```bash
bun run dev
```

`bun install` runs `electron-builder install-app-deps`, which rebuilds the
native `better-sqlite3` module for Electron's ABI. `bun run dev` starts Vite on
port 5173 and Electron with `NODE_ENV=development`: React hot-reloads, DevTools
open detached, and the main process logs at debug level to the terminal.
Changes under `src/main/` need a restart (Ctrl+C, then `bun run dev` again).
Only one MaxDrive instance can run at a time, so quit an installed copy first.

### Credentials for development

- **Google:** create your own OAuth client
  ([Google Cloud setup](guides/google-cloud-setup.md)), then paste it into
  Settings → Google connection - or copy `.env.example` to `.env` and fill it in.
  `.env` is only read while nothing is saved in Settings, is git-ignored and is
  never packaged.
- **S3:** any local S3-compatible server works, for example
  [MinIO](https://min.io) or [RustFS](https://rustfs.com) in Docker. Create a
  bucket and keys, then add it from the Accounts page with **Path-style URLs**
  on.

### Local data

The app keeps everything in `%APPDATA%\maxdrive\`: `maxdrive.db` (SQLite
index and settings), DPAPI-encrypted `tokens.bin` and `oauth-client.bin`, the
thumbnail cache, temp areas for encryption, and `logs\main.log`. Quit the
app and delete the folder to start from scratch - files in your cloud storage
are untouched.

## Project layout

```
src/main/            Electron main process (plain CommonJS .cjs)
  main.cjs           boot sequence, wiring of setNotifier() pushes
  preload.cjs        window.maxdrive bridge - the whole IPC surface
  ipc.cjs            IPC handlers ({ok, data} envelope)
  auth/              OAuth (PKCE loopback), token/credential stores
  db/                better-sqlite3, migrations, prepared queries
  providers/         storage seam: providerFor(account) -> gdrive | s3
  drive/  s3/        Google Drive REST client; S3 with hand-rolled SigV4
  sync/              scanner, change poller, cloud index backup
  transfers/         persistent transfer queue
  vault/             Secure Storage and vault-mode crypto + services
  localBackup/       local folder backup engine, scheduler, restore
  server/            opt-in LAN API, device pairing, MCP endpoint
src/renderer/        React 18 + Vite + Tailwind
  pages/             one component per page (no router)
  components/        UI by area; ui/ holds shared primitives
  commands/          registry.js - every user action
  shortcuts/         default key chords
  stores/            Zustand stores
  styles/globals.css theme tokens for every color scheme
tests/               Vitest unit tests
skills/              MCP stdio bridge, Agent Skill, API + protocol references
scripts/             icon generation
docs/                user guides and developer docs
```

Deeper references:

- [CODEBASE.md](CODEBASE.md) - file-by-file map, IPC contract, database
  schema, boot sequence, known quirks.
- [ARCHITECTURE.md](ARCHITECTURE.md) - the invariants and how the app behaves
  in edge cases (revoked accounts, reinstalls, full accounts, crashes).
- [FEATURES.md](FEATURES.md) - the inventory of user-facing features.
- [CLAUDE.md](../CLAUDE.md) - the project's hard rules in one place.

## Conventions

The short version - [CONTRIBUTING.md](../CONTRIBUTING.md#the-rules-that-matter-most)
and [CLAUDE.md](../CLAUDE.md) have the full list.

- **Main owns I/O.** The renderer never touches Google, S3, SQLite or the
  filesystem. A new IPC call is a handler in `ipc.cjs` plus a line in
  `preload.cjs`. Push events use a module's `setNotifier(fn)`, wired only in
  `main.cjs`.
- **Go through the provider.** File operations, uploads, downloads and media
  call `providerFor(account)`; never call the Drive or S3 client for a node
  directly.
- **Sequential remote traffic.** No `Promise.all` in `src/main`.
- **IDs, not names.** Nodes are `g:<accountId>:<fileId>`; `nodes.origin`
  (`vfolder | managed | mirrored`) decides how a row behaves.
- **Commands drive the UI.** Add an action to `commands/registry.js` with
  `when`/`run`; menus, toolbar, palette and shortcuts just trigger it. Dialogs
  are an overlay `kind` in `useOverlayStore`, rendered by `OverlayHost`.
- **Theme tokens only.** No hex colors in components; a new token goes in
  every `[data-scheme]` block, light and dark.
- **Errors carry `.code`** (and `.retryable = false` when a retry can't help).
- **Data loading** uses `hooks/useIpcQuery.js`: fetch through
  `window.maxdrive` and refetch on the matching `on.*` event.

## Testing

```bash
bun run test
```

Vitest runs `tests/**/*.test.js` in jsdom (`vitest.config.js`). Pure logic is
unit-tested and must stay importable without Electron or the database: vault
crypto and the `.mxv` format, vault-mode sealing, S3 SigV4/XML/keys, backup
rules/differ/schedule, pairing crypto and tokens, discovery parsing,
shortcuts, upload naming. When you add logic like that, keep it in a
dependency-free module and test it there.

Everything that touches Electron, Google or S3 is verified by hand in
`bun run dev`. For S3 changes, test against a local MinIO/RustFS bucket; for
UI changes, check light and dark themes in each color scheme.

`bun run build` must also pass - CI runs both on every push and pull request.

## Database migrations

Schema changes are a new, numbered migration appended in
`src/main/db/migrations.cjs`. On startup each pending migration runs in its own
transaction and bumps `PRAGMA user_version`; a database from a newer build is
refused rather than half-read. Never edit or reorder a released migration.

## Building

```bash
bun run dist
```

builds the renderer into `dist/` and packages with electron-builder (config in
`package.json` → `build`) into `release/`:

- `MaxDrive-Setup-<version>.exe` - NSIS installer, per-user, lets the user pick
  the install folder, creates shortcuts.
- `MaxDrive-<version>-Portable.exe` - single-file portable build.

`bun run pack` writes just the unpacked app to `release/win-unpacked/`, which
is quicker for checking a packaging change. Only production `dependencies` are
packaged; renderer libraries (React, Zustand, lucide) are bundled by Vite and
live in `devDependencies`. `better-sqlite3` is unpacked from the asar because
it is a native module.

To change the app icon, edit `public/assets/logo.svg` and run `bun run icons`.

## Releasing

1. Bump `version` in `package.json`.
2. Move the **Unreleased** notes in `CHANGELOG.md` under the new version.
3. Commit, then tag and push:

   ```bash
   git tag v0.2.0
   ```

   ```bash
   git push origin master v0.2.0
   ```

The [Release workflow](../.github/workflows/release.yml) checks that the tag
matches `package.json`, runs the tests, builds both executables and publishes
them on a GitHub release with generated notes. Tags with a hyphen
(`v0.2.0-beta.1`) become pre-releases. Running the workflow manually from the
Actions tab builds the executables as a downloadable artifact without
publishing a release.

Builds are not code-signed. To sign, add a certificate through
electron-builder's `CSC_LINK` / `CSC_KEY_PASSWORD` secrets and remove
`CSC_IDENTITY_AUTO_DISCOVERY: "false"` from the workflow.
