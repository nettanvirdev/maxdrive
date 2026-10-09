# Local folder backup

The Backup page keeps a copy of folders on your PC in your Google Drive accounts, on a schedule you choose. Backups are one-way: changes on your PC flow to Drive, never back.

Each folder you back up is a **backup set** with its own format, schedule, rules and account. Backups are stored in a hidden `.backup` area of your `MaxDrive` folder, so they don't clutter your file tree or search.

## Before you start

- You need at least one connected **Google Drive** account. Backups can't be stored on S3-compatible storage. See [Accounts and storage](accounts-and-storage.md).
- Backups are paused while [vault mode](vault-mode.md) is on, because backups upload plaintext. The Backup page shows **Backups are paused while vault mode is on** until you turn it off.

## Back up a folder

![The Back up a folder dialog](../screenshots/backup-new.png)

1. Open **Backup** and click **Back up a folder** (or **Choose a folder** on an empty page).
2. Click **Browse** and pick the folder. The **Name** fills in from the folder name; change it if you like.
3. Choose a **Storage format**: **Mirror (recommended)** or **Zip archive** (see below).
4. Choose what happens **When a file is deleted locally** (see below).
5. Set the **Schedule**.
6. If you have more than one account, pick a **Preferred account**.
7. Review the **Rules**.
8. Click **Start backing up**.

If the folder overlaps one you already back up, MaxDrive warns you but still creates the set.

## Mirror or zip archive

| Format                   | How it works                                                                                                         | Best for                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Mirror (recommended)** | Keeps your folder structure in Drive. Only new or changed files upload; renamed files are renamed in Drive without re-uploading. Any single file can be restored. | Most folders                      |
| **Zip archive**          | Each run uploads a full compressed snapshot, split into zip parts that can span several accounts. The two newest complete runs are kept; older ones go to Drive's trash. | Folders with many tiny files      |

The format can't be changed after the set is created.

### When a file is deleted locally

- **Move cloud copy to trash** (default): the Drive copy goes to Drive's trash, where it is recoverable for 30 days before Google purges it. Storage is reclaimed.
- **Keep cloud copy forever**: deleted files stay in the backup and restorable until you remove them yourself.

## Schedules

| Schedule            | Options                                                        |
| ------------------- | -------------------------------------------------------------- |
| **Manual only**     | Runs only when you click **Back up now**                       |
| **Every few hours** | **Every hour**, **Every 3 hours**, **Every 6 hours** (default), **Every 12 hours** |
| **Daily**           | A time of day (default 02:00)                                  |
| **Weekly**          | A day of the week and a time                                   |
| **Monthly**         | A day of the month (1-31) and a time. In shorter months, day 31 runs on the last day. |

Only one backup runs at a time; other due sets wait their turn. Scheduled runs wait while you are offline. If your PC was asleep or MaxDrive was closed when a run was due, it runs once when MaxDrive is back, not once for every missed slot.

## Preferred account

**Automatic (most free space)** lets MaxDrive pick. Choosing an account pins the set to it; files spill to other accounts automatically when it fills up. This option appears only when more than one account is connected.

## Rules

| Rule                      | Effect                                                                                                  | Default                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Ignored folders**       | Folders with these exact names are skipped entirely, at any depth (not case-sensitive)                  | `node_modules`, `.git`, `.github` |
| **Excluded file types**   | Files with these extensions are never backed up. `.env` also catches a file named `.env`.               | `.env`                           |
| **Only these file types** | If not empty, only files with these extensions are backed up, and **Excluded file types** is ignored    | Empty                            |

Type a value and press Enter or comma to add it; click the x on a chip to remove it. Extensions work with or without the leading dot.

## Run, pause and resume

- **Back up now** (play button on a set) starts a run immediately. It is disabled while the set is running, paused, or vault mode is on.
- **Pause this folder** / **Resume this folder** pauses one set, including any of its uploads in progress, and resumes it later.
- **Pause all** (top of the page) stops scheduled runs from starting for every set. A banner says **All backups are paused**. Click **Resume backups** to continue.

## Check status

Each set's card shows:

- The format (**Mirror** or **Archive**) and a **Paused** tag if paused.
- The folder path, how many files and how much data are backed up, and the schedule.
- While running: **Scanning for changes...** then **Backing up N of M files** with a progress bar.
- Otherwise: **Last run** time and result (**Completed**, **Completed with warnings**, **Failed** or **Canceled**) and the **Next** scheduled run.

Backup runs don't appear on the Transfers page; their progress shows here instead.

## Confirm large deletions

If a mirror run finds that many files disappeared locally - more than 20 files and more than a quarter of the backed-up files - MaxDrive keeps their cloud copies and stops short. The card shows a warning: **Many files disappeared locally, so their cloud copies were kept.** This protects you from, for example, a drive that wasn't mounted.

- If the deletions were intentional, click **Confirm deletions**. The set runs again and mirrors them.
- If not, leave it; nothing in Drive was removed.

## Restore files

1. On the set's card, click **Restore files**.
2. Browse the backup. Folders show their file count and size; files may be tagged **missing locally** or **in Drive trash**.
3. Tick the files or folders you want, or open a folder to restore just that folder.
4. Choose options at the bottom:
   - **Overwrite existing files**: off by default, so files that already exist locally are skipped.
   - **Recover trashed copies** (mirror only, on by default): brings back copies that are in Drive's trash.
5. Click **Restore N selected**, **Restore this folder** or **Restore everything missing**.

Files are restored to their original place inside the backed-up folder. Archive restores download the whole newest archive before extracting your selection, so they need free disk space for it.

## Edit or remove a set

**Edit rules and schedule** (pencil button) changes the name, deletion behaviour, schedule, preferred account and rules. The folder and format are fixed.

**Remove backup** (trash button) asks **Stop backing up "name"?**. Your local files are never touched. Choose:

- **Keep cloud copy**: stops the backup and leaves the copy in Drive. You can delete it there later.
- **Also trash cloud copy**: also moves the backup to Drive's trash, where it stays recoverable for 30 days.

## Related

- Backing up MaxDrive's own file index is a different feature: see [Index backup and recovery](index-backup-and-recovery.md).
- For encrypted storage, see [Secure Storage](secure-storage.md).
