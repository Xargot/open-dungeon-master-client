import assert from "node:assert/strict";
import test from "node:test";
import { nativeEligible, parseVersion, portalEligible } from "../dist/shared/portal-logic.js";

test("parseVersion reads the leading x.y.z and ignores tags", () => {
  assert.deepEqual(parseVersion("0.16.0"), [0, 16, 0]);
  assert.deepEqual(parseVersion("1.2.3-beta"), [1, 2, 3]);
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion("dev"), null);
});

test("a host at or above the bundled minor is eligible", () => {
  assert.deepEqual(portalEligible({ bundled: "0.16.0", remote: "0.16.0" }), { ok: true });
  assert.deepEqual(portalEligible({ bundled: "0.16.0", remote: "0.16.4" }), { ok: true });
  assert.deepEqual(portalEligible({ bundled: "0.16.2", remote: "0.17.0" }), { ok: true });
});

test("an older host, another major line, or an unknown version opens its own pages", () => {
  assert.equal(portalEligible({ bundled: "0.16.0", remote: "0.15.0" }).ok, false);
  assert.equal(portalEligible({ bundled: "1.0.0", remote: "0.16.0" }).ok, false);
  assert.equal(portalEligible({ bundled: "0.16.0", remote: "" }).ok, false);
});

test("a bundled server without the proxy never portals", () => {
  assert.equal(portalEligible({ bundled: "0.15.0", remote: "0.16.0" }).ok, false);
  assert.equal(portalEligible({ bundled: "", remote: "0.16.0" }).ok, false);
});

test("the native screens need a host that answers the app's own origin", () => {
  assert.deepEqual(nativeEligible("0.30.0"), { ok: true });
  assert.deepEqual(nativeEligible("0.30.1"), { ok: true });
  assert.deepEqual(nativeEligible("1.2.0"), { ok: true });
  // Hosts before NPC advances (server 0.30.0) have no route for the Bonds
  // tab's opt-in and drop who a character is drawn to.
  assert.equal(nativeEligible("0.29.1").ok, false);
  assert.match(nativeEligible("0.29.1").reason, /0\.30\.0 or newer/);
  // Hosts before one tool per intent (server 0.29.1) refuse the console's
  // enemy conditions, enemy damage and teleports by their merged tools, drop
  // a workshop attack's bonus action and a swarm's weaker blow, and refuse
  // True Polymorph into a creature that is no beast.
  // They also name every class's subclasses among a player's own a table
  // leaves out, so a fighter's subclass list would explain away a wizard's.
  assert.equal(nativeEligible("0.29.0").ok, false);
  assert.match(nativeEligible("0.29.0").reason, /0\.30\.0 or newer/);
  // Hosts before workshop classes and whole names (server 0.29.0) refuse a
  // class of the table's own and drop the row a renamed Market line is.
  assert.equal(nativeEligible("0.28.4").ok, false);
  assert.match(nativeEligible("0.28.4").reason, /0\.30\.0 or newer/);
  // Hosts before the table's pace and breaks (server 0.28.4) drop when the
  // AI DM answers and have no break, Pass or party backstory routes.
  assert.equal(nativeEligible("0.28.3").ok, false);
  assert.match(nativeEligible("0.28.3").reason, /0\.30\.0 or newer/);
  // Hosts before hands and gear and the fight pace (server issues 424 and
  // 432) drop the table's fight pace and have no tool for a gear card's move.
  assert.equal(nativeEligible("0.28.2").ok, false);
  assert.match(nativeEligible("0.28.2").reason, /0\.30\.0 or newer/);
  // Hosts before one cloak at a time (server issue 412) drop where a
  // workshop item is worn and the DM's "wear both", and their engine counts
  // a second cloak's magic that the sheet would leave out of its AC.
  assert.equal(nativeEligible("0.28.1").ok, false);
  assert.equal(nativeEligible("0.21.3").ok, false);
  // Hosts before the redesign would drop what the new screens save (map
  // skins, stamped props) and do not send the turn budget or enemy intent.
  assert.equal(nativeEligible("0.20.0").ok, false);
  assert.equal(nativeEligible("0.19.0").ok, false);
  assert.equal(nativeEligible("0.18.0").ok, false);
  assert.equal(nativeEligible("0.16.1").ok, false);
  assert.equal(nativeEligible("").ok, false);
});
