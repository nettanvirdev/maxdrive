/**
 * Picks which account an upload lands on.
 *
 * Evaluated when a transfer *starts*, not when it is queued - quota moves while
 * files sit in the queue, and committing early is how you get a 403 halfway
 * through a 2 GB upload.
 */
const { get: db } = require("./db/database.cjs");
const { accounts } = require("./db/queries.cjs");
const settingsStore = require("./settings.cjs");

/**
 * Bytes already promised to queued or running uploads on each account.
 *
 * Migrations count too: their account_id is the *target* of the move, so those
 * bytes are every bit as committed as an upload's. Leaving them out let a
 * migration and an upload both be told the same free space was theirs.
 */
function reserved() {
  const rows = db()
    .prepare(
      `SELECT account_id, COALESCE(SUM(size - COALESCE(bytes_done, 0)), 0) AS pending
         FROM transfers
        WHERE kind IN ('upload', 'migrate', 'backup', 'vaultUp') AND account_id IS NOT NULL
          AND state IN ('queued', 'allocating', 'running', 'paused')
        GROUP BY account_id`,
    )
    .all();
  return new Map(rows.map((r) => [r.account_id, r.pending]));
}

function freeBytes(account, pending = 0) {
  // usage, not usageInDrive: the 15 GB pool is shared with Gmail and Photos.
  if (account.quota_limit == null) return Number.POSITIVE_INFINITY;
  return account.quota_limit - (account.quota_usage ?? 0) - pending;
}

/**
 * Accounts eligible for placement. User files may go anywhere; app plumbing
 * (local backups, vault blobs, archive parts) only to providers that support
 * it - today Drive, since S3 has no remote trash/revisions those flows rely on.
 */
function snapshot({ userFiles = false } = {}) {
  const pending = reserved();
  return accounts
    .active()
    .filter((account) => userFiles || account.provider !== "s3")
    .map((account) => ({
    id: account.id,
    email: account.email,
    free: freeBytes(account, pending.get(account.id) ?? 0),
  }));
}

/**
 * @returns {{accountId: string, email: string, free: number}}
 * @throws when nothing can hold the file - the message lists every account so
 *   the user can see exactly how short they are.
 */
function pickAccountForUpload(sizeBytes, overrideAccountId, { userFiles = false } = {}) {
  const headroom = (settingsStore.get("headroomMb") ?? 200) * 1024 * 1024;
  const candidates = snapshot({ userFiles });

  if (!candidates.length) {
    const err = new Error("No connected accounts are available for uploads.");
    err.code = "NO_ACCOUNTS";
    // Retrying cannot conjure an account; wait for the user to connect one.
    err.retryable = false;
    throw err;
  }

  const fits = (c) => c.free >= sizeBytes + headroom;

  if (overrideAccountId) {
    const chosen = candidates.find((c) => c.id === overrideAccountId);
    if (chosen && fits(chosen)) return { accountId: chosen.id, ...chosen };
  }

  const eligible = candidates.filter(fits).sort((a, b) => b.free - a.free);
  if (eligible.length) return { accountId: eligible[0].id, ...eligible[0] };

  // No split-across-accounts: a striped file would be unreadable outside
  // MaxDrive and would turn index loss into permanent data loss.
  const best = [...candidates].sort((a, b) => b.free - a.free)[0];
  const err = new Error(
    `No account has room for this file. Largest free slot: ` +
      `${Math.max(Math.floor(best.free / 1024 / 1024), 0)} MB on ${best.email}.`,
  );
  err.code = "NO_SPACE";
  // Eight rounds of backoff will not create space either. Fail now, clearly,
  // and leave the Retry button for once the user has actually freed some.
  err.retryable = false;
  throw err;
}

module.exports = { pickAccountForUpload, snapshot, freeBytes };
