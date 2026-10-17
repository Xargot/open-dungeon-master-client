import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const cookies = new EventEmitter();
const cookieSession = { cookies, setPermissionRequestHandler() {} };
const views = [];
let load = async () => {};

class FakeView {
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler() {},
    loadURL: (url) => load(url),
    close() {},
  });
  constructor() { views.push(this); }
  setBounds() {}
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return {
      WebContentsView: FakeView,
      session: { fromPartition: () => cookieSession },
      shell: { openExternal: async () => {} },
    };
  }
  if (parent?.filename.endsWith("window.js") && request === "./app-icon") return { appIconPath: () => "" };
  if (parent?.filename.endsWith("window.js") && request === "./bluetooth") {
    return { autoConfirmBluetoothPairing() {}, wireBluetoothChooser() {} };
  }
  if (parent?.filename.endsWith("window.js") && request === "./session-cookies") {
    return { isShellCookieWrite: () => false };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let ShellWindow;
try {
  ({ ShellWindow } = require("../dist/main/window.js"));
} finally {
  Module._load = originalLoad;
}

function loginWindow() {
  const win = new ShellWindow();
  win.win = {
    contentView: { addChildView() {}, removeChildView() {} },
    getContentSize: () => [1280, 800],
    webContents: { send() {} },
  };
  return win;
}

function assertClean(win, view) {
  assert.equal(win.viewOrigin(), "");
  assert.equal(cookies.listenerCount("changed"), 0);
  assert.equal(view.webContents.listenerCount("did-navigate"), 0);
  assert.equal(view.webContents.listenerCount("did-fail-load"), 0);
}

test("a rejected Discord start load rejects sign-in and removes the temporary view", async () => {
  load = async () => { throw new Error("ERR_CONNECTION_REFUSED"); };
  const win = loginWindow();
  const login = win.browserLogin("https://remote.example", "persist:discord-test", "/auth/discord");
  const view = views.at(-1);
  await assert.rejects(login, /connection|load|refused/i);
  assertClean(win, view);
});

test("a main-frame navigation failure rejects sign-in and cleans up", async () => {
  load = async () => {};
  const win = loginWindow();
  const login = win.browserLogin("https://remote.example", "persist:discord-test", "/auth/discord");
  const view = views.at(-1);
  view.webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://remote.example/auth/discord", false);
  view.webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://remote.example/auth/discord", true);
  await assert.rejects(login, /name|connection|load/i);
  assertClean(win, view);
});

test("redirect abort does not reject sign-in before the session cookie arrives", async () => {
  load = async () => {};
  const win = loginWindow();
  const login = win.browserLogin("https://remote.example", "persist:discord-test", "/auth/discord");
  const view = views.at(-1);
  view.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://discord.com/oauth2/authorize", true);
  cookies.emit("changed", {}, { name: "odm_session", domain: "remote.example", value: "token" }, "explicit", false);
  assert.deepEqual(await login, { token: "token", expiresAt: "" });
  assertClean(win, view);
});
