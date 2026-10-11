// The Android staging of the shared payload: native modules pruned before
// the aliases are followed, nested copies hunted down, the app's own art
// left out, and nothing dangling for the zip to trip over.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PRUNE, PRUNE_ANYWHERE, stageAndroidPayload } from "../mobile/scripts/bundle-android-payload.mjs";

function stage(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

// Files as the zip will see them: `zip -r` follows directory links, so an
// alias contributes its target's files under its own name.
function listAsZipped(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (fs.statSync(full).isDirectory()) walk(full, name);
      else out.push(name);
    }
  };
  walk(root, "");
  return out.sort();
}

test("the phone's payload keeps only what Node on Android can run", {
  skip: process.platform === "win32" && "Android payload packaging is outside the Windows desktop target",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-android-"));
  const vendorDir = path.join(dir, "server");
  const staging = path.join(dir, "staging");
  stage(vendorDir, {
    "server.js": "x",
    "odm-payload.json": "{}",
    ".next/server/app/page.js": "x",
    ".next/server/app/page.js.nft.json": "{}",
    "node_modules/next/package.json": "{}",
    "node_modules/next/node_modules/@img/sharp-libvips-linux-x64/lib/libvips.so": "x64 binary",
    "node_modules/next/node_modules/sharp/lib/index.js": "x",
    "node_modules/mediasoup/package.json": "{}",
    "node_modules/mediasoup/node/lib/index.js": "x",
    "node_modules/mediasoup/worker/out/Release/mediasoup-worker": "x64 binary",
    "node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node": "x64 binary",
    "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1": "x64 binary",
    "node_modules/onnxruntime-common/dist/index.js": "x",
    "node_modules/@huggingface/transformers/dist/transformers.js": "x",
    "node_modules/@img/sharp-linux-x64/lib/sharp.node": "x64 binary",
    "public/assets/tiles/floor/grass.webp": "grass",
    "public/assets/ambience/rain.mp3": "rain",
  });
  const modules = path.join(vendorDir, "node_modules");
  fs.symlinkSync("mediasoup", path.join(modules, "mediasoup-f2b066850faeed90"), "junction");
  fs.symlinkSync("better-sqlite3-multiple-ciphers", path.join(modules, "better-sqlite3-multiple-ciphers-e07168e96e7c9c18"), "junction");
  fs.symlinkSync("@huggingface/transformers", path.join(modules, "transformers-31f28a0eb9b916d1"), "junction");
  try {
    const report = stageAndroidPayload(vendorDir, staging, { "/assets/tiles/floor/": ["grass.webp"] });
    assert.deepEqual(listAsZipped(staging), [
      ".next/server/app/page.js",
      "node_modules/mediasoup-f2b066850faeed90/node/lib/index.js",
      "node_modules/mediasoup-f2b066850faeed90/package.json",
      "node_modules/mediasoup/node/lib/index.js",
      "node_modules/mediasoup/package.json",
      "node_modules/next/package.json",
      "odm-payload.json",
      "public/assets/ambience/rain.mp3",
      "server.js",
    ]);
    assert.equal(report.localAssets, 1);
    assert.equal(report.dangling, 2);
    assert.deepEqual(report.nested, [
      "node_modules/@huggingface",
      "node_modules/@img",
      "node_modules/next/node_modules/@img",
      "node_modules/next/node_modules/sharp",
    ]);
    // The alias is still a link in the staging tree (the zip follows it),
    // and the source payload is untouched.
    assert.ok(fs.lstatSync(path.join(staging, "node_modules/mediasoup-f2b066850faeed90")).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(vendorDir, "node_modules/mediasoup/worker/out/Release/mediasoup-worker")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the prune lists name what the phone cannot load", () => {
  assert.ok(PRUNE.includes("node_modules/onnxruntime-node"));
  assert.ok(PRUNE.includes("node_modules/mediasoup/worker"));
  assert.ok(PRUNE_ANYWHERE.includes("@img"));
  assert.ok(PRUNE_ANYWHERE.includes("sharp"));
});
