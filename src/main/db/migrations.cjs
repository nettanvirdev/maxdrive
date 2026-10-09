/**
 * Schema migrations, applied in order via PRAGMA user_version.
 * Never edit a shipped migration - add a new one.
 */

const V1 = `
CREATE TABLE accounts (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  display_name       TEXT,
  photo_url          TEXT,
  app_folder_id      TEXT,
  index_folder_id    TEXT,
  quota_limit        INTEGER,
  quota_usage        INTEGER,
  quota_usage_drive  INTEGER,
  quota_refreshed_at INTEGER,
  auth_state         TEXT NOT NULL DEFAULT 'ok',
  added_at           INTEGER NOT NULL,
  sort_order         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE nodes (
  id                   TEXT PRIMARY KEY,
  parent_id            TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  origin               TEXT NOT NULL,
  account_id           TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  drive_file_id        TEXT,
  drive_parent_id      TEXT,
  name                 TEXT NOT NULL,
  is_folder            INTEGER NOT NULL DEFAULT 0,
  mime                 TEXT,
  size                 INTEGER NOT NULL DEFAULT 0,
  md5                  TEXT,
  is_google_doc        INTEGER NOT NULL DEFAULT 0,
  web_view_link        TEXT,
  created_at           INTEGER,
  modified_at          INTEGER,
  starred              INTEGER NOT NULL DEFAULT 0,
  trashed              INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'ok',
  thumb_state          TEXT NOT NULL DEFAULT 'none',
  thumb_version        TEXT,
  share_link           TEXT,
  share_permission_id  TEXT,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX idx_nodes_parent ON nodes(parent_id, trashed);
CREATE INDEX idx_nodes_drive  ON nodes(account_id, drive_file_id);
CREATE INDEX idx_nodes_origin ON nodes(origin);
CREATE UNIQUE INDEX idx_nodes_drive_unique
  ON nodes(account_id, drive_file_id) WHERE drive_file_id IS NOT NULL;

CREATE VIRTUAL TABLE nodes_fts USING fts5(
  name,
  content='nodes',
  content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name) VALUES (new.rowid, new.name);
END;
CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
END;
CREATE TRIGGER nodes_fts_au AFTER UPDATE OF name ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
  INSERT INTO nodes_fts(rowid, name) VALUES (new.rowid, new.name);
END;

CREATE TABLE transfers (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,
  state               TEXT NOT NULL,
  node_id             TEXT,
  account_id          TEXT,
  local_path          TEXT,
  dest_parent_node_id TEXT,
  name                TEXT NOT NULL,
  size                INTEGER NOT NULL DEFAULT 0,
  bytes_done          INTEGER NOT NULL DEFAULT 0,
  session_uri         TEXT,
  session_expires_at  INTEGER,
  temp_path           TEXT,
  error_code          TEXT,
  error_message       TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  priority            INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_transfers_state ON transfers(state, priority DESC, created_at);

CREATE TABLE sync_state (
  account_id      TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  page_token      TEXT,
  full_scan_done  INTEGER NOT NULL DEFAULT 0,
  scan_cursor     TEXT,
  full_scan_at    INTEGER,
  last_poll_at    INTEGER,
  last_error      TEXT
);

CREATE TABLE backup_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  generation  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  sha256      TEXT,
  size        INTEGER,
  uploaded_to TEXT
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * Per-file activity log, written by our own operations. Drive's Activity API
 * is a separate service with its own quota; for a personal app, recording what
 * *this app* did plus the scanner's created/modified timestamps covers the
 * "why is this file here" question without extra API cost.
 */
const V2 = `
CREATE TABLE activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id    TEXT NOT NULL,
  account_id TEXT,
  kind       TEXT NOT NULL, -- uploaded|created|renamed|moved|trashed|restored|downloaded|shared|migrated
  detail     TEXT,
  at         INTEGER NOT NULL
);
CREATE INDEX idx_activity_node ON activity(node_id, at DESC);
`;

/**
 * Who paused a transfer. Without this, auto-resume on the next launch cannot
 * tell "the app was killed mid-upload" from "the user pressed pause and meant
 * it", so it restarts work the user deliberately stopped.
 *
 * NULL means never paused; 'system' is crash recovery; 'user' is deliberate.
 */
const V3 = `
ALTER TABLE transfers ADD COLUMN paused_by TEXT;
`;

/**
 * Local→cloud backup sets. Identity rules mirror the main index philosophy:
 * a backup entry's identity is its relative path within the set (local truth),
 * while backup_folders records the Drive-side folder skeleton per account —
 * a set can spill across accounts, so the same rel dir may exist on several.
 * transfers.meta carries per-kind JSON context so backup/restore transfers
 * don't need nodes rows.
 */
const V4 = `
ALTER TABLE accounts  ADD COLUMN backup_folder_id TEXT;
ALTER TABLE transfers ADD COLUMN meta TEXT;

CREATE TABLE backup_sets (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  local_root         TEXT NOT NULL,
  mode               TEXT NOT NULL DEFAULT 'mirror',
  deletion_policy    TEXT NOT NULL DEFAULT 'trash',
  rules              TEXT NOT NULL DEFAULT '{}',
  schedule           TEXT NOT NULL DEFAULT '{}',
  primary_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  enabled            INTEGER NOT NULL DEFAULT 1,
  paused             INTEGER NOT NULL DEFAULT 0,
  last_run_at        INTEGER,
  next_run_at        INTEGER,
  last_run_status    TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE backup_entries (
  set_id        TEXT NOT NULL REFERENCES backup_sets(id) ON DELETE CASCADE,
  rel_path      TEXT NOT NULL,
  size          INTEGER NOT NULL DEFAULT 0,
  mtime         INTEGER NOT NULL DEFAULT 0,
  md5           TEXT,
  account_id    TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  drive_file_id TEXT,
  state         TEXT NOT NULL DEFAULT 'pending',
  error         TEXT,
  trashed_at    INTEGER,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (set_id, rel_path)
);
CREATE INDEX idx_backup_entries_state ON backup_entries(set_id, state);
CREATE INDEX idx_backup_entries_drive ON backup_entries(account_id, drive_file_id);

CREATE TABLE backup_folders (
  set_id          TEXT NOT NULL REFERENCES backup_sets(id) ON DELETE CASCADE,
  account_id      TEXT NOT NULL,
  rel_path        TEXT NOT NULL,
  drive_folder_id TEXT NOT NULL,
  PRIMARY KEY (set_id, account_id, rel_path)
);
CREATE INDEX idx_backup_folders_drive ON backup_folders(account_id, drive_folder_id);

CREATE TABLE backup_runs (
  id          TEXT PRIMARY KEY,
  set_id      TEXT NOT NULL REFERENCES backup_sets(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  state       TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  files_total INTEGER NOT NULL DEFAULT 0,
  files_done  INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  bytes_done  INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX idx_backup_runs_set ON backup_runs(set_id, started_at DESC);

CREATE TABLE backup_archive_parts (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
  set_id        TEXT NOT NULL,
  part_index    INTEGER NOT NULL,
  account_id    TEXT,
  drive_file_id TEXT,
  size          INTEGER,
  sha256        TEXT,
  state         TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_archive_parts_run ON backup_archive_parts(run_id, part_index);
`;

/*
 * V5 - Secure Storage (encrypted vault).
 *
 * The vault is a parallel storage plane: its rows never touch `nodes`.
 * vault_config holds the wrapped Vault Master Key (password wrap + optional
 * recovery-key wrap) - losing both secrets means the data is gone by design.
 * vault_items store name/mime only as a VMK-encrypted blob (meta_ct) so a
 * locked vault leaks nothing readable even from the raw sqlite file; sizes
 * and dates stay plain columns for ordering. vault_copies tracks which
 * accounts hold each ciphertext blob; vault_accounts is the user's chosen
 * set of hosting accounts.
 */
const V5 = `
ALTER TABLE accounts ADD COLUMN vault_folder_id TEXT;

CREATE TABLE vault_config (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  version              INTEGER NOT NULL,
  rev                  INTEGER NOT NULL DEFAULT 1,
  kdf_params           TEXT NOT NULL,
  salt                 BLOB NOT NULL,
  wrapped_vmk          BLOB NOT NULL,
  recovery_salt        BLOB,
  wrapped_vmk_recovery BLOB,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE vault_items (
  id               TEXT PRIMARY KEY,
  parent_id        TEXT REFERENCES vault_items(id) ON DELETE CASCADE,
  is_folder        INTEGER NOT NULL DEFAULT 0,
  meta_ct          BLOB,
  size             INTEGER NOT NULL DEFAULT 0,
  blob_uuid        TEXT,
  blob_size        INTEGER,
  chunk_size       INTEGER,
  blob_md5         TEXT,
  plaintext_sha256 TEXT,
  wrapped_file_key BLOB,
  file_prefix      BLOB,
  state            TEXT NOT NULL DEFAULT 'active',
  created_at       INTEGER,
  modified_at      INTEGER,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_vault_items_parent ON vault_items(parent_id, is_folder);

CREATE TABLE vault_copies (
  item_id       TEXT NOT NULL REFERENCES vault_items(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL,
  drive_file_id TEXT,
  state         TEXT NOT NULL DEFAULT 'pending',
  error         TEXT,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (item_id, account_id)
);
CREATE INDEX idx_vault_copies_account ON vault_copies(account_id, state);

CREATE TABLE vault_accounts (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT 'active',
  added_at   INTEGER NOT NULL,
  last_ok_at INTEGER,
  last_error TEXT
);
`;

/*
 * V6 - LAN server device pairing.
 *
 * A paired device (phone, or an AI via MCP) proves possession of a 6-digit
 * pairing code and is then a trusted client of the local-network API. Identity
 * is a client-generated UUID; secret_enc is the PBKDF2-derived per-device
 * secret, DPAPI-wrapped at rest like tokens.bin. token_version lets a revoke
 * invalidate any issued bearer token without a token table. The stable
 * serverId and the token signing key live in the `settings` table.
 */
const V6 = `
CREATE TABLE paired_devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  platform      TEXT,
  secret_enc    BLOB NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  revoked       INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * V7 - storage providers. `provider` says which backend an account is
 * ('gdrive' | 's3'); `config` is the provider's non-secret settings as JSON
 * (S3: endpoint, region, bucket, prefix, pathStyle). Secrets stay in
 * tokens.bin. For S3 rows, nodes.drive_file_id holds the object key and
 * transfers.session_uri holds the multipart {key, uploadId, partSize} JSON.
 */
const V7 = `
ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'gdrive';
ALTER TABLE accounts ADD COLUMN config TEXT;
`;

/**
 * V8 - vault mode. seal_config holds the one vault-mode key: its public half
 * (uploads seal to it while locked) and the private half wrapped under the
 * password. nodes.seal_meta is the sealed {name, mime, size} of an encrypted
 * file or folder; such rows keep only a placeholder in nodes.name, so no
 * plaintext name reaches the DB or the index snapshot.
 */
const V8 = `
CREATE TABLE seal_config (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  version      INTEGER NOT NULL,
  kdf_params   TEXT NOT NULL,
  salt         BLOB NOT NULL,
  wrapped_priv BLOB NOT NULL,
  public_key   BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
ALTER TABLE nodes ADD COLUMN seal_meta BLOB;
`;

const MIGRATIONS = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
  { version: 3, sql: V3 },
  { version: 4, sql: V4 },
  { version: 5, sql: V5 },
  { version: 6, sql: V6 },
  { version: 7, sql: V7 },
  { version: 8, sql: V8 },
];

/** Highest schema this build understands - used to refuse a newer database. */
const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

module.exports = { MIGRATIONS, LATEST_VERSION };
