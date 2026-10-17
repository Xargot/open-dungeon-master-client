import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const nativeRequire = createRequire(import.meta.url);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function setupShutdown() {
  const share = deferred();
  const ai = deferred();
  const local = deferred();
  const app = new EventEmitter();
  let localStops = 0;
  let aiStops = 0;
  let shareStops = 0;
  let completedQuits = 0;
  const timers = [];
  app.requestSingleInstanceLock = () => true;
  app.setPath = () => {};
  app.getPath = () => "C:\\unused-odm-test";
  app.getAppPath = () => "C:\\unused-odm-test";
  app.getVersion = () => "0.17.4";
  app.setAsDefaultProtocolClient = () => {};
  app.whenReady = () => Promise.resolve();
  app.isPackaged = false;
  app.quit = () => {
    let prevented = false;
    app.emit("before-quit", { preventDefault() { prevented = true; } });
    if (!prevented) completedQuits++;
  };

  const dependencies = {
    electron: { app, safeStorage: {}, shell: {} },
    "../shared/deck": { detectDeck: () => ({ gameMode: false, active: false, device: false }) },
    "../shared/deep-link": { joinLinkFromArgv: () => null },
    "./local-ai/manager": { LocalAiManager: class { stop() { aiStops++; return ai.promise; } } },
    "./local-server": { LocalServer: class { stop() { localStops++; return local.promise; } } },
    // A reset the previous run asked for (src/main/reset.ts): none here.
    "./reset": { applyPendingReset: async () => null },
    "./ipc": { registerIpc: () => ({ shutdownShare() { shareStops++; return share.promise; } }) },
    "./servers": { LOCAL_SERVER_ID: "local", ServerStore: class { storyMemory() { return ""; } deckChoice() { return ""; } } },
    "../shared/story-memory": { storyMemorySupported: () => false },
    "./tunnel": { QuickTunnel: class {} },
    "./updater": {
      detectInstallKind: () => "test",
      packageFormatOf: () => "",
      Updater: class { checkOnStartup() {} },
    },
    "./window": { ShellWindow: class {
      create() {}
      onSessionRevoked() {}
      whenPageReady() { return Promise.resolve(); }
    } },
  };
  const source = fs.readFileSync(new URL("../dist/main/index.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    exports: {},
    require: (id) => dependencies[id] ?? nativeRequire(id),
    process: { ...process, argv: [], env: {}, defaultApp: false },
    __dirname: path.dirname(new URL("../dist/main/index.js", import.meta.url).pathname),
    Buffer,
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  await new Promise(setImmediate);
  return {
    app, share, ai, local, timers,
    get shareStops() { return shareStops; },
    get aiStops() { return aiStops; },
    get localStops() { return localStops; },
    get completedQuits() { return completedQuits; },
  };
}

test("healthy quit keeps local server available until share cleanup finishes", async () => {
  const state = await setupShutdown();
  state.app.quit();
  await Promise.resolve();
  assert.equal(state.shareStops, 1);
  assert.equal(state.aiStops, 1);
  assert.equal(state.localStops, 0, "sharing still needs the local server");
  assert.equal(state.completedQuits, 0);

  state.share.resolve();
  await new Promise(setImmediate);
  assert.equal(state.localStops, 1, "local stop starts as soon as sharing is cleaned up");
  assert.equal(state.completedQuits, 0);

  state.ai.resolve();
  state.local.resolve();
  await new Promise(setImmediate);
  assert.equal(state.completedQuits, 1);
  assert.equal(state.timers.length, 1);
  assert.equal(state.timers[0].ms, 3000);
});

test("hung sharing still initiates local stop by one total deadline", async () => {
  const state = await setupShutdown();
  state.app.quit();
  await Promise.resolve();
  assert.equal(state.shareStops, 1);
  assert.equal(state.aiStops, 1);
  assert.equal(state.localStops, 0);
  assert.equal(state.completedQuits, 0);

  state.app.quit();
  state.app.emit("window-all-closed");
  await Promise.resolve();
  assert.equal(state.completedQuits, 0, "a second quit event must wait for the same shutdown");
  assert.equal(state.timers.length, 1);
  assert.equal(state.timers[0].ms, 3000);

  state.timers[0].callback();
  await new Promise(setImmediate);
  assert.equal(state.localStops, 1, "the timeout must initiate local stop despite hung sharing");
  assert.equal(state.completedQuits, 1);
  assert.equal(state.shareStops, 1);
  assert.equal(state.aiStops, 1);
});
