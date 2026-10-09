# Changelog

All notable changes to MaxDrive are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-09

First public release.

### Storage

- One file tree and one search across any number of Google Drive accounts and
  S3-compatible buckets (AWS, Cloudflare R2, Backblaze B2, Wasabi, MinIO, ...),
  backed by a local SQLite index kept current with Drive's change feed and a
  periodic, adjustable S3 re-list.
- Uploads placed automatically on the account with room, with a headroom
  reserve for Drive and a user-set GB limit for each S3 bucket.
- Resumable uploads and downloads with a persistent, crash-safe transfer
  queue; offline and sleep handling.
- Cross-account moves, copy, rename, star, trash and Google Drive sharing.
- Cloud backup of the index to every Google account for reinstall recovery.
- Local folder backup (mirror and archive modes) on a schedule.

### Security

- Secure Storage: an end-to-end encrypted vault (AES-256-GCM, scrypt, recovery
  key) with multi-account replication and restore from Drive alone.
- Vault mode: encrypt every new upload and folder with its own password and
  recovery key (X25519 sealed boxes, so uploads work while locked).
- Tokens, S3 keys and the Google OAuth client are stored DPAPI-encrypted; the
  OAuth client is entered in Settings, no `.env` needed.

### AI and devices

- Opt-in LAN API with QR + 6-digit device pairing and instant revocation.
- Built-in MCP server for AI assistants, with a stdio bridge and Agent Skill.

### App

- Graphite, Drive and Midnight color schemes in light and dark, command
  palette, keyboard shortcuts, in-app preview, tray mode, start on sign-in.
- Windows installer and portable executable, built by GitHub Actions.

[Unreleased]: https://github.com/nettanvirdev/maxdrive/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nettanvirdev/maxdrive/releases/tag/v0.1.0
