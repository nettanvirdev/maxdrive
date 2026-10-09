/**
 * Rasterises public/assets/logo.svg into the PNG that the window, tray and
 * installer need. Uses Electron's own renderer rather than pulling in a
 * native image library, so `bunx electron scripts/generate-icons.cjs` is all it
 * takes to refresh the icons after editing the SVG.
 */
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const ROOT = path.join(__dirname, "..");
const SVG = path.join(ROOT, "public/assets/logo.svg");
const STAGE = path.join(require("os").tmpdir(), "maxdrive-logo-512.png");

async function renderAt(svg, size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    useContentSize: true, // capture exactly size x size, not size minus chrome
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
  });

  // Scrollbars would otherwise be composited into the capture and clip the art.
  const html = `<!doctype html><html><head><style>
      html,body{margin:0;padding:0;overflow:hidden;background:transparent}
      ::-webkit-scrollbar{display:none}
      svg{display:block}
    </style></head><body>
    <div style="width:${size}px;height:${size}px">${svg}</div>
  </body></html>`;

  note("window created");
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  note("loaded");
  // One frame is not always painted yet on the first tick.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await win.webContents.capturePage();
  note(`captured ${image.getSize().width}x${image.getSize().height}`);
  win.destroy();
  return image;
}

// Destroying the render window would otherwise trip Electron's default
// "quit when no windows remain" and kill the process mid-write.
app.on("window-all-closed", () => {});

const LOG = path.join(require("os").tmpdir(), "maxdrive-icon-gen.log");
const note = (m) => fs.appendFileSync(LOG, `${m}\n`);
process.on("uncaughtException", (e) => { note("UNCAUGHT " + e.stack); app.exit(1); });
process.on("unhandledRejection", (e) => { note("REJECTED " + (e?.stack || e)); app.exit(1); });

app.whenReady().then(async () => {
  fs.writeFileSync(LOG, "ready\n");
  const raw = fs.readFileSync(SVG, "utf8");
  const size = 512;

  // Force the SVG to fill the capture area regardless of its own attributes.
  const svg = raw
    .replace(/width="\d+"/, `width="${size}"`)
    .replace(/height="\d+"/, `height="${size}"`);

  const image = await renderAt(svg, size);

  // Windows Controlled Folder Access blocks electron.exe from writing into
  // Desktop-backed project folders, so the render is staged in temp and
  // install-icons.cjs (plain node) copies it into place.
  fs.writeFileSync(STAGE, image.toPNG());
  note(`staged ${STAGE} (${image.getSize().width}x${image.getSize().height})`);

  app.exit(0);
});
