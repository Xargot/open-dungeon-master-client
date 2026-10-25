import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import Module from "node:module";

// The desktop's offer notification (src/main/offer-notices.ts) with
// Electron's Notification stood in for, and the preload's two calls.

const require = createRequire(import.meta.url);
const { createDesktopOfferNotices } = require("../dist/main/offer-notices.js");

const NOTICE = {
  hostId: "server-1",
  campaignId: "camp-1",
  offerId: "offer-1",
  title: "Mira Vell asks to court Kael Ashvale",
  body: "Only you can answer this. Open the table to choose.",
};

function rig({ foreground = false, supported = true } = {}) {
  const made = [];
  const opened = [];
  const state = { foreground };
  const notices = createDesktopOfferNotices({
    supported: () => supported,
    foreground: () => state.foreground,
    open: (target) => opened.push(target),
    icon: "/app/icon.png",
    create(options) {
      const handlers = {};
      const notification = {
        options,
        shown: 0,
        closed: 0,
        on(event, listener) {
          handlers[event] = listener;
        },
        show() {
          this.shown += 1;
        },
        close() {
          this.closed += 1;
          handlers.close?.();
        },
        fire(event) {
          handlers[event]?.();
        },
      };
      made.push(notification);
      return notification;
    },
  });
  return { notices, made, opened, state };
}

test("a backgrounded window shows the offer once, with the card's line as its title", () => {
  const { notices, made } = rig();
  assert.equal(notices.show(NOTICE, true), true);
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].options, { title: NOTICE.title, body: NOTICE.body, icon: "/app/icon.png" });
  assert.equal(made[0].shown, 1);
  assert.equal(notices.show(NOTICE, false), false, "the same offer again");
  assert.equal(made.length, 1);
});

test("a window in front stays quiet only while the card is in view", () => {
  const looking = rig({ foreground: true });
  assert.equal(looking.notices.show(NOTICE, true), false);
  assert.equal(looking.made.length, 0);
  const elsewhere = rig({ foreground: true });
  assert.equal(elsewhere.notices.show(NOTICE, false), true, "another page or tab of the app");
  // Anything but a plain true is not "in view".
  const odd = rig({ foreground: true });
  assert.equal(odd.notices.show(NOTICE, "yes"), true);
});

test("a click opens the table at the card; a settled offer's notification goes away", () => {
  const { notices, made, opened } = rig();
  notices.show(NOTICE, false);
  made[0].fire("click");
  assert.deepEqual(opened, [{ hostId: "server-1", campaignId: "camp-1", offerId: "offer-1" }]);

  const second = rig();
  second.notices.show(NOTICE, false);
  second.notices.clear("offer-1");
  assert.equal(second.made[0].closed, 1);
  second.notices.clear("offer-1");
  assert.equal(second.made[0].closed, 1, "only once");
  second.notices.clear(42);
});

test("no notification daemon, or a notice that is not one, shows nothing", () => {
  const none = rig({ supported: false });
  assert.equal(none.notices.show(NOTICE, false), false);
  assert.equal(none.made.length, 0);
  const { notices, made } = rig();
  assert.equal(notices.show({ ...NOTICE, campaignId: "../../etc" }, false), false);
  assert.equal(notices.show("offer-1", false), false);
  assert.equal(made.length, 0);
  // Anything beyond the notice's own parts never reaches the system.
  assert.equal(notices.show({ ...NOTICE, offerId: "offer-9", icon: "/etc/passwd", silent: true }, false), true);
  assert.deepEqual(made[0].options, { title: NOTICE.title, body: NOTICE.body, icon: "/app/icon.png" });
});

test("the preload hands the notice and the in-view answer to main, and asks main to clear it", async () => {
  const calls = [];
  let exposed = null;
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "electron") {
      return {
        contextBridge: { exposeInMainWorld: (_name, api) => (exposed = api) },
        ipcRenderer: { invoke: async (...args) => (calls.push(args), true), send() {}, on() {} },
      };
    }
    return load.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve("../dist/preload/index.js")];
    require("../dist/preload/index.js");
  } finally {
    Module._load = load;
  }
  assert.equal(await exposed.offerNotice(NOTICE, false), true);
  await exposed.clearOfferNotice("offer-1");
  assert.deepEqual(calls, [
    ["offer:notify", NOTICE, false],
    ["offer:clear", "offer-1"],
  ]);
});
