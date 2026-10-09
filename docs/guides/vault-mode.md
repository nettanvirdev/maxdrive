# Vault mode (encrypt everything)

Vault mode encrypts every new upload and every new folder on your PC before it leaves, including file and folder names. Encrypted items stay in your normal file tree, and uploads keep working even while vault mode is locked.

Vault mode has its own password and recovery key. It is independent of [Secure Storage](secure-storage.md), which is a separate vault on its own page.

## Set up vault mode

![The vault mode group in Settings](../screenshots/settings-vault-mode.png)

1. Open **Settings** and find the **Encrypt everything (vault mode)** group.
2. Click **Set up**.
3. In **Set up vault mode**, enter a password (at least 8 characters) and confirm it. Click **Set up**.
4. **Save your recovery key** appears. Click **Save to file** or **Copy**.
5. Click **Done**. The dialog will not close until you have saved or copied the key.

Setting up does not turn encryption on by itself. Do that next.

> **Warning:** The recovery key is shown once. It opens your encrypted files if you forget the password, and anyone who has it can open them too. Keep it somewhere offline, not in a folder you back up. If you lose both the password and the recovery key, nobody can decrypt your encrypted files - not MaxDrive, not Google.

## Turn on encryption for new uploads

In **Settings > Encrypt everything (vault mode)**, switch on **Encrypt all new uploads**.

From then on, uploads from **Upload**, drag-and-drop, the tray and paired devices (including AI tools connected over MCP) are encrypted on this PC first, and new folders get encrypted names. See [Remote access and AI](remote-access-and-ai.md).

- **Existing files are not encrypted.** Files already in your Drives stay as they are. Only new uploads are encrypted.
- **Turning it off** makes new uploads plaintext again. Files that were encrypted stay encrypted and still open normally once you unlock. Uploads already queued while it was on are still encrypted.

## Unlock and lock

Uploading never needs the password. Unlocking is only needed to see real names and to open, preview, download or rename encrypted items.

**To unlock**, use any of these:

- **Settings > Encrypt everything (vault mode) > Unlock**.
- The lock button in the window header (shown while **Encrypt all new uploads** is on).
- **Unlock encrypted files** in the command palette.
- Open a locked encrypted item. MaxDrive asks for the password first.

In **Unlock encrypted files**, enter your vault mode password, or click **Use recovery key instead**. After 5 wrong attempts, each further failure adds a growing delay (up to 5 minutes), shown as **Try again in Ns**. The counter survives restarts.

**To lock**, click **Lock** in Settings, click the header lock button, or run **Lock encrypted files** from the command palette. Vault mode also locks when MaxDrive quits.

**Lock automatically** (in the same Settings group) locks after a period without activity: **5 min**, **10 min** (default), **30 min**, **1 hour** or **Never**.

**Change password** (the **Password** row) needs your current password. Encrypted files are not touched; only the key that opens them is re-locked.

## What encrypted items look like

| State    | Name shown                              | What you can do                                                                    |
| -------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| Locked   | "Encrypted file" / "Encrypted folder", with a lock badge | Browse, move, copy, delete. Opening one asks you to unlock.                         |
| Unlocked | The real name, with a lock badge        | Preview, download, rename and search by name, like any other file                 |

- **Preview and download** decrypt on the fly. Previews stream and decrypt only what is needed; downloads land decrypted in the folder you choose.
- **Rename** needs vault mode unlocked. The new name is encrypted again; the stored file is not touched.
- **Search** finds encrypted items by their real names only while unlocked.
- **Thumbnails** are not generated for encrypted files, because a thumbnail would be a readable copy.
- **Sharing is not offered.** **Share**, **Create shareable link** and **Open in Google Drive** are hidden for encrypted items, since the other person would only get ciphertext.
- **Copies and moves** keep the item encrypted, including moves between accounts.
- In your Drive or bucket, an encrypted file is stored as `<random-id>.mxv` with unreadable contents.

## Local folder backups pause

[Local folder backups](local-backup.md) upload plaintext, so they pause while **Encrypt all new uploads** is on. The Backup page shows **Backups are paused while vault mode is on**. They resume when you turn it off.

## Limitations

- **Names live in the index.** The real names of encrypted items exist only (encrypted) in MaxDrive's local index. If you lose this PC's database entirely, restore it from an index backup to get the names back - see [Index backup and recovery](index-backup-and-recovery.md). A fresh rescan without a restore shows encrypted files under their random `.mxv` names. The file contents themselves can always be decrypted by the key derived from your recovery key.
- **The local transfer list holds real names.** While an encrypted upload is queued or running, the transfer entry on this PC shows the real file name. These names are scrubbed from the index snapshot uploaded to the cloud.
- **No new recovery key.** Vault mode has no option to issue a replacement recovery key.

## Vault mode vs Secure Storage

|                         | Secure Storage                                  | Vault mode                                                     |
| ----------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Where files live        | Separate **Secure** page, hidden from Files     | Your normal file tree, with a lock badge                       |
| What gets encrypted     | Only files you add to the vault                 | Every new upload and folder while it is on                     |
| Upload while locked     | No                                              | Yes                                                            |
| Storage                 | Google Drive only, with 1-3 copies              | Wherever the upload is placed                                  |
| Password / recovery key | Its own                                         | Its own                                                        |
| Auto-lock options       | 2, 10 (default), 30 min, or only on quit        | 5, 10 (default), 30 min, 1 hour, or never                      |
| Change password with recovery key | Yes                                   | No - current password needed                                   |
| Replace recovery key    | Yes                                             | No                                                             |
| Restore on a new PC     | From Drive alone, with password or recovery key | Through an index restore                                       |

## How it works

Vault mode uses public-key encryption so that uploading needs no secret.

- **Key pair.** At setup MaxDrive generates a random 32-byte recovery key. Your X25519 private key is derived from it with HKDF-SHA256, and the matching public key is stored on this PC. Because the private key comes from the recovery key, the recovery key alone can always regenerate it.
- **Password wrap.** The private key is encrypted with AES-256-GCM under a key derived from your password with scrypt (N = 2^15, r = 8, p = 1, random 32-byte salt). Changing the password re-wraps only this key.
- **Sealing a file.** Each upload gets a random file key, and the content is encrypted into the same chunked AES-256-GCM `.mxv` format the Secure vault uses. The file key is then sealed to your public key: a fresh one-time X25519 key pair, an ECDH exchange with your public key, HKDF-SHA256 bound to both public keys, then AES-256-GCM. The sealed key goes in the file header, flagged as sealed.
- **Names.** The real name, type and size are sealed the same way and stored in the index. While unlocked, MaxDrive decrypts them in memory only and never writes them back to the database.
- **Unlocking** decrypts the private key into memory. Locking zero-fills it. Only the background process ever holds it; the app window receives decrypted results, never keys.
