import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LOCAL_SERVER_ID, registryPatience, ServerStore } from "../dist/main/servers.js";

const crypt = {
  encrypt: (plain) => `enc:${plain}`,
  decrypt: (cipher) => (cipher.startsWith("enc:") ? cipher.slice(4) : null),
};

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-store-"));
  return { store: new ServerStore(path.join(dir, "servers.json"), crypt), dir };
}

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();

test("the local profile secret is stored encrypted and survives token refreshes", () => {
  const { store } = freshStore();
  store.upsert({
    id: LOCAL_SERVER_ID,
    origin: "local",
    name: "This computer",
    username: "kaleb",
    token: "tok1",
    tokenExpiresAt: future,
    secret: "profile-password",
  });
  assert.equal(store.secret(LOCAL_SERVER_ID), "profile-password");
  // A token refresh without a secret must not drop the stored password.
  store.upsert({
    id: LOCAL_SERVER_ID,
    origin: "local",
    name: "This computer",
    username: "kaleb",
    token: "tok2",
    tokenExpiresAt: future,
  });
  assert.equal(store.secret(LOCAL_SERVER_ID), "profile-password");
  assert.equal(store.token(LOCAL_SERVER_ID), "tok2");
  // Servers without a stored secret report null, not a decryption error.
  const remote = store.upsert({
    origin: "https://r.example",
    name: "R",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
  });
  assert.equal(store.secret(remote.id), null);
});

test("upsert dedupes remote servers by origin and keeps the id", () => {
  const { store } = freshStore();
  const first = store.upsert({
    origin: "https://a.example",
    name: "A",
    username: "kaleb",
    token: "tok1",
    tokenExpiresAt: future,
  });
  const second = store.upsert({
    origin: "https://a.example",
    name: "A renamed",
    username: "kaleb",
    token: "tok2",
    tokenExpiresAt: future,
  });
  assert.equal(first.id, second.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.token(first.id), "tok2");
});

test("upsert falls back to the instanceId so a moved world keeps one entry", () => {
  const { store } = freshStore();
  const first = store.upsert({
    origin: "https://play-OLDCODE.example",
    name: "Dave's world",
    username: "kaleb",
    token: "tok1",
    tokenExpiresAt: future,
    instanceId: "world-1",
  });
  // Same world, new tunnel hostname: refreshed in place, not duplicated.
  const second = store.upsert({
    origin: "https://play-NEWCODE.example",
    name: "Dave's world",
    username: "kaleb",
    token: "tok2",
    tokenExpiresAt: future,
    instanceId: "world-1",
  });
  assert.equal(first.id, second.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.get(first.id).origin, "https://play-NEWCODE.example");
  // A blank instanceId never matches anything.
  store.upsert({
    origin: "https://old-server-a.example",
    name: "A",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
    instanceId: "",
  });
  store.upsert({
    origin: "https://old-server-b.example",
    name: "B",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
  });
  assert.equal(store.list().length, 3);
});

test("findByInstanceId, rebindOrigin and setInstanceId move a world, not copy it", () => {
  const { store } = freshStore();
  const entry = store.upsert({
    origin: "https://play-OLDCODE.example",
    name: "Dave's world",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
  });
  // Entries saved before the server exposed an instanceId get it backfilled.
  assert.equal(store.findByInstanceId("world-1"), null);
  store.setInstanceId(entry.id, "world-1");
  assert.equal(store.findByInstanceId("world-1")?.id, entry.id);
  assert.equal(store.findByInstanceId(""), null);

  const moved = store.rebindOrigin(entry.id, "https://play-NEWCODE.example");
  assert.equal(moved.id, entry.id);
  assert.equal(store.get(entry.id).origin, "https://play-NEWCODE.example");
  assert.equal(store.token(entry.id), "tok");
  assert.equal(store.list().length, 1);
  assert.equal(store.rebindOrigin("missing", "https://x.example"), null);
});

test("expired or missing tokens read as null and summaries reflect it", () => {
  const { store } = freshStore();
  const live = store.upsert({
    origin: "https://live.example",
    name: "Live",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
  });
  const dead = store.upsert({
    origin: "https://dead.example",
    name: "Dead",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: past,
  });
  assert.equal(store.token(live.id), "tok");
  assert.equal(store.token(dead.id), null);
  const byOrigin = new Map(store.summaries().map((entry) => [entry.origin, entry.hasToken]));
  assert.equal(byOrigin.get("https://live.example"), true);
  assert.equal(byOrigin.get("https://dead.example"), false);
});

test("the local entry is addressed by id and hidden from the remote list", () => {
  const { store } = freshStore();
  store.upsert({
    id: LOCAL_SERVER_ID,
    origin: "local",
    name: "This computer",
    username: "kaleb",
    token: "local-tok",
    tokenExpiresAt: future,
  });
  store.upsert({
    id: LOCAL_SERVER_ID,
    origin: "local",
    name: "This computer",
    username: "kaleb",
    token: "local-tok-2",
    tokenExpiresAt: future,
  });
  assert.equal(store.list().length, 0);
  assert.equal(store.summaries().length, 0);
  assert.equal(store.token(LOCAL_SERVER_ID), "local-tok-2");
});

test("updates stay on stable until beta is chosen, and the choice is kept", () => {
  const { store, dir } = freshStore();
  assert.equal(store.updateChannel(), "stable");
  store.setUpdateChannel("beta");
  assert.equal(new ServerStore(path.join(dir, "servers.json"), crypt).updateChannel(), "beta");
  store.setUpdateChannel("stable");
  assert.equal(store.updateChannel(), "stable");
  assert.equal("betaUpdates" in JSON.parse(fs.readFileSync(path.join(dir, "servers.json"), "utf8")), false);
});

test("registry persists across instances and survives corruption", () => {
  const { store, dir } = freshStore();
  const entry = store.upsert({
    origin: "https://a.example",
    name: "A",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
  });
  const reopened = new ServerStore(path.join(dir, "servers.json"), crypt);
  assert.equal(reopened.token(entry.id), "tok");

  fs.writeFileSync(path.join(dir, "servers.json"), "{not json");
  const corrupted = new ServerStore(path.join(dir, "servers.json"), crypt, () => {});
  assert.equal(corrupted.token(entry.id), "tok", "the copy from the last clean start came back");
});

const quiet = () => {};
const damagedCopies = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith("servers.json.damaged-"));

test("a damaged registry is kept aside and the last clean start's copy comes back, the device world's password with it", () => {
  const { store, dir } = freshStore();
  const file = path.join(dir, "servers.json");
  store.upsert({ id: LOCAL_SERVER_ID, origin: "local", name: "This computer", username: "kaleb", token: "t", tokenExpiresAt: future, secret: "made-up" });
  store.upsert({ origin: "https://a.example", name: "A", username: "kaleb", token: "tok", tokenExpiresAt: future });
  // The next start reads it cleanly and keeps a copy.
  assert.equal(new ServerStore(file, crypt, quiet).list().length, 1);
  fs.writeFileSync(file, "\0\0\0\0");
  const lines = [];
  const next = new ServerStore(file, crypt, (line) => lines.push(line));
  assert.equal(next.secret(LOCAL_SERVER_ID), "made-up");
  assert.equal(next.list()[0].origin, "https://a.example");
  assert.equal(damagedCopies(dir).length, 1);
  assert.equal(fs.readFileSync(path.join(dir, damagedCopies(dir)[0]), "utf8"), "\0\0\0\0");
  assert.match(lines.join("\n"), /damaged; kept as servers\.json\.damaged-.*from the last start are back/);
});

test("a damaged registry with no earlier copy starts empty and the next save leaves the damaged bytes alone", () => {
  const { dir } = freshStore();
  const file = path.join(dir, "servers.json");
  fs.writeFileSync(file, '{"version":1,"servers":[{"id":"x"');
  const store = new ServerStore(file, crypt, quiet);
  assert.deepEqual(store.list(), []);
  store.upsert({ origin: "https://b.example", name: "B", username: "x", token: "t", tokenExpiresAt: future });
  assert.equal(new ServerStore(file, crypt, quiet).list().length, 1);
  assert.equal(fs.readFileSync(path.join(dir, damagedCopies(dir)[0]), "utf8"), '{"version":1,"servers":[{"id":"x"');
});

test("a registry that cannot be read is never written over; this run keeps its changes in memory", () => {
  const { store, dir } = freshStore();
  const file = path.join(dir, "servers.json");
  store.upsert({ origin: "https://a.example", name: "A", username: "kaleb", token: "tok", tokenExpiresAt: future });
  const before = fs.readFileSync(file, "utf8");
  const original = fs.readFileSync;
  const patience = { ...registryPatience };
  registryPatience.delayMs = 1;
  fs.readFileSync = (...args) => {
    if (args[0] === file) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return original(...args);
  };
  try {
    const locked = new ServerStore(file, crypt, quiet);
    assert.deepEqual(locked.list(), []);
    locked.upsert({ origin: "https://b.example", name: "B", username: "x", token: "t", tokenExpiresAt: future });
    assert.equal(locked.list().length, 1, "the change is kept for this run");
  } finally {
    fs.readFileSync = original;
    Object.assign(registryPatience, patience);
  }
  assert.equal(fs.readFileSync(file, "utf8"), before, "the file is untouched");
});

test("a read Windows holds for a moment is tried again", () => {
  const { store, dir } = freshStore();
  const file = path.join(dir, "servers.json");
  store.upsert({ origin: "https://a.example", name: "A", username: "kaleb", token: "tok", tokenExpiresAt: future });
  const original = fs.readFileSync;
  const patience = { ...registryPatience };
  registryPatience.delayMs = 1;
  let busy = 2;
  fs.readFileSync = (...args) => {
    if (args[0] === file && busy > 0) {
      busy -= 1;
      throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    }
    return original(...args);
  };
  try {
    assert.equal(new ServerStore(file, crypt, quiet).list().length, 1);
  } finally {
    fs.readFileSync = original;
    Object.assign(registryPatience, patience);
  }
});

test("a save leaves no temp file behind", () => {
  const { store, dir } = freshStore();
  for (let index = 0; index < 5; index += 1) store.touch("nothing");
  store.upsert({ origin: "https://a.example", name: "A", username: "kaleb", token: "tok", tokenExpiresAt: future });
  store.setPortal(false);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

test("the home cache is kept beside the servers and replaced whole", () => {
  const { store, dir } = freshStore();
  assert.deepEqual(store.homeCache(), {});
  const entry = { status: "online", campaigns: [], lastSeenAt: "2026-09-04T00:00:00.000Z" };
  store.saveHomeCache({ local: entry, gone: entry });
  assert.deepEqual(new ServerStore(path.join(dir, "servers.json"), crypt).homeCache(), {
    local: entry,
    gone: entry,
  });
  store.saveHomeCache({ local: entry });
  assert.deepEqual(Object.keys(store.homeCache()), ["local"]);
});

test("remove forgets the server", () => {
  const { store } = freshStore();
  const entry = store.upsert({
    origin: "https://a.example",
    name: "A",
    username: "kaleb",
    token: "tok",
    tokenExpiresAt: future,
  });
  store.remove(entry.id);
  assert.equal(store.get(entry.id), null);
  assert.equal(store.list().length, 0);
});

test("the room code a player joined through is kept on the entry, newest first", () => {
  const { store } = freshStore();
  const entry = store.upsert({
    origin: "https://play-old.example",
    name: "Phone",
    username: "wren",
    token: "tok1",
    tokenExpiresAt: future,
    instanceId: "world-1",
  });
  // Nothing cached from the home screen yet: this is the case 0.7.16
  // missed, a player who joined and never came back to the home screen.
  store.rememberJoinCode(entry.id, "abcd2345");
  store.rememberJoinCode(entry.id, "EFGH6789");
  store.rememberJoinCode(entry.id, "ABCD2345");
  assert.deepEqual(store.tableCodesFor(entry.id), ["ABCD2345", "EFGH6789"]);
  // A token refresh keeps them.
  store.upsert({
    id: entry.id,
    origin: "https://play-old.example",
    name: "Phone",
    username: "wren",
    token: "tok2",
    tokenExpiresAt: future,
  });
  assert.deepEqual(store.tableCodesFor(entry.id), ["ABCD2345", "EFGH6789"]);
});

test("a stored password does not follow a different account onto the same host", () => {
  const { store } = freshStore();
  const first = store.upsert({
    origin: "https://a.example",
    name: "A",
    username: "wren",
    token: "tok1",
    tokenExpiresAt: future,
    secret: "minted-for-wren",
  });
  assert.equal(store.secret(first.id), "minted-for-wren");
  store.upsert({
    origin: "https://a.example",
    name: "A",
    username: "kaleb",
    token: "tok2",
    tokenExpiresAt: future,
  });
  assert.equal(store.secret(first.id), null);
});

test("published room codes survive a restart so they can be taken offline", () => {
  const { store } = freshStore();
  assert.deepEqual(store.publishedCodes(), []);
  store.setPublishedCodes(["ABCD2345", "EFGH6789"]);
  assert.deepEqual(store.publishedCodes(), ["ABCD2345", "EFGH6789"]);
  store.setPublishedCodes([]);
  assert.deepEqual(store.publishedCodes(), []);
});

// Audit S8: with "keep sign-ins" off, a sign-in to a host where the player
// typed their own password lives in memory only; the device world and
// room-code accounts, whose passwords only this file holds, stay saved.
test("sign-ins kept for this run only never reach the file, and come back when kept again", () => {
  const { store, dir } = freshStore();
  const file = path.join(dir, "servers.json");
  assert.deepEqual(store.credentialStorage(), { protection: "keyring", keepSignIns: true });
  const typed = store.upsert({ origin: "https://a.example", name: "A", username: "kaleb", token: "typed-tok", tokenExpiresAt: future });
  const minted = store.upsert({
    origin: "https://b.example",
    name: "B",
    username: "guest",
    token: "room-tok",
    tokenExpiresAt: future,
    secret: "app-made",
  });
  store.upsert({ id: LOCAL_SERVER_ID, origin: "http://127.0.0.1:3005", name: "Local", username: "me", token: "local-tok", tokenExpiresAt: future, secret: "local-pass" });

  store.setKeepSignIns(false);
  assert.equal(store.credentialStorage().keepSignIns, false);
  const onDisk = fs.readFileSync(file, "utf8");
  assert.ok(!onDisk.includes("typed-tok"), "the typed-password sign-in left the file");
  assert.ok(onDisk.includes("enc:room-tok") && onDisk.includes("enc:local-tok"), "app-made sign-ins stay saved");
  assert.equal(store.token(typed.id), "typed-tok", "still signed in for this run");
  assert.equal(store.summaries().find((entry) => entry.id === typed.id)?.hasToken, true);

  // A new sign-in while it is off stays in memory too.
  store.upsert({ origin: "https://a.example", name: "A", username: "kaleb", token: "typed-tok-2", tokenExpiresAt: future });
  assert.ok(!fs.readFileSync(file, "utf8").includes("typed-tok-2"));
  // Another run (a new store over the same file) has to sign in again there.
  const nextRun = new ServerStore(file, crypt);
  assert.equal(nextRun.token(typed.id), null);
  assert.equal(nextRun.token(minted.id), "room-tok");
  assert.equal(nextRun.token(LOCAL_SERVER_ID), "local-tok");

  store.setKeepSignIns(true);
  assert.ok(fs.readFileSync(file, "utf8").includes("enc:typed-tok-2"), "kept again, it is written back");
  assert.equal(new ServerStore(file, crypt).token(typed.id), "typed-tok-2");
});

test("the store says when the computer has no real keyring", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-store-"));
  const store = new ServerStore(path.join(dir, "servers.json"), { ...crypt, protection: () => "obscured" });
  assert.equal(store.credentialStorage().protection, "obscured");
});

// Audit C4: the registry is read once and served from memory until the file
// changes underneath, and a caller's copy is its own.
test("the registry is parsed once, re-read when the file changes, and never shared by reference", () => {
  const { store, dir } = freshStore();
  const file = path.join(dir, "servers.json");
  const entry = store.upsert({ origin: "https://a.example", name: "A", username: "kaleb", token: "tok", tokenExpiresAt: future });
  const reads = { count: 0 };
  const original = fs.readFileSync;
  fs.readFileSync = (...args) => {
    if (args[0] === file) reads.count += 1;
    return original(...args);
  };
  try {
    for (let index = 0; index < 50; index += 1) {
      store.list();
      store.token(entry.id);
      store.summaries();
    }
    assert.equal(reads.count, 0, "served from memory while the file is unchanged");
    // Another writer (a second app instance) changes the file.
    const other = new ServerStore(file, crypt);
    other.upsert({ origin: "https://b.example", name: "B", username: "x", token: "t", tokenExpiresAt: future });
    assert.equal(store.list().length, 2);
    assert.ok(reads.count >= 1);
  } finally {
    fs.readFileSync = original;
  }
  const listed = store.get(entry.id);
  listed.name = "changed by a caller";
  assert.equal(store.get(entry.id).name, "A");
});

test("the first-launch offer to add the app to Steam is answered once and stays answered", () => {
  const { store, dir } = freshStore();
  assert.equal(store.steamOfferAnswered(), false);
  store.answerSteamOffer();
  assert.equal(store.steamOfferAnswered(), true);
  const again = new ServerStore(path.join(dir, "servers.json"), crypt);
  assert.equal(again.steamOfferAnswered(), true, "a later start reads the answer back");
});
