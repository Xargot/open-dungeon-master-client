import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { findEntry, intOf, parseBinaryVdf, serializeBinaryVdf, stringOf } from "../dist/main/steam-vdf.js";
import {
  STABLE_APPIMAGE_NAME,
  STEAM_ART,
  SHORTCUT_NAME,
  addToSteam,
  canAddToSteam,
  deckOffersSteam,
  mergeLaunchOptions,
  mostRecentAccount,
  shortcutAppId,
  stableAppImagePath,
  steamShortcutState,
  steamTarget,
  upsertShortcut,
} from "../dist/main/steam-shortcut.js";
import { cleanHostEnv } from "../dist/main/steam-host.js";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ART_DIR = path.join(repo, "build", "steam");

// Steam's bytes, written out by hand rather than by the serializer under
// test: 0x00 map, 0x01 string, 0x02 int32, 0x08 end.
function vdf(...parts) {
  return Buffer.concat(
    parts.flat(Infinity).map((part) =>
      typeof part === "number" ? Buffer.from([part]) : Buffer.isBuffer(part) ? part : Buffer.from(`${part}\0`, "utf8"),
    ),
  );
}
const i32 = (value) => {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value);
  return buf;
};
const s = (key, value) => [0x01, key, value];
const n = (key, value) => [0x02, key, i32(value)];
const entry = (index, ...fields) => [0x00, String(index), ...fields, 0x08];
const list = (...entries) => vdf(0x00, "shortcuts", ...entries, 0x08, 0x08);

// An emulator a player added by hand, the way Steam writes it.
const EMULATOR = entry(
  0,
  n("appid", -1234567890),
  s("AppName", "RetroArch"),
  s("Exe", '"/usr/bin/retroarch"'),
  s("StartDir", '"/usr/bin/"'),
  s("icon", ""),
  s("ShortcutPath", "/usr/share/applications/retroarch.desktop"),
  s("LaunchOptions", ""),
  n("IsHidden", 0),
  n("AllowDesktopConfig", 1),
  n("AllowOverlay", 1),
  n("OpenVR", 0),
  n("Devkit", 0),
  s("DevkitGameID", ""),
  n("DevkitOverrideAppID", 0),
  n("LastPlayTime", 1760000000),
  s("FlatpakAppID", ""),
  [0x00, "tags", s("0", "Emulators"), 0x08],
);

// Every CRC-32 written out, so the app id scheme is pinned by a second
// implementation rather than by zlib agreeing with itself.
function crc32(text) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, "utf8")) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test("Steam's binary list reads and writes back byte for byte, every value type included", () => {
  const bytes = list(EMULATOR);
  const parsed = parseBinaryVdf(bytes);
  assert.deepEqual(serializeBinaryVdf(parsed), bytes);
  const shortcuts = findEntry(parsed, "shortcuts").node.entries;
  assert.equal(stringOf(shortcuts[0].node.entries, "appname"), "RetroArch", "keys are read without regard to case");
  assert.equal(intOf(shortcuts[0].node.entries, "LastPlayTime"), 1760000000);

  const wide = Buffer.alloc(8);
  wide.writeBigUInt64LE(0xfedcba9876543210n);
  const signed = Buffer.alloc(8);
  signed.writeBigInt64LE(-5n);
  const float = Buffer.alloc(4);
  float.writeFloatLE(1.5);
  const mixed = vdf(0x07, "u", wide, 0x0a, "i", signed, 0x03, "f", float, 0x01, "name", "Überwald ☃", 0x08);
  assert.deepEqual(serializeBinaryVdf(parseBinaryVdf(mixed)), mixed);
  assert.deepEqual(parseBinaryVdf(Buffer.alloc(0)), [], "no file yet is an empty list");
});

test("a list with an unknown value type, a cut-off end or trailing bytes is refused", () => {
  assert.throws(() => parseBinaryVdf(vdf(0x05, "wide", "x", 0x08)), /Unknown value type 0x5/);
  assert.throws(() => parseBinaryVdf(list(EMULATOR).subarray(0, 40)));
  assert.throws(() => parseBinaryVdf(Buffer.concat([list(EMULATOR), Buffer.from([0])])), /follow the end/);
});

test("the shortcut's app id is the CRC-32 of the quoted program and the name, top bit set", () => {
  const exe = '"/home/deck/Applications/OpenDungeonMaster.AppImage"';
  const id = shortcutAppId(exe, SHORTCUT_NAME);
  assert.equal(id, (crc32(exe + SHORTCUT_NAME) | 0x80000000) >>> 0);
  assert.ok(id >= 0x80000000 && id <= 0xffffffff);
  assert.notEqual(shortcutAppId('"/other"', SHORTCUT_NAME), id);
});

test("each Linux install starts the way it can: a flatpak through flatpak, the rest by their file with --no-sandbox", () => {
  const place = { execPath: "/opt/Open Dungeon Master/open-dungeon-master-client", appImagePath: "", flatpakId: "" };
  assert.deepEqual(steamTarget({ ...place, kind: "managed" }), {
    exe: '"/opt/Open Dungeon Master/open-dungeon-master-client"',
    startDir: '"/opt/Open Dungeon Master"',
    launchOptions: "--no-sandbox",
    flatpakId: "",
  });
  assert.equal(steamTarget({ ...place, kind: "portable", execPath: "/home/k/odm/open-dungeon-master-client" }).exe, '"/home/k/odm/open-dungeon-master-client"');
  assert.deepEqual(steamTarget({ ...place, kind: "appimage", appImagePath: "/home/deck/OpenDungeonMaster.AppImage" }), {
    exe: '"/home/deck/OpenDungeonMaster.AppImage"',
    startDir: '"/home/deck"',
    launchOptions: "--no-sandbox",
    flatpakId: "",
  });
  assert.deepEqual(steamTarget({ ...place, kind: "flatpak", flatpakId: "com.opendungeonmaster.client" }), {
    exe: '"/usr/bin/flatpak"',
    startDir: '"/usr/bin"',
    launchOptions: "run com.opendungeonmaster.client",
    flatpakId: "com.opendungeonmaster.client",
  });
  for (const kind of ["dev", "snap", "nsis", "mac"]) assert.equal(steamTarget({ ...place, kind }), null, kind);
  assert.equal(steamTarget({ ...place, kind: "appimage" }), null, "an AppImage run that lost $APPIMAGE");
  assert.equal(canAddToSteam("flatpak", "linux"), true);
  assert.equal(canAddToSteam("portable", "win32"), false);
  assert.equal(canAddToSteam("dev", "linux"), false);
});

test("an AppImage named with its version moves to a name updates keep; a renamed one stays", () => {
  assert.equal(stableAppImagePath("/home/deck/Downloads/open-dungeon-master-client-0.17.6-x86_64.AppImage"), path.join("/home/deck/Downloads", STABLE_APPIMAGE_NAME));
  assert.equal(stableAppImagePath("/home/deck/Games/ODM.AppImage"), "/home/deck/Games/ODM.AppImage");
});

test("the account that signed in last is the one the shortcut goes to", () => {
  const text = `"users"
{
\t"76561197960287930"
\t{
\t\t"AccountName"\t\t"older"
\t\t"PersonaName"\t\t"Someone Else"
\t\t"MostRecent"\t\t"0"
\t\t"Timestamp"\t\t"1760000500"
\t}
\t"76561198012345678"
\t{
\t\t"AccountName"\t\t"kaleb"
\t\t"PersonaName"\t\t"Kal \\"the DM\\""
\t\t"mostrecent"\t\t"1"
\t\t"Timestamp"\t\t"1760000000"
\t}
}`;
  assert.deepEqual(mostRecentAccount(text), { accountId: 52079950, persona: 'Kal "the DM"' });
  assert.deepEqual(mostRecentAccount(text.replace('"mostrecent"\t\t"1"', '"mostrecent"\t\t"0"')), { accountId: 22202, persona: "Someone Else" });
  assert.equal(mostRecentAccount(""), null);
});

test("the player's own launch options stay on a shortcut that already starts this app", () => {
  assert.equal(mergeLaunchOptions("--steam-deck", "--no-sandbox", true), "--steam-deck --no-sandbox");
  assert.equal(mergeLaunchOptions("--no-sandbox --steam-deck", "--no-sandbox", true), "--no-sandbox --steam-deck");
  assert.equal(
    mergeLaunchOptions("run --branch=stable --arch=x86_64 --file-forwarding com.opendungeonmaster.client @@u @@", "run com.opendungeonmaster.client", true),
    "run --branch=stable --arch=x86_64 --file-forwarding com.opendungeonmaster.client @@u @@",
  );
  assert.equal(mergeLaunchOptions("-fullscreen", "--no-sandbox", false), "--no-sandbox");
  assert.equal(mergeLaunchOptions("", "--no-sandbox", true), "--no-sandbox");
});

const appImageWish = (exe, formerPaths = []) => ({
  name: SHORTCUT_NAME,
  target: { exe: `"${exe}"`, startDir: `"${path.dirname(exe)}"`, launchOptions: "--no-sandbox", flatpakId: "" },
  formerPaths,
  gridDir: "/home/deck/.local/share/Steam/userdata/1/config/grid",
});

test("a new shortcut is appended after the last entry and nothing else in the list changes", () => {
  const bytes = list(EMULATOR);
  const root = parseBinaryVdf(bytes);
  const wish = appImageWish("/home/deck/OpenDungeonMaster.AppImage");
  const { appid, added } = upsertShortcut(root, wish);
  assert.equal(added, true);
  assert.equal(appid, shortcutAppId(wish.target.exe, SHORTCUT_NAME));
  const shortcuts = findEntry(root, "shortcuts").node.entries;
  assert.deepEqual(shortcuts.map((e) => e.key), ["0", "1"]);
  assert.deepEqual(serializeBinaryVdf([{ key: "shortcuts", node: { type: "map", entries: [shortcuts[0]] } }]), bytes, "the emulator is untouched");
  const ours = shortcuts[1].node.entries;
  assert.equal(intOf(ours, "appid") >>> 0, appid);
  assert.equal(stringOf(ours, "AppName"), SHORTCUT_NAME);
  assert.equal(stringOf(ours, "Exe"), '"/home/deck/OpenDungeonMaster.AppImage"');
  assert.equal(stringOf(ours, "LaunchOptions"), "--no-sandbox");
  assert.equal(stringOf(ours, "icon"), path.join(wish.gridDir, `${appid}_icon.png`));
  assert.equal(intOf(ours, "AllowOverlay"), 1);

  const fresh = [];
  upsertShortcut(fresh, wish);
  assert.equal(findEntry(fresh, "shortcuts").node.entries[0].key, "0", "a list Steam never wrote starts at 0");
});

test("a shortcut the player made to the versioned AppImage is taken over: its id, play time and tags stay", () => {
  const old = "/home/deck/Downloads/open-dungeon-master-client-0.17.3-x86_64.AppImage";
  const root = parseBinaryVdf(
    list(
      EMULATOR,
      entry(1, n("appid", -555), s("AppName", "open-dungeon-master-client-0.17.3-x86_64"), s("Exe", `"${old}"`), s("StartDir", '"/home/deck/Downloads/"'), s("LaunchOptions", "--steam-deck"), n("LastPlayTime", 1760001234), [0x00, "tags", s("0", "Tabletop"), 0x08]),
    ),
  );
  const wish = appImageWish(`/home/deck/Downloads/${STABLE_APPIMAGE_NAME}`, [old]);
  const { appid, added } = upsertShortcut(root, wish);
  assert.equal(added, false);
  assert.equal(appid, -555 >>> 0);
  const shortcuts = findEntry(root, "shortcuts").node.entries;
  assert.equal(shortcuts.length, 2, "no second tile");
  const ours = shortcuts[1].node.entries;
  assert.equal(stringOf(ours, "AppName"), SHORTCUT_NAME);
  assert.equal(stringOf(ours, "Exe"), `"/home/deck/Downloads/${STABLE_APPIMAGE_NAME}"`);
  assert.equal(stringOf(ours, "LaunchOptions"), "--steam-deck --no-sandbox");
  assert.equal(intOf(ours, "LastPlayTime"), 1760001234);
  assert.equal(stringOf(findEntry(ours, "tags").node.entries, "0"), "Tabletop");
});

test("a flatpak shortcut Steam's own dialog made is found by its app id in the launch options, and other flatpaks are not", () => {
  const steamMade = entry(
    1,
    n("appid", -777),
    s("AppName", "Open Dungeon Master"),
    s("Exe", '"/usr/bin/flatpak"'),
    s("LaunchOptions", "run --branch=stable --arch=x86_64 --command=open-dungeon-master-client com.opendungeonmaster.client"),
  );
  const otherFlatpak = entry(0, n("appid", -888), s("AppName", "Firefox"), s("Exe", '"/usr/bin/flatpak"'), s("LaunchOptions", "run org.mozilla.firefox"));
  const root = parseBinaryVdf(list(otherFlatpak, steamMade));
  const wish = {
    name: SHORTCUT_NAME,
    target: { exe: '"/usr/bin/flatpak"', startDir: '"/usr/bin"', launchOptions: "run com.opendungeonmaster.client", flatpakId: "com.opendungeonmaster.client" },
    formerPaths: [],
    gridDir: "/g",
  };
  const { appid, added } = upsertShortcut(root, wish);
  assert.equal(added, false);
  assert.equal(appid, -777 >>> 0);
  const [firefox, ours] = findEntry(root, "shortcuts").node.entries;
  assert.equal(stringOf(firefox.node.entries, "LaunchOptions"), "run org.mozilla.firefox");
  assert.equal(stringOf(ours.node.entries, "FlatpakAppID"), "com.opendungeonmaster.client");
  assert.match(stringOf(ours.node.entries, "LaunchOptions"), /^run --branch=stable/);
});

// A home folder with a Steam in it, and a Steam that answers like the real
// one: running until asked to quit.
async function fakeHome({ running = false, closes = true, list: initial = null, flathubOnly = false } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "odm-steam-"));
  const steamDir = path.join(home, flathubOnly ? ".var/app/com.valvesoftware.Steam/.local/share/Steam" : ".local/share/Steam");
  const account = path.join(steamDir, "userdata", "52079950");
  await mkdir(path.join(account, "config"), { recursive: true });
  await mkdir(path.join(steamDir, "userdata", "0"), { recursive: true });
  await mkdir(path.join(steamDir, "config"), { recursive: true });
  await writeFile(
    path.join(steamDir, "config", "loginusers.vdf"),
    `"users"\n{\n\t"76561198012345678"\n\t{\n\t\t"PersonaName"\t\t"Kaleb"\n\t\t"MostRecent"\t\t"1"\n\t}\n}\n`,
  );
  if (!flathubOnly) {
    await mkdir(path.join(home, ".steam"), { recursive: true });
    await symlink(steamDir, path.join(home, ".steam", "steam"));
  }
  if (initial) await writeFile(path.join(account, "config", "shortcuts.vdf"), initial);
  const calls = [];
  let up = running;
  const host = {
    async isRunning() {
      calls.push("isRunning");
      return up;
    },
    async shutdown() {
      calls.push("shutdown");
      if (closes) up = false;
    },
    start() {
      calls.push("start");
      up = true;
    },
    async wait() {
      calls.push("wait");
    },
  };
  return { home, account, host, calls, cleanup: () => rm(home, { recursive: true, force: true }) };
}

const request = (home, extra = {}) => ({
  place: { kind: "managed", execPath: "/opt/Open Dungeon Master/open-dungeon-master-client", appImagePath: "", flatpakId: "" },
  home,
  artDir: ART_DIR,
  launchedBySteam: false,
  restart: false,
  ...extra,
});

test("with Steam closed the app joins the library at once, artwork in the grid folder", async () => {
  const before = list(EMULATOR);
  const steam = await fakeHome({ list: before });
  try {
    const result = await addToSteam(request(steam.home), steam.host);
    assert.deepEqual(result, { ok: true, state: "added", persona: "Kaleb", restarted: false, moved: "" });
    assert.deepEqual(steam.calls, ["isRunning"], "a closed Steam is neither asked to quit nor started");
    const written = await readFile(path.join(steam.account, "config", "shortcuts.vdf"));
    assert.deepEqual(written.subarray(0, before.length - 2), before.subarray(0, before.length - 2), "the emulator's bytes lead the new list unchanged");
    const shortcuts = findEntry(parseBinaryVdf(written), "shortcuts").node.entries;
    const appid = intOf(shortcuts[1].node.entries, "appid") >>> 0;
    const grid = await readdir(path.join(steam.account, "config", "grid"));
    assert.deepEqual(grid.sort(), STEAM_ART.map((art) => art.grid(appid)).sort());
    const leftovers = (await readdir(path.join(steam.account, "config"))).filter((name) => name.endsWith(".odm-new"));
    assert.deepEqual(leftovers, []);

    const again = await addToSteam(request(steam.home), steam.host);
    assert.equal(again.state, "updated");
    const after = findEntry(parseBinaryVdf(await readFile(path.join(steam.account, "config", "shortcuts.vdf"))), "shortcuts").node.entries;
    assert.equal(after.length, 2, "pressing it twice makes one tile");
  } finally {
    await steam.cleanup();
  }
});

test("with Steam open nothing changes until the player agrees, then Steam closes, the app is added, and Steam opens again", async () => {
  const steam = await fakeHome({ running: true });
  try {
    assert.deepEqual(await addToSteam(request(steam.home), steam.host), { ok: true, state: "needs-restart" });
    await assert.rejects(stat(path.join(steam.account, "config", "shortcuts.vdf")), "nothing written while Steam holds the list");
    steam.calls.length = 0;
    const result = await addToSteam(request(steam.home, { restart: true }), steam.host);
    assert.equal(result.ok && result.state, "added");
    assert.equal(result.restarted, true);
    assert.equal(steam.calls[0], "isRunning");
    assert.equal(steam.calls[1], "shutdown");
    assert.equal(steam.calls.at(-1), "start");
    assert.ok((await stat(path.join(steam.account, "config", "shortcuts.vdf"))).size > 0);
  } finally {
    await steam.cleanup();
  }
});

test("a Steam that will not close leaves the list alone and is not started twice", async () => {
  const steam = await fakeHome({ running: true, closes: false });
  try {
    const result = await addToSteam(request(steam.home, { restart: true }), steam.host);
    assert.equal(result.ok, false);
    assert.match(result.error, /did not close/);
    assert.ok(!steam.calls.includes("start"));
    await assert.rejects(stat(path.join(steam.account, "config", "shortcuts.vdf")));
  } finally {
    await steam.cleanup();
  }
});

test("an AppImage named with its version is renamed, and the shortcut and the answer name the new file", async () => {
  const steam = await fakeHome();
  const versioned = path.join(steam.home, "open-dungeon-master-client-0.17.6-x86_64.AppImage");
  await writeFile(versioned, "appimage");
  try {
    const result = await addToSteam(
      request(steam.home, { place: { kind: "appimage", execPath: "/tmp/.mount_x/odm", appImagePath: versioned, flatpakId: "" } }),
      steam.host,
    );
    const stable = path.join(steam.home, STABLE_APPIMAGE_NAME);
    assert.equal(result.moved, stable);
    assert.equal(await readFile(stable, "utf8"), "appimage");
    await assert.rejects(stat(versioned));
    const shortcuts = findEntry(parseBinaryVdf(await readFile(path.join(steam.account, "config", "shortcuts.vdf"))), "shortcuts").node.entries;
    assert.equal(stringOf(shortcuts[0].node.entries, "Exe"), `"${stable}"`);
    assert.equal(stringOf(shortcuts[0].node.entries, "LaunchOptions"), "--no-sandbox");
  } finally {
    await steam.cleanup();
  }
});

test("a list this app cannot read back exactly is left alone", async () => {
  const odd = vdf(0x00, "shortcuts", 0x05, "wide", "x", 0x08, 0x08);
  const steam = await fakeHome({ list: odd });
  try {
    const result = await addToSteam(request(steam.home), steam.host);
    assert.equal(result.ok, false);
    assert.match(result.error, /left alone/);
    assert.deepEqual(await readFile(path.join(steam.account, "config", "shortcuts.vdf")), odd);
  } finally {
    await steam.cleanup();
  }
});

test("no Steam, Steam from Flathub, a run Steam started and a dev run each get a plain answer", async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), "odm-steam-"));
  const flathub = await fakeHome({ flathubOnly: true });
  try {
    const host = { isRunning: async () => false, shutdown: async () => {}, start() {}, wait: async () => {} };
    assert.match((await addToSteam(request(empty), host)).error, /not installed/);
    assert.match((await addToSteam(request(flathub.home), host)).error, /Flathub/);
    assert.match((await addToSteam(request(flathub.home, { launchedBySteam: true }), host)).error, /Steam started this run/);
    assert.match(
      (await addToSteam(request(flathub.home, { place: { kind: "dev", execPath: "/x", appImagePath: "", flatpakId: "" } }), host)).error,
      /cannot be added/,
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
    await flathub.cleanup();
  }
});

test("Steam starts without the AppImage's mount or Electron's markers in its environment", () => {
  const env = cleanHostEnv({
    APPDIR: "/tmp/.mount_odm",
    APPIMAGE: "/home/deck/OpenDungeonMaster.AppImage",
    LD_LIBRARY_PATH: "/tmp/.mount_odm/usr/lib:/usr/lib",
    XDG_DATA_DIRS: "/tmp/.mount_odm/usr/share",
    PATH: "/usr/bin:/bin",
    ELECTRON_RUN_AS_NODE: "1",
    CHROME_DESKTOP: "open-dungeon-master-client.desktop",
    XDG_CURRENT_DESKTOP: "Unity",
    ORIGINAL_XDG_CURRENT_DESKTOP: "KDE",
    HOME: "/home/deck",
  });
  assert.deepEqual(env, { LD_LIBRARY_PATH: "/usr/lib", PATH: "/usr/bin:/bin", XDG_CURRENT_DESKTOP: "KDE", HOME: "/home/deck" });
});

test("the shipped artwork is every file Steam is given, at the sizes Steam draws", async () => {
  const expected = {
    "portrait.jpg": [600, 900],
    "wide.jpg": [920, 430],
    "hero.jpg": [1920, 620],
  };
  for (const art of STEAM_ART) {
    const meta = await sharp(path.join(ART_DIR, art.source)).metadata();
    if (expected[art.source]) assert.deepEqual([meta.width, meta.height], expected[art.source], art.source);
    if (art.source === "logo.png") {
      assert.equal(meta.hasAlpha, true, "the logo sits on the banner, so it needs a clear background");
      assert.ok(meta.width <= 1280 && meta.height <= 720, "Steam's logo box");
    }
    if (art.source === "icon.png") assert.equal(meta.width, meta.height);
  }
});

test("the first-launch offer is for a Deck in Desktop Mode started from the desktop", () => {
  assert.equal(deckOffersSteam({ device: true, gameMode: false, steam: false }), true);
  assert.equal(deckOffersSteam({ device: true, gameMode: true, steam: true }), false, "Game Mode: Steam started it");
  assert.equal(deckOffersSteam({ device: true, gameMode: false, steam: true }), false, "a Steam shortcut started it");
  assert.equal(deckOffersSteam({ device: false, gameMode: false, steam: false }), false, "a desktop has the Settings button only");
});

test("the offer is due only while the app is missing from a library it could join", async () => {
  const steam = await fakeHome({ list: list(EMULATOR) });
  const versioned = path.join(steam.home, "open-dungeon-master-client-0.17.6-x86_64.AppImage");
  await writeFile(versioned, "appimage");
  const place = { kind: "appimage", execPath: "/tmp/.mount_x/odm", appImagePath: versioned, flatpakId: "" };
  try {
    assert.equal(await steamShortcutState(place, steam.home), "missing");
    await addToSteam(request(steam.home, { place }), steam.host);
    const stable = path.join(steam.home, STABLE_APPIMAGE_NAME);
    assert.equal(await steamShortcutState({ ...place, appImagePath: stable }, steam.home), "found", "the renamed file is the one in Steam");
    assert.equal(await steamShortcutState(place, steam.home), "found", "a new versioned download still finds the stable shortcut");
    assert.equal(await steamShortcutState({ ...place, kind: "dev" }, steam.home), "unavailable");
    await writeFile(path.join(steam.account, "config", "shortcuts.vdf"), vdf(0x00, "shortcuts", 0x05, "wide", "x", 0x08, 0x08));
    assert.equal(await steamShortcutState(place, steam.home), "unavailable", "a list the add would refuse");
  } finally {
    await steam.cleanup();
  }
  const empty = await mkdtemp(path.join(os.tmpdir(), "odm-steam-"));
  try {
    assert.equal(await steamShortcutState({ kind: "portable", execPath: "/opt/odm/odm", appImagePath: "", flatpakId: "" }, empty), "unavailable");
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("a fresh Steam with no list yet is a library the app is missing from", async () => {
  const steam = await fakeHome();
  try {
    assert.equal(await steamShortcutState(request(steam.home).place, steam.home), "missing");
  } finally {
    await steam.cleanup();
  }
});
