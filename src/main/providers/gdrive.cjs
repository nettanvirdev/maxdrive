/**
 * Google Drive behind the provider interface (see providers/index.cjs). A thin
 * adapter: the real work stays in drive/driveApi.cjs and drive/uploadCore.cjs.
 */
const drive = require("../drive/driveApi.cjs");
const core = require("../drive/uploadCore.cjs");
const { accessToken, request } = require("../auth/googleClient.cjs");

const caps = { share: true, thumbnails: true, remoteTrash: true, backups: true };

function appFolder(account) {
  if (!account.app_folder_id) {
    throw core.fail("That account has no MaxDrive folder yet.", "NO_APP_FOLDER", false);
  }
  return account.app_folder_id;
}

/**
 * Resumable upload into the account's MaxDrive folder. Resolves to Drive's file
 * metadata, or null when Drive finalised the file without returning it.
 */
async function upload(account, { localPath, size, name, mime, session, setSession, signal, onProgress }) {
  const parent = appFolder(account);
  const { file } = await core.uploadResumable({
    accountId: account.id,
    localPath,
    size,
    createSession: () =>
      core.openSession(account.id, {
        url: core.createFileSessionUrl(),
        size,
        mimeType: mime || null,
        body: { name: typeof name === "function" ? name() : name, parents: [parent] },
      }),
    session,
    onSessionInvalid: () => setSession(null, null),
    signal,
    onProgress,
    setSession,
  });
  return file;
}

async function openRange(account, fileId, range, signal) {
  const token = await accessToken(account.id);
  return fetch(`${drive.API}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}`, ...(range ? { Range: range } : {}) },
    signal,
  });
}

const remove = (account, fileId) =>
  drive.deleteIgnore404(account.id, `/files/${fileId}`, (status) => `Could not delete the file (${status}).`);

/** Drive renames in place, so the id never changes. */
async function rename(account, node, name) {
  await drive.patchFile(account.id, node.drive_file_id, { name });
  return node.drive_file_id;
}

const copy = (account, node, name) =>
  drive.copyFile(account.id, node.drive_file_id, { name, parentId: appFolder(account) });

const setTrashed = (account, fileId, trashed) => drive.patchFile(account.id, fileId, { trashed });
const setStarred = (account, fileId, starred) => drive.patchFile(account.id, fileId, { starred });

/** Tells Drive to forget a resumable session so its bytes aren't held. */
const abortUpload = (account, sessionUri) =>
  request(account.id, sessionUri, { method: "DELETE", retry: false });

module.exports = { caps, upload, openRange, remove, rename, copy, setTrashed, setStarred, abortUpload };
