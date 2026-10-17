// Copies the renderer's static assets next to its compiled script: the
// pages, the stylesheet, the wordmark tile, and the Cinzel display face the
// shell shares with the game (vendored from @fontsource so the packaged app
// never reaches for a font host).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(repo, "dist", "renderer");
fs.mkdirSync(outDir, { recursive: true });
for (const name of [
  "index.html",
  "bluetooth-picker.html",
  "style.css",
  "controls.css",
  "home.css",
  "story.webp",
]) {
  fs.copyFileSync(path.join(repo, "src", "renderer", name), path.join(outDir, name));
}

// `resolve` finds a package's folder: the desktop build reads this repo's
// node_modules, the mobile build its own (CI installs only those).
import { FONT_PACKAGES } from "./font-files.mjs";

export function copyFonts(target, resolve = (name) => path.join(repo, "node_modules", ...name.split("/"))) {
  fs.mkdirSync(target, { recursive: true });
  for (const [name, files] of Object.entries(FONT_PACKAGES)) {
    for (const file of files) fs.copyFileSync(path.join(resolve(name), "files", file), path.join(target, file));
  }
}

copyFonts(path.join(outDir, "fonts"));
