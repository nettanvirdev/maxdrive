/**
 * Prepared-statement layer. Statements are built lazily on first use so this
 * module can be required before the database is open.
 */
const { get, MANAGED_ROOT_ID } = require("./database.cjs");

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = get().prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

/**
 * UPDATE only the `allowed` columns present in `patch` (no-op when none are);
 * `touch` also bumps updated_at.
 */
function patchRow(table, keyCol, allowed, id, patch, touch = false) {
  const cols = allowed.filter((c) => c in patch);
  if (!cols.length) return;
  const sets = cols.map((c) => `${c} = @${c}`);
  if (touch) sets.push("updated_at = @updated_at");
  stmt(
    `UPDATE ${table} SET ${sets.join(", ")} WHERE ${keyCol} = @${keyCol}`,
  ).run({
    ...patch,
    [keyCol]: id,
    ...(touch ? { updated_at: Date.now() } : {}),
  });
}

/** Called after a restore swaps the underlying handle; old statements are dead. */
function resetStatementCache() {
  cache.clear();
}

/* ---------------------------------------------------------------- settings */

const settings = {
  get(key, fallback = null) {
    const row = stmt("SELECT value FROM settings WHERE key = ?").get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    stmt(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, JSON.stringify(value));
  },
  all() {
    const rows = stmt("SELECT key, value FROM settings").all();
    const out = {};
    for (const { key, value } of rows) {
      try {
        out[key] = JSON.parse(value);
      } catch {
        /* skip unparseable rows rather than failing the whole read */
      }
    }
    return out;
  },
};

/* ---------------------------------------------------------------- accounts */

/** `config` is stored as JSON text; every reader gets the parsed object. */
function withConfig(row) {
  if (!row) return row;
  let config = null;
  try {
    config = row.config ? JSON.parse(row.config) : null;
  } catch {
    /* a corrupt config reads as none; the account then fails visibly on use */
  }
  return { ...row, config };
}

const accounts = {
  list() {
    return stmt("SELECT * FROM accounts ORDER BY sort_order, added_at")
      .all()
      .map(withConfig);
  },
  byId(id) {
    return withConfig(stmt("SELECT * FROM accounts WHERE id = ?").get(id));
  },
  active() {
    return stmt(
      "SELECT * FROM accounts WHERE auth_state = 'ok' ORDER BY sort_order, added_at",
    )
      .all()
      .map(withConfig);
  },
  upsert(a) {
    stmt(
      `INSERT INTO accounts
         (id, provider, config, email, display_name, photo_url, app_folder_id, index_folder_id,
          backup_folder_id, vault_folder_id,
          quota_limit, quota_usage, quota_usage_drive, quota_refreshed_at,
          auth_state, added_at, sort_order)
       VALUES (@id, @provider, @config, @email, @display_name, @photo_url, @app_folder_id, @index_folder_id,
               @backup_folder_id, @vault_folder_id,
               @quota_limit, @quota_usage, @quota_usage_drive, @quota_refreshed_at,
               @auth_state, @added_at, @sort_order)
       ON CONFLICT(id) DO UPDATE SET
         config            = excluded.config,
         email             = excluded.email,
         display_name      = excluded.display_name,
         photo_url         = excluded.photo_url,
         app_folder_id     = COALESCE(excluded.app_folder_id, accounts.app_folder_id),
         index_folder_id   = COALESCE(excluded.index_folder_id, accounts.index_folder_id),
         backup_folder_id  = COALESCE(excluded.backup_folder_id, accounts.backup_folder_id),
         vault_folder_id   = COALESCE(excluded.vault_folder_id, accounts.vault_folder_id),
         quota_limit       = excluded.quota_limit,
         quota_usage       = excluded.quota_usage,
         quota_usage_drive = excluded.quota_usage_drive,
         quota_refreshed_at= excluded.quota_refreshed_at,
         auth_state        = excluded.auth_state`,
    ).run({
      provider: "gdrive",
      display_name: null,
      photo_url: null,
      app_folder_id: null,
      index_folder_id: null,
      backup_folder_id: null,
      vault_folder_id: null,
      quota_limit: null,
      quota_usage: null,
      quota_usage_drive: null,
      quota_refreshed_at: null,
      auth_state: "ok",
      added_at: Date.now(),
      sort_order: 0,
      ...a,
      config: a.config ? JSON.stringify(a.config) : null,
    });
  },
  setAuthState(id, state) {
    stmt("UPDATE accounts SET auth_state = ? WHERE id = ?").run(state, id);
  },
  setBackupFolder(id, folderId) {
    stmt("UPDATE accounts SET backup_folder_id = ? WHERE id = ?").run(
      folderId,
      id,
    );
  },
  setVaultFolder(id, folderId) {
    stmt("UPDATE accounts SET vault_folder_id = ? WHERE id = ?").run(
      folderId,
      id,
    );
  },
  setQuota(id, { limit, usage, usageInDrive }) {
    stmt(
      `UPDATE accounts SET quota_limit = ?, quota_usage = ?,
              quota_usage_drive = ?, quota_refreshed_at = ? WHERE id = ?`,
    ).run(limit, usage, usageInDrive, Date.now(), id);
  },
  remove(id) {
    stmt("DELETE FROM accounts WHERE id = ?").run(id);
  },
};

/* -------------------------------------------------------------- sync state */

const syncState = {
  get(accountId) {
    return stmt("SELECT * FROM sync_state WHERE account_id = ?").get(accountId);
  },
  /** A reconnect must never keep the old page token - it may already be expired. */
  setPageToken(accountId, pageToken) {
    stmt(
      `INSERT INTO sync_state (account_id, page_token) VALUES (?, ?)
       ON CONFLICT(account_id) DO UPDATE SET page_token = excluded.page_token`,
    ).run(accountId, pageToken);
  },
  remove(accountId) {
    stmt("DELETE FROM sync_state WHERE account_id = ?").run(accountId);
  },
};

/* ------------------------------------------------------------------- nodes */

const SORTS = {
  name: "n.is_folder DESC, n.name COLLATE NOCASE",
  modified: "n.is_folder DESC, n.modified_at DESC",
  size: "n.is_folder DESC, n.size DESC",
};

/**
 * Every listing carries what the UI's columns need: the owning account (email
 * + avatar), the parent folder's name for the Location column, and the most
 * recent activity entry for the Reason column. One projection, one shape.
 */
const NODE_SELECT = `
  SELECT n.*,
         a.email      AS account_email,
         a.photo_url  AS account_photo,
         a.provider   AS account_provider,
         p.name       AS parent_name,
         (SELECT kind || '\t' || at FROM activity
           WHERE node_id = n.id ORDER BY at DESC LIMIT 1) AS last_activity
    FROM nodes n
    LEFT JOIN accounts a ON a.id = n.account_id
    LEFT JOIN nodes p    ON p.id = n.parent_id`;

const nodes = {
  byId(id) {
    return stmt(`${NODE_SELECT} WHERE n.id = ?`).get(id);
  },
  children(parentId, sort = "name") {
    const order = SORTS[sort] || SORTS.name;
    return stmt(
      `${NODE_SELECT}
       WHERE n.parent_id IS ? AND n.trashed = 0
       ORDER BY ${order}`,
    ).all(parentId);
  },
  roots() {
    return stmt(
      `${NODE_SELECT} WHERE n.parent_id IS NULL ORDER BY n.name COLLATE NOCASE`,
    ).all();
  },
  /** Walks up to the root; capped so a cycle can't hang the UI. */
  path(id) {
    const out = [];
    let cursor = id;
    while (cursor && out.length < 128) {
      const node = nodes.byId(cursor);
      if (!node) break;
      out.unshift(node);
      cursor = node.parent_id;
    }
    return out;
  },
  search(query, limit = 200) {
    const trimmed = query.trim();
    if (!trimmed) return [];
    // FTS5 needs whole tokens; 1-2 character queries are better served by LIKE.
    if (trimmed.length < 3) {
      return stmt(
        `${NODE_SELECT} WHERE n.name LIKE ? AND n.trashed = 0 AND n.seal_meta IS NULL
         ORDER BY n.is_folder DESC, n.name COLLATE NOCASE LIMIT ?`,
      ).all(`%${trimmed}%`, limit);
    }
    const match = `${trimmed.replace(/["*]/g, " ").trim()}*`;
    return stmt(
      `SELECT n.*, a.email AS account_email, a.photo_url AS account_photo,
              a.provider AS account_provider,
              p.name AS parent_name,
              (SELECT kind || '\t' || at FROM activity
                WHERE node_id = n.id ORDER BY at DESC LIMIT 1) AS last_activity
         FROM nodes_fts f
         JOIN nodes n ON n.rowid = f.rowid
         LEFT JOIN accounts a ON a.id = n.account_id
         LEFT JOIN nodes p    ON p.id = n.parent_id
        WHERE nodes_fts MATCH ? AND n.trashed = 0 AND n.seal_meta IS NULL
        ORDER BY rank LIMIT ?`,
    ).all(match, limit);
  },
  /** Backs the Recent view; folders are noise in a "what did I touch" list. */
  recent(limit = 50) {
    return stmt(
      `${NODE_SELECT}
       WHERE n.trashed = 0 AND n.is_folder = 0 AND n.modified_at IS NOT NULL
       ORDER BY n.modified_at DESC LIMIT ?`,
    ).all(limit);
  },
  starred(limit = 200) {
    return stmt(
      `${NODE_SELECT} WHERE n.trashed = 0 AND n.starred = 1
       ORDER BY n.is_folder DESC, n.name COLLATE NOCASE LIMIT ?`,
    ).all(limit);
  },
  /**
   * Only the items the user actually deleted. Trashing a folder cascades to its
   * contents, and listing all of them here would bury the one row that matters
   * (and let you "restore" a child into a still-trashed parent).
   */
  trashed(limit = 500) {
    return stmt(
      `${NODE_SELECT} WHERE n.trashed = 1 AND (p.id IS NULL OR p.trashed = 0)
       ORDER BY n.updated_at DESC LIMIT ?`,
    ).all(limit);
  },
  /**
   * Index a Drive file MaxDrive itself just created (upload, copy) as a
   * `managed` row under `parentId`. `file` is Drive's metadata; name/mime/size
   * fill in whatever it omitted. A row that already exists is refreshed.
   */
  upsertManaged({ id, parentId, accountId, file, name, mime = null, size, sealMeta = null }) {
    const now = Date.now();
    stmt(
      `INSERT INTO nodes (id, parent_id, origin, account_id, drive_file_id,
                          name, is_folder, mime, size, md5, web_view_link,
                          created_at, modified_at, status, updated_at, seal_meta)
       VALUES (?, ?, 'managed', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, size = excluded.size, md5 = excluded.md5,
         seal_meta = excluded.seal_meta,
         status = 'ok', updated_at = excluded.updated_at`,
    ).run(
      id,
      parentId,
      accountId,
      file.id,
      // A sealed file's real name lives only in seal_meta.
      sealMeta ? name : file.name || name,
      file.mimeType || mime,
      file.size == null ? size : Number(file.size),
      file.md5Checksum || null,
      file.webViewLink || null,
      file.createdTime ? Date.parse(file.createdTime) : now,
      file.modifiedTime ? Date.parse(file.modifiedTime) : now,
      now,
      sealMeta,
    );
  },

  /**
   * Points a row at a new physical object - a migration to another account, or
   * an S3 rename (a new key). Everything that references the old id follows.
   */
  rekey(oldId, { id, accountId, fileId, name }) {
    const now = Date.now();
    stmt(
      `UPDATE nodes SET id = ?, account_id = ?, drive_file_id = ?,
              name = COALESCE(?, name), updated_at = ? WHERE id = ?`,
    ).run(id, accountId, fileId, name ?? null, now, oldId);
    stmt("UPDATE nodes SET parent_id = ? WHERE parent_id = ?").run(id, oldId);
    stmt("UPDATE transfers SET node_id = ? WHERE node_id = ?").run(id, oldId);
    stmt("UPDATE activity SET node_id = ? WHERE node_id = ?").run(id, oldId);
  },
};

/* ---------------------------------------------------------------- activity */

const activity = {
  log(nodeId, accountId, kind, detail = null) {
    stmt(
      "INSERT INTO activity (node_id, account_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)",
    ).run(nodeId, accountId, kind, detail, Date.now());
  },
  forNode(nodeId, limit = 20) {
    return stmt(
      `SELECT v.*, a.email AS account_email FROM activity v
       LEFT JOIN accounts a ON a.id = v.account_id
       WHERE v.node_id = ? ORDER BY v.at DESC LIMIT ?`,
    ).all(nodeId, limit);
  },
};

/* --------------------------------------------------- paired devices (LAN) */

const devices = {
  list() {
    return stmt(
      "SELECT * FROM paired_devices ORDER BY created_at DESC",
    ).all();
  },
  byId(id) {
    return stmt("SELECT * FROM paired_devices WHERE id = ?").get(id);
  },
  insert(d) {
    stmt(
      `INSERT INTO paired_devices
         (id, name, platform, secret_enc, token_version, created_at, last_seen_at, revoked)
       VALUES (@id, @name, @platform, @secret_enc, @token_version, @created_at, @last_seen_at, @revoked)
       ON CONFLICT(id) DO UPDATE SET
         name          = excluded.name,
         platform      = excluded.platform,
         secret_enc    = excluded.secret_enc,
         token_version = paired_devices.token_version + 1,
         revoked       = 0,
         last_seen_at  = excluded.last_seen_at`,
    ).run({
      platform: null,
      token_version: 1,
      created_at: Date.now(),
      last_seen_at: Date.now(),
      revoked: 0,
      ...d,
    });
  },
  touch(id) {
    stmt("UPDATE paired_devices SET last_seen_at = ? WHERE id = ?").run(
      Date.now(),
      id,
    );
  },
  /** Revoke: mark revoked and bump token_version so live tokens stop verifying. */
  revoke(id) {
    stmt(
      "UPDATE paired_devices SET revoked = 1, token_version = token_version + 1 WHERE id = ?",
    ).run(id);
  },
};

/* ---------------------------------------------------------- local backup */

const backupSets = {
  list() {
    return stmt("SELECT * FROM backup_sets ORDER BY created_at").all();
  },
  byId(id) {
    return stmt("SELECT * FROM backup_sets WHERE id = ?").get(id);
  },
  insert(s) {
    stmt(
      `INSERT INTO backup_sets
         (id, name, local_root, mode, deletion_policy, rules, schedule,
          primary_account_id, enabled, paused, next_run_at, created_at, updated_at)
       VALUES (@id, @name, @local_root, @mode, @deletion_policy, @rules, @schedule,
               @primary_account_id, @enabled, @paused, @next_run_at, @created_at, @updated_at)`,
    ).run({
      mode: "mirror",
      deletion_policy: "trash",
      rules: "{}",
      schedule: "{}",
      primary_account_id: null,
      enabled: 1,
      paused: 0,
      next_run_at: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      ...s,
    });
  },
  /** Patch only the columns present in `patch`; always bumps updated_at. */
  update(id, patch) {
    const cols = [
      "name",
      "local_root",
      "mode",
      "deletion_policy",
      "rules",
      "schedule",
      "primary_account_id",
      "enabled",
      "paused",
      "last_run_at",
      "next_run_at",
      "last_run_status",
    ];
    patchRow("backup_sets", "id", cols, id, patch, true);
  },
  remove(id) {
    stmt("DELETE FROM backup_sets WHERE id = ?").run(id);
  },
  due(now) {
    return stmt(
      `SELECT * FROM backup_sets
        WHERE enabled = 1 AND paused = 0
          AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at`,
    ).all(now);
  },
};

const backupEntries = {
  get(setId, relPath) {
    return stmt(
      "SELECT * FROM backup_entries WHERE set_id = ? AND rel_path = ?",
    ).get(setId, relPath);
  },
  allForSet(setId) {
    return stmt("SELECT * FROM backup_entries WHERE set_id = ?").all(setId);
  },
  byState(setId, state, limit = -1) {
    return stmt(
      "SELECT * FROM backup_entries WHERE set_id = ? AND state = ? ORDER BY rel_path LIMIT ?",
    ).all(setId, state, limit);
  },
  countByState(setId) {
    const rows = stmt(
      "SELECT state, COUNT(*) c, SUM(size) bytes FROM backup_entries WHERE set_id = ? GROUP BY state",
    ).all(setId);
    const out = {};
    for (const r of rows) out[r.state] = { count: r.c, bytes: r.bytes || 0 };
    return out;
  },
  upsert(e) {
    stmt(
      `INSERT INTO backup_entries
         (set_id, rel_path, size, mtime, md5, account_id, drive_file_id,
          state, error, trashed_at, updated_at)
       VALUES (@set_id, @rel_path, @size, @mtime, @md5, @account_id, @drive_file_id,
               @state, @error, @trashed_at, @updated_at)
       ON CONFLICT(set_id, rel_path) DO UPDATE SET
         size = excluded.size, mtime = excluded.mtime,
         md5 = COALESCE(excluded.md5, backup_entries.md5),
         account_id = COALESCE(excluded.account_id, backup_entries.account_id),
         drive_file_id = COALESCE(excluded.drive_file_id, backup_entries.drive_file_id),
         state = excluded.state, error = excluded.error,
         trashed_at = excluded.trashed_at, updated_at = excluded.updated_at`,
    ).run({
      size: 0,
      mtime: 0,
      md5: null,
      account_id: null,
      drive_file_id: null,
      state: "pending",
      error: null,
      trashed_at: null,
      updated_at: Date.now(),
      ...e,
    });
  },
  setState(setId, relPath, state, error = null) {
    stmt(
      `UPDATE backup_entries SET state = ?, error = ?, updated_at = ?
        WHERE set_id = ? AND rel_path = ?`,
    ).run(state, error, Date.now(), setId, relPath);
  },
  /** Successful upload finalize: everything we now know about the cloud copy. */
  markOk(setId, relPath, { size, mtime, md5, accountId, driveFileId }) {
    stmt(
      `UPDATE backup_entries
          SET size = ?, mtime = ?, md5 = ?, account_id = ?, drive_file_id = ?,
              state = 'ok', error = NULL, trashed_at = NULL, updated_at = ?
        WHERE set_id = ? AND rel_path = ?`,
    ).run(size, mtime, md5, accountId, driveFileId, Date.now(), setId, relPath);
  },
  markTrashed(setId, relPath) {
    stmt(
      `UPDATE backup_entries SET state = 'trashed', trashed_at = ?, updated_at = ?
        WHERE set_id = ? AND rel_path = ?`,
    ).run(Date.now(), Date.now(), setId, relPath);
  },
  /** A rename changes the PK; done as delete+insert by the caller in a tx. */
  rename(setId, fromRel, toRel) {
    stmt(
      `UPDATE backup_entries SET rel_path = ?, updated_at = ?
        WHERE set_id = ? AND rel_path = ?`,
    ).run(toRel, Date.now(), setId, fromRel);
  },
  remove(setId, relPath) {
    stmt("DELETE FROM backup_entries WHERE set_id = ? AND rel_path = ?").run(
      setId,
      relPath,
    );
  },
  /** Drive purges its trash after ~30 days; matching rows are dead weight. */
  purgeExpiredTrash(setId, cutoffMs) {
    stmt(
      `DELETE FROM backup_entries
        WHERE set_id = ? AND state = 'trashed' AND trashed_at < ?`,
    ).run(setId, cutoffMs);
  },
  /** Fingerprint input: cheap change signal for the index cloud snapshot. */
  digest() {
    return stmt(
      "SELECT COUNT(*) c, COALESCE(MAX(updated_at), 0) m FROM backup_entries",
    ).get();
  },
};

const backupFolders = {
  get(setId, accountId, relPath) {
    const row = stmt(
      `SELECT drive_folder_id FROM backup_folders
        WHERE set_id = ? AND account_id = ? AND rel_path = ?`,
    ).get(setId, accountId, relPath);
    return row ? row.drive_folder_id : null;
  },
  insert(setId, accountId, relPath, driveFolderId) {
    stmt(
      `INSERT INTO backup_folders (set_id, account_id, rel_path, drive_folder_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(set_id, account_id, rel_path)
         DO UPDATE SET drive_folder_id = excluded.drive_folder_id`,
    ).run(setId, accountId, relPath, driveFolderId);
  },
  driveIdsForAccount(accountId) {
    return stmt(
      "SELECT drive_folder_id FROM backup_folders WHERE account_id = ?",
    )
      .all(accountId)
      .map((r) => r.drive_folder_id);
  },
  forSet(setId) {
    return stmt("SELECT * FROM backup_folders WHERE set_id = ?").all(setId);
  },
};

const backupRuns = {
  insert(r) {
    stmt(
      `INSERT INTO backup_runs
         (id, set_id, mode, reason, state, started_at,
          files_total, files_done, bytes_total, bytes_done)
       VALUES (@id, @set_id, @mode, @reason, @state, @started_at,
               @files_total, @files_done, @bytes_total, @bytes_done)`,
    ).run({
      files_total: 0,
      files_done: 0,
      bytes_total: 0,
      bytes_done: 0,
      started_at: Date.now(),
      ...r,
    });
  },
  update(id, patch) {
    const cols = [
      "state",
      "finished_at",
      "files_total",
      "files_done",
      "bytes_total",
      "bytes_done",
      "error",
    ];
    patchRow("backup_runs", "id", cols, id, patch);
  },
  forSet(setId, limit = 20) {
    return stmt(
      "SELECT * FROM backup_runs WHERE set_id = ? ORDER BY started_at DESC LIMIT ?",
    ).all(setId, limit);
  },
  nonTerminal() {
    return stmt(
      `SELECT * FROM backup_runs
        WHERE state IN ('scanning', 'transferring', 'finalizing')`,
    ).all();
  },
  latestComplete(setId) {
    return stmt(
      `SELECT * FROM backup_runs
        WHERE set_id = ? AND state IN ('done', 'partial')
        ORDER BY started_at DESC LIMIT 1`,
    ).get(setId);
  },
};

const archiveParts = {
  insert(p) {
    stmt(
      `INSERT INTO backup_archive_parts
         (id, run_id, set_id, part_index, account_id, drive_file_id,
          size, sha256, state, created_at)
       VALUES (@id, @run_id, @set_id, @part_index, @account_id, @drive_file_id,
               @size, @sha256, @state, @created_at)`,
    ).run({
      account_id: null,
      drive_file_id: null,
      size: null,
      sha256: null,
      state: "pending",
      created_at: Date.now(),
      ...p,
    });
  },
  update(id, patch) {
    const cols = [
      "account_id",
      "drive_file_id",
      "size",
      "sha256",
      "state",
    ];
    patchRow("backup_archive_parts", "id", cols, id, patch);
  },
  forRun(runId) {
    return stmt(
      "SELECT * FROM backup_archive_parts WHERE run_id = ? ORDER BY part_index",
    ).all(runId);
  },
};

/* ----------------------------------------------------------- secure vault */

/**
 * The vault plane. Note what is NOT here: no name, no mime, no path. Those
 * live inside `meta_ct`, encrypted under the master key, so these rows are
 * useless to anyone reading the database file while the vault is locked.
 */
/** Vault mode's single key config (see vault/seal.cjs). */
const sealConfig = {
  get() {
    return stmt("SELECT * FROM seal_config WHERE id = 1").get();
  },
  upsert(c) {
    const now = Date.now();
    stmt(
      `INSERT INTO seal_config
         (id, version, kdf_params, salt, wrapped_priv, public_key, created_at, updated_at)
       VALUES (1, @version, @kdf_params, @salt, @wrapped_priv, @public_key, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version, kdf_params = excluded.kdf_params,
         salt = excluded.salt, wrapped_priv = excluded.wrapped_priv,
         public_key = excluded.public_key, updated_at = excluded.updated_at`,
    ).run({ created_at: now, ...c, updated_at: now });
  },
};

const vaultConfig = {
  get() {
    return stmt("SELECT * FROM vault_config WHERE id = 1").get();
  },
  upsert(c) {
    stmt(
      `INSERT INTO vault_config
         (id, version, rev, kdf_params, salt, wrapped_vmk,
          recovery_salt, wrapped_vmk_recovery, created_at, updated_at)
       VALUES (1, @version, @rev, @kdf_params, @salt, @wrapped_vmk,
               @recovery_salt, @wrapped_vmk_recovery, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version, rev = excluded.rev,
         kdf_params = excluded.kdf_params, salt = excluded.salt,
         wrapped_vmk = excluded.wrapped_vmk,
         recovery_salt = excluded.recovery_salt,
         wrapped_vmk_recovery = excluded.wrapped_vmk_recovery,
         updated_at = excluded.updated_at`,
    ).run({
      rev: 1,
      recovery_salt: null,
      wrapped_vmk_recovery: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      ...c,
    });
  },
};

const vaultItems = {
  /** Children of a folder; `null` parent is the vault root. */
  list(parentId = null) {
    return parentId
      ? stmt(
          "SELECT * FROM vault_items WHERE parent_id = ? ORDER BY is_folder DESC",
        ).all(parentId)
      : stmt(
          "SELECT * FROM vault_items WHERE parent_id IS NULL ORDER BY is_folder DESC",
        ).all();
  },
  byId(id) {
    return stmt("SELECT * FROM vault_items WHERE id = ?").get(id);
  },
  all() {
    return stmt("SELECT * FROM vault_items").all();
  },
  byState(state) {
    return stmt("SELECT * FROM vault_items WHERE state = ?").all(state);
  },
  count() {
    return stmt("SELECT COUNT(*) c FROM vault_items").get().c;
  },
  insert(i) {
    stmt(
      `INSERT INTO vault_items
         (id, parent_id, is_folder, meta_ct, size, blob_uuid, blob_size,
          chunk_size, blob_md5, plaintext_sha256, wrapped_file_key, file_prefix,
          state, created_at, modified_at, updated_at)
       VALUES (@id, @parent_id, @is_folder, @meta_ct, @size, @blob_uuid, @blob_size,
               @chunk_size, @blob_md5, @plaintext_sha256, @wrapped_file_key, @file_prefix,
               @state, @created_at, @modified_at, @updated_at)`,
    ).run({
      parent_id: null,
      is_folder: 0,
      meta_ct: null,
      size: 0,
      blob_uuid: null,
      blob_size: null,
      chunk_size: null,
      blob_md5: null,
      plaintext_sha256: null,
      wrapped_file_key: null,
      file_prefix: null,
      state: "active",
      created_at: Date.now(),
      modified_at: Date.now(),
      updated_at: Date.now(),
      ...i,
    });
  },
  update(id, patch) {
    const cols = [
      "parent_id",
      "meta_ct",
      "size",
      "blob_uuid",
      "blob_size",
      "chunk_size",
      "blob_md5",
      "plaintext_sha256",
      "wrapped_file_key",
      "file_prefix",
      "state",
      "created_at",
      "modified_at",
    ];
    patchRow("vault_items", "id", cols, id, patch, true);
  },
  remove(id) {
    stmt("DELETE FROM vault_items WHERE id = ?").run(id);
  },
  clear() {
    stmt("DELETE FROM vault_items").run();
  },
};

const vaultCopies = {
  forItem(itemId) {
    return stmt("SELECT * FROM vault_copies WHERE item_id = ?").all(itemId);
  },
  get(itemId, accountId) {
    return stmt(
      "SELECT * FROM vault_copies WHERE item_id = ? AND account_id = ?",
    ).get(itemId, accountId);
  },
  forAccount(accountId, state = null) {
    return state
      ? stmt(
          "SELECT * FROM vault_copies WHERE account_id = ? AND state = ?",
        ).all(accountId, state)
      : stmt("SELECT * FROM vault_copies WHERE account_id = ?").all(accountId);
  },
  all() {
    return stmt("SELECT * FROM vault_copies").all();
  },
  upsert(c) {
    stmt(
      `INSERT INTO vault_copies (item_id, account_id, drive_file_id, state, error, updated_at)
       VALUES (@item_id, @account_id, @drive_file_id, @state, @error, @updated_at)
       ON CONFLICT(item_id, account_id) DO UPDATE SET
         drive_file_id = COALESCE(excluded.drive_file_id, vault_copies.drive_file_id),
         state = excluded.state, error = excluded.error,
         updated_at = excluded.updated_at`,
    ).run({
      drive_file_id: null,
      state: "pending",
      error: null,
      updated_at: Date.now(),
      ...c,
    });
  },
  setState(itemId, accountId, state, error = null) {
    stmt(
      `UPDATE vault_copies SET state = ?, error = ?, updated_at = ?
        WHERE item_id = ? AND account_id = ?`,
    ).run(state, error, Date.now(), itemId, accountId);
  },
  remove(itemId, accountId) {
    stmt("DELETE FROM vault_copies WHERE item_id = ? AND account_id = ?").run(
      itemId,
      accountId,
    );
  },
  countsByAccount() {
    const rows = stmt(
      "SELECT account_id, state, COUNT(*) c FROM vault_copies GROUP BY account_id, state",
    ).all();
    const out = {};
    for (const r of rows) {
      out[r.account_id] = out[r.account_id] || {};
      out[r.account_id][r.state] = r.c;
    }
    return out;
  },
  clear() {
    stmt("DELETE FROM vault_copies").run();
  },
};

const vaultAccounts = {
  list() {
    return stmt(
      `SELECT v.*, a.email, a.auth_state, a.quota_limit, a.quota_usage
         FROM vault_accounts v JOIN accounts a ON a.id = v.account_id
        ORDER BY v.added_at`,
    ).all();
  },
  ids() {
    return stmt("SELECT account_id FROM vault_accounts")
      .all()
      .map((r) => r.account_id);
  },
  get(accountId) {
    return stmt("SELECT * FROM vault_accounts WHERE account_id = ?").get(
      accountId,
    );
  },
  insert(a) {
    stmt(
      `INSERT INTO vault_accounts (account_id, state, added_at, last_ok_at, last_error)
       VALUES (@account_id, @state, @added_at, @last_ok_at, @last_error)
       ON CONFLICT(account_id) DO UPDATE SET state = excluded.state`,
    ).run({
      state: "active",
      added_at: Date.now(),
      last_ok_at: null,
      last_error: null,
      ...a,
    });
  },
  update(accountId, patch) {
    const cols = ["state", "last_ok_at", "last_error"];
    patchRow("vault_accounts", "account_id", cols, accountId, patch);
  },
  remove(accountId) {
    stmt("DELETE FROM vault_accounts WHERE account_id = ?").run(accountId);
  },
};

module.exports = {
  sealConfig,
  NODE_SELECT,
  settings,
  accounts,
  syncState,
  nodes,
  activity,
  devices,
  backupSets,
  backupEntries,
  backupFolders,
  backupRuns,
  archiveParts,
  vaultConfig,
  vaultItems,
  vaultCopies,
  vaultAccounts,
  resetStatementCache,
  MANAGED_ROOT_ID,
};
