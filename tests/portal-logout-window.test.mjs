import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const cookies = new EventEmitter();
const cookieSession = { cookies, setPermissionRequestHandler() {} };

const webRequests = new Map();
const completions = new Map();

class FakeView {
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler() {},
    loadURL: async () => {},
    close() {},
    session: {
      webRequest: {
        onBeforeRequest(filter, handler) {
          const key = filter.urls.join();
          if (handler === null) webRequests.delete(key);
          else webRequests.set(key, handler);
        },
        onCompleted(filter, handler) {
          const key = filter.urls.join();
          if (handler === null) completions.delete(key);
          else completions.set(key, handler);
        },
      },
    },
  });
  setBounds() {}
  setBackgroundColor() {}
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

test("a POST logout inside a game view is refused and opens the manager", () => {
  const remote = "https://remote.example";
  const events = [];
  const win = new ShellWindow();
  win.win = {
    contentView: { addChildView() {}, removeChildView() {} },
    getContentSize: () => [1280, 800],
    webContents: { send: (_channel, event) => events.push(event) },
  };
  win.attachView(remote, "persist:logout-block-test", "/");

  const handler = webRequests.get(`${remote}/api/auth/logout*`);
  assert.ok(handler, "attaching a view registers the logout block");

  let response = null;
  handler({ method: "POST" }, (result) => {
    response = result;
  });
  assert.deepEqual(response, { cancel: true });
  assert.deepEqual(events.at(-1), { kind: "show-manager" });
  assert.equal(win.viewOrigin(), "");
  assert.equal(webRequests.has(`${remote}/api/auth/logout*`), false);

  // A GET (or any other method) on the same path is left alone.
  const other = new ShellWindow();
  other.win = {
    contentView: { addChildView() {}, removeChildView() {} },
    getContentSize: () => [1280, 800],
    webContents: { send() {} },
  };
  other.attachView(remote, "persist:logout-block-test", "/");
  let getResponse = null;
  webRequests.get(`${remote}/api/auth/logout*`)({ method: "GET" }, (result) => {
    getResponse = result;
  });
  assert.deepEqual(getResponse, {});
});

function shellWindow(events = []) {
  const win = new ShellWindow();
  win.win = {
    contentView: { addChildView() {}, removeChildView() {} },
    getContentSize: () => [1280, 800],
    webContents: { send: (_channel, event) => events.push(event) },
  };
  return win;
}

test("a session that died on its own leaves the world for home, with the news and the token forgotten", () => {
  const remote = "https://remote.example";
  const events = [];
  const revoked = [];
  const win = shellWindow(events);
  win.onSessionRevoked((origin) => revoked.push(origin));
  win.attachView(remote, "persist:session-end-test", "/campaigns/abc");
  const answer = completions.get(`${remote}/api/*`);
  assert.ok(answer, "attaching a view watches its API answers");

  // A wrong password at the sign-in routes and a refusal that is not a 401
  // are not the session's end.
  answer({ statusCode: 401, url: `${remote}/api/auth/login` });
  answer({ statusCode: 403, url: `${remote}/api/campaigns/abc` });
  answer({ statusCode: 200, url: `${remote}/api/campaigns/abc` });
  assert.equal(win.viewOrigin(), remote);
  assert.deepEqual(revoked, []);

  answer({ statusCode: 401, url: `${remote}/api/campaigns/abc?since=3` });
  assert.equal(win.viewOrigin(), "");
  assert.deepEqual(revoked, [remote]);
  assert.deepEqual(events.at(-1), { kind: "show-manager", notice: "Your session at this world ended. Sign in again." });
  assert.equal(completions.has(`${remote}/api/*`), false, "the watch goes with the view");
});

test("a portal view's dead session forgets the host's token, not the device world's", () => {
  const local = "http://127.0.0.1:3000";
  const remote = "https://remote.example";
  const revoked = [];
  const win = shellWindow();
  win.onSessionRevoked((origin) => revoked.push(origin));
  win.attachView(local, "persist:session-end-portal", "/", remote);
  completions.get(`${local}/api/*`)({ statusCode: 401, url: `${local}/api/friends` });
  assert.deepEqual(revoked, [remote]);
  assert.equal(win.viewOrigin(), "");
});
