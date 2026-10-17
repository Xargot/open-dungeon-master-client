// Renders the Steam library artwork Add to Steam installs
// (src/main/steam-shortcut.ts) into build/steam, from the app's own
// paintings and the title screen's gilt Cinzel title. Electron draws it so
// the type, gradients and shadows match the shell exactly. Run after
// `npm run build` (the paintings and fonts are read from dist/renderer):
//
//   ./node_modules/.bin/electron --no-sandbox --ozone-platform=headless --disable-gpu scripts/make-steam-art.mjs
//
// Outputs (Steam's sizes):
// - portrait.jpg 600x900: the library tile Game Mode shows.
// - wide.jpg 920x430: the wide tile (recent games, the desktop grid).
// - hero.jpg 1920x620: the banner across the game's page, no type on it,
//   since Steam draws the logo over its lower left.
// - logo.png: the d20 and the name on a clear background, for that banner.
// - icon.png 256x256: the app icon.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import sharp from "sharp";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "build", "steam");
const dist = path.join(root, "dist", "renderer");

const NIGHT = "#0a0817";

const base64 = async (file) => (await readFile(file)).toString("base64");
const pngUrl = (buf) => `data:image/png;base64,${buf.toString("base64")}`;

// The paintings, resized here (Lanczos) rather than by the page, so the
// upscale is as sharp as the small originals allow.
async function painting(rel, width, height, position = "centre") {
  const buf = await sharp(path.join(dist, rel))
    .resize({ width, height, fit: "cover", position, kernel: "lanczos3" })
    .sharpen({ sigma: 0.6 })
    .png()
    .toBuffer();
  return pngUrl(buf);
}

// The d20 from build/icon.svg without its plate, as make-icons.mjs draws it.
async function d20(size) {
  const svg = (await readFile(path.join(root, "build", "icon.svg"), "utf8")).replace(/<rect[^>]*\/>\s*/, "");
  return pngUrl(await sharp(Buffer.from(svg), { density: (72 * size) / 64 }).resize(size, size).png().toBuffer());
}

const fonts = {
  cinzel600: await base64(path.join(dist, "fonts", "cinzel-latin-600-normal.woff2")),
  cinzel700: await base64(path.join(dist, "fonts", "cinzel-latin-700-normal.woff2")),
  serifItalic: await base64(path.join(dist, "fonts", "source-serif-4-latin-400-italic.woff2")),
};

// The title screen's pieces (src/renderer/home.css): the gilt face, the
// letter-spaced eyebrow, the gold corner brackets, the grain and the stars.
const SHARED_CSS = `
@font-face { font-family: "Cinzel"; font-weight: 600; src: url(data:font/woff2;base64,${fonts.cinzel600}) format("woff2"); }
@font-face { font-family: "Cinzel"; font-weight: 700; src: url(data:font/woff2;base64,${fonts.cinzel700}) format("woff2"); }
@font-face { font-family: "Source Serif 4"; font-style: italic; font-weight: 400; src: url(data:font/woff2;base64,${fonts.serifItalic}) format("woff2"); }
* { box-sizing: border-box; }
html, body { margin: 0; overflow: hidden; }
.layer { position: absolute; inset: 0; }
.gilt {
  margin: 0;
  font-family: "Cinzel", serif;
  font-weight: 700;
  line-height: 0.98;
  letter-spacing: 0.02em;
  background: linear-gradient(180deg, #fff6da 0%, #f4e0a6 28%, #e3c15c 58%, #b8922a 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 1px 0 rgba(92, 64, 12, 0.9)) drop-shadow(0 2px 0 rgba(58, 40, 8, 0.7)) drop-shadow(0 10px 24px rgba(212, 171, 58, 0.28));
}
.eyebrow {
  font-family: "Cinzel", serif;
  font-weight: 600;
  letter-spacing: 0.34em;
  text-transform: uppercase;
  color: #e3c15c;
}
.rule { height: 1px; background: linear-gradient(90deg, transparent, #b8922a, transparent); }
.corner { position: absolute; width: 42px; height: 42px; border: 0 solid rgba(212, 171, 58, 0.6); }
.tl { left: 22px; top: 22px; border-left-width: 1px; border-top-width: 1px; }
.tr { right: 22px; top: 22px; border-right-width: 1px; border-top-width: 1px; }
.bl { left: 22px; bottom: 22px; border-left-width: 1px; border-bottom-width: 1px; }
.br { right: 22px; bottom: 22px; border-right-width: 1px; border-bottom-width: 1px; }
.grain {
  opacity: 0.35;
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E");
}
.stars {
  background-image:
    radial-gradient(1.5px 1.5px at 11% 24%, rgba(244, 224, 166, 0.8), transparent 60%),
    radial-gradient(2px 2px at 27% 68%, rgba(233, 230, 244, 0.5), transparent 60%),
    radial-gradient(1.5px 1.5px at 38% 12%, rgba(244, 224, 166, 0.55), transparent 60%),
    radial-gradient(1.5px 1.5px at 18% 88%, rgba(244, 224, 166, 0.45), transparent 60%),
    radial-gradient(1.5px 1.5px at 6% 42%, rgba(244, 224, 166, 0.5), transparent 60%),
    radial-gradient(2px 2px at 44% 52%, rgba(233, 230, 244, 0.4), transparent 60%),
    radial-gradient(1.5px 1.5px at 33% 37%, rgba(244, 224, 166, 0.5), transparent 60%),
    radial-gradient(1.5px 1.5px at 22% 8%, rgba(233, 230, 244, 0.45), transparent 60%);
}
`;

const pageHtml = (width, height, css, body, background) => `<!doctype html><html><head><meta charset="utf-8"><style>
${SHARED_CSS}
html, body { width: ${width}px; height: ${height}px; background: ${background}; }
${css}
</style></head><body>${body}</body></html>`;

// Draws one page offscreen and returns its pixels at exactly width x height.
async function render(width, height, html, { transparent = false } = {}) {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    enableLargerThanScreen: true,
    frame: false,
    transparent,
    backgroundColor: transparent ? "#00000000" : NIGHT,
    // Hidden windows are throttled: no animation frames, no paint.
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  // A headless offscreen window starts at 1x1 whatever it was asked for.
  win.setContentSize(width, height);
  // A file, not a data: URL: the inlined paintings and fonts outgrow
  // Chromium's URL limit.
  const dir = await mkdtemp(path.join(os.tmpdir(), "odm-steam-art-"));
  const page = path.join(dir, "page.html");
  try {
    await writeFile(page, html);
    await win.loadFile(page);
    await win.webContents.executeJavaScript(
      "document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))",
    );
    const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
    const size = image.getSize();
    if (size.width !== width || size.height !== height) {
      throw new Error(`Captured ${size.width}x${size.height}, wanted ${width}x${height}.`);
    }
    return image.toPNG();
  } finally {
    win.destroy();
    await rm(dir, { recursive: true, force: true });
  }
}

async function write(name, pixels) {
  const file = path.join(out, name);
  const image = sharp(pixels);
  await (name.endsWith(".jpg") ? image.jpeg({ quality: 88, mozjpeg: true }) : image.png({ compressionLevel: 9 })).toFile(file);
  console.log(`wrote build/steam/${name}`);
}

async function main() {
  await mkdir(out, { recursive: true });
  const glyph = await d20(512);

  // The party stands on the right at little more than its own size; the
  // night opens to the left, where Steam draws the logo.
  const party = await painting("game/public/assets/placeholders/misc/party.webp", 1091, 620);
  await write(
    "hero.jpg",
    await render(
      1920,
      620,
      pageHtml(
        1920,
        620,
        `.art { left: auto; width: 1091px; background: url(${party}) center / cover no-repeat;
           -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 42%); mask-image: linear-gradient(90deg, transparent 0%, #000 42%); }
         .floor { background: linear-gradient(0deg, rgba(10, 8, 23, 0.7) 0%, transparent 38%), linear-gradient(180deg, rgba(10, 8, 23, 0.4) 0%, transparent 22%); }
         .glow { background: radial-gradient(60% 90% at 30% 85%, rgba(212, 171, 58, 0.12), transparent 70%); }`,
        `<div class="layer stars"></div><div class="layer glow"></div><div class="layer art"></div><div class="layer floor"></div><div class="layer grain"></div>`,
        NIGHT,
      ),
    ),
  );

  const partyWide = await painting("game/public/assets/placeholders/misc/party.webp", 757, 430);
  await write(
    "wide.jpg",
    await render(
      920,
      430,
      pageHtml(
        920,
        430,
        `.art { left: auto; width: 757px; background: url(${partyWide}) center / cover no-repeat;
           -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 55%); mask-image: linear-gradient(90deg, transparent 0%, #000 55%); }
         .scrim { background: linear-gradient(90deg, rgba(10, 8, 23, 0.9) 0%, rgba(10, 8, 23, 0.55) 38%, transparent 62%); }
         .title { position: absolute; left: 48px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 16px; }
         .title .gilt { font-size: 66px; }
         .title .eyebrow { font-size: 15px; }
         .title .rule { width: 220px; background: linear-gradient(90deg, #b8922a, transparent); }`,
        `<div class="layer stars"></div><div class="layer art"></div><div class="layer scrim"></div><div class="layer grain"></div>
         <div class="title"><span class="eyebrow">Tabletop adventures</span><h1 class="gilt">Open<br>Dungeon<br>Master</h1><div class="rule"></div></div>
         <span class="corner tl"></span><span class="corner br"></span>`,
        NIGHT,
      ),
    ),
  );

  // The keep against the sun, cropped tall; the name sits in the dark below.
  const keep = await painting("game/ui-art/door/dark-fantasy.webp", 600, 900, "centre");
  await write(
    "portrait.jpg",
    await render(
      600,
      900,
      pageHtml(
        600,
        900,
        `.art { background: url(${keep}) center / cover no-repeat; }
         .floor { background: linear-gradient(0deg, rgba(10, 8, 23, 0.97) 0%, rgba(10, 8, 23, 0.82) 30%, transparent 58%), linear-gradient(180deg, rgba(10, 8, 23, 0.35) 0%, transparent 18%); }
         .title { position: absolute; left: 0; right: 0; bottom: 70px; display: flex; flex-direction: column; align-items: center; gap: 18px; text-align: center; }
         .title img { width: 96px; height: 96px; filter: drop-shadow(0 6px 18px rgba(212, 171, 58, 0.35)); }
         .title .gilt { font-size: 74px; }
         .title .eyebrow { font-size: 15px; }
         .title .rule { width: 260px; }`,
        `<div class="layer art"></div><div class="layer floor"></div><div class="layer grain"></div>
         <div class="title"><img src="${glyph}" alt=""><h1 class="gilt">Open<br>Dungeon<br>Master</h1><div class="rule"></div><span class="eyebrow">Tabletop adventures</span></div>
         <span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>`,
        NIGHT,
      ),
    ),
  );

  // The logo, drawn large and trimmed to its ink.
  const logo = await render(
    1280,
    720,
    pageHtml(
      1280,
      720,
      `.lockup { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 44px; }
       .lockup img { width: 250px; height: 250px; filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.6)); }
       .lockup .gilt { font-size: 124px; filter: drop-shadow(0 1px 0 rgba(92, 64, 12, 0.9)) drop-shadow(0 3px 0 rgba(58, 40, 8, 0.8)) drop-shadow(0 6px 18px rgba(0, 0, 0, 0.75)); }`,
      `<div class="lockup"><img src="${glyph}" alt=""><h1 class="gilt">Open<br>Dungeon<br>Master</h1></div>`,
      "transparent",
    ),
    { transparent: true },
  );
  await write("logo.png", await sharp(logo).trim({ threshold: 1 }).extend({ top: 12, bottom: 12, left: 12, right: 12, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());

  await write("icon.png", await sharp(path.join(root, "build", "icon.png")).resize(256, 256, { kernel: "lanczos3" }).png().toBuffer());
}

app.disableHardwareAcceleration();
// Each image's window closes before the next opens; that is not the end.
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
