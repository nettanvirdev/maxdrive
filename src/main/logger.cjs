const log = require("electron-log/main");

log.initialize();
log.transports.file.level = "info";
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.console.level = process.env.NODE_ENV === "development" ? "debug" : "warn";

/** Scoped logger so every message says which subsystem it came from. */
function scope(name) {
  return log.scope(name);
}

module.exports = { log, scope };
