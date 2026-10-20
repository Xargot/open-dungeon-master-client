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
  assert.deepEqual(nativeEligible("0.28.2"), { ok: true });
  assert.deepEqual(nativeEligible("0.29.0"), { ok: true });
  assert.deepEqual(nativeEligible("1.2.0"), { ok: true });
  // Hosts before one cloak at a time (server issue 412) drop where a
  // workshop item is worn and the DM's "wear both", and their engine counts
  // a second cloak's magic that the sheet would leave out of its AC.
  assert.equal(nativeEligible("0.28.1").ok, false);
  assert.equal(nativeEligible("0.21.3").ok, false);
  assert.match(nativeEligible("0.28.1").reason, /0\.28\.2 or newer/);
  // Hosts before the redesign would drop what the new screens save (map
  // skins, stamped props) and do not send the turn budget or enemy intent.
  assert.equal(nativeEligible("0.20.0").ok, false);
  assert.equal(nativeEligible("0.19.0").ok, false);
  assert.equal(nativeEligible("0.18.0").ok, false);
  assert.equal(nativeEligible("0.16.1").ok, false);
  assert.equal(nativeEligible("").ok, false);
});
