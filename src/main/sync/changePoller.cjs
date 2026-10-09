/**
 * Incremental sync: drains each account's changes.list feed on a timer.
 *
 * Drive wins for file facts (name, trash state, existence); the local index
 * wins for virtual structure. Those never actually collide, because Drive has
 * no opinion about virtual folders.
 */
const { app, BrowserWindow } = require("electron");
const { get: db } = require("../db/database.cjs");
const { accounts, syncState } = require("../db/queries.cjs");
const { json } = require("../auth/googleClient.cjs");
const drive = require("../drive/driveApi.cjs");
const scanner = require("./scanner.cjs");
const settingsStore = require("../settings.cjs");
const { scope } = require("../logger.cjs");

const log = scope("poll");

const API = "https://www.googleapis.com/drive/v3";
const FOCUSED_MS = 45_000;
const BLURRED_MS = 5 * 60_000;

const CHANGE_FIELDS =
  "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size," +
  "md5Checksum,parents,createdTime,modifiedTime,starred,trashed,webViewLink))";

let notify = () => {};
function setNotifier(fn) {
  notify = fn;
}

let timer = null;
let polling = false;

function applyChange(accountId, change, hidden) {
  const nodeId = scanner.nodeId(accountId, change.fileId);

  if (change.removed || change.file?.trashed) {
    // Mirrored rows just disappear; managed rows (our uploads) get flagged so
    // the user can see something they put here was deleted elsewhere.
    const existing = db()
      .prepare("SELECT origin FROM nodes WHERE id = ?")
      .get(nodeId);
    if (!existing) return false;
    if (change.removed && existing.origin !== "managed") {
      // A mirrored row is only ever a reflection of Drive, so it can go.
      db().prepare("DELETE FROM nodes WHERE id = ?").run(nodeId);
    } else if (existing.origin === "managed") {
      db()
        .prepare(
          "UPDATE nodes SET trashed = 1, status = 'missing_remote', updated_at = ? WHERE id = ?",
        )
        .run(Date.now(), nodeId);
    } else {
      db()
        .prepare("UPDATE nodes SET trashed = 1, updated_at = ? WHERE id = ?")
        .run(Date.now(), nodeId);
    }
    return true;
  }

  if (!change.file) return false;

  // App plumbing (.index snapshots, .backup trees) must never surface as user
  // files. The set covers every folder we created, so any depth is caught.
  if (hidden.has(change.file.parents?.[0]) || hidden.has(change.file.id)) {
    return false;
  }

  // Upsert with the scanner's row shape, then fix up the parent link.
  const row = scanner.toRow(accountId, change.file);
  db().prepare(scanner.UPSERT).run(row);
  db()
    .prepare(
      `UPDATE nodes SET parent_id = COALESCE(
         (SELECT p.id FROM nodes p
           WHERE p.account_id = ? AND p.drive_file_id = ?),
         parent_id,
         ?
       ) WHERE id = ? AND origin = 'mirrored'`,
    )
    .run(
      accountId,
      row.drive_parent_id,
      scanner.nodeId(accountId, "root"),
      nodeId,
    );
  return true;
}

/**
 * Built per call rather than memoised: a restore swaps the database handle
 * underneath us, and a cached transaction would still point at the closed one.
 */
function applyPage(accountId, changes, hidden) {
  if (!changes.length) return 0;
  const run = db().transaction((id, list) => {
    let count = 0;
    for (const change of list) if (applyChange(id, change, hidden)) count += 1;
    return count;
  });
  return run(accountId, changes);
}

async function pollAccount(account) {
  const state = syncState.get(account.id);
  if (!state?.page_token) return 0;

  let token = state.page_token;
  let applied = 0;
  const hidden = scanner.hiddenFolderIds(account);

  for (;;) {
    let page;
    try {
      page = await json(
        account.id,
        `${API}/changes?pageToken=${encodeURIComponent(token)}&fields=${encodeURIComponent(CHANGE_FIELDS)}&pageSize=500&spaces=drive`,
      );
    } catch (err) {
      // Deliberately narrow: a generic 400 is a malformed request, not an
      // expired cursor, and treating it as one would wipe and re-scan the
      // account on every repeat - the exact traffic pattern to avoid.
      if (err.status === 410 || err.code === "invalidPageToken") {
        // Token expired: this account's mirror is now untrustworthy - rescan it.
        log.warn(`${account.email}: change token expired, rescanning`);
        db()
          .prepare(
            "DELETE FROM nodes WHERE account_id = ? AND origin = 'mirrored' AND drive_file_id != 'root'",
          )
          .run(account.id);
        await scanner.scanAccount(account.id);
        return 0;
      }
      throw err;
    }

    // One transaction per page: applyChange writes a row and then fixes its
    // parent link, and a crash between those two leaves a stale parent_id.
    applied += applyPage(account.id, page.changes || [], hidden);

    if (page.newStartPageToken) {
      syncState.setPageToken(account.id, page.newStartPageToken);
      break;
    }
    token = page.pageToken || page.nextPageToken;
    if (!token) break;
  }

  db()
    .prepare(
      "UPDATE sync_state SET last_poll_at = ?, last_error = NULL WHERE account_id = ?",
    )
    .run(Date.now(), account.id);
  return applied;
}

/**
 * S3 has no change feed, so "polling" an S3 account is re-listing it - cheap
 * per request but proportional to the bucket, hence its own cadence (setting
 * `s3RescanMinutes`, 0 = only on manual Re-index) and never on the quick
 * after-our-own-write follow-up.
 */
async function rescanIfStale(account) {
  const minutes = Number(settingsStore.get("s3RescanMinutes")) || 0;
  if (!minutes) return 0;
  const state = syncState.get(account.id);
  if (Date.now() - (state?.full_scan_at || 0) < minutes * 60_000) return 0;
  const result = await scanner.scanAccount(account.id);
  return result?.count ? 1 : 0;
}

async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    let total = 0;
    for (const account of accounts.active()) {
      try {
        if (account.provider === "s3") {
          total += await rescanIfStale(account);
          continue;
        }
        total += await pollAccount(account);
      } catch (err) {
        log.warn(`poll failed for ${account.email}: ${err.message}`);
        db()
          .prepare("UPDATE sync_state SET last_error = ? WHERE account_id = ?")
          .run(err.message, account.id);
      }
    }
    if (total) {
      log.info(`applied ${total} remote change(s)`);
      notify({ changed: total });
    }
  } finally {
    polling = false;
  }
}

function schedule() {
  const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused());
  timer = setTimeout(
    async () => {
      await pollAll();
      schedule();
    },
    focused ? FOCUSED_MS : BLURRED_MS,
  );
}

/** Restarts the interval - used when focus changes so the cadence adapts at once. */
function reschedule() {
  if (!timer) return;
  clearTimeout(timer);
  schedule();
}

let soonTimer = null;

/**
 * A short, coalesced poll. Drive publishes changes to the feed a beat after the
 * write lands, so both our own edits and a just-noticed remote edit need one
 * quick follow-up rather than a full interval's wait.
 */
function pollSoon(delayMs = 2500) {
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = setTimeout(() => {
    soonTimer = null;
    pollAll();
  }, delayMs);
}

function start() {
  if (timer) return;
  schedule();

  // Coming back to the window is the strongest signal that the user wants to
  // see current data - poll immediately and switch to the fast cadence.
  app.on("browser-window-focus", () => {
    pollSoon(300);
    reschedule();
  });
  app.on("browser-window-blur", reschedule);

  log.info("change polling started");
}

function stop() {
  if (timer) clearTimeout(timer);
  if (soonTimer) clearTimeout(soonTimer);
  timer = soonTimer = null;
}

module.exports = { start, stop, pollAll, pollSoon, setNotifier };
