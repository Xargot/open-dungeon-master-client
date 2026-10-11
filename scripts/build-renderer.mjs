// Bundles the shell's renderer with esbuild:
//
// - the page scripts (app, topo, the Bluetooth picker), one ESM each;
// - the game bundle (src/renderer/game): the host's own page components,
//   taken straight from the sibling server checkout (ODM_SERVER_DIR, the
//   same one bundle-server.mjs builds the payload from), compiled against
//   Preact through its compat layer with shims for the Next.js bits, and
//   code-split per page;
// - game.css: Tailwind over those components plus the server's theme.
//
// Type checking stays with tsc (tsconfig.renderer.json, noEmit); this only
// emits. The Android build (mobile/scripts/build-www.mjs) reuses the same
// options and entries into its www folder.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scopeCss } from "./scope-css.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const RENDERER_ENTRIES = ["app", "topo", "bluetooth-picker"];

export function serverDir() {
  const dir = path.resolve(process.env.ODM_SERVER_DIR ?? path.join(repo, "..", "open-dungeon-master"));
  if (!fs.existsSync(path.join(dir, "src", "app", "page.tsx"))) {
    throw new Error(`No server checkout at ${dir}. Set ODM_SERVER_DIR.`);
  }
  return dir;
}

// Shared by both shells so they compile the same way.
export const rendererBuildOptions = {
  bundle: true,
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "warning",
  // The bundles are parsed from local files on every launch and on every
  // entry into a world; minified they are about half the bytes to parse.
  minify: true,
};

const shims = path.join(repo, "src", "renderer", "game", "shims");

// ONE Preact, by absolute path. esbuild resolves a bare alias target
// ("preact/jsx-runtime") from the working directory, and the mobile build
// runs from mobile/, which has a Preact of its own: the bundle then carried
// two copies, an element made by one was not an element to the other, and
// every Radix `asChild` (menu and dialog triggers, tooltips, the kit Select)
// threw "failed to slot onto its children". Both shells now name the same
// folder, whichever of the two installs is present.
export function preactDir() {
  const found = [path.join(repo, "node_modules", "preact"), path.join(repo, "mobile", "node_modules", "preact")].find((dir) =>
    fs.existsSync(path.join(dir, "package.json")),
  );
  if (!found) throw new Error("Preact is not installed: run npm install in the client repo.");
  return found;
}

// The built-in art the apps carry beside the game bundle: the server's
// public folders, whole, except `ambience` (gitignored, fetched separately,
// and served behind the login). The list is the manifest the runtime
// consults (src/shared/local-assets.ts): a host folder with a trailing
// slash to the file names directly in it, sorted, so a path the app was
// not built with still goes to the host.
export const LOCAL_ASSET_FOLDERS = ["assets", "fx", "dice-box", "sidebar-icons"];

export function localAssetManifest(server) {
  const manifest = {};
  const walk = (dir, hostDir) => {
    if (!fs.existsSync(dir)) return;
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${hostDir}${entry.name}/`);
      else if (entry.isFile() && !entry.name.startsWith(".")) files.push(entry.name);
    }
    if (files.length) manifest[hostDir] = files;
  };
  for (const folder of LOCAL_ASSET_FOLDERS) walk(path.join(server, "public", folder), `/${folder}/`);
  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// Where a host folder lands beside the bundle: the icons and the
// stylesheet's furniture keep their old folders (the shell's own sheet
// points at game/ui-art), the rest mirrors the server under game/public.
// Mirrors localFolder() in src/shared/local-assets.ts.
function localAssetTarget(outDir, hostDir) {
  if (hostDir.startsWith("/assets/icons/")) return path.join(outDir, "icons", hostDir.slice("/assets/icons/".length));
  if (hostDir.startsWith("/assets/ui/")) return path.join(outDir, "ui-art", hostDir.slice("/assets/ui/".length));
  return path.join(outDir, "public", hostDir.slice(1));
}

// The manifest as a module ("odm:local-assets"), inlined into game.js so
// the first pictures already resolve locally; a fetch at runtime would
// race the first render.
function localAssetsPlugin(server) {
  return {
    name: "odm-local-assets",
    setup(build) {
      build.onResolve({ filter: /^odm:local-assets$/ }, (args) => ({ path: args.path, namespace: "odm-local-assets" }));
      build.onLoad({ filter: /.*/, namespace: "odm-local-assets" }, () => ({
        contents: JSON.stringify(localAssetManifest(server)),
        loader: "json",
      }));
    },
  };
}

// The server's components import their own stylesheets (the ones its
// src/app/styles/component-sheets.css lists) so Next loads each with the
// chunk that renders it. The apps fold those sheets into game.css instead
// (buildGameCss), so in the game bundle a stylesheet import is an empty
// module.
function serverCssPlugin() {
  return {
    name: "odm-server-css",
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "odm-server-css" }));
      build.onLoad({ filter: /.*/, namespace: "odm-server-css" }, () => ({ contents: "", loader: "js" }));
    },
  };
}

// The game bundle's view of the world: React is Preact, Next's pieces are
// the shims, "@/" is the server's src.
export function gameBuildOptions(server) {
  const preact = preactDir();
  return {
    ...rendererBuildOptions,
    format: "esm",
    splitting: true,
    plugins: [localAssetsPlugin(server), serverCssPlugin()],
    alias: {
      react: path.join(shims, "react.js"),
      "react-dom": path.join(shims, "react-dom.js"),
      "react-dom/client": path.join(preact, "compat"),
      "react/jsx-runtime": path.join(preact, "jsx-runtime"),
      "react/jsx-dev-runtime": path.join(preact, "jsx-runtime"),
      // Every "preact" and "preact/..." import, the JSX runtime included.
      preact,
      "next/link": path.join(shims, "next-link.tsx"),
      "next/navigation": path.join(shims, "next-navigation.ts"),
      "node:crypto": path.join(shims, "node-crypto.ts"),
      "@radix-ui/react-portal": path.join(shims, "radix-portal.tsx"),
      "@": path.join(server, "src"),
    },
    define: { "process.env.NODE_ENV": '"production"' },
    // The server's sources import from its own node_modules (radix, lucide,
    // zod...); the same packages are installed here, so resolution is
    // pinned to this repo and falls back to the server's copy.
    nodePaths: [path.join(repo, "node_modules"), path.join(server, "node_modules")],
    entryPoints: [path.join(repo, "src", "renderer", "game", "index.tsx")],
    entryNames: "game",
    chunkNames: "chunks/[name]-[hash]",
  };
}

// Tailwind over the server's components and the game shims, with the
// server's own theme. The input is written beside the output because
// @source paths are relative to the file that holds them.
export function buildGameCss(server, outDir) {
  const entry = path.join(outDir, "game-entry.css");
  const rel = (target) => path.relative(outDir, target).split(path.sep).join("/");
  // The server's stylesheet is copied in rather than imported: its own
  // `@import "tailwindcss"` must resolve from this repo's node_modules,
  // since the server checkout beside it (CI) has none installed.
  // Its relative imports (src/app/styles/*.css) are inlined for the same
  // reason: copied text has no directory of its own to resolve them from.
  // A sheet may import a neighbour of its own (hand.css brings in
  // hand-motion.css), so each file's imports resolve from that file's folder.
  const inline = (file) =>
    fs
      .readFileSync(file, "utf8")
      .replace(/^@import\s+"(\.\/[^"]+\.css)";[ \t]*$/gm, (_, next) => inline(path.join(path.dirname(file), next)));
  const globals = inline(path.join(server, "src", "app", "globals.css"));
  // The sheets the web loads with their components, after globals as the
  // server's own file says; a server from before the split has none.
  const sheets = path.join(server, "src", "app", "styles", "component-sheets.css");
  const componentSheets = fs.existsSync(sheets) ? inline(sheets) : "";
  fs.writeFileSync(
    entry,
    [
      globals,
      componentSheets,
      `@source "${rel(path.join(server, "src", "app"))}";`,
      `@source "${rel(path.join(server, "src", "components"))}";`,
      `@source "${rel(path.join(server, "src", "lib"))}";`,
      `@source "${rel(path.join(repo, "src", "renderer", "game"))}";`,
      "",
    ].join("\n"),
  );
  const cli = path.join(repo, "node_modules", "@tailwindcss", "cli", "dist", "index.mjs");
  const out = path.join(outDir, "game.css");
  execFileSync(process.execPath, [cli, "-i", entry, "-o", out, "--minify"], { stdio: "inherit" });
  fs.rmSync(entry, { force: true });
  // The sheet shares the page with the shell's own screens: every rule is
  // confined to the game's root element (scope-css.mjs).
  // Painted furniture the stylesheet draws as a background (the scroll, the
  // book, the dust) cannot be pointed at the host the way an <img> is, so the
  // parts ship beside the sheet and its root-relative addresses become local.
  // The painted icons, the tiles, props, placeholders, themes, effects, the
  // dice and the sidebar glyphs ship inside the app the same way: the
  // runtime points every picture the manifest lists at the local copy
  // (src/renderer/game/local-assets.ts), so they show on the app's own
  // screens where no host is connected, offline, and without a round trip
  // to the host for each one in a world.
  copyLocalAssets(server, outDir);
  const local = fs.readFileSync(out, "utf8").replace(/url\((["']?)\/assets\/ui\//g, "url($1./ui-art/");
  fs.writeFileSync(out, scopeCss(local, ".game-root"));
}

export function copyLocalAssets(server, outDir) {
  for (const folder of ["icons", "ui-art", "public"]) fs.rmSync(path.join(outDir, folder), { recursive: true, force: true });
  const manifest = localAssetManifest(server);
  for (const [hostDir, files] of Object.entries(manifest)) {
    const target = localAssetTarget(outDir, hostDir);
    fs.mkdirSync(target, { recursive: true });
    for (const file of files) fs.copyFileSync(path.join(server, "public", hostDir.slice(1), file), path.join(target, file));
  }
  fs.mkdirSync(path.join(outDir, "public"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "public", "manifest.json"), JSON.stringify(manifest));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = path.join(repo, "dist", "renderer");
  for (const name of RENDERER_ENTRIES) {
    await build({
      ...rendererBuildOptions,
      entryPoints: [path.join(repo, "src", "renderer", `${name}.ts`)],
      format: "esm",
      outfile: path.join(outDir, `${name}.js`),
    });
  }
  const server = serverDir();
  fs.rmSync(path.join(outDir, "game"), { recursive: true, force: true });
  await build({ ...gameBuildOptions(server), outdir: path.join(outDir, "game") });
  buildGameCss(server, path.join(outDir, "game"));
  console.log("renderer bundled");
}
