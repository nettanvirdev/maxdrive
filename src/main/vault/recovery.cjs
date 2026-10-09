/**
 * Rebuilding a vault from Drive alone.
 *
 * This is the answer to "my laptop died". Everything needed lives in the
 * `.vault` folders: `vault.cfg` (the wrapped master key), `index.snap` (the
 * encrypted file listing) and the blobs themselves. With the password - or the
 * recovery key - the whole vault comes back on a machine that has never seen
 * it, and without either secret none of it is readable to anyone.
 *
 * Blobs that the snapshot doesn't mention are still recovered: each `.mxv`
 * header carries its own wrapped key, so the contents survive even when the
 * name (which only ever lived encrypted in the snapshot) does not.
 */
const { randomUUID } = require("node:crypto");
const {
  accounts,
  vaultAccounts,
  vaultConfig,
  vaultCopies,
  vaultItems,
} = require("../db/queries.cjs");
const accountService = require("../auth/accountService.cjs");
const drive = require("../drive/driveApi.cjs");
const { scope } = require("../logger.cjs");
const crypto = require("./crypto.cjs");
const session = require("./session.cjs");

const log = scope("vaultRecovery");

const { fail } = crypto;

async function vaultFolderOf(accountId) {
  const account = accounts.byId(accountId);
  if (!account?.app_folder_id) return null;
  if (account.vault_folder_id) return account.vault_folder_id;
  const children = await drive.listChildren(accountId, account.app_folder_id);
  const found = children.find((f) => f.name === ".vault");
  if (found) accounts.setVaultFolder(accountId, found.id);
  return found?.id || null;
}

/**
 * Look for a vault on every connected account. Returns the newest config found
 * (highest `rev` wins - a password change bumps it), without unlocking
 * anything: knowing a vault exists reveals nothing about its contents.
 */
async function scan() {
  const candidates = [];
  for (const account of accounts.active()) {
    try {
      const folderId = await vaultFolderOf(account.id);
      if (!folderId) continue;
      const children = await drive.listChildren(
        account.id,
        folderId,
        "modifiedTime",
      );
      const cfg = children.find((f) => f.name === "vault.cfg");
      if (!cfg) continue;
      const buffer = await drive.downloadBuffer(account.id, cfg.id);
      const configRow = crypto.parseCfgFile(buffer);
      candidates.push({
        accountId: account.id,
        email: account.email,
        rev: configRow.rev,
        configRow,
        blobs: children.filter((f) => f.name.endsWith(".mxv")).length,
      });
    } catch (err) {
      log.warn(`vault scan failed on ${account.email}: ${err.message}`);
    }
  }
  candidates.sort((a, b) => b.rev - a.rev);
  const best = candidates[0] || null;
  return {
    found: Boolean(best),
    accounts: candidates.map(({ accountId, email, rev, blobs }) => ({
      accountId,
      email,
      rev,
      blobs,
    })),
    // The row itself is only kept in memory for the follow-up run() call.
    rev: best?.rev ?? null,
  };
}

/**
 * Adopt the vault found on Drive: verify the secret, persist the config, then
 * rebuild the item and copy tables from the snapshot plus a listing of every
 * `.vault` folder.
 */
async function run({ secret, recovery = false } = {}) {
  const found = [];
  for (const account of accounts.active()) {
    const folderId = await vaultFolderOf(account.id);
    if (!folderId) continue;
    const children = await drive.listChildren(
      account.id,
      folderId,
      "modifiedTime",
    );
    const cfg = children.find((f) => f.name === "vault.cfg");
    if (!cfg) continue;
    const configRow = crypto.parseCfgFile(
      await drive.downloadBuffer(account.id, cfg.id),
    );
    found.push({ account, folderId, children, configRow });
  }
  if (!found.length)
    throw fail("No vault was found in your accounts.", "VAULT_MISSING");

  found.sort((a, b) => b.configRow.rev - a.configRow.rev);
  const newest = found[0].configRow;

  // Verify before writing anything: a wrong password must leave the machine
  // exactly as it was.
  const { vmk } = crypto.unlockConfig(newest, secret, { recovery });

  vaultConfig.upsert(newest);
  session.adopt(vmk);

  // Start clean: a half-recovered vault mixed with stale rows would be worse
  // than either state alone.
  vaultCopies.clear();
  vaultItems.clear();

  // Newest snapshot across all accounts wins.
  let snapshot = null;
  let snapshotAt = -1;
  for (const entry of found) {
    const snap = entry.children.find((f) => f.name === "index.snap");
    if (!snap) continue;
    try {
      const buffer = await drive.downloadBuffer(entry.account.id, snap.id);
      const parsed = crypto.decryptMeta(vmk, buffer);
      const at = parsed.at || 0;
      if (at > snapshotAt) {
        snapshot = parsed;
        snapshotAt = at;
      }
    } catch (err) {
      log.warn(`snapshot on ${entry.account.email} unreadable: ${err.message}`);
    }
  }

  const byBlobUuid = new Map();
  if (snapshot?.items) {
    // Folders first so a child's parent always exists (FK is enforced).
    const ordered = [...snapshot.items].sort(
      (a, b) => Number(b.isFolder) - Number(a.isFolder),
    );
    for (const entry of ordered) {
      vaultItems.insert({
        id: entry.id,
        parent_id: entry.parentId || null,
        is_folder: entry.isFolder ? 1 : 0,
        meta_ct: crypto.encryptMeta(
          vmk,
          entry.meta || { name: "Recovered item" },
        ),
        size: entry.size || 0,
        blob_uuid: entry.blobUuid || null,
        blob_size: entry.blobSize || null,
        chunk_size: entry.chunkSize || null,
        blob_md5: entry.blobMd5 || null,
        plaintext_sha256: entry.plaintextSha256 || null,
        created_at: entry.createdAt || Date.now(),
        modified_at: entry.modifiedAt || Date.now(),
        state: "active",
      });
      if (entry.blobUuid) byBlobUuid.set(entry.blobUuid, entry.id);
    }
  }

  // Match the blobs actually present against the rebuilt items.
  let orphans = 0;
  for (const entry of found) {
    vaultAccounts.insert({
      account_id: entry.account.id,
      last_ok_at: Date.now(),
    });
    accounts.setVaultFolder(entry.account.id, entry.folderId);
    for (const file of entry.children) {
      if (!file.name.endsWith(".mxv")) continue;
      const uuid = file.name.replace(/\.mxv$/, "");
      let itemId = byBlobUuid.get(uuid);

      if (!itemId) {
        // Uploaded after the last snapshot. The header holds the key, so the
        // bytes are recoverable - only the original name is lost.
        itemId = randomUUID();
        vaultItems.insert({
          id: itemId,
          is_folder: 0,
          meta_ct: crypto.encryptMeta(vmk, {
            name: `Recovered ${uuid.slice(0, 8)}`,
            mime: null,
          }),
          blob_uuid: uuid,
          blob_size: Number(file.size) || null,
          created_at: Date.parse(file.createdTime || "") || Date.now(),
          modified_at: Date.now(),
          state: "active",
        });
        byBlobUuid.set(uuid, itemId);
        orphans += 1;
      }

      vaultCopies.upsert({
        item_id: itemId,
        account_id: entry.account.id,
        drive_file_id: file.id,
        state: "ok",
      });
    }
  }

  // Items the snapshot promised but whose blobs are nowhere: keep the row so
  // the user can see what is missing rather than silently losing the name.
  let missing = 0;
  for (const item of vaultItems.all()) {
    if (item.is_folder || vaultCopies.forItem(item.id).length) continue;
    missing += 1;
  }

  log.info(
    `vault recovered: ${vaultItems.count()} item(s), ${orphans} unnamed, ${missing} missing`,
  );
  return {
    items: vaultItems.count(),
    accounts: found.length,
    unnamed: orphans,
    missing,
  };
}

module.exports = { scan, run };
