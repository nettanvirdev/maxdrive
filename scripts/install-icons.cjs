/**
 * Copies the PNG staged by generate-icons.cjs into the project.
 *
 * This runs under plain node rather than electron on purpose: Windows
 * Controlled Folder Access refuses writes from electron.exe into Desktop-backed
 * folders, while node is trusted.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STAGE = path.join(os.tmpdir(), "maxdrive-logo-512.png");
const TARGETS = ["public/assets/logo.png"];

if (!fs.existsSync(STAGE)) {
  console.error(`No staged icon at ${STAGE}. Run: bunx electron scripts/generate-icons.cjs`);
  process.exit(1);
}

const png = fs.readFileSync(STAGE);
for (const target of TARGETS) {
  const file = path.join(ROOT, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  console.log(`installed ${target} (${png.length} bytes)`);
}
