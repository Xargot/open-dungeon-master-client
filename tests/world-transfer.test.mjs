import assert from "node:assert/strict";
import test from "node:test";
import {
  commitWorldImport,
  describeCounts,
  describePreview,
  exportFileName,
  formatBytes,
  runWorldJob,
} from "../dist/shared/world-transfer.js";

// The device world's archive job as the shells follow it (src/shared/world-transfer.ts).

function server(replies) {
  const asked = [];
  return {
    asked,
    request: async (method, body) => {
      asked.push({ method, body });
      return replies.shift() ?? { status: 500, data: { error: "no more replies" } };
    },
  };
}

const job = (fields) => ({ kind: "export", phase: "", done: false, error: "", export: null, preview: null, ...fields });

test("a job is followed phase by phase until it is done", async () => {
  const done = job({ done: true, phase: "Ready", export: { name: "odm-world-x.tar.gz", bytes: 10, sha256: "", counts: {} } });
  const api = server([
    { status: 202, data: { job: job({}) } },
    { status: 200, data: { job: job({ phase: "Copying the database" }) } },
    { status: 200, data: { job: job({ phase: "Copying the database" }) } },
    { status: 200, data: { job: job({ phase: "Packing 1 of 2 files" }) } },
    { status: 200, data: { job: done } },
  ]);
  const phases = [];
  const result = await runWorldJob(api.request, { action: "export" }, (phase) => phases.push(phase), async () => undefined);
  assert.equal(result.export.name, "odm-world-x.tar.gz");
  assert.deepEqual(phases, ["Copying the database", "Packing 1 of 2 files", "Ready"], "each phase once");
  assert.deepEqual(api.asked[0], { method: "POST", body: { action: "export" } });
});

test("a job that fails says why, in the server's words", async () => {
  const api = server([
    { status: 202, data: { job: job({}) } },
    { status: 200, data: { job: job({ done: true, error: "This world was saved by a newer Open Dungeon Master (0.30.0)." }) } },
  ]);
  await assert.rejects(
    runWorldJob(api.request, { action: "check", name: "import-a.tar.gz" }, () => undefined, async () => undefined),
    /newer Open Dungeon Master/,
  );
});

test("an older world server without the route asks for an update", async () => {
  const api = server([{ status: 404, data: { error: "Not found." } }]);
  await assert.rejects(runWorldJob(api.request, { action: "export" }, () => undefined), /too old to move worlds/);
});

test("a job that never finishes gives up", async () => {
  let clock = 0;
  const api = server(Array.from({ length: 5 }, () => ({ status: 200, data: { job: job({ phase: "Packing" }) } })));
  api.asked.length = 0;
  await assert.rejects(
    runWorldJob(api.request, { action: "export" }, () => undefined, async () => {
      clock += 31 * 60_000;
    }, () => clock),
    /took too long/,
  );
});

test("a commit hands back the owner to sign in as", async () => {
  const api = server([{ status: 200, data: { owner: "rowan", restart: true } }]);
  assert.deepEqual(await commitWorldImport(api.request, "import-a.tar.gz", "s".repeat(32)), { owner: "rowan" });
  assert.deepEqual(api.asked[0].body, { action: "commit", name: "import-a.tar.gz", ownerPassword: "s".repeat(32) });
  const refused = server([{ status: 409, data: { error: "Check the archive first." } }]);
  await assert.rejects(commitWorldImport(refused.request, "import-a.tar.gz", "x"), /Check the archive first/);
});

test("the question before an import says what the archive holds", () => {
  const counts = { campaigns: 1, users: 2, messages: 1, files: 0 };
  assert.equal(describeCounts(counts), "1 campaign, 2 accounts, 1 message and 0 files");
  const text = describePreview({ name: "import-a.tar.gz", serverVersion: "0.26.2", createdAt: "2026-10-11T10:00:00.000Z", owner: "rowan", counts }, "en-US");
  assert.match(text, /^1 campaign, 2 accounts, 1 message and 0 files, saved Oct 11, 2026/);
  assert.match(text, /You will play as rowan\.$/);
  assert.equal(exportFileName({ name: "odm-world-2026-10-11T10-00-00Z.tar.gz" }), "odm-world-2026-10-11T10-00-00Z.tar.gz");
  assert.equal(exportFileName({ name: "../../etc/passwd" }), "odm-world.tar.gz");
  assert.equal(formatBytes(5 * 1024 ** 2), "5.0 MB");
});
