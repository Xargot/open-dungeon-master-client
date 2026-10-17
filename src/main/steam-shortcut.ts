// "Add to Steam" (Settings, Steam Deck and controllers): this install as a
// non-Steam game in the library of the account last signed in to Steam,
// with its artwork, so Game Mode starts it like any game.
//
// Steam keeps its shortcuts in userdata/<account>/config/shortcuts.vdf
// (binary, src/main/steam-vdf.ts) and the artwork in config/grid, named by
// the shortcut's app id. It reads the list once at start and writes it back
// on the way out, so the list only changes while Steam is closed: an open
// Steam is closed first (once the player agrees) and started again after.
//
// The list is only rewritten when it reads back byte for byte, and only the
// one entry for this app is added or changed; every other shortcut stays as
// it was. Kept free of electron so the tests run it under plain node.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import type { InstallKind, SteamAddResult } from "../shared/types";
import { versionedAppImageName } from "./updater";
import {
  findEntry,
  intOf,
  parseBinaryVdf,
  serializeBinaryVdf,
  setEntry,
  stringOf,
  type VdfEntry,
  type VdfNode,
} from "./steam-vdf";

export const SHORTCUT_NAME = "Open Dungeon Master";

// The name an AppImage takes for its shortcut: no version in it, so the
// updater replaces the file in place (replaceAppImage) and Steam's
// shortcut keeps finding it.
export const STABLE_APPIMAGE_NAME = "OpenDungeonMaster.AppImage";

// Steam installs the shortcut can go into, most trusted first: ~/.steam/steam
// is the link Steam itself keeps to the install it runs from.
const STEAM_ROOTS = [".steam/steam", ".local/share/Steam", ".steam/root", ".steam/debian-installation"];

// Steam from Flathub starts its games inside its own sandbox, where neither
// this app's files nor the host's flatpak command exist.
const FLATHUB_STEAM = ".var/app/com.valvesoftware.Steam/.local/share/Steam";

const STEAM_ID64_BASE = 76561197960265728n;

// The artwork as shipped (build/steam, resources/steam once packaged) and
// the file Steam looks for in config/grid: the portrait tile Game Mode's
// library shows, the wide tile, the banner over the game's page, the logo
// drawn on that banner, and the icon.
export const STEAM_ART: readonly { source: string; grid: (appid: number) => string }[] = [
  { source: "portrait.jpg", grid: (appid) => `${appid}p.jpg` },
  { source: "wide.jpg", grid: (appid) => `${appid}.jpg` },
  { source: "hero.jpg", grid: (appid) => `${appid}_hero.jpg` },
  { source: "logo.png", grid: (appid) => `${appid}_logo.png` },
  { source: "icon.png", grid: (appid) => `${appid}_icon.png` },
];

export interface InstallPlace {
  kind: InstallKind;
  // The running binary (an rpm, deb or tar.gz install starts from it).
  execPath: string;
  // $APPIMAGE, "" elsewhere.
  appImagePath: string;
  // $FLATPAK_ID, "" elsewhere.
  flatpakId: string;
}

// What the shortcut starts, as Steam stores it (paths in double quotes).
export interface SteamTarget {
  exe: string;
  startDir: string;
  launchOptions: string;
  flatpakId: string;
}

const quoted = (file: string): string => `"${file}"`;

export function unquoted(value: string): string {
  const text = value.trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

// The installs a shortcut can start. A flatpak runs through the host's
// flatpak, the way Steam's own "Add a Non-Steam Game" list adds one.
// Everything else starts its binary directly, with --no-sandbox: Electron
// started by Steam often dies before it draws anything without it.
export function steamTarget(place: InstallPlace): SteamTarget | null {
  const direct = (file: string): SteamTarget => ({
    exe: quoted(file),
    startDir: quoted(path.dirname(file)),
    launchOptions: "--no-sandbox",
    flatpakId: "",
  });
  switch (place.kind) {
    case "flatpak":
      return place.flatpakId
        ? { exe: quoted("/usr/bin/flatpak"), startDir: quoted("/usr/bin"), launchOptions: `run ${place.flatpakId}`, flatpakId: place.flatpakId }
        : null;
    case "appimage":
      return place.appImagePath ? direct(place.appImagePath) : null;
    case "managed":
    case "portable":
      return place.execPath ? direct(place.execPath) : null;
    default:
      return null;
  }
}

export function canAddToSteam(kind: InstallKind, platform: NodeJS.Platform): boolean {
  return platform === "linux" && (kind === "appimage" || kind === "flatpak" || kind === "managed" || kind === "portable");
}

// Is there a Steam here to add to? Read for Settings, so it stays cheap.
export function steamPresent(home: string): boolean {
  return [...STEAM_ROOTS, FLATHUB_STEAM].some((dir) => existsSync(path.join(home, dir)));
}

// Where the AppImage should be for a shortcut that outlives updates.
export function stableAppImagePath(current: string): string {
  return versionedAppImageName(path.basename(current)) ? path.join(path.dirname(current), STABLE_APPIMAGE_NAME) : current;
}

// The id Steam files the shortcut's artwork under. The scheme every tool
// that writes shortcuts uses (Steam ROM Manager, BoilR): the CRC-32 of the
// quoted program and the name, with the top bit set.
export function shortcutAppId(exe: string, name: string): number {
  return (crc32(exe + name) | 0x80000000) >>> 0;
}

// Text VDF (config/loginusers.vdf): the account that signed in last, or
// failing a MostRecent mark, the newest by timestamp.
export function mostRecentAccount(loginUsers: string): { accountId: number; persona: string } | null {
  const field = (body: string, key: string): string => {
    const match = new RegExp(`"${key}"\\s+"((?:[^"\\\\]|\\\\.)*)"`, "i").exec(body);
    return (match?.[1] ?? "").replace(/\\(.)/g, "$1");
  };
  let best: { accountId: number; persona: string; recent: boolean; stamp: number } | null = null;
  for (const [, id64 = "0", body = ""] of loginUsers.matchAll(/"(\d{17})"\s*\{([^{}]*)\}/g)) {
    const id = BigInt(id64) - STEAM_ID64_BASE;
    if (id <= 0n || id > 0xffffffffn) continue;
    const candidate = {
      accountId: Number(id),
      persona: field(body, "PersonaName"),
      recent: field(body, "MostRecent") === "1",
      stamp: Number(field(body, "Timestamp")) || 0,
    };
    if (!best || (candidate.recent && !best.recent) || (candidate.recent === best.recent && candidate.stamp > best.stamp)) {
      best = candidate;
    }
  }
  return best ? { accountId: best.accountId, persona: best.persona } : null;
}

// The player's own launch options survive on a shortcut that already starts
// this app; what the app needs is added. A shortcut to some other program
// takes the app's options whole.
export function mergeLaunchOptions(existing: string, wanted: string, sameProgram: boolean): string {
  const have = existing.trim();
  if (!sameProgram || !have) return wanted;
  const tokens = have.split(/\s+/);
  const missing = wanted.split(/\s+/).filter((token) => token && !tokens.includes(token));
  return [have, ...missing].join(" ");
}

export interface ShortcutWish {
  name: string;
  target: SteamTarget;
  // Programs an older shortcut to this install may name (the AppImage by
  // its versioned name, before it moved).
  formerPaths: readonly string[];
  // config/grid, where the icon is copied.
  gridDir: string;
}

function startsThisApp(fields: readonly VdfEntry[], wish: ShortcutWish): boolean {
  const exe = unquoted(stringOf(fields, "Exe"));
  const { flatpakId } = wish.target;
  if (flatpakId) {
    if (stringOf(fields, "FlatpakAppID") === flatpakId) return true;
    return path.basename(exe) === "flatpak" && stringOf(fields, "LaunchOptions").split(/\s+/).includes(flatpakId);
  }
  return [unquoted(wish.target.exe), ...wish.formerPaths].includes(exe);
}

const str = (value: string): VdfNode => ({ type: "string", value });
const int = (value: number): VdfNode => ({ type: "int32", value: value | 0 });

type VdfMapEntry = { key: string; node: Extract<VdfNode, { type: "map" }> };

// This app's entry in the list: by app id, or by starting the same program.
function findOurShortcut(entries: readonly VdfEntry[], wish: ShortcutWish): VdfMapEntry | undefined {
  const ownId = shortcutAppId(wish.target.exe, wish.name);
  const maps = entries.filter((entry): entry is VdfMapEntry => entry.node.type === "map");
  return (
    maps.find((entry) => intOf(entry.node.entries, "appid") >>> 0 === ownId) ??
    maps.find((entry) => startsThisApp(entry.node.entries, wish))
  );
}

// Adds this app to the list, or brings its existing entry up to date.
// Changes the list in place.
export function upsertShortcut(root: VdfEntry[], wish: ShortcutWish): { appid: number; added: boolean } {
  let list = findEntry(root, "shortcuts");
  if (!list) {
    list = { key: "shortcuts", node: { type: "map", entries: [] } };
    root.push(list);
  }
  if (list.node.type !== "map") throw new Error("Its shortcut list is not a list.");
  const entries = list.node.entries;
  const ownId = shortcutAppId(wish.target.exe, wish.name);
  const match = findOurShortcut(entries, wish);
  if (match) {
    const fields = match.node.entries;
    const appid = intOf(fields, "appid") >>> 0 || ownId;
    const same = startsThisApp(fields, wish);
    setEntry(fields, "appid", int(appid));
    setEntry(fields, "AppName", str(wish.name));
    setEntry(fields, "Exe", str(wish.target.exe));
    setEntry(fields, "StartDir", str(wish.target.startDir));
    setEntry(fields, "icon", str(path.join(wish.gridDir, `${appid}_icon.png`)));
    setEntry(fields, "LaunchOptions", str(mergeLaunchOptions(stringOf(fields, "LaunchOptions"), wish.target.launchOptions, same)));
    setEntry(fields, "IsHidden", int(0));
    setEntry(fields, "FlatpakAppID", str(wish.target.flatpakId));
    return { appid, added: false };
  }
  // The next free index; Steam numbers its entries from "0".
  const next = entries.reduce((top, entry) => (/^\d+$/.test(entry.key) ? Math.max(top, Number(entry.key) + 1) : top), 0);
  entries.push({
    key: String(next),
    node: {
      type: "map",
      entries: [
        { key: "appid", node: int(ownId) },
        { key: "AppName", node: str(wish.name) },
        { key: "Exe", node: str(wish.target.exe) },
        { key: "StartDir", node: str(wish.target.startDir) },
        { key: "icon", node: str(path.join(wish.gridDir, `${ownId}_icon.png`)) },
        { key: "ShortcutPath", node: str("") },
        { key: "LaunchOptions", node: str(wish.target.launchOptions) },
        { key: "IsHidden", node: int(0) },
        { key: "AllowDesktopConfig", node: int(1) },
        { key: "AllowOverlay", node: int(1) },
        { key: "OpenVR", node: int(0) },
        { key: "Devkit", node: int(0) },
        { key: "DevkitGameID", node: str("") },
        { key: "DevkitOverrideAppID", node: int(0) },
        { key: "LastPlayTime", node: int(0) },
        { key: "FlatpakAppID", node: str(wish.target.flatpakId) },
        { key: "tags", node: { type: "map", entries: [] } },
      ],
    },
  });
  return { appid: ownId, added: true };
}

// The first-launch offer is for a Steam Deck (or anything running SteamOS)
// in Desktop Mode, started from the desktop: in Game Mode, or started by
// Steam, the app is in the library already.
export function deckOffersSteam(deck: { device: boolean; gameMode: boolean; steam: boolean }): boolean {
  return deck.device && !deck.gameMode && !deck.steam;
}

// What the add needs from the machine, behind an interface so the tests
// run the whole add against a folder with a fake Steam.
export interface SteamHost {
  isRunning(): Promise<boolean>;
  // Asks a running Steam to quit; resolves once the request is sent.
  shutdown(): Promise<void>;
  // Starts Steam on its own, outliving this app.
  start(): void;
  wait(ms: number): Promise<void>;
}

export interface AddToSteamRequest {
  place: InstallPlace;
  home: string;
  // The artwork folder (STEAM_ART sources).
  artDir: string;
  // Steam started this run: it is in the library already, and closing
  // Steam would end this app with it.
  launchedBySteam: boolean;
  // The player agreed to Steam closing and opening again.
  restart: boolean;
}

const SHUTDOWN_WAIT_MS = 30_000;
const POLL_MS = 500;

async function isDirectory(dir: string): Promise<boolean> {
  return stat(dir).then((info) => info.isDirectory(), () => false);
}

async function findSteamRoot(home: string): Promise<string> {
  for (const relative of STEAM_ROOTS) {
    const dir = await realpath(path.join(home, relative)).catch(() => "");
    if (dir && ((await isDirectory(path.join(dir, "userdata"))) || (await isDirectory(path.join(dir, "ubuntu12_32"))))) {
      return dir;
    }
  }
  return "";
}

// The account folder the shortcut goes into: the account that signed in
// last, else the one whose settings changed last.
async function findAccount(root: string): Promise<{ dir: string; persona: string } | null> {
  const userdata = path.join(root, "userdata");
  const ids = (await readdir(userdata).catch(() => [] as string[])).filter((name) => /^\d+$/.test(name) && name !== "0");
  if (ids.length === 0) return null;
  const loginUsers = await readFile(path.join(root, "config", "loginusers.vdf"), "utf8").catch(() => "");
  const recent = mostRecentAccount(loginUsers);
  if (recent && ids.includes(String(recent.accountId))) {
    return { dir: path.join(userdata, String(recent.accountId)), persona: recent.persona };
  }
  let newest = { id: ids[0] ?? "", time: -1 };
  for (const id of ids) {
    const time = await stat(path.join(userdata, id, "config")).then((info) => info.mtimeMs, () => 0);
    if (time > newest.time) newest = { id, time };
  }
  return { dir: path.join(userdata, newest.id), persona: "" };
}

// Is this app in the Steam library already? "unavailable" when there is no
// Steam this app can add to, no account in it, or a list the add would
// refuse to change: nothing worth offering then.
export async function steamShortcutState(place: InstallPlace, home: string): Promise<"found" | "missing" | "unavailable"> {
  const target = steamTarget(place);
  const root = target ? await findSteamRoot(home) : "";
  const account = root ? await findAccount(root) : null;
  if (!target || !account) return "unavailable";
  const bytes = await readFile(path.join(account.dir, "config", "shortcuts.vdf")).catch((err: NodeJS.ErrnoException) =>
    err.code === "ENOENT" ? Buffer.alloc(0) : null,
  );
  if (!bytes) return "unavailable";
  let list: VdfEntry[];
  try {
    list = parseBinaryVdf(bytes);
  } catch {
    return "unavailable";
  }
  if (bytes.length > 0 && !serializeBinaryVdf(list).equals(bytes)) return "unavailable";
  const shortcuts = findEntry(list, "shortcuts");
  if (!shortcuts) return "missing";
  if (shortcuts.node.type !== "map") return "unavailable";
  // An AppImage a previous add renamed is named by its stable path.
  const formerPaths = place.appImagePath ? [place.appImagePath, stableAppImagePath(place.appImagePath)] : [];
  const wish = { name: SHORTCUT_NAME, target, formerPaths, gridDir: "" };
  return findOurShortcut(shortcuts.node.entries, wish) ? "found" : "missing";
}

const BY_HAND = "Add it from Steam instead: Games, then Add a Non-Steam Game to My Library.";

export async function addToSteam(request: AddToSteamRequest, host: SteamHost): Promise<SteamAddResult> {
  if (!steamTarget(request.place)) {
    return { ok: false, error: "This kind of install cannot be added to Steam from here." };
  }
  if (request.launchedBySteam) {
    return { ok: false, error: "Steam started this run, so the app is in your Steam library already. To add it again, start it from your desktop." };
  }
  const root = await findSteamRoot(request.home);
  if (!root) {
    return {
      ok: false,
      error: existsSync(path.join(request.home, FLATHUB_STEAM))
        ? `Steam here is the Flathub package, which starts games inside its own sandbox and cannot start this app. ${BY_HAND}`
        : "Steam is not installed for this user.",
    };
  }
  const account = await findAccount(root);
  if (!account) return { ok: false, error: "Sign in to Steam once first: it has no account folder yet." };

  const wasRunning = await host.isRunning();
  if (wasRunning && !request.restart) return { ok: true, state: "needs-restart" };
  if (wasRunning) {
    await host.shutdown();
    let waited = 0;
    while ((await host.isRunning()) && waited < SHUTDOWN_WAIT_MS) {
      await host.wait(POLL_MS);
      waited += POLL_MS;
    }
    if (await host.isRunning()) {
      return { ok: false, error: "Steam did not close. Quit it from its menu, then press Add to Steam again." };
    }
  }

  try {
    // An AppImage named with its version is renamed first: the next update
    // would replace it with a file of another name.
    let place = request.place;
    let moved = "";
    const formerPaths = place.appImagePath ? [place.appImagePath] : [];
    if (place.kind === "appimage") {
      const stable = stableAppImagePath(place.appImagePath);
      if (stable !== place.appImagePath) {
        try {
          await rename(place.appImagePath, stable);
          place = { ...place, appImagePath: stable };
          moved = stable;
        } catch {
          // A folder the app cannot write in: the shortcut names the file
          // where it is, as Steam's own dialog would.
        }
      }
    }
    const target = steamTarget(place);
    if (!target) throw new Error("The app's own file was not found.");

    const configDir = path.join(account.dir, "config");
    const gridDir = path.join(configDir, "grid");
    const listFile = path.join(configDir, "shortcuts.vdf");
    const before = await readFile(listFile).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return Buffer.alloc(0);
      throw err;
    });
    let list: VdfEntry[];
    try {
      list = parseBinaryVdf(before);
    } catch {
      return { ok: false, error: `Steam's list of non-Steam games is in a form this app does not know, so it was left alone. ${BY_HAND}` };
    }
    if (before.length > 0 && !serializeBinaryVdf(list).equals(before)) {
      return { ok: false, error: `Steam's list of non-Steam games did not read back exactly, so it was left alone. ${BY_HAND}` };
    }
    const { appid, added } = upsertShortcut(list, { name: SHORTCUT_NAME, target, formerPaths, gridDir });

    await mkdir(gridDir, { recursive: true });
    for (const art of STEAM_ART) {
      await copyFile(path.join(request.artDir, art.source), path.join(gridDir, art.grid(appid)));
    }
    // A whole new file swapped in, so Steam never finds half a list.
    const staged = `${listFile}.odm-new`;
    await writeFile(staged, serializeBinaryVdf(list));
    await rename(staged, listFile);
    return { ok: true, state: added ? "added" : "updated", persona: account.persona, restarted: wasRunning, moved };
  } catch (err) {
    return { ok: false, error: `Steam's library could not be changed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (wasRunning) host.start();
  }
}
