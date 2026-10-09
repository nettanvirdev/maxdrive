# Getting started

This tutorial takes you from a fresh install to a working, encrypted drive in
about 20 minutes: install MaxDrive, connect storage, upload your first files,
turn on encryption, and (optionally) connect an AI assistant.

## 1. Install MaxDrive

Download the latest release from
[GitHub Releases](https://github.com/nettanvirdev/maxdrive/releases):

- **`MaxDrive-Setup-<version>.exe`** - the installer. It installs for your user
  only, lets you choose the folder, and adds Start menu and desktop shortcuts.
- **`MaxDrive-<version>-Portable.exe`** - a single file you can run from
  anywhere, no installation.

Both use the same settings folder (`%APPDATA%\maxdrive\`), so you can switch
between them. Builds are not code-signed yet: if SmartScreen warns, choose
**More info → Run anyway**.

Prefer to build it yourself? See [Build from source](../README.md#build-from-source).

## 2. Connect your storage

MaxDrive needs at least one storage account. You can mix both kinds freely.

### Google Drive accounts

1. Create your own Google OAuth client - a one-time, ~10-minute job in the
   Google Cloud console. Follow [Google Cloud setup](guides/google-cloud-setup.md).
2. In MaxDrive, open **Settings → Google connection**, paste the **Client ID**
   and **Client secret**, and save.
3. Open **Accounts** and click **Add Google Drive**. Sign in in your browser
   and approve access. Google warns that the app is unverified - that's
   expected for your own client; choose **Advanced → Go to MaxDrive**.
4. Repeat step 3 for every Gmail account you want in the pool.

### S3-compatible buckets

1. Create a bucket and an access key that can list, read and write it (AWS S3,
   Cloudflare R2, Backblaze B2, Wasabi, MinIO, ...).
2. Open **Accounts** and click **Add S3-compatible storage**.
3. Enter the endpoint, bucket, region and keys, and set a **Storage limit
   (GB)** - MaxDrive never puts more than that on the bucket.
4. Click **Connect**. MaxDrive tests the keys before saving them.

Each account is indexed in the background; its files appear in **Files** as
soon as they are found. Details: [Accounts and storage](guides/accounts-and-storage.md).

## 3. Upload and organise

- Drag files or folders anywhere onto the window, or use **New → File upload**
  (Ctrl+U) / **New → Folder upload** (Ctrl+Shift+U).
- You never pick an account: each file goes to whichever account has the most
  free room, and the **Storage** page shows how full everything is.
- Folders are yours to arrange - rename, move, copy and star items, across
  accounts. Moving a file between accounts migrates its bytes for you.
- Press **Ctrl+P** for the command palette and **F1** for every keyboard
  shortcut.

Watch progress in the transfer tray or the **Transfers** page (Ctrl+J).
Transfers survive crashes, reboots and lost connections. Details:
[Files and transfers](guides/files-and-transfers.md).

## 4. Turn on encryption

MaxDrive has two ways to keep files private. Both encrypt on your PC, so your
storage providers only ever see unreadable `.mxv` blobs.

| If you want...                                         | Use                                            |
| ------------------------------------------------------ | ---------------------------------------------- |
| A separate, locked space for your most private files   | [Secure Storage](guides/secure-storage.md)     |
| Every new upload encrypted automatically, in your tree | [Vault mode](guides/vault-mode.md)             |

**Secure Storage:** open **Secure** in the sidebar, choose a master password,
and save the recovery key it shows you. Files you add there are encrypted
before upload and hidden everywhere else in the app.

**Vault mode:** open **Settings → Encrypt everything (vault mode)**, click
**Set up**, choose a password, save the recovery key, then turn on **Encrypt
all new uploads**. From then on every upload and new folder is encrypted -
even while vault mode is locked.

> **Warning:** store each recovery key somewhere safe and offline (a password
> manager or printed copy). If you lose both the password and the recovery key,
> nobody - including the MaxDrive maintainers - can decrypt your files.

## 5. Keep a safety net

- **Index backups** happen automatically: MaxDrive stores a snapshot of its
  index in every connected Google account, so a reinstall or a new PC restores
  your whole tree. See [Index backup and recovery](guides/index-backup-and-recovery.md).
- **Local folder backup** copies folders on your PC to Google Drive on a
  schedule, as a mirror or as snapshot archives. See
  [Local folder backup](guides/local-backup.md).

## 6. Connect an AI assistant or another device (optional)

1. Open **Settings → Remote access and devices** and turn on **Allow phones
   and AI assistants on this network**. It is off by default and stays on your
   local network.
2. To connect an AI assistant, use **Connect an AI assistant (MCP)** →
   **Generate connection command**, then run the copied
   `claude mcp add ...` line (or add the URL and token to any MCP client).
3. To pair a phone or other device, click **Add device**, scan the QR code or
   type the 6-digit code on the device, then click **Allow** on your PC.

Your assistant can now browse, search, upload and organise your files.
Details: [Remote access and AI](guides/remote-access-and-ai.md).

## Next steps

- Make it yours: themes and color schemes, tray mode and start-on-sign-in in
  [Settings and appearance](guides/settings-and-appearance.md).
- Browse every feature in [FEATURES.md](FEATURES.md).
- Something not working? Check the troubleshooting section of
  [Google Cloud setup](guides/google-cloud-setup.md#troubleshooting), then
  [open an issue](https://github.com/nettanvirdev/maxdrive/issues/new/choose).
