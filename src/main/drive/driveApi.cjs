/**
 * Thin Drive v3 REST client. Only the endpoints MaxDrive actually uses, with
 * explicit `fields` projections everywhere - Drive charges by call, and the
 * default projection returns far more than we ever read.
 */
const { json, request } = require("../auth/googleClient.cjs");

const API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** The app folder created in every connected account. */
const APP_FOLDER = "MaxDrive";
const INDEX_FOLDER = ".index";
const BACKUP_FOLDER = ".backup";
const VAULT_FOLDER = ".vault";

function url(pathname, params) {
  const u = new URL(API + pathname);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null)
      u.searchParams.set(key, String(value));
  }
  return u.toString();
}

/**
 * Identity plus quota. `storageQuota.usage` is the number that matters: the
 * 15 GB pool is shared with Gmail and Photos, so `usageInDrive` would let the
 * allocator promise space that does not exist.
 */
async function about(accountId, token) {
  const data = await json(
    accountId,
    url("/about", {
      fields:
        "user(permissionId,emailAddress,displayName,photoLink),storageQuota",
    }),
    token ? { token } : undefined,
  );
  const q = data.storageQuota || {};
  return {
    user: data.user || {},
    quota: {
      // Unlimited accounts omit `limit` entirely.
      limit: q.limit == null ? null : Number(q.limit),
      usage: Number(q.usage || 0),
      usageInDrive: Number(q.usageInDrive || 0),
    },
  };
}

async function findFolder(accountId, name, parent, token) {
  const q = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    `mimeType = '${FOLDER_MIME}'`,
    "trashed = false",
    `'${parent}' in parents`,
  ].join(" and ");
  const data = await json(
    accountId,
    url("/files", {
      q,
      fields: "files(id,name)",
      pageSize: 1,
      spaces: "drive",
    }),
    token ? { token } : undefined,
  );
  return data.files?.[0] || null;
}

async function createFolder(accountId, name, parent, token) {
  return json(accountId, url("/files", { fields: "id,name" }), {
    ...(token ? { token } : {}),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
  });
}

async function ensureFolder(accountId, name, parent, token) {
  return (
    (await findFolder(accountId, name, parent, token)) ||
    (await createFolder(accountId, name, parent, token))
  );
}

/**
 * MaxDrive/ for payloads, MaxDrive/.index/ for index snapshots,
 * MaxDrive/.backup/ for local-folder backup sets, and MaxDrive/.vault/ for
 * the encrypted secure store. All three dot-folders are kept out of the
 * unified index (see scanner.hiddenFolderIds).
 */
async function ensureAppFolders(accountId, token) {
  const appFolder = await ensureFolder(accountId, APP_FOLDER, "root", token);
  const indexFolder = await ensureFolder(
    accountId,
    INDEX_FOLDER,
    appFolder.id,
    token,
  );
  const backupFolder = await ensureFolder(
    accountId,
    BACKUP_FOLDER,
    appFolder.id,
    token,
  );
  const vaultFolder = await ensureFolder(
    accountId,
    VAULT_FOLDER,
    appFolder.id,
    token,
  );
  return {
    appFolderId: appFolder.id,
    indexFolderId: indexFolder.id,
    backupFolderId: backupFolder.id,
    vaultFolderId: vaultFolder.id,
  };
}

// Everything the index needs and nothing it doesn't - the default projection
// returns roughly ten times this much per file.
const FILE_FIELDS =
  "nextPageToken,files(id,name,mimeType,size,md5Checksum,parents,createdTime," +
  "modifiedTime,starred,trashed,webViewLink,shortcutDetails)";

async function listFiles(accountId, { pageToken, pageSize = 1000 } = {}) {
  return json(
    accountId,
    url("/files", {
      q: "trashed = false",
      fields: FILE_FIELDS,
      pageSize,
      pageToken,
      spaces: "drive",
      // Personal accounts only, but this keeps shared-drive items out of a
      // per-account tree where they would have no valid parent.
      supportsAllDrives: false,
    }),
  );
}

/** Multipart upload for small payloads (index snapshots, manifests). */
async function uploadSmall(
  accountId,
  { name, parentId, buffer, mimeType = "application/octet-stream" },
) {
  const boundary = `maxdrive-${Date.now()}`;
  const meta = JSON.stringify({ name, parents: [parentId] });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await request(
    accountId,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  if (!res.ok) throw new Error(`upload of ${name} failed (${res.status})`);
  return res.json();
}

async function listChildren(
  accountId,
  folderId,
  extraFields = "",
  { trashed = false } = {},
) {
  const data = await json(
    accountId,
    url("/files", {
      q: `'${folderId}' in parents and trashed = ${trashed}`,
      fields: `files(id,name,size,createdTime${extraFields ? `,${extraFields}` : ""})`,
      pageSize: 1000,
    }),
  );
  return data.files || [];
}

/**
 * Generic metadata PATCH: rename, reparent, trash/untrash, star. addParents and
 * removeParents ride as query params (Drive's API shape); everything else is
 * the request body.
 */
async function patchFile(
  accountId,
  fileId,
  { name, addParents, removeParents, trashed, starred } = {},
) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (trashed !== undefined) body.trashed = trashed;
  if (starred !== undefined) body.starred = starred;
  return json(
    accountId,
    url(`/files/${fileId}`, {
      fields: "id,name,trashed,parents",
      ...(addParents ? { addParents } : {}),
      ...(removeParents ? { removeParents } : {}),
    }),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

/**
 * DELETE where 404 means someone beat us to it - the desired end state. Any
 * other failure throws `message(status)`.
 */
async function deleteIgnore404(accountId, pathname, message) {
  const res = await request(accountId, url(pathname), { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(message(res.status));
}

const deleteFile = (accountId, fileId) =>
  deleteIgnore404(accountId, `/files/${fileId}`, (s) => `delete failed (${s})`);

async function downloadBuffer(accountId, fileId) {
  const res = await request(
    accountId,
    url(`/files/${fileId}`, { alt: "media" }),
  );
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Server-side copy. Drive duplicates the bytes itself, so a copy costs one
 * request rather than a download and a re-upload - but the new file does
 * consume the account's quota, and Drive cannot copy across accounts.
 */
const COPY_FIELDS =
  "id,name,size,md5Checksum,mimeType,webViewLink,createdTime,modifiedTime";

async function copyFile(accountId, fileId, { name, parentId }) {
  return json(
    accountId,
    url(`/files/${fileId}/copy`, { fields: COPY_FIELDS }),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    },
  );
}

/** Persisted now so the first poll replays anything that changed during the scan. */
async function startPageToken(accountId, token) {
  const data = await json(
    accountId,
    url("/changes/startPageToken", { fields: "startPageToken" }),
    token ? { token } : undefined,
  );
  return data.startPageToken;
}

module.exports = {
  about,
  ensureFolder,
  ensureAppFolders,
  startPageToken,
  listFiles,
  uploadSmall,
  listChildren,
  patchFile,
  copyFile,
  deleteFile,
  deleteIgnore404,
  downloadBuffer,
  API,
  FOLDER_MIME,
};
