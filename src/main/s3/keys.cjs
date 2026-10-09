/**
 * Pure key ↔ tree mapping for S3 accounts. S3 has no folders, only keys with
 * slashes, so the tree is synthesised: every key prefix becomes a folder row
 * whose drive_file_id is the prefix itself ("photos/2024/"). The account's
 * configured prefix is the root, so its direct children have no parent key.
 */
const { mimeOf } = require("../vault/mime.cjs");

/** Where MaxDrive puts the files it uploads, under the account prefix. */
const APP_DIR = "MaxDrive/";

/** Plumbing under MaxDrive/ that must never surface as user files. */
const HIDDEN = [/^MaxDrive\/\.maxdrive-probe$/, /^MaxDrive\/\.(index|backup|vault)\//];

/** "" or "a/b/" - no leading slash, always a trailing one when set. */
function normalizePrefix(prefix) {
  const p = String(prefix || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return p ? `${p}/` : "";
}

/** Folder key containing `key`, or null when that is the account root. */
function parentKey(prefix, key) {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const cut = trimmed.lastIndexOf("/");
  if (cut < 0) return null;
  const parent = trimmed.slice(0, cut + 1);
  return parent.length > prefix.length ? parent : null;
}

const baseName = (key) => {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "(untitled)";
};

/** A single-part ETag is the MD5; a multipart one ("…-12") is not. */
const md5FromEtag = (etag) => (/^[0-9a-f]{32}$/i.test(etag || "") ? etag.toLowerCase() : null);

/**
 * One listing page → index rows (same shape as scanner.toRow), including a
 * folder row the first time each prefix is seen. `seen` carries across pages.
 */
function objectsToRows(accountId, prefix, objects, { seen, now, nodeId }) {
  const rows = [];
  const folder = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      id: nodeId(accountId, key),
      origin: "mirrored",
      account_id: accountId,
      drive_file_id: key,
      drive_parent_id: parentKey(prefix, key),
      name: baseName(key),
      is_folder: 1,
      mime: null,
      size: 0,
      md5: null,
      is_google_doc: 0,
      web_view_link: null,
      created_at: null,
      modified_at: null,
      starred: 0,
      trashed: 0,
      updated_at: now,
    });
  };

  for (const o of objects) {
    if (!o.key?.startsWith(prefix)) continue;
    const rel = o.key.slice(prefix.length);
    if (!rel || HIDDEN.some((re) => re.test(rel))) continue;

    // Every ancestor prefix is a folder, even when no marker object exists.
    const segments = rel.split("/");
    for (let i = 1; i < segments.length; i++) {
      folder(prefix + segments.slice(0, i).join("/") + "/");
    }
    if (rel.endsWith("/")) continue; // a "folder marker" object

    const name = baseName(o.key);
    rows.push({
      id: nodeId(accountId, o.key),
      origin: "mirrored",
      account_id: accountId,
      drive_file_id: o.key,
      drive_parent_id: parentKey(prefix, o.key),
      name,
      is_folder: 0,
      mime: mimeOf(name),
      size: o.size || 0,
      md5: md5FromEtag(o.etag),
      is_google_doc: 0,
      web_view_link: null,
      created_at: o.lastModified,
      modified_at: o.lastModified,
      starred: 0,
      trashed: 0,
      updated_at: now,
    });
  }
  return rows;
}

/** The sibling key `name` would have next to `key` (for renames). */
const siblingKey = (key, name) => `${key.slice(0, key.lastIndexOf("/") + 1)}${name}`;

module.exports = {
  APP_DIR,
  normalizePrefix,
  parentKey,
  baseName,
  md5FromEtag,
  objectsToRows,
  siblingKey,
};
