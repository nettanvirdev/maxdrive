# Files and transfers

Everything in your connected accounts appears in one file tree. This guide
covers finding, opening and managing files, how uploads and downloads run in
the background, and the keyboard shortcuts that speed it all up.

## Find your way around

The sidebar on the left holds:

| Item | What it shows |
| --- | --- |
| **New** | Create a folder, or upload files or a folder. |
| **Home** | Suggested folders and suggested (recent) files. |
| **MaxDrive** | The unified drive: your folders and files, with no account boundaries. Expand it to jump to a top-level folder. |
| **Accounts** | Expand it to browse one account's own contents, exactly as they are laid out in that Google Drive or bucket. |
| **Recent** | Files across all accounts, newest first. Folders are left out. |
| **Starred** | Everything you starred, from every account. |
| **Transfers** | Uploads, downloads and moves in progress and finished. |
| **Trash** | Items you moved to trash, from every account. |
| **Storage**, **Backup**, **Secure**, **Settings** | Capacity, local folder backup, the encrypted vault, and preferences. |

Inside a folder, the breadcrumb at the top shows where you are; click any part
of it to go back up. The **Back** and **Forward** arrows in the title bar step
through folders you visited.

### List and grid

The toggle at the top right of a file view switches between:

- **List** - columns for Name, Activity, Owner (the account that physically
  holds the file), Location and Size.
- **Grid** - tiles with thumbnails for images and videos stored on Google Drive.

Ctrl+Shift+V switches too. In file views the choice lasts until you close the
app; the Home page remembers its own choice.

### Ordering

Folders are listed first, then files by name (A to Z). Recent is ordered by
date modified, newest first, and Trash by when the item was deleted. There is
no column sorting.

### Select items

- Click to select one item; Ctrl+click to add or remove one; Shift+click to
  select a range. Ctrl+A selects everything in the view.
- Right-click an item, or click its **More actions** button, for every action
  that applies. If the item is part of a selection, the action applies to the
  whole selection.
- With one item selected, the most common actions also appear as buttons at the
  top of the view.

## Search

Click the search box ("Search across all your Drives") or press Ctrl+K or
Ctrl+F, type, and press Enter. MaxDrive searches file and folder names across
every account at once, using its local index, so results are instant and work
offline. Press Escape to clear the box. Trashed items and locked vault-mode
files are not included.

## Open and preview

Double-click (or press Enter on) a file to open it:

- **Images, video, audio, PDFs and text files** (text up to 1 MB) open in the
  built-in preview without downloading the whole file. Video and audio can be
  scrubbed to any point; only the part you watch is fetched.
- **Google Docs, Sheets and Slides** open in your web browser.
- Other types show a "no preview for this type" card.

Space (or Ctrl+Shift+P) previews the selected file. **Open in Google Drive**
(Ctrl+Enter) opens a Drive file on the Google Drive website. **File
information** shows the type, size, which account it is stored on, its
location, created and modified dates, sharing state and recent activity. **Show file location** jumps to the folder containing a file, which is
handy from Search, Recent or Starred.

## Upload

Uploads go into the folder you are browsing. You never choose an account -
each file lands on the account with the most free room (see
[Accounts and storage](accounts-and-storage.md#how-upload-placement-works)).

- **Files:** New > **File upload**, or Ctrl+U.
- **A folder:** New > **Folder upload**, or Ctrl+Shift+U. The folder structure is
  kept.
- **Drag and drop:** drop files or folders anywhere in the window.

A file is never split across accounts, so the largest file you can upload is
limited by the emptiest single account. The Storage page shows that figure.

## Download

Select one or more files and choose **Download**. Files are saved to your
Windows Downloads folder; when a download finishes, click **Show in folder** on
its transfer row to see it in Explorer. Folders and Google Docs cannot be
downloaded this way.

## Organise files

| Action | How |
| --- | --- |
| New folder | New > **New folder**, or Ctrl+Shift+N |
| Rename | **Rename**, or F2 |
| Move within MaxDrive | **Move to folder**, then pick a destination; or Ctrl+X then Ctrl+V |
| Copy | Ctrl+C, open the destination, Ctrl+V |
| Duplicate (copy beside the original) | **Duplicate**, or Ctrl+D |
| Star / unstar | **Add to starred** / **Remove from starred** |

**Move to folder** only rearranges MaxDrive's own folders; the file stays on
the same account. To move a file's data to a different account, right-click it
and choose **Move to another account**, then pick the account. MaxDrive copies
the file to the new account, then removes it from the old one, and the move
shows up in Transfers. This works for single files (not folders or Google Docs)
and between any mix of Google Drive accounts and S3 buckets.

## Trash, restore and delete forever

- **Move to trash** (Delete key) hides items from every view except Trash. For
  Google Drive files the file also goes to that account's Google Drive trash.
  For S3, trash exists only in MaxDrive; the object stays in the bucket.
  On a folder you created in MaxDrive, this reads **Delete folder**.
- **Restore from trash** puts items back where they were.
- **Delete permanently** (Shift+Delete) asks for confirmation, then deletes the
  items from their storage. This cannot be undone.

## Share (Google Drive only)

Sharing uses Google Drive's own permissions, so it is available only for files
on Google Drive accounts (and not for vault-mode encrypted files).

- **Create shareable link** creates a link and copies it to the clipboard.
- **Copy link** copies an existing link. Shared items show a link icon in the
  list.
- **Share** opens the full dialog, where you can:
  - add people by email as Viewer, Commenter or Editor, optionally ticking
    **Send them an email notification**;
  - see everyone with access and remove a person;
  - switch General access between "Restricted" and "Anyone with the link"
    (**Create link** / **Turn off**).

## Transfers

Every upload, download and cross-account move runs in one background queue.
You can watch it on the **Transfers** page or in the small transfer panel in
the corner of the window, which you can expand, collapse or close.

- Each row has **Pause**, **Resume**, **Retry** (for failed jobs) and **Cancel**
  buttons. Cancelling cleans up the partial file.
- The Transfers page also has **Pause all**, **Resume all** and **Clear
  finished**. The tray icon menu has **Pause transfers** / **Resume
  transfers**.
- Up to three transfers run at once, with one upload per account at a time.

What happens when things go wrong:

- **Interrupted uploads and downloads resume** from where they stopped instead
  of starting over. Downloads are checked before they get their final name, so
  a broken file is never left looking complete.
- **Temporary errors** are retried automatically with increasing delays, up to
  8 attempts.
- **Network drops** park transfers without using up retries; they continue
  shortly after the connection returns.
- **Sleep:** the queue holds while the PC sleeps and carries on after wake.
- **Crashes and restarts:** the queue is saved to disk. With **Resume
  interrupted transfers automatically** on (the default, in Settings), jobs that
  were cut off restart at launch. Jobs you paused yourself stay paused.
- Closing the window does not stop transfers while **Keep running in the tray**
  is on.

## Command palette

Press Ctrl+P to open the command palette, type part of an action's name and
press Enter. Matching is forgiving - "nf" finds "New folder". The palette lists
the actions available right now, with their shortcuts, so it is also a quick way
to learn them.

## Keyboard shortcuts

Press F1 or Ctrl+/ for the full list inside the app. The defaults:

| Shortcut | Action |
| --- | --- |
| Ctrl+P | Command palette |
| Ctrl+K or Ctrl+F | Search |
| F1 or Ctrl+/ | Keyboard shortcuts |
| Escape | Close dialog or clear selection |
| Alt+Left / Alt+Right | Back / Forward |
| Alt+Up | Parent folder |
| Ctrl+Home | MaxDrive root |
| Ctrl+Shift+H | Home |
| Ctrl+J | Transfers |
| Ctrl+, | Settings |
| Ctrl+U / Ctrl+Shift+U | Upload files / Upload folder |
| Ctrl+Shift+N | New folder |
| Enter | Open |
| Space or Ctrl+Shift+P | Preview |
| Ctrl+Enter | Open in Google Drive |
| F2 | Rename |
| Delete | Move to trash |
| Shift+Delete | Delete permanently |
| Ctrl+A | Select all |
| Ctrl+X / Ctrl+C / Ctrl+V | Cut / Copy / Paste |
| Ctrl+D | Duplicate |
| Ctrl+Shift+V | Switch between list and grid |

On the Transfers page, with a job focused, some keys act on the job instead:
Space pauses or resumes it, R retries it, Ctrl+R retries all failed jobs, and
Delete removes a finished job from the list.

Shortcuts only work while MaxDrive is focused. You can change any of them under
**Settings > Keyboard shortcuts** (see
[Settings and appearance](settings-and-appearance.md#keyboard-shortcuts)).
