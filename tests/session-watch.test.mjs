import assert from "node:assert/strict";
import test from "node:test";
import { createSessionWatch } from "../dist/shared/session-watch.js";

// A session that ends on its own while a world is on screen (a password
// changed elsewhere, an admin's reset, the account deleted, the days run
// out) shows as the page's first refused call; the server's own login page,
// where the page would go next, is a dead end inside the app.
test("one 401 from any route but sign-in ends the session, once", () => {
  const watch = createSessionWatch();
  assert.equal(watch.seen("/api/campaigns/abc", 200), false);
  assert.equal(watch.seen("/api/campaigns/abc?since=4", 401), true);
  assert.equal(watch.seen("/api/friends", 401), false, "the news is given once");
});

test("a campaign page's lone refusal is enough: it navigates home next, where /api/auth/me answers 200", () => {
  // useCampaignStream answers a 401 with a move to "/", whose only call is
  // /api/auth/me (200, null user): two 401s never come.
  const watch = createSessionWatch();
  assert.equal(watch.seen("/api/campaigns/abc", 401), true);
});

test("/api/auth/me naming nobody ends the session; naming the player does not", () => {
  const watch = createSessionWatch();
  assert.equal(watch.seen("/api/auth/me", 200, true), false);
  assert.equal(watch.seen("/api/auth/me", 503), false, "an answer that is not the server's word says nothing");
  assert.equal(watch.seen("/api/auth/me", 200, undefined), false, "a body that could not be read says nothing");
  assert.equal(watch.seen("/api/auth/me", 200, false), true);
});

test("the sign-in routes' refusals and other statuses are not the session's", () => {
  const watch = createSessionWatch();
  assert.equal(watch.seen("/api/auth/login", 401), false, "a wrong password");
  assert.equal(watch.seen("/api/auth/token", 401), false);
  assert.equal(watch.seen("/api/campaigns/abc", 403), false, "not a member");
  assert.equal(watch.seen("/api/campaigns/abc", 404), false);
  assert.equal(watch.seen("/uploads/x.png", 401), false, "not an API answer");
  assert.equal(watch.seen("/api/campaigns/abc", 401), true);
});
