import assert from "node:assert/strict";
import test from "node:test";
import {
  agoLabel,
  buildGroups,
  campaignLine,
  canDeleteFromHome,
  canDuplicateFromHome,
  chapterLine,
  deviceStatusLine,
  enterLabel,
  heroLine,
  pickContinueCampaign,
  pickPrimaryHost,
  recapText,
  reconcileLocal,
  relativeTime,
  romanNumeral,
  rowAction,
  seatLine,
  slotLine,
  slotMeta,
  titleEyebrow,
} from "../dist/shared/home-view-logic.js";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

function campaign(overrides = {}) {
  return {
    id: "c1",
    title: "The Sunless Citadel",
    status: "active",
    playerCount: 4,
    maxPlayers: 5,
    playingAs: "Kaleb",
    coverUrl: null,
    placeholderUrl: null,
    updatedAt: "2026-09-03T12:00:00.000Z",
    role: "player",
    dmMode: "ai",
    ...overrides,
  };
}

function host(overrides = {}) {
  return {
    id: "srv",
    kind: "server",
    name: "play.mytable.net",
    origin: "https://play.mytable.net",
    username: "kaleb",
    status: "online",
    lastSeenAt: "2026-09-04T11:00:00.000Z",
    stale: false,
    error: "",
    campaigns: [],
    ...overrides,
  };
}

const local = (overrides = {}) =>
  host({ id: "local", kind: "local", name: "", origin: "http://127.0.0.1:3210", ...overrides });

const feed = (hosts) => ({ hosts, refreshedAt: "2026-09-04T12:00:00.000Z" });

test("continue picks the freshest active campaign on a reachable host, lobbies after", () => {
  const picked = pickContinueCampaign(
    feed([
      local({
        campaigns: [
          campaign({ id: "lobby", status: "lobby", updatedAt: "2026-09-04T11:59:00.000Z" }),
          campaign({ id: "older", updatedAt: "2026-09-01T00:00:00.000Z" }),
        ],
      }),
      host({ campaigns: [campaign({ id: "fresh", updatedAt: "2026-09-03T00:00:00.000Z" })] }),
      host({
        id: "down",
        status: "offline",
        campaigns: [campaign({ id: "unreachable", updatedAt: "2026-09-04T12:00:00.000Z" })],
      }),
    ]),
  );
  assert.equal(picked.campaign.id, "fresh");
  assert.equal(picked.host.id, "srv");

  // No active table anywhere: the newest lobby wins. Ended ones never do.
  const lobby = pickContinueCampaign(
    feed([
      local({
        status: "starting",
        campaigns: [
          campaign({ id: "done", status: "ended", updatedAt: "2026-09-04T12:00:00.000Z" }),
          campaign({ id: "gathering", status: "lobby" }),
        ],
      }),
    ]),
  );
  assert.equal(lobby.campaign.id, "gathering");
  assert.equal(pickContinueCampaign(feed([host({ status: "needsLogin", campaigns: [campaign()] })])), null);
  assert.equal(pickContinueCampaign(feed([])), null);
});

test("the device world's cached tables are continued while it sleeps, since opening one wakes it", () => {
  const asleep = feed([local({ status: "offline", campaigns: [campaign({ id: "mine" })] })]);
  assert.equal(pickContinueCampaign(asleep), null, "without the shell saying it wakes");
  assert.equal(pickContinueCampaign(asleep, true).campaign.id, "mine");
  // A server that is down is still not continued.
  const down = feed([host({ status: "offline", campaigns: [campaign({ id: "theirs" })] })]);
  assert.equal(pickContinueCampaign(down, true), null);
});

test("the primary host is the hero's, else the device world, else the first online server", () => {
  const hero = { host: host({ id: "hero" }), campaign: campaign() };
  assert.equal(pickPrimaryHost(feed([local()]), hero).id, "hero");
  assert.equal(pickPrimaryHost(feed([host(), local({ status: "offline" })]), null).id, "local");
  assert.equal(
    pickPrimaryHost(feed([local({ status: "unavailable" }), host({ id: "a", status: "offline" }), host({ id: "b" })]), null).id,
    "b",
  );
  assert.equal(pickPrimaryHost(feed([host({ status: "offline" })]), null), null);
});

test("status lines read like the mockup", () => {
  assert.equal(campaignLine(campaign({ playerCount: 5, maxPlayers: 5 })), "Active · 5/5 · playing as Kaleb");
  assert.equal(campaignLine(campaign({ status: "lobby", playerCount: 1, maxPlayers: 6, playingAs: null })), "Lobby · 1/6");
  assert.equal(campaignLine(campaign({ status: "ended" })), "Ended");
  assert.equal(campaignLine(campaign({ maxPlayers: 0, playerCount: 2, playingAs: null })), "Active · 2");
  assert.equal(heroLine(campaign()), "Playing as Kaleb · 4/5 party");
  assert.equal(heroLine(campaign({ status: "lobby", playingAs: null, playerCount: 1, maxPlayers: 6 })), "Lobby · 1/6");
});

test("relative time is coarse and never in the future", () => {
  assert.equal(relativeTime(null, NOW), "");
  assert.equal(relativeTime("garbage", NOW), "");
  assert.equal(relativeTime("2026-09-04T11:59:40.000Z", NOW), "just now");
  assert.equal(relativeTime("2026-09-04T11:35:00.000Z", NOW), "25m ago");
  assert.equal(relativeTime("2026-09-04T09:00:00.000Z", NOW), "3h ago");
  assert.equal(relativeTime("2026-09-02T12:00:00.000Z", NOW), "2d ago");
  assert.equal(relativeTime("2026-09-04T13:00:00.000Z", NOW), "just now");
});

test("rows act by host: open, wake the device, sign in, or nothing", () => {
  assert.equal(rowAction(host()), "open");
  assert.equal(rowAction(host({ status: "starting" })), "open");
  assert.equal(rowAction(local({ status: "offline" })), "start");
  assert.equal(rowAction(local({ status: "unavailable" })), "blocked");
  assert.equal(rowAction(host({ status: "needsLogin" })), "signIn");
  assert.equal(rowAction(host({ status: "offline" })), "blocked");
  assert.equal(rowAction(host({ kind: "tunnel", status: "offline" })), "blocked");
});

test("a slot offers Delete to the owner alone, and only on a host that answers", () => {
  const owned = campaign({ role: "owner" });
  assert.equal(canDeleteFromHome(host(), owned), true);
  assert.equal(canDeleteFromHome(local({ status: "online" }), owned), true);
  assert.equal(canDeleteFromHome(host(), campaign({ role: "player" })), false);
  assert.equal(canDeleteFromHome(host({ stale: true }), owned), false);
  assert.equal(canDeleteFromHome(host({ status: "offline" }), owned), false);
  assert.equal(canDeleteFromHome(host({ status: "needsLogin" }), owned), false);
  assert.equal(canDeleteFromHome(local({ status: "offline" }), owned), false);
  // The device world asleep, when the shell says it wakes: its own kept list.
  assert.equal(canDeleteFromHome(local({ status: "offline", stale: true }), owned, true), true);
  assert.equal(canDeleteFromHome(host({ status: "offline", stale: true }), owned, true), false);
});

test("a slot offers Duplicate to the owner or the DM seat, where new campaigns may start", () => {
  const open = (over = {}) => host({ canCreate: true, ...over });
  assert.equal(canDuplicateFromHome(open(), campaign({ role: "owner" })), true);
  assert.equal(canDuplicateFromHome(open(), campaign({ role: "player", dmSeat: true })), true);
  assert.equal(canDuplicateFromHome(open(), campaign({ role: "player" })), false);
  assert.equal(canDuplicateFromHome(open({ canCreate: false }), campaign({ role: "owner" })), false);
  assert.equal(canDuplicateFromHome(open({ stale: true }), campaign({ role: "owner" })), false);
  assert.equal(canDuplicateFromHome(local({ canCreate: true, status: "offline", stale: true }), campaign({ role: "owner" }), true), true);
});

test("groups follow the feed, sort rows, label status and explain what cannot continue", () => {
  const hosts = feed([
    local({
      status: "offline",
      lastSeenAt: "2026-09-04T09:00:00.000Z",
      campaigns: [
        campaign({ id: "ended", status: "ended", updatedAt: "2026-09-04T11:00:00.000Z" }),
        campaign({ id: "lobby", status: "lobby" }),
        campaign({ id: "active" }),
      ],
    }),
    host({ campaigns: [campaign({ id: "vault", title: "Emerald Vault", playerCount: 5, maxPlayers: 5 })] }),
    host({
      id: "dave",
      kind: "tunnel",
      name: "Dave's table",
      status: "offline",
      stale: true,
      lastSeenAt: "2026-09-04T09:00:00.000Z",
      campaigns: [campaign({ id: "frost", title: "Frostspire Saga" })],
    }),
    host({ id: "locked", status: "needsLogin", lastSeenAt: null, campaigns: [campaign({ id: "l" })] }),
    local({ id: "none", status: "unavailable" }),
  ]);
  const groups = buildGroups(hosts, { hideOffline: false, deviceName: "This device", now: NOW });
  assert.deepEqual(
    groups.map((group) => [group.label, group.statusLabel, group.lastSeen]),
    [
      ["This device", "offline", "last seen 3h ago"],
      ["play.mytable.net", "online", ""],
      ["Dave's table", "offline", "last seen 3h ago"],
      ["play.mytable.net", "sign in", ""],
    ],
  );
  // Active, then lobby, then ended; the device world's rows wake it.
  assert.deepEqual(
    groups[0].rows.map((row) => [row.campaign.id, row.action]),
    [["active", "start"], ["lobby", "start"], ["ended", "start"]],
  );
  assert.deepEqual(groups[1].rows.map((row) => row.line), ["Active · 5/5 · playing as Kaleb"]);
  assert.equal(groups[2].rows[0].action, "blocked");
  assert.equal(groups[2].rows[0].reason, "Hosted on another player's app");
  assert.equal(groups[3].rows[0].action, "signIn");

  const offlineServer = buildGroups(
    feed([host({ status: "offline", campaigns: [campaign()] })]),
    { hideOffline: false, deviceName: "This device", now: NOW },
  );
  assert.equal(offlineServer[0].rows[0].reason, "Server unreachable");

  // Hide offline keeps the device world and the host that only needs a sign-in.
  const hidden = buildGroups(hosts, { hideOffline: true, deviceName: "This device", now: NOW });
  assert.deepEqual(hidden.map((group) => group.host.id), ["local", "srv", "locked"]);
});

test("the device world's live state overrides what the cached feed remembers", () => {
  const cached = feed([local({ status: "online", username: "old" }), host()]);
  const base = { origin: "", firstRun: false, hasAccount: true, username: "kaleb", serverVersion: "", error: "", lanOrigin: "" };
  assert.equal(reconcileLocal(cached, { ...base, state: "stopped" }).hosts[0].status, "offline");
  assert.equal(reconcileLocal(cached, { ...base, state: "starting" }).hosts[0].status, "starting");
  assert.equal(reconcileLocal(cached, { ...base, state: "running" }).hosts[0].status, "online");
  assert.equal(reconcileLocal(cached, { ...base, state: "running" }).hosts[0].username, "kaleb");
  assert.equal(reconcileLocal(cached, { ...base, state: "unavailable" }).hosts[0].status, "unavailable");
  assert.equal(reconcileLocal(cached, { ...base, state: "error" }).hosts[1].status, "online");
});

// ---------- the title screen's words, the server's own ----------

test("agoLabel is coarse and reads like the website", () => {
  const now = NOW;
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(agoLabel(at(30_000), now), "just now");
  assert.equal(agoLabel(at(5 * 60_000), now), "5 minutes ago");
  assert.equal(agoLabel(at(60 * 60_000), now), "an hour ago");
  assert.equal(agoLabel(at(3 * 3_600_000), now), "3 hours ago");
  assert.equal(agoLabel(at(24 * 3_600_000), now), "yesterday");
  assert.equal(agoLabel(at(3 * 86_400_000), now), "3 days ago");
  assert.equal(agoLabel(at(7 * 86_400_000), now), "a week ago");
  assert.equal(agoLabel(at(35 * 86_400_000), now), "a month ago");
  assert.equal(agoLabel(at(70 * 86_400_000), now), "2 months ago");
  assert.equal(agoLabel(at(400 * 86_400_000), now), "a year ago");
  assert.equal(agoLabel(null, now), "");
  assert.equal(agoLabel("garbage", now), "");
});

test("roman numerals for chapter headings", () => {
  assert.equal(romanNumeral(1), "I");
  assert.equal(romanNumeral(4), "IV");
  assert.equal(romanNumeral(9), "IX");
  assert.equal(romanNumeral(14), "XIV");
  assert.equal(romanNumeral(0), "0");
  assert.equal(romanNumeral(4000), "4000");
});

test("the title block's words follow the table's state", () => {
  assert.equal(titleEyebrow(campaign()), "Continue your tale");
  assert.equal(titleEyebrow(campaign({ status: "lobby" })), "The table is set");
  assert.equal(titleEyebrow(campaign({ status: "ended" })), "A finished tale");
  assert.equal(enterLabel(campaign()), "Enter the world");
  assert.equal(enterLabel(campaign({ status: "lobby" })), "Take your seat");
  assert.equal(enterLabel(campaign({ status: "ended" })), "Revisit the world");
});

test("the chapter line prefers the chapter, then the scene, then the description", () => {
  const glance = (chapter) => ({ chapter, recap: "", recapAt: null, sceneImage: null, faces: [] });
  assert.equal(chapterLine(campaign({ glance: glance({ index: 3, title: "The Drowned Lantern" }) })), "Chapter III · The Drowned Lantern");
  assert.equal(chapterLine(campaign({ scene: "The gatehouse", glance: glance({ index: 1, title: " " }) })), "Chapter I · The gatehouse");
  assert.equal(chapterLine(campaign({ glance: glance({ index: 2, title: "" }) })), "Chapter II");
  // Hosts that announce acts: the act leads, and an unnamed chapter borrows the act's name.
  assert.equal(chapterLine(campaign({ glance: glance({ index: 3, title: "The Drowned Lantern", act: 2, actTitle: "The Drowned Hymn" }) })), "Act II, Chapter III · The Drowned Lantern");
  assert.equal(chapterLine(campaign({ scene: "The nave", glance: glance({ index: 3, title: "", act: 2, actTitle: "The Drowned Hymn" }) })), "Act II, Chapter III · The Drowned Hymn");
  assert.equal(chapterLine(campaign({ glance: glance({ index: 3, title: "", act: 2, actTitle: "" }) })), "Act II, Chapter III");
  assert.equal(chapterLine(campaign({ scene: "A cold road" })), "A cold road");
  assert.equal(chapterLine(campaign({ description: "  Ash falls.  " })), "Ash falls.");
  assert.equal(chapterLine(campaign()), "");
});

test("the seat line says who you are there and how full the table is", () => {
  assert.equal(seatLine(campaign()), "Playing as Kaleb · 4 of 5 seats");
  assert.equal(seatLine(campaign({ playingAs: null, dmSeat: true })), "Running the table · 4 of 5 seats");
  assert.equal(seatLine(campaign({ playingAs: null })), "No character yet · 4 of 5 seats");
  assert.equal(seatLine(campaign({ playingAs: null, maxPlayers: 1, playerCount: 1 })), "No character yet · solo");
  assert.equal(seatLine(campaign({ status: "lobby", playerCount: 2 })), "Lobby · 2 of 5 ready");
});

test("the save slot's line and small print", () => {
  const now = NOW;
  const twoDays = new Date(now - 2 * 86_400_000).toISOString();
  assert.equal(slotLine(campaign({ status: "lobby", playerCount: 2 }), now), "2 of 5 ready");
  assert.equal(slotLine(campaign({ status: "ended", updatedAt: twoDays }), now), "Finished 2 days ago");
  assert.equal(slotLine(campaign({ status: "ended", updatedAt: "" }), now), "Finished");
  assert.equal(slotLine(campaign({ dmSeat: true }), now), "Running the table");
  assert.equal(slotLine(campaign({ updatedAt: twoDays }), now), "Last played 2 days ago");
  assert.equal(slotLine(campaign({ updatedAt: "", glance: { chapter: null, recap: "", recapAt: null, sceneImage: null, faces: [] } }), now), "In play");
  assert.equal(slotMeta(campaign({ startingLevel: 3, difficulty: "hard" })), "Level 3 start · hard");
  assert.equal(slotMeta(campaign({ startingLevel: 1, difficulty: "normal", maxPlayers: 1 })), "Level 1 start · normal · solo");
  assert.equal(slotMeta(campaign()), "");
});

test("the recap panel shows the DM's last words or the quiet line for the table's state", () => {
  const glance = { chapter: null, recap: "  The tide pulled back. ", recapAt: null, sceneImage: null, faces: [] };
  assert.deepEqual(recapText(campaign({ glance })), { text: "The tide pulled back.", quiet: false });
  assert.equal(recapText(campaign()).quiet, true);
  assert.match(recapText(campaign({ status: "lobby" })).text, /seats are filling/);
  assert.match(recapText(campaign({ status: "ended" })).text, /told to its end/);
  assert.match(recapText(campaign()).text, /has not spoken yet/);
});

test("the status line lights its lamp for the device world and names the build", () => {
  const base = { origin: "", firstRun: false, hasAccount: true, username: "k", serverVersion: "0.23.5", error: "", lanOrigin: "" };
  assert.deepEqual(deviceStatusLine({ ...base, state: "running" }, "0.15.0"), { tone: "awake", text: "Your world is awake · server 0.23.5 · v0.15.0" });
  assert.deepEqual(deviceStatusLine({ ...base, state: "starting" }, ""), { tone: "wait", text: "Waking your world" });
  assert.deepEqual(deviceStatusLine({ ...base, state: "error" }, "1.0.0"), { tone: "dozing", text: "Your world could not start · v1.0.0" });
  assert.deepEqual(deviceStatusLine({ ...base, state: "stopped" }, "1.0.0"), { tone: "off", text: "Your world is asleep · v1.0.0" });
  assert.deepEqual(deviceStatusLine({ ...base, state: "stopped", firstRun: true }, ""), { tone: "off", text: "Your world has not begun" });
  assert.deepEqual(deviceStatusLine({ ...base, state: "unavailable" }, "1.0.0"), { tone: "off", text: "No world on this device · play on a server · v1.0.0" });
});
