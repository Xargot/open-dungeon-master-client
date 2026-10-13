// The manifest the staging step writes at the top of the payload and the
// check the shell runs against it (src/main/payload-manifest.ts): a tree
// that matches passes, its module folders renamed and all; a tree that lost
// a file, one with a file of the wrong size and one with a file of the
// right size and the wrong bytes are each found (the last only when
// hashing); a tree not unpacked yet is nothing to check; and a payload
// without a manifest cannot be checked at all.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MANIFEST,
  listPayloadFiles,
  readPayloadManifest,
  runTreePath,
  verifyRunTree,
  writePayloadManifest,
} from "../dist/main/payload-manifest.js";
import { MARKER } from "../dist/main/payload-store.js";
import { MODULES_DIR, materializeRunTree } from "../dist/main/run-tree.js";

function write(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

const SERVER = "require('next')";
const NESTED = `${MODULES_DIR}/next/${MODULES_DIR}/sharp/index.js`;
const PACKAGE = `${MODULES_DIR}/next/package.json`;
const PAGE = ".next/server/app/page.js";

// A staged payload with its manifest, unpacked into a run tree the way the
// app does it (run-tree.ts), with no renderer art to restore.
async function staged() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-manifest-"));
  const payload = path.join(dir, "payload");
  write(payload, {
    "server.js": SERVER,
    [MARKER]: JSON.stringify({ serverVersion: "1", builtAt: "now" }),
    [PACKAGE]: "{}",
    [NESTED]: "sharp",
    [PAGE]: "page",
  });
  const manifest = await writePayloadManifest(payload);
  const run = path.join(dir, "run");
  await materializeRunTree(payload, run, path.join(dir, "renderer"));
  return { dir, payload, run, manifest, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("the manifest lists every file but the marker and itself, with sizes and hashes", async () => {
  const { payload, manifest, cleanup } = await staged();
  try {
    assert.deepEqual(Object.keys(manifest.files), [PAGE, NESTED, PACKAGE, "server.js"]);
    assert.equal(manifest.files["server.js"].size, SERVER.length);
    assert.match(manifest.files["server.js"].sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(readPayloadManifest(payload), manifest);
    assert.ok(fs.existsSync(path.join(payload, MANIFEST)));
    assert.deepEqual(listPayloadFiles(payload), Object.keys(manifest.files), "the manifest does not list itself");
  } finally {
    cleanup();
  }
});

test("a run tree that matches passes, its module folders renamed and all", async () => {
  const { payload, run, cleanup } = await staged();
  try {
    assert.equal(runTreePath(run, NESTED), path.join(run, "node_modules", "next", "node_modules", "sharp", "index.js"));
    assert.deepEqual(await verifyRunTree(payload, run, { hash: true }), {
      unpacked: true,
      listed: 4,
      missing: [],
      changed: [],
      hashed: true,
    });
  } finally {
    cleanup();
  }
});

test("a missing file, a resized one and a rewritten one of the same size are each found", async () => {
  const { payload, run, cleanup } = await staged();
  try {
    fs.rmSync(path.join(run, "node_modules", "next", "package.json"));
    fs.writeFileSync(path.join(run, "server.js"), "");
    fs.writeFileSync(path.join(run, ".next", "server", "app", "page.js"), "PAGE");
    assert.deepEqual(await verifyRunTree(payload, run), {
      unpacked: true,
      listed: 4,
      missing: [PACKAGE],
      changed: ["server.js"],
      hashed: false,
    });
    const hashed = await verifyRunTree(payload, run, { hash: true });
    assert.deepEqual(hashed.missing, [PACKAGE]);
    assert.deepEqual(hashed.changed, [PAGE, "server.js"], "the same-size rewrite shows only when hashing");
  } finally {
    cleanup();
  }
});

test("a tree without the marker is not unpacked yet, and a payload without a manifest cannot be checked", async () => {
  const { dir, payload, run, cleanup } = await staged();
  try {
    fs.rmSync(path.join(run, MARKER));
    assert.deepEqual(await verifyRunTree(payload, run), { unpacked: false, listed: 4, missing: [], changed: [], hashed: false });
    assert.equal(await verifyRunTree(path.join(dir, "nowhere"), run), null);
    fs.rmSync(path.join(payload, MANIFEST));
    assert.equal(await verifyRunTree(payload, run), null);
    assert.equal(readPayloadManifest(payload), null);
  } finally {
    cleanup();
  }
});
