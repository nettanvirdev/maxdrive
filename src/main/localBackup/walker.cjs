/**
 * Snapshot walk of a backup set's local root.
 *
 * Iterative (no recursion limit), prunes ignored directories before ever
 * descending into them (a node_modules with 100k files costs nothing), and
 * yields to the event loop periodically so a huge tree can't starve the app.
 *
 * Unreadable entries are collected, never fatal: one locked file must not
 * fail a whole backup run.
 */
const path = require("node:path");
const fsp = require("node:fs/promises");

const YIELD_EVERY_DIRS = 25;

/**
 * @param {string} root absolute path of the set's local root
 * @param {{skipDir, includeFile}} rules compiled by rules.cjs
 * @returns {Promise<{files: Map<string,{size:number,mtime:number}>, skipped: Array<{relPath,error}>}>}
 *   files is keyed by forward-slash relative path.
 */
async function walkTree(root, rules) {
  const files = new Map();
  const skipped = [];
  const stack = [""];
  let dirsSeen = 0;

  while (stack.length) {
    const relDir = stack.pop();
    const absDir = relDir ? path.join(root, relDir) : root;

    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ relPath: relDir || ".", error: err.code || err.message });
      continue;
    }

    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!rules.skipDir(entry.name)) stack.push(rel);
      } else if (entry.isFile()) {
        if (!rules.includeFile(rel)) continue;
        try {
          const stat = await fsp.stat(path.join(root, rel));
          files.set(rel, { size: stat.size, mtime: Math.round(stat.mtimeMs) });
        } catch (err) {
          skipped.push({ relPath: rel, error: err.code || err.message });
        }
      }
      // Symlinks, junctions, sockets etc. are deliberately ignored: following
      // links out of the root turns "back up this folder" into "back up
      // whatever the link points at", including cycles.
    }

    if (++dirsSeen % YIELD_EVERY_DIRS === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return { files, skipped };
}

module.exports = { walkTree };
