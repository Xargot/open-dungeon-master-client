import { App } from "@capacitor/app";
import { BleClient } from "@capacitor-community/bluetooth-le";
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";
import { CapacitorCookies, CapacitorHttp } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Preferences } from "@capacitor/preferences";
import { plainPreferences, secretStore } from "./secret-store";
import { loadServerSecrets, migrateSecret, readServerList, storeServerSecrets, withoutSecrets } from "./secret-store-core";
import { Share } from "@capacitor/share";
import { BackgroundColor, InAppBrowser, ToolBarType } from "@capgo/inappbrowser";
import { createWebBluetooth } from "./ble-polyfill-core";
import { createBleRelay } from "./ble-relay";
import { createDownloadRelay } from "./download-relay";
import { createDownloadShim, DOWNLOAD_URL_MESSAGE, noticeText } from "./download-shim-core";
import { offerNativeDictation } from "./dictation";
import { createAndroidHomeFeed, HOME_CACHE_KEY } from "./home-feed";
import { fetchCover, fetchIncoming, OdmDownload, renameIncoming, sweepCovers } from "./native-download";
import { createShortCache, createTransitionDebounce } from "./throttle";
import { createIdleStopper, IDLE_STOP_GRACE_MS } from "./world-idle";
import {
  createLocalWorld,
  LocalWorld,
  tokenAlive as profileTokenAlive,
  type LocalProfile,
} from "./local-world";
import { createShareTunnel, type JsonReply, type SharePlugin } from "./share-tunnel";
import {
  CODE_SHAPE,
  normalizeOrigin,
  originCandidates,
  parseAnyLink,
  parseLinkOrAddress,
  codeCandidates,
  parseRoomCode,
  insecureRemoteOrigin,
  trustedTunnelOrigin,
  type JoinLink,
} from "../../src/shared/deep-link";
import {
  createPublishLedger,
  DEFAULT_BROKER_URL,
  parseTableReply,
  refusedAfter,
  TABLE_REFUSED_STATUS,
  tableEndpoint,
} from "../../src/shared/broker";
import {
  COVER_MAX_BYTES,
  coverRequestUrl,
  LOCAL_HOST_ID,
  type HomeCache,
} from "../../src/shared/home-feed-logic";
import { relocateWorld } from "../../src/shared/relocate";
import {
  PORTAL_ORIGIN_COOKIE,
  PORTAL_TOKEN_COOKIE,
  portalEligible,
} from "../../src/shared/portal-logic";
import { landingPath, safeInnerPath } from "../../src/shared/open-path";
import { diagnosticSummary } from "../../src/shared/diagnostics";
import type {
  AccountDeletionResult,
  ConnectResult,
  OdmBridge,
  ShellShareStatus,
  Result,
  ServerProbe,
  ServerSummary,
  ShellEvent,
  SignupMode,
} from "../../src/shared/types";

// The Android implementation of the window.odm bridge. Same shared manager
// UI as the desktop shell; here the privileged side is Capacitor. Server
// pages open in a separate native WebView (no Capacitor bridge injected),
// logged in by planting the odm_session cookie in the shared CookieManager.
// The device hosts its own world too (local-world.ts) and can share it on
// the internet through a tunnel (share-tunnel.ts), like the desktop shell.

interface StoredServer {
  id: string;
  origin: string;
  name: string;
  username: string;
  lastUsedAt: string;
  // Kept in the secret store (secret-store-core.ts: sealed under a Keystore
  // key, left out of backups), never in the saved list itself.
  token: string;
  tokenExpiresAt: string;
  // The password for an account the app made up on the player's behalf
  // (joining by room code), so the session can be renewed without asking
  // for something they were never told. Absent for accounts a person
  // chose a password for.
  secret?: string;
  // Room codes this entry was joined through, newest first, so a world that
  // moved can be found again by the code the player arrived with even when
  // the home screen never listed this host while it was up.
  joinCodes?: string[];
  // The world's stable id from /api/auth/providers ("" or absent on servers
  // that predate it). Lets the shell recognize a device world that came back
  // at a new tunnel address and move this entry there instead of adding a
  // duplicate.
  instanceId?: string;
}

const SERVERS_KEY = "odm-servers";
const TIMEOUT_MS = 10_000;

// ---------- storage ----------

// The ids the saved list held when last read or written, so a server taken
// off it has its secrets removed with it.
let knownServerIds: string[] = [];

async function loadServers(): Promise<StoredServer[]> {
  // A damaged list is kept under a dated key before it reads as empty, so
  // the next save cannot write over the only copy (secret-store-core.ts).
  const parsed = await readServerList<StoredServer>(plainPreferences, SERVERS_KEY);
  // Each entry's token and made-up password come from the secret store; a
  // list saved before the store existed has them moved in, and is saved
  // again without them.
  const { servers, migrated } = await loadServerSecrets(parsed, secretStore);
  knownServerIds = servers.map((server) => server.id);
  if (migrated) {
    await Preferences.set({ key: SERVERS_KEY, value: JSON.stringify(withoutSecrets(servers)) });
  }
  return servers;
}

async function saveServers(servers: StoredServer[]): Promise<void> {
  await storeServerSecrets(servers, secretStore, knownServerIds);
  knownServerIds = servers.map((server) => server.id);
  await Preferences.set({ key: SERVERS_KEY, value: JSON.stringify(withoutSecrets(servers)) });
}

function summaryOf(server: StoredServer): ServerSummary {
  return {
    id: server.id,
    origin: server.origin,
    name: server.name,
    username: server.username,
    lastUsedAt: server.lastUsedAt,
    hasToken: tokenAlive(server),
  };
}

function tokenAlive(server: StoredServer): boolean {
  if (!server.token) return false;
  return !server.tokenExpiresAt || Date.parse(server.tokenExpiresAt) > Date.now();
}

// ---------- HTTP (native, so plain-http LAN servers and no CORS walls) ----------

interface HttpReply {
  status: number;
  data: unknown;
}

async function http(
  origin: string,
  pathname: string,
  init: { method?: string; token?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<HttpReply> {
  try {
    const response = await CapacitorHttp.request({
      url: `${origin}${pathname}`,
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      data: init.body,
      connectTimeout: TIMEOUT_MS,
      readTimeout: init.timeoutMs ?? TIMEOUT_MS,
    });
    return { status: response.status, data: response.data };
  } catch {
    throw new Error(`Could not reach ${origin}. Check the address and your connection.`);
  }
}

function errorText(reply: HttpReply, fallback: string): string {
  const data = reply.data as { error?: string } | null;
  return (data && typeof data.error === "string" && data.error) || fallback;
}

async function probeOrigin(origin: string): Promise<ServerProbe> {
  const reply = await http(origin, "/api/auth/providers");
  const body = reply.data as {
    discord?: boolean;
    password?: boolean;
    signupMode?: string;
    serverName?: string;
    version?: string;
    instanceId?: string;
    deviceWorld?: boolean;
    needsSetup?: boolean;
  } | null;
  if (reply.status !== 200 || !body || typeof body.password !== "boolean") {
    throw new Error(`${origin} does not look like an Open Dungeon Master server.`);
  }
  const signupMode: SignupMode =
    body.signupMode === "invite" || body.signupMode === "closed" ? body.signupMode : "open";
  return {
    origin,
    serverName: typeof body.serverName === "string" ? body.serverName : "",
    version: typeof body.version === "string" ? body.version : "",
    signupMode,
    discord: Boolean(body.discord),
    instanceId: typeof body.instanceId === "string" ? body.instanceId : "",
    // Servers older than 0.16.6 do not say, and are taken for real ones.
    deviceWorld: body.deviceWorld === true,
    needsSetup: body.needsSetup === true,
  };
}

interface TokenGrant {
  token: string;
  expiresAt: string;
  username: string;
}

async function loginForToken(
  origin: string,
  username: string,
  password: string,
): Promise<TokenGrant> {
  const reply = await http(origin, "/api/auth/token", {
    method: "POST",
    body: { username, password },
  });
  if (reply.status !== 200) throw new Error(errorText(reply, "Sign-in failed."));
  const body = reply.data as { token: string; expiresAt: string; user: { username: string } };
  return { token: body.token, expiresAt: body.expiresAt, username: body.user.username };
}

async function registerAccount(
  origin: string,
  input: { username: string; password: string; inviteCode: string; joinCode?: string; setupCode?: string },
): Promise<TokenGrant> {
  const body: Record<string, string> = { username: input.username, password: input.password };
  // The code that claims a server's first account: typed for a real server,
  // the shell's own for the world this device hosts (local-world.ts).
  if (input.setupCode) body.setupCode = input.setupCode;
  if (input.inviteCode) body.inviteCode = input.inviteCode;
  // The room code travels with the registration: on a world an app hosts
  // it is the only door, and on an invite-only server it vouches for the
  // signup. The server looks it up without consuming it, and the same code
  // then seats the player.
  if (input.joinCode) body.joinCode = input.joinCode;
  const reply = await http(origin, "/api/auth/register", { method: "POST", body });
  if (reply.status !== 201) throw new Error(errorText(reply, "Could not create the account."));
  return loginForToken(origin, input.username, input.password);
}

// Self-service account deletion (DELETE /api/profile). Password accounts
// must send their password; Discord-only accounts send "".
async function deleteAccount(
  origin: string,
  token: string,
  password: string,
): Promise<AccountDeletionResult> {
  const reply = await http(origin, "/api/profile", {
    method: "DELETE",
    token,
    body: password ? { password } : {},
  });
  if (reply.status !== 200) throw new Error(errorText(reply, "Could not delete the account."));
  const body = reply.data as { dueAt?: string; graceDays?: number; purged?: boolean } | null;
  return {
    dueAt: typeof body?.dueAt === "string" ? body.dueAt : "",
    graceDays: typeof body?.graceDays === "number" ? body.graceDays : 0,
    purged: body?.purged === true,
  };
}

// /api/auth/me answers 200 with a null user for a dead session, so the
// body decides, not the status.
async function tokenIsValid(origin: string, token: string): Promise<boolean> {
  try {
    const reply = await http(origin, "/api/auth/me", { token });
    const body = reply.data as { user?: unknown } | null;
    return reply.status === 200 && !!body?.user;
  } catch {
    return false;
  }
}

async function patchAdminSettings(origin: string, token: string, patch: object): Promise<void> {
  const reply = await http(origin, "/api/admin/settings", { method: "PATCH", token, body: patch });
  if (reply.status !== 200) throw new Error(errorText(reply, "Saving world settings failed."));
}

async function getAdminSettings(origin: string, token: string): Promise<unknown> {
  const reply = await http(origin, "/api/admin/settings", { token });
  if (reply.status !== 200) throw new Error(errorText(reply, "Reading world settings failed."));
  return reply.data;
}

// The model listings the OpenAI door asks (src/shared/ai-setup.ts). The
// world's server asks the key's provider in turn, so it is given longer.
async function postAdmin(origin: string, token: string, path: string, body: object): Promise<unknown> {
  const reply = await http(origin, path, { method: "POST", token, body, timeoutMs: 30_000 });
  if (reply.status !== 200) throw new Error(errorText(reply, "The world's server refused the request."));
  return reply.data;
}

// ---------- events and the server webview ----------

const listeners = new Set<(event: ShellEvent) => void>();

function emit(event: ShellEvent): void {
  for (const listener of listeners) listener(event);
}

// Android 13+ only shows notifications after a runtime POST_NOTIFICATIONS
// grant, and connecting is the first moment they mean anything (session
// reminders, turn alerts). Asked once per run; the system remembers a grant
// or denial, so repeat connects never nag. Scaffolding only for now: server
// pages run in the InAppBrowser webview, which does not grant the web
// Notification API, so a follow-up must either enable notifications on that
// webview (WebChromeClient permission grant in @capgo/inappbrowser) or
// listen to the server's event stream natively and post through
// LocalNotifications.schedule.
let notificationsAsked = false;

async function ensureNotificationPermission(): Promise<void> {
  if (notificationsAsked) return;
  notificationsAsked = true;
  try {
    const status = await LocalNotifications.checkPermissions();
    if (status.display === "prompt" || status.display === "prompt-with-rationale") {
      await LocalNotifications.requestPermissions();
    }
  } catch {
    // A missing or denied permission must never block connecting.
  }
}

// ---------- Bluetooth dice (Web Bluetooth bridge for the game webview) ----------

// The game pairs Pixels dice via navigator.bluetooth, which the Android
// WebView lacks. A polyfill (built to www/ble-polyfill.js) is injected into
// every server page before its scripts run; it relays GATT calls here over
// the InAppBrowser message channel and this relay runs them natively.
const GRANTED_DICE_KEY = "odm-ble-granted";

// Answers from the native side reach two audiences: a server's page in the
// game webview (through the plugin's channel) and this page's own game
// screens (an in-page event), whichever asked.
const NATIVE_REPLY = "odm-native-reply";

function replyToPages(detail: Record<string, unknown>): void {
  void InAppBrowser.postMessage({ detail }).catch(() => undefined);
  window.dispatchEvent(new CustomEvent(NATIVE_REPLY, { detail }));
}

const bleRelay = createBleRelay({
  ble: BleClient,
  send: (detail) => replyToPages(detail),
  async loadGranted() {
    try {
      const { value } = await Preferences.get({ key: GRANTED_DICE_KEY });
      const parsed = value ? (JSON.parse(value) as string[]) : [];
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
    } catch {
      return [];
    }
  },
  async saveGranted(ids) {
    await Preferences.set({ key: GRANTED_DICE_KEY, value: JSON.stringify(ids) });
  },
});

// ---------- file exports (download bridge for the game webview) ----------
// The game webview has no download handler, so an <a download> click there
// (character-sheet PDF, workshop bundle, story export) would do nothing. A
// shim (built to www/download-shim.js) injected next to the BLE polyfill
// posts the click here: a host file as its address, streamed natively by
// the app's own download plugin; a file the page built (blob:) as bytes.
// The relay parks the file in the app cache and opens the system share
// sheet, where the player saves to Files or Drive or sends the file on. The
// cache folder is covered by the FileProvider the app manifest already
// declares (res/xml/file_paths).
const downloadRelay = createDownloadRelay({
  async writeCache(path, data) {
    const written = await Filesystem.writeFile({
      path,
      data,
      directory: Directory.Cache,
      recursive: true,
    });
    return written.uri;
  },
  async clearCache(path) {
    await Filesystem.rmdir({ path, directory: Directory.Cache, recursive: true });
  },
  fetchToCache: (url, headers) => fetchIncoming(OdmDownload, url, headers),
  renameCache: renameIncoming,
  async share(title, uri) {
    await Share.share({ title, files: [uri] });
  },
  // The message goes to whichever page asked: the game webview renders it
  // as a toast through its shim, this page through showShellToast.
  notify(message) {
    replyToPages({ type: "odm-download-notice", message });
  },
});

// ---------- the same bridges for this page's own game screens ----------
// The native game screens (src/renderer/game) run in this WebView rather
// than the game webview, so the Web Bluetooth stand-in and the download
// bridge are installed here directly, talking to the relays in-process.

const TOAST_MS = 4000;
let shellToast: HTMLDivElement | null = null;
let shellToastTimer: ReturnType<typeof setTimeout> | null = null;

function showShellToast(text: string): void {
  if (!shellToast) {
    shellToast = document.createElement("div");
    shellToast.className = "shell-toast";
    shellToast.setAttribute("role", "status");
  }
  shellToast.textContent = text;
  if (!shellToast.isConnected) document.body.append(shellToast);
  if (shellToastTimer) clearTimeout(shellToastTimer);
  shellToastTimer = setTimeout(() => {
    shellToast?.remove();
    shellToastTimer = null;
  }, TOAST_MS);
}

function installPageBridges(): void {
  const nav = navigator as Navigator & { bluetooth?: unknown };
  if (!nav.bluetooth) {
    Object.defineProperty(nav, "bluetooth", {
      configurable: true,
      value: createWebBluetooth({
        send: (message) => void bleRelay.handleMessage(message).catch(() => undefined),
        onMessage(listener) {
          window.addEventListener(NATIVE_REPLY, (event) => {
            const detail = (event as CustomEvent<Record<string, unknown>>).detail;
            if (detail && typeof detail === "object") listener(detail);
          });
        },
      }),
    });
  }
  const pageOrigin = window.location.origin;
  const shim = createDownloadShim({
    origin: pageOrigin,
    // Only blob: links are fetched here (a root-relative one is posted as
    // an address instead, see below), so this is the page's own fetch.
    fetch: (url) => fetch(url),
    channel: () => ({
      postMessage(message) {
        const detail = (message as { detail?: unknown }).detail ?? message;
        void routeShellDownload(detail).catch(() => undefined);
      },
    }),
  });
  document.addEventListener("click", (event) => shim.onClick(event), true);
  const proto = HTMLAnchorElement.prototype as HTMLAnchorElement & { click(): void };
  const nativeClick = proto.click;
  proto.click = function click(this: HTMLAnchorElement): void {
    if (!shim.handleAnchor(this)) nativeClick.call(this);
  };
  window.addEventListener(NATIVE_REPLY, (event) => {
    const text = noticeText((event as CustomEvent<unknown>).detail);
    if (text) showShellToast(text);
  });
}

// A download from this page's own game screens. A host link there resolves
// against this page (https://localhost/...), so its path is sent to the
// mounted host with that host's session, the way the game runtime's fetch
// would have (src/renderer/game/runtime.ts).
async function routeShellDownload(detail: unknown): Promise<void> {
  const msg = detail as { type?: unknown; url?: unknown; name?: unknown } | null;
  if (!msg || typeof msg !== "object" || msg.type !== DOWNLOAD_URL_MESSAGE) {
    await downloadRelay.handleMessage(detail);
    return;
  }
  const hostId = window.odmMountedHostId ?? "";
  const session = hostId ? await bridge.hostSession(hostId) : null;
  let path = "";
  try {
    const url = new URL(String(msg.url ?? ""));
    if (url.origin === window.location.origin) path = `${url.pathname}${url.search}`;
  } catch {
    // Not an address; refused below.
  }
  if (!session || !path) {
    showShellToast("That download is not from this server.");
    return;
  }
  await downloadRelay.download(`${session.origin}${path}`, String(msg.name ?? ""), {
    authorization: `Bearer ${session.token}`,
  });
}

installPageBridges();
sweepCovers();

// The manager UI ships the game-page scripts as sibling assets. Each is a
// self-contained IIFE, so they concatenate into one preShowScript; a missing
// or failing one must never block connecting, it only disables its feature
// (dice pairing, file exports, the account menu's way back to this list).
const INJECTED_SCRIPTS = ["ble-polyfill.js", "download-shim.js", "shell-hook.js"];

// The game's own night background, painted behind the status bar and the
// navigation bar so the page and the system chrome read as one surface.
const NIGHT = "#0a0817";
let injectedScripts: Promise<string> | null = null;
function loadInjectedScripts(): Promise<string> {
  injectedScripts ??= Promise.all(
    INJECTED_SCRIPTS.map((name) =>
      fetch(name)
        .then((response) => (response.ok ? response.text() : ""))
        .catch(() => ""),
    ),
  ).then((parts) => parts.filter((part) => part.length > 0).join("\n;\n"));
  return injectedScripts;
}

// True while a game web view is up, and which origin it shows: address
// downloads posted from it may only point back at that host.
let gameWebViewOpen = false;
let gameWebViewOrigin = "";

// The shell's contour backdrop is paused under the web view (the native
// game path pauses it through the game layout, chrome.ts). On close it
// resumes only when the shell is not showing the native game, which owns
// that decision itself.
function resumeTopoUnderShell(): void {
  if (document.querySelector(".page.game")) return;
  window.odmTopo?.resume();
}

// Whether the last web view to close showed the device world's own pages.
let closedOwnWorld = false;

// The web view is gone: the manager is back, the backdrop breathes again,
// and the phone's own world gets its grace period before sleeping.
function gameWebViewClosed(): void {
  gameWebViewOpen = false;
  gameWebViewOrigin = "";
  closedOwnWorld = worldPageOpen;
  worldPageOpen = false;
  resumeTopoUnderShell();
  idleWorld.arm();
}

// No toolbar: the page is the app. The status bar and navigation bar keep
// their space (the WebView cannot see them itself), the hardware back
// button walks the page's own history, and at its root it closes the
// page, landing here. The page's account menu offers the same door.
async function openGameWebView(url: string, title: string): Promise<void> {
  const preShowScript = await loadInjectedScripts();
  idleWorld.cancel();
  gameWebViewOpen = true;
  try {
    gameWebViewOrigin = new URL(url).origin;
  } catch {
    gameWebViewOrigin = "";
  }
  window.odmTopo?.pause();
  await InAppBrowser.openWebView({
    url,
    toolbarType: ToolBarType.BLANK,
    toolbarColor: NIGHT,
    backgroundColor: BackgroundColor.BLACK,
    enabledSafeBottomMargin: true,
    activeNativeNavigationForWebview: true,
    title,
    // documentStart injection needs the present-after-load mode; the game's
    // Bluetooth feature detection must run after the polyfill exists.
    ...(preShowScript
      ? {
          isPresentAfterPageLoad: true,
          preShowScript,
          preShowScriptInjectionTime: "documentStart" as const,
        }
      : {}),
  });
  // The system dialog renders above the webview, so asking after the open
  // never delays the connect itself.
  void ensureNotificationPermission();
}

// Portal mode is on unless the player switched it off in Settings.
const PORTAL_PREF_KEY = "odm-portal";

async function portalMode(): Promise<boolean> {
  try {
    return (await Preferences.get({ key: PORTAL_PREF_KEY })).value !== "off";
  } catch {
    return true;
  }
}

// The phone has one cookie jar, so the portal cookies on the local origin
// must go before the device world's own pages open there, and come back
// only when a host is visited through the portal.
async function clearPortalCookies(localOrigin: string): Promise<void> {
  for (const key of [PORTAL_ORIGIN_COOKIE, PORTAL_TOKEN_COOKIE]) {
    await CapacitorCookies.deleteCookie({ url: localOrigin, key }).catch(() => undefined);
  }
}

// Portal mode: the world on this phone serves the screens and forwards
// data calls to the host, so the controls are the app's own and the
// tunnel carries game data only. Falls back to the host's own pages when
// the player has it off, the host is too old for this UI, or the device
// world will not start.
async function openThroughPortal(server: StoredServer, pathname: string): Promise<boolean> {
  if (!(await portalMode())) return false;
  const world = await localWorld.status();
  if (world.state === "unavailable") return false;
  let remoteVersion = "";
  try {
    remoteVersion = (await probeOrigin(server.origin)).version;
  } catch {
    return false;
  }
  if (!portalEligible({ bundled: world.serverVersion, remote: remoteVersion }).ok) return false;
  let origin: string;
  try {
    origin = await localWorld.start();
  } catch {
    return false;
  }
  await CapacitorCookies.setCookie({ url: origin, key: PORTAL_ORIGIN_COOKIE, value: server.origin });
  await CapacitorCookies.setCookie({ url: origin, key: PORTAL_TOKEN_COOKIE, value: server.token });
  // The world on this phone only forwards to the host while both cookies
  // are really in the jar; without them it answers the host's campaign
  // paths out of its own database ("Campaign not found."). A jar that did
  // not take them means the host opens its own pages instead.
  const jar = await CapacitorCookies.getCookies({ url: origin }).catch(
    () => ({}) as Record<string, string>,
  );
  if (jar[PORTAL_ORIGIN_COOKIE] !== server.origin || !jar[PORTAL_TOKEN_COOKIE]) {
    await clearPortalCookies(origin);
    return false;
  }
  worldPageOpen = false;
  await openGameWebView(`${origin}${pathname}`, server.name);
  return true;
}

async function openServer(server: StoredServer, joinCode: string, path = ""): Promise<void> {
  const pathname = landingPath(joinCode, path);
  if (await openThroughPortal(server, pathname)) return;
  await CapacitorCookies.setCookie({
    url: server.origin,
    key: "odm_session",
    value: server.token,
  });
  worldPageOpen = false;
  await openGameWebView(`${server.origin}${pathname}`, server.name);
}

// ---------- the device-hosted world ----------

// The on-device profile lives in the secret store (secret-store-core.ts);
// the world's data itself is the server's SQLite file in the app's files
// directory (WorldRuntime.java).
const LOCAL_PROFILE_KEY = "odm-local-profile";

function randomSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

// The profile is the device world's own account (its password and token),
// so it lives in the secret store too; one saved before that is moved in.
async function loadLocalProfile(): Promise<LocalProfile | null> {
  try {
    const value = await migrateSecret(LOCAL_PROFILE_KEY, secretStore, plainPreferences);
    const parsed = value ? (JSON.parse(value) as LocalProfile) : null;
    return parsed && typeof parsed.username === "string" ? parsed : null;
  } catch {
    return null;
  }
}

const localWorld = createLocalWorld({
  plugin: LocalWorld,
  fetchJson,
  loadProfile: loadLocalProfile,
  async saveProfile(profile) {
    if (profile) {
      await secretStore.set(LOCAL_PROFILE_KEY, JSON.stringify(profile));
    } else {
      await secretStore.remove(LOCAL_PROFILE_KEY);
    }
    await Preferences.remove({ key: LOCAL_PROFILE_KEY });
  },
  loginForToken,
  registerAccount,
  tokenIsValid,
  patchAdminSettings,
  getAdminSettings,
  postAdmin,
  async plantSession(origin, token) {
    await clearPortalCookies(origin);
    await CapacitorCookies.setCookie({ url: origin, key: "odm_session", value: token });
  },
  async open(origin, token, joinCode, path) {
    await clearPortalCookies(origin);
    await CapacitorCookies.setCookie({ url: origin, key: "odm_session", value: token });
    worldPageOpen = true;
    await openGameWebView(`${origin}${landingPath(joinCode, path)}`, "This device");
  },
  emit,
  randomSecret,
  currentShareUrl: () => shareTunnel.snapshot().url,
});

// ---------- sharing the world on the internet ----------

// True while the game webview shows this device's own world; only then may
// a page's odmShell.share requests do anything.
let worldPageOpen = false;

// Native JSON round trip that reports bad statuses instead of throwing;
// only no reply at all rejects. Shared by the tunnel and the home feed.
async function fetchJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<JsonReply> {
  const timeout = init.timeoutMs ?? TIMEOUT_MS;
  const response = await CapacitorHttp.request({
    url,
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    data: init.body,
    connectTimeout: timeout,
    readTimeout: timeout,
    responseType: "json",
  });
  let data: unknown = response.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      // Not JSON (a health page, an error body); the caller only needs the status then.
    }
  }
  return { status: response.status, data };
}

// The room code registry. A campaign's code never changes; the address
// this phone answers at changes with every share session, so while the
// world is shared each code its owner holds is pointed at the address of
// the moment. One code, typed by a friend, then lands on this table
// however the tunnel moved. Best effort throughout: a phone that cannot
// reach the broker still shares by link and QR.
const TABLE_SECRET_PREFIX = "odm-table-secret:";
let publishedCodes: string[] = [];
// Codes the registry is refusing from this phone (another device holds
// them), reported to the lobby with the share status.
let refusedRoomCodes: string[] = [];

function setRefusedRoomCodes(next: string[]): void {
  const changed = next.join() !== refusedRoomCodes.join();
  refusedRoomCodes = next;
  if (changed && worldPageOpen) void shellShareStatus().then((status) => pushShareStatus(undefined, status));
}
// Which codes the registry already holds at the current address, so the
// minute-by-minute republish only sends what changed.
const publishLedger = createPublishLedger();

async function tableSecretFor(code: string): Promise<string> {
  const key = `${TABLE_SECRET_PREFIX}${code}`;
  const existing = await migrateSecret(key, secretStore, plainPreferences);
  if (existing && existing.length >= 16) return existing;
  const secret = randomSecret() + randomSecret();
  await secretStore.set(key, secret);
  return secret;
}

async function ownedRoomCodes(origin: string, token: string): Promise<string[]> {
  const reply = await fetchJson(`${origin}/api/campaigns`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  const list = (reply?.data as { campaigns?: unknown } | null)?.campaigns;
  if (reply?.status !== 200 || !Array.isArray(list)) return [];
  const codes: string[] = [];
  for (const raw of list) {
    const entry = raw as { inviteCode?: unknown; role?: unknown } | null;
    if (!entry || entry.role !== "owner") continue;
    const code = String(entry.inviteCode ?? "").trim().toUpperCase();
    if (CODE_SHAPE.test(code) && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

// The codes last published live in Preferences, not only in memory, so a
// process the OS killed while sharing can still take them offline on the
// next start rather than leave a friend's code pointing at a dead address.
const PUBLISHED_CODES_KEY = "odm-published-codes";

async function loadPublishedCodes(): Promise<string[]> {
  try {
    const raw = (await Preferences.get({ key: PUBLISHED_CODES_KEY })).value;
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((code) => typeof code === "string") : [];
  } catch {
    return [];
  }
}

async function savePublishedCodes(codes: readonly string[]): Promise<void> {
  await Preferences.set({ key: PUBLISHED_CODES_KEY, value: JSON.stringify(codes) });
}

async function publishRoomCodes(url: string): Promise<void> {
  const profile = await loadLocalProfile();
  const status = await localWorld.status();
  if (!profile?.token || !status.origin || !url) return;
  const codes = await ownedRoomCodes(status.origin, profile.token);
  const due = publishLedger.due(codes, url);
  const published = codes.filter((code) => !due.includes(code));
  const refused: string[] = [];
  for (const code of due) {
    const reply = await fetchJson(tableEndpoint(DEFAULT_BROKER_URL, code), {
      method: "PUT",
      headers: { "x-table-secret": await tableSecretFor(code) },
      body: { url },
    }).catch(() => null);
    if (reply?.status === TABLE_REFUSED_STATUS) refused.push(code);
    if (!reply || reply.status < 200 || reply.status >= 300) continue;
    published.push(code);
    publishLedger.sent([code], url);
  }
  setRefusedRoomCodes(refusedAfter(refusedRoomCodes, { codes, published, refused }));
  // A code the registry refused (claimed from another device) stays listed
  // so it is at least dropped with the rest later.
  const before = await loadPublishedCodes();
  publishedCodes = [...new Set([...published, ...before])];
  await savePublishedCodes(publishedCodes);
}

async function unpublishRoomCodes(): Promise<void> {
  const codes = [...new Set([...publishedCodes, ...(await loadPublishedCodes())])];
  publishedCodes = [];
  setRefusedRoomCodes([]);
  publishLedger.clear();
  await savePublishedCodes([]);
  for (const code of codes) {
    await fetchJson(tableEndpoint(DEFAULT_BROKER_URL, code), {
      method: "DELETE",
      headers: { "x-table-secret": await tableSecretFor(code) },
    }).catch(() => undefined);
  }
}

// Sharing is a span, not a moment: a campaign opened while shared gets its
// code published too, and the registry's claim is refreshed, by running the
// publish again every so often for as long as the address is up.
const REPUBLISH_MS = 60_000;
let republishTimer: ReturnType<typeof setInterval> | null = null;
let sharedUrl = "";

function keepRoomCodesPublished(url: string): void {
  sharedUrl = url;
  if (republishTimer) {
    clearInterval(republishTimer);
    republishTimer = null;
  }
  if (!url) return;
  republishTimer = setInterval(() => {
    void republishTick();
  }, REPUBLISH_MS);
}

// Each tick looks before it publishes: a tunnel that died (or was ended
// from the notification) must not have its address put back on the
// registry. status() itself tears the share down when the process is
// gone, and that teardown publishes "" which clears this interval.
async function republishTick(): Promise<void> {
  if (!sharedUrl) return;
  const status = await shareTunnel.status().catch(() => null);
  if (status?.state === "running" && sharedUrl) {
    await publishRoomCodes(sharedUrl);
    return;
  }
  keepRoomCodesPublished("");
  await unpublishRoomCodes();
}

// Room codes seen on a host, newest campaign first. These are the keys the
// broker's table registry answers "where is that world now" for, which is how
// a saved entry finds a world that came back at a new address.
async function tableCodesFor(id: string): Promise<string[]> {
  const raw = (await Preferences.get({ key: HOME_CACHE_KEY })).value;
  let cache: HomeCache | null = null;
  try {
    cache = raw ? (JSON.parse(raw) as HomeCache) : null;
  } catch {
    cache = null;
  }
  const codes: string[] = [];
  // The codes the player joined through come first: they exist even when
  // the home screen never drew this host while it was up.
  const servers = await loadServers();
  for (const code of servers.find((entry) => entry.id === id)?.joinCodes ?? []) {
    if (code && !codes.includes(code)) codes.push(code);
  }
  for (const campaign of cache?.[id]?.campaigns ?? []) {
    const code = (campaign.inviteCode ?? "").trim().toUpperCase();
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

// The room code an entry was just joined through, kept newest first on the
// entry itself, so a world that moved can be found again by it.
async function rememberJoinCode(id: string, code: string): Promise<void> {
  const clean = (code || "").trim().toUpperCase();
  if (!clean) return;
  const servers = await loadServers();
  const server = servers.find((entry) => entry.id === id);
  if (!server) return;
  const rest = (server.joinCodes ?? []).filter((entry) => entry !== clean);
  server.joinCodes = [clean, ...rest].slice(0, 8);
  await saveServers(servers);
}

// Where a table is right now, or "" when nobody has it online.
async function resolveRoomCode(code: string): Promise<string> {
  const reply = await fetchJson(tableEndpoint(DEFAULT_BROKER_URL, code)).catch(() => null);
  if (!reply || reply.status !== 200) return "";
  return parseTableReply(reply.data);
}

// Where a saved world is now, moving the entry as a side effect, or "" when
// it is not to be found. Shared by the home feed (a host drawn offline is not
// even tappable) and the connect path.
async function relocateSaved(id: string, origin: string): Promise<string> {
  const servers = await loadServers();
  const server = servers.find((entry) => entry.id === id);
  if (!server) return "";
  const located = await relocateWorld(
    {
      origin: server.origin,
      instanceId: server.instanceId ?? "",
      codes: await tableCodesFor(server.id),
    },
    { probe: (target) => probeOrigin(target).catch(() => null), resolveTable: resolveRoomCode },
  );
  if (!located.found || !located.moved) return "";
  server.origin = located.origin;
  server.lastUsedAt = new Date().toISOString();
  await saveServers(servers);
  return located.origin === origin ? "" : located.origin;
}

const shareTunnel = createShareTunnel({
  plugin: LocalWorld as unknown as SharePlugin,
  fetchJson,
  brokerUrl: () => "",
  async worldPort() {
    const origin = await localWorld.start();
    return Number(new URL(origin).port);
  },
  // The tunnel calls this on the way up with the address, and on the way
  // down with "". Both the app's Share button and the game's invite dialog
  // reach it, which is why the room codes follow the address from here
  // rather than from either button.
  publish: async (url) => {
    await localWorld.publish(url);
    keepRoomCodesPublished(url);
    if (url) await publishRoomCodes(url);
    else await unpublishRoomCodes();
  },
  emit,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});

// News from the native side: cloudflared or the Node server leaving, or a
// stop finishing. The tunnel side lets go of a dead address at once (the
// room codes and the game's publicUrl follow through publish("")); a dead
// world takes any tunnel down with it, since there is nothing behind it.
localWorld.watch((event) => {
  if (event.source === "tunnel") {
    if (event.state !== "running") void shareTunnel.dropped(event.state, event.message ?? "");
    return;
  }
  if (event.state !== "running" && shareTunnel.snapshot().state !== "stopped") {
    void shareTunnel.stop();
  }
});

// A world that came up, went down or moved makes the last status() answer
// stale; between such moments a second or two of memory folds the native
// game screens' repeated asks into one plugin call.
const LOCAL_STATUS_TTL_MS = 1500;
const localStatusCached = createShortCache(LOCAL_STATUS_TTL_MS, () => localWorld.status());
listeners.add((event) => {
  if (event.kind === "local-status") localStatusCached.clear();
});

// The phone's own world goes to sleep a little after the game web view
// closes, unless it is shared (online or on the Wi-Fi), the app's own
// screens are on it, or a web view is up again. Waking it later is what
// every door here does anyway.
const idleWorld = createIdleStopper({
  graceMs: IDLE_STOP_GRACE_MS,
  inspect: async () => {
    const tunnel = shareTunnel.snapshot().state;
    const onWifi = !!(await localWorld.status().catch(() => null))?.lanOrigin;
    return {
      shared: tunnel === "running" || tunnel === "starting" || onWifi,
      nativeWorldOpen: window.odmMountedHostId === LOCAL_HOST_ID,
      webViewOpen: gameWebViewOpen,
      ownWorldLeft: closedOwnWorld,
    };
  },
  async stop() {
    const status = await localWorld.status();
    if (status.state !== "running" || !status.origin) return;
    // The portal cookies only mean something while a host's pages are up.
    await clearPortalCookies(status.origin);
    await localWorld.stop();
  },
});

const SHARE_UNSUPPORTED: ShellShareStatus = {
  supported: false,
  state: "stopped",
  url: "",
  mode: "",
  error: "",
  lanUrl: "",
};

async function shellShareStatus(): Promise<ShellShareStatus> {
  if (!worldPageOpen) return SHARE_UNSUPPORTED;
  const [status, world] = await Promise.all([shareTunnel.status(), localWorld.status()]);
  return { supported: true, ...status, lanUrl: world.lanOrigin, refusedCodes: refusedRoomCodes };
}

// Down to the game page's shell hook (shell-hook.ts): an answer to one
// request when id is given, otherwise a broadcast to its subscribers.
function pushShareStatus(id: number | undefined, status: ShellShareStatus): void {
  void InAppBrowser.postMessage({
    detail: { type: "odm-share-status", id, status },
  }).catch(() => undefined);
}

listeners.add((event) => {
  if (event.kind !== "tunnel-status" || !worldPageOpen) return;
  void localWorld.status().then((world) => {
    pushShareStatus(undefined, { supported: true, ...event.status, lanUrl: world.lanOrigin });
  });
});

// ---------- the home screen's campaign feed ----------

const homeFeed = createAndroidHomeFeed({
  async servers() {
    return (await loadServers()).map((server) => ({
      id: server.id,
      origin: server.origin,
      name: server.name,
      username: server.username,
      lastUsedAt: server.lastUsedAt,
      token: tokenAlive(server) ? server.token : "",
    }));
  },
  localStatus: () => localWorld.status(),
  async localToken() {
    const profile = await loadLocalProfile();
    return profileTokenAlive(profile) ? (profile?.token ?? "") : "";
  },
  fetchJson,
  getPref: async (key) => (await Preferences.get({ key })).value,
  setPref: async (key, value) => Preferences.set({ key, value }),
  emit,
  relocate: async (input) =>
    input.kind === "local" || input.id === LOCAL_HOST_ID
      ? ""
      : relocateSaved(input.id, input.origin),
});

// The world coming up or going down, or the tunnel doing the same, is a
// reason to look again; the feed announces the outcome itself as a
// home-feed event. Only settled transitions count, and a burst of them
// (starting, running, and the repeat announces around a start) becomes one
// refresh, since each one asks every saved host for its campaigns.
const FEED_REFRESH_DELAY_MS = 1500;
const feedRefresh = createTransitionDebounce({
  delayMs: FEED_REFRESH_DELAY_MS,
  fire: () => void homeFeed.refresh().catch(() => undefined),
});
listeners.add((event) => {
  if (event.kind === "local-status" || event.kind === "tunnel-status") {
    feedRefresh.notice(event.kind, event.status.state);
  }
});

// The lobby's invite dialog asks to share the world (or stop). A start is
// answered at once with the "starting" snapshot and a stop with the
// "stopped" one; the outcome reaches the page through the broadcast above,
// since a tunnel can take longer to come up (or to be cancelled while
// coming up) than a page should wait on one request.
async function handleShareRequest(request: { action: string; id?: number }): Promise<void> {
  const id = typeof request.id === "number" ? request.id : undefined;
  if (!worldPageOpen) {
    pushShareStatus(id, SHARE_UNSUPPORTED);
    return;
  }
  if (request.action === "start") {
    void shareTunnel.start();
    pushShareStatus(id, { ...(await shellShareStatus()), state: "starting", error: "" });
    return;
  }
  if (request.action === "stop") {
    void shareTunnel.stop();
    const world = await localWorld.status();
    pushShareStatus(id, {
      supported: true,
      state: "stopped",
      url: "",
      mode: "",
      error: "",
      lanUrl: world.lanOrigin,
    });
    return;
  }
  pushShareStatus(id, await shellShareStatus());
}

// ---------- Discord sign-in (the server's own OAuth, in the game webview) ----------

// The round trip starts on the server, visits discord.com and lands back on
// the server with the odm_session cookie set in the shared CookieManager.
// The webview stays open as the game; this side only harvests the session
// so the server list can remember the account like a password login.
const SESSION_COOKIE = "odm_session";
// The server's session TTL; the cookie's own expiry is not readable here.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface PendingDiscord {
  origin: string;
  joinCode: string;
  resolve: (result: Result<{ server: ServerSummary }>) => void;
}

let pendingDiscord: PendingDiscord | null = null;

function settleDiscord(result: Result<{ server: ServerSummary }>): void {
  const pending = pendingDiscord;
  pendingDiscord = null;
  pending?.resolve(result);
}

async function startDiscordLogin(
  origin: string,
  joinCode: string,
): Promise<Result<{ server: ServerSummary }>> {
  settleDiscord(fail(new Error("Sign-in was interrupted.")));
  // A stale session cookie would make the callback look like a fresh one.
  await CapacitorCookies.clearCookies({ url: origin }).catch(() => undefined);
  const next = joinCode ? `/join/${joinCode}` : "/";
  const start = `${origin}/api/auth/discord/start?next=${encodeURIComponent(next)}`;
  let name = "";
  try {
    name = (await probeOrigin(origin)).serverName;
  } catch {
    // Cosmetic; the start route will say if the server is not real.
  }
  return new Promise((resolve) => {
    pendingDiscord = { origin, joinCode, resolve };
    openGameWebView(start, name || new URL(origin).host).catch((err: unknown) => {
      settleDiscord(fail(err));
    });
  });
}

// Every navigation inside the game webview: while a Discord sign-in is
// pending, a return to the server's origin is the callback having finished,
// one way or the other.
async function onWebviewUrl(url: string): Promise<void> {
  const pending = pendingDiscord;
  if (!pending || !url.startsWith(`${pending.origin}/`) && url !== pending.origin) return;
  if (url.includes("/api/auth/discord/")) return;
  let failed = "";
  try {
    failed = new URL(url).searchParams.get("error") ?? "";
  } catch {
    return;
  }
  if (failed) {
    // Every error the callback can end on settles the sign-in; the server's
    // own words for it (src/app/AuthForm.tsx), so a refused signup says why
    // rather than hanging the promise forever.
    await InAppBrowser.close().catch(() => undefined);
    gameWebViewClosed();
    const text =
      failed === "signups_disabled"
        ? "Signups are disabled on this server."
        : failed === "invite_required"
          ? "This server needs an invite code or a live room code to create an account."
          : failed === "invite_invalid"
            ? "That invite code is not valid (or has been used up)."
            : "Discord sign-in failed. Try again.";
    settleDiscord(fail(new Error(text)));
    return;
  }
  const cookies = await InAppBrowser.getCookies({ url: pending.origin, includeHttpOnly: true }).catch(
    () => ({}) as Record<string, string>,
  );
  const token = cookies[SESSION_COOKIE];
  if (!token) return;
  try {
    const reply = await http(pending.origin, "/api/auth/me", { token });
    const body = reply.data as { user?: { username?: string } } | null;
    const username = body?.user?.username;
    if (reply.status !== 200 || typeof username !== "string") {
      throw new Error("The sign-in did not produce a usable session.");
    }
    const grant: TokenGrant = {
      token,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      username,
    };
    settleDiscord(await rememberGrant(pending.origin, grant));
  } catch (err) {
    await InAppBrowser.close().catch(() => undefined);
    gameWebViewClosed();
    settleDiscord(fail(err));
  }
}

// Whether a saved session still opens a world: "ok", "rejected" (the host
// answered and does not know it) or "unreachable" (nothing answered). The
// two failures are different news: a rejected session wants a sign-in, an
// unreachable host wants the player told it is not online.
async function sessionStateAt(
  origin: string,
  token: string,
): Promise<"ok" | "rejected" | "unreachable"> {
  try {
    const reply = await http(origin, "/api/auth/me", { token });
    if (reply.status !== 200) return "rejected";
    const body = reply.data as { user?: unknown } | null;
    return body?.user ? "ok" : "rejected";
  } catch {
    return "unreachable";
  }
}

async function connectById(id: string, joinCode: string, path = ""): Promise<ConnectResult> {
  const servers = await loadServers();
  const server = servers.find((entry) => entry.id === id);
  if (!server) return { ok: false, needsLogin: false, error: "Unknown server." };
  const notOnline = (): ConnectResult => ({
    ok: false,
    needsLogin: false,
    error: `${server.name} is not online right now. Ask the host to share their world, then try again.`,
  });
  // Who answers at the address on file, before anything secret is sent
  // there: a tunnel hostname is handed out per session and can later belong
  // to somebody else's world, and a world one of the apps hosts answers at
  // a new address every time it is shared again.
  let probe = await probeOrigin(server.origin).catch(() => null);
  const strangerOnFile =
    probe !== null && !!server.instanceId && probe.instanceId !== server.instanceId;
  if (!probe || strangerOnFile) {
    // Nothing there, or the wrong world: ask the registry where this
    // world's room codes point today. Without this a returning player was
    // told to sign in, and on a device world the only door that screen
    // offered was a new account: a second character and no way back.
    const moved = await relocateSaved(server.id, server.origin).catch(() => "");
    if (!moved) return notOnline();
    server.origin = moved;
    probe = await probeOrigin(server.origin).catch(() => null);
    if (!probe) return notOnline();
  }
  if (probe.instanceId && server.instanceId !== probe.instanceId) {
    server.instanceId = probe.instanceId;
  }
  let session = tokenAlive(server) ? await sessionStateAt(server.origin, server.token) : "rejected";
  if (session === "unreachable") return notOnline();
  if (session === "rejected") {
    // An account the app made up a password for (joined by room code) must
    // never be asked for it: nobody was ever told what it is. Renew with
    // the stored one, and keep the sign-in form for accounts whose
    // password a person actually chose.
    if (server.secret) {
      try {
        const grant = await loginForToken(server.origin, server.username, server.secret);
        server.token = grant.token;
        server.tokenExpiresAt = grant.expiresAt;
        server.username = grant.username;
        session = "ok";
      } catch {
        // The password no longer works (changed, or the account is gone).
      }
    }
    if (session !== "ok") {
      await saveServers(servers);
      return {
        ok: false,
        needsLogin: true,
        error: probe.deviceWorld
          ? "Your seat at this world could not be reopened. Join again with a name, and ask the host to remove the old one."
          : "Your session expired. Sign in again.",
      };
    }
  }
  server.lastUsedAt = new Date().toISOString();
  await saveServers(servers);
  if (joinCode) await rememberJoinCode(server.id, joinCode);
  await openServer(server, joinCode, path);
  return { ok: true };
}

// Writes a fresh session into the server list (new entry or refreshed
// token) without opening anything.
async function rememberGrant(
  origin: string,
  grant: TokenGrant,
  secret?: string,
): Promise<{ ok: true; server: ServerSummary; stored: StoredServer }> {
  let name = "";
  let instanceId = "";
  try {
    const probe = await probeOrigin(origin);
    name = probe.serverName;
    instanceId = probe.instanceId;
  } catch {
    // Cosmetic; the login already proved the server is real.
  }
  const servers = await loadServers();
  // Dedupe by origin first, then by the world's stable id: a device world
  // back at a new tunnel address refreshes its old entry instead of adding
  // a second one.
  const existing =
    servers.find((entry) => entry.origin === origin) ??
    (instanceId ? servers.find((entry) => entry.instanceId === instanceId) : undefined);
  // A stored password belongs to one account: signing in to the same host
  // as somebody else must not keep the old one.
  const sameAccount = !existing || existing.username === grant.username;
  const server: StoredServer = {
    id: existing?.id ?? crypto.randomUUID(),
    origin,
    name: name || new URL(origin).host,
    username: grant.username,
    lastUsedAt: new Date().toISOString(),
    token: grant.token,
    tokenExpiresAt: grant.expiresAt,
    secret: secret ?? (sameAccount ? existing?.secret : undefined),
    instanceId: instanceId || existing?.instanceId,
    joinCodes: existing?.joinCodes,
  };
  if (existing) servers[servers.indexOf(existing)] = server;
  else servers.push(server);
  await saveServers(servers);
  return { ok: true, server: summaryOf(server), stored: server };
}

async function adoptGrant(
  origin: string,
  grant: TokenGrant,
  joinCode: string,
  secret?: string,
): Promise<Result<{ server: ServerSummary }>> {
  const remembered = await rememberGrant(origin, grant, secret);
  if (joinCode) await rememberJoinCode(remembered.stored.id, joinCode);
  await openServer(remembered.stored, joinCode);
  return { ok: true, server: remembered.server };
}

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : "Something went wrong." };
}

function cleanCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return CODE_SHAPE.test(code) ? code : "";
}

// ---------- deep links (odm:// and https://opendungeonmaster.com/j) ----------

async function handleJoinLink(link: JoinLink): Promise<void> {
  const servers = await loadServers();
  let known = servers.find((entry) => entry.origin === link.origin);
  if (!known) {
    // A device world gets a fresh tunnel hostname every share session. If
    // the server at the new address identifies as a world this app already
    // has an account on, move that entry to the new address and walk in
    // with the stored token instead of asking for a second login.
    // The world's id is public, so the address itself has to be one a
    // stranger could not have chosen (a tunnel hostname), or one the
    // registry confirms the code points at; a crafted link naming any other
    // origin gets the add screen, never the saved session.
    try {
      const probe = await probeOrigin(link.origin);
      const match = probe.instanceId
        ? servers.find((entry) => entry.instanceId === probe.instanceId)
        : undefined;
      // Never from https to plain http on the open internet.
      const trusted =
        !!match &&
        !(match.origin.startsWith("https:") && insecureRemoteOrigin(link.origin)) &&
        (trustedTunnelOrigin(link.origin) ||
          (!!link.code && (await resolveRoomCode(link.code)) === link.origin));
      if (match && trusted) {
        match.origin = link.origin;
        match.lastUsedAt = new Date().toISOString();
        await saveServers(servers);
        known = match;
      }
    } catch {
      // Unreachable or not an ODM server; the add screen will say so.
    }
  }
  if (known) {
    const result = await connectById(known.id, link.code);
    if (result.ok) return;
  }
  emit({
    kind: "join-request",
    origin: link.origin,
    code: link.code,
    knownServerId: known?.id ?? "",
  });
}

async function handleLink(raw: string): Promise<void> {
  const link = parseAnyLink(raw);
  if (link) await handleJoinLink(link);
}

// ---------- the bridge ----------

const bridge: OdmBridge = {
  platform: "android",
  // What the phone can draw (docs/vtt-parity-implementation-plan.md 18.2,
  // phase 16): under 4 GB the server screens start with effects low.
  deviceClass: (navigator as { deviceMemory?: number }).deviceMemory !== undefined && (navigator as { deviceMemory?: number }).deviceMemory! < 4 ? "low" : "standard",
  // A short buzz (phase 17) through the WebView's own motor; a phone that
  // has none, or a user who turned vibration off, feels nothing.
  haptic(kind) {
    const pattern = kind === "crit" ? [30, 40, 60] : kind === "hit" ? [40] : kind === "turn" ? [20, 60, 20] : [12];
    try {
      navigator.vibrate?.(pattern);
    } catch {
      // no motor
    }
  },
  // A host document (a PDF page set, phase 21) fetched with the session
  // into the app's cache and handed to the system viewer through the share
  // sheet, the same road a download takes.
  async openDocument(path) {
    const target = String(path ?? "");
    if (!target.startsWith("/")) return false;
    const hostId = window.odmMountedHostId ?? "";
    const session = hostId ? await bridge.hostSession(hostId) : null;
    if (!session) return false;
    const name = target.split("?")[0]?.split("/").pop() || "document.pdf";
    return downloadRelay.download(`${session.origin}${target}`, name, {
      authorization: `Bearer ${session.token}`,
    });
  },

  async listServers() {
    const servers = await loadServers();
    servers.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    return {
      servers: servers.map(summaryOf),
      local: await localWorld.status(),
      tunnel: await shareTunnel.status(),
    };
  },

  async probeServer(raw: string) {
    let lastError: unknown = null;
    for (const origin of originCandidates(String(raw ?? ""))) {
      try {
        return { ok: true, probe: await probeOrigin(origin) };
      } catch (err) {
        lastError = err;
      }
    }
    return fail(lastError ?? new Error("That does not look like a server address."));
  },

  async login(input) {
    try {
      const origin = normalizeOrigin(String(input?.origin ?? ""));
      if (!origin) return fail(new Error("Bad server address."));
      const grant = await loginForToken(origin, String(input.username), String(input.password));
      return await adoptGrant(origin, grant, cleanCode(input.joinCode));
    } catch (err) {
      return fail(err);
    }
  },

  async register(input) {
    try {
      const origin = normalizeOrigin(String(input?.origin ?? ""));
      if (!origin) return fail(new Error("Bad server address."));
      const joinCode = cleanCode(input.joinCode);
      // Joining by room code asks for a name and nothing else, so the
      // password is the app's business: minted here and kept with the
      // entry, the way the device world's own profile works.
      const generated = input.generated === true;
      const password = generated ? randomSecret() + randomSecret() : String(input.password);
      const grant = await registerAccount(origin, {
        username: String(input.username),
        password,
        inviteCode: String(input.inviteCode ?? "").trim(),
        joinCode,
        setupCode: String(input.setupCode ?? "").trim().slice(0, 40),
      });
      return await adoptGrant(origin, grant, joinCode, generated ? password : undefined);
    } catch (err) {
      return fail(err);
    }
  },

  async discordLogin(input) {
    const origin = normalizeOrigin(String(input?.origin ?? ""));
    if (!origin) return fail(new Error("Bad server address."));
    return startDiscordLogin(origin, cleanCode(input.joinCode));
  },

  connect: (serverId, joinCode, path) =>
    connectById(String(serverId), cleanCode(joinCode), safeInnerPath(path)),

  // Back on the home screen: finish the activity, which is what Android
  // users expect from a root screen (the launcher, not a dead tap).
  leaveApp: () => App.exitApp(),

  // A pasted invite, room code or bare server address takes the same path
  // as a scan.
  async openInviteLink(raw) {
    const text = String(raw ?? "");
    // A room code is a campaign's own code and names no address: the
    // registry says where that table is right now, which is what lets one
    // code outlive the tunnel it was shared on.
    const bare = codeCandidates(text);
    if (bare.table || bare.hostOrigin) {
      // Registry first, host shape second: the two code shapes overlap, so
      // shape alone cannot say which one was typed.
      // The registry is cleared best effort when a host stops sharing, so
      // an answer is a lead, not a promise: the address is probed before
      // the player is sent there, and a dead one reads as "not online".
      const found = bare.table ? await resolveRoomCode(bare.table) : "";
      if (found && (await probeOrigin(found).catch(() => null))) {
        await handleJoinLink({ origin: found, code: bare.table });
        return true;
      }
      if (bare.hostOrigin) {
        try {
          await probeOrigin(bare.hostOrigin);
        } catch {
          return false;
        }
        await handleJoinLink({ origin: bare.hostOrigin, code: "" });
        return true;
      }
      return false;
    }
    const link = parseLinkOrAddress(text);
    if (!link) return false;
    // A room code names the broker hostname it expands to and nothing
    // else, so a stale or mistyped one points at a world that is not
    // there. Probe before sending the player on: false puts the reason in
    // the add screen's field instead of at a sign-in for nothing.
    if (parseRoomCode(text)) {
      const servers = await loadServers();
      if (!servers.some((entry) => entry.origin === link.origin)) {
        try {
          await probeOrigin(link.origin);
        } catch {
          return false;
        }
      }
    }
    await handleJoinLink(link);
    return true;
  },

  // The in-app QR path: an invite (room code plus server) or a bare server
  // address, which is what the server's own corner QR button shows. The
  // plugin owns the camera UI and its runtime permission prompt.
  async scanInvite() {
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      });
      const raw = String(result.ScanResult ?? "").trim();
      if (!raw) return { ok: true };
      const link = parseLinkOrAddress(raw);
      if (!link) {
        return {
          ok: false,
          error: "That QR code is not an Open Dungeon Master invite or server address.",
        };
      }
      // A bare address is the same path an invite takes, minus the join. A
      // known server (by address, or by the world's instanceId when a tunnel
      // came back at a new hostname) opens straight away with its saved
      // session; only a new one lands on its sign-in screen.
      await handleJoinLink(link);
      return { ok: true };
    } catch (err) {
      // Backing out of the scanner is not an error worth showing.
      const message = err instanceof Error ? err.message : "";
      if (/cancel/i.test(message)) return { ok: true };
      return fail(err);
    }
  },

  // Mirrors the desktop handler: the session goes, the entry stays so a
  // sign-in before the due date can still keep the account.
  async deleteAccount(input) {
    const serverId = String(input?.serverId ?? "");
    const servers = await loadServers();
    const server = servers.find((entry) => entry.id === serverId);
    if (!server || !tokenAlive(server)) {
      return fail(new Error("Sign in to this server first, then delete the account."));
    }
    try {
      const deletion = await deleteAccount(server.origin, server.token, String(input?.password ?? ""));
      server.token = "";
      server.tokenExpiresAt = "";
      await saveServers(servers);
      await CapacitorCookies.clearCookies({ url: server.origin }).catch(() => undefined);
      return { ok: true, deletion };
    } catch (err) {
      return fail(err);
    }
  },

  async removeServer(serverId) {
    const servers = await loadServers();
    const server = servers.find((entry) => entry.id === serverId);
    await saveServers(servers.filter((entry) => entry.id !== serverId));
    if (server) {
      await CapacitorCookies.clearCookies({ url: server.origin }).catch(() => undefined);
    }
  },

  homeFeed: () => homeFeed.refresh(),
  homeFeedCached: () => homeFeed.cached(),

  // A cover for the home screen, fetched natively with the host's own
  // session (the WebView's image tags carry none, and the server keeps
  // uploads behind its login) and only from that host, straight into the
  // app cache; the page gets an address it can draw. "" when it cannot be
  // had right now.
  async coverImage(hostId, url) {
    const id = String(hostId ?? "");
    const session = await bridge.hostSession(id);
    const target = coverRequestUrl(session?.origin ?? "", String(url ?? ""));
    if (!target || !session) return "";
    try {
      return await fetchCover(OdmDownload, {
        hostId: id,
        url: target,
        token: session.token,
        maxBytes: COVER_MAX_BYTES,
      });
    } catch {
      return "";
    }
  },

  // The native game screens' way onto a host's API (see coverImage for the
  // same lookup): the address and live token, or null without a session.
  async hostSession(hostId) {
    const id = String(hostId ?? "");
    if (id === LOCAL_HOST_ID) {
      const profile = await loadLocalProfile();
      const origin = (await localStatusCached.get()).origin;
      const token = profileTokenAlive(profile) ? (profile?.token ?? "") : "";
      return origin && token ? { origin, token } : null;
    }
    const server = (await loadServers()).find((entry) => entry.id === id);
    return server && tokenAlive(server) ? { origin: server.origin, token: server.token } : null;
  },

  portalMode,
  async setPortalMode(on) {
    await Preferences.set({ key: PORTAL_PREF_KEY, value: on === false ? "off" : "on" });
  },

  // The OS share sheet for the world's public address (or any link the
  // shell hands out): chat apps, mail, whatever the phone has.
  async shareLink(input) {
    try {
      await Share.share({
        title: String(input?.title ?? ""),
        text: String(input?.text ?? ""),
        url: String(input?.url ?? ""),
        dialogTitle: String(input?.title ?? "Share"),
      });
      return true;
    } catch {
      // Dismissing the sheet rejects; that is not a failure worth a word.
      return false;
    }
  },

  async localStart() {
    try {
      await localWorld.start();
      return { ok: true, status: await localWorld.status() };
    } catch (err) {
      return fail(err);
    }
  },
  localCreateAccount: (input) =>
    localWorld.createAccount({
      username: String(input?.username ?? "").trim(),
      password: String(input?.password ?? ""),
    }),
  localLogin: (input) =>
    localWorld.login({
      username: String(input?.username ?? "").trim(),
      password: String(input?.password ?? ""),
    }),
  localConfigureAi: (setup) => localWorld.configureAi(setup),
  localAiSaved: () => localWorld.aiSaved(),
  localAiModels: (apiKey) => localWorld.aiModels(String(apiKey ?? "")),
  // Agent programs (Claude Code, Codex, ...) are started by a desktop's own
  // server; a phone has none to start.
  localHarnessStatus: async () => ({ ok: false, error: "Agent programs run on a computer, not a phone." }),
  localPlay: (joinCode, path) => localWorld.play(cleanCode(joinCode), safeInnerPath(path)),
  localExportWorld: () => localWorld.exportWorld(),
  localImportPick: () => localWorld.importPick(),
  localImportCommit: () => localWorld.importCommit(),
  localImportCancel: () => localWorld.importCancel(),
  // Troubleshooting (Settings), the phone's half: the server files unpacked
  // again with everything the player made kept (WorldRuntime.repair), and
  // the summary for a bug report. The phone's payload carries no manifest,
  // so there is no check, and nothing of the WebView's cache is offered.
  localRepair: () => localWorld.repair(),
  async diagnosticSummary() {
    const [status, facts, info, servers] = await Promise.all([
      localWorld.status(),
      localWorld.diagnostics(),
      App.getInfo().catch(() => null),
      loadServers(),
    ]);
    // The WebView's user agent names the Android version and the device,
    // the way it does to every site.
    const device = /\(([^)]*)\)/.exec(navigator.userAgent)?.[1] ?? "";
    return {
      text: diagnosticSummary({
        app: { version: info?.version ?? "", installKind: "android", platform: "android", arch: "", os: device, runtime: "WebView" },
        payload: facts?.payload ?? null,
        runTree: facts?.runTree ?? null,
        world: {
          state: status.state,
          error: status.error,
          firstRun: status.firstRun,
          dbPresent: facts?.dbPresent ?? false,
          keyPresent: facts?.keyPresent ?? false,
          packs: facts?.packs ?? [],
        },
        servers: servers.length,
        localAi: null,
        verify: null,
        paths: { userData: "the app's private storage", log: "local-server.log in the app's private storage" },
      }),
    };
  },
  async shareStart() {
    const status = await shareTunnel.start();
    if (status.state !== "running") return fail(new Error(status.error || "Sharing failed."));
    return { ok: true, tunnel: status };
  },
  shareStop: async () => ({ ok: true, tunnel: await shareTunnel.stop() }),
  // The phone's world answers on the phone alone until it is shared on
  // the Wi-Fi, as on the desktop (local-world.ts setLanSharing).
  lanStart: () => localWorld.setLanSharing(true),
  lanStop: () => localWorld.setLanSharing(false),
  localAiScan: async () => fail(new Error("Local AI is desktop-only.")),
  localAiInstall: async () => fail(new Error("Local AI is desktop-only.")),
  localAiInstallComfy: async () => fail(new Error("Local AI is desktop-only.")),
  localAiUninstall: async () => fail(new Error("Local AI is desktop-only.")),
  localAiStatus: async () => ({
    supported: false,
    installedTierId: "",
    installedLabel: "",
    utilityInstalled: false,
    running: false,
    external: false,
    endpoint: "",
    busy: "" as const,
    progress: null,
    error: "",
    comfy: { installed: false, running: false, checkpoint: "", error: "" },
  }),
  localAiStart: async () => fail(new Error("Local AI is desktop-only.")),
  async appInfo() {
    // Capacitor knows the installed APK's version; a plain browser dev run
    // does not, and the About card copes with an empty string.
    const version = await App.getInfo()
      .then((info) => info.version)
      .catch(() => "");
    return { version, installKind: "android" as const };
  },
  // The store owns updates on Android; report "nothing to do" so the shared
  // About card renders as version-only without a special case crashing.
  updateCheck: async () => ({
    ok: true as const,
    update: { current: "", latest: "", available: false, canSelfUpdate: false, canDownload: false, instruction: "", releasesUrl: "", channel: "stable" },
  }),
  updateInstall: async () => fail(new Error("Updates come through the app store on Android.")),

  onEvent(listener) {
    listeners.add(listener);
  },
};

window.odm = bridge;

// The phone's speech recognizer, for dictating on a server with no
// speech-to-text (the world this phone hosts, above all).
offerNativeDictation();

// Closing the server webview lands back on the manager; closing it in the
// middle of a Discord sign-in is a cancel.
void InAppBrowser.addListener("closeEvent", () => {
  gameWebViewClosed();
  settleDiscord(fail(new Error("Sign-in cancelled.")));
  emit({ kind: "show-manager" });
});
void InAppBrowser.addListener("urlChangeEvent", ({ url }) => {
  void onWebviewUrl(String(url ?? ""));
});

// The hardware back gesture on the manager itself. Registering a listener
// takes the decision away from Capacitor's default (which walks WebView
// history and otherwise swallows the press); the shell UI decides whether
// it is on an inner screen or at home.
void App.addListener("backButton", () => emit({ kind: "back" }));

// Traffic from the injected game-page scripts: GATT calls from the Web
// Bluetooth polyfill and file exports from the download shim. The plugin
// copies the posted object's top-level keys onto the event, so a message
// posted as { detail: {...} } arrives under event.detail while one posted
// bare (the BLE polyfill's shape) is the event itself; accept both.
async function routeWebviewMessage(event: unknown): Promise<void> {
  const wrapped = event as { detail?: unknown } | null;
  const detail =
    wrapped && typeof wrapped === "object" && wrapped.detail !== undefined ? wrapped.detail : event;
  if (isShellRequest(detail)) {
    // "Switch server" from the page's account menu (shell-hook.js). The
    // plugin fires closeEvent for toolbar and back-button closes only, so
    // the manager is shown explicitly here.
    await InAppBrowser.close().catch(() => undefined);
    gameWebViewClosed();
    emit({ kind: "show-manager" });
    return;
  }
  const share = shareRequestOf(detail);
  if (share) {
    await handleShareRequest(share);
    return;
  }
  const link = shareLinkRequestOf(detail);
  if (link) {
    // A page's share button (invite dialog, server address card): the
    // webview has no Web Share API, so the sheet opens from here.
    await bridge.shareLink?.(link);
    return;
  }
  if (await bleRelay.handleMessage(detail)) return;
  // An address download from the page may only name the host it shows.
  await downloadRelay.handleMessage(detail, { origin: gameWebViewOrigin || "-" });
}

function isShellRequest(detail: unknown): boolean {
  return (
    !!detail &&
    typeof detail === "object" &&
    (detail as { odmShell?: unknown }).odmShell === "servers"
  );
}

function shareLinkRequestOf(detail: unknown): { title: string; text: string; url: string } | null {
  if (!detail || typeof detail !== "object") return null;
  const message = detail as { odmShell?: unknown; url?: unknown; title?: unknown; text?: unknown };
  if (message.odmShell !== "share-link" || typeof message.url !== "string") return null;
  // Only web addresses leave the app; nothing else could open a sheet
  // anyone would want.
  if (!/^https?:\/\//i.test(message.url)) return null;
  return {
    title: typeof message.title === "string" ? message.title : "",
    text: typeof message.text === "string" ? message.text : "",
    url: message.url,
  };
}

function shareRequestOf(detail: unknown): { action: string; id?: number } | null {
  if (!detail || typeof detail !== "object") return null;
  const message = detail as { odmShell?: unknown; action?: unknown; id?: unknown };
  if (message.odmShell !== "share" || typeof message.action !== "string") return null;
  return { action: message.action, id: typeof message.id === "number" ? message.id : undefined };
}
void InAppBrowser.addListener("messageFromWebview", (event) => {
  void routeWebviewMessage(event);
});

// Deep links: while running, and the one that may have launched the app.
void App.addListener("appUrlOpen", ({ url }) => void handleLink(url));
void App.getLaunchUrl().then((launch) => {
  if (launch?.url) void handleLink(launch.url);
});
