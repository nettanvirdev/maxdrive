/**
 * The single point where SQLite is opened. Everything else talks to the DB
 * through queries.cjs, so swapping the driver is a change to this file only.
 */
const path = require("path");
const fs = require("fs");
const { app } = require("electron");
const Database = require("better-sqlite3");
const { MIGRATIONS, LATEST_VERSION } = require("./migrations.cjs");
const { scope } = require("../logger.cjs");

const log = scope("db");

/** Virtual root that holds the unified, app-managed folder tree. */
const MANAGED_ROOT_ID = "root-managed";

let db = null;

function dbPath() {
  return path.join(app.getPath("userData"), "maxdrive.db");
}

function migrate(handle) {
  const current = handle.pragma("user_version", { simple: true });

  // A database written by a newer build may have columns and tables this one
  // has never heard of. Silently skipping every migration and carrying on is
  // the worst option - it corrupts data slowly. Refuse instead, and say why.
  if (current > LATEST_VERSION) {
    throw new Error(
      `This index was created by a newer version of MaxDrive ` +
        `(schema v${current}, this build understands v${LATEST_VERSION}). ` +
        `Update MaxDrive to open it.`,
    );
  }

  for (const { version, sql } of MIGRATIONS) {
    if (version <= current) continue;
    log.info(`applying migration v${version}`);
    handle.exec("BEGIN");
    try {
      handle.exec(sql);
      handle.pragma(`user_version = ${version}`);
      handle.exec("COMMIT");
    } catch (err) {
      handle.exec("ROLLBACK");
      throw err;
    }
  }
}

function seed(handle) {
  handle
    .prepare(
      `INSERT INTO nodes (id, parent_id, origin, name, is_folder, updated_at)
       VALUES (?, NULL, 'vfolder', 'MaxDrive', 1, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(MANAGED_ROOT_ID, Date.now());
}

/**
 * Opens the database, running migrations and an integrity check. A corrupt
 * file is moved aside rather than deleted - the restore wizard can still
 * offer to pull a cloud backup, and the bad file stays available for triage.
 */
function open() {
  if (db) return db;

  const file = dbPath();
  let handle;
  try {
    handle = new Database(file);
    const integrity = handle.pragma("integrity_check", { simple: true });
    if (integrity !== "ok")
      throw new Error(`integrity_check returned ${integrity}`);
  } catch (err) {
    log.error("database unusable, moving aside", err);
    try {
      handle?.close();
    } catch {
      /* already unusable */
    }
    if (fs.existsSync(file)) {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    }
    handle = new Database(file);
  }

  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");
  handle.pragma("synchronous = NORMAL");

  migrate(handle);
  seed(handle);

  db = handle;
  log.info(`opened ${file}`);
  return db;
}

function get() {
  if (!db) throw new Error("database not opened yet");
  return db;
}

function close() {
  if (!db) return;
  db.close();
  db = null;
}

/**
 * Swaps in a restored snapshot. The current file is kept as .pre-restore so
 * even a restore of the wrong generation is reversible by hand. Prepared
 * statements cached elsewhere die with the old handle, so queries.cjs is told
 * to rebuild its cache.
 */
function replaceWith(sourceFile) {
  const file = dbPath();
  close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${file}${suffix}`;
    if (!fs.existsSync(target)) continue;
    if (suffix === "") fs.copyFileSync(target, `${file}.pre-restore`);
    fs.rmSync(target, { force: true });
  }
  fs.copyFileSync(sourceFile, file);
  open();
  require("./queries.cjs").resetStatementCache();
  log.info("index replaced from snapshot; previous copy kept as .pre-restore");
}

module.exports = { open, get, close, replaceWith, MANAGED_ROOT_ID };
