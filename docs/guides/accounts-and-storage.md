# Accounts and storage

MaxDrive pools any number of Google Drive accounts and S3-compatible buckets
into one drive. This guide covers adding and managing those accounts, and how
MaxDrive decides where each upload goes.

## Connect a Google account

![The Accounts page](../screenshots/accounts.png)

Before the first Google account can be added, MaxDrive needs a Google OAuth
client. Create one by following [Google Cloud setup](google-cloud-setup.md),
then paste it into **Settings > Google connection** (see
[Settings and appearance](settings-and-appearance.md#google-connection)).

1. Open **Accounts** in the sidebar.
2. Click **Add Google Drive**. The button changes to "Waiting for Google..."
   while Google's sign-in page is open in your web browser.
3. Sign in and approve access. When you return to MaxDrive the account appears
   in the list and its files start indexing in the background.
4. Repeat for every account you want in the pool. There is no limit.

You can also connect from the **Storage** page ("Connect another Google
account") or the command palette ("Add Google Drive account").

Connecting an account that is already connected is harmless: MaxDrive
recognises it by its Google account ID (not its email address) and simply
updates it.

## Add an S3 bucket

![The Add S3-compatible storage dialog](../screenshots/add-s3.png)

Any service that speaks the S3 API works: AWS S3, Cloudflare R2, Backblaze B2,
Wasabi, MinIO and others.

1. On the **Accounts** or **Storage** page, click **Add S3-compatible storage**.
2. Fill in the dialog:

   | Field | What to enter |
   | --- | --- |
   | Name | Optional. Shown instead of the bucket name. |
   | Endpoint URL | Your provider's S3 endpoint. Leave blank for AWS. If you omit `https://`, it is added for you. |
   | Bucket | The bucket name. |
   | Region | The bucket's region (default `us-east-1`). Use `auto` for Cloudflare R2. |
   | Prefix | Optional. Restricts MaxDrive to one folder of the bucket, for example `maxdrive/`. |
   | Path-style URLs | Needed by MinIO and most self-hosted servers. AWS and R2 work either way. Turned on automatically when you enter an endpoint; you can untick it. |
   | Access key ID / Secret access key | Keys that can list, read and write the bucket. |
   | Storage limit (GB) | Required. MaxDrive never places more than this on the bucket. |

3. Click **Connect**. MaxDrive shows "Testing connection..." while it lists the
   bucket and writes (then deletes) a small test object. If the keys can read
   but not write, or the bucket cannot be reached, the error is shown in the
   dialog and nothing is saved.

Typical endpoints (check your provider's documentation for the exact form):

| Provider | Endpoint | Region |
| --- | --- | --- |
| AWS S3 | leave blank | the bucket's region |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | `auto` |
| Backblaze B2, Wasabi | the S3 endpoint shown in your provider's console | the bucket's region |
| MinIO / self-hosted | your server's URL | as configured; tick Path-style URLs |

The access keys are stored encrypted on this PC. Files you upload through
MaxDrive go into a `MaxDrive/` folder inside the bucket (or inside the prefix),
and MaxDrive never overwrites an existing object - a clash gets a numbered
name such as `report (2).pdf`.

### Why a storage limit?

Buckets have no quota of their own, so the limit you set is what upload
placement plans around. The used figure for a bucket is the total size of
everything MaxDrive has indexed in it. The Accounts and Storage pages label it
"limit set by you".

## Edit S3 storage

Click **Edit** on the bucket's row in **Accounts**. You can change the name,
the storage limit and the access keys. To keep the current keys, leave both key
fields blank; to replace them, enter both. The endpoint, bucket, region, prefix
and path-style setting are fixed once connected and shown read-only.

## Reconnect an account

If an account's sign-in expires or access is revoked, its row on the Accounts
page shows **Reconnect needed** (or **Disconnected** if you removed it earlier).
While that is the case, MaxDrive stops syncing it and does not place uploads on
it, but its files stay in the index.

- **Google account:** click **Reconnect** and sign in again. You must choose the
  same Google account - picking a different one is rejected. All files and
  folders come back exactly as they were.
- **S3 bucket:** click **Reconnect needed** (or **Edit**) and enter new access
  keys. The keys are tested again before saving.

## Disconnect or remove an account

1. Click **Disconnect** (Google) or **Remove** (S3) on the account's row.
2. The dialog shows how many files, and how much data, physically live on that
   account.
3. Optionally tick **Also remove its files from the MaxDrive index**. Leave it
   off to keep seeing those files (marked "Unavailable"); reconnecting the same
   account restores them either way.
4. Confirm.

Nothing is deleted from Google Drive or from the bucket. MaxDrive only forgets
its sign-in or access keys.

## Re-index one account

Click **Re-index** on an account's row to rescan it and rebuild its part of the
index without touching the others. A notification reports how many files were
found. Use this if something changed outside MaxDrive and has not shown up yet.

To rescan every account at once, run **Rebuild index** from the command palette
(Ctrl+P).

Google accounts pick up outside changes on their own within about a minute
while MaxDrive is focused. S3 has no change feed, so buckets are re-listed on a
schedule - every 15 minutes by default, adjustable under **Settings > Storage >
Check S3 buckets for changes** (5 min, 15 min, 1 hour, 6 hours or Manual). Large
buckets cost more requests per check.

## The Storage page

![The Storage page](../screenshots/storage.png)

**Storage** in the sidebar shows:

- Total used and free space across all accounts, with a combined usage bar.
- **Largest single file you can upload right now** and which account it would
  go to. Files are never split across accounts, so this - not the combined free
  space - is the real ceiling.
- A card per account with its own usage bar and free space. An account at 90%
  or more is flagged with a warning icon.
- **Refresh**, which asks every account for fresh usage figures. Figures are
  otherwise cached for up to 15 minutes, so use this after deleting files on the
  Google Drive website.

For Google accounts the figures are the whole account's usage: Google counts
Gmail and Photos against the same storage pool as Drive.

## How upload placement works

You never pick an account when uploading. When an upload actually starts (not
when it is queued), MaxDrive:

1. Works out each account's free space: its limit, minus what is used, minus
   bytes already promised to other queued or running uploads.
2. Keeps only the accounts with room for the file plus the **headroom** reserve
   (200 MB by default, set under **Settings > Storage > Headroom per account**).
3. Sends the file to the account with the most free space.

If an account fills up partway through an upload, MaxDrive refreshes its
figures and restarts the upload on another account. If no account can hold the
file, the upload fails straight away with a message naming the largest free
slot; free some space and click **Retry**.

S3 buckets take part in placement for your files. MaxDrive's own internal data
(local folder backups, the Secure Storage vault and index snapshots) is only
ever placed on Google Drive accounts.

## What S3 accounts can't do

S3 buckets are full members of the unified drive - browse, search, preview,
download, rename, copy, move to and from Drive accounts, trash and delete all
work. A few things are Google Drive only:

| Feature | On S3 |
| --- | --- |
| Share links and sharing with people | Not available |
| Thumbnails | Not available; files show their type icon |
| Local folder backups | Not stored on S3 |
| Hosting the Secure Storage vault | Not available |
| Index snapshots (cloud backup of the file index) | Not stored on S3 |
| Trash and star | Kept in MaxDrive only; the object stays in the bucket until you delete it forever |
| Change detection | Periodic re-listing instead of a live feed (see above) |
