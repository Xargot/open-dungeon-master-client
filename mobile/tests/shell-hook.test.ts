import assert from "node:assert/strict";
import test from "node:test";
import { hookedFetch } from "../src/shell-hook-core";

// The game web view's fetch (shell-hook.ts): a fake page at a world, its
// calls answered from a script, and what the hook tells the bridge.

const PAGE = "https://play.example.test/campaigns/abc";

function harness(answers: Record<string, { status: number; body?: unknown }>) {
  const sent: { url: string; method: string }[] = [];
  const told: string[] = [];
  const fetch = hookedFetch({
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      sent.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      const path = new URL(url, PAGE).pathname;
      const answer = answers[path] ?? { status: 200, body: {} };
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
    },
    pageHref: () => PAGE,
    onLogout: () => told.push("servers"),
    onSessionLost: () => told.push("session-lost"),
  });
  // The watch reads answers after the page's call resolves.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { fetch, sent, told, settle };
}

test("an old server's Log out never leaves and opens the server list", async () => {
  const h = harness({});
  const response = await h.fetch("/api/auth/logout", { method: "POST" });
  assert.equal(response.status, 204);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.told, ["servers"]);
});

test("a campaign page's one refused call is the session's end (two never come)", async () => {
  const h = harness({ "/api/campaigns/abc": { status: 401, body: { error: "Not logged in." } } });
  const response = await h.fetch("/api/campaigns/abc");
  // The page still gets its answer and reads it.
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Not logged in." });
  await h.settle();
  assert.deepEqual(h.told, ["session-lost"]);
  await h.fetch("/api/friends");
  await h.fetch("/api/campaigns/abc");
  await h.settle();
  assert.deepEqual(h.told, ["session-lost"], "told once");
});

test("/api/auth/me naming nobody is the session's end, and the page still reads the body", async () => {
  const h = harness({ "/api/auth/me": { status: 200, body: { user: null } } });
  const response = await h.fetch("/api/auth/me");
  assert.deepEqual(await response.json(), { user: null });
  await h.settle();
  assert.deepEqual(h.told, ["session-lost"]);
});

test("a signed-in page, a wrong password and another origin's 401 are not news", async () => {
  const h = harness({
    "/api/auth/me": { status: 200, body: { user: { id: "u1" } } },
    "/api/auth/login": { status: 401, body: { error: "Wrong username or password." } },
    // Only ever asked of another origin below.
    "/api/campaigns": { status: 401 },
  });
  await h.fetch("/api/auth/me");
  await h.fetch("/api/auth/login", { method: "POST" });
  await h.fetch("https://elsewhere.example/api/campaigns", {});
  await h.fetch(new Request("https://play.example.test/api/campaigns/abc"));
  await h.settle();
  assert.deepEqual(h.told, []);
  // A logout by GET is no logout (the server has none); it is sent.
  await h.fetch("/api/auth/logout");
  assert.equal(h.sent.at(-1)?.url, "/api/auth/logout");
});
