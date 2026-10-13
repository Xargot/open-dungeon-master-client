// The desktop payload is packaged in one shape (scripts/
// stage-desktop-payload.mjs) and run from another; this checks the way
// back: module folders renamed, aliases linked, the shell's art restored.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ALIASES_FILE,
  MODULES_DIR,
  linkModuleAliases,
  materializeRunTree,
  restoreLocalAssets,
  restoreModuleDirs,
} from "../dist/main/run-tree.js";

function stage(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "odm-run-tree-"));
}

// The link at an alias path, or a missing one, taken off without touching
// the package it names (Windows wants rmdir for a directory junction on some
// Node builds, unlink on others).
function dropLink(link) {
  try {
    fs.unlinkSync(link);
  } catch (error) {
    if (error.code === "ENOENT") return;
    fs.rmdirSync(link);
  }
}

// The way the device world does it (payload-store.ts): unpacked beside the
// live tree as run.new, renamed into place, and only then linked.
test("a staged payload becomes a runnable server tree in user data", async () => {
  const dir = scratch();
  const payload = path.join(dir, "payload");
  const renderer = path.join(dir, "renderer");
  const run = path.join(dir, "run");
  stage(payload, {
    "server.js": "require('next')",
    "odm-payload.json": "{}",
    [`${MODULES_DIR}/next/package.json`]: "{}",
    [`${MODULES_DIR}/next/${MODULES_DIR}/@img/sharp/index.js`]: "x",
    [`${MODULES_DIR}/mediasoup/package.json`]: "{}",
    [ALIASES_FILE]: JSON.stringify({ "mediasoup-f2b066850faeed90": "mediasoup", "gone-0123456789abcdef": "gone" }),
    "public/icon-512.png": "png",
  });
  stage(renderer, {
    "game/public/manifest.json": JSON.stringify({
      "/assets/tiles/floor/": ["grass.webp"],
      "/assets/icons/spell/": ["fireball.webp"],
      "/assets/ui/door/": ["horror.webp"],
      "/fx/": ["loop.webp", "missing.webp"],
    }),
    "game/public/assets/tiles/floor/grass.webp": "grass",
    "game/icons/spell/fireball.webp": "icon",
    "game/ui-art/door/horror.webp": "door",
    "game/public/fx/loop.webp": "fx",
  });
  try {
    await materializeRunTree(payload, `${run}.new`, renderer);
    fs.renameSync(`${run}.new`, run);
    linkModuleAliases(run);
    assert.ok(fs.existsSync(path.join(run, "node_modules/next/package.json")));
    assert.ok(fs.existsSync(path.join(run, "node_modules/next/node_modules/@img/sharp/index.js")));
    assert.ok(!fs.existsSync(path.join(run, MODULES_DIR)));
    const alias = path.join(run, "node_modules/mediasoup-f2b066850faeed90");
    assert.ok(fs.lstatSync(alias).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(alias, "package.json")), "the alias reaches its package where the tree runs");
    assert.equal(fs.realpathSync.native(alias), fs.realpathSync.native(path.join(run, "node_modules/mediasoup")));
    assert.ok(!fs.existsSync(path.join(run, "node_modules/gone-0123456789abcdef")));
    assert.equal(fs.readFileSync(path.join(run, "public/assets/tiles/floor/grass.webp"), "utf8"), "grass");
    assert.equal(fs.readFileSync(path.join(run, "public/assets/icons/spell/fireball.webp"), "utf8"), "icon");
    assert.equal(fs.readFileSync(path.join(run, "public/assets/ui/door/horror.webp"), "utf8"), "door");
    assert.equal(fs.readFileSync(path.join(run, "public/fx/loop.webp"), "utf8"), "fx");
    assert.ok(!fs.existsSync(path.join(run, "public/fx/missing.webp")));
    assert.equal(fs.readFileSync(path.join(run, "public/icon-512.png"), "utf8"), "png");
    // The marker arrives last, whole.
    assert.equal(fs.readFileSync(path.join(run, "odm-payload.json"), "utf8"), "{}");
    assert.ok(!fs.existsSync(path.join(run, "odm-payload.json.part")));
    // The staged payload itself is untouched.
    assert.ok(fs.existsSync(path.join(payload, `${MODULES_DIR}/next/package.json`)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a payload in the plain layout (a dev checkout's vendor/server) passes through unchanged", async () => {
  const dir = scratch();
  const payload = path.join(dir, "payload");
  const run = path.join(dir, "run");
  stage(payload, { "server.js": "x", "node_modules/next/package.json": "{}", "public/fx/loop.webp": "fx" });
  try {
    await materializeRunTree(payload, run, path.join(dir, "no-renderer"));
    assert.ok(fs.existsSync(path.join(run, "node_modules/next/package.json")));
    assert.equal(fs.readFileSync(path.join(run, "public/fx/loop.webp"), "utf8"), "fx");
    assert.equal(restoreModuleDirs(run), 0);
    assert.equal(linkModuleAliases(run), 0);
    assert.equal(await restoreLocalAssets(run, path.join(dir, "no-renderer")), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("linking an alias twice is harmless", () => {
  const dir = scratch();
  stage(dir, {
    "node_modules/mediasoup/package.json": "{}",
    [ALIASES_FILE]: JSON.stringify({ "mediasoup-f2b066850faeed90": "mediasoup" }),
  });
  try {
    assert.equal(linkModuleAliases(dir), 1);
    assert.equal(linkModuleAliases(dir), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// What 0.17.3 to 0.17.5 left on Windows (server issue #280): the alias was
// linked while the tree was still local-server.new, and a junction keeps
// the absolute path it was made with, so the rename into place left every
// alias pointing at a folder that no longer exists. An absolute link stands
// in for the junction here so the same thing happens on every platform.
test("an alias made before the tree was renamed into place is replaced", () => {
  const dir = scratch();
  const fresh = path.join(dir, "live.new");
  const live = path.join(dir, "live");
  stage(fresh, {
    "node_modules/mediasoup/package.json": "{}",
    [ALIASES_FILE]: JSON.stringify({ "mediasoup-f2b066850faeed90": "mediasoup" }),
  });
  try {
    fs.symlinkSync(path.join(fresh, "node_modules/mediasoup"), path.join(fresh, "node_modules/mediasoup-f2b066850faeed90"), "junction");
    fs.renameSync(fresh, live);
    const alias = path.join(live, "node_modules/mediasoup-f2b066850faeed90");
    assert.ok(fs.lstatSync(alias).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(alias, "package.json")), "the moved tree's alias points at the old place");
    assert.equal(linkModuleAliases(live), 1);
    assert.ok(fs.existsSync(path.join(alias, "package.json")), "the alias reaches its package again");
    assert.equal(fs.realpathSync.native(alias), fs.realpathSync.native(path.join(live, "node_modules/mediasoup")));
    assert.equal(linkModuleAliases(live), 0, "a mended alias is left alone");
    assert.ok(fs.existsSync(path.join(live, "node_modules/mediasoup/package.json")), "the package itself was never touched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an alias that reaches the wrong package is replaced; a plain folder at an alias name is left alone", () => {
  const dir = scratch();
  stage(dir, {
    "node_modules/mediasoup/package.json": '{"name":"mediasoup"}',
    "node_modules/other/package.json": '{"name":"other"}',
    "node_modules/plain-0123456789abcdef/package.json": '{"name":"plain"}',
    [ALIASES_FILE]: JSON.stringify({ "mediasoup-f2b066850faeed90": "mediasoup", "plain-0123456789abcdef": "mediasoup" }),
  });
  try {
    const alias = path.join(dir, "node_modules/mediasoup-f2b066850faeed90");
    fs.symlinkSync("other", alias, "junction");
    assert.equal(linkModuleAliases(dir), 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(alias, "package.json"), "utf8")).name, "mediasoup");
    assert.ok(fs.existsSync(path.join(dir, "node_modules/other/package.json")), "the wrong target was never touched");
    const plain = path.join(dir, "node_modules/plain-0123456789abcdef");
    assert.ok(!fs.lstatSync(plain).isSymbolicLink());
    assert.equal(JSON.parse(fs.readFileSync(path.join(plain, "package.json"), "utf8")).name, "plain");
    assert.equal(linkModuleAliases(dir), 0);
    dropLink(alias);
    assert.equal(linkModuleAliases(dir), 1, "a missing alias is made");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
