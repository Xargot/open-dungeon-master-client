import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ServerStore } from "../dist/main/servers.js";
import { prepareRemoteConnection } from "../dist/main/remote-preparation.js";

const future = new Date(Date.now() + 86_400_000).toISOString();
const crypt = {
  encrypt: (value) => `enc:${value}`,
  decrypt: (value) => value.startsWith("enc:") ? value.slice(4) : null,
};

function setup(t, secret) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-native-prep-"));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith("odm-native-prep-")) {
      throw new Error(`Refusing to remove unexpected test directory: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const store = new ServerStore(path.join(dir, "servers.json"), crypt);
  const entry = store.upsert({
    origin: "https://old.example",
    name: "A world",
    username: "player",
    token: "saved-token",
    tokenExpiresAt: future,
    instanceId: "world-1",
    ...(secret ? { secret } : {}),
  });
  const probe = (origin, instanceId = "world-1") => ({
    origin, instanceId, serverName: "A world", version: "0.26.3",
    signupMode: "open", discord: false, deviceWorld: true, needsSetup: false,
  });
  return { store, entry, probe };
}

test("a locally unexpired but revoked session cannot prepare native entry", async (t) => {
  const { store, entry, probe } = setup(t);
  const result = await prepareRemoteConnection(entry.id, {
    store,
    probe: async (origin) => probe(origin),
    relocate: async (saved) => saved,
    sessionState: async () => "rejected",
    login: async () => { throw new Error("no saved password"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.needsLogin, true);
});

test("a revoked saved session renews before native entry", async (t) => {
  const { store, entry, probe } = setup(t, "saved-secret");
  const renewedExpiry = new Date(Date.now() + 172_800_000).toISOString();
  const result = await prepareRemoteConnection(entry.id, {
    store,
    probe: async (origin) => probe(origin),
    relocate: async (saved) => saved,
    sessionState: async () => "rejected",
    login: async () => ({ username: "player", token: "renewed-token", expiresAt: renewedExpiry }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.token, "renewed-token");
  assert.equal(store.token(entry.id), "renewed-token");
  assert.equal(result.entry.tokenExpiresAt, renewedExpiry);
});

test("a changed host identity relocates before the session is sent", async (t) => {
  const { store, entry, probe } = setup(t);
  const sessionOrigins = [];
  const result = await prepareRemoteConnection(entry.id, {
    store,
    probe: async (origin) => probe(origin, origin === "https://old.example" ? "stranger" : "world-1"),
    relocate: async (saved) => store.rebindOrigin(saved.id, "https://new.example"),
    sessionState: async (origin) => { sessionOrigins.push(origin); return "ok"; },
    login: async () => { throw new Error("unexpected login"); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.entry.origin, "https://new.example");
  assert.deepEqual(sessionOrigins, ["https://new.example"]);
});

test("a stranger at the saved address never receives the stored session", async (t) => {
  const { store, entry, probe } = setup(t);
  let sessionCalls = 0;
  const result = await prepareRemoteConnection(entry.id, {
    store,
    probe: async (origin) => probe(origin, "stranger"),
    relocate: async (saved) => saved,
    sessionState: async () => { sessionCalls++; return "ok"; },
    login: async () => { throw new Error("unexpected login"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.needsLogin, false);
  assert.equal(sessionCalls, 0);
});
