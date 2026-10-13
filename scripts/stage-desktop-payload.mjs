// Stages the desktop payload for electron-builder: vendor/server (the
// output of scripts/bundle-server.mjs, with the native module rebuilt for
// this platform) becomes vendor/desktop, which electron-builder.yml ships
// as resources/server. Runs after `npm run build`, whose renderer bundle
// decides which art the payload can leave out.
//
// What changes on the way, and why (src/main/run-tree.ts undoes it when
// the app first copies the payload into user data):
//
//  - Every node_modules directory is renamed: electron-builder drops a
//    folder of that name anywhere under extraResources, and did so in every
//    release before this script existed, leaving the packaged server unable
//    to require next.
//  - The hashed-id alias links become a JSON list, so nothing depends on
//    what the packager or the installer makes of a symlink.
//  - The art the shell carries beside its game bundle is left out.
//  - Build leftovers inside the rebuilt SQLite module go (object files,
//    the SQLite sources, prebuilt downloads): only the binding and its
//    JavaScript run.
//  - A manifest of every file that stays (size and sha256) is written last
//    at the top of the payload, so the app can tell a run tree that lost a
//    file from one that is whole and rebuild it (src/main/payload-manifest.ts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  dropLocalAssets,
  pruneServerPayload,
  readLocalAssetManifest,
  walk,
} from "./prune-server-payload.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SQLITE_MODULE = path.join("node_modules", "better-sqlite3-multiple-ciphers");
const SQLITE_KEEP = new Set(["lib", "package.json", "LICENSE", "build"]);
const SQLITE_BINDING = path.join("build", "Release", "better_sqlite3.node");

async function runTreeLayout() {
  const built = path.join(repo, "dist", "main", "run-tree.js");
  if (!fs.existsSync(built)) throw new Error("dist/main/run-tree.js is missing: run npm run build first.");
  const { MODULES_DIR, ALIASES_FILE } = await import(pathToFileURL(built).href);
  const { writePayloadManifest } = await import(pathToFileURL(path.join(repo, "dist", "main", "payload-manifest.js")).href);
  return { MODULES_DIR, ALIASES_FILE, writePayloadManifest };
}

function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

// The alias links at the top of node_modules, as alias name to the real
// package (a relative link target such as "mediasoup"; "../@scope/pkg"
// style targets keep their scope).
export function collectModuleAliases(vendorDir) {
  const aliases = {};
  const modules = path.join(vendorDir, "node_modules");
  if (!fs.existsSync(modules)) return aliases;
  const visit = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = path.resolve(dir, fs.readlinkSync(full));
        aliases[prefix + entry.name] = path.relative(modules, target).split(path.sep).join("/");
      } else if (entry.isDirectory() && entry.name.startsWith("@")) {
        visit(full, `${entry.name}/`);
      }
    }
  };
  visit(modules, "");
  return aliases;
}

export function pruneSqliteBuild(dir) {
  const module = path.join(dir, SQLITE_MODULE);
  if (!fs.existsSync(module)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(module)) {
    if (SQLITE_KEEP.has(entry)) continue;
    fs.rmSync(path.join(module, entry), { recursive: true, force: true });
    removed += 1;
  }
  const binding = path.join(module, SQLITE_BINDING);
  if (!fs.existsSync(binding)) throw new Error(`The SQLite binding is missing at ${binding}; was it rebuilt?`);
  const keep = fs.readFileSync(binding);
  fs.rmSync(path.join(module, "build"), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(binding), { recursive: true });
  fs.writeFileSync(binding, keep);
  return removed + 1;
}

// A native package built for one platform, by the suffix sharp gives its
// per-platform packages (sharp-linux-x64, sharp-libvips-darwin-arm64,
// sharp-linuxmusl-x64 and so on).
const NATIVE_SUFFIX = /-(linux|linuxmusl|darwin|win32)-(x64|arm64|ia32|arm|s390x|ppc64)$/;

// The OS/CPU pairs the release packages (.github/workflows/release.yml).
export const DESKTOP_TARGETS = ["linux/x64", "win32/x64", "darwin/arm64", "darwin/x64"];

// The server's standalone trace carries the embedding runtime's binding for
// the host it builds on only (linux/x64 on the release runner), all its Docker
// image needs, so the Windows and Mac apps had no binding to load and every
// embed failed there. This adds the binding of each other desktop target from
// the full install the payload was built from;
// pruneForeignBinaries then keeps the one each package can load. A target
// onnxruntime ships no build for (darwin/x64) stays without, and the server
// falls back to keyword search there. Returns the targets added, sorted.
export function addEmbeddingBindings(vendorDir, installModules) {
  const rel = path.join("onnxruntime-node", "bin", "napi-v6");
  const from = path.join(installModules, rel);
  if (!fs.existsSync(from)) throw new Error(`No onnxruntime-node bindings at ${from}.`);
  const added = [];
  for (const target of DESKTOP_TARGETS) {
    const source = path.join(from, ...target.split("/"));
    const dest = path.join(vendorDir, "node_modules", rel, ...target.split("/"));
    if (!fs.existsSync(source) || fs.existsSync(dest)) continue;
    fs.cpSync(source, dest, { recursive: true });
    added.push(target);
  }
  return added.sort();
}

// The payload is built once, on Linux, and packaged on every desktop
// platform; the binaries built for another OS or CPU (or for musl) cannot
// load where this package will run, so they stay out of it: sharp's
// per-platform packages wherever a node_modules holds them, the embedding
// runtime's bindings, and mediasoup's worker, a Linux x64 executable.
// Returns the payload-relative paths removed, sorted.
export function pruneForeignBinaries(dir, platform, arch) {
  const removed = [];
  const drop = (full) => {
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(path.relative(dir, full).split(path.sep).join("/"));
  };
  walk(dir, (full, entry) => {
    if (!entry.isDirectory() || entry.name !== "@img" || path.basename(path.dirname(full)) !== "node_modules") return false;
    for (const pkg of fs.readdirSync(full)) {
      const match = NATIVE_SUFFIX.exec(pkg);
      if (match && (match[1] !== platform || match[2] !== arch)) drop(path.join(full, pkg));
    }
    return true;
  });
  const bindings = path.join(dir, "node_modules", "onnxruntime-node", "bin", "napi-v6");
  if (fs.existsSync(bindings)) {
    for (const os of fs.readdirSync(bindings)) {
      const osDir = path.join(bindings, os);
      if (!fs.statSync(osDir).isDirectory()) continue;
      if (os !== platform) {
        drop(osDir);
        continue;
      }
      for (const cpu of fs.readdirSync(osDir)) {
        if (cpu !== arch) drop(path.join(osDir, cpu));
      }
    }
  }
  const worker = path.join(dir, "node_modules", "mediasoup", "worker");
  if ((platform !== "linux" || arch !== "x64") && fs.existsSync(worker)) drop(worker);
  return removed.sort();
}

export function renameModuleDirs(root, modulesDir) {
  const found = [];
  walk(root, (full, entry) => {
    if (entry.isDirectory() && entry.name === "node_modules") found.push(full);
    return false;
  });
  // Deepest first, so a rename never invalidates a path still to be done.
  found.sort((a, b) => b.length - a.length);
  for (const dir of found) fs.renameSync(dir, path.join(path.dirname(dir), modulesDir));
  return found.length;
}

export async function stageDesktopPayload({
  vendorDir,
  rendererDir,
  outDir,
  platform = process.platform,
  arch = process.arch,
}) {
  if (!fs.existsSync(path.join(vendorDir, "odm-payload.json"))) {
    throw new Error(`No server payload at ${vendorDir}; run npm run bundle-server first.`);
  }
  const manifest = readLocalAssetManifest(rendererDir);
  if (!manifest) throw new Error(`No renderer bundle at ${rendererDir}; run npm run build first.`);
  const { MODULES_DIR, ALIASES_FILE, writePayloadManifest } = await runTreeLayout();
  const aliases = collectModuleAliases(vendorDir);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(vendorDir, outDir, { recursive: true, filter: (src) => !isSymlink(src) });
  const report = {
    dropped: pruneServerPayload(outDir),
    sqlite: pruneSqliteBuild(outDir),
    foreign: pruneForeignBinaries(outDir, platform, arch),
    localAssets: dropLocalAssets(outDir, manifest),
    modules: renameModuleDirs(outDir, MODULES_DIR),
    aliases: Object.keys(aliases).length,
  };
  fs.writeFileSync(path.join(outDir, ALIASES_FILE), JSON.stringify(aliases, null, 2) + "\n");
  report.manifest = Object.keys((await writePayloadManifest(outDir)).files).length;
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await stageDesktopPayload({
    vendorDir: path.join(repo, "vendor", "server"),
    rendererDir: path.join(repo, "dist", "renderer"),
    outDir: path.join(repo, "vendor", "desktop"),
  });
  console.log(`Dropped from the payload: ${report.dropped.join(", ") || "nothing"}`);
  console.log(`Binaries for other platforms left out: ${report.foreign.join(", ") || "none"}`);
  console.log(
    `Left out ${report.localAssets} art files the shell carries, ${report.sqlite} SQLite build entries; ` +
      `${report.modules} module folders renamed, ${report.aliases} aliases recorded, ${report.manifest} files in the manifest`,
  );
  console.log("Desktop payload staged at vendor/desktop");
}
