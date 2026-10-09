# Settings and appearance

Open **Settings** from the sidebar, the gear in the title bar, or Ctrl+,. This
guide walks through each section in the order it appears. Changes apply
immediately - there is no Save button, except where noted.

## Defaults at a glance

| Setting | Default |
| --- | --- |
| Theme | System |
| Color scheme | Graphite |
| Start MaxDrive when I sign in to Windows | Off |
| Keep running in the tray when I close the window | On |
| Resume interrupted transfers automatically | On |
| Headroom per account | 200 MB |
| Check S3 buckets for changes | 15 min |

## Appearance

![Theme and color scheme settings](../screenshots/settings-appearance.png)

### Theme

Choose **Light**, **Dark** or **System**. System follows the Windows light/dark
setting and switches when Windows does. The theme button in the title bar (or
"Switch theme" in the command palette) cycles through the three.

### Color scheme

Pick one of three preview cards. Each card shows the scheme's light and dark
versions side by side, and the theme above decides which one you see.

| Scheme | Look |
| --- | --- |
| **Graphite** (default) | Neutral greys, monochrome |
| **Drive** | Google Drive blue |
| **Midnight** | True black, suited to OLED screens |

### List or grid view

There is no default-view option on this page. Switch between list and grid with
the toggle at the top of any file view, or Ctrl+Shift+V (see
[Files and transfers](files-and-transfers.md#list-and-grid)).

## Startup and background

- **Start MaxDrive when I sign in to Windows** - launches MaxDrive minimised to
  the system tray at sign-in, so queued transfers resume on their own. This
  applies to the installed app.
- **Keep running in the tray when I close the window** - closing the window
  hides MaxDrive to the tray instead of quitting, and uploads and downloads
  carry on. To quit completely, right-click the tray icon and choose **Quit
  MaxDrive**. The tray menu also has **Open MaxDrive** and **Pause transfers** /
  **Resume transfers**.
- **Resume interrupted transfers automatically** - at launch, transfers that
  were cut off by a crash, shutdown or restart pick up where they stopped.
  Transfers you paused yourself stay paused.

## Storage

### Headroom per account

A slider from 0 to 1000 MB (in 50 MB steps). This much space is left untouched
on every account, so none is ever filled to the brim. An upload only goes to an
account with room for the file plus this reserve. See
[How upload placement works](accounts-and-storage.md#how-upload-placement-works).

### Check S3 buckets for changes

S3 has no change feed, so MaxDrive re-lists each bucket on this schedule to
notice files added, changed or removed outside MaxDrive. Choose **5 min**,
**15 min**, **1 hour**, **6 hours** or **Manual**. Large buckets cost more
requests per check. With Manual, buckets are only re-listed when you click
**Re-index** on the Accounts page.

## Encrypt everything (vault mode)

Encrypts every new upload and folder on this PC before it leaves, with its own
password and recovery key. Before it is set up this section shows a **Set up**
button; afterwards it has the lock state, **Encrypt all new uploads**, **Lock
automatically** and **Change password**. See [Vault mode](vault-mode.md).

## Google connection

MaxDrive signs in to Google with an OAuth client that you create in your own
Google Cloud project. [Google Cloud setup](google-cloud-setup.md) explains how
to create one.

When no client is configured, this section says "Google connection not
configured" and shows two fields:

1. Paste the **Client ID** (it ends in `apps.googleusercontent.com`).
2. Paste the **Client secret**.
3. Click **Save**.

The section then reads "Connected to Google". The ID and secret are stored
encrypted on this PC (with Windows data protection, tied to your Windows
account) and are never shown again, not even to you.

To switch to a different OAuth client, click **Change**, enter the new ID and
secret, and click **Save** (or **Cancel**). Accounts connected with the old
client will need to be reconnected from the Accounts page.

If the section says it is using `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
from `.env`, the app was started with a developer configuration file; saving a
client here takes precedence.

## Remote access and devices

Opt-in LAN access for your phone and for AI assistants through the built-in MCP
server, with device pairing. It is off by default. See
[Remote access and AI](remote-access-and-ai.md).

## Index backup and restore

Restores MaxDrive's file index from a snapshot stored in your Google Drive,
for example after reinstalling Windows (**Find cloud backups**). See
[Index backup and recovery](index-backup-and-recovery.md).

## Keyboard shortcuts

Every command that has a shortcut is listed here with its category.

- Type in **Search shortcuts...** to filter by name, category or key.
- Click a shortcut, then press the new key combination. Press Escape to cancel.
- Click the reset arrow next to a shortcut to restore its default, or **Reset
  all** to restore every default.

Some keys are shared on purpose - Space previews a file in the file list and
pauses a job in the transfer list - and the list notes which commands share a
key. A clash that would actually conflict is marked with a warning icon.
Shortcuts only work while MaxDrive is focused. The default set is listed in
[Files and transfers](files-and-transfers.md#keyboard-shortcuts).

## About

Shows the MaxDrive version and the folder that holds the file index and logs -
useful when reporting a problem.

## Settings that live elsewhere

- **Secure Storage** (the encrypted vault) is set up and managed on the
  **Secure** page. See [Secure Storage](secure-storage.md).
- **Local folder backup** is configured on the **Backup** page. See
  [Local backup](local-backup.md).
- **Accounts** (Google and S3) are managed on the **Accounts** page. See
  [Accounts and storage](accounts-and-storage.md).
