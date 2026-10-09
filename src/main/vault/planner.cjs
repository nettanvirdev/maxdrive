/**
 * Decides where secure blobs should live - pure functions over plain data, so
 * the redundancy rules can be reasoned about (and tested) without touching
 * Drive or the database.
 *
 * Two rules dominate everything else:
 *   1. Never delete the last usable copy of a file. An over-replication tidy-up
 *      or an account removal must degrade availability, never destroy data.
 *   2. An unreachable account still counts as holding its copies. Treating a
 *      disconnected account as empty would re-upload the whole vault the moment
 *      a token expired.
 */

const HEALTH_OK = "ok";

/** Free bytes an account can still take, honouring the caller's headroom. */
function freeFor(account) {
  if (account.freeBytes == null) return Infinity;
  return Math.max(0, account.freeBytes);
}

const isUsable = (account) =>
  account.state !== "draining" && account.health === HEALTH_OK;

/**
 * @param {object} input
 * @param {Array} input.items      files (folders have no blobs to place)
 * @param {Array} input.copies     {item_id, account_id, state}
 * @param {Array} input.accounts   {accountId, state, health, freeBytes}
 * @param {number} input.desiredCopies
 * @returns {Array} actions: replicate | deleteCopy | drainComplete | blocked
 */
function plan({
  items = [],
  copies = [],
  accounts = [],
  desiredCopies = 1,
} = {}) {
  const actions = [];
  const byAccount = new Map(accounts.map((a) => [a.accountId, a]));
  const known = new Set(accounts.map((a) => a.accountId));

  // Mutable free-space budget: two replications planned in one pass must not
  // both be promised the same gigabyte.
  const budget = new Map(accounts.map((a) => [a.accountId, freeFor(a)]));

  const copiesByItem = new Map();
  for (const copy of copies) {
    if (!copiesByItem.has(copy.item_id)) copiesByItem.set(copy.item_id, []);
    copiesByItem.get(copy.item_id).push(copy);
  }

  const drainingWithCopies = new Set();

  for (const item of items) {
    if (item.is_folder) continue;
    const mine = copiesByItem.get(item.id) || [];
    const live = mine.filter(
      (c) =>
        c.state === "ok" || c.state === "pending" || c.state === "uploading",
    );

    // Copies on accounts the user removed from the vault are no longer counted
    // as coverage, but they are also not deleted here - removal has its own
    // deliberate flow.
    const held = live.filter((c) => known.has(c.account_id));
    const onDraining = held.filter(
      (c) => byAccount.get(c.account_id)?.state === "draining",
    );
    const onKeepers = held.filter(
      (c) => byAccount.get(c.account_id)?.state !== "draining",
    );

    for (const copy of onDraining) drainingWithCopies.add(copy.account_id);

    const need = Math.max(0, desiredCopies - onKeepers.length);
    if (need > 0) {
      const source = held.find((c) => c.state === "ok") || null;
      const taken = new Set(held.map((c) => c.account_id));
      const size = item.blob_size || item.size || 0;

      for (let i = 0; i < need; i += 1) {
        const target = accounts
          .filter((a) => isUsable(a) && !taken.has(a.accountId))
          .filter((a) => (budget.get(a.accountId) ?? Infinity) >= size)
          .sort(
            (a, b) =>
              (budget.get(b.accountId) ?? 0) - (budget.get(a.accountId) ?? 0),
          )[0];

        if (!target) {
          const anyRoom = accounts.some(
            (a) => isUsable(a) && !taken.has(a.accountId),
          );
          actions.push({
            type: "blocked",
            itemId: item.id,
            reason: anyRoom ? "quota" : "no-target",
          });
          break;
        }
        taken.add(target.accountId);
        budget.set(
          target.accountId,
          (budget.get(target.accountId) ?? Infinity) - size,
        );
        actions.push({
          type: "replicate",
          itemId: item.id,
          toAccountId: target.accountId,
          fromAccountId: source?.account_id || null,
          size,
        });
      }
    }

    // Trim only genuine surplus, and only once the survivors are confirmed 'ok'
    // - dropping a copy while its replacement is still uploading would open a
    // window where the file exists nowhere complete.
    const confirmed = onKeepers.filter((c) => c.state === "ok");
    if (confirmed.length > desiredCopies) {
      const surplus = confirmed
        .slice()
        .sort(
          (a, b) =>
            freeFor(byAccount.get(a.account_id) || {}) -
            freeFor(byAccount.get(b.account_id) || {}),
        )
        .slice(0, confirmed.length - desiredCopies);
      for (const copy of surplus) {
        actions.push({
          type: "deleteCopy",
          itemId: item.id,
          accountId: copy.account_id,
        });
      }
    }
  }

  // A draining account is done when nothing of ours is left on it.
  for (const account of accounts) {
    if (
      account.state === "draining" &&
      !drainingWithCopies.has(account.accountId)
    ) {
      actions.push({ type: "drainComplete", accountId: account.accountId });
    }
  }

  return actions;
}

/**
 * What the user is about to lose by dropping an account from the vault:
 * `soleItems` are the files whose only remaining copy sits there.
 */
function removalImpact({ items = [], copies = [], accountId }) {
  const byItem = new Map();
  for (const copy of copies) {
    if (!byItem.has(copy.item_id)) byItem.set(copy.item_id, []);
    byItem.get(copy.item_id).push(copy);
  }
  const soleItems = [];
  let totalHere = 0;
  for (const item of items) {
    if (item.is_folder) continue;
    const mine = byItem.get(item.id) || [];
    const here = mine.find(
      (c) => c.account_id === accountId && c.state === "ok",
    );
    if (!here) continue;
    totalHere += 1;
    const elsewhere = mine.some(
      (c) => c.account_id !== accountId && c.state === "ok",
    );
    if (!elsewhere) soleItems.push(item);
  }
  return { soleItems, totalHere };
}

module.exports = { plan, removalImpact };
