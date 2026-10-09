/**
 * Resumable upload worker for user uploads into the managed tree.
 *
 * The wire protocol lives in uploadCore.cjs (shared with the local-backup
 * engine); this worker owns what is specific to user uploads: account
 * allocation, name dedup in the virtual folder, indexing the finished file,
 * and the quota-exceeded re-allocation dance.
 *
 * Vault mode: a sealed upload is encrypted ONCE to a ciphertext-only temp
 * blob (kept in transfers.temp_path so a retry resumes the same bytes), sent
 * as "<uuid>.mxv", and indexed with only a placeholder name plus seal_meta.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { get: db } = require("../db/database.cjs");
const { accounts, activity, nodes } = require("../db/queries.cjs");
const { nodeId } = require("../sync/scanner.cjs");
const allocation = require("../allocation.cjs");
const accountService = require("../auth/accountService.cjs");
const ops = require("../ops.cjs");
const core = require("./uploadCore.cjs");
const { providerFor } = require("../providers/index.cjs");
const { uploadName } = require("./uploadName.cjs");
const sealMode = require("../vault/sealMode.cjs");
const blob = require("../vault/blobFormat.cjs");
const { mimeOf } = require("../vault/mime.cjs");
const { scope } = require("../logger.cjs");

const log = scope("upload");

const { fail } = core;

/** Records the finished file in the index so it shows up in the tree. */
function indexUploaded(transfer, accountId, file, sealMeta = null) {
  const id = nodeId(accountId, file.id);
  nodes.upsertManaged({
    id,
    parentId: transfer.dest_parent_node_id,
    accountId,
    file,
    size: transfer.size,
    sealMeta,
    name: sealMeta ? sealMode.placeholder(false) : undefined,
  });
  db()
    .prepare("UPDATE transfers SET node_id = ? WHERE id = ?")
    .run(id, transfer.id);
  return id;
}

/**
 * The single place an upload is declared finished, so the resume-probe path and
 * the last-chunk path can never disagree about what "done" means.
 */
async function finalize(transfer, accountId, account, file, size, onProgress, sealMeta) {
  onProgress(size);

  if (!file?.id) {
    // Drive finalized the file but withheld its metadata. The file is real and
    // sits in the MaxDrive folder, so the change feed will adopt it on the next
    // poll - better than inventing a row we cannot key correctly.
    log.warn(`${transfer.name}: finished without metadata, leaving it to sync`);
    await accountService.refreshQuota(accountId, { force: true });
    return { bytes: size };
  }

  const nodeId = indexUploaded(transfer, accountId, file, sealMeta);
  activity.log(nodeId, accountId, "uploaded");
  await accountService.refreshQuota(accountId, { force: true });
  log.info(`uploaded ${sealMeta ? "a sealed file" : file.name} (${size} bytes) to ${account.email}`);
  return { nodeId, bytes: size };
}

/**
 * REST uploads stream into this exact dir (server/routes.cjs); only copies
 * there are ours to remove once sent - never a user's own file.
 */
function isRestUploadCopy(localPath) {
  const dir = path.join(require("electron").app.getPath("temp"), "maxdrive-uploads");
  return path.resolve(path.dirname(localPath)).toLowerCase() === path.resolve(dir).toLowerCase();
}

/**
 * Encrypts the source to a sealed blob once per transfer. A plaintext session
 * left from before vault mode was switched on is dropped - resuming it would
 * finish a plaintext upload.
 */
async function sealedBlob(transfer, setSession) {
  const blobPath = path.join(sealMode.tempDir(), `${transfer.id}.mxv`);
  if (transfer.temp_path === blobPath && fs.existsSync(blobPath)) {
    return { blobPath, fresh: false };
  }
  if (transfer.session_uri) setSession(null, null);
  await blob.encryptFileToPath({
    srcPath: transfer.local_path,
    destPath: blobPath,
    sealTo: sealMode.publicKey(),
  });
  db().prepare("UPDATE transfers SET temp_path = ? WHERE id = ?").run(blobPath, transfer.id);
  return { blobPath, fresh: true };
}

async function upload(
  transfer,
  { signal, onProgress, setSession, setAccount, meta },
) {
  if (!transfer.local_path || !fs.existsSync(transfer.local_path)) {
    throw fail("The file is no longer on disk.", "FILE_MISSING", false);
  }

  // Stamped at enqueue; rows queued before vault mode was enabled are sealed
  // too, so nothing plaintext leaves once the mode is on.
  const sealed = Boolean(meta?.sealed) || sealMode.enabled();
  let source = transfer.local_path;
  let session = { uri: transfer.session_uri, expiresAt: transfer.session_expires_at };
  let sealMeta = null;
  if (sealed) {
    const realName = uploadName(transfer);
    const plainSize = fs.statSync(transfer.local_path).size;
    const { blobPath, fresh } = await sealedBlob(transfer, setSession);
    if (fresh) session = { uri: null, expiresAt: null };
    source = blobPath;
    sealMeta = sealMode.sealMeta({ name: realName, mime: mimeOf(realName), size: plainSize });
  }
  const size = fs.statSync(source).size;

  // Allocate at start time, not enqueue time - free space moves while queued.
  //
  // A live session pins us to the account holding it; re-deciding there would
  // abandon the bytes already uploaded. Otherwise we always go through the
  // allocator, passing any user-pinned account as a preference so that even an
  // explicit choice gets a space check instead of discovering the problem as a
  // 403 halfway through.
  const hasLiveSession =
    Boolean(session.uri) && (session.expiresAt ?? 0) > Date.now();

  let accountId = transfer.account_id;
  if (!accountId || !hasLiveSession) {
    const chosen = allocation.pickAccountForUpload(size, accountId, {
      userFiles: true,
    });
    if (accountId && chosen.accountId !== accountId) {
      log.info(
        `${transfer.name}: ${accountId} cannot hold it, using ${chosen.email}`,
      );
    }
    accountId = chosen.accountId;
    setAccount(accountId);
    log.info(`${transfer.name} → ${chosen.email}`);
  }

  const account = accounts.byId(accountId);
  if (!account) throw fail("That account is gone.", "NO_ACCOUNT", false);

  try {
    const file = await providerFor(account).upload(account, {
      localPath: source,
      size,
      // Lazy: only a fresh session needs a name. The extension is kept, so the
      // backend can sniff (Drive) or look up (S3) the type itself. A sealed
      // blob gets a random name: the remote side learns nothing from it.
      name: () =>
        sealed
          ? `${crypto.randomUUID()}.mxv`
          : ops.uniqueName(transfer.dest_parent_node_id, uploadName(transfer)),
      mime: sealed ? "application/octet-stream" : null,
      session,
      signal,
      onProgress,
      setSession,
    });
    const result = await finalize(transfer, accountId, account, file, size, onProgress, sealMeta);
    if (sealed) fs.rmSync(source, { force: true });
    if (isRestUploadCopy(transfer.local_path)) {
      fs.rmSync(transfer.local_path, { force: true });
    }
    return result;
  } catch (err) {
    if (err.code === "storageQuotaExceeded") {
      // Re-allocate rather than fail: another account probably has room.
      await accountService.refreshQuota(accountId, { force: true });
      if (err.phase === "session") {
        const next = allocation.pickAccountForUpload(size, null, {
          userFiles: true,
        });
        setAccount(next.accountId);
        setSession(null, null);
        throw fail(
          `Moved to ${next.email} - the first account was full.`,
          "REALLOCATED",
        );
      }
      setSession(null, null);
      setAccount(null);
      throw fail(
        "That account filled up mid-upload; retrying elsewhere.",
        "storageQuotaExceeded",
      );
    }
    throw err;
  }
}

module.exports = { upload };
