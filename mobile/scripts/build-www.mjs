// Builds the Capacitor web assets. The manager UI is the same app.ts the
// desktop shell uses (it only talks to window.odm); the Capacitor bridge
// implementation is bundled in front of it.
import { build } from "esbuild";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mobile = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.dirname(mobile);
const www = path.join(mobile, "www");

// The same compile options as the desktop renderer (JSX through Preact),
// and Preact itself resolvable from this package's own node_modules when
// CI installs only these.
const { buildGameCss, gameBuildOptions, rendererBuildOptions, serverDir } = await import(
  path.join(repo, "scripts", "build-renderer.mjs")
);
const shared = { ...rendererBuildOptions, nodePaths: [path.join(mobile, "node_modules")] };

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });

await build({
  entryPoints: [path.join(mobile, "src", "bridge.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  // The barcode scanner plugin carries html5-qrcode (over a megabyte) as
  // its browser fallback; on the device the native scanner does the work,
  // so the fallback is swapped for a stub that only keeps the enum the
  // plugin builds its type hints from.
  alias: { "html5-qrcode": path.join(mobile, "src", "html5-qrcode-stub.ts") },
  outfile: path.join(www, "bridge.js"),
});

// The game-page scripts (Web Bluetooth polyfill, download shim, shell menu
// hook) are not loaded by the manager UI; the bridge fetches them as text
// and injects them into the game webview (preShowScript).
for (const name of ["ble-polyfill", "download-shim", "shell-hook"]) {
  await build({
    entryPoints: [path.join(mobile, "src", `${name}.ts`)],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    outfile: path.join(www, `${name}.js`),
  });
}

for (const name of ["app", "topo"]) {
  await build({
    ...shared,
    entryPoints: [path.join(repo, "src", "renderer", `${name}.ts`)],
    format: "iife",
    outfile: path.join(www, `${name}.js`),
  });
}

// The native game screens (src/renderer/game): the host's own pages,
// bundled from the sibling server checkout the same way the desktop shell
// does, with their stylesheet.
const server = serverDir();
const game = gameBuildOptions(server);
await build({
  ...game,
  nodePaths: [...game.nodePaths, path.join(mobile, "node_modules")],
  outdir: path.join(www, "game"),
});
buildGameCss(server, path.join(www, "game"));

for (const name of ["style.css", "controls.css", "home.css", "story.webp"]) {
  fs.copyFileSync(path.join(repo, "src", "renderer", name), path.join(www, name));
}
fs.copyFileSync(path.join(mobile, "src", "index.html"), path.join(www, "index.html"));

// The same three faces as the desktop shell. Each package is resolved as a
// module so it is found in the mobile package's own node_modules (CI installs
// only those) or in the repo root's.
const requireHere = createRequire(import.meta.url);
const { FONT_PACKAGES } = await import(path.join(repo, "scripts", "font-files.mjs"));
fs.mkdirSync(path.join(www, "fonts"), { recursive: true });
for (const [name, files] of Object.entries(FONT_PACKAGES)) {
  const folder = path.join(path.dirname(requireHere.resolve(`${name}/package.json`)), "files");
  for (const file of files) fs.copyFileSync(path.join(folder, file), path.join(www, "fonts", file));
}
console.log("www built");
