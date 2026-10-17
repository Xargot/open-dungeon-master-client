import assert from "node:assert/strict";
import test from "node:test";
import { createPublicUrlSync } from "../dist/main/public-url-sync.js";

test("Stop waits for an in-flight publish and leaves the registry and settings offline", async () => {
  let state = "running";
  let publicUrl = "";
  let registryUrl = "";
  let publishedCodes = [];
  let releasePublish;
  let publishStarted;
  const started = new Promise((resolve) => { publishStarted = resolve; });
  const held = new Promise((resolve) => { releasePublish = resolve; });
  const sync = createPublicUrlSync({
    token: () => "local-token",
    origin: () => "http://127.0.0.1:3005",
    lanOrigin: () => "http://192.168.1.3:3005",
    status: () => ({ state, url: state === "running" ? "https://share.example" : "" }),
    patch: async (_origin, _token, settings) => { publicUrl = settings.publicUrl; },
    owned: async () => ["ABCD2345"],
    publish: async () => {
      publishStarted();
      await held;
      registryUrl = "https://share.example";
      return { published: ["ABCD2345"], refused: [] };
    },
    drop: async () => { registryUrl = ""; return []; },
    publishedCodes: () => publishedCodes,
    setPublishedCodes: (codes) => { publishedCodes = [...codes]; },
    secretFor: () => "secret",
    refusedCodes: () => [],
    setRefusedCodes: () => {},
  });

  const publishing = sync();
  await started;
  state = "stopped";
  const stopping = sync();
  releasePublish();
  await Promise.all([publishing, stopping]);

  assert.equal(registryUrl, "");
  assert.deepEqual(publishedCodes, []);
  assert.equal(publicUrl, "http://192.168.1.3:3005");
});
