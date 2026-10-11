import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CODES_TRIED, relocateWorld } from "../dist/shared/relocate.js";

// A world at `origin` answering as `instanceId`; anything else is unreachable.
function world(map, registry = {}) {
  const calls = { probes: [], tables: [] };
  const deps = {
    probe: async (origin) => {
      calls.probes.push(origin);
      return map[origin] ? { instanceId: map[origin] } : null;
    },
    resolveTable: async (code) => {
      calls.tables.push(code);
      return registry[code] ?? "";
    },
  };
  return { deps, calls };
}

test("a world still at its saved address is left alone", async () => {
  const { deps, calls } = world({ "https://a.example": "world-1" });
  const result = await relocateWorld(
    { origin: "https://a.example", instanceId: "world-1", codes: ["ABCD"] },
    deps,
  );
  assert.deepEqual(result, { found: true, origin: "https://a.example", moved: false });
  // Nothing to look up when the address on file answers.
  assert.deepEqual(calls.tables, []);
});

// The regression: the host shared again, so the address changed while the
// room code did not.
test("a world that moved is found through its room code", async () => {
  const { deps } = world(
    { "https://b.example": "world-1" },
    { ABCD: "https://b.example" },
  );
  const result = await relocateWorld(
    { origin: "https://a.example", instanceId: "world-1", codes: ["ABCD"] },
    deps,
  );
  assert.deepEqual(result, { found: true, origin: "https://b.example", moved: true });
});

test("the first code that leads anywhere wins, and later ones are not asked for", async () => {
  const { deps, calls } = world(
    { "https://b.example": "world-1" },
    { DEAD: "", ABCD: "https://b.example" },
  );
  const result = await relocateWorld(
    { origin: "https://a.example", instanceId: "world-1", codes: ["DEAD", "ABCD", "LATER"] },
    deps,
  );
  assert.equal(result.found && result.origin, "https://b.example");
  assert.deepEqual(calls.tables, ["DEAD", "ABCD"]);
});

// The safety rule. play-CODE hostnames are handed out per session and can
// later belong to somebody else's world; a saved session must never follow
// the address alone.
test("an address that answers as a different world is refused, not adopted", async () => {
  const { deps } = world({ "https://a.example": "someone-else" });
  const result = await relocateWorld(
    { origin: "https://a.example", instanceId: "world-1", codes: [] },
    deps,
  );
  assert.deepEqual(result, { found: false });
});

test("a registry answer that is a different world is refused too", async () => {
  const { deps } = world(
    { "https://b.example": "someone-else" },
    { ABCD: "https://b.example" },
  );
  const result = await relocateWorld(
    { origin: "https://a.example", instanceId: "world-1", codes: ["ABCD"] },
    deps,
  );
  assert.deepEqual(result, { found: false });
});

test("an entry with no stable id trusts its address and never chases a new one", async () => {
  const { deps, calls } = world(
    { "https://a.example": "world-1", "https://b.example": "world-1" },
    { ABCD: "https://b.example" },
  );
  const still = await relocateWorld(
    { origin: "https://a.example", instanceId: "", codes: ["ABCD"] },
    deps,
  );
  assert.deepEqual(still, { found: true, origin: "https://a.example", moved: false });
  const gone = await relocateWorld(
    { origin: "https://dead.example", instanceId: "", codes: ["ABCD"] },
    deps,
  );
  assert.deepEqual(gone, { found: false });
  assert.deepEqual(calls.tables, []);
});

test("nowhere to go leaves the entry where it was", async () => {
  const { deps } = world({}, { ABCD: "" });
  const result = await relocateWorld(
    { origin: "https://a.example", instanceId: "world-1", codes: ["ABCD"] },
    deps,
  );
  assert.deepEqual(result, { found: false });
});

test("codes are tidied, deduped and capped", async () => {
  const { deps, calls } = world({});
  const codes = [" abcd ", "ABCD", ...Array.from({ length: 20 }, (_, i) => `C${i}`)];
  await relocateWorld({ origin: "https://dead.example", instanceId: "world-1", codes }, deps);
  assert.equal(calls.tables.length, MAX_CODES_TRIED);
  assert.equal(calls.tables[0], "ABCD");
  assert.equal(new Set(calls.tables).size, calls.tables.length);
});

test("a probe or registry that throws does not break the search", async () => {
  const deps = {
    probe: async (origin) => {
      if (origin === "https://a.example") throw new Error("network down");
      return origin === "https://b.example" ? { instanceId: "world-1" } : null;
    },
    resolveTable: async (code) => {
      if (code === "BOOM") throw new Error("broker down");
      return "https://b.example";
    },
  };
  const result = await relocateWorld(
    { origin: "https://a.example", instanceId: "world-1", codes: ["BOOM", "ABCD"] },
    deps,
  );
  assert.deepEqual(result, { found: true, origin: "https://b.example", moved: true });
});

// Audit S9: a saved https world is never followed to plain http on the open
// internet, even when the registry points there and the world answers.
test("an https world is not relocated to an insecure public address", async () => {
  const { deps } = world({ "http://203.0.113.9:3005": "world-1" }, { ABCD: "http://203.0.113.9:3005" });
  const result = await relocateWorld({ origin: "https://a.example", instanceId: "world-1", codes: ["ABCD"] }, deps);
  assert.deepEqual(result, { found: false });
  // A LAN address is still fine.
  const lan = world({ "http://192.168.1.9:3005": "world-1" }, { ABCD: "http://192.168.1.9:3005" });
  const moved = await relocateWorld({ origin: "https://a.example", instanceId: "world-1", codes: ["ABCD"] }, lan.deps);
  assert.deepEqual(moved, { found: true, origin: "http://192.168.1.9:3005", moved: true });
});
