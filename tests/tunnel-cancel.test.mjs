import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { QuickTunnel } from "../dist/main/tunnel.js";

const session = {
  code: "ABCD1234",
  hostname: "play-abcd1234.opendungeonmaster.com",
  tunnelToken: "token",
  secret: "secret",
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function runningChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => true;
  child.finishExit = () => {
    child.exitCode = 0;
    child.emit("exit", 0);
  };
  return child;
}

test("Stop during binary acquisition prevents a later tunnel launch", async () => {
  const binary = deferred();
  const tunnel = new QuickTunnel("unused", "unused");
  let launches = 0;
  const ensure = mock.method(tunnel, "ensureBinary", () => binary.promise);
  const spawn = mock.method(childProcess, "spawn", () => { launches++; throw new Error("launched after Stop"); });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  try {
    const started = tunnel.start(3333);
    await tunnel.stop();
    binary.resolve("unused-cloudflared");
    await started;
    assert.equal(launches, 0);
    assert.deepEqual(tunnel.status(), { state: "stopped", url: "", mode: "", error: "" });
  } finally {
    ensure.mock.restore();
    spawn.mock.restore();
    globalThis.fetch = originalFetch;
  }
});

test("Stop during broker request releases its late session without launching", async () => {
  const broker = deferred();
  const tunnel = new QuickTunnel("unused", "unused");
  let launches = 0;
  let deletes = 0;
  const ensure = mock.method(tunnel, "ensureBinary", async () => "unused-cloudflared");
  const spawn = mock.method(childProcess, "spawn", () => { launches++; throw new Error("launched after Stop"); });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (options?.method === "POST") return broker.promise;
    if (options?.method === "DELETE" && url.endsWith("/session/ABCD1234")) {
      deletes++;
      return { ok: true };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const started = tunnel.start(3333);
    await Promise.resolve();
    await tunnel.stop();
    broker.resolve({ ok: true, json: async () => session });
    await started;
    assert.equal(launches, 0);
    assert.equal(deletes, 1);
    assert.deepEqual(tunnel.status(), { state: "stopped", url: "", mode: "", error: "" });
  } finally {
    ensure.mock.restore();
    spawn.mock.restore();
    globalThis.fetch = originalFetch;
  }
});

test("Stop during named tunnel cleanup prevents quick tunnel fallback", async () => {
  const deleting = deferred();
  const deleteStarted = deferred();
  const tunnel = new QuickTunnel("unused", "unused.log");
  let launches = 0;
  const ensure = mock.method(tunnel, "ensureBinary", async () => "unused-cloudflared");
  const log = mock.method(fs, "createWriteStream", () => new PassThrough());
  const spawn = mock.method(childProcess, "spawn", () => {
    launches++;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = 1;
    child.kill = () => true;
    queueMicrotask(() => child.emit("exit", 1));
    return child;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (options?.method === "POST") return { ok: true, json: async () => session };
    if (options?.method === "DELETE" && url.endsWith("/session/ABCD1234")) {
      deleteStarted.resolve();
      return deleting.promise;
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const started = tunnel.start(3333);
    await deleteStarted.promise;
    await tunnel.stop();
    deleting.resolve({ ok: true });
    await started;
    assert.equal(launches, 1);
    assert.deepEqual(tunnel.status(), { state: "stopped", url: "", mode: "", error: "" });
  } finally {
    ensure.mock.restore();
    log.mock.restore();
    spawn.mock.restore();
    globalThis.fetch = originalFetch;
  }
});

for (const mode of ["named", "quick"]) {
  test(`Stop during successful ${mode} warmup never reports running`, async () => {
    const reachable = deferred();
    const reachableStarted = deferred();
    const tunnel = new QuickTunnel("unused", "unused.log");
    const observed = [];
    tunnel.onStatus(() => observed.push(tunnel.status().state));
    const ensure = mock.method(tunnel, "ensureBinary", async () => "unused-cloudflared");
    const log = mock.method(fs, "createWriteStream", () => new PassThrough());
    let child;
    const spawn = mock.method(childProcess, "spawn", () => {
      child = runningChild();
      if (mode === "quick") {
        queueMicrotask(() => child.stderr.emit("data", Buffer.from("https://alpha.trycloudflare.com")));
      }
      return child;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (options?.method === "POST") {
        return mode === "named" ? { ok: true, json: async () => session } : { ok: false };
      }
      if (options?.method === "DELETE") return { ok: true };
      if (String(url).startsWith("https://cloudflare-dns.com/")) {
        return { json: async () => ({ Answer: [{}] }) };
      }
      if (String(url).endsWith("/api/health")) {
        reachableStarted.resolve();
        return reachable.promise;
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    try {
      const started = tunnel.start(3333);
      await reachableStarted.promise;
      const stopped = tunnel.stop();
      reachable.resolve({ ok: true });
      await Promise.resolve();
      child.finishExit();
      await Promise.all([stopped, started]);
      assert.equal(observed.includes("running"), false);
      assert.deepEqual(tunnel.status(), { state: "stopped", url: "", mode: "", error: "" });
    } finally {
      ensure.mock.restore();
      log.mock.restore();
      spawn.mock.restore();
      globalThis.fetch = originalFetch;
    }
  });
}
