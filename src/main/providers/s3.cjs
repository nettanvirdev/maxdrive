/**
 * S3-compatible storage behind the provider interface (see providers/index.cjs).
 *
 * Differences from Drive that callers can rely on:
 * - identity is the object key, so `rename` returns a NEW id (copy + delete);
 * - trash and star are MaxDrive-only flags (S3 has neither);
 * - uploads are multipart with 8 MiB+ parts; the transfer's session_uri holds
 *   {key, uploadId, partSize} so a restart resumes via ListParts.
 */
const fs = require("node:fs");
const crypto = require("node:crypto");
const api = require("../s3/api.cjs");
const { APP_DIR, siblingKey } = require("../s3/keys.cjs");
const { hashFile, fail } = require("../drive/uploadCore.cjs");
const { mimeOf } = require("../vault/mime.cjs");
const { get: db } = require("../db/database.cjs");

const caps = { share: false, thumbnails: false, remoteTrash: false, backups: false };

const MIB = 1024 * 1024;
const MIN_PART = 8 * MIB;
const MAX_PARTS = 9000; // S3 allows 10,000; leave headroom
const SESSION_TTL_MS = 6 * 24 * 60 * 60 * 1000;

/** Parts grow with the file so even 1 TB stays under the part limit. */
const partSizeFor = (size) => Math.max(MIN_PART, Math.ceil(size / MAX_PARTS / MIB) * MIB);

const prefixOf = (account) => account.config?.prefix || "";

/** Index first (free), then a HEAD to be sure: never overwrite someone's object. */
async function freeKey(account, dir, name) {
  const indexed = db().prepare("SELECT 1 FROM nodes WHERE account_id = ? AND drive_file_id = ?");
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 1000; n++) {
    const key = `${dir}${n === 1 ? name : `${stem} (${n})${ext}`}`;
    if (indexed.get(account.id, key)) continue;
    if (!(await api.head(account, key))) return key;
  }
  return `${dir}${stem} (${Date.now()})${ext}`;
}

/** Drive-shaped metadata so nodes.upsertManaged works unchanged. */
async function describe(account, key, md5, contentType) {
  const meta = await api.head(account, key);
  const at = new Date(meta?.lastModified || Date.now()).toISOString();
  return {
    id: key,
    name: key.slice(key.lastIndexOf("/") + 1),
    size: meta?.size,
    md5Checksum: md5,
    mimeType: contentType,
    createdTime: at,
    modifiedTime: at,
  };
}

function readSession(uri) {
  try {
    const s = uri ? JSON.parse(uri) : null;
    return s?.uploadId && s?.key ? s : null;
  } catch {
    return null;
  }
}

async function upload(account, { localPath, size, name, mime, session, setSession, signal, onProgress }) {
  const fileName = typeof name === "function" ? name() : name;
  const contentType = mime || mimeOf(fileName);
  let state = readSession(session?.uri);

  if (!state) {
    const key = await freeKey(account, `${prefixOf(account)}${APP_DIR}`, fileName);
    if (size <= MIN_PART) {
      const buffer = fs.readFileSync(localPath);
      await api.putObject(account, key, buffer, { contentType, signal });
      onProgress(size);
      const md5 = crypto.createHash("md5").update(buffer).digest("hex");
      return describe(account, key, md5, contentType);
    }
    const uploadId = await api.createMultipart(account, key, contentType, signal);
    state = { key, uploadId, partSize: partSizeFor(size) };
    setSession(JSON.stringify(state), Date.now() + SESSION_TTL_MS);
  }

  let stored;
  try {
    stored = await api.listParts(account, state.key, state.uploadId, signal);
  } catch (err) {
    if (err.code === "NoSuchUpload") {
      setSession(null, null);
      throw fail("The upload session expired; starting over.", "SESSION_GONE");
    }
    throw err;
  }

  const parts = new Map(stored.map((p) => [p.partNumber, p.etag]));
  const count = Math.ceil(size / state.partSize);
  const lengthOf = (n) => Math.min(state.partSize, size - (n - 1) * state.partSize);
  let sent = 0;
  for (const n of parts.keys()) sent += lengthOf(n);
  onProgress(sent);

  const fd = fs.openSync(localPath, "r");
  try {
    for (let n = 1; n <= count; n++) {
      if (parts.has(n)) continue;
      const buffer = Buffer.alloc(lengthOf(n));
      fs.readSync(fd, buffer, 0, buffer.length, (n - 1) * state.partSize);
      parts.set(n, await api.uploadPart(account, state.key, state.uploadId, n, buffer, signal));
      sent += buffer.length;
      onProgress(sent);
    }
  } finally {
    fs.closeSync(fd);
  }

  const ordered = [...parts].sort(([a], [b]) => a - b).map(([partNumber, etag]) => ({ partNumber, etag }));
  await api.completeMultipart(account, state.key, state.uploadId, ordered, signal);
  // A multipart ETag is not an MD5, so hash locally for the index.
  return describe(account, state.key, await hashFile(localPath), contentType);
}

const openRange = (account, key, range, signal) => api.getRange(account, key, range, signal);

const remove = (account, key) => api.deleteObject(account, key);

/**
 * S3 cannot rename: copy to the new key, then delete the old one. Folders are
 * key prefixes - renaming one would rewrite every object below it, so v1
 * refuses rather than half-doing it.
 */
async function rename(account, node, name) {
  if (node.is_folder) {
    throw fail("Folders in an S3 bucket can't be renamed yet.", "S3_FOLDER_RENAME", false);
  }
  const target = siblingKey(node.drive_file_id, name);
  if (target === node.drive_file_id) return target;
  if (await api.head(account, target)) {
    throw fail(`"${name}" already exists in that folder.`, "NAME_TAKEN", false);
  }
  await api.copyObject(account, node.drive_file_id, target);
  await api.deleteObject(account, node.drive_file_id);
  return target;
}

async function copy(account, node, name) {
  const key = await freeKey(account, `${prefixOf(account)}${APP_DIR}`, name);
  await api.copyObject(account, node.drive_file_id, key);
  return describe(account, key, node.md5, node.mime);
}

// S3 has no trash or stars; MaxDrive keeps both as index-only flags.
const setTrashed = async () => {};
const setStarred = async () => {};

async function abortUpload(account, sessionUri) {
  const state = readSession(sessionUri);
  if (state) await api.abortMultipart(account, state.key, state.uploadId);
}

module.exports = {
  caps,
  upload,
  openRange,
  remove,
  rename,
  copy,
  setTrashed,
  setStarred,
  abortUpload,
  partSizeFor,
};
