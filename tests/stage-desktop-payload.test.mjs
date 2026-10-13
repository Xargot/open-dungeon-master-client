// The staging step between vendor/server and electron-builder: what it
// renames, records, drops and keeps, on a small stand-in for the payload.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ALIASES_FILE, MODULES_DIR } from "../dist/main/run-tree.js";
import {
  addEmbeddingBindings,
  collectModuleAliases,
  pruneSqliteBuild,
  stageDesktopPayload,
} from "../scripts/stage-desktop-payload.mjs";

function stage(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

const SQLITE = "node_modules/better-sqlite3-multiple-ciphers";

function fakeVendor(dir) {
  stage(dir, {
    "server.js": "x",
    "package.json": "{}",
    "odm-payload.json": JSON.stringify({ serverVersion: "1.0.0", builtAt: "now" }),
    "LICENSE": "MIT",
    "docs/plan.md": "dropped by the prune",
    ".next/server/app/page.js": "x",
    ".next/server/app/page.js.nft.json": "{}",
    "node_modules/next/package.json": "{}",
    "node_modules/next/node_modules/@img/sharp-libvips-linux-x64/lib/libvips.so": "x",
    "node_modules/next/node_modules/@img/sharp-libvips-linuxmusl-x64/lib/libvips.so": "x",
    "node_modules/@img/sharp-linux-x64/lib/sharp.node": "x",
    "node_modules/@img/sharp-linuxmusl-x64/lib/sharp.node": "x",
    "node_modules/@img/colour/index.js": "x",
    "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1": "x",
    "node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/libonnxruntime.so.1": "x",
    "node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.dylib": "x",
    "node_modules/mediasoup/worker/out/Release/mediasoup-worker": "x",
    "node_modules/mediasoup/package.json": "{}",
    "node_modules/@scope/pkg/package.json": "{}",
    [`${SQLITE}/package.json`]: "{}",
    [`${SQLITE}/LICENSE`]: "MIT",
    [`${SQLITE}/lib/index.js`]: "x",
    [`${SQLITE}/build/Release/better_sqlite3.node`]: "binding",
    [`${SQLITE}/build/Release/obj/x.o`]: "object",
    [`${SQLITE}/build/Release/test_extension.node`]: "test",
    [`${SQLITE}/build/Makefile`]: "make",
    [`${SQLITE}/deps/sqlite3/sqlite3.c`]: "source",
    [`${SQLITE}/src/better_sqlite3.cpp`]: "source",
    [`${SQLITE}/bin/linux-x64-140/better_sqlite3.node`]: "prebuilt",
    "public/assets/tiles/floor/grass.webp": "grass",
    "public/assets/ambience/rain.mp3": "rain",
    "public/icon-512.png": "png",
  });
  fs.symlinkSync("mediasoup", path.join(dir, "node_modules/mediasoup-f2b066850faeed90"), "junction");
  fs.symlinkSync("pkg", path.join(dir, "node_modules/@scope/pkg-0123456789abcdef"), "junction");
}

test("the payload is staged in the shape electron-builder packages whole", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-stage-"));
  const vendorDir = path.join(dir, "server");
  const rendererDir = path.join(dir, "renderer");
  const outDir = path.join(dir, "desktop");
  fakeVendor(vendorDir);
  stage(rendererDir, { "game/public/manifest.json": JSON.stringify({ "/assets/tiles/floor/": ["grass.webp"] }) });
  try {
    const report = await stageDesktopPayload({ vendorDir, rendererDir, outDir, platform: "linux", arch: "x64" });
    assert.deepEqual(listFiles(outDir), [
      ".next/server/app/page.js",
      "LICENSE",
      `${MODULES_DIR}/@img/colour/index.js`,
      `${MODULES_DIR}/@img/sharp-linux-x64/lib/sharp.node`,
      `${MODULES_DIR}/@scope/pkg/package.json`,
      `${MODULES_DIR}/better-sqlite3-multiple-ciphers/LICENSE`,
      `${MODULES_DIR}/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node`,
      `${MODULES_DIR}/better-sqlite3-multiple-ciphers/lib/index.js`,
      `${MODULES_DIR}/better-sqlite3-multiple-ciphers/package.json`,
      `${MODULES_DIR}/mediasoup/package.json`,
      `${MODULES_DIR}/mediasoup/worker/out/Release/mediasoup-worker`,
      `${MODULES_DIR}/next/${MODULES_DIR}/@img/sharp-libvips-linux-x64/lib/libvips.so`,
      `${MODULES_DIR}/next/package.json`,
      `${MODULES_DIR}/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1`,
      ALIASES_FILE,
      "odm-payload-manifest.json",
      "odm-payload.json",
      "package.json",
      "public/assets/ambience/rain.mp3",
      "public/icon-512.png",
      "server.js",
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, ALIASES_FILE), "utf8")), {
      "mediasoup-f2b066850faeed90": "mediasoup",
      "@scope/pkg-0123456789abcdef": "@scope/pkg",
    });
    assert.deepEqual(report.foreign, [
      "node_modules/@img/sharp-linuxmusl-x64",
      "node_modules/next/node_modules/@img/sharp-libvips-linuxmusl-x64",
      "node_modules/onnxruntime-node/bin/napi-v6/darwin",
      "node_modules/onnxruntime-node/bin/napi-v6/linux/arm64",
    ]);
    assert.equal(report.localAssets, 1);
    assert.equal(report.modules, 2);
    assert.equal(report.aliases, 2);
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "odm-payload-manifest.json"), "utf8"));
    assert.equal(manifest.version, 1);
    assert.equal(report.manifest, Object.keys(manifest.files).length);
    assert.ok(manifest.files[`${MODULES_DIR}/next/package.json`], "listed as staged, module folders renamed");
    assert.ok(manifest.files["server.js"].sha256.length === 64);
    assert.ok(!("odm-payload.json" in manifest.files) && !("odm-payload-manifest.json" in manifest.files), "the marker and the manifest list nothing of themselves");
    assert.ok(report.dropped.includes("docs"));
    assert.equal(fs.readFileSync(path.join(outDir, MODULES_DIR, "better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node"), "utf8"), "binding");
    // vendor/server is left as it was: the smoke scripts and a dev run use it.
    assert.ok(fs.existsSync(path.join(vendorDir, "node_modules/next/package.json")));
    assert.ok(fs.existsSync(path.join(vendorDir, "docs/plan.md")));
    assert.ok(fs.lstatSync(path.join(vendorDir, "node_modules/mediasoup-f2b066850faeed90")).isSymbolicLink());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("staging refuses to run before the renderer bundle exists", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-stage-"));
  const vendorDir = path.join(dir, "server");
  fakeVendor(vendorDir);
  try {
    await assert.rejects(
      stageDesktopPayload({ vendorDir, rendererDir: path.join(dir, "renderer"), outDir: path.join(dir, "desktop") }),
      /npm run build/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing SQLite binding is an error, not a silently broken app", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-stage-"));
  stage(dir, { [`${SQLITE}/package.json`]: "{}", [`${SQLITE}/build/Makefile`]: "x" });
  try {
    assert.throws(() => pruneSqliteBuild(dir), /binding is missing/);
    assert.equal(pruneSqliteBuild(path.join(dir, "nowhere")), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("aliases are read off the links, scoped ones included", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-stage-"));
  fakeVendor(dir);
  try {
    assert.deepEqual(collectModuleAliases(dir), {
      "mediasoup-f2b066850faeed90": "mediasoup",
      "@scope/pkg-0123456789abcdef": "@scope/pkg",
    });
    assert.deepEqual(collectModuleAliases(path.join(dir, "nowhere")), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a mac or windows package leaves every Linux binary behind", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-stage-"));
  const vendorDir = path.join(dir, "server");
  const rendererDir = path.join(dir, "renderer");
  const outDir = path.join(dir, "desktop");
  fakeVendor(vendorDir);
  stage(rendererDir, { "game/public/manifest.json": "{}" });
  try {
    const report = await stageDesktopPayload({ vendorDir, rendererDir, outDir, platform: "darwin", arch: "arm64" });
    assert.deepEqual(report.foreign, [
      "node_modules/@img/sharp-linux-x64",
      "node_modules/@img/sharp-linuxmusl-x64",
      "node_modules/mediasoup/worker",
      "node_modules/next/node_modules/@img/sharp-libvips-linux-x64",
      "node_modules/next/node_modules/@img/sharp-libvips-linuxmusl-x64",
      "node_modules/onnxruntime-node/bin/napi-v6/linux",
    ]);
    const left = listFiles(outDir);
    assert.ok(left.includes(`${MODULES_DIR}/@img/colour/index.js`));
    assert.ok(left.includes(`${MODULES_DIR}/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.dylib`));
    assert.ok(!left.some((file) => file.includes("linux")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the embedding runtime reaches every desktop package, not only Linux", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-stage-"));
  const vendorDir = path.join(dir, "server");
  const install = path.join(dir, "install", "node_modules");
  const rendererDir = path.join(dir, "renderer");
  const outDir = path.join(dir, "desktop");
  const NAPI = "onnxruntime-node/bin/napi-v6";
  // What the server's standalone trace ships: the linux/x64 binding alone.
  stage(vendorDir, {
    "server.js": "x",
    "package.json": "{}",
    "odm-payload.json": JSON.stringify({ serverVersion: "1.0.0", builtAt: "now" }),
    "node_modules/onnxruntime-node/package.json": "{}",
    "node_modules/onnxruntime-node/dist/index.js": "x",
    [`node_modules/${NAPI}/linux/x64/onnxruntime_binding.node`]: "traced",
  });
  // The full install the payload is built from carries every platform.
  stage(install, {
    [`${NAPI}/linux/x64/onnxruntime_binding.node`]: "install",
    [`${NAPI}/linux/arm64/onnxruntime_binding.node`]: "x",
    [`${NAPI}/win32/x64/onnxruntime_binding.node`]: "win",
    [`${NAPI}/win32/x64/onnxruntime.dll`]: "win",
    [`${NAPI}/win32/arm64/onnxruntime_binding.node`]: "x",
    [`${NAPI}/darwin/arm64/onnxruntime_binding.node`]: "mac",
  });
  stage(rendererDir, { "game/public/manifest.json": "{}" });
  try {
    assert.deepEqual(addEmbeddingBindings(vendorDir, install), ["darwin/arm64", "win32/x64"]);
    // Only packaged targets are added, and the traced binding is kept as is.
    const vendored = listFiles(path.join(vendorDir, "node_modules", NAPI));
    assert.deepEqual(vendored, [
      "darwin/arm64/onnxruntime_binding.node",
      "linux/x64/onnxruntime_binding.node",
      "win32/x64/onnxruntime.dll",
      "win32/x64/onnxruntime_binding.node",
    ]);
    assert.equal(fs.readFileSync(path.join(vendorDir, "node_modules", NAPI, "linux/x64/onnxruntime_binding.node"), "utf8"), "traced");
    // A second run adds nothing.
    assert.deepEqual(addEmbeddingBindings(vendorDir, install), []);

    await stageDesktopPayload({ vendorDir, rendererDir, outDir, platform: "win32", arch: "x64" });
    const left = listFiles(outDir).filter((file) => file.includes("napi-v6"));
    assert.deepEqual(left, [
      `${MODULES_DIR}/${NAPI}/win32/x64/onnxruntime.dll`,
      `${MODULES_DIR}/${NAPI}/win32/x64/onnxruntime_binding.node`,
    ]);
    assert.throws(() => addEmbeddingBindings(vendorDir, path.join(dir, "nowhere")), /No onnxruntime-node bindings/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
