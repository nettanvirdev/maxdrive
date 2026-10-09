# Contributing to MaxDrive

Thanks for helping! Bug reports, docs fixes, ideas and pull requests are all
welcome. This guide covers how to get set up and what a good change looks like.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** - open an
  [issue](https://github.com/nettanvirdev/maxdrive/issues/new/choose) with
  steps to reproduce and your MaxDrive version. Never paste tokens, keys,
  recovery keys or OAuth secrets.
- **Suggest a feature** - open a feature request and describe the problem
  first; the solution can follow.
- **Report a security issue** - privately, as described in
  [SECURITY.md](SECURITY.md). Not as a public issue.
- **Improve the docs** - everything under [`docs/`](docs/README.md) is plain
  Markdown.
- **Send a pull request** - for anything bigger than a small fix, please open
  an issue first so we can agree on the approach before you spend time on it.

## Development setup

You need Windows 10/11, [Bun](https://bun.sh) 1.2+, [Node.js](https://nodejs.org)
20+ and Git.

```bash
git clone https://github.com/nettanvirdev/maxdrive.git
```

```bash
cd maxdrive
```

```bash
bun install
```

```bash
bun run dev
```

`bun install` also rebuilds `better-sqlite3` for Electron (the `postinstall`
script). To connect Google accounts you need your own OAuth client - follow
[docs/guides/google-cloud-setup.md](docs/guides/google-cloud-setup.md) and
paste it into Settings, or put it in a `.env` (copy `.env.example`). For S3
work, any local S3-compatible server (MinIO, RustFS, etc.) is enough.

Then read [docs/development.md](docs/development.md) - it explains the project
layout, conventions and how to test.

## Before you start coding

Read these, in this order, before a non-trivial change:

1. [docs/FEATURES.md](docs/FEATURES.md) - what already exists, so you don't
   build it twice.
2. [docs/CODEBASE.md](docs/CODEBASE.md) - where everything lives: IPC
   contract, database schema, boot sequence.
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - the invariants the design
   depends on.
4. [CLAUDE.md](CLAUDE.md) - the project's hard rules, written for AI coding
   assistants but binding for humans too.

## The rules that matter most

- **The main process owns all I/O.** Google, S3, the database and the
  filesystem are only touched in `src/main/`. The renderer talks through
  `window.maxdrive` (defined in `src/main/preload.cjs`); a new IPC call is a
  handler in `src/main/ipc.cjs` plus one line in the preload.
- **Identity is IDs, never names or paths.**
- **No `Promise.all` in `src/main`.** Remote traffic is sequential on purpose,
  to stay inside provider quotas.
- **Every user action is a command** in `src/renderer/commands/registry.js`;
  menus, toolbar, palette and shortcuts only trigger commands.
- **Dialogs** go through `useOverlayStore` and render in `OverlayHost`.
- **Styling** uses Tailwind and the CSS variables in
  `src/renderer/styles/globals.css` - never hard-coded hex colors. A new color
  goes into every color-scheme block.
- **Errors** from the main process are `Error`s with a `.code` (and
  `.retryable = false` when retrying can't help).
- **Security code is not negotiable.** Keys never leave the main process, and
  nothing plaintext from the vault or vault mode is written to a provider or a
  temp file. Changes in `src/main/vault/`, `src/main/auth/` or
  `src/main/server/` get extra review.
- **Keep it small.** No new dependency for what a few lines can do, no
  abstraction with a single implementation, and delete code you replace.

## Making a change

1. Fork the repo and create a branch from `master`
   (`fix/upload-retry`, `feat/s3-presigned-share`, ...).
2. Make the change. Match the style of the surrounding code - comment density,
   naming and idioms.
3. Add or update tests for logic you touch. Pure modules (crypto, parsers,
   planners, rules) are unit-tested in `tests/` and must stay free of Electron
   and database imports.
4. Run the checks:

   ```bash
   bun run test
   ```

   ```bash
   bun run build
   ```

5. Try it for real in `bun run dev` - especially UI changes, in both light and
   dark themes.
6. Update the docs if behaviour changed: `docs/FEATURES.md`, the relevant guide
   in `docs/guides/`, and `docs/CODEBASE.md` for new files, IPC channels or
   schema changes. Add a line to `CHANGELOG.md` under **Unreleased**.
7. Open a pull request and fill in the template.

### Database changes

Schema changes are a new numbered migration in `src/main/db/migrations.cjs`.
Never edit a migration that has shipped - users' databases have already run
it.

### Commit messages

Short, imperative subject lines that say what changed: `Fix resume offset for
S3 multipart uploads`, `Add Midnight color scheme`. Keep one logical change per
commit where you can.

## Releases

Maintainers release by bumping `version` in `package.json`, moving the
**Unreleased** notes in `CHANGELOG.md` under the new version, and pushing a
matching tag:

```bash
git tag v0.2.0
```

```bash
git push origin v0.2.0
```

The [Release workflow](.github/workflows/release.yml) runs the tests, builds
the setup and portable executables and publishes them on a GitHub release.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
