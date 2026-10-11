// Builds the Open Dungeon Master server as a Next.js standalone bundle and
// stages it under vendor/server, ready to ship inside the desktop app for
// offline play. Builds from a clean git worktree of the server repo so the
// server checkout's own .next (often serving a live instance) is untouched.
//
//   ODM_SERVER_DIR=/path/to/open-dungeon-master npm run bundle-server
//
// The native better-sqlite3 module is rebuilt for Electron's ABI, because the
// bundled server runs under the Electron binary in Node mode.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { pruneServerPayload } from "./prune-server-payload.mjs";
import { addEmbeddingBindings } from "./stage-desktop-payload.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.resolve(
  process.env.ODM_SERVER_DIR ?? path.join(repo, "..", "open-dungeon-master"),
);
const vendorDir = path.join(repo, "vendor", "server");

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// The content pack from a server release, gunzipped into place. False when
// that release has no such asset (an unreleased version) or the download
// fails, in which case the caller builds the pack instead.
async function fetchPack(url, dest) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = gunzipSync(Buffer.from(await response.arrayBuffer()));
      fs.writeFileSync(dest, bytes);
      console.log(`Content pack taken from ${url} (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB)`);
      return true;
    } catch (error) {
      console.log(`Content pack download failed (${error instanceof Error ? error.message : error}), attempt ${attempt} of 3`);
    }
  }
  return false;
}

if (!fs.existsSync(path.join(serverDir, "package.json"))) {
  console.error(`No server checkout at ${serverDir}. Set ODM_SERVER_DIR.`);
  process.exit(1);
}

const serverPkg = JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"), "utf8"));
const electronPkg = JSON.parse(
  fs.readFileSync(path.join(repo, "node_modules", "electron", "package.json"), "utf8"),
);
const commit = execFileSync("git", ["-C", serverDir, "rev-parse", "--short", "HEAD"], {
  encoding: "utf8",
}).trim();

// Build on the same filesystem as the server checkout: node_modules is
// brought over with a reflink copy (Turbopack rejects a symlink that points
// outside the project root), which is nearly free on btrfs/XFS and degrades
// to a real copy elsewhere.
const buildRoot = process.env.ODM_BUILD_DIR ?? path.join(os.homedir(), ".cache");
fs.mkdirSync(buildRoot, { recursive: true });
const buildDir = fs.mkdtempSync(path.join(buildRoot, "odm-server-build-"));
fs.rmdirSync(buildDir);
console.log(`Building server ${serverPkg.version} (${commit}) in ${buildDir}`);
run("git", ["-C", serverDir, "worktree", "add", "--detach", buildDir, "HEAD"]);

try {
  // Keep the source checkout's live .next untouched, while allowing a local
  // development build to include tracked, uncommitted fixes. Release builds
  // use a clean checkout, so this is a no-op there.
  const sourceDiff = execFileSync("git", ["-C", serverDir, "diff", "--binary", "HEAD"]);
  if (sourceDiff.length) {
    execFileSync("git", ["-C", buildDir, "apply", "--binary", "-"], { input: sourceDiff });
  }
  fs.cpSync(path.join(serverDir, "node_modules"), path.join(buildDir, "node_modules"), {
    recursive: true,
  });
  // The postinstall step copies dice assets into public/, which git ignores.
  run(process.execPath, ["scripts/copy-dice-assets.mjs"], { cwd: buildDir });
  run(process.execPath, [path.join(buildDir, "node_modules", "next", "dist", "bin", "next"), "build"], {
    cwd: buildDir,
    env: { ...process.env, DOCKER_BUILD: "1" },
  });

  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(vendorDir), { recursive: true });
  fs.cpSync(path.join(buildDir, ".next", "standalone"), vendorDir, { recursive: true });
  fs.cpSync(path.join(buildDir, ".next", "static"), path.join(vendorDir, ".next", "static"), {
    recursive: true,
  });
  fs.cpSync(path.join(buildDir, "public"), path.join(vendorDir, "public"), { recursive: true });
  // Next's standalone tracer includes sharp's native addon, but can omit the
  // adjacent platform runtime libraries that the addon loads dynamically
  // (libvips on Windows). Merge the installed platform package so the
  // packaged server can load sharp for Whisper model installation.
  const sharpPlatform = `sharp-${process.platform}-${process.arch}`;
  const sharpPlatformSource = path.join(buildDir, "node_modules", "@img", sharpPlatform);
  if (fs.existsSync(sharpPlatformSource)) {
    fs.cpSync(
      sharpPlatformSource,
      path.join(vendorDir, "node_modules", "@img", sharpPlatform),
      { recursive: true },
    );
  }
  const bindings = addEmbeddingBindings(vendorDir, path.join(buildDir, "node_modules"));
  console.log(`Embedding runtime bindings added for ${bindings.join(", ") || "no other target"}`);

  // The content pack: spells, items, monsters and feats, which every picker
  // in the character builder and the workshop searches. It is a build
  // artifact in the server repo (data/ is ignored), so it is taken from the
  // checkout when it has one and built in the worktree otherwise, the same
  // way the Docker image bakes it. Staged outside data/ so a data volume
  // or a preserved directory can never hide it, and the shells point
  // CONTENT_DB_PATH at it.
  const packRel = path.join("data", "content", "open5e.sqlite");
  let pack = path.join(serverDir, packRel);
  if (!fs.existsSync(pack)) {
    // Every server release carries the pack as an asset (open5e.sqlite.gz),
    // which is far more dependable than rebuilding it from api.open5e.com
    // on a CI runner; the import stays as the fallback for an unreleased
    // server version.
    pack = path.join(buildDir, packRel);
    fs.mkdirSync(path.dirname(pack), { recursive: true });
    const asset = `https://github.com/Lebbitheplow/open-dungeon-master/releases/download/v${serverPkg.version}/open5e.sqlite.gz`;
    const fetched = await fetchPack(asset, pack);
    if (!fetched) {
      console.log("No content pack in the server checkout or its release; importing one for the payload");
      run(process.execPath, ["scripts/import-open5e.mjs"], { cwd: buildDir });
    }
  }
  if (!fs.existsSync(pack)) {
    console.error(`The content pack was not produced at ${pack}.`);
    process.exit(1);
  }
  fs.mkdirSync(path.join(vendorDir, "content"), { recursive: true });
  fs.copyFileSync(pack, path.join(vendorDir, "content", "open5e.sqlite"));

  fs.writeFileSync(
    path.join(vendorDir, "odm-payload.json"),
    JSON.stringify(
      {
        serverVersion: serverPkg.version,
        commit,
        builtAt: new Date().toISOString(),
        electron: electronPkg.version,
      },
      null,
      2,
    ),
  );
  // The tracer swept the whole worktree into the payload; keep only what
  // the server reaches at runtime (scripts/prune-server-payload.mjs).
  console.log(`Dropped from the payload: ${pruneServerPayload(vendorDir).join(", ")}`);
} finally {
  fs.rmSync(path.join(buildDir, "node_modules"), { recursive: true, force: true });
  run("git", ["-C", serverDir, "worktree", "remove", "--force", buildDir]);
}

// Prune the dangling symlinks the standalone tracer leaves behind and
// create the hashed-id aliases Turbopack's serverExternalPackages need;
// CI platform jobs rerun the same script after unpacking the payload.
run(process.execPath, ["scripts/alias-server-modules.mjs"], { cwd: repo });

console.log(`Rebuilding native modules for Electron ${electronPkg.version}`);
run(
  process.execPath,
  [
    path.join(repo, "node_modules", "@electron", "rebuild", "lib", "cli.js"),
    "--version",
    electronPkg.version,
    "--module-dir",
    vendorDir,
    "--force",
    "--only",
    "better-sqlite3-multiple-ciphers",
  ],
  { cwd: repo },
);

console.log(`Payload staged at vendor/server`);
