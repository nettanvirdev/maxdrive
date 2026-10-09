/**
 * JSON files encrypted at rest with Electron safeStorage (Windows DPAPI), in
 * userData. The blob is bound to the Windows user account, so a fresh Windows
 * install cannot decrypt it - callers decide what an unreadable file means.
 */
const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

function sealedPath(name) {
  return path.join(app.getPath("userData"), name);
}

/** Parsed contents, or null when the file does not exist. Throws if unreadable. */
function readSealed(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file);
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(raw)
    : raw.toString("utf8");
  return JSON.parse(json);
}

function writeSealed(file, value) {
  const json = JSON.stringify(value);
  const payload = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, "utf8");
  // Write-then-rename: a crash mid-write leaves the previous file intact
  // rather than a truncated blob that would fail to decrypt on next launch.
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, payload);
  fs.renameSync(temp, file);
}

module.exports = { sealedPath, readSealed, writeSealed };
