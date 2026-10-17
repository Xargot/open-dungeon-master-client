import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { STARTING_ROUTES } from "../dist/shared/starting-routes.js";
import { creationHosts, nextCreationHost, pickPrimaryHost } from "../dist/shared/home-view-logic.js";

// The home's ways into a game say where they lead in the same words as the
// server's title screen (audit F06/C02), and the home says which host its
// New campaign, Characters and Workshop open on, with a way to pick another.

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.resolve(process.env.ODM_SERVER_DIR ?? path.join(repo, "..", "open-dungeon-master"));

test("the shell's route lines match the server's", () => {
  const tiles = fs.readFileSync(path.join(serverDir, "src/app/home/QuickTiles.tsx"), "utf8");
  for (const [key, text] of Object.entries(STARTING_ROUTES)) {
    assert.ok(tiles.includes(`${key}: ${JSON.stringify(text)}`) || tiles.includes(`${key}: "${text.replaceAll('"', '\\"')}"`), `${key}: ${text}`);
  }
});

const host = (overrides = {}) => ({
  id: "s",
  kind: "server",
  name: "",
  origin: "https://dungeon.example.org",
  username: "ada",
  status: "online",
  lastSeenAt: null,
  stale: false,
  error: "",
  campaigns: [],
  canCreate: true,
  offersStory: true,
  ...overrides,
});
const feed = (hosts) => ({ hosts, refreshedAt: "" });

test("the player's chosen host is kept while it answers", () => {
  const local = host({ id: "local", kind: "local", status: "offline" });
  const remote = host({ id: "remote" });
  const all = feed([local, remote]);
  assert.equal(pickPrimaryHost(all, null).id, "local", "the device world by default");
  assert.equal(pickPrimaryHost(all, null, "remote").id, "remote", "a chosen host wins");
  assert.equal(pickPrimaryHost(feed([local, host({ id: "remote", status: "offline" })]), null, "remote").id, "local", "an offline choice falls back");
  assert.deepEqual(creationHosts(all).map((entry) => entry.id), ["local", "remote"]);
  assert.equal(nextCreationHost(all, local).id, "remote");
  assert.equal(nextCreationHost(all, remote).id, "local");
  assert.equal(nextCreationHost(feed([remote]), remote), null, "one host offers no Change");
});
