import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignPlaceholderPath,
  classifyOutcome,
  coverRequestUrl,
  createHomeFeed,
  cacheEntryFor,
  hostFromCache,
  hostKindFor,
  imageDataUrl,
  isTunnelOrigin,
  localOutcome,
  orderHosts,
  parseCampaigns,
  parseCanCreate,
  parseOffersStory,
  resolveHost, tableLookupOrigins } from "../dist/shared/home-feed-logic.js";

const origin = "https://play.example";

function host(overrides = {}) {
  return {
    id: "srv",
    kind: "server",
    name: "Play",
    origin,
    username: "kaleb",
    lastUsedAt: "2026-09-01T00:00:00.000Z",
    token: "tok",
    ...overrides,
  };
}

// The server's FNV-1a pick, so the test states the expected plate rather
// than trusting the function under test to name it.
function fnv(value) {
  let acc = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    acc ^= value.charCodeAt(index);
    acc = Math.imul(acc, 16777619);
  }
  return acc >>> 0;
}

test("campaignPlaceholderPath matches the server's rule: genre slug, three variants, custom fallback", () => {
  assert.equal(campaignPlaceholderPath("Dark Fantasy", "c1"), `/assets/placeholders/campaign/dark-fantasy-${1 + (fnv("c1") % 3)}.webp`);
  assert.equal(campaignPlaceholderPath("high_fantasy", "x"), `/assets/placeholders/campaign/high-fantasy-${1 + (fnv("x") % 3)}.webp`);
  assert.equal(campaignPlaceholderPath("space opera", "y"), `/assets/placeholders/campaign/custom-${1 + (fnv("y") % 3)}.webp`);
  assert.equal(campaignPlaceholderPath("", ""), `/assets/placeholders/campaign/custom-${1 + (fnv("custom") % 3)}.webp`);
});

const rawCampaign = {
  id: "c1",
  title: "The Sunken Keep",
  status: "active",
  playerCount: 3,
  maxPlayers: 5,
  updatedAt: "2026-09-03T12:00:00.000Z",
  role: "owner",
  gameSettings: { dmMode: "assisted", genre: "Dark Fantasy" },
  cover: { url: "/uploads/keep.png" },
  playingAs: "Ser Vell",
};

function campaign(overrides = {}) {
  return {
    id: "c1",
    title: "The Sunken Keep",
    status: "active",
    playerCount: 3,
    maxPlayers: 5,
    playingAs: "Ser Vell",
    coverUrl: `${origin}/uploads/keep.png`,
    placeholderUrl: `${origin}${campaignPlaceholderPath("Dark Fantasy", "c1")}`,
    updatedAt: "2026-09-03T12:00:00.000Z",
    role: "owner",
    dmMode: "assisted",
    // The genre rides along for the title screen's plates and words.
    genre: "Dark Fantasy",
    ...overrides,
  };
}

test("tunnel hosts are the play-CODE and trycloudflare addresses", () => {
  assert.equal(isTunnelOrigin("https://play-abcd1234.opendungeonmaster.com"), true);
  assert.equal(isTunnelOrigin("https://PLAY-ABCD1234.opendungeonmaster.com"), true);
  assert.equal(isTunnelOrigin("https://quiet-owl-42.trycloudflare.com"), true);
  assert.equal(isTunnelOrigin("https://dungeon.example.org"), false);
  assert.equal(isTunnelOrigin("http://192.168.1.50:3005"), false);
  assert.equal(isTunnelOrigin("https://play-abcd.opendungeonmaster.com.evil.example"), false);
  assert.equal(isTunnelOrigin("not a url"), false);
  assert.equal(hostKindFor("https://play-abcd1234.opendungeonmaster.com"), "tunnel");
  assert.equal(hostKindFor("https://dungeon.example.org"), "server");
});

test("a campaign list is parsed, covers pinned to the host, new fields optional", () => {
  const parsed = parseCampaigns({ campaigns: [rawCampaign] }, origin);
  assert.deepEqual(parsed, [campaign()]);
  const bare = parseCampaigns(
    { campaigns: [{ id: "c2", title: "Bare", status: "lobby", role: "player" }] },
    origin,
  );
  const expectedBare = campaign({
    id: "c2",
    title: "Bare",
    status: "lobby",
    playerCount: 0,
    maxPlayers: 0,
    playingAs: null,
    coverUrl: null,
    placeholderUrl: `${origin}/assets/placeholders/campaign/custom-${1 + (fnv("c2") % 3)}.webp`,
    updatedAt: "",
    role: "player",
    dmMode: "ai",
  });
  delete expectedBare.genre;
  assert.deepEqual(bare, [expectedBare]);
  // Absolute covers pass through; entries without an id are dropped.
  const mixed = parseCampaigns(
    { campaigns: [{ ...rawCampaign, cover: { url: "https://cdn.example/x.png" } }, { title: "no id" }, null] },
    origin,
  );
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].coverUrl, "https://cdn.example/x.png");
  // Not a list at all: null, so the caller knows to fall back to its cache.
  assert.equal(parseCampaigns({ error: "nope" }, origin), null);
  assert.equal(parseCampaigns(null, origin), null);
});

test("the title screen's glance rides the list: pictures pinned to the host, the DM seat read off an owned row", () => {
  const me = "user-1";
  const list = {
    campaigns: [
      {
        ...rawCampaign,
        ownerUserId: me,
        dmUserId: me,
        description: "A keep under the waves.",
        scene: "The gatehouse",
        startingLevel: 3,
        difficulty: "hard",
        glance: {
          chapter: { index: 2, title: "The Drowned Stair" },
          recap: "The tide pulled back.",
          recapAt: "2026-09-03T11:00:00.000Z",
          sceneImage: "/generated/scene.webp",
          faces: [{ name: "Ser Vell", url: "/uploads/vell.png" }, { name: "Mara", url: "/assets/placeholders/character/elf.webp" }, { url: 5 }],
        },
      },
      { id: "c3", title: "Theirs", status: "active", role: "player", ownerUserId: "someone", dmUserId: "someone", assistantDmUserId: me },
      { id: "c4", title: "Bare glance", status: "lobby", role: "player", ownerUserId: "someone", glance: { chapter: { index: 0 }, faces: "no" } },
    ],
  };
  const parsed = parseCampaigns(list, origin);
  assert.equal(parsed[0].dmSeat, true);
  assert.equal(parsed[0].description, "A keep under the waves.");
  assert.equal(parsed[0].scene, "The gatehouse");
  assert.equal(parsed[0].startingLevel, 3);
  assert.equal(parsed[0].difficulty, "hard");
  assert.deepEqual(parsed[0].glance, {
    // A host from before acts were announced sends no act: the line stays a chapter.
    chapter: { index: 2, title: "The Drowned Stair", act: null, actTitle: "" },
    recap: "The tide pulled back.",
    recapAt: "2026-09-03T11:00:00.000Z",
    sceneImage: `${origin}/generated/scene.webp`,
    faces: [
      { name: "Ser Vell", url: `${origin}/uploads/vell.png` },
      { name: "Mara", url: `${origin}/assets/placeholders/character/elf.webp` },
    ],
  });
  // The assistant DM seat counts; a plain player does not hold it.
  assert.equal(parsed[1].dmSeat, true);
  assert.equal(parsed[2].dmSeat, false);
  // A glance with nothing in it still has its shape.
  assert.deepEqual(parsed[2].glance, { chapter: null, recap: "", recapAt: null, sceneImage: null, faces: [] });
  // A host that announces acts (server 0.23.7 and up) names the act the chapter is in.
  const withAct = parseCampaigns(
    { campaigns: [{ id: "c5", title: "Acts", status: "active", role: "player", ownerUserId: "someone", glance: { chapter: { index: 3, title: "", act: 2, actTitle: "The Drowned Hymn" } } }] },
    origin,
  );
  assert.deepEqual(withAct[0].glance.chapter, { index: 3, title: "", act: 2, actTitle: "The Drowned Hymn" });
  // No owned row: the seat is unknown and left out rather than guessed.
  const guest = parseCampaigns({ campaigns: [{ id: "g", title: "Guest", status: "active", role: "player", dmUserId: "x" }] }, origin);
  assert.equal("dmSeat" in guest[0], false);
});

test("the campaign list says whether the account may start one; a server that does not say is open", () => {
  assert.equal(parseCanCreate({ campaigns: [], canCreateCampaigns: false }), false);
  assert.equal(parseCanCreate({ campaigns: [], canCreateCampaigns: true }), true);
  assert.equal(parseCanCreate({ campaigns: [] }), true);
  assert.equal(parseCanCreate(null), true);
  const input = { id: "s1", kind: "server", name: "Shared", origin, username: "guest", token: "t" };
  const kept = resolveHost(
    input,
    { kind: "reply", status: 200, body: { campaigns: [], canCreateCampaigns: false } },
    null,
    "2026-10-08T12:00:00.000Z",
  );
  assert.equal(kept.canCreate, false);
  // The cache remembers the answer; a host out of reach keeps it, and a
  // cache from before the policy existed reads as open.
  const entry = cacheEntryFor(kept);
  assert.equal(entry.canCreate, false);
  assert.equal(resolveHost(input, { kind: "failed", error: "down" }, entry, "2026-10-08T12:01:00.000Z").canCreate, false);
  assert.equal(hostFromCache(input, entry).canCreate, false);
  assert.equal(hostFromCache(input, { status: "online", campaigns: [], lastSeenAt: null }).canCreate, true);
});

test("the campaign list says whether the server has an AI storyteller; one that does not say has one", () => {
  // Quick start is AI-run, so the home offers it only where a storyteller is.
  assert.equal(parseOffersStory({ campaigns: [], offersStory: false }), false);
  assert.equal(parseOffersStory({ campaigns: [], offersStory: true }), true);
  assert.equal(parseOffersStory({ campaigns: [] }), true);
  assert.equal(parseOffersStory(null), true);
  const input = { id: "s1", kind: "server", name: "Shared", origin, username: "guest", token: "t" };
  const human = resolveHost(
    input,
    { kind: "reply", status: 200, body: { campaigns: [], offersStory: false } },
    null,
    "2026-10-16T12:00:00.000Z",
  );
  assert.equal(human.offersStory, false);
  const entry = cacheEntryFor(human);
  assert.equal(resolveHost(input, { kind: "failed", error: "down" }, entry, "2026-10-16T12:01:00.000Z").offersStory, false);
  assert.equal(hostFromCache(input, { status: "online", campaigns: [], lastSeenAt: null }).offersStory, true);
});

test("responses classify: 401/403 need login, failures are offline, 2xx is online", () => {
  assert.equal(classifyOutcome({ kind: "reply", status: 401, body: null }, origin).status, "needsLogin");
  assert.equal(classifyOutcome({ kind: "reply", status: 403, body: null }, origin).status, "needsLogin");
  const failed = classifyOutcome({ kind: "failed", error: "Could not reach it." }, origin);
  assert.equal(failed.status, "offline");
  assert.equal(failed.error, "Could not reach it.");
  const broken = classifyOutcome({ kind: "reply", status: 500, body: null }, origin);
  assert.equal(broken.status, "offline");
  assert.match(broken.error, /answered 500/);
  const odd = classifyOutcome({ kind: "reply", status: 200, body: { hello: 1 } }, origin);
  assert.equal(odd.status, "offline");
  const online = classifyOutcome(
    { kind: "reply", status: 200, body: { campaigns: [rawCampaign] } },
    origin,
  );
  assert.equal(online.status, "online");
  assert.equal(online.campaigns.length, 1);
  const skipped = classifyOutcome({ kind: "skipped", status: "starting", error: "" }, origin);
  assert.equal(skipped.status, "starting");
});

test("the local world's process state maps to a host status without a request", () => {
  const base = { origin: "", firstRun: false, hasAccount: true, username: "k", serverVersion: "", error: "", lanOrigin: "" };
  assert.equal(localOutcome({ ...base, state: "running" }), null);
  assert.equal(localOutcome({ ...base, state: "starting" }).status, "starting");
  assert.equal(localOutcome({ ...base, state: "stopped" }).status, "offline");
  assert.equal(localOutcome({ ...base, state: "unavailable" }).status, "unavailable");
  const crashed = localOutcome({ ...base, state: "error", error: "It died." });
  assert.equal(crashed.status, "offline");
  assert.equal(crashed.error, "It died.");
});

test("a fresh answer replaces the cache; an unreachable host keeps it, marked stale", () => {
  const now = "2026-09-04T10:00:00.000Z";
  const cached = {
    status: "online",
    campaigns: [campaign({ id: "old", title: "Old" })],
    lastSeenAt: "2026-09-03T00:00:00.000Z",
  };
  const fresh = resolveHost(
    host(),
    { kind: "reply", status: 200, body: { campaigns: [rawCampaign] } },
    cached,
    now,
  );
  assert.equal(fresh.status, "online");
  assert.equal(fresh.stale, false);
  assert.equal(fresh.lastSeenAt, now);
  assert.deepEqual(fresh.campaigns, [campaign()]);

  const down = resolveHost(host(), { kind: "failed", error: "gone" }, cached, now);
  assert.equal(down.status, "offline");
  assert.equal(down.stale, true);
  assert.equal(down.lastSeenAt, "2026-09-03T00:00:00.000Z");
  assert.deepEqual(down.campaigns, cached.campaigns);
  assert.equal(down.error, "gone");

  // Login needed still shows what the player had there.
  const locked = resolveHost(host(), { kind: "reply", status: 401, body: null }, cached, now);
  assert.equal(locked.status, "needsLogin");
  assert.deepEqual(locked.campaigns, cached.campaigns);

  // Nothing cached and nothing fresh: stale and empty, never invented.
  const empty = resolveHost(host(), { kind: "failed", error: "gone" }, null, now);
  assert.equal(empty.stale, true);
  assert.deepEqual(empty.campaigns, []);
  assert.equal(empty.lastSeenAt, null);
});

test("the cached view reports the remembered status unless the caller knows better", () => {
  const cached = { status: "online", campaigns: [campaign()], lastSeenAt: "2026-09-03T00:00:00.000Z" };
  assert.equal(hostFromCache(host(), cached).status, "online");
  assert.equal(hostFromCache(host(), cached).stale, true);
  assert.equal(hostFromCache(host(), cached, "starting").status, "starting");
  assert.equal(hostFromCache(host({ token: "" }), null).status, "needsLogin");
  assert.equal(hostFromCache(host(), null).status, "offline");
});

test("hosts order local first, then most recently used", () => {
  const ordered = orderHosts([
    host({ id: "b", lastUsedAt: "2026-09-02T00:00:00.000Z" }),
    host({ id: "local", kind: "local", lastUsedAt: "" }),
    host({ id: "a", lastUsedAt: "2026-09-03T00:00:00.000Z" }),
    host({ id: "t", kind: "tunnel", lastUsedAt: "2026-09-01T00:00:00.000Z" }),
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.id),
    ["local", "a", "b", "t"],
  );
});

function harness(overrides = {}) {
  const events = [];
  let cache = overrides.cache ?? {};
  const asked = [];
  const local = {
    state: "running",
    origin: "http://127.0.0.1:3210",
    firstRun: false,
    hasAccount: true,
    username: "kaleb",
    serverVersion: "1",
    error: "",
    lanOrigin: "",
    ...overrides.local,
  };
  const replies = overrides.replies ?? {};
  const feed = createHomeFeed({
    hosts: async () => overrides.hosts ?? [],
    localStatus: async () => local,
    fetchCampaigns: async (origin, token) => {
      asked.push(`${origin}|${token}`);
      const reply = replies[origin];
      return reply ?? { kind: "failed", error: `Could not reach ${origin}.` };
    },
    loadCache: async () => cache,
    saveCache: async (next) => {
      cache = next;
    },
    emit: (event) => events.push(event),
    now: () => "2026-09-04T10:00:00.000Z",
    ...(overrides.relocate ? { relocate: overrides.relocate } : {}),
  });
  return { feed, events, asked, cache: () => cache, local };
}

test("a refresh asks every host with a token, caches, and announces the feed", async () => {
  const h = harness({
    hosts: [
      host({ id: "local", kind: "local", origin: "http://127.0.0.1:3210", token: "ltok" }),
      host({ id: "srv" }),
      host({ id: "dead", origin: "https://dead.example", token: "" }),
    ],
    replies: {
      "http://127.0.0.1:3210": { kind: "reply", status: 200, body: { campaigns: [rawCampaign] } },
      [origin]: { kind: "reply", status: 401, body: null },
    },
  });
  const feed = await h.feed.refresh();
  assert.equal(feed.refreshedAt, "2026-09-04T10:00:00.000Z");
  assert.deepEqual(
    feed.hosts.map((entry) => [entry.id, entry.status, entry.stale]),
    [
      ["local", "online", false],
      ["srv", "needsLogin", true],
      ["dead", "needsLogin", true],
    ],
  );
  // No token means no request at all.
  assert.deepEqual(h.asked.sort(), ["http://127.0.0.1:3210|ltok", `${origin}|tok`]);
  assert.equal(h.cache().local.campaigns.length, 1);
  assert.equal(h.cache().local.lastSeenAt, "2026-09-04T10:00:00.000Z");
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].kind, "home-feed");
  assert.deepEqual(h.events[0].feed, feed);
  // The cached view is now the last refresh.
  assert.deepEqual(await h.feed.cached(), feed);
});

test("a stopped local world is offline yet still lists its cached campaigns", async () => {
  const h = harness({
    hosts: [host({ id: "local", kind: "local", origin: "", token: "ltok" })],
    local: { state: "stopped", origin: "" },
    cache: {
      local: { status: "online", campaigns: [campaign()], lastSeenAt: "2026-09-03T00:00:00.000Z" },
    },
  });
  const before = await h.feed.cached();
  assert.equal(before.refreshedAt, "");
  assert.equal(before.hosts[0].status, "offline");
  assert.equal(before.hosts[0].campaigns.length, 1);
  const feed = await h.feed.refresh();
  assert.equal(feed.hosts[0].status, "offline");
  assert.equal(feed.hosts[0].stale, true);
  assert.deepEqual(feed.hosts[0].campaigns, [campaign()]);
  assert.deepEqual(h.asked, []);
  h.local.state = "starting";
  assert.equal((await h.feed.refresh()).hosts[0].status, "starting");
  h.local.state = "unavailable";
  assert.equal((await h.feed.refresh()).hosts[0].status, "unavailable");
});

test("a refresh requested mid-flight runs once more afterwards", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const events = [];
  let asked = 0;
  const feed = createHomeFeed({
    hosts: async () => [host()],
    localStatus: async () => ({ state: "stopped", origin: "", firstRun: false, hasAccount: false, username: "", serverVersion: "", error: "", lanOrigin: "" }),
    fetchCampaigns: async () => {
      asked += 1;
      if (asked === 1) await gate;
      return { kind: "reply", status: 200, body: { campaigns: [] } };
    },
    loadCache: async () => ({}),
    saveCache: async () => undefined,
    emit: (event) => events.push(event),
    now: () => "now",
  });
  const first = feed.refresh();
  const second = feed.refresh();
  assert.equal(first, second);
  release();
  await first;
  // Let the queued refresh run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(asked, 2);
  assert.equal(events.length, 2);
});

test("a cover is only requested from its own host, under /uploads", () => {
  const host = "https://dungeon.example";
  assert.equal(coverRequestUrl(host, `${host}/uploads/keep.png`), `${host}/uploads/keep.png`);
  // Another host, another path, or no host at all: the token stays home.
  assert.equal(coverRequestUrl(host, "https://evil.example/uploads/keep.png"), null);
  assert.equal(coverRequestUrl(host, `${host}/api/admin/settings`), null);
  assert.equal(coverRequestUrl(host, `${host}/uploadsx/keep.png`), null);
  // The painted scenes live under /generated, behind the same login.
  assert.equal(coverRequestUrl(host, `${host}/generated/scene.webp`), `${host}/generated/scene.webp`);
  assert.equal(coverRequestUrl(host, `${host}/generatedx/scene.webp`), null);
  assert.equal(coverRequestUrl("", `${host}/uploads/keep.png`), null);
  assert.equal(coverRequestUrl(host, "/uploads/keep.png"), null);
  assert.equal(coverRequestUrl(host, ""), null);
});

test("only image bodies become data URLs", () => {
  assert.equal(imageDataUrl("image/png", "AAAA"), "data:image/png;base64,AAAA");
  assert.equal(imageDataUrl("Image/JPEG; charset=binary", "AAAA"), "data:image/jpeg;base64,AAAA");
  assert.equal(imageDataUrl("text/html", "AAAA"), null);
  assert.equal(imageDataUrl("", "AAAA"), null);
  assert.equal(imageDataUrl("image/png", ""), null);
});

// A world one of the apps hosts answers at a new address every time its host
// shares it again. A host drawn offline is not tappable, so the feed has to
// find it rather than leave the player with nothing to press.
test("a host that has gone quiet is looked for at its new address", async () => {
  const moved = "https://play-newcode.example";
  const asked_ = [];
  const h = harness({
    hosts: [host({ id: "srv", origin: "https://play-oldcode.example" })],
    replies: {
      [moved]: { kind: "reply", status: 200, body: { campaigns: [rawCampaign] } },
    },
    relocate: async (input) => {
      asked_.push(input.id);
      return moved;
    },
  });
  const feed = await h.feed.refresh();
  const srv = feed.hosts.find((entry) => entry.id === "srv");
  assert.equal(srv.status, "online", "the world is reachable again");
  assert.equal(srv.origin, moved, "and the tile points at where it actually is");
  assert.equal(srv.campaigns.length, 1);
  assert.deepEqual(asked_, ["srv"]);
  // The dead address was tried first, then the one it moved to.
  assert.deepEqual(h.asked, [
    "https://play-oldcode.example|tok",
    `${moved}|tok`,
  ]);
});

test("a host that answers is never looked for, and one that cannot be found stays offline", async () => {
  const calls = [];
  const answering = harness({
    hosts: [host({ id: "srv" })],
    replies: { [origin]: { kind: "reply", status: 200, body: { campaigns: [] } } },
    relocate: async () => {
      calls.push("asked");
      return "https://somewhere.example";
    },
  });
  await answering.feed.refresh();
  assert.deepEqual(calls, [], "no registry traffic for a host that is simply up");

  const lost = harness({
    hosts: [host({ id: "srv" })],
    relocate: async () => "",
  });
  const feed = await lost.feed.refresh();
  assert.equal(feed.hosts[0].status, "offline");
  assert.equal(feed.hosts[0].origin, origin, "the address on file is kept");
});

// A dead tunnel hostname keeps answering for a while, with the edge's own
// error page rather than a refused connection. That is not this world
// speaking, so the feed must go looking exactly as it does for no answer.
test("a host answering with an edge error is looked for too", async () => {
  const moved = "https://play-newcode.example";
  const h = harness({
    hosts: [host({ id: "srv", origin: "https://play-oldcode.example" })],
    replies: {
      "https://play-oldcode.example": { kind: "reply", status: 530, body: "<html>error</html>" },
      [moved]: { kind: "reply", status: 200, body: { campaigns: [rawCampaign] } },
    },
    relocate: async () => moved,
  });
  const feed = await h.feed.refresh();
  const srv = feed.hosts.find((entry) => entry.id === "srv");
  assert.equal(srv.status, "online");
  assert.equal(srv.origin, moved);
});

test("a host that refuses the session is a sign-in matter, not a move", async () => {
  const calls = [];
  const h = harness({
    hosts: [host({ id: "srv" })],
    replies: { [origin]: { kind: "reply", status: 401, body: {} } },
    relocate: async () => {
      calls.push("asked");
      return "https://somewhere.example";
    },
  });
  const feed = await h.feed.refresh();
  assert.equal(feed.hosts[0].status, "needsLogin");
  assert.deepEqual(calls, []);
});

test("a typed code is asked of signed-in servers only, never a friend's world, newest first", () => {
  const origins = tableLookupOrigins([
    { origin: "https://old.example.com", lastUsedAt: "2026-09-01T00:00:00.000Z", signedIn: true },
    { origin: "https://play-abcd2345.opendungeonmaster.com", lastUsedAt: "2026-10-20T00:00:00.000Z", signedIn: true },
    { origin: "https://new.example.com", lastUsedAt: "2026-10-19T00:00:00.000Z", signedIn: true },
    { origin: "https://signed-out.example.com", lastUsedAt: "2026-10-20T00:00:00.000Z", signedIn: false },
  ]);
  assert.deepEqual(origins, ["https://new.example.com", "https://old.example.com"]);
});
