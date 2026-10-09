/**
 * Shapes internal DB rows into stable, camelCase JSON for LAN clients (mobile
 * apps, AI via MCP). Keeping this in one place means the wire contract does not
 * drift as the DB projection changes. PURE.
 */

/** A node row (from queries.nodes.* / NODE_SELECT) → API object. */
function node(raw) {
  // Vault-mode rows: real name while unlocked, placeholder while locked.
  const n = require("../vault/sealMode.cjs").reveal(raw);
  if (!n) return null;
  const isFolder = Boolean(n.is_folder);
  return {
    id: n.id,
    parentId: n.parent_id ?? null,
    name: n.name,
    isFolder,
    origin: n.origin, // vfolder | managed | mirrored
    mime: n.mime ?? null,
    size: n.size ?? 0,
    md5: n.md5 ?? null,
    createdAt: n.created_at ?? null,
    modifiedAt: n.modified_at ?? null,
    starred: Boolean(n.starred),
    trashed: Boolean(n.trashed),
    status: n.status, // ok | orphaned | missing_remote
    isGoogleDoc: Boolean(n.is_google_doc),
    webViewLink: n.web_view_link ?? null,
    accountId: n.account_id ?? null,
    accountEmail: n.account_email ?? null,
    accountProvider: n.account_provider ?? null,
    parentName: n.parent_name ?? null,
    // Capability hints so a client knows which media endpoints will work.
    sealed: Boolean(n.sealed),
    sealLocked: Boolean(n.sealLocked),
    hasThumbnail:
      !isFolder &&
      Boolean(n.drive_file_id) &&
      Boolean(n.account_id) &&
      n.account_provider !== "s3" &&
      !n.sealed,
    hasBytes:
      !isFolder && Boolean(n.drive_file_id) && !n.is_google_doc,
  };
}

function nodes(list) {
  return (list || []).map(node);
}

/** accounts.list() rows → quota summary the storage view needs. */
function storage(accounts) {
  const perAccount = (accounts || []).map((a) => ({
    id: a.id,
    email: a.email,
    provider: a.provider || "gdrive",
    displayName: a.display_name ?? null,
    photoUrl: a.photo_url ?? null,
    authState: a.auth_state,
    limit: a.quota_limit ?? null,
    usage: a.quota_usage ?? null,
    usageInDrive: a.quota_usage_drive ?? null,
    free:
      a.quota_limit != null && a.quota_usage != null
        ? Math.max(0, a.quota_limit - a.quota_usage)
        : null,
  }));
  const totals = perAccount.reduce(
    (acc, a) => {
      if (a.limit != null) acc.limit += a.limit;
      if (a.usage != null) acc.usage += a.usage;
      if (a.free != null) acc.free += a.free;
      return acc;
    },
    { limit: 0, usage: 0, free: 0 },
  );
  return { accounts: perAccount, totals };
}

/** accounts.list() rows → public account list (no tokens, no folder ids). */
function accounts(list) {
  return (list || []).map((a) => ({
    id: a.id,
    email: a.email,
    displayName: a.display_name ?? null,
    photoUrl: a.photo_url ?? null,
    authState: a.auth_state,
  }));
}

/** A transfers row → API object (upload/download/backup/vault job status). */
function transfer(t) {
  if (!t) return null;
  return {
    id: t.id,
    kind: t.kind, // upload | download | migrate | backup | restore | vaultUp | vaultDown
    state: t.state, // queued | allocating | running | paused | done | canceled | failed
    name: t.name ?? null,
    size: t.size ?? 0,
    bytesDone: t.bytes_done ?? 0,
    nodeId: t.node_id ?? null,
    destParentId: t.dest_parent_node_id ?? null,
    accountEmail: t.account_email ?? null,
    pausedBy: t.paused_by ?? null,
    attempts: t.attempts ?? 0,
    error: t.error_message ?? t.error_code ?? null,
    updatedAt: t.updated_at ?? null,
  };
}

function transfers(list) {
  return (list || []).map(transfer);
}

module.exports = { node, nodes, storage, accounts, transfer, transfers };
