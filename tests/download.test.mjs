// The local AI downloader (src/main/local-ai/download.ts) against a real
// HTTP server on loopback: a resume lands only on the offset the server
// confirms, a stalled transfer is dropped with its partial kept, a wrong
// file never takes its real name, and a checksum that cannot be looked up
// stops the install instead of skipping the check.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { downloadVerified, fetchHfSha256 } from "../dist/main/local-ai/download.js";

// A GGUF-looking body: the magic, then filler.
const BODY = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64 * 1024, 7)]);
const SHA = createHash("sha256").update(BODY).digest("hex");

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/model.gguf`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function folder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-download-"));
  return { dir, target: path.join(dir, "model.gguf"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const quiet = { onProgress: () => undefined };

test("a whole download is verified and takes its real name", async () => {
  const host = await serve((_req, res) => res.end(BODY));
  const { target, cleanup } = folder();
  try {
    await downloadVerified(host.url, target, { kind: "gguf", sha256: SHA, ...quiet });
    assert.ok(fs.readFileSync(target).equals(BODY));
    assert.ok(!fs.existsSync(`${target}.part`));
  } finally {
    await host.close();
    cleanup();
  }
});

test("a resume appends only when the server starts exactly at the partial's end", async () => {
  const ranges = [];
  const host = await serve((req, res) => {
    ranges.push(req.headers.range ?? "");
    const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? "")?.[1] ?? 0);
    res.writeHead(206, { "content-range": `bytes ${start}-${BODY.length - 1}/${BODY.length}` });
    res.end(BODY.subarray(start));
  });
  const { target, cleanup } = folder();
  try {
    fs.writeFileSync(`${target}.part`, BODY.subarray(0, 1000));
    await downloadVerified(host.url, target, { kind: "gguf", sha256: SHA, ...quiet });
    assert.deepEqual(ranges, ["bytes=1000-"]);
    assert.ok(fs.readFileSync(target).equals(BODY));
  } finally {
    await host.close();
    cleanup();
  }
});

test("a 206 for another offset is not spliced in: the download starts over", async () => {
  const ranges = [];
  const host = await serve((req, res) => {
    ranges.push(req.headers.range ?? "");
    if (req.headers.range) {
      // Claims a resume but sends the file from byte 0.
      res.writeHead(206, { "content-range": `bytes 0-${BODY.length - 1}/${BODY.length}` });
      res.end(BODY);
      return;
    }
    res.end(BODY);
  });
  const { target, cleanup } = folder();
  try {
    fs.writeFileSync(`${target}.part`, BODY.subarray(0, 1000));
    await downloadVerified(host.url, target, { kind: "gguf", sha256: SHA, ...quiet });
    assert.deepEqual(ranges, ["bytes=1000-", ""]);
    assert.ok(fs.readFileSync(target).equals(BODY));
  } finally {
    await host.close();
    cleanup();
  }
});

test("a stalled transfer is dropped and its partial kept for the next try", async () => {
  const host = await serve((_req, res) => {
    res.writeHead(200, { "content-length": String(BODY.length) });
    res.write(BODY.subarray(0, 4096));
    // ...and then nothing.
  });
  const { target, cleanup } = folder();
  try {
    await assert.rejects(
      downloadVerified(host.url, target, { kind: "gguf", sha256: SHA, idleMs: 300, ...quiet }),
      /stalled/,
    );
    assert.ok(fs.existsSync(`${target}.part`));
    assert.ok(!fs.existsSync(target));
  } finally {
    await host.close();
    cleanup();
  }
});

test("bytes that fail the checksum are deleted, never renamed", async () => {
  const wrong = Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(1024, 1)]);
  const host = await serve((_req, res) => res.end(wrong));
  const { target, cleanup } = folder();
  try {
    await assert.rejects(downloadVerified(host.url, target, { kind: "gguf", sha256: SHA, ...quiet }), /checksum/);
    assert.ok(!fs.existsSync(target));
    assert.ok(!fs.existsSync(`${target}.part`));
  } finally {
    await host.close();
    cleanup();
  }
});

test("a checksum that cannot be looked up stops the install instead of skipping the check", async () => {
  const url = "https://huggingface.co/acme/models/resolve/main/sub/dir/model.gguf";
  const asked = [];
  const down = async (href) => {
    asked.push(String(href));
    throw new Error("offline");
  };
  await assert.rejects(fetchHfSha256(url, down), /Could not look up/);
  // A file in a folder is looked up in that folder's listing.
  assert.deepEqual(asked, ["https://huggingface.co/api/models/acme/models/tree/main/sub/dir"]);
  const listed = async () => Response.json([{ path: "sub/dir/model.gguf", lfs: { oid: SHA } }]);
  assert.equal(await fetchHfSha256(url, listed), SHA);
  const gone = async () => Response.json([{ path: "sub/dir/other.gguf", lfs: { oid: SHA } }]);
  await assert.rejects(fetchHfSha256(url, gone), /no longer lists/);
  await assert.rejects(fetchHfSha256("https://example.com/model.gguf", listed), /source the app can verify/);
});
