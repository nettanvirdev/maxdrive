/**
 * Public link sharing: permissions.create(type=anyone, role=reader) plus the
 * file's webViewLink. Revoking deletes that permission again.
 */
const { get: db } = require("../db/database.cjs");
const { nodes, activity } = require("../db/queries.cjs");
const { json } = require("../auth/googleClient.cjs");
const { API, deleteIgnore404 } = require("./driveApi.cjs");
const { scope } = require("../logger.cjs");

const log = scope("share");

function requireDriveNode(id) {
  const node = nodes.byId(id);
  if (!node) throw new Error("That item no longer exists.");
  if (!node.drive_file_id || !node.account_id) {
    throw new Error(
      "Virtual folders can't be shared - they only exist inside MaxDrive.",
    );
  }
  if (node.seal_meta) {
    // A link would hand out ciphertext under a random name - useless, and it
    // advertises that the file exists.
    throw new Error("Encrypted files can't be shared by link.");
  }
  return node;
}

async function createLink({ nodeId }) {
  const node = requireDriveNode(nodeId);
  if (node.share_link) return { link: node.share_link };

  const permission = await json(
    node.account_id,
    `${API}/files/${node.drive_file_id}/permissions?fields=id`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "anyone", role: "reader" }),
    },
  );
  const meta = await json(
    node.account_id,
    `${API}/files/${node.drive_file_id}?fields=webViewLink`,
  );

  db()
    .prepare(
      "UPDATE nodes SET share_link = ?, share_permission_id = ?, updated_at = ? WHERE id = ?",
    )
    .run(meta.webViewLink, permission.id, Date.now(), nodeId);
  activity.log(nodeId, node.account_id, "shared");
  log.info(`shared ${node.name}`);
  return { link: meta.webViewLink };
}

async function revoke({ nodeId }) {
  const node = requireDriveNode(nodeId);
  if (node.share_permission_id) {
    await deleteIgnore404(
      node.account_id,
      `/files/${node.drive_file_id}/permissions/${node.share_permission_id}`,
      (status) => `Could not revoke the link (${status}).`,
    );
  }
  db()
    .prepare(
      "UPDATE nodes SET share_link = NULL, share_permission_id = NULL, updated_at = ? WHERE id = ?",
    )
    .run(Date.now(), nodeId);
  log.info(`unshared ${node.name}`);
  return { link: null };
}

/** Everyone the file is shared with, excluding the owner's own entry. */
async function listPermissions({ nodeId }) {
  const node = requireDriveNode(nodeId);
  const data = await json(
    node.account_id,
    `${API}/files/${node.drive_file_id}/permissions` +
      `?fields=permissions(id,type,role,emailAddress,displayName,photoLink)`,
  );
  return (data.permissions || [])
    .filter((p) => p.role !== "owner")
    .map((p) => ({
      id: p.id,
      type: p.type,
      role: p.role,
      email:
        p.emailAddress ||
        (p.type === "anyone" ? "Anyone with the link" : "Unknown"),
      name: p.displayName || null,
    }));
}

/**
 * Share with a specific person. `notify` sends Google's own invitation email —
 * off by default, since for a personal multi-account setup the other side is
 * usually the same human.
 */
async function addPerson({ nodeId, email, role = "reader", notify = false }) {
  const node = requireDriveNode(nodeId);
  const address = (email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    throw new Error("Enter a valid email address.");
  }
  if (!["reader", "writer", "commenter"].includes(role)) {
    throw new Error(`Unsupported role "${role}".`);
  }

  const permission = await json(
    node.account_id,
    `${API}/files/${node.drive_file_id}/permissions` +
      `?fields=id&sendNotificationEmail=${notify ? "true" : "false"}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "user", role, emailAddress: address }),
    },
  );
  activity.log(nodeId, node.account_id, "shared", `with ${address} (${role})`);
  log.info(`shared ${node.name} with ${address} as ${role}`);
  return { id: permission.id };
}

async function removePermission({ nodeId, permissionId }) {
  const node = requireDriveNode(nodeId);
  await deleteIgnore404(
    node.account_id,
    `/files/${node.drive_file_id}/permissions/${permissionId}`,
    (status) => `Could not remove that person (${status}).`,
  );
  // Removing the "anyone" permission by hand must also clear the cached link.
  if (node.share_permission_id === permissionId) {
    db()
      .prepare(
        "UPDATE nodes SET share_link = NULL, share_permission_id = NULL WHERE id = ?",
      )
      .run(nodeId);
  }
  return { removed: permissionId };
}

module.exports = {
  createLink,
  revoke,
  listPermissions,
  addPerson,
  removePermission,
};
