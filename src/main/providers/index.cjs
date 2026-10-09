/**
 * Storage providers. An account's `provider` column picks the module; every
 * module exports the same surface, so file operations, transfers and media
 * never branch on the backend themselves:
 *
 *   caps                                   {share, thumbnails, remoteTrash, backups}
 *   upload(account, {localPath, size, name, mime, session, setSession, signal, onProgress})
 *                                          → Drive-shaped file metadata (id = file id / key)
 *   openRange(account, fileId, range, signal) → fetch Response (200/206/416 untouched)
 *   remove(account, fileId)                missing counts as success
 *   rename(account, node, name)            → the file id afterwards (may change)
 *   copy(account, node, name)              → metadata of the copy, in MaxDrive/
 *   setTrashed / setStarred(account, fileId, flag)
 *   abortUpload(account, sessionUri)
 *
 * Adding a provider = one module here + its connect flow in accountService.
 */
const { accounts } = require("../db/queries.cjs");

const MODULES = {
  gdrive: () => require("./gdrive.cjs"),
  s3: () => require("./s3.cjs"),
};

/** The provider module for an account row or id. Unknown ids read as Drive. */
function providerFor(accountOrId) {
  const account = typeof accountOrId === "string" ? accounts.byId(accountOrId) : accountOrId;
  return (MODULES[account?.provider] || MODULES.gdrive)();
}

const isS3 = (account) => account?.provider === "s3";

module.exports = { providerFor, isS3 };
