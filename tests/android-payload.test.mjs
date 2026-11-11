// The Android staging of the shared payload: native modules pruned before
// the aliases are followed, nested copies hunted down, the app's own art
// left out, and nothing dangling for the zip to trip over.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { PRUNE, PRUNE_ANYWHERE, packPayload, payloadEntries, stageAndroidPayload } from "../mobile/scripts/bundle-android-payload.mjs";

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

test("the phone's payload keeps only what Node on Android can run", () => {
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

// The packing tools the release job has; a desktop without them skips the
// round trip, not the order.
const hasTools = ["zip", "xz", "unzip"].every((tool) => spawnSync(tool, ["-h"], { stdio: "ignore" }).error === undefined);

test("the payload zip lists folders first, then files side by side by kind, through links", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-android-pack-"));
  stage(dir, {
    "server.js": "s",
    "odm-payload.json": "{}",
    ".next/server/chunks/b.js": "b",
    ".next/server/chunks/a.js": "a",
    ".next/server/app/page.rsc": "r",
    "node_modules/next/package.json": "{}",
    "node_modules/next/dist/index.js": "n",
  });
  fs.symlinkSync("next", path.join(dir, "node_modules/next-0123456789abcdef"), "junction");
  // A link back up its own path: zip skips it, and so does the order.
  fs.symlinkSync("..", path.join(dir, "node_modules/next/dist/up"), "junction");
  try {
    assert.deepEqual(payloadEntries(dir), [
      ".next/",
      ".next/server/",
      ".next/server/app/",
      ".next/server/chunks/",
      "node_modules/",
      "node_modules/next-0123456789abcdef/",
      "node_modules/next-0123456789abcdef/dist/",
      "node_modules/next/",
      "node_modules/next/dist/",
      ".next/server/chunks/a.js",
      ".next/server/chunks/b.js",
      "node_modules/next-0123456789abcdef/dist/index.js",
      "node_modules/next/dist/index.js",
      "server.js",
      "node_modules/next-0123456789abcdef/package.json",
      "node_modules/next/package.json",
      "odm-payload.json",
      ".next/server/app/page.rsc",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the packed payload is a stored zip inside one xz stream, holding every file", { skip: !hasTools }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-android-pack-"));
  const tree = path.join(dir, "tree");
  const chunk = "export const shared = " + JSON.stringify("x".repeat(4000)) + ";\n";
  stage(tree, {
    "server.js": chunk,
    "odm-payload.json": "{}",
    ".next/server/chunks/a.js": chunk + "a",
    ".next/server/chunks/b.js": chunk + "b",
  });
  fs.symlinkSync(".next", path.join(tree, "alias"), "junction");
  const out = path.join(dir, "server-payload.zip.xz");
  try {
    packPayload(tree, out);
    assert.equal(fs.readFileSync(out).subarray(0, 6).toString("latin1"), "\xfd7zXZ\x00");
    const zip = path.join(dir, "inner.zip");
    fs.writeFileSync(zip, execFileSync("xz", ["-dc", out]));
    const listed = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(listed, payloadEntries(tree));
    // Stored, so the compression is xz's across files, not zip's per file.
    const verbose = execFileSync("unzip", ["-v", zip], { encoding: "utf8" });
    assert.doesNotMatch(verbose, /Defl/);
    assert.match(verbose, /Stored/);
    // The leftover temp zip is gone, and the duplicated chunks cost little.
    assert.deepEqual(fs.readdirSync(dir).sort(), ["inner.zip", "server-payload.zip.xz", "tree"]);
    assert.ok(fs.statSync(out).size < 2000, `packed to ${fs.statSync(out).size} bytes`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
