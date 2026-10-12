// Cuts a staged server payload down to what the server reaches at runtime.
//
// Next's standalone tracer copies the whole server worktree, not just what
// server.js loads (the process.cwd() reads in src/lib make every path look
// reachable), so a payload arrives with the repo's docs and plans, worker
// sources, scripts, CI config, Dockerfiles, env examples, agent notes and
// TypeScript. None of it runs inside the desktop app or on the phone, and
// all of it ships on every install unless it is dropped here. Both
// bundlers (scripts/bundle-server.mjs for the desktop payload and
// mobile/scripts/bundle-android-payload.mjs for the APK) call this, so the
// keep-list lives in one place.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// What the server needs at runtime, by top-level payload entry.
export const KEEP = new Set([
  ".next",
  "node_modules",
  "public",
  "models",
  // The Open5e content pack (content/open5e.sqlite), staged by
  // scripts/bundle-server.mjs; the shells point CONTENT_DB_PATH at it.
  "content",
  "server.js",
  "package.json",
  "odm-payload.json",
  "LICENSE",
]);

// The one source directory the server reads from disk
// (src/lib/worlds/index.ts), so it survives while the rest of src goes.
export const KEEP_IN_SRC = path.join("lib", "worlds", "bundled");

// GPU execution providers the embedding runtime would load if a CUDA or
// TensorRT install were present. Embeddings run on the CPU in the apps
// (next.config.ts ships only the build host's Linux binding for that reason),
// and the CUDA provider alone is over 300 MB, so they go on every platform.
const GPU_PROVIDER = /^libonnxruntime_providers_(cuda|tensorrt)\.(so|dll|dylib)(\.\d+)*$/;

// Removes everything outside the keep-list from `dir`, then the build
// leftovers inside what stays. Returns the names of what was dropped,
// sorted, for the bundler's log.
export function pruneServerPayload(dir) {
  const dropped = [];
  for (const entry of fs.readdirSync(dir)) {
    if (KEEP.has(entry)) continue;
    const target = path.join(dir, entry);
    if (entry === "src") {
      const bundled = path.join(target, KEEP_IN_SRC);
      const parked = path.join(dir, ".worlds-bundled");
      if (fs.existsSync(bundled)) fs.renameSync(bundled, parked);
      fs.rmSync(target, { recursive: true, force: true });
      if (fs.existsSync(parked)) {
        fs.mkdirSync(path.dirname(bundled), { recursive: true });
        fs.renameSync(parked, bundled);
      }
      dropped.push("src (except " + KEEP_IN_SRC + ")");
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    dropped.push(entry);
  }
  const traces = pruneBuildTraces(dir);
  if (traces) dropped.push(`.next/server/**/*.nft.json (${traces})`);
  const providers = pruneGpuProviders(dir);
  if (providers) dropped.push(`onnxruntime GPU providers (${providers})`);
  const dead = pruneDeadFiles(dir);
  if (dead) dropped.push(`source maps, type declarations, TypeScript sources, readmes and test folders (${dead})`);
  const tracks = pruneAmbienceLibrary(dir);
  if (tracks) dropped.push(`public/ambience (${tracks} tracks; the admin panel installs the sound pack)`);
  const folded = dedupeChunks(dir);
  if (folded.count) dropped.push(`.next/server/chunks duplicates (${folded.count} copies, ${(folded.bytes / 1048576).toFixed(1)} MB)`);
  return dropped.sort();
}

// Turbopack writes the modules a route shares with other routes into one
// merged chunk per route and names it after the route, so the same bytes
// land under many names: server 0.26.3's build carried 65 copies of one
// 1.1 MB chunk and 84 MB of such copies in all, which the APK and every
// installer then compressed and shipped. The server runtime loads a chunk
// with require() and installs only the module ids it has not seen yet, so a
// copy can hand over the first file's exports instead of carrying them again.
// Only the CommonJS chunk form is folded (the browser-style chunks register
// themselves differently); the trailing source-map comment names the file
// and is the one thing that differs between copies, so it and any trailing
// newline are left out of the comparison. The first name in sorted order keeps the bytes. Returns how
// many copies were folded and the bytes they gave up.
const CJS_CHUNK = /^module\.exports=/;
const SOURCE_MAP_COMMENT = /\n*\/\/# sourceMappingURL=[^\n]*\n?$/;

export function dedupeChunks(dir) {
  const chunks = path.join(dir, ".next", "server", "chunks");
  const files = [];
  walk(chunks, (full, entry) => {
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
    return false;
  });
  files.sort();
  const kept = new Map();
  let count = 0;
  let bytes = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    if (!CJS_CHUNK.test(source)) continue;
    const body = source.replace(SOURCE_MAP_COMMENT, "").trimEnd();
    const key = `${body.length}:${crypto.createHash("sha256").update(body).digest("hex")}`;
    const first = kept.get(key);
    if (!first) {
      kept.set(key, file);
      continue;
    }
    let target = path.relative(path.dirname(file), first).split(path.sep).join("/");
    if (!target.startsWith(".")) target = `./${target}`;
    const stub = `module.exports=require(${JSON.stringify(target)});\n`;
    fs.writeFileSync(file, stub);
    count += 1;
    bytes += Buffer.byteLength(source) - Buffer.byteLength(stub);
  }
  return { count, bytes };
}

// The sound library (public/ambience): some ninety open-licensed recordings
// the server repo ships for the tables it hosts, 145 MB that compress not
// at all. Inside the apps it tripled the APK and every desktop installer,
// so the payload leaves it out and the server offers it as a download
// instead: the same release publishes the folder as ambience-pack.zip, the
// Sound panel and the admin panel install it with one tap, and both shells
// keep the folder across payload upgrades (PRESERVED in
// src/main/local-server.ts and PayloadStore.java), so it is fetched once.
// Returns how many audio files went; the manifest goes with them, since the
// server rebuilds it from the folder.
const AUDIO_FILE = /\.(mp3|ogg|opus|m4a|wav)$/i;

export function pruneAmbienceLibrary(dir) {
  const folder = path.join(dir, "public", "ambience");
  if (!fs.existsSync(folder)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.isFile() && AUDIO_FILE.test(entry.name)) count += 1;
  }
  fs.rmSync(folder, { recursive: true, force: true });
  return count;
}

// Files no running server opens, found under node_modules and the build
// output: source maps (Node reads none without --enable-source-maps, and a
// missing map is not an error), type declarations and the TypeScript
// sources some packages publish beside their JavaScript, readmes and
// changelogs, and packages' own test folders. Licenses stay. A payload
// carried about 1.2 MB of these across some 600 files.
const DEAD_FILE = /\.(map|d\.ts|d\.mts|d\.cts|ts|mts|cts|md|markdown|tsbuildinfo)$/i;
const DEAD_DIR = new Set(["test", "tests", "__tests__", "docs", "example", "examples", ".github"]);

export function pruneDeadFiles(dir) {
  let count = 0;
  const sweep = (root, underModules) =>
    walk(root, (full, entry) => {
      if (entry.isDirectory()) {
        if (underModules && DEAD_DIR.has(entry.name) && path.basename(path.dirname(path.dirname(full))) === "node_modules") {
          fs.rmSync(full, { recursive: true, force: true });
          count += 1;
          return true;
        }
        return false;
      }
      if (!entry.isFile() || !DEAD_FILE.test(entry.name)) return false;
      fs.rmSync(full);
      count += 1;
      return true;
    });
  sweep(path.join(dir, "node_modules"), true);
  sweep(path.join(dir, ".next"), false);
  return count;
}

// Walks `dir` depth first, calling `visit(fullPath, dirent)` for each entry
// before descending into it. A visitor that removes an entry stops the
// descent by returning true.
export function walk(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (visit(full, entry)) continue;
    if (entry.isDirectory()) walk(full, visit);
  }
}

// The file-trace manifests (`route.js.nft.json`) that `next build` writes
// beside every server chunk. They only feed the standalone copy step at
// build time; the running server never opens one, and a payload carries a
// hundred megabytes of them. Returns how many went.
export function pruneBuildTraces(dir) {
  let count = 0;
  walk(path.join(dir, ".next", "server"), (full, entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".nft.json")) return false;
    fs.rmSync(full);
    count += 1;
    return true;
  });
  return count;
}

export function pruneGpuProviders(dir) {
  let count = 0;
  walk(path.join(dir, "node_modules", "onnxruntime-node"), (full, entry) => {
    if (!entry.isFile() || !GPU_PROVIDER.test(entry.name)) return false;
    fs.rmSync(full);
    count += 1;
    return true;
  });
  return count;
}

// Removes every directory called one of `names` found under any
// node_modules in the payload, however deep: a package nested under
// another (next carries its own copy of sharp's binaries) escapes a
// top-level prune. Returns the payload-relative paths removed, sorted.
export function pruneNamedModuleDirs(dir, names) {
  const wanted = new Set(names);
  const removed = [];
  walk(dir, (full, entry) => {
    if (!entry.isDirectory()) return false;
    if (path.basename(path.dirname(full)) !== "node_modules" || !wanted.has(entry.name)) return false;
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(path.relative(dir, full).split(path.sep).join("/"));
    return true;
  });
  return removed.sort();
}

// The art the app carries beside its own game bundle (scripts/
// build-renderer.mjs copies the server's public folders and writes the
// manifest of what it took: host folder to file names). The same bytes
// need not ship a second time inside the payload; the shells put them back
// into the server's public tree when they unpack it (src/main/run-tree.ts
// on the desktop, WorldEnvironment.copyLocalAssets on Android). Returns
// how many files went.
export function dropLocalAssets(dir, manifest) {
  let count = 0;
  const publicDir = path.join(dir, "public");
  for (const [hostDir, files] of Object.entries(manifest)) {
    const folder = path.join(publicDir, ...hostDir.split("/").filter(Boolean));
    for (const file of files) {
      const target = path.join(folder, file);
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target);
      count += 1;
    }
    removeEmptyDirs(folder, publicDir);
  }
  return count;
}

function removeEmptyDirs(dir, stopAt) {
  let current = dir;
  while (current !== stopAt && current.startsWith(stopAt)) {
    if (!fs.existsSync(current) || fs.readdirSync(current).length) return;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

// Reads the manifest the renderer build wrote beside its game bundle
// (`<renderer>/game/public/manifest.json`), or null when that build has
// not run.
export function readLocalAssetManifest(rendererDir) {
  const file = path.join(rendererDir, "game", "public", "manifest.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
