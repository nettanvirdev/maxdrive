/**
 * The Drive-side folder skeleton of a backup set, per account.
 *
 * A set can spill across accounts, so the same relative directory may need to
 * exist on several of them. Every folder we create is recorded in
 * backup_folders - that table is simultaneously the ensure-cache here and the
 * scanner's hide-list (scanner.cjs hiddenFolderIds).
 *
 * Also home to the small path helpers the archive and restore paths share.
 */
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const { backupSets, backupFolders } = require("../db/queries.cjs");
const drive = require("../drive/driveApi.cjs");
const accountService = require("../auth/accountService.cjs");

/**
 * Ensure `MaxDrive/.backup/<set name>/<relDir>` exists on `accountId` and
 * return the Drive folder id of the deepest segment. relDir "" = the set root.
 */
async function ensureFolderChain(setId, accountId, relDir = "") {
  const set = backupSets.byId(setId);
  if (!set) throw new Error("Backup set no longer exists.");

  let parentId = backupFolders.get(setId, accountId, "");
  if (!parentId) {
    const backupRootId = await accountService.ensureSubfolder(
      accountId,
      ".backup",
      "backup_folder_id",
    );
    const folder = await drive.ensureFolder(
      accountId,
      set.name || setId,
      backupRootId,
    );
    backupFolders.insert(setId, accountId, "", folder.id);
    parentId = folder.id;
  }
  if (!relDir) return parentId;

  let rel = "";
  for (const segment of relDir.split("/")) {
    rel = rel ? `${rel}/${segment}` : segment;
    let id = backupFolders.get(setId, accountId, rel);
    if (!id) {
      id = (await drive.ensureFolder(accountId, segment, parentId)).id;
      backupFolders.insert(setId, accountId, rel, id);
    }
    parentId = id;
  }
  return parentId;
}

/** The relative directory of a relative file path ("a/b/c.txt" → "a/b"). */
function relDirOf(relPath) {
  const slash = relPath.lastIndexOf("/");
  return slash < 0 ? "" : relPath.slice(0, slash);
}

/** True when relPath is selected: no selection = everything; else a listed file or dir prefix. */
function matchesSelection(relPath, paths) {
  if (!paths || !paths.length) return true;
  return paths.some(
    (p) => relPath === p || relPath.startsWith(`${p.replace(/\/+$/, "")}/`),
  );
}

function userDataDir(name) {
  const dir = path.join(app.getPath("userData"), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Scratch space for archive parts (created on demand). */
const backupTmpDir = () => userDataDir("backup-tmp");
/** Local copies of archive manifests, one `<runId>.json` per run. */
const manifestDir = () => userDataDir("backup-manifests");

module.exports = {
  ensureFolderChain,
  relDirOf,
  matchesSelection,
  backupTmpDir,
  manifestDir,
};
