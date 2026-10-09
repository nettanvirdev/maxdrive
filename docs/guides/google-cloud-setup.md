# Google Cloud setup

MaxDrive talks to Google Drive with **your own** Google Cloud OAuth client - no
shared client ships with the app, so your accounts never depend on anyone
else's project or quota. You only do this once. It produces a **Client ID** and
**Client secret** that you paste into MaxDrive's Settings on first run; they are
encrypted on disk with Windows DPAPI.

Only using S3-compatible storage? Skip this guide entirely - see
[accounts-and-storage.md](accounts-and-storage.md).

Budget about 10 minutes.

---

## 1. Create the project

1. Go to <https://console.cloud.google.com/>.
2. Sign in with **any one** of your Gmail accounts. This account owns the
   project; your other accounts don't need to be involved here. They'll each just
   sign in to the finished app later.
3. Click the project dropdown in the top bar → **New project**.
4. Name: `MaxDrive`. Leave the organisation as-is. Click **Create**.
5. Wait for the notification, then make sure the project dropdown now says
   **MaxDrive**. Everything below happens inside this project.

## 2. Enable the Drive API

1. Left menu → **APIs & Services** → **Library**.
2. Search for **Google Drive API**, open it, click **Enable**.

## 3. Configure the OAuth consent screen

1. Left menu → **APIs & Services** → **OAuth consent screen**.
2. User type: **External**. Click **Create**.
   _(Internal is only available with Google Workspace, which personal Gmail
   accounts don't have.)_
3. Fill in the required fields:
   - App name: `MaxDrive`
   - User support email: your email
   - Developer contact email: your email
   - Everything else can stay blank.
4. **Save and continue**.

## 4. Add the Drive scope

1. On the **Scopes** step, click **Add or remove scopes**.
2. In the filter box paste:
   ```
   https://www.googleapis.com/auth/drive
   ```
3. Tick it and click **Update**, then **Save and continue**.

This is a _restricted_ scope. Google will show a warning about verification —
that's expected and you can ignore it. See step 6.

## 5. Add your accounts as test users, then move on

1. On the **Test users** step, click **Add users** and add **all** of the Gmail
   addresses you intend to connect.
2. **Save and continue**, then **Back to dashboard**.

## 6. Publish the app - do not skip this

On the OAuth consent screen dashboard, find **Publishing status** and click
**Publish app** → confirm.

**Why this matters:** while the app sits in _Testing_ status, Google expires
every refresh token after **7 days**. You would have to re-authenticate every
account every single week. Publishing to Production makes the tokens
long-lived.

You do **not** need to submit for verification. An unverified app keeps
working; it just shows a warning screen the first time each account signs in
(see step 8), and it's capped at 100 total users over the project's lifetime,
which is irrelevant here.

If Google prompts you to "Prepare for verification", you can leave the form
unsubmitted. The publishing status is what counts.

## 7. Create the OAuth client

1. Left menu → **APIs & Services** → **Credentials**.
2. **Create credentials** → **OAuth client ID**.
3. Application type: **Desktop app**. This matters - desktop clients are what
   allow the loopback redirect MaxDrive uses.
4. Name: `MaxDrive Desktop`. Click **Create**.
5. Copy the **Client ID** and **Client secret** from the dialog (you can always
   come back to Credentials and reopen the client to see them again).

## 8. Paste them into MaxDrive

Launch MaxDrive, open **Settings → Google connection**, paste the **Client ID**
and **Client secret**, and click **Save**. They are encrypted with Windows DPAPI
into `%APPDATA%/maxdrive/oauth-client.bin`; the app never shows them again, and
no build or installer ships a client. Use **Change** there to switch clients
later (accounts connected with the old client must then be reconnected).

For development you can instead put them in a `.env` in the project root
(copy `.env.example`):

```
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-…
```

`.env` is only used while nothing is saved in Settings, and is never bundled
into the installer. Google’s own documentation says installed-app client
secrets cannot be kept confidential, which is why the flow also uses PKCE.

Then click **Connect a Google account** once per Gmail
account.

On each account's consent screen you'll see:

> **Google hasn't verified this app**

Click **Advanced** → **Go to MaxDrive (unsafe)** → **Continue**, then grant the
Drive permission. This is the expected path for a personal unverified app; the
"unsafe" wording is Google's generic warning for anything it hasn't audited.

Repeat for each account. MaxDrive creates a `MaxDrive` folder in each Drive
(with a `.index` subfolder for index backups) the first time it connects.

---

## Troubleshooting

**"Access blocked: MaxDrive has not completed the Google verification process"**
with no Advanced link - the account isn't in the test-user list _and_ the app
isn't published. Re-check step 6.

**Signed in with the wrong account** - MaxDrive rejects a reconnect that lands
on a different account than the one it expected. Sign out of the wrong account
at accounts.google.com, or use the account picker on the consent screen.

**`redirect_uri_mismatch`** - the OAuth client was created as "Web
application" instead of "Desktop app". Delete it and redo step 7.

**Tokens dying after a week** - the app slipped back to Testing status, or a
second OAuth client is in use. Check Publishing status on the consent screen.
