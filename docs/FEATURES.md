# MaxDrive — Feature Inventory

Every user-facing capability in the app, one line each. MaxDrive is a desktop
secure-storage app (Windows today, more platforms planned) that merges multiple Google Drive accounts and S3-compatible
buckets into one virtual drive, with end-to-end encryption (Secure Storage and
vault mode), local-folder backup, and an opt-in LAN API + MCP server. Step-by-step
user guides for each area live in [guides/](guides/).

For *how* any of this is built, see [CODEBASE.md](CODEBASE.md) (file map, IPC
contract, schema) and [ARCHITECTURE.md](ARCHITECTURE.md) (invariants).

---

## 1. Accounts and the unified drive

- **Connect Google account** — OAuth sign-in adding another Drive to the pool; repeatable for unlimited accounts.
- **Vault mode (encrypt everything)** — a Settings switch that encrypts every new upload and new folder on this PC before it leaves (files and names), with its own password and recovery key. Works while locked (drag-drop, tray, LAN, MCP); unlocking reveals names and allows preview/download. Encrypted items stay in the normal tree with a lock badge. Local folder backups pause while it's on; existing files are untouched.
- **Add S3-compatible storage** — any S3 API (AWS, Cloudflare R2, Backblaze B2, Wasabi, MinIO…): endpoint, region, bucket, optional prefix, access keys, path-style toggle, and a **storage limit in GB** set while adding. The keys are tested (list + write) before saving and stored encrypted.
- **Edit S3 storage** — change its name, limit or access keys later; also how a bucket whose keys stopped working is reconnected.
- **S3 as a full account** — its objects are browsable and searchable, uploads are auto-placed on it up to the limit, and files can be previewed, downloaded, renamed, copied, deleted and moved to/from Drive accounts. Share links, thumbnails, backups and the vault stay Drive-only.
- **Unified file tree** — every connected account's `MaxDrive` folder merged into one browsable tree with no account boundaries visible.
- **Unified search** — one query searches across all connected accounts at once.
- **Account identity by ID** — accounts are keyed by Google `permissionId`, so renames and email changes never break the index.
- **Reconnect account** — re-run OAuth for an account whose token expired or was revoked, keeping all existing files and IDs.
- **Disconnect account** — remove an account from MaxDrive; its files leave the unified view but stay in Google Drive.
- **Disconnect impact preview** — before disconnecting, shows how many files and how much storage will disappear from the unified view.
- **Per-account re-index** — force a full rescan of one account without touching the others.
- **Quota refresh** — pull current used/total storage figures for an account on demand.
- **Account health status** — per-account auth state (ok / needs reauth / error) shown on the Accounts page.

## 2. Files: browsing and viewing

- **Browse folders** — navigate the merged tree with breadcrumbs and a folder sidebar.
- **List view** — dense table with name, activity, owner account, location, and size.
- **Grid view** — thumbnail tiles for visual scanning.
- **View mode toggle** — switch list/grid; the Files view keeps it for the session, the Home page remembers its own choice.
- **Ordering** — folders first, then by name; Recent is newest first.
- **Recent files** — everything touched recently across all accounts, newest first.
- **Starred files** — a cross-account view of everything starred.
- **Trash view** — deleted items from all accounts in one place.
- **Home page** — landing view with suggested folders and suggested files.
- **File type icons** — per-MIME iconography (docs, sheets, slides, images, video, archives, code).
- **Thumbnails** — image and video previews streamed through the `maxthumb://` protocol.
- **File details panel** — name, type, size, owner account, created/modified dates, and path.
- **Activity history** — recent changes recorded per file.
- **Preview overlay** — in-app viewer for images, video, audio, PDFs, and text without downloading.
- **Video/audio scrubbing** — seek anywhere in a media file; only the needed byte range is fetched (`maxfile://` with HTTP Range).
- **Open in Google Drive** — open a Drive file on the Drive website.
- **Show in folder** — reveal a downloaded file in Windows Explorer.

## 3. Files: managing

- **Upload files** — pick files and send them to the current folder.
- **Upload folder** — upload a whole directory, preserving its structure.
- **Drag and drop upload** — drop files or folders anywhere in the window; they land in the folder being browsed.
- **Automatic account placement** — uploads are routed to whichever connected account has the most free room, with a configurable headroom reserve.
- **Download** — save any file or selection to the Windows Downloads folder.
- **Create folder** — new folder in the current location.
- **Rename** — rename any file or folder.
- **Move** — relocate items via a folder-picker dialog, including across accounts.
- **Cross-account migration** — moving between accounts transparently re-uploads and cleans up the source.
- **Copy** — copy items to another location.
- **Duplicate** — one-step copy of an item beside itself.
- **Cut / Copy / Paste** — clipboard-style file operations with keyboard shortcuts.
- **Select all** — select every item in the current view.
- **Multi-select** — Ctrl/Shift click to build a selection; all actions operate on the whole selection.
- **Star / Unstar** — flag items for the Starred view.
- **Move to trash** — soft-delete, recoverable from the Trash view.
- **Restore from trash** — put a trashed item back where it came from.
- **Delete forever** — permanent removal, with confirmation.
- **Context menu** — right-click menu exposing every applicable action for the item under the cursor.
- **Toolbar actions** — the same actions surfaced as a toolbar over the current selection.

## 4. Sharing

- **Create share link** — generate a Google Drive shareable link for a file or folder.
- **Copy link** — copy an existing share link to the clipboard.
- **Set link access level** — choose viewer / commenter / editor for the link.
- **Share with a person** — grant a specific email address access.
- **List permissions** — see everyone who currently has access to an item.
- **Remove permission** — revoke one person's access.
- **Revoke link** — turn off link sharing entirely.

## 5. Transfers

- **Transfer queue** — every upload, download, migration, backup, and restore runs through one managed queue.
- **Transfers page** — full list of active, queued, and finished jobs with per-job progress.
- **Transfer tray** — compact always-visible progress widget in the corner of the window.
- **Pause / resume a job** — control any single transfer.
- **Pause all / resume all** — stop or restart the whole queue at once.
- **Cancel job** — abort a transfer and clean up its partial file.
- **Retry job** — re-run a failed transfer.
- **Retry all** — re-run every failed transfer in one action.
- **Remove job** — drop a finished or failed entry from the list.
- **Clear finished** — clear all completed entries.
- **Resumable uploads** — interrupted uploads continue from where they stopped rather than restarting.
- **Resumable downloads** — interrupted downloads resume via HTTP Range, then verify by MD5.
- **Automatic retry with backoff** — up to 8 attempts with increasing delays on transient failures.
- **Crash recovery** — the queue is stored in SQLite, so transfers survive an app crash or force-quit.
- **Offline parking** — transfers pause when the network drops and resume when it returns.
- **Sleep/wake handling** — the queue pauses on system suspend and resumes on wake.
- **Concurrency limits** — capped parallel transfers (and one write per account) to stay inside Google's API quota.
- **Auto-resume on launch** — optionally restart interrupted transfers when the app starts.
- **Partial-file cleanup** — orphaned `.maxdrivepart` files are swept on startup.

## 6. Storage and allocation

- **Storage page** — combined and per-account capacity, usage, and free space.
- **Per-account usage bars** — visual breakdown of each Drive's fill level.
- **Almost-full warning** — flags accounts approaching their limit.
- **Headroom setting** — reserve a configurable amount of space per account that uploads won't touch.
- **Quota-aware placement** — uploads that don't fit on one account automatically spill to another.

## 7. Sync and indexing

- **Full scan** — walk every connected account and build the local file index.
- **Incremental change polling** — Google Drive change feed keeps the index current without rescanning.
- **Local SQLite index** — the whole tree cached locally so browsing and search are instant and work offline.
- **Refresh** — "Refresh current folder" re-pulls account quotas on demand.
- **Rebuild index** — rescan every connected account to repair the local index.
- **Index cloud backup** — the index database is backed up to Drive so a reinstall doesn't require a full rescan.
- **Back up index now** — trigger that backup on demand.
- **Index restore** — list available index backups in Drive and restore from a chosen one.
- **Hidden internal folders** — MaxDrive's own `.backup` and `.vault` areas are excluded from the unified tree, search, and every file view.

## 8. Local folder backup

- **Backup sets** — define one or more local folders to back up to Drive.
- **Mirror mode** — keeps the Drive copy identical to the local folder, including deletions.
- **Archive mode** — a full zipped snapshot each run with a manifest; the two newest complete runs are kept and older ones go to Drive trash.
- **Scheduled backups** — hourly, daily, weekly, or monthly.
- **Day-of-week / day-of-month selection** — pick exactly when weekly and monthly runs happen.
- **Time-of-day selection** — set the hour a scheduled run starts.
- **Custom interval** — run every N hours instead of a calendar schedule.
- **Preferred account** — pin a backup set to a specific Drive account, or let MaxDrive choose.
- **Ignored folders rule** — exclude folders by exact name (case-insensitive).
- **Excluded file types rule** — skip specific extensions.
- **Include-only file types rule** — back up only the listed extensions.
- **Run now** — trigger a backup set immediately.
- **Pause / resume a set** — suspend one backup set without deleting it.
- **Global pause** — suspend all backup activity at once.
- **Deletion confirmation** — mirror-mode deletions above a threshold require explicit approval before they're applied.
- **Change detection** — only added, modified, or removed files are transferred on each run.
- **Backup status dashboard** — per-set last-run result, next-run time, and current state.
- **Restore browser** — navigate the backed-up tree in Drive and pick what to bring back.
- **Selective restore** — restore an individual file, a folder, or a whole set back to its original location inside the set's folder.
- **Backup trash** — files removed by a mirror run go to Drive's trash (or are kept with "Keep cloud copy forever") and show as "in Drive trash" in the restore browser.
- **Edit set** — change a set's rules, schedule, or account after creation.
- **Remove set** — delete a backup set, optionally leaving its Drive copy intact.

## 9. Secure Storage (encrypted vault)

### Setup and keys
- **Create vault** — first-run setup with a master password (8-character minimum) and a strength meter.
- **Recovery key** — a one-time random key issued at setup, the only way in if the password is forgotten.
- **Save recovery key to file** — write the key to a `.txt` anywhere on disk.
- **Copy recovery key** — copy it to the clipboard.
- **Forced acknowledgement** — the setup flow will not continue until the key has been saved or copied.
- **Change master password** — re-locks the vault key without re-uploading or touching a single file.
- **Change password using the recovery key** — the current secret may be the old password *or* the recovery key, so a forgotten password can be replaced rather than lived with.
- **Guided password recovery** — unlocking with the recovery key drops straight into the set-a-new-password dialog.
- **Recovery key survives password change** — an existing key keeps working after a password change.
- **Regenerate recovery key** — issue a replacement key; the previous key immediately stops working.
- **Rotate recovery key without the password** — the old recovery key is accepted as proof, so a key that may have been exposed can always be replaced.
- **Unlock with password** — the normal way into the vault.
- **Unlock with recovery key** — alternate unlock path when the password is lost.
- **Brute-force rate limiting** — after 5 wrong attempts, exponentially increasing delays (capped at 5 minutes), persisted across restarts and shown as a live countdown.

### Locking
- **Lock on demand** — a lock button on the Secure page and a "Lock the vault" command in the palette.
- **Idle auto-lock** — locks automatically after a configurable idle period (default 10 minutes).
- **Lock on quit** — the key is zero-filled from memory when the app exits.
- **Nothing visible while locked** — no names, no counts, no thumbnails; the main process refuses to list anything without the key.

### Files
- **Upload to vault** — files are encrypted on this computer *before* any upload begins.
- **Browse vault** — folders, breadcrumbs, list and grid views, matching the normal file browser.
- **Create vault folder** — organize secure files into a folder tree.
- **Rename vault item** — rename files and folders inside the vault.
- **Delete vault item** — removes the local record and every encrypted copy from Drive.
- **Vault file details** — name, type, size, created and modified dates, and per-account copy status.
- **Vault thumbnails** — encrypted image thumbnails, decrypted on the fly for display.
- **Vault preview** — view images, video, audio, PDFs, and text in-app, decrypted in memory with no plaintext ever written to disk.
- **Vault video scrubbing** — seeking fetches and decrypts only the covering chunks.
- **Download and decrypt** — retrieve a secure file from Drive, decrypt it locally, and save the original to a chosen folder.
- **Integrity verification** — every chunk is authenticated and the whole file is checked against a SHA-256 hash on decrypt; tampering fails loudly.
- **Hidden transfers** — vault uploads and downloads never appear in the Transfers page, the tray or the LAN API, because their names would leak vault contents.

### Storage accounts
- **Choose host accounts** — pick which connected Drive accounts store the encrypted vault.
- **Add a host account** — extend the vault onto another Drive.
- **Copies setting** — choose how many accounts each file is replicated to (default 1).
- **Background replication** — copies are made by moving ciphertext, so it works even while the vault is locked.
- **Per-account vault status** — health, copy counts, free space, and last error for each host account.
- **Removal impact check** — before removing an account, MaxDrive names the files that would become unreachable.
- **Drain before removal** — the safe default: re-replicate at-risk files elsewhere, then remove the account.
- **Force removal** — remove anyway, with an optional delete-the-remote-copies step.
- **Unavailable account tolerance** — if one host account is offline, the vault keeps working from the others.
- **Automatic reconciliation** — a periodic pass repairs missing copies, retries blocked replications, and re-checks accounts that came back online.

### Disaster recovery
- **Vault detection on a fresh install** — MaxDrive finds an existing vault in your connected Drives and offers to restore it.
- **Restore from Drive alone** — the vault config and an encrypted index live beside the blobs, so the password (or recovery key) is all you need.
- **Self-describing blobs** — each encrypted file carries its own wrapped key, so even files uploaded after the last index snapshot are recoverable.
- **Crash sweep** — interrupted encryptions and orphaned temp blobs are cleaned up on the next launch.

### Privacy guarantees
- **Encrypted before upload** — the original file never reaches Google Drive.
- **Opaque in Drive** — a connected Drive shows only meaningless `<uuid>.mxv` files with no names, extensions, or readable content.
- **Encrypted metadata at rest** — file names and types are encrypted in the local database, so even the SQLite file leaks nothing while locked.
- **Invisible to normal MaxDrive** — vault contents never appear in Files, search, recent, starred, or the sidebar tree.
- **Key never leaves the main process** — the UI receives decrypted results, never keys.

## 10. Search and navigation

- **Search bar** — cross-account search with a keyboard shortcut to focus it.
- **Command palette** — searchable list of every action in the app.
- **Keyboard shortcuts** — full chord set for navigation, file operations, and transfer control.
- **Shortcut help overlay** — a reference sheet of every binding.
- **Back / forward** — history navigation through visited folders.
- **Up to parent** — jump one level up the tree.
- **Jump to root** — return to the top of the unified drive.
- **Page shortcuts** — Home (Ctrl+Shift+H), Transfers (Ctrl+J) and Settings (Ctrl+,); every page is also in the command palette.

## 11. Settings and app shell

- **Theme** — light, dark, or follow Windows.
- **Color scheme** — Graphite (neutral, default), Drive (blue), or Midnight (true black); picked from preview cards in Settings, each with a light and dark version.
- **Start on Windows sign-in** — launch MaxDrive automatically at login.
- **Minimize to tray** — closing the window keeps MaxDrive running in the background.
- **System tray icon** — quick access and status while the window is closed.
- **Auto-resume transfers** — restart interrupted transfers on launch.
- **Headroom per account** — the reserved free space setting used by upload placement.
- **Google connection settings** — enter the OAuth Client ID and secret (stored encrypted on this PC; never shown again).
- **About** — version and app information.
- **Frameless custom window** — custom titlebar with native minimize/maximize/close and drag regions.
- **Toast notifications** — non-blocking success, error, and progress messages.
- **Confirmation dialogs** — destructive actions require explicit confirmation.
- **Themed dropdowns** — every select in the app is a custom keyboard-accessible listbox matching the app's design.
