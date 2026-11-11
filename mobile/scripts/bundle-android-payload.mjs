// Stages what the Android app needs to host a world on the phone:
//
//   android/app/src/main/assets/server-payload.zip.xz   the server, from the
//       desktop payload at ../vendor/server (npm run bundle-server at the
//       repo root) minus every native module, since the phone runs it on
//       Node's built-in SQLite and has no GPU workers or voice SFU, and
//       minus the art the app already carries in its web assets
//       (www/game, built by npm run build here first), which
//       WorldEnvironment.copyLocalAssets puts back when the zip is unpacked;
//       a stored zip compressed whole with xz (packPayload below)
//   android/app/src/main/assets/server-payload.json  its odm-payload.json,
//       read on the phone before unzipping to decide whether to upgrade
//   android/app/src/main/jniLibs/<abi>/libnode.so    the Node runtime built
//       for Android (scripts/build-node-android.sh), taken from
//       runtime/node-android/<abi>/libnode.so
//   android/app/src/main/jniLibs/<abi>/libcloudflared.so   cloudflared built
//       for Android (scripts/build-cloudflared-android.sh), taken from
//       runtime/cloudflared-android/<abi>/; without it a device can host on
//       its Wi-Fi but not share online
//
// Everything written here is a build artifact (gitignored). CI runs this
// after unpacking the shared payload artifact and fetching the runtime.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dropLocalAssets,
  pruneNamedModuleDirs,
  pruneServerPayload,
  readLocalAssetManifest,
} from "../../scripts/prune-server-payload.mjs";

const mobile = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.dirname(mobile);
const vendor = process.env.ODM_SERVER_PAYLOAD || path.join(repo, "vendor", "server");
const runtime = process.env.ODM_NODE_ANDROID || path.join(mobile, "runtime", "node-android");
const cloudflared =
  process.env.ODM_CLOUDFLARED_ANDROID || path.join(mobile, "runtime", "cloudflared-android");
const assets = path.join(mobile, "android", "app", "src", "main", "assets");
const jniLibs = path.join(mobile, "android", "app", "src", "main", "jniLibs");
const ABIS = ["arm64-v8a", "x86_64"];

// Native modules the phone cannot load; the server degrades without them
// (built-in SQLite, no embeddings, mesh voice only, no image transcoding).
export const PRUNE = [
  "node_modules/better-sqlite3-multiple-ciphers",
  "node_modules/onnxruntime-node",
  "node_modules/onnxruntime-common",
  "node_modules/mediasoup/worker",
];
// Packages that may sit under another package's own node_modules as well
// as at the top (next carries sharp's binaries), so they are hunted at any
// depth. The embedding pipeline goes with its runtime: the server only
// loads it on demand (src/lib/embeddings.ts) and reports the feature as
// unavailable when the import fails.
export const PRUNE_ANYWHERE = ["@img", "sharp", "@huggingface"];

// Lays the payload out under `staging` the way the zip will hold it.
// Links are copied as links and pruned as part of the tree, so an alias of
// a pruned package goes with it and an alias of a kept one still points at
// the pruned copy; `zip -r` then follows what is left into real folders,
// which is what Java's unzip needs. Returns what was left out, for the log.
export function stageAndroidPayload(vendorDir, staging, manifest) {
  fs.cpSync(vendorDir, staging, { recursive: true, verbatimSymlinks: true });
  for (const rel of PRUNE) {
    const target = path.join(staging, rel);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
  const nested = pruneNamedModuleDirs(staging, PRUNE_ANYWHERE);
  // The desktop bundler already pruned the payload to what the server
  // reaches at runtime; run the same prune again so a payload staged some
  // other way (an older artifact, a hand copy) ships nothing extra either.
  const dropped = pruneServerPayload(staging);
  const localAssets = dropLocalAssets(staging, manifest);
  // Aliases of pruned packages would dangle after the prune; drop them too.
  const modules = path.join(staging, "node_modules");
  let dangling = 0;
  for (const entry of fs.readdirSync(modules)) {
    const full = path.join(modules, entry);
    if (!fs.lstatSync(full).isSymbolicLink()) continue;
    if (fs.existsSync(full)) continue;
    fs.rmSync(full, { recursive: true, force: true });
    dangling += 1;
  }
  return { dropped, nested, localAssets, dangling };
}

// The asset WorldRuntime.java unpacks; its name says how to open it.
export const PAYLOAD_ASSET = "server-payload.zip.xz";

// Every entry the zip holds, folders first and then files grouped by
// extension, with links followed the way `zip -r` follows them (a folder
// reached twice through links is listed once per path, as zip would).
// The order is what makes the payload small: xz sees the whole stored zip
// as one stream, and the server's thousands of JS chunks, which share most
// of their code, sit next to each other within its dictionary.
export function payloadEntries(root) {
  const out = [];
  const walk = (rel, seen) => {
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      const child = rel ? `${rel}/${name}` : name;
      const full = path.join(root, child);
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) {
        // A link back up its own path would never end; zip skips those too.
        const real = fs.realpathSync(full);
        if (seen.has(real)) continue;
        out.push(`${child}/`);
        walk(child, new Set([...seen, real]));
      } else if (stat.isFile()) {
        out.push(child);
      }
    }
  };
  walk("", new Set([fs.realpathSync(root)]));
  const kind = (entry) => (entry.endsWith("/") ? "" : `.${path.posix.extname(entry)}`);
  return out.sort((a, b) => {
    const byKind = kind(a) < kind(b) ? -1 : kind(a) > kind(b) ? 1 : 0;
    return byKind || (a < b ? -1 : a > b ? 1 : 0);
  });
}

// Writes the staged tree as a stored zip compressed whole with xz. A zip
// deflated per file came to 35 MB for 0.32.1's payload, as each file was
// squeezed alone; the same tree as one xz stream is about 10 MB, a quarter
// of the APK. The dictionary is 32 MiB, not -9's 64: the phone holds it
// in its Java heap while it unpacks, and the larger one saves under 1 MB.
// One thread keeps it one block, which XZ for Java reads as a stream.
export function packPayload(staging, out) {
  const stored = `${out}.zip-tmp`;
  fs.rmSync(stored, { force: true });
  fs.rmSync(out, { force: true });
  try {
    execFileSync("zip", ["-q", "-X", "-0", "-@", stored], {
      cwd: staging,
      input: payloadEntries(staging).join("\n"),
      stdio: ["pipe", "inherit", "inherit"],
    });
    const fd = fs.openSync(out, "w");
    try {
      execFileSync("xz", ["--format=xz", "--lzma2=preset=9e,dict=32MiB", "--threads=1", "--stdout", stored], {
        stdio: ["ignore", fd, "inherit"],
      });
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.rmSync(stored, { force: true });
  }
}

// Everything below is the staging run itself; the functions above are what tests import.
function main() {
  if (!fs.existsSync(path.join(vendor, "odm-payload.json"))) {
    console.error(`No server payload at ${vendor}; run "npm run bundle-server" at the repo root first.`);
    process.exit(1);
  }

  const manifest = readLocalAssetManifest(path.join(mobile, "www"));
  if (!manifest) {
    console.error("No web assets at mobile/www; run \"npm run build\" in mobile first (the payload leaves out the art they carry).");
    process.exit(1);
  }
  const staging = fs.mkdtempSync(path.join(mobile, ".payload-"));
  try {
    const report = stageAndroidPayload(vendor, staging, manifest);
    console.log(`Dropped from the payload: ${[...report.dropped, ...report.nested].join(", ")}`);
    console.log(`Left out ${report.localAssets} art files the app carries; ${report.dangling} dangling aliases removed`);
    fs.mkdirSync(assets, { recursive: true });
    // The deflated zip earlier builds wrote, so a local tree does not ship both.
    fs.rmSync(path.join(assets, "server-payload.zip"), { force: true });
    const packed = path.join(assets, PAYLOAD_ASSET);
    packPayload(staging, packed);
    fs.copyFileSync(path.join(vendor, "odm-payload.json"), path.join(assets, "server-payload.json"));
    const size = (fs.statSync(packed).size / 1024 / 1024).toFixed(1);
    console.log(`Server payload packed: ${size} MB`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  // The NDK ships libc++_shared.so with its debug info and full symbol table,
  // nine megabytes of it per ABI. Nothing on the phone reads any of that: the
  // app never loads the library itself (node and cloudflared are child
  // processes with this directory on their LD_LIBRARY_PATH), so the symbols
  // only ever cost the user their download. Stripping keeps every dynamic
  // symbol the loader resolves against and takes the file to about 1.2 MB.
  function findLlvmStrip() {
    const roots = [
      process.env.ANDROID_NDK_HOME,
      process.env.ANDROID_NDK_LATEST_HOME,
      process.env.ANDROID_NDK_ROOT,
    ].filter(Boolean);
    for (const sdk of [
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      path.join(os.homedir(), "Android", "Sdk"),
    ]) {
      const ndks = sdk && path.join(sdk, "ndk");
      if (!ndks || !fs.existsSync(ndks)) continue;
      // Newest NDK first, so a stale one beside it is not what gets picked.
      for (const version of fs.readdirSync(ndks).sort().reverse()) {
        roots.push(path.join(ndks, version));
      }
    }
    for (const root of roots) {
      const prebuilt = path.join(root, "toolchains", "llvm", "prebuilt");
      if (!fs.existsSync(prebuilt)) continue;
      for (const host of fs.readdirSync(prebuilt)) {
        const tool = path.join(prebuilt, host, "bin", "llvm-strip");
        if (fs.existsSync(tool)) return tool;
      }
    }
    return null;
  }

  const llvmStrip = findLlvmStrip();
  if (!llvmStrip) {
    console.warn(
      "No llvm-strip found (set ANDROID_NDK_HOME or install an NDK under the SDK); " +
        "libc++_shared.so ships unstripped and the download is about 8 MB larger per ABI.",
    );
  }

  function stripDebugSymbols(file) {
    if (!llvmStrip) return;
    const before = fs.statSync(file).size;
    execFileSync(llvmStrip, ["--strip-debug", "--strip-unneeded", file], { stdio: "inherit" });
    const after = fs.statSync(file).size;
    const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
    console.log(`Stripped ${path.basename(file)}: ${mb(before)} MB -> ${mb(after)} MB`);
  }

  // The runtime is the stripped node executable plus the NDK's libc++_shared
  // it links against; both sit in the app's native library directory, which
  // is also the child process's LD_LIBRARY_PATH.
  const RUNTIME_FILES = ["libnode.so", "libc++_shared.so"];
  let shipped = 0;
  for (const abi of ABIS) {
    const sources = RUNTIME_FILES.map((name) => path.join(runtime, abi, name));
    if (!sources.every((file) => fs.existsSync(file))) {
      console.warn(`No complete Node runtime for ${abi} under ${runtime}; phones on that ABI will be connect-only.`);
      continue;
    }
    const dir = path.join(jniLibs, abi);
    fs.mkdirSync(dir, { recursive: true });
    for (const [index, name] of RUNTIME_FILES.entries()) {
      const target = path.join(dir, name);
      fs.copyFileSync(sources[index], target);
      if (name === "libc++_shared.so") stripDebugSymbols(target);
    }
    shipped += 1;
    console.log(`Node runtime staged for ${abi}`);
    const tunnelBinary = path.join(cloudflared, abi, "libcloudflared.so");
    const staged = path.join(dir, "libcloudflared.so");
    fs.rmSync(staged, { force: true });
    if (fs.existsSync(tunnelBinary)) {
      fs.copyFileSync(tunnelBinary, staged);
      console.log(`cloudflared staged for ${abi}`);
    } else {
      console.warn(`No cloudflared for ${abi} under ${cloudflared}; devices on that ABI cannot share online.`);
    }
  }
  if (!shipped) {
    console.error("No Node runtime staged for any ABI.");
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
