/**
 * Connect / reconnect / disconnect and quota refresh.
 *
 * Drive identity is Google's `permissionId`, not the email address: emails can
 * be renamed, and a reconnect must be able to prove it landed on the same
 * Drive. S3 identity is a hash of endpoint + region + bucket + prefix, so
 * adding the same bucket twice refreshes it instead of duplicating it.
 */
const crypto = require("node:crypto");
const { accounts, syncState, nodes } = require("../db/queries.cjs");
const { get: db } = require("../db/database.cjs");
const tokenStore = require("./tokenStore.cjs");
const oauth = require("./oauthFlow.cjs");
const drive = require("../drive/driveApi.cjs");
const s3 = require("../s3/api.cjs");
const { normalizePrefix, APP_DIR } = require("../s3/keys.cjs");
const { scope } = require("../logger.cjs");

const log = scope("accounts");

let notify = () => {};
function setNotifier(fn) {
  notify = fn;
}

/** 15 min is well inside Drive's tolerance and keeps the dashboard honest. */
const QUOTA_TTL_MS = 15 * 60_000;

/**
 * The renderer's CSP only allows img-src 'self' data: blob:, so Google's
 * lh3.googleusercontent.com photo URL renders as a broken image there. Fetch
 * the bytes here and store a data: URI instead - avatars are ~2 KB at s64.
 */
async function fetchAvatar(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 256 * 1024) return null;
    const type = res.headers.get("content-type") || "image/jpeg";
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null; // offline etc. - the initial fallback covers it
  }
}

async function connect({ expectAccountId, loginHint } = {}) {
  const tokens = await oauth.authorize({ loginHint });

  // Identify with the raw token - there is no account row to look up yet.
  const { user, quota } = await drive.about(null, tokens.access_token);
  const id = user.permissionId;
  if (!id) throw new Error("Google did not return an account identity.");

  if (expectAccountId && id !== expectAccountId) {
    await oauth.revoke(tokens.access_token);
    const err = new Error(
      `Wrong account chosen. Expected ${loginHint || expectAccountId}, got ${user.emailAddress}.`,
    );
    err.code = "WRONG_ACCOUNT";
    throw err;
  }

  const existing = accounts.byId(id);
  if (existing && !expectAccountId) {
    // Re-running "Add account" on an already-connected Drive should refresh it,
    // not create a duplicate or silently do nothing.
    log.info(`${user.emailAddress} already connected - refreshing credentials`);
  }

  tokenStore.set(id, tokens);

  const folders = await drive.ensureAppFolders(id, tokens.access_token);
  const pageToken = await drive.startPageToken(id, tokens.access_token);

  accounts.upsert({
    id,
    email: user.emailAddress,
    display_name: user.displayName || null,
    photo_url: await fetchAvatar(user.photoLink),
    app_folder_id: folders.appFolderId,
    index_folder_id: folders.indexFolderId,
    backup_folder_id: folders.backupFolderId,
    vault_folder_id: folders.vaultFolderId,
    quota_limit: quota.limit,
    quota_usage: quota.usage,
    quota_usage_drive: quota.usageInDrive,
    quota_refreshed_at: Date.now(),
    auth_state: "ok",
    sort_order: existing?.sort_order ?? accounts.list().length,
  });
  syncState.setPageToken(id, pageToken);

  // Reconnecting is what makes a kept-but-disconnected account whole again.
  // Without this the rows stay flagged forever and the promise in disconnect's
  // "reconnecting restores the view" is never actually kept.
  const restored = db()
    .prepare(
      "UPDATE nodes SET status = 'ok' WHERE account_id = ? AND status = 'orphaned'",
    )
    .run(id);
  if (restored.changes)
    log.info(`restored ${restored.changes} file(s) from ${user.emailAddress}`);

  log.info(`connected ${user.emailAddress} (${id})`);
  notify();

  // Indexing runs in the background so the account appears immediately and the
  // tree fills in as pages arrive, rather than blocking on a 30k-file Drive.
  require("../sync/scanner.cjs")
    .scanAccount(id)
    .catch((err) => log.warn(`initial scan failed: ${err.message}`));

  return accounts.byId(id);
}

/** Reconnect pins the flow to one Gmail and rejects a different Drive. */
async function reauth({ accountId }) {
  const account = accounts.byId(accountId);
  if (!account) throw new Error("Unknown account.");
  if (account.provider === "s3") {
    throw invalid("S3 storage reconnects by editing it with new access keys.");
  }
  return connect({ expectAccountId: accountId, loginHint: account.email });
}

/**
 * `purge` decides what happens to the index rows. Default keeps them: the files
 * still physically exist in that Drive, and reconnecting restores the view.
 */
async function disconnect({ accountId, purge = false }) {
  const account = accounts.byId(accountId);
  const tokens = tokenStore.get(accountId);
  if (tokens?.refresh_token) await oauth.revoke(tokens.refresh_token);
  tokenStore.remove(accountId);

  if (purge) {
    db().prepare("DELETE FROM nodes WHERE account_id = ?").run(accountId);
    syncState.remove(accountId);
    accounts.remove(accountId);
  } else {
    db()
      .prepare("UPDATE nodes SET status = 'orphaned' WHERE account_id = ?")
      .run(accountId);
    accounts.setAuthState(accountId, "disconnected");
  }

  log.info(`disconnected ${account?.email || accountId} (purge=${purge})`);
  notify();
  return accounts.list();
}

/** How much would be lost on a purge - shown in the confirm dialog. */
function disconnectImpact(accountId) {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes
         FROM nodes WHERE account_id = ? AND is_folder = 0`,
    )
    .get(accountId);
  return { files: row.files, bytes: row.bytes };
}

async function refreshQuota(accountId, { force = false } = {}) {
  const account = accounts.byId(accountId);
  if (!account || account.auth_state !== "ok") return account;
  if (account.provider === "s3") {
    // No quota API: the limit is the user's, the usage is what we've indexed.
    accounts.setQuota(accountId, {
      limit: account.quota_limit,
      usage: indexedBytes(accountId),
      usageInDrive: null,
    });
    return accounts.byId(accountId);
  }
  if (!force && Date.now() - (account.quota_refreshed_at || 0) < QUOTA_TTL_MS) {
    return account;
  }
  try {
    const { user, quota } = await drive.about(accountId);
    accounts.setQuota(accountId, quota);
    // Repair rows that still hold a raw Google photo URL (blocked by the
    // renderer CSP) by converting them to a stored data: URI.
    if (!account.photo_url?.startsWith("data:") && user.photoLink) {
      const dataUri = await fetchAvatar(user.photoLink);
      if (dataUri) {
        db()
          .prepare(
            "UPDATE accounts SET photo_url = ?, display_name = COALESCE(?, display_name) WHERE id = ?",
          )
          .run(dataUri, user.displayName || null, accountId);
      }
    }
  } catch (err) {
    // A stale gauge beats an error toast; the auth state is already flagged
    // by googleClient if this was a REAUTH_REQUIRED.
    log.warn(`quota refresh failed for ${account.email}: ${err.message}`);
  }
  return accounts.byId(accountId);
}

async function refreshAllQuotas(options) {
  for (const account of accounts.active()) {
    await refreshQuota(account.id, options);
  }
  notify();
  return accounts.list();
}

/* ------------------------------------------------------------------- S3 */

const GiB = 1024 ** 3;

function invalid(message, code = "INVALID_INPUT") {
  const err = new Error(message);
  err.code = code;
  err.retryable = false;
  return err;
}

/** Everything the bucket holds that we know of, trash included (it's still stored). */
function indexedBytes(accountId) {
  return db()
    .prepare(
      "SELECT COALESCE(SUM(size), 0) AS bytes FROM nodes WHERE account_id = ? AND is_folder = 0",
    )
    .get(accountId).bytes;
}

/** Validates the connect form into the stored, non-secret config. */
function s3Config({ endpoint, region, bucket, prefix, pathStyle }) {
  const cleanBucket = String(bucket || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,254}$/i.test(cleanBucket)) {
    throw invalid("Enter a valid bucket name.");
  }
  let cleanEndpoint = String(endpoint || "").trim().replace(/\/+$/, "");
  if (cleanEndpoint) {
    if (!/^https?:\/\//i.test(cleanEndpoint)) cleanEndpoint = `https://${cleanEndpoint}`;
    try {
      new URL(cleanEndpoint);
    } catch {
      throw invalid("The endpoint is not a valid URL.");
    }
  }
  return {
    endpoint: cleanEndpoint,
    region: String(region || "").trim() || "us-east-1",
    bucket: cleanBucket,
    prefix: normalizePrefix(prefix),
    pathStyle: pathStyle ?? Boolean(cleanEndpoint),
  };
}

function s3Keys({ accessKeyId, secretAccessKey }) {
  const keys = {
    accessKeyId: String(accessKeyId || "").trim(),
    secretAccessKey: String(secretAccessKey || "").trim(),
  };
  if (!keys.accessKeyId || !keys.secretAccessKey) {
    throw invalid("Enter both the access key ID and the secret access key.");
  }
  return keys;
}

function limitBytes(limitGb) {
  const gb = Number(limitGb);
  if (!Number.isFinite(gb) || gb <= 0) {
    throw invalid("Set a storage limit above 0 GB.");
  }
  return Math.round(gb * GiB);
}

const hostOf = (config) =>
  config.endpoint ? new URL(config.endpoint).host : `s3.${config.region}.amazonaws.com`;

/**
 * Proves the keys can list AND write before anything is saved: a read-only key
 * would otherwise connect fine and fail on the first upload.
 */
async function probeS3(candidate) {
  const prefix = candidate.config.prefix;
  try {
    await s3.listPage(candidate, prefix, null);
  } catch (err) {
    if (err.code === "S3_ACCESS_DENIED") throw invalid(err.message, "S3_AUTH");
    throw invalid(err.message, err.code?.startsWith("S3_") ? err.code : "S3_UNREACHABLE");
  }
  const probeKey = `${prefix}${APP_DIR}.maxdrive-probe`;
  try {
    await s3.putObject(candidate, probeKey, Buffer.from("maxdrive"), { contentType: "text/plain" });
    await s3.deleteObject(candidate, probeKey);
  } catch (err) {
    throw invalid(`These keys can read the bucket but not write to it (${err.message}).`, "S3_NO_WRITE");
  }
}

async function connectS3(input = {}) {
  const config = s3Config(input);
  const credentials = s3Keys(input);
  const quotaLimit = limitBytes(input.limitGb);
  const id = `s3_${crypto
    .createHash("sha256")
    .update(`${config.endpoint}|${config.region}|${config.bucket}|${config.prefix}`)
    .digest("hex")
    .slice(0, 16)}`;

  await probeS3({ id, config, credentials });

  const existing = accounts.byId(id);
  tokenStore.set(id, credentials);
  accounts.upsert({
    id,
    provider: "s3",
    config,
    email: `${config.bucket}@${hostOf(config)}${config.prefix ? `/${config.prefix.slice(0, -1)}` : ""}`,
    display_name: String(input.label || "").trim() || null,
    quota_limit: quotaLimit,
    quota_usage: existing ? indexedBytes(id) : 0,
    quota_refreshed_at: Date.now(),
    auth_state: "ok",
    sort_order: existing?.sort_order ?? accounts.list().length,
  });
  syncState.setPageToken(id, null);
  db()
    .prepare("UPDATE nodes SET status = 'ok' WHERE account_id = ? AND status = 'orphaned'")
    .run(id);

  log.info(`connected S3 bucket ${config.bucket} (${id})`);
  notify();
  require("../sync/scanner.cjs")
    .scanAccount(id)
    .catch((err) => log.warn(`initial S3 scan failed: ${err.message}`));
  return accounts.byId(id);
}

/**
 * Label, limit and keys can change; where the bucket is cannot (that would be
 * a different account - add it instead). Blank keys keep the saved ones.
 */
async function updateS3({ accountId, label, limitGb, accessKeyId, secretAccessKey }) {
  const account = accounts.byId(accountId);
  if (account?.provider !== "s3") throw invalid("That is not an S3 storage account.");

  let reconnected = false;
  if (accessKeyId || secretAccessKey) {
    const credentials = s3Keys({ accessKeyId, secretAccessKey });
    await probeS3({ ...account, credentials });
    tokenStore.set(accountId, credentials);
    reconnected = account.auth_state !== "ok";
  }

  db()
    .prepare("UPDATE accounts SET display_name = ?, quota_limit = ?, auth_state = ? WHERE id = ?")
    .run(
      label === undefined ? account.display_name : String(label || "").trim() || null,
      limitGb === undefined ? account.quota_limit : limitBytes(limitGb),
      reconnected ? "ok" : account.auth_state,
      accountId,
    );
  if (reconnected) {
    db()
      .prepare("UPDATE nodes SET status = 'ok' WHERE account_id = ? AND status = 'orphaned'")
      .run(accountId);
  }

  const updated = await refreshQuota(accountId);
  notify();
  if (reconnected) {
    require("../sync/scanner.cjs")
      .scanAccount(accountId)
      .catch((err) => log.warn(`S3 rescan failed: ${err.message}`));
  }
  return updated;
}

/**
 * Accounts connected before the backup feature existed have no `.backup`
 * folder yet. Create it (or any hidden `MaxDrive/<name>` folder whose id is
 * cached in accounts.<column>) on first use rather than forcing a reconnect.
 */
async function ensureSubfolder(accountId, name, column) {
  const account = accounts.byId(accountId);
  if (!account) throw new Error("Unknown account.");
  if (account[column]) return account[column];
  const folder = await drive.ensureFolder(
    accountId,
    name,
    account.app_folder_id,
  );
  SUBFOLDER_SETTERS[column](accountId, folder.id);
  return folder.id;
}

const SUBFOLDER_SETTERS = {
  backup_folder_id: accounts.setBackupFolder,
  vault_folder_id: accounts.setVaultFolder,
};

/** Same lazy creation for `.vault` on accounts that predate Secure Storage. */
const ensureVaultFolder = (accountId) =>
  ensureSubfolder(accountId, ".vault", "vault_folder_id");

/**
 * Boot check: a DPAPI blob that no longer decrypts (a fresh Windows install)
 * leaves rows with no tokens. Flag them so the UI shows Reconnect instead of
 * failing on the first API call.
 */
function reconcileTokensOnStartup() {
  const stored = new Set(tokenStore.ids());
  for (const account of accounts.list()) {
    if (account.auth_state === "ok" && !stored.has(account.id)) {
      accounts.setAuthState(account.id, "reauth_required");
      log.warn(`${account.email} has no stored token - marked reauth_required`);
    }
  }
}

module.exports = {
  connect,
  connectS3,
  updateS3,
  reauth,
  disconnect,
  disconnectImpact,
  refreshQuota,
  refreshAllQuotas,
  ensureSubfolder,
  ensureVaultFolder,
  reconcileTokensOnStartup,
  setNotifier,
};
