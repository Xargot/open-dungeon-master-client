import assert from "node:assert/strict";
import test from "node:test";
import { GameRouter, isAbsoluteUrl, matchRoute } from "../dist/shared/game-router.js";

test("matchRoute reads params one segment at a time", () => {
  assert.deepEqual(matchRoute("/", "/"), {});
  assert.deepEqual(matchRoute("/campaigns/:campaignId", "/campaigns/abc-1"), { campaignId: "abc-1" });
  assert.deepEqual(matchRoute("/campaigns/:campaignId/character", "/campaigns/x/character"), { campaignId: "x" });
  assert.equal(matchRoute("/campaigns/:campaignId", "/campaigns/x/character"), null);
  assert.equal(matchRoute("/characters", "/characters/new"), null);
  assert.deepEqual(matchRoute("/join/:code", "/join/ABCD%202"), { code: "ABCD 2" });
});

test("the router keeps a stack, splits queries, and notifies on every change", () => {
  const router = new GameRouter("/?new=1");
  const seen = [];
  router.subscribe(() => seen.push(router.location.pathname + router.location.search));
  assert.deepEqual(router.location, { pathname: "/", search: "?new=1" });
  router.push("/campaigns/c1");
  router.replace("/campaigns/c1?tab=party");
  assert.equal(router.depth, 2);
  assert.equal(router.back(), true);
  assert.equal(router.back(), false);
  assert.deepEqual(seen, ["/campaigns/c1", "/campaigns/c1?tab=party", "/?new=1"]);
});

test("a full URL leaves the native screens instead of joining the stack", () => {
  const router = new GameRouter("/");
  const left = [];
  router.onLeave = (url) => left.push(url);
  router.push("https://discord.com/oauth");
  router.replace("mailto:someone@example.com");
  assert.deepEqual(left, ["https://discord.com/oauth", "mailto:someone@example.com"]);
  assert.equal(router.depth, 1);
  assert.equal(isAbsoluteUrl("/api/x"), false);
  assert.equal(isAbsoluteUrl("//cdn.example/x"), false);
});

test("refresh keeps the address but yields a new location object", () => {
  const router = new GameRouter("/settings?linked=1");
  const before = router.location;
  let fired = 0;
  router.subscribe(() => fired++);
  router.refresh();
  assert.notEqual(router.location, before);
  assert.deepEqual(router.location, before);
  assert.equal(fired, 1);
  // The count the game root keys the page on, so the page mounts afresh.
  assert.equal(router.refreshes, 1);
  router.push("/campaigns/abc");
  assert.equal(router.refreshes, 1, "a navigation is no refresh");
});

test("the table view has a native screen of its own", () => {
  // docs/vtt-parity-implementation-plan.md 13.2 and 18.2: a second window
  // boots straight into it.
  assert.deepEqual(matchRoute("/campaigns/:campaignId/table", "/campaigns/c1/table"), { campaignId: "c1" });
  assert.equal(matchRoute("/campaigns/:campaignId", "/campaigns/c1/table"), null);
});

test("with a home handler, the bare home page goes to the shell; the wizard's query stays the host's", () => {
  const router = new GameRouter("/?new=1");
  let home = 0;
  router.onHome = () => home++;
  router.push("/campaigns/c1");
  router.push("/");
  router.replace("/#top");
  assert.equal(home, 2);
  assert.equal(router.location.pathname, "/campaigns/c1");
  router.push("/?new=starter");
  assert.deepEqual(router.location, { pathname: "/", search: "?new=starter" });
  assert.equal(router.depth, 3);
  // The home page drops ?new= from its own address once the wizard is open.
  router.replace("/");
  assert.equal(home, 2);
  assert.deepEqual(router.location, { pathname: "/", search: "" });
});

test("back onto the bare home page goes to the shell too; without a handler it stays a page", () => {
  const router = new GameRouter("/");
  router.push("/characters");
  let home = 0;
  router.onHome = () => home++;
  assert.equal(router.back(), true);
  assert.equal(home, 1);
  assert.equal(router.location.pathname, "/characters");
  router.onHome = null;
  assert.equal(router.back(), true);
  assert.deepEqual(router.location, { pathname: "/", search: "" });
});
