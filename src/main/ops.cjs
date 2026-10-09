/**
 * Node mutations.
 *
 * Virtual folders (origin 'vfolder') exist only in the index - creating,
 * renaming and moving them is a local write with no API call, which is the
 * whole point of the virtual tree. Mirrored and managed nodes mirror the change
 * to their storage account too, through providers/ (Drive or S3).
 */
const crypto = require("node:crypto");
const { get: db } = require("./db/database.cjs");
const {
  nodes,
  accounts,
  activity,
  MANAGED_ROOT_ID,
} = require("./db/queries.cjs");
const { providerFor } = require("./providers/index.cjs");
const sealMode = require("./vault/sealMode.cjs");
const { nodeId } = require("./sync/scanner.cjs");
const { scope } = require("./logger.cjs");

const log = scope("ops");

let notify = () => {};
function setNotifier(fn) {
  notify = fn;
}

function changed(parentIds) {
  notify({ parentIds: [...new Set(parentIds.filter(Boolean))] });
}

/** True when a node is backed by a real object on a storage account. */
const isRemote = (node) =>
  Boolean(node.drive_file_id && node.account_id && node.drive_file_id !== "root");

/** The account row and its provider module, for a remote node. */
function backendOf(node) {
  const account = accounts.byId(node.account_id) || { id: node.account_id };
  return { account, provider: providerFor(account) };
}

function requireNode(id) {
  const node = nodes.byId(id);
  if (!node) throw new Error("That item no longer exists.");
  return node;
}

/** Drive tolerates duplicate names; a local tree is far easier to read without them. */
function uniqueName(parentId, name) {
  const siblings = db()
    .prepare("SELECT name FROM nodes WHERE parent_id IS ? AND trashed = 0")
    .all(parentId)
    .map((r) => r.name.toLowerCase());
  return freeName(name, (n) => siblings.includes(n.toLowerCase()));
}

/** "report.pdf" -> "report (2).pdf" ... until `taken(candidate)` is false. */
function freeName(name, taken) {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

function mkdir({ parentId, name = "Untitled folder" } = {}) {
  // The renderer sends null for "no specific folder open"; a default parameter
  // only catches undefined, so normalise here or requireNode(null) throws.
  parentId = parentId || MANAGED_ROOT_ID;
  const parent = parentId === MANAGED_ROOT_ID ? null : requireNode(parentId);
  if (parent && !parent.is_folder)
    throw new Error("That destination is not a folder.");

  // Only the virtual tree accepts new folders for now; a folder inside a
  // mirrored Drive would need a matching remote folder to be useful.
  if (parent && parent.origin === "mirrored") {
    throw new Error(
      "New folders can only be created inside MaxDrive at the moment.",
    );
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const realName = name.trim() || "Untitled folder";
  // Vault mode: a new folder's name is sealed like a file's - folder names
  // say plenty on their own, and the index snapshot leaves this PC.
  const sealed = sealMode.enabled();
  db()
    .prepare(
      `INSERT INTO nodes (id, parent_id, origin, name, is_folder, status, updated_at, created_at, modified_at, seal_meta)
       VALUES (?, ?, 'vfolder', ?, 1, 'ok', ?, ?, ?, ?)`,
    )
    .run(
      id,
      parentId,
      sealed ? sealMode.placeholder(true) : uniqueName(parentId, realName),
      now,
      now,
      now,
      sealed ? sealMode.sealMeta({ name: realName }) : null,
    );

  activity.log(id, null, "created");
  log.info(`created folder ${id} under ${parentId}`);
  changed([parentId]);
  return nodes.byId(id);
}

async function rename({ id, name }) {
  const node = requireNode(id);
  const next = (name || "").trim();
  if (!next) throw new Error("A name is required.");

  if (node.seal_meta) return renameSealed(node, next);

  // Remote first: a refused rename (an S3 folder, a taken name) must leave the
  // index untouched rather than showing a name the storage doesn't have.
  if (isRemote(node)) {
    const { account, provider } = backendOf(node);
    const fileId = await provider.rename(account, node, next);
    if (fileId !== node.drive_file_id) {
      // S3 renames are copy + delete: the object, and so the node id, moved.
      const newId = nodeId(account.id, fileId);
      nodes.rekey(id, { id: newId, accountId: account.id, fileId });
      id = newId;
    }
  }

  db()
    .prepare("UPDATE nodes SET name = ?, updated_at = ? WHERE id = ?")
    .run(next, Date.now(), id);

  activity.log(id, node.account_id, "renamed", `${node.name} → ${next}`);
  changed([node.parent_id]);
  return nodes.byId(id);
}

/**
 * A sealed item's name lives only in seal_meta: re-seal it (unlock needed to
 * read the old metadata) and leave the remote object's random name alone. No
 * activity detail - it would put the names back in the DB in plaintext.
 */
function renameSealed(node, next) {
  const meta = sealMode.realMeta(node);
  db()
    .prepare("UPDATE nodes SET seal_meta = ?, updated_at = ? WHERE id = ?")
    .run(sealMode.sealMeta({ ...meta, name: next }), Date.now(), node.id);
  activity.log(node.id, node.account_id, "renamed");
  changed([node.parent_id]);
  return nodes.byId(node.id);
}

/** Virtual moves are index-only; the bytes never move between accounts here. */
function move({ ids = [], newParentId }) {
  newParentId = newParentId || MANAGED_ROOT_ID;
  const target =
    newParentId === MANAGED_ROOT_ID ? null : requireNode(newParentId);
  if (target && !target.is_folder)
    throw new Error("That destination is not a folder.");

  const touched = [newParentId];
  const update = db().prepare(
    "UPDATE nodes SET parent_id = ?, updated_at = ? WHERE id = ?",
  );
  const run = db().transaction(() => {
    for (const id of ids) {
      const node = requireNode(id);
      if (isAncestor(id, newParentId)) {
        throw new Error(`"${node.name}" cannot be moved inside itself.`);
      }
      touched.push(node.parent_id);
      update.run(newParentId, Date.now(), id);
      activity.log(id, node.account_id, "moved");
    }
  });
  run();

  changed(touched);
  return nodes.children(newParentId);
}

/** Guards the one move that would silently detach a whole subtree (self included). */
function isAncestor(possibleAncestorId, id) {
  return nodes.path(id).some((n) => n.id === possibleAncestorId);
}

/**
 * Trash and restore both cascade.
 *
 * Trashing only the folder row would leave its files indexed but unreachable:
 * gone from browse, absent from Trash, still occupying Drive quota. The whole
 * subtree moves together, and only the item the user picked is listed in Trash.
 */
async function setTrashed(ids, trashed) {
  const touched = [];
  const at = Date.now();
  const mark = db().prepare(
    "UPDATE nodes SET trashed = ?, updated_at = ? WHERE id = ?",
  );

  for (const id of ids) {
    const root = requireNode(id);
    touched.push(root.parent_id);

    for (const node of subtree(id)) {
      mark.run(trashed ? 1 : 0, at, node.id);
      if (isRemote(node)) {
        const { account, provider } = backendOf(node);
        await provider.setTrashed(account, node.drive_file_id, trashed);
      }
    }

    activity.log(id, root.account_id, trashed ? "trashed" : "restored");
  }

  changed(touched);
}

const trash = ({ ids = [] }) => setTrashed(ids, true);
const restore = ({ ids = [] }) => setTrashed(ids, false);

/** Collects a node and all its descendants, deepest first, so deletes cascade cleanly. */
function subtree(id) {
  const out = [];
  const walk = (nodeId) => {
    const node = nodes.byId(nodeId);
    if (!node) return;
    const kids = db()
      .prepare("SELECT id FROM nodes WHERE parent_id = ?")
      .all(nodeId);
    for (const kid of kids) walk(kid.id);
    out.push(node);
  };
  walk(id);
  return out;
}

/**
 * Permanent delete: remote bytes first, index rows second, so a network failure
 * midway leaves rows pointing at files that still exist (recoverable) rather
 * than files with no index entry (invisible).
 */
async function deleteForever({ ids = [] }) {
  const touched = [];
  for (const id of ids) {
    for (const node of subtree(id)) {
      touched.push(node.parent_id);
      if (isRemote(node)) {
        const { account, provider } = backendOf(node);
        await provider.remove(account, node.drive_file_id);
      }
      db().prepare("DELETE FROM nodes WHERE id = ?").run(node.id);
    }
  }
  changed(touched);
}

async function star({ id, starred }) {
  const node = requireNode(id);
  db()
    .prepare("UPDATE nodes SET starred = ?, updated_at = ? WHERE id = ?")
    .run(starred ? 1 : 0, Date.now(), id);
  if (isRemote(node)) {
    const { account, provider } = backendOf(node);
    await provider.setStarred(account, node.drive_file_id, Boolean(starred));
  }
  changed([node.parent_id]);
  return nodes.byId(id);
}

/**
 * Duplicates files into a virtual folder.
 *
 * The storage copies the bytes server-side (Drive files.copy, S3 CopyObject),
 * so this costs one request per file rather
 * than a download and re-upload - but it cannot copy between accounts, so each
 * copy stays on the account that holds the original. The new row is `managed`
 * and hangs under the requested virtual parent, which is how one virtual folder
 * ends up holding files from several accounts.
 *
 * Folders are refused: copying one means walking its subtree, and a partial
 * recursive copy is worse than no copy at all.
 */
async function copy({ ids = [], newParentId } = {}) {
  const parentId = newParentId || MANAGED_ROOT_ID;
  if (parentId !== MANAGED_ROOT_ID) {
    const parent = requireNode(parentId);
    if (!parent.is_folder) throw new Error("That destination is not a folder.");
  }

  const made = [];
  for (const id of ids) {
    const node = requireNode(id);
    if (node.is_folder) throw new Error("Folders cannot be copied yet.");
    if (!isRemote(node)) {
      throw new Error(`${node.name} is not stored on an account.`);
    }

    // A sealed copy stays sealed: same ciphertext, same seal_meta, new random name.
    const name = node.seal_meta
      ? `${crypto.randomUUID()}.mxv`
      : uniqueName(parentId, node.name);
    const { account, provider } = backendOf(node);
    const file = await provider.copy(account, node, name);

    const newId = nodeId(node.account_id, file.id);
    nodes.upsertManaged({
      id: newId,
      parentId,
      accountId: node.account_id,
      file,
      name: node.seal_meta ? node.name : name,
      mime: node.mime,
      size: node.size,
      sealMeta: node.seal_meta || null,
    });

    activity.log(newId, node.account_id, "created", `copied from ${node.name}`);
    made.push(newId);
  }

  log.info(`copied ${made.length} file(s) into ${parentId}`);
  changed([parentId]);
  return { copied: made.length, ids: made };
}

module.exports = {
  mkdir,
  rename,
  move,
  copy,
  trash,
  restore,
  deleteForever,
  star,
  uniqueName,
  freeName,
  subtree,
  setNotifier,
};
