import assert from "node:assert/strict";
import test from "node:test";
import { enterLocalWorld } from "../dist/main/local-owner.js";

// The device world's owner, against a fake store and world. `accounts` is
// what the world holds; `owner` whether it still waits for its first one.
function harness({ profile = null, token = null, valid = false, accounts = {}, says = true, registerFails = false } = {}) {
  let kept = profile;
  const calls = [];
  const world = { accounts: { ...accounts } };
  const deps = {
    token: () => token,
    tokenIsValid: async () => valid,
    profile: () => kept,
    login: async (username, password) => {
      calls.push(`login:${username}`);
      if (world.accounts[username] !== password) throw new Error("Wrong username or password.");
      return { token: `tok-${username}`, expiresAt: "2030-01-01T00:00:00.000Z", username };
    },
    register: async (username, password) => {
      calls.push(`register:${username}`);
      if (Object.keys(world.accounts).length) throw new Error("Ask the host for the table's room code.");
      world.accounts[username] = password;
      if (registerFails) throw new Error("The sign-in after it timed out.");
      return { token: `tok-${username}`, expiresAt: "2030-01-01T00:00:00.000Z", username };
    },
    awaitsOwner: async () => (says ? Object.keys(world.accounts).length === 0 : null),
    hold: (username, secret) => {
      calls.push(`hold:${username}`);
      kept = { username, secret };
    },
    adopt: (grant, secret) => {
      calls.push(`adopt:${grant.username}`);
      kept = { username: grant.username, secret: secret ?? kept?.secret ?? null };
    },
    profileName: () => "kaleb",
    mintSecret: () => "minted-secret",
  };
  return { deps, calls, world, kept: () => kept };
}

test("a world whose database exists but has no account yet makes its owner (the timed-out first start)", async () => {
  // The file test says "not fresh"; the world itself says it has no owner.
  const h = harness();
  const entered = await enterLocalWorld(h.deps, false);
  assert.equal(entered.kind, "created");
  assert.equal(entered.grant.username, "kaleb");
  assert.deepEqual(h.world.accounts, { kaleb: "minted-secret" });
  assert.deepEqual(h.calls, ["hold:kaleb", "register:kaleb", "adopt:kaleb"]);
});

test("the profile is kept before the world hears of it, so a lost answer still signs in next time", async () => {
  const h = harness({ registerFails: true });
  await assert.rejects(enterLocalWorld(h.deps, true), /timed out/);
  // The account exists and the shell still holds its password.
  assert.deepEqual(h.kept(), { username: "kaleb", secret: "minted-secret" });
  h.calls.length = 0;
  const entered = await enterLocalWorld(h.deps, false);
  assert.deepEqual(entered, { kind: "session", token: "tok-kaleb" });
  assert.deepEqual(h.calls, ["login:kaleb", "adopt:kaleb"], "no second account is asked for");
});

test("a kept profile whose account never came to be is registered again under the same name and password", async () => {
  const h = harness({ profile: { username: "brakka", secret: "kept-secret" } });
  const entered = await enterLocalWorld(h.deps, false);
  assert.equal(entered.kind, "created");
  assert.deepEqual(h.world.accounts, { brakka: "kept-secret" });
});

test("a world with an owner and no kept password asks for a sign-in, and makes nothing", async () => {
  const h = harness({ accounts: { someone: "theirs" } });
  assert.deepEqual(await enterLocalWorld(h.deps, true), { kind: "needs-login" });
  assert.equal(h.calls.some((call) => call.startsWith("register")), false);
});

test("a live token is used as it is, and an expired one renews from the kept password", async () => {
  const live = harness({ token: "tok-live", valid: true });
  assert.deepEqual(await enterLocalWorld(live.deps, false), { kind: "session", token: "tok-live" });
  assert.deepEqual(live.calls, []);
  const lapsed = harness({ token: "tok-old", profile: { username: "kaleb", secret: "s" }, accounts: { kaleb: "s" } });
  assert.deepEqual(await enterLocalWorld(lapsed.deps, false), { kind: "session", token: "tok-kaleb" });
});

test("a world that cannot say falls back to whether its database was new", async () => {
  const fresh = harness({ says: false });
  assert.equal((await enterLocalWorld(fresh.deps, true)).kind, "created");
  const old = harness({ says: false });
  assert.deepEqual(await enterLocalWorld(old.deps, false), { kind: "needs-login" });
});
