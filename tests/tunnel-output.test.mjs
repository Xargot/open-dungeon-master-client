import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { QuickTunnel } from "../dist/main/tunnel.js";

function child() {
  const fake = new EventEmitter();
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  return fake;
}

for (const chunks of [
  ["ready https:/", "/alpha.trycloudflare.com\n"],
  ["ready https://alpha.trycloud", "flare.com\n"],
  ["https://", "alpha.", "trycloudflare", ".com"],
]) {
  test(`quick tunnel captures a URL split across ${chunks.length} stdout chunks`, async () => {
    const log = mock.method(fs, "createWriteStream", () => new PassThrough());
    try {
      const tunnel = new QuickTunnel("unused", "unused.log");
      const fake = child();
      const address = tunnel.captureUrl(fake);
      for (const chunk of chunks) fake.stdout.emit("data", Buffer.from(chunk));
      fake.emit("exit", 0);
      assert.equal(await address, "https://alpha.trycloudflare.com");
    } finally {
      log.mock.restore();
    }
  });
}

test("quick tunnel captures a URL split across stderr chunks", async () => {
  const log = mock.method(fs, "createWriteStream", () => new PassThrough());
  try {
    const tunnel = new QuickTunnel("unused", "unused.log");
    const fake = child();
    const address = tunnel.captureUrl(fake);
    fake.stderr.emit("data", Buffer.from("https://beta.trycloudflare."));
    fake.stderr.emit("data", Buffer.from("com"));
    fake.emit("exit", 0);
    assert.equal(await address, "https://beta.trycloudflare.com");
  } finally {
    log.mock.restore();
  }
});

test("quick tunnel does not join unrelated stdout and stderr fragments", async () => {
  const log = mock.method(fs, "createWriteStream", () => new PassThrough());
  try {
    const tunnel = new QuickTunnel("unused", "unused.log");
    const fake = child();
    const address = tunnel.captureUrl(fake);
    fake.stdout.emit("data", Buffer.from("https://alpha."));
    fake.stderr.emit("data", Buffer.from("trycloudflare.com"));
    fake.emit("exit", 0);
    await assert.rejects(address, /exited during startup/);
  } finally {
    log.mock.restore();
  }
});
