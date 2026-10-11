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
    await materializeRunTree(payload, run, renderer);
    assert.ok(fs.existsSync(path.join(run, "node_modules/next/package.json")));
    assert.ok(fs.existsSync(path.join(run, "node_modules/next/node_modules/@img/sharp/index.js")));
    assert.ok(!fs.existsSync(path.join(run, MODULES_DIR)));
    const alias = path.join(run, "node_modules/mediasoup-f2b066850faeed90");
    assert.ok(fs.lstatSync(alias).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(alias, "package.json")));
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
