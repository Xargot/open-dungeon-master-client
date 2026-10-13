// Starting over (src/main/reset.ts): a reset asked for by one run is
// carried out by the next, which sets the whole data folder aside under a
// dated name (never deleting it) and brings the local AI engines and the
// tunnel binary back; a second start finds nothing to do; and where the
// folder will not move as one, its entries go one by one and whatever
// stays is named.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { lockPatience } from "../dist/main/payload-store.js";
import {
  KEEP_ACROSS_RESET,
  RESET_MARKER,
  applyPendingReset,
  moveEntriesAside,
  requestReset,
  resetPending,
  setAsidePath,
} from "../dist/main/reset.js";

// The retries that wait out a Windows file lock, shortened for the test
// that stands in for one with a folder nobody may write into.
lockPatience.attempts = 10;
lockPatience.delayMs = 20;
const noChmod = process.platform === "win32" ? "a folder nobody may write into cannot be made with chmod on Windows" : false;
const root = typeof process.getuid === "function" && process.getuid() === 0;

function write(base, files) {
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(base, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const quiet = () => undefined;

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-reset-"));
  const userData = path.join(dir, "open-dungeon-master-client");
  write(userData, {
    "data/odm.sqlite": "world",
    "data/db-key": "key",
    "local-server/server.js": "server",
    "local-server/data/worlds/hollow_marsh.json": "{}",
    "servers.json": "{}",
    "Partitions/persist_odm-local/Cookies": "cookie",
    "local-ai/models/story.gguf": "weights",
    "bin/cloudflared": "tunnel",
  });
  return { dir, userData, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a reset asked for is carried out by the next start: the folder set aside under a dated name, the engines kept", async () => {
  const { dir, userData, cleanup } = world();
  try {
    assert.equal(await applyPendingReset(userData, new Date(), quiet), null, "nothing asked for, nothing done");
    requestReset(userData);
    assert.equal(resetPending(userData), true);
    const when = new Date("2026-10-13T00:05:11.000Z");
    const outcome = await applyPendingReset(userData, when, quiet);
    const aside = setAsidePath(userData, when);
    assert.equal(aside, path.join(dir, "open-dungeon-master-client.set-aside-2026-10-13T00-05-11"));
    assert.deepEqual(outcome, { aside, left: [] });
    assert.equal(read(path.join(aside, "data", "odm.sqlite")), "world", "the world waits in the set-aside folder");
    assert.equal(read(path.join(aside, "data", "db-key")), "key");
    assert.equal(read(path.join(aside, "local-server", "data", "worlds", "hollow_marsh.json")), "{}");
    assert.equal(read(path.join(aside, "servers.json")), "{}");
    assert.equal(read(path.join(aside, "Partitions", "persist_odm-local", "Cookies")), "cookie");
    assert.ok(!fs.existsSync(path.join(aside, RESET_MARKER)), "the marker does not travel");
    assert.deepEqual(fs.readdirSync(userData).sort(), [...KEEP_ACROSS_RESET].sort(), "only the engines and the tunnel binary are back");
    assert.equal(read(path.join(userData, "local-ai", "models", "story.gguf")), "weights");
    assert.equal(read(path.join(userData, "bin", "cloudflared")), "tunnel");
    assert.equal(resetPending(userData), false);
    assert.equal(await applyPendingReset(userData, when, quiet), null, "the next start finds nothing to do");
  } finally {
    cleanup();
  }
});

test("a folder that will not move as one goes entry by entry, and what stays is named", { skip: noChmod || (root && "root may write anywhere") }, async () => {
  const { dir, userData, cleanup } = world();
  // A destination nothing may be created in: every entry stays, and is
  // named, and nothing is lost on the way.
  const sealed = path.join(dir, "sealed");
  fs.mkdirSync(sealed);
  fs.chmodSync(sealed, 0o500);
  try {
    const stayed = await moveEntriesAside(userData, sealed);
    assert.deepEqual(stayed, ["Partitions", "data", "local-server", "servers.json"]);
    assert.equal(read(path.join(userData, "data", "odm.sqlite")), "world");
    assert.equal(read(path.join(userData, "local-ai", "models", "story.gguf")), "weights");
    // And a destination that takes them: all go, the engines stay.
    const open = path.join(dir, "open");
    assert.deepEqual(await moveEntriesAside(userData, open), []);
    assert.equal(read(path.join(open, "data", "odm.sqlite")), "world");
    assert.deepEqual(fs.readdirSync(userData).sort(), [...KEEP_ACROSS_RESET].sort());
  } finally {
    fs.chmodSync(sealed, 0o700);
    cleanup();
  }
});

test("a stale pid file beside the tree is cleared on the way, and a dead one is no obstacle", async () => {
  const { userData, cleanup } = world();
  try {
    write(userData, { "local-server.pid": "not a pid" });
    requestReset(userData);
    const outcome = await applyPendingReset(userData, new Date("2026-10-13T01:00:00.000Z"), quiet);
    assert.deepEqual(outcome.left, []);
    assert.ok(!fs.existsSync(path.join(userData, "local-server.pid")));
  } finally {
    cleanup();
  }
});
