import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const spawned = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "node:child_process" && /[\\/]local-ai[\\/](manager|comfy)\.js$/.test(parent?.filename ?? "")) {
    return {
      ...originalLoad.call(this, request, parent, isMain),
      spawn() {
        const child = Object.assign(new EventEmitter(), {
          exitCode: null,
          kill() { this.exitCode = 0; queueMicrotask(() => this.emit("exit", 0)); return true; },
        });
        spawned.push(child);
        return child;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let LocalAiManager;
let ComfyManager;
let CHECKPOINT;
try {
  ({ LocalAiManager } = require("../dist/main/local-ai/manager.js"));
  ({ ComfyManager, CHECKPOINT } = require("../dist/main/local-ai/comfy.js"));
} finally {
  Module._load = originalLoad;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "odm-ai-readiness-"));
  const ai = path.join(root, "text");
  fs.mkdirSync(path.join(ai, "bin"), { recursive: true });
  fs.mkdirSync(path.join(ai, "models"), { recursive: true });
  fs.writeFileSync(path.join(ai, "bin", process.platform === "win32" ? "llama-server.exe" : "llama-server"), "");
  fs.writeFileSync(path.join(ai, "models", "model.gguf"), "");
  fs.writeFileSync(path.join(ai, "state.json"), JSON.stringify({ tierId: "gemma-12b", file: "model.gguf", utilityFile: "", llamaTag: "test" }));
  const images = path.join(root, "images");
  fs.mkdirSync(path.join(images, "ComfyUI", "models", "checkpoints"), { recursive: true });
  fs.mkdirSync(path.dirname(process.platform === "win32" ? path.join(images, "venv", "Scripts", "python.exe") : path.join(images, "venv", "bin", "python")), { recursive: true });
  fs.writeFileSync(process.platform === "win32" ? path.join(images, "venv", "Scripts", "python.exe") : path.join(images, "venv", "bin", "python"), "");
  fs.writeFileSync(path.join(images, "ComfyUI", "models", "checkpoints", CHECKPOINT.file), "");
  return { root, ai, images };
}

const hardware = { platform: process.platform, arch: process.arch, ramGb: 16, vramGb: 0, gpuName: "", gpuVendor: "", unifiedMemory: false };

for (const service of ["text", "images"]) {
  test(`${service} startup rejects an alive process that misses its health deadline`, async () => {
    const dirs = fixture();
    const oldFetch = globalThis.fetch;
    const oldNow = Date.now;
    try {
      globalThis.fetch = async () => { throw new Error("not ready"); };
      let now = 0;
      Date.now = () => { now += 61_000; return now; };
      const manager = service === "text" ? new LocalAiManager(dirs.ai) : new ComfyManager(dirs.images, () => {});
      if (service === "text") manager.hardware = hardware;
      await assert.rejects(manager.start(), /healthy|ready|time/i);
      const status = manager.status();
      assert.equal(status.running, false);
      assert.match(status.error, /healthy|ready|time/i);
    } finally {
      globalThis.fetch = oldFetch;
      Date.now = oldNow;
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  test(`${service} startup succeeds when health becomes available before the deadline`, async () => {
    const dirs = fixture();
    const oldFetch = globalThis.fetch;
    try {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls < 2) throw new Error("warming up");
        return { status: 200, ok: true };
      };
      const manager = service === "text" ? new LocalAiManager(dirs.ai) : new ComfyManager(dirs.images, () => {});
      if (service === "text") manager.hardware = hardware;
      await manager.start();
      assert.equal(manager.status().running, true);
      assert.equal(manager.status().error, "");
      await manager.stop();
    } finally {
      globalThis.fetch = oldFetch;
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  test(`${service} startup does not accept an unhealthy HTTP response as readiness`, async () => {
    const dirs = fixture();
    const oldFetch = globalThis.fetch;
    const oldNow = Date.now;
    try {
      globalThis.fetch = async () => ({ status: 503, ok: false });
      let now = 0;
      Date.now = () => { now += service === "text" ? 20_000 : 40_000; return now; };
      const manager = service === "text" ? new LocalAiManager(dirs.ai) : new ComfyManager(dirs.images, () => {});
      if (service === "text") manager.hardware = hardware;
      await assert.rejects(manager.start(), /healthy|ready|time/i);
      assert.equal(manager.status().running, false);
    } finally {
      globalThis.fetch = oldFetch;
      Date.now = oldNow;
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  test(`${service} startup reports a child that exits before health is ready`, async () => {
    const dirs = fixture();
    const oldFetch = globalThis.fetch;
    try {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls > 1) {
          const child = spawned.at(-1);
          child.exitCode = 1;
          child.emit("exit", 1);
        }
        throw new Error("not ready");
      };
      const manager = service === "text" ? new LocalAiManager(dirs.ai) : new ComfyManager(dirs.images, () => {});
      if (service === "text") manager.hardware = hardware;
      await assert.rejects(manager.start(), /exited|stopped/i);
      assert.equal(manager.status().running, false);
    } finally {
      globalThis.fetch = oldFetch;
      fs.rmSync(dirs.root, { recursive: true, force: true });
    }
  });
}
