/**
 * Queue worker for kind 'backup': one file of a backup set → its place in the
 * hidden `.backup` tree. Reuses the resumable protocol from uploadCore.
 *
 * Unlike the user uploader, this never touches the nodes table - the cloud
 * copy is recorded in backup_entries, and only after Drive's md5 matches the
 * local file (the entry is what restore trusts, so it must never lie).
 */
const fs = require("node:fs");
const { get: db } = require("../db/database.cjs");
const {
  backupSets,
  backupEntries,
  archiveParts,
} = require("../db/queries.cjs");
const allocation = require("../allocation.cjs");
const accountService = require("../auth/accountService.cjs");
const drive = require("../drive/driveApi.cjs");
const core = require("../drive/uploadCore.cjs");
const { ensureFolderChain, relDirOf } = require("./folders.cjs");
const { scope } = require("../logger.cjs");

const log = scope("backupWorker");
const { fail } = core;

function writeMeta(transferId, meta) {
  db()
    .prepare("UPDATE transfers SET meta = ? WHERE id = ?")
    .run(JSON.stringify(meta), transferId);
}

async function backup(
  transfer,
  { signal, meta, onProgress, setSession, setAccount },
) {
  const set = backupSets.byId(meta.setId);
  if (!set) throw fail("Backup set no longer exists.", "SET_GONE", false);

  // Archive parts are temp files the archive builder is waiting on - a missing
  // one is fatal for the run, not skippable.
  if (meta.archivePartId) {
    if (!transfer.local_path || !fs.existsSync(transfer.local_path)) {
      throw fail(
        "Archive part vanished before upload.",
        "ARCHIVE_PART_MISSING",
        false,
      );
    }
    return uploadArchivePart(transfer, meta, set, {
      signal,
      onProgress,
      setSession,
      setAccount,
    });
  }

  // Re-stat: the file may have changed (or vanished) since the run scanned it.
  if (!transfer.local_path || !fs.existsSync(transfer.local_path)) {
    backupEntries.setState(
      meta.setId,
      meta.relPath,
      "skipped",
      "missing at upload time",
    );
    return { bytes: 0 };
  }
  const stat = fs.statSync(transfer.local_path);
  const size = stat.size;
  const mtime = Math.round(stat.mtimeMs);

  // Hash before uploading: this is both the integrity check (compared against
  // Drive's md5Checksum at the end) and the mid-upload change detector.
  const localMd5 = await core.hashFile(transfer.local_path);
  if (signal.aborted) throw fail("Stopped.", "ABORTED", false);

  let accountId = transfer.account_id;
  if (!accountId) {
    accountId = allocation.pickAccountForUpload(
      size,
      set.primary_account_id,
    ).accountId;
    setAccount(accountId);
    meta.driveParentId = await ensureFolderChain(
      meta.setId,
      accountId,
      relDirOf(meta.relPath),
    );
    writeMeta(transfer.id, meta);
  }

  const name = meta.relPath.slice(meta.relPath.lastIndexOf("/") + 1);
  const isUpdate = meta.op === "update" && meta.fileId;

  try {
    const { file } = await core.uploadResumable({
      accountId,
      localPath: transfer.local_path,
      size,
      createSession: () =>
        isUpdate
          ? core.openSession(accountId, {
              // A new revision of the same file: identity and Drive's revision
              // history are preserved (≈30 days of previous versions for free).
              url: core.updateFileSessionUrl(meta.fileId),
              method: "PATCH",
              size,
              mimeType: null,
              body: null,
            })
          : core.openSession(accountId, {
              url: core.createFileSessionUrl(),
              method: "POST",
              size,
              mimeType: null,
              body: { name, parents: [meta.driveParentId] },
            }),
      session: {
        uri: transfer.session_uri,
        expiresAt: transfer.session_expires_at,
      },
      onSessionInvalid: () => setSession(null, null),
      signal,
      onProgress,
      setSession,
    });

    let uploaded = file;
    if (!uploaded?.id) {
      // Drive finalized but withheld the metadata. Unlike user uploads there is
      // no change-feed to adopt the file (the tree is hidden), so look it up.
      if (isUpdate) {
        uploaded = { id: meta.fileId, md5Checksum: null };
      } else {
        const children = await drive.listChildren(
          accountId,
          meta.driveParentId,
          "md5Checksum",
        );
        uploaded = children.find((f) => f.name === name) || null;
      }
    }
    if (!uploaded?.id) {
      throw fail(
        "Drive finalized the upload but it could not be located.",
        "LOST_UPLOAD",
      );
    }

    if (uploaded.md5Checksum && uploaded.md5Checksum !== localMd5) {
      // The file changed while we were reading it. The bytes on Drive are a
      // torn copy - leave the entry pending so the next run replaces them.
      backupEntries.upsert({
        set_id: meta.setId,
        rel_path: meta.relPath,
        size,
        mtime,
        account_id: accountId,
        drive_file_id: uploaded.id,
        state: "pending",
        error: "changed during upload",
      });
      log.warn(
        `${meta.relPath}: changed during upload, will re-back up next run`,
      );
      return { bytes: size };
    }

    backupEntries.markOk(meta.setId, meta.relPath, {
      size,
      mtime,
      md5: uploaded.md5Checksum || localMd5,
      accountId,
      driveFileId: uploaded.id,
    });

    // A spill replaced a file that lives on a now-full account; retire the old
    // copy best-effort (its bytes are the reason the account is full).
    if (meta.replacedFileId && meta.replacedAccountId) {
      drive
        .patchFile(meta.replacedAccountId, meta.replacedFileId, {
          trashed: true,
        })
        .catch((err) =>
          log.warn(`could not trash replaced copy: ${err.message}`),
        );
    }

    return { bytes: size };
  } catch (err) {
    if (err.code === "storageQuotaExceeded") {
      // Sticky-with-spill: refresh, pick another account, and turn an update
      // into a fresh create there (a new revision can't move accounts).
      await accountService.refreshQuota(accountId, { force: true });
      const next = allocation.pickAccountForUpload(size);
      const nextParent = await ensureFolderChain(
        meta.setId,
        next.accountId,
        relDirOf(meta.relPath),
      );
      const spilled = {
        ...meta,
        op: "new",
        driveParentId: nextParent,
        ...(isUpdate
          ? { replacedFileId: meta.fileId, replacedAccountId: accountId }
          : {}),
        fileId: null,
      };
      writeMeta(transfer.id, spilled);
      setAccount(next.accountId);
      setSession(null, null);
      throw fail(
        `Moved to ${next.email} - the first account was full.`,
        "REALLOCATED",
      );
    }
    throw err;
  }
}

/** Zip parts go to the set's root backup folder on whatever account fits. */
async function uploadArchivePart(
  transfer,
  meta,
  set,
  { signal, onProgress, setSession, setAccount },
) {
  const size = fs.statSync(transfer.local_path).size;

  let accountId = transfer.account_id;
  if (!accountId) {
    accountId = allocation.pickAccountForUpload(
      size,
      set.primary_account_id,
    ).accountId;
    setAccount(accountId);
  }
  const parentId = await ensureFolderChain(meta.setId, accountId, "");

  try {
    const { file } = await core.uploadResumable({
      accountId,
      localPath: transfer.local_path,
      size,
      createSession: () =>
        core.openSession(accountId, {
          url: core.createFileSessionUrl(),
          method: "POST",
          size,
          mimeType: "application/zip",
          body: { name: transfer.name, parents: [parentId] },
        }),
      session: {
        uri: transfer.session_uri,
        expiresAt: transfer.session_expires_at,
      },
      onSessionInvalid: () => setSession(null, null),
      signal,
      onProgress,
      setSession,
    });

    let uploaded = file;
    if (!uploaded?.id) {
      const children = await drive.listChildren(accountId, parentId);
      uploaded = children.find((f) => f.name === transfer.name) || null;
    }
    if (!uploaded?.id)
      throw fail(
        "Part upload finished but could not be located.",
        "LOST_UPLOAD",
      );

    archiveParts.update(meta.archivePartId, {
      account_id: accountId,
      drive_file_id: uploaded.id,
      size,
    });
    return { bytes: size };
  } catch (err) {
    if (err.code === "storageQuotaExceeded") {
      await accountService.refreshQuota(accountId, { force: true });
      const next = allocation.pickAccountForUpload(size);
      setAccount(next.accountId);
      setSession(null, null);
      throw fail(
        `Moved to ${next.email} - the first account was full.`,
        "REALLOCATED",
      );
    }
    throw err;
  }
}

module.exports = { backup };
