// The local story AI's lifecycle (src/main/local-ai/manager.ts), as the
// "Could not reach the backend at http://127.0.0.1:8001/v1/..." investigation
// found it: a missing engine that read as installed and silent, two starts
// racing for the port, any program on 8001 adopted as the AI, an adopted
// server still "running" after it had gone, and a crashed engine that was
// never started again. Processes and HTTP are stand-ins; the control flow is
// the real one.
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
          kill() { this.exitCode = 0; queueMicrotask(() => this.emit("exit", 0, null)); return true; },
        });
        spawned.push(child);
        return child;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let LocalAiManager;
try {
  ({ LocalAiManager } = require("../dist/main/local-ai/manager.js"));
} finally {
  Module._load = originalLoad;
}

const hardware = { platform: process.platform, arch: process.arch, ramGb: 16, vramGb: 0, gpuName: "", gpuVendor: "", unifiedMemory: false };
const binName = process.platform === "win32" ? "llama-server.exe" : "llama-server";

function fixture({ engine = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "odm-ai-lifecycle-"));
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "models"), { recursive: true });
  if (engine) fs.writeFileSync(path.join(root, "bin", binName), "");
  fs.writeFileSync(path.join(root, "models", "model.gguf"), "");
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ tierId: "gemma-12b", file: "model.gguf", utilityFile: "", llamaTag: "test" }));
  return root;
}

// An HTTP stand-in answering by path: `models` for /v1/models, `health` for
// /health; a function may throw to play "nothing listening".
function serve(answers) {
  return async (url) => {
    const route = String(url).endsWith("/v1/models") ? "models" : "health";
    const answer = answers[route];
    if (typeof answer === "function") return answer();
    if (!answer) throw new Error("connect ECONNREFUSED");
    return answer;
  };
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const notFound = { ok: false, status: 404, json: async () => ({}) };

function manager(root, tuning) {
  const made = new LocalAiManager(root, tuning);
  made.hardware = hardware;
  return made;
}

async function withFetch(impl, run) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await run();
  } finally {
    globalThis.fetch = oldFetch;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("an install whose engine is gone says so instead of starting nothing", async () => {
  const root = fixture({ engine: false });
  const before = spawned.length;
  try {
    await withFetch(serve({}), async () => {
      const ai = manager(root);
      let emitted = 0;
      ai.onStatus(() => { emitted += 1; });
      await assert.rejects(ai.start(), /engine \(llama-server\) is missing/);
      const status = ai.status();
      assert.equal(status.installedTierId, "gemma-12b", "the files say installed");
      assert.equal(status.running, false);
      assert.match(status.error, /missing from this install.*Story AI/);
      assert.ok(emitted >= 1, "the renderer hears about it");
      assert.equal(spawned.length, before, "nothing to run");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two starts at once share one engine", async () => {
  const root = fixture();
  const before = spawned.length;
  try {
    await withFetch(serve({ health: ok({ status: "ok" }) }), async () => {
      const ai = manager(root);
      await Promise.all([ai.start(), ai.start(), ai.start()]);
      assert.equal(spawned.length, before + 1, "one process for three callers");
      assert.equal(ai.status().running, true);
      assert.equal(ai.status().external, false);
      await ai.stop();
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stray program on the port is not adopted as the AI; a model server is", async () => {
  const root = fixture();
  try {
    // Something answers 404 at /v1/models and 200 at /health: not a model
    // server, so the engine is started beside it (and would then own the
    // health answer).
    const before = spawned.length;
    await withFetch(serve({ models: notFound, health: ok({ status: "ok" }) }), async () => {
      const ai = manager(root);
      await ai.start();
      assert.equal(spawned.length, before + 1, "ours was started");
      assert.equal(ai.status().external, false);
      await ai.stop();
    });
    // A server that lists models is theirs to run.
    const again = spawned.length;
    await withFetch(serve({ models: ok({ data: [{ id: "qwen" }] }), health: ok({ status: "ok" }) }), async () => {
      const ai = manager(root);
      await ai.start();
      assert.equal(spawned.length, again, "nothing started");
      assert.deepEqual([ai.status().running, ai.status().external], [true, true]);
      assert.equal(ai.status().endpoint, "http://127.0.0.1:8001/v1");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an adopted server that has gone is no longer running, and the installed engine takes its place", async () => {
  const root = fixture();
  const before = spawned.length;
  try {
    let alive = true;
    const impl = serve({
      models: () => { if (alive) return ok({ data: [{ id: "qwen" }] }); throw new Error("connect ECONNREFUSED"); },
      health: ok({ status: "ok" }),
    });
    await withFetch(impl, async () => {
      const ai = manager(root);
      await ai.start();
      assert.equal(ai.status().external, true);
      assert.equal((await ai.refresh()).running, true, "still there, still running");
      alive = false;
      assert.equal(ai.status().running, true, "a snapshot alone does not know");
      const refreshed = await ai.refresh();
      assert.equal(refreshed.external, false);
      assert.match(refreshed.error, /gone; starting the installed one/);
      // refresh() set the engine going; join that start.
      await ai.start();
      assert.equal(spawned.length, before + 1);
      assert.deepEqual([ai.status().running, ai.status().external, ai.status().error], [true, false, ""]);
      await ai.stop();
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an engine that crashes after it was answering is started again, with the reason shown; past three crashes it is left for the player", async () => {
  const root = fixture();
  const before = spawned.length;
  try {
    await withFetch(serve({ health: ok({ status: "ok" }) }), async () => {
      const ai = manager(root, { restartDelaysMs: [5, 5, 5] });
      const errors = [];
      ai.onStatus(() => { if (ai.status().error) errors.push(ai.status().error); });
      await ai.start();
      assert.equal(spawned.length, before + 1);

      const crash = async (code, { join = true } = {}) => {
        const child = spawned.at(-1);
        child.exitCode = code;
        child.emit("exit", code, null);
        // The restart timer, then the start it fires; joined so the engine
        // is up before the next step. A start of the test's own would mask
        // a manager that gave up, so the last crash is only watched.
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (join) await ai.start();
      };
      await crash(139);
      assert.equal(spawned.length, before + 2, "started again");
      assert.equal(ai.status().running, true);
      assert.equal(ai.status().error, "", "a clean restart clears the notice");
      assert.ok(errors.some((text) => /stopped \(exit code 139; see llama-server\.log\)\. Starting it again in 1s/.test(text)), errors.join("\n"));

      await crash(1);
      await crash(1);
      assert.equal(spawned.length, before + 4);
      await crash(1, { join: false });
      await tick();
      assert.equal(spawned.length, before + 4, "the fourth crash in the window is not retried");
      assert.equal(ai.status().running, false);
      assert.match(ai.status().error, /stopped 4 times in ten minutes \(last exit code 1\).*start it again from Story AI/);

      // Story AI's button: the count is forgotten and the engine runs again.
      await ai.restart();
      assert.equal(spawned.length, before + 5);
      assert.deepEqual([ai.status().running, ai.status().error], [true, ""]);
      await ai.stop();
      await tick();
      assert.equal(spawned.length, before + 5, "a stop on purpose is not a crash");
      assert.equal(ai.status().error, "");
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an engine that exits during startup is reported, not restarted in a loop", async () => {
  const root = fixture();
  const before = spawned.length;
  try {
    await withFetch(serve({}), async () => {
      const ai = manager(root, { restartDelaysMs: [5, 5, 5] });
      const started = ai.start();
      await tick();
      const child = spawned.at(-1);
      child.exitCode = 127;
      child.emit("exit", 127, null);
      await assert.rejects(started, /exited during startup/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(spawned.length, before + 1, "no restart for a start that never answered");
      assert.equal(ai.status().running, false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
