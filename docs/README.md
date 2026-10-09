# MaxDrive documentation

MaxDrive is a secure-storage app for Windows: it pools Google Drive accounts
and S3-compatible buckets into one drive, encrypts what you choose on your PC
before it leaves, and lets AI assistants and paired devices use it over your
local network.

## Start here

- **[Getting started](getting-started.md)** - a 20-minute tutorial from install
  to an encrypted, multi-account drive.
- **[Google Cloud setup](guides/google-cloud-setup.md)** - create the OAuth
  client MaxDrive needs for Google Drive (one time, ~10 minutes).

## User guides

| Guide                                                          | Covers                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [Accounts and storage](guides/accounts-and-storage.md)         | Google accounts, S3 buckets, storage limits, where uploads go           |
| [Files and transfers](guides/files-and-transfers.md)           | Browsing, search, preview, upload, move, share, the transfer queue, shortcuts |
| [Secure Storage](guides/secure-storage.md)                     | The end-to-end encrypted vault, recovery keys, host accounts            |
| [Vault mode](guides/vault-mode.md)                             | Encrypting every new upload automatically                               |
| [Local folder backup](guides/local-backup.md)                  | Scheduled mirror and archive backups of folders on your PC              |
| [Index backup and recovery](guides/index-backup-and-recovery.md) | The local index, cloud snapshots, reinstall and disaster recovery     |
| [Remote access and AI](guides/remote-access-and-ai.md)         | LAN API, device pairing, MCP for AI assistants, building clients        |
| [Settings and appearance](guides/settings-and-appearance.md)   | Themes, color schemes, startup, tray and every other setting            |

Every feature in one list: [FEATURES.md](FEATURES.md).

## For developers

- **[Development guide](development.md)** - setup, layout, conventions,
  testing, building and releasing.
- **[CODEBASE.md](CODEBASE.md)** - file-by-file map, IPC contract, schema.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - invariants and edge-case behaviour.
- **[Client API](../skills/maxdrive/references/API.md)** and
  **[protocol](../skills/maxdrive/references/PROTOCOL.md)** - for building a
  mobile, web or AI client against the LAN API.
- **[Contributing](../CONTRIBUTING.md)** and **[Security policy](../SECURITY.md)**.
