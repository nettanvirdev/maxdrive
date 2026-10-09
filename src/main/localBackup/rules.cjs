/**
 * Include/exclude rules for a backup set, compiled once per run.
 *
 * Pure module (no node imports) so the unit tests can exercise it without
 * Electron. Paths are forward-slash relative paths within the set.
 */

const DEFAULT_IGNORE_DIRS = ["node_modules", ".git", ".github"];
const DEFAULT_EXCLUDE_EXTS = [".env"];

/**
 * Normalise an extension spec: ".ENV", "env", ".env" all become "env".
 * Matching is done on the same normalised form.
 */
function normaliseExt(spec) {
  return String(spec || "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "");
}

/**
 * The "extension" of a file name, normalised. Dotfiles like `.env` have no
 * extension as far as path.extname is concerned, but for filtering purposes
 * the whole name IS the extension - excluding ".env" must catch `.env`.
 */
function extOf(relPath) {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot + 1);
}

function parseRules(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

/**
 * @returns {{ skipDir(name): boolean, includeFile(relPath): boolean }}
 *
 * Precedence: an include-only list (when non-empty) wins - only listed
 * extensions are backed up. Otherwise everything minus the exclude list.
 * Directory ignores apply at any depth and always win over file rules,
 * because the walker never descends into them at all.
 */
function compileRules(rawRules) {
  const rules = parseRules(rawRules);
  const ignoreDirs = new Set(
    (rules.ignoreDirs ?? DEFAULT_IGNORE_DIRS)
      .map((d) => String(d).trim().toLowerCase())
      .filter(Boolean),
  );
  const excludeExts = new Set(
    (rules.excludeExts ?? DEFAULT_EXCLUDE_EXTS)
      .map(normaliseExt)
      .filter(Boolean),
  );
  const includeList = (rules.includeExts ?? [])
    .map(normaliseExt)
    .filter(Boolean);
  const includeExts = includeList.length ? new Set(includeList) : null;

  return {
    skipDir(name) {
      return ignoreDirs.has(String(name).toLowerCase());
    },
    includeFile(relPath) {
      const ext = extOf(relPath);
      if (includeExts) return includeExts.has(ext);
      return !excludeExts.has(ext);
    },
  };
}

module.exports = {
  compileRules,
  normaliseExt,
  extOf,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_EXCLUDE_EXTS,
};
