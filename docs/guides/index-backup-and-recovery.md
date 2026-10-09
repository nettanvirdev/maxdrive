# Index, backup and recovery

MaxDrive keeps a local index of every file in every connected account so browsing and search are instant. This guide explains how that index stays current, how it is backed up to your own Google Drive, and what to do when something goes wrong.

The short version: your files always live in Google Drive or your S3 bucket. Losing the local index is never data loss - at worst you lose your MaxDrive folder layout, and the cloud index backup exists to bring that back too.

## How the index stays current

| Source | How MaxDrive finds changes |
| --- | --- |
| First connect | A full scan of the account builds its part of the index. Large accounts scan in the background and appear page by page. |
| Google Drive | Drive's change feed is checked about every 45 seconds while the MaxDrive window is focused and every 5 minutes in the background. Switching back to the window triggers a check right away. |
| S3 buckets | S3 has no change feed, so MaxDrive re-lists each bucket on a schedule (see below). |
| Your own actions | Uploads, renames and moves made in MaxDrive update the index immediately. |

Each account is tracked separately. Adding a new account scans only that account; the others are not touched.

### Change how often S3 buckets are checked

1. Open **Settings**.
2. Under **Storage**, find **Check S3 buckets for changes**.
3. Pick **5 min**, **15 min** (the default), **1 hour**, **6 hours** or **Manual**.

Large buckets cost more requests per check. With **Manual**, a bucket is only re-listed when you use **Re-index** on the Accounts page.

## Refresh, re-index and rebuild

These actions live on the Accounts page and in the command palette (Ctrl+P).

| Action | Where | What it does |
| --- | --- | --- |
| **Re-index** | Accounts page, on each account row | Rescans that one account and rebuilds its part of the index. |
| **Rebuild index** | Command palette | Rescans every connected account. |
| **Refresh current folder** | Command palette | Refreshes storage figures for all accounts. |

A rescan never downloads file contents - it only reads names, sizes and folder structure.

## Cloud index backup

The one thing MaxDrive cannot rebuild from Google Drive is your MaxDrive folder layout (which folder each uploaded file sits in). So the whole index is backed up, compressed, to a hidden `MaxDrive/.index/` folder in **every** connected Google account. Five accounts means five independent copies.

- **Automatic:** a backup runs about 5 minutes after your files change, and a periodic check runs every 6 hours. If nothing has changed, no new backup is uploaded.
- **History:** the newest 3 backups (called generations) are kept in each account.
- **Google Drive only:** S3 buckets never hold index backups.
- **Hidden:** the `.index` folder never shows up in your MaxDrive file tree or search.
- **Private:** in vault mode, names of encrypted uploads are scrubbed from the backup copy before it leaves the PC.

Your local folder backup sets are part of the index, so their configuration comes back with a restore too (see [local-backup.md](local-backup.md)).

### Back up now

The bottom of the sidebar shows when the index was last backed up, for example **Backed up 5 minutes ago** or **Not backed up yet**. A red dot means the last backup failed; hover it to see why.

1. Click that sidebar row, or run **Back up index now** from the command palette.
2. The row shows **Backing up...** while it runs.

### Restore from a chosen backup

1. Open **Settings** and scroll to **Index backup and restore**.
2. Click **Find cloud backups**. MaxDrive lists the backups found in all reachable accounts, newest generation first, with the account, size and date.
3. Click **Restore** next to the one you want.
4. Confirm with **Restore index**.

Before the swap, MaxDrive checks the backup's checksum, its database integrity and that it was not written by a newer MaxDrive version. If any check fails, your current index is left untouched. If a backup is reported as damaged, try an older generation.

Your current index is kept on disk as `maxdrive.db.pre-restore`. After the restore, MaxDrive re-syncs every account with Google Drive so anything that changed after the backup is picked up.

> MaxDrive is designed for one PC per set of accounts. If two computers run MaxDrive against the same accounts at the same time, the newest backup wins and they will overwrite each other's folder layout.

## Recovery recipes

### Reinstalled Windows or moved to a new PC

Sign-ins are encrypted to your Windows user account, so a fresh Windows cannot read the old ones. Your index backups are still in Google Drive.

1. Install MaxDrive and enter your Google OAuth client again (see [google-cloud-setup.md](google-cloud-setup.md)).
2. Connect **one** of your Google accounts.
3. The Home page shows **Found a backup of your MaxDrive index**. Click **Review backups** (or go to **Settings > Index backup and restore > Find cloud backups**).
4. Restore the newest generation.
5. On the Accounts page, use **Reconnect** for your other Google accounts. For S3 buckets, use **Edit** to re-enter the access keys.

### Lost or corrupted local database

If MaxDrive finds the database damaged on startup, it renames it to `maxdrive.db.corrupt-<timestamp>` and starts with a fresh one. Nothing in the cloud is touched.

1. Open **Settings > Index backup and restore** and click **Find cloud backups**. This works even when the index is empty, as long as your sign-ins on this PC are intact.
2. Restore the newest generation.

Without any backup, reconnect your accounts and let them rescan. Every file comes back; only your MaxDrive folder layout is lost.

### Vault mode and Secure Storage after total loss

- **Vault mode:** the real names of encrypted uploads are stored only in the index. After a fresh rescan they show as `<uuid>.mxv`. The contents remain decryptable with your recovery key, but the names come back only with an index restore. See [vault-mode.md](vault-mode.md).
- **Secure Storage:** the vault keeps its own encrypted configuration and index in Google Drive and is restored from there with its password or recovery key, independently of the index backup. See [secure-storage.md](secure-storage.md).

### An account was revoked or its sign-in expired

MaxDrive marks the account **Reconnect needed** and stops syncing, uploading to and backing up that account only. Its files stay in the index.

1. Open the **Accounts** page.
2. Click **Reconnect** on that account and sign in.
3. Choose the **same** Google account - MaxDrive refuses a different one.

For an S3 bucket whose keys stopped working, click **Edit** and enter new keys. See [accounts-and-storage.md](accounts-and-storage.md).

### A file was deleted on drive.google.com

MaxDrive notices on its next check (within about 45 seconds while focused).

- A file you uploaded through MaxDrive is not silently removed: it moves to MaxDrive's Trash with an **Unavailable** badge ("Missing from its storage").
- Other files simply follow Google Drive: trashed there means trashed here, and permanently deleted there disappears here.

If the deletion was a mistake, restore the file from Google Drive's own trash; MaxDrive picks it up again on the next check.

### An account filled up mid-upload

Nothing to do. MaxDrive detects the full account, refreshes its storage figures and restarts the upload on another account with room, showing a toast such as "Moved to ... - the first account was full." See [files-and-transfers.md](files-and-transfers.md).

### The app crashed or was closed mid-transfer

The transfer queue is saved to disk, so nothing is lost.

- With **Settings > Startup and background > Resume interrupted transfers automatically** on (the default), interrupted transfers restart on the next launch. Transfers you paused yourself stay paused.
- Uploads continue from the last byte Google confirmed; downloads resume and are verified before the file is saved.
- Otherwise, resume or retry them from the Transfers page.

## Where your data lives

### On this PC: `%APPDATA%\maxdrive\`

| Item | Contents |
| --- | --- |
| `maxdrive.db` | The index: file tree, accounts, transfer queue, backup sets. |
| `tokens.bin` | Account sign-ins and S3 keys, encrypted to your Windows user. |
| `oauth-client.bin` | Your Google OAuth client, encrypted the same way. |
| `thumbs\` | Thumbnail cache. |
| `maxdrive.db.pre-restore` | The index as it was before your last restore. |
| `maxdrive.db.corrupt-<timestamp>` | A damaged index that was set aside on startup. |

### In each Google account

| Folder | Contents |
| --- | --- |
| `MaxDrive/` | Your files. |
| `MaxDrive/.index/` | Index backups (`maxdrive-index-g<generation>-...db.gz`). |
| `MaxDrive/.backup/` | Local folder backups. |
| `MaxDrive/.vault/` | Secure Storage, as encrypted `.mxv` files. |

The hidden folders never appear in MaxDrive's file views. S3 buckets hold only your files.
