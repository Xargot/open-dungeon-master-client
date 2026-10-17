import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const Module = require("node:module");
let lastChild;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "node:child_process" && /[\\/](manager|comfy|local-server|tunnel)\.js$/.test(parent?.filename ?? "")) {
    return {
      ...originalLoad.call(this, request, parent, isMain),
      spawn() {
        const child = Object.assign(new EventEmitter(), {
          exitCode: null,
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          kill() { queueMicrotask(() => this.emit("exit", 0)); return true; },
        });
        lastChild = child;
        queueMicrotask(() => {
          try { child.emit("error", new Error("EACCES launch denied")); }
          catch { /* The assertion below observes the missing rejection. */ }
        });
        return child;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let LocalAiManager, ComfyManager, CHECKPOINT, LocalServer, QuickTunnel;
try {
  ({ LocalAiManager } = require("../dist/main/local-ai/manager.js"));
  ({ ComfyManager, CHECKPOINT } = require("../dist/main/local-ai/comfy.js"));
  ({ LocalServer } = require("../dist/main/local-server.js"));
  ({ QuickTunnel } = require("../dist/main/tunnel.js"));
} finally {
  Module._load = originalLoad;
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "odm-launch-error-")); }
const hardware = { platform: process.platform, arch: process.arch, ramGb: 16, vramGb: 0, gpuName: "", gpuVendor: "", unifiedMemory: false };

test("text AI launch error rejects startup, reports failure, and stop settles without exit", async () => {
  const root = tempDir();
  const oldFetch = globalThis.fetch;
  const oldNow = Date.now;
  try {
    fs.mkdirSync(path.join(root, "bin"));
    fs.mkdirSync(path.join(root, "models"));
    fs.writeFileSync(path.join(root, "bin", process.platform === "win32" ? "llama-server.exe" : "llama-server"), "");
    fs.writeFileSync(path.join(root, "models", "model.gguf"), "");
    fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ tierId: "gemma-12b", file: "model.gguf", utilityFile: "" }));
    globalThis.fetch = async () => { throw new Error("offline"); };
    let now = 0;
    Date.now = () => { now += 20_000; return now; };
    const manager = new LocalAiManager(root);
    manager.hardware = hardware;
    await assert.rejects(manager.start(), /EACCES/);
    assert.equal(manager.status().running, false);
    assert.match(manager.status().error, /EACCES/);
    await manager.stop();
  } finally {
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("image AI launch error rejects startup, reports failure, and stop settles without exit", async () => {
  const root = tempDir();
  const oldFetch = globalThis.fetch;
  const oldNow = Date.now;
  try {
    const checkpoint = path.join(root, "ComfyUI", "models", "checkpoints", CHECKPOINT.file);
    const python = process.platform === "win32" ? path.join(root, "venv", "Scripts", "python.exe") : path.join(root, "venv", "bin", "python");
    fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(checkpoint, "");
    fs.writeFileSync(python, "");
    globalThis.fetch = async () => { throw new Error("offline"); };
    let now = 0;
    Date.now = () => { now += 40_000; return now; };
    const manager = new ComfyManager(root, () => {});
    await assert.rejects(manager.start(), /EACCES/);
    assert.equal(manager.status().running, false);
    assert.match(manager.status().error, /EACCES/);
    await manager.stop();
  } finally {
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local server launch error rejects startup and stop settles without exit", async () => {
  const root = tempDir();
  const oldFetch = globalThis.fetch;
  const oldNow = Date.now;
  try {
    const server = new LocalServer(root, root, root);
    server.syncRunTree = async () => {};
    server.pickPort = async () => 3210;
    server.dbEncryptionKey = () => "test-key";
    server.portalSecret = () => "test-secret";
    globalThis.fetch = async () => { throw new Error("offline"); };
    let now = 0;
    Date.now = () => { now += 30_000; return now; };
    await assert.rejects(server.start(), /EACCES/);
    assert.equal(server.running, false);
    await server.stop();
  } finally {
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("quick tunnel launch error settles startup as failure without an exit event", async () => {
  const root = tempDir();
  try {
    const tunnel = new QuickTunnel(root, path.join(root, "tunnel.log"));
    tunnel.ensureBinary = async () => "fake-cloudflared";
    tunnel.requestBrokerSession = async () => null;
    const started = tunnel.start(3210);
    const outcome = await Promise.race([
      started,
      new Promise((resolve) => setTimeout(() => resolve({ state: "did not settle" }), 100)),
    ]);
    // Release the baseline capture promise if its error handler is missing.
    if (outcome.state === "did not settle") {
      lastChild.emit("exit", 1);
      await started;
    }
    assert.equal(outcome.state, "error");
    assert.match(outcome.error, /EACCES/);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
