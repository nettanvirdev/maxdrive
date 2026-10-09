const path = require("node:path");

/**
 * The name a queued upload gets on Drive. `transfer.name` is the user-facing
 * name; `local_path` may be a uuid-prefixed temp file (REST uploads), so it is
 * only the fallback for rows that predate the name column being set.
 */
function uploadName(transfer) {
  return transfer.name || path.basename(transfer.local_path);
}

module.exports = { uploadName };
