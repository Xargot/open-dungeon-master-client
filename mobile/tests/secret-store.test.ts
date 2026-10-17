import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSecretStore,
  loadServerSecrets,
  migrateSecret,
  readServerList,
  serverSecretKey,
  serverTokenKey,
  storeServerSecrets,
  withoutSecrets,
  type SecretBackend,
} from "../src/secret-store-core";

function memory(initial: Record<string, string> = {}): SecretBackend & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get({ key }) {
      return { value: data.get(key) ?? null };
    },
    async set({ key, value }) {
      data.set(key, value);
    },
    async remove({ key }) {
      data.delete(key);
    },
  };
}

const server = (id: string, token: string, secret?: string) => ({ id, origin: `https://${id}.example`, token, secret });

test("the saved list carries no token and no made-up password", () => {
  const saved = withoutSecrets([server("a", "tok-a", "pw-a"), server("b", "tok-b")]);
  assert.deepEqual(saved, [
    { id: "a", origin: "https://a.example", token: "" },
    { id: "b", origin: "https://b.example", token: "" },
  ]);
  assert.ok(!JSON.stringify(saved).includes("tok-") && !JSON.stringify(saved).includes("pw-"));
});

test("secrets round-trip through the store, and a removed server takes its own", async () => {
  const backend = memory();
  const store = createSecretStore(backend);
  await storeServerSecrets([server("a", "tok-a", "pw-a"), server("b", "tok-b")], store, []);
  const { servers, migrated } = await loadServerSecrets(withoutSecrets([server("a", "", undefined), server("b", "")]), store);
  assert.equal(migrated, false);
  assert.deepEqual(servers.map((entry) => [entry.id, entry.token, entry.secret]), [
    ["a", "tok-a", "pw-a"],
    ["b", "tok-b", undefined],
  ]);
  await storeServerSecrets([server("b", "tok-b")], store, ["a", "b"]);
  assert.equal(backend.data.has(serverTokenKey("a")), false);
  assert.equal(backend.data.has(serverSecretKey("a")), false);
});

test("a list saved before the store moves its secrets in and asks to be saved again", async () => {
  const store = createSecretStore(memory());
  const { servers, migrated } = await loadServerSecrets([server("a", "old-token", "old-pw")], store);
  assert.equal(migrated, true);
  assert.equal(servers[0].token, "old-token");
  assert.equal(await store.get(serverTokenKey("a")), "old-token");
  assert.equal(await store.get(serverSecretKey("a")), "old-pw");
});

test("a new phone with the list but not the store asks the player to sign in", async () => {
  const store = createSecretStore(memory());
  const { servers } = await loadServerSecrets(withoutSecrets([server("a", "t")]), store);
  assert.equal(servers[0].token, "");
});

test("a plain value is moved into the store once", async () => {
  const plain = memory({ "odm-table-secret:ABCD": "s3cret" });
  const store = createSecretStore(memory());
  assert.equal(await migrateSecret("odm-table-secret:ABCD", store, plain), "s3cret");
  assert.equal(plain.data.size, 0);
  assert.equal(await migrateSecret("odm-table-secret:ABCD", store, plain), "s3cret");
  assert.equal(await migrateSecret("odm-table-secret:NONE", store, plain), null);
});

test("a damaged saved-server list is kept under a dated key, not written over", async () => {
  const plain = memory({ "odm-servers": '[{"id":"a","origin":"https://a.exa' });
  const at = () => new Date("2026-10-13T12:00:00.000Z");
  assert.deepEqual(await readServerList(plain, "odm-servers", at), []);
  assert.equal(plain.data.get("odm-servers.damaged-2026-10-13T12:00:00.000Z"), '[{"id":"a","origin":"https://a.exa');
  assert.equal(plain.data.get("odm-servers"), "[]");
  // Read again: nothing more is set aside.
  assert.deepEqual(await readServerList(plain, "odm-servers", at), []);
  assert.equal([...plain.data.keys()].filter((key) => key.includes("damaged")).length, 1);
});

test("a saved-server list that is JSON but not a list is kept aside too; a missing one is a first run", async () => {
  const plain = memory({ "odm-servers": '{"servers":[]}' });
  assert.deepEqual(await readServerList(plain, "odm-servers"), []);
  assert.equal([...plain.data.keys()].filter((key) => key.startsWith("odm-servers.damaged-")).length, 1);
  const fresh = memory();
  assert.deepEqual(await readServerList(fresh, "odm-servers"), []);
  assert.equal(fresh.data.size, 0);
  const listed = memory({ "odm-servers": '[{"id":"a"}]' });
  assert.deepEqual(await readServerList(listed, "odm-servers"), [{ id: "a" }]);
});

test("a preferences read that fails is an error, not an empty list", async () => {
  const broken: SecretBackend = {
    async get() {
      throw new Error("preferences unavailable");
    },
    async set() {
      throw new Error("must not write");
    },
    async remove() {},
  };
  await assert.rejects(readServerList(broken, "odm-servers"), /preferences unavailable/);
});
