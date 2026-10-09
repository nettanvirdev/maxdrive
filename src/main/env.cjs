/**
 * Minimal .env loader.
 *
 * Deliberately not `dotenv`: main is CommonJS with a hard policy of only two
 * runtime dependencies, and the parsing we need is twenty lines.
 *
 * Optional: the OAuth client normally comes from Settings (credentials.cjs);
 * GOOGLE_CLIENT_ID/SECRET here are only a fallback, and no .env is bundled.
 *
 * Search order (first file found wins):
 *
 *   1. $MAXDRIVE_ENV_FILE          explicit override
 *   2. <exe dir>/.env              packaged - next to MaxDrive.exe
 *   3. <resources>/.env            packaged - inside resources/
 *   4. <userData>/.env             per-user, survives reinstalling the app
 *   5. <app path>/.env             the repo root in dev
 *
 * Values already present in process.env are never overwritten, so a real
 * environment variable still beats every file.
 */
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { scope } = require("./logger.cjs");

const log = scope("env");

function candidates() {
  const list = [];
  if (process.env.MAXDRIVE_ENV_FILE) list.push(process.env.MAXDRIVE_ENV_FILE);
  if (app.isPackaged) {
    list.push(path.join(path.dirname(app.getPath("exe")), ".env"));
    if (process.resourcesPath)
      list.push(path.join(process.resourcesPath, ".env"));
  }
  list.push(path.join(app.getPath("userData"), ".env"));
  // fs reads straight through app.asar, so no unpacking is needed for this.
  list.push(path.join(app.getAppPath(), ".env"));
  return list;
}

function parse(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes; unquoted values keep any inner '#'
    // because Google secrets are opaque and we must not mangle them.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function load() {
  for (const file of candidates()) {
    try {
      if (!file || !fs.existsSync(file)) continue;
      const values = parse(fs.readFileSync(file, "utf8"));
      for (const [key, value] of Object.entries(values)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      log.info(`loaded ${Object.keys(values).length} vars from ${file}`);
      return file;
    } catch (err) {
      log.warn(`could not read ${file}: ${err.message}`);
    }
  }
  log.info("no .env file found");
  return null;
}

module.exports = { load, parse, candidates };
