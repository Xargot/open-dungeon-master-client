import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const cookies = new EventEmitter();
const cookieSession = { cookies, setPermissionRequestHandler() {} };

class FakeView {
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler() {},
    loadURL: async () => {},
    close() {},
  });
  setBounds() {}
}

const electron = {
  WebContentsView: FakeView,
  session: { fromPartition: () => cookieSession },
  shell: { openExternal: async () => {} },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electron;
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

test("portal logout revokes the remote session and preserves the local session", () => {
  const local = "http://127.0.0.1:3000";
  const remote = "https://remote.example";
  const tokens = new Map([[local, "local-token"], [remote, "remote-token"]]);
  const win = new ShellWindow();
  win.win = {
    contentView: { addChildView() {}, removeChildView() {} },
    getContentSize: () => [1280, 800],
    webContents: { send() {} },
  };
  win.onSessionRevoked((origin) => tokens.delete(origin));
  win.attachView(local, "persist:portal-test", "/", remote);

  cookies.emit("changed", {}, { name: "odm_portal_token", domain: "127.0.0.1" }, "explicit", true);

  assert.equal(tokens.get(local), "local-token");
  assert.equal(tokens.has(remote), false);
  assert.equal(win.viewOrigin(), "");
  assert.equal(cookies.listenerCount("changed"), 0);
});
