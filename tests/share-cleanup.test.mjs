import assert from "node:assert/strict";
import test from "node:test";
import { createPublicUrlSync } from "../dist/main/public-url-sync.js";
import { dropTables } from "../dist/main/table-registry.js";

test("expired local login does not block broker cleanup, and failed deletes remain retryable", async () => {
  let token = null;
  let saved = ["ABCD2345"];
  let deleted = 0;
  let settings = "stale public URL";
  const sync = createPublicUrlSync({
    token: () => token,
    origin: () => "http://127.0.0.1:3005",
    lanOrigin: () => "http://192.168.1.3:3005",
    status: () => ({ state: "stopped", url: "" }),
    patch: async (_origin, _token, value) => { settings = value.publicUrl; },
    owned: async () => [],
    publish: async () => ({ published: [], refused: [] }),
    drop: async () => { deleted++; return deleted === 1 ? ["ABCD2345"] : []; },
    publishedCodes: () => saved,
    setPublishedCodes: (codes) => { saved = [...codes]; },
    secretFor: () => "saved-secret",
    refusedCodes: () => [],
    setRefusedCodes: () => {},
  });

  await sync();
  assert.equal(deleted, 1);
  assert.deepEqual(saved, ["ABCD2345"]);
  assert.equal(settings, "stale public URL");

  token = "renewed-token";
  await sync();
  assert.equal(deleted, 2);
  assert.deepEqual(saved, []);
  assert.equal(settings, "http://192.168.1.3:3005");
});

test("an in-flight publish followed by Stop patches settings before a slow failed DELETE and retries it", async () => {
  let state = "running";
  let publicUrl = "";
  let registryUrl = "";
  let saved = [];
  let publishStarted;
  let releasePublish;
  let dropStarted;
  let releaseDrop;
  const publishing = new Promise((resolve) => { publishStarted = resolve; });
  const heldPublish = new Promise((resolve) => { releasePublish = resolve; });
  const dropping = new Promise((resolve) => { dropStarted = resolve; });
  const heldDrop = new Promise((resolve) => { releaseDrop = resolve; });
  let deleteAttempts = 0;
  const sync = createPublicUrlSync({
    token: () => "local-token",
    origin: () => "http://127.0.0.1:3005",
    lanOrigin: () => "http://192.168.1.3:3005",
    status: () => ({ state, url: state === "running" ? "https://share.example" : "" }),
    patch: async (_origin, _token, value) => { publicUrl = value.publicUrl; },
    owned: async () => ["ABCD2345"],
    publish: async () => {
      publishStarted();
      await heldPublish;
      registryUrl = "https://share.example";
      return { published: ["ABCD2345"], refused: [] };
    },
    drop: async () => {
      deleteAttempts++;
      if (deleteAttempts === 1) {
        dropStarted();
        await heldDrop;
        return ["ABCD2345"];
      }
      registryUrl = "";
      return [];
    },
    publishedCodes: () => saved,
    setPublishedCodes: (codes) => { saved = [...codes]; },
    secretFor: () => "saved-secret",
    refusedCodes: () => [],
    setRefusedCodes: () => {},
  });

  const oldPublish = sync();
  await publishing;
  state = "stopped";
  const stop = sync();
  releasePublish();
  await dropping;
  assert.equal(publicUrl, "http://192.168.1.3:3005");
  releaseDrop();
  await Promise.all([oldPublish, stop]);
  assert.equal(registryUrl, "https://share.example");
  assert.deepEqual(saved, ["ABCD2345"]);

  await sync();
  assert.equal(deleteAttempts, 2);
  assert.equal(registryUrl, "");
  assert.deepEqual(saved, []);
});

test("broker deletion keeps only codes worth trying again", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  // A failing broker, then success, then a code another host claimed (409),
  // then no answer at all.
  const answers = [{ ok: false, status: 503 }, { ok: true, status: 200 }, { ok: false, status: 409 }, null];
  globalThis.fetch = async (_url, init) => {
    requests.push({ method: init.method, secret: init.headers["x-table-secret"] });
    const answer = answers[requests.length - 1];
    if (!answer) throw new TypeError("fetch failed");
    return answer;
  };
  try {
    const failed = await dropTables({
      codes: ["ABCD2345", "EFGH6789", "JKMN2345", "PQRS6789"],
      secretFor: (code) => `secret-${code}`,
    });
    assert.deepEqual(requests, [
      { method: "DELETE", secret: "secret-ABCD2345" },
      { method: "DELETE", secret: "secret-EFGH6789" },
      { method: "DELETE", secret: "secret-JKMN2345" },
      { method: "DELETE", secret: "secret-PQRS6789" },
    ]);
    assert.deepEqual(failed, ["ABCD2345", "PQRS6789"], "a 409 answers the same next time and is not kept");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
