// The desktop's payload upgrade (src/main/payload-store.ts): whatever stage
// an upgrade is interrupted at, the next start leaves one live tree that
// holds every file the player made and, when the new payload had finished
// unpacking, the new payload. The audit that found the copy-based upgrade
// lost uploads reproduced it with exactly the first case below.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PRESERVED } from "../dist/main/local-server.js";
import { MARKER, PayloadStore, lockPatience } from "../dist/main/payload-store.js";

// The retries that wait out a Windows file lock, shortened for the tests
// below that stand in for one with a folder nobody may write into.
lockPatience.attempts = 30;
lockPatience.delayMs = 20;
const root = typeof process.getuid === "function" && process.getuid() === 0;
const noChmod = process.platform === "win32" ? "a folder nobody may write into cannot be made with chmod on Windows" : false;

function write(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-payload-store-"));
  const run = path.join(dir, "local-server");
  return { dir, run, store: new PayloadStore(run, PRESERVED), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const payload = (version) => ({ [MARKER]: JSON.stringify({ serverVersion: version, builtAt: version }), "server.js": version });

test("an interrupted copy-based upgrade's .keep is folded back, never deleted first", async () => {
  const { run, store, cleanup } = world();
  try {
    // The new payload is in place, but the player's upload only survives in .keep.
    write(run, payload("2"));
    write(store.keep, { "public/uploads/face.png": "face" });
    await store.recover();
    assert.equal(read(path.join(run, "public/uploads/face.png")), "face");
    assert.ok(!fs.existsSync(store.keep));
  } finally {
    cleanup();
  }
});

test(".keep alone (the live tree already deleted) becomes the live tree", async () => {
  const { run, store, cleanup } = world();
  try {
    write(store.keep, { "public/generated/map.webp": "map" });
    await store.recover();
    assert.equal(read(path.join(run, "public/generated/map.webp")), "map");
  } finally {
    cleanup();
  }
});

test("an upgrade moves the player's folders into the new tree and swaps it in", async () => {
  const { run, store, cleanup } = world();
  try {
    write(run, { ...payload("1"), "public/uploads/face.png": "face", "models/embeddings/w.onnx": "weights", "public/icon.png": "old icon" });
    await store.upgrade(async (dir) => write(dir, { ...payload("2"), "public/icon.png": "new icon" }));
    assert.equal(read(path.join(run, "server.js")), "2");
    assert.equal(read(path.join(run, "public/icon.png")), "new icon");
    assert.equal(read(path.join(run, "public/uploads/face.png")), "face");
    assert.equal(read(path.join(run, "models/embeddings/w.onnx")), "weights");
    for (const stray of [store.fresh, store.old, store.keep]) assert.ok(!fs.existsSync(stray), stray);
  } finally {
    cleanup();
  }
});

test("an unpack that dies before its marker leaves the live tree and its files alone", async () => {
  const { run, store, cleanup } = world();
  try {
    write(run, { ...payload("1"), "public/uploads/face.png": "face" });
    await assert.rejects(
      store.upgrade(async (dir) => {
        write(dir, { "server.js": "half" });
        throw new Error("disk full");
      }),
      /disk full/,
    );
    assert.equal(read(path.join(run, "server.js")), "1");
    assert.equal(read(path.join(run, "public/uploads/face.png")), "face");
    assert.ok(!fs.existsSync(store.fresh));
  } finally {
    cleanup();
  }
});

test("a crash after the new tree was unpacked but before the swap finishes it", async () => {
  const { run, store, cleanup } = world();
  try {
    write(run, { ...payload("1"), "public/uploads/face.png": "face" });
    write(store.fresh, payload("2"));
    await store.recover();
    assert.equal(read(path.join(run, "server.js")), "2");
    assert.equal(read(path.join(run, "public/uploads/face.png")), "face");
  } finally {
    cleanup();
  }
});

test("a crash mid-swap (live tree renamed aside) loses nothing", async () => {
  const { run, store, cleanup } = world();
  try {
    // The player's folder was not moved out yet when the old tree went aside.
    write(store.old, { ...payload("1"), "public/generated-audio/n.mp3": "voice" });
    write(store.fresh, payload("2"));
    await store.recover();
    assert.equal(read(path.join(run, "server.js")), "2");
    assert.equal(read(path.join(run, "public/generated-audio/n.mp3")), "voice");
    assert.ok(!fs.existsSync(store.old));
  } finally {
    cleanup();
  }
});

test("an unpack without a marker is dropped, and fills only gaps in the live tree", async () => {
  const { run, store, cleanup } = world();
  try {
    write(run, { ...payload("1"), "public/uploads/a.png": "live" });
    write(store.fresh, { "server.js": "half", "public/uploads/a.png": "stale", "public/uploads/b.png": "only here" });
    await store.recover();
    assert.equal(read(path.join(run, "server.js")), "1");
    assert.equal(read(path.join(run, "public/uploads/a.png")), "live");
    assert.equal(read(path.join(run, "public/uploads/b.png")), "only here");
    assert.ok(!fs.existsSync(store.fresh));
  } finally {
    cleanup();
  }
});

test("the installed world packs and the rest of the server's data folder survive an upgrade", async () => {
  const { run, store, cleanup } = world();
  try {
    write(run, { ...payload("1"), "data/worlds/hollow_marsh.json": '{"id":"hollow_marsh"}', "data/ambience-lock.json": "{}" });
    await store.upgrade(async (dir) => write(dir, payload("2")));
    assert.equal(read(path.join(run, "server.js")), "2");
    assert.equal(read(path.join(run, "data/worlds/hollow_marsh.json")), '{"id":"hollow_marsh"}');
    assert.equal(read(path.join(run, "data/ambience-lock.json")), "{}");
  } finally {
    cleanup();
  }
});

test("the Android shell carries the same folders across an upgrade as the desktop", () => {
  const java = fs.readFileSync(
    new URL("../mobile/android/app/src/main/java/com/opendungeonmaster/app/PayloadStore.java", import.meta.url),
    "utf8",
  );
  const block = java.match(/PRESERVED = \{([^}]*)\}/);
  assert.ok(block, "PayloadStore.java names its PRESERVED folders");
  assert.deepEqual([...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]), PRESERVED);
});

test("a swap waits out a lock on the tree, as Windows holds one for a moment", { skip: noChmod }, async () => {
  const { dir, run, store, cleanup } = world();
  try {
    write(run, { ...payload("1"), "public/uploads/face.png": "face" });
    await store.upgrade(async (fresh) => {
      write(fresh, payload("2"));
      // Renaming the live tree aside needs the parent writable; take that
      // away for the swap's first tries and give it back while it waits.
      fs.chmodSync(dir, 0o500);
      // As root the swap never waits, and the world may be cleaned up first.
      setTimeout(() => fs.existsSync(dir) && fs.chmodSync(dir, 0o700), 150);
    });
    assert.equal(read(path.join(run, "server.js")), "2");
    assert.equal(read(path.join(run, "public/uploads/face.png")), "face");
    for (const stray of [store.fresh, store.old, store.keep]) assert.ok(!fs.existsSync(stray), stray);
  } finally {
    fs.chmodSync(dir, 0o700);
    cleanup();
  }
});

test("a replaced tree that cannot be removed yet is left for the next start, not a failed one", { skip: noChmod }, async () => {
  const { run, store, cleanup } = world();
  const locked = path.join(store.old, "locked");
  try {
    write(run, payload("2"));
    write(locked, { "chunk.js": "old" });
    fs.chmodSync(locked, 0o500);
    await store.recover();
    assert.equal(read(path.join(run, "server.js")), "2", "the live tree is untouched");
    if (!root) assert.ok(fs.existsSync(store.old), "the old tree waits for a start that can remove it");
    // Root removes it anyway, lock and all.
    if (fs.existsSync(locked)) fs.chmodSync(locked, 0o700);
    await store.recover();
    assert.ok(!fs.existsSync(store.old));
  } finally {
    if (fs.existsSync(locked)) fs.chmodSync(locked, 0o700);
    cleanup();
  }
});

test("recovery with nothing to do is a no-op", async () => {
  const { run, store, cleanup } = world();
  try {
    write(run, payload("1"));
    await store.recover();
    assert.equal(read(path.join(run, "server.js")), "1");
  } finally {
    cleanup();
  }
});
