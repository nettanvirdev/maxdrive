/**
 * Initial per-account index scan.
 *
 * Parent links are resolved in a second pass rather than inline: files.list
 * returns pages in no particular hierarchical order, so a child routinely
 * arrives before its folder and a foreign key on parent_id would reject it.
 * Rows land with drive_parent_id only, then one UPDATE joins them up.
 */
const { get: db } = require("../db/database.cjs");
const { accounts, syncState, backupFolders } = require("../db/queries.cjs");
const drive = require("../drive/driveApi.cjs");
const { scope } = require("../logger.cjs");

const log = scope("scan");

let notify = () => {};
function setNotifier(fn) {
  notify = fn;
}

const running = new Set();

function nodeId(accountId, fileId) {
  return `g:${accountId}:${fileId}`;
}

/** Each account gets a synthetic root so its Drive appears as a browsable tree. */
function ensureAccountRoot(account) {
  const id = nodeId(account.id, "root");
  db()
    .prepare(
      `INSERT INTO nodes (id, parent_id, origin, account_id, drive_file_id,
                          name, is_folder, status, updated_at)
       VALUES (?, NULL, 'mirrored', ?, 'root', ?, 1, 'ok', ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    )
    .run(id, account.id, rootName(account), Date.now());
  return id;
}

/** Drive roots are the Gmail address; S3 roots the label the user gave. */
const rootName = (account) =>
  account.provider === "s3"
    ? account.display_name || account.config?.bucket || account.email
    : account.email;

const UPSERT = `
  INSERT INTO nodes (id, parent_id, origin, account_id, drive_file_id, drive_parent_id,
                     name, is_folder, mime, size, md5, is_google_doc, web_view_link,
                     created_at, modified_at, starred, trashed, status, updated_at)
  VALUES (@id, NULL, @origin, @account_id, @drive_file_id, @drive_parent_id,
          @name, @is_folder, @mime, @size, @md5, @is_google_doc, @web_view_link,
          @created_at, @modified_at, @starred, @trashed, 'ok', @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    drive_parent_id = excluded.drive_parent_id,
    name            = CASE WHEN nodes.seal_meta IS NULL THEN excluded.name ELSE nodes.name END,
    mime            = CASE WHEN nodes.seal_meta IS NULL THEN excluded.mime ELSE nodes.mime END,
    size            = excluded.size,
    md5             = excluded.md5,
    web_view_link   = excluded.web_view_link,
    modified_at     = excluded.modified_at,
    starred         = excluded.starred,
    trashed         = excluded.trashed,
    updated_at      = excluded.updated_at`;

/**
 * S3 variant: trash and star are MaxDrive-only flags there, so a re-list must
 * not clear them; and a multipart ETag carries no MD5, so keep the one we
 * hashed at upload while the object is unchanged.
 */
const UPSERT_S3 = `
  INSERT INTO nodes (id, parent_id, origin, account_id, drive_file_id, drive_parent_id,
                     name, is_folder, mime, size, md5, is_google_doc, web_view_link,
                     created_at, modified_at, starred, trashed, status, updated_at)
  VALUES (@id, NULL, @origin, @account_id, @drive_file_id, @drive_parent_id,
          @name, @is_folder, @mime, @size, @md5, @is_google_doc, @web_view_link,
          @created_at, @modified_at, @starred, @trashed, 'ok', @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    drive_parent_id = excluded.drive_parent_id,
    name            = CASE WHEN nodes.seal_meta IS NULL THEN excluded.name ELSE nodes.name END,
    size            = excluded.size,
    md5             = CASE WHEN excluded.modified_at = nodes.modified_at
                           THEN COALESCE(excluded.md5, nodes.md5)
                           ELSE excluded.md5 END,
    modified_at     = excluded.modified_at,
    status          = 'ok',
    updated_at      = excluded.updated_at`;

function toRow(accountId, file) {
  const isFolder = file.mimeType === drive.FOLDER_MIME;
  return {
    id: nodeId(accountId, file.id),
    origin: "mirrored",
    account_id: accountId,
    drive_file_id: file.id,
    drive_parent_id: file.parents?.[0] ?? null,
    name: file.name || "(untitled)",
    is_folder: isFolder ? 1 : 0,
    mime: file.mimeType || null,
    // Folders and Google-native files report no size; the column is NOT NULL.
    size: file.size == null ? 0 : Number(file.size),
    md5: file.md5Checksum || null,
    // Docs/Sheets/Slides have no downloadable bytes and mostly cost no quota.
    is_google_doc:
      !isFolder &&
      (file.mimeType || "").startsWith("application/vnd.google-apps.")
        ? 1
        : 0,
    web_view_link: file.webViewLink || null,
    created_at: file.createdTime ? Date.parse(file.createdTime) : null,
    modified_at: file.modifiedTime ? Date.parse(file.modifiedTime) : null,
    starred: file.starred ? 1 : 0,
    trashed: file.trashed ? 1 : 0,
    updated_at: Date.now(),
  };
}

/**
 * Second pass. Anything whose parent was not scanned (shared items, files in
 * another user's folder) falls back to the account root so it stays reachable
 * instead of disappearing from the tree.
 */
function linkParents(accountId) {
  const rootNode = nodeId(accountId, "root");
  const database = db();

  database
    .prepare(
      `UPDATE nodes SET parent_id = (
         SELECT p.id FROM nodes p
          WHERE p.account_id = nodes.account_id
            AND p.drive_file_id = nodes.drive_parent_id
       )
       WHERE account_id = ? AND origin = 'mirrored' AND id != ?`,
    )
    .run(accountId, rootNode);

  database
    .prepare(
      `UPDATE nodes SET parent_id = ?
        WHERE account_id = ? AND origin = 'mirrored' AND id != ? AND parent_id IS NULL`,
    )
    .run(rootNode, accountId, rootNode);

  // Top-level items point at the real root folder id, which has no node row.
  log.info(`linked parents for ${accountId}`);
}

/**
 * Drive folder ids whose contents are app plumbing, not user files: the
 * `.index` snapshot folder, the `.backup` root and every backup-set folder we
 * ever created, and the `.vault` root holding encrypted secure blobs. Checking
 * `parents[0]` against this set hides any depth of those trees because we
 * created (and recorded) every folder in them - the vault keeps its blobs flat
 * under `.vault`, so its root alone is sufficient.
 */
function hiddenFolderIds(account) {
  return new Set(
    [
      account.index_folder_id,
      account.backup_folder_id,
      account.vault_folder_id,
      ...backupFolders.driveIdsForAccount(account.id),
    ].filter(Boolean),
  );
}

/**
 * Belt-and-braces for the one case the hidden set can't cover: a rescan after
 * the local DB was lost while `.backup`/`.vault` trees still exist in Drive.
 * Walks drive_parent_id links from the hidden root and deletes everything
 * reachable, so plumbing never surfaces as user files.
 */
function pruneHiddenTree(account, folderName, knownId, remember) {
  const database = db();
  let rootId = knownId;
  if (!rootId) {
    const row = database
      .prepare(
        `SELECT drive_file_id FROM nodes
          WHERE account_id = ? AND origin = 'mirrored' AND is_folder = 1
            AND name = ? AND drive_parent_id = ?`,
      )
      .get(account.id, folderName, account.app_folder_id);
    rootId = row?.drive_file_id;
    if (rootId) remember(account.id, rootId);
  }
  if (!rootId) return;
  const { changes } = database
    .prepare(
      `WITH RECURSIVE doomed(fid) AS (
         VALUES (?)
         UNION
         SELECT n.drive_file_id FROM nodes n
           JOIN doomed d ON n.drive_parent_id = d.fid
          WHERE n.account_id = ? AND n.origin = 'mirrored'
            AND n.drive_file_id IS NOT NULL
       )
       DELETE FROM nodes
        WHERE account_id = ? AND origin = 'mirrored'
          AND drive_file_id IN (SELECT fid FROM doomed)`,
    )
    .run(rootId, account.id, account.id);
  if (changes)
    log.info(`pruned ${changes} ${folderName} rows for ${account.email}`);
}

/** Rows the scan didn't touch were deleted remotely while we were away. */
function pruneMissing(accountId, startedAt) {
  const rootNode = nodeId(accountId, "root");
  const { changes } = db()
    .prepare(
      `DELETE FROM nodes
        WHERE account_id = ? AND origin = 'mirrored' AND id != ? AND updated_at < ?`,
    )
    .run(accountId, rootNode, startedAt);
  if (changes) log.info(`pruned ${changes} stale rows for ${accountId}`);
}

/**
 * The scan checkpoint. It carries the page token plus the scan's original start
 * time and running count, because a resumed scan has to prune against the time
 * the scan *began*, not the time it was picked back up.
 */
function writeCursor(accountId, value) {
  db()
    .prepare("UPDATE sync_state SET scan_cursor = ? WHERE account_id = ?")
    .run(value ? JSON.stringify(value) : null, accountId);
}

function readCursor(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.cursor ? parsed : null;
  } catch {
    return null; // A malformed checkpoint just means a clean rescan.
  }
}

async function scanAccount(accountId) {
  if (running.has(accountId)) return { skipped: true };
  const account = accounts.byId(accountId);
  if (!account || account.auth_state !== "ok") return { skipped: true };

  running.add(accountId);
  let startedAt = Date.now();
  let total = 0;

  try {
    notify({ accountId, email: account.email, state: "scanning", count: 0 });

    // Resume a scan the app died in the middle of, rather than re-listing a
    // Drive of tens of thousands of files from page one.
    const state = syncState.get(accountId) || {};
    const saved = readCursor(state.scan_cursor);
    const resuming = Boolean(
      saved && state.page_token && !state.full_scan_done,
    );

    const s3 = account.provider === "s3";
    let pageToken = null;
    let cursor;
    if (s3) {
      // No change feed: every S3 scan is a fresh listing, pruned against its
      // own start, which is also how the poller picks up remote changes.
      syncState.setPageToken(accountId, null);
      writeCursor(accountId, null);
    } else if (resuming) {
      // Keep the ORIGINAL start time: pruneMissing deletes rows older than it,
      // so a fresh timestamp here would delete the pages already scanned.
      ({ cursor, startedAt, total } = saved);
      pageToken = state.page_token;
      log.info(`resuming scan of ${account.email} at ${total} files`);
    } else {
      // Take the change token BEFORE listing: anything that changes mid-scan is
      // then replayed by the first poll rather than being missed. Persist it
      // straight away so a crash mid-scan doesn't throw the token away too.
      pageToken = await drive.startPageToken(accountId);
      syncState.setPageToken(accountId, pageToken);
      writeCursor(accountId, null);
    }

    ensureAccountRoot(account);

    const insert = db().prepare(s3 ? UPSERT_S3 : UPSERT);
    const hidden = hiddenFolderIds(account);
    const insertRows = db().transaction((rows) => {
      for (const row of rows) insert.run(row);
    });
    const seen = new Set(); // S3 folder prefixes already written this scan

    do {
      let rows;
      if (s3) {
        const prefix = account.config?.prefix || "";
        const page = await s3Api().listPage(account, prefix, cursor);
        rows = s3Keys().objectsToRows(accountId, prefix, page.objects, {
          seen,
          now: Date.now(),
          nodeId,
        });
        total += page.objects.length;
        cursor = page.next;
      } else {
        const page = await drive.listFiles(accountId, { pageToken: cursor });
        // Skip both children of hidden folders and the hidden folders
        // themselves (.index / .backup sit under the visible MaxDrive folder).
        rows = (page.files || [])
          .filter((f) => !hidden.has(f.parents?.[0]) && !hidden.has(f.id))
          .map((f) => toRow(accountId, f));
        total += (page.files || []).length;
        cursor = page.nextPageToken;
      }
      insertRows(rows);
      // Checkpoint after every committed page, so a crash costs one page.
      writeCursor(accountId, cursor ? { cursor, startedAt, total } : null);
      notify({
        accountId,
        email: account.email,
        state: "scanning",
        count: total,
      });
    } while (cursor);

    linkParents(accountId);
    pruneMissing(accountId, startedAt);
    const scanned = accounts.byId(accountId);
    pruneHiddenTree(
      scanned,
      ".backup",
      scanned.backup_folder_id,
      accounts.setBackupFolder,
    );
    pruneHiddenTree(
      scanned,
      ".vault",
      scanned.vault_folder_id,
      accounts.setVaultFolder,
    );

    writeCursor(accountId, null);
    syncState.setPageToken(accountId, pageToken);
    db()
      .prepare(
        `UPDATE sync_state SET full_scan_done = 1, full_scan_at = ?, last_error = NULL
          WHERE account_id = ?`,
      )
      .run(Date.now(), accountId);

    log.info(
      `scanned ${account.email}: ${total} files in ${Date.now() - startedAt}ms`,
    );
    notify({ accountId, email: account.email, state: "done", count: total });
    return { count: total };
  } catch (err) {
    log.error(`scan failed for ${account.email}`, err);
    db()
      .prepare("UPDATE sync_state SET last_error = ? WHERE account_id = ?")
      .run(err.message, accountId);
    notify({
      accountId,
      email: account.email,
      state: "error",
      error: err.message,
    });
    throw err;
  } finally {
    running.delete(accountId);
  }
}

// Lazy: the S3 modules pull in the account queries this module is loaded by.
const s3Api = () => require("../s3/api.cjs");
const s3Keys = () => require("../s3/keys.cjs");

/** Sequential on purpose - parallel scans would race the per-project rate limit. */
async function scanAll({ onlyStale = false } = {}) {
  const results = [];
  for (const account of accounts.active()) {
    const state = syncState.get(account.id);
    if (onlyStale && state?.full_scan_done) continue;
    try {
      results.push({
        accountId: account.id,
        ...(await scanAccount(account.id)),
      });
    } catch (err) {
      results.push({ accountId: account.id, error: err.message });
    }
  }
  return results;
}

module.exports = {
  scanAccount,
  scanAll,
  setNotifier,
  nodeId,
  toRow,
  UPSERT,
  hiddenFolderIds,
};
