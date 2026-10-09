# Security policy

MaxDrive handles OAuth tokens, storage keys and end-to-end encrypted files, so
security reports are taken seriously and handled privately.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub:
[Report a vulnerability](https://github.com/nettanvirdev/maxdrive/security/advisories/new)
(Security tab → Advisories → Report a vulnerability).

Please include:

- what the issue is and what an attacker could do with it
- the steps or a proof of concept to reproduce it
- the MaxDrive version or commit you tested

You can expect an acknowledgement within a few days. Once a fix is ready it
will ship in a release, and you'll be credited in the advisory unless you'd
rather not be.

## Supported versions

Only the latest release gets security fixes.

## Scope

Especially interesting:

- anything that exposes plaintext of Secure Storage or vault-mode files or
  names to a storage provider, a temp file or the network
- key handling in `src/main/vault/` (key derivation, wrapping, sealing, the
  `.mxv` format)
- token, credential and secret storage in `src/main/auth/`
- the LAN API, device pairing, tokens and the MCP endpoint in `src/main/server/`
- IPC or custom-protocol (`maxthumb://`, `maxfile://`, `maxvault://`) paths
  that let renderer content reach data it shouldn't

Out of scope: problems that need an attacker who already controls your
unlocked Windows account, and reports about Google's "unverified app" consent
screen (every self-hosted OAuth client shows it).

## How MaxDrive protects your data

A short summary - the details are in the
[Secure Storage](docs/guides/secure-storage.md) and
[Vault mode](docs/guides/vault-mode.md) guides.

- **No MaxDrive server.** The app talks directly to Google and your S3
  endpoint with your own credentials.
- **Secrets at rest** - OAuth tokens, S3 keys, your Google OAuth client and
  paired-device secrets are encrypted with Windows DPAPI.
- **Secure Storage** - files are split into chunks encrypted with AES-256-GCM
  on your PC before upload; the master key is protected by a scrypt-derived key
  from your password and by a one-time recovery key. Names and types are
  encrypted too.
- **Vault mode** - each new upload is sealed to an X25519 public key, so
  encryption works while locked; only your password or recovery key can open
  it.
- **Keys stay in the main process** - the UI receives decrypted results, never
  keys, and keys are wiped from memory on lock.
- **LAN access is opt-in** and off by default; pairing uses a 6-digit code that
  never crosses the network, and any device can be revoked instantly.

If you lose both the password and the recovery key of an encrypted area, your
data cannot be recovered - by you, by the maintainers, or by anyone else.
