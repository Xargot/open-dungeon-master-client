// The shell's door into a host: the game screens drawn natively by the app
// (src/renderer/game), owning the whole window the way they do in a
// browser: the host's pages bring their own header, and the app's doors
// (App home, App settings, App guide) sit in that header's account menu.
// The game bundle is loaded on first use; a host too old to serve the
// app's own origin, or a page the native screens do not have, still opens
// in the web view as before.
import { landingPath } from "../shared/open-path.js";
import { nativeEligible } from "../shared/portal-logic.js";
import type { ShellShareStatus } from "../shared/types.js";
import { show } from "./chrome.js";
import { el } from "./dom.js";
import { renderHelp } from "./help.js";
import { renderHome } from "./home.js";
import { renderSettings } from "./settings.js";
import { connectAt, localPlayAt, refresh, refreshFeed, state, tunnelWatchers } from "./state.js";

interface GameMount {
  router: {
    location: { pathname: string; search: string };
    push(url: string): void;
    replace(url: string): void;
    back(): boolean;
    refresh(): void;
  };
  unmount(): void;
}

interface GameModule {
  mountDeviceSettings(root: HTMLElement): () => void;
  // Fetches the page module for a host path ahead of its first render.
  prefetch?(path: string): void;
  mountGame(
    root: HTMLElement,
    options: {
      session: { origin: string; token: string };
      path: string;
      onLeave(url: string): void;
      onHome?(): void;
    },
  ): GameMount;
}

// The window.odmShell contract the host's pages rely on inside the apps
// (the server's src/lib/shell-host.ts), served here by the shell itself.
interface ShellHostApi {
  platform: "desktop" | "android";
  showServers(): void;
  share: {
    status(): Promise<ShellShareStatus>;
    start(): Promise<ShellShareStatus>;
    stop(): Promise<ShellShareStatus>;
    subscribe(listener: (status: ShellShareStatus) => void): () => void;
  };
  shareLink?(input: { title: string; text: string; url: string }): Promise<boolean>;
  navigation: {
    location(): { pathname: string; search: string };
    push(url: string): void;
    replace(url: string): void;
    reload(): void;
  };
  hostOrigin: string;
  // The app's Settings (audio, dice, updates, sharing) and its guide, laid
  // over the running world from the page's account menu.
  openSettings(): void;
  openHelp(): void;
}

const LOCAL = "local";
let mount: GameMount | null = null;
let mountedHost = "";
let bundle: Promise<GameModule> | null = null;

function loadBundle(): Promise<GameModule> {
  if (window.odmGame) return Promise.resolve(window.odmGame as GameModule);
  bundle ??= new Promise((resolve, reject) => {
    const style = el("link");
    style.rel = "stylesheet";
    style.href = "./game/game.css";
    document.head.append(style);
    const script = el("script");
    script.type = "module";
    script.src = "./game/game.js";
    script.addEventListener("load", () => {
      if (window.odmGame) resolve(window.odmGame as GameModule);
      else reject(new Error("The game screens did not load."));
    });
    script.addEventListener("error", () => reject(new Error("The game screens did not load.")));
    document.head.append(script);
  });
  return bundle;
}

export function isGameShowing(): boolean {
  return mount !== null;
}

// Warms the way into a world while the home screen sits idle: the game
// bundle and the host home page's module, both local files, so the first
// tap pays only for the host's answers. Failures are left for the real
// entry to report.
export function preloadGame(): void {
  void loadBundle()
    .then((game) => game.prefetch?.("/"))
    .catch(() => undefined);
}

// The audio and dice controls on the shell's Settings screen, drawn by the
// game bundle (loaded on first use). Resolves to the unmount.
export async function mountDeviceSettings(root: HTMLElement): Promise<() => void> {
  const game = await loadBundle();
  root.replaceChildren();
  return game.mountDeviceSettings(root);
}

// The shell's back gesture inside a world: the previous page, or false at
// the world's first page so the caller can leave for home.
export function gameBack(): boolean {
  return mount ? mount.router.back() : false;
}

// Escape to whatever a world's page has open, before the back gesture goes
// back a page: Radix closes its dialogs and menus on it, and the host's
// guided tours end on it and record that they were ended (server issue
// #306; a tour the page merely navigated away from opens again next visit).
// A controller's B does the same in gamepad.ts. True when something took it.
export function escapeInGame(): boolean {
  if (!mount) return false;
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const escape = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(escape);
  return escape.defaultPrevented;
}

// The game root's distance from the top of the window, for the CSS that
// sizes the table's full-height layout (home.css --game-top). Measured
// again when the window changes, since the safe area can move.
function measureTop(root: HTMLElement): void {
  const top = Math.round(root.getBoundingClientRect().top + window.scrollY);
  root.style.setProperty("--game-top", `${Math.max(0, top)}px`);
}

let resizeWatcher: (() => void) | null = null;

export function unmountGame(): void {
  if (!mount) return;
  mount.unmount();
  mount = null;
  mountedHost = "";
  (window as { odmMountedHostId?: string }).odmMountedHostId = "";
  window.odm.gameMounted?.("");
  if (resizeWatcher) {
    window.removeEventListener("resize", resizeWatcher);
    resizeWatcher = null;
  }
  delete (window as { odmShell?: unknown }).odmShell;
}

// Back to the app's home from a world's page (its App home, or the world's
// own home page, which the app's stands in for). The tables are asked again
// too: the page may have just deleted, left or made one.
function goHome(): void {
  void refresh().then(() => renderHome());
  void refreshFeed();
}

// A page the native screens do not have, or an address off the host: the
// web view for the former (the old way in), the browser for the latter.
function leaveFor(hostId: string, url: string): void {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    window.open(url, "_blank", "noopener");
    return;
  }
  void (hostId === LOCAL ? localPlayAt(undefined, url) : connectAt(hostId, undefined, url));
}

function shareStatus(hostId: string): ShellShareStatus {
  const supported = hostId === LOCAL && state.local.state === "running";
  return { supported, ...state.tunnel, lanUrl: supported ? state.local.lanOrigin : "" };
}

function shellHostApi(hostId: string, origin: string, current: () => GameMount | null): ShellHostApi {
  const api: ShellHostApi = {
    platform: window.odm.platform,
    showServers: () => goHome(),
    share: {
      status: async () => shareStatus(hostId),
      async start() {
        if (hostId !== LOCAL) return shareStatus(hostId);
        const result = await window.odm.shareStart();
        await refresh().catch(() => undefined);
        const status = shareStatus(hostId);
        return result.ok ? status : { ...status, state: "error", error: result.error };
      },
      async stop() {
        if (hostId === LOCAL) {
          await window.odm.shareStop();
          await refresh().catch(() => undefined);
        }
        return shareStatus(hostId);
      },
      subscribe(listener) {
        const watcher = (): void => listener(shareStatus(hostId));
        tunnelWatchers.add(watcher);
        return () => tunnelWatchers.delete(watcher);
      },
    },
    navigation: {
      location: () => current()?.router.location ?? { pathname: "/", search: "" },
      push: (url) => current()?.router.push(url),
      replace: (url) => current()?.router.replace(url),
      reload: () => current()?.router.refresh(),
    },
    hostOrigin: origin,
    openSettings: () => renderSettings(),
    openHelp: () => renderHelp(),
  };
  if (window.odm.shareLink) {
    const share = window.odm.shareLink;
    api.shareLink = (input) => share(input);
  }
  return api;
}

// Draws the host natively at path. Returns false when the host is too old
// for it or the shell has no live session there; the caller then opens the
// web view the way it always did.
export async function tryOpenNative(
  hostId: string,
  path: string,
  serverVersion: string,
  validatedSession?: { origin: string; token: string },
): Promise<boolean> {
  if (!nativeEligible(serverVersion).ok) return false;
  // The bundle and the session do not depend on each other; the bundle's
  // failure is swallowed only once the session says the door is open.
  const loading = loadBundle().catch(() => null);
  const session = validatedSession ?? await window.odm.hostSession(hostId);
  if (!session) return false;
  const game = await loading;
  if (!game) return false;
  unmountGame();
  state.screenName = "game";
  const root = el("div", "game-root");
  root.dataset.host = hostId;
  show("game", root);
  measureTop(root);
  resizeWatcher = () => measureTop(root);
  window.addEventListener("resize", resizeWatcher);
  (window as { odmShell?: ShellHostApi }).odmShell = shellHostApi(hostId, session.origin, () => mount);
  mount = game.mountGame(root, {
    session,
    path: path || "/",
    onLeave: (url) => {
      unmountGame();
      leaveFor(hostId, url);
    },
    // The device world's home is the app's home: its own title screen
    // would only repeat this one's menu, save slots and join boxes.
    ...(hostId === LOCAL
      ? {
          onHome: () => {
            unmountGame();
            goHome();
          },
        }
      : {}),
  });
  mountedHost = hostId;
  // The Android bridge reads this to fetch a host document for the system
  // viewer (docs/vtt-parity-implementation-plan.md 18.2, phase 21).
  (window as { odmMountedHostId?: string }).odmMountedHostId = hostId;
  // The desktop fetches a document the page asks to open (window.odm
  // .openDocument) with this host's session.
  window.odm.gameMounted?.(hostId);
  return true;
}

export function mountedHostId(): string {
  return mountedHost;
}

// Moves the world on screen to one of its pages (an offer's table, from its
// notification); false when no world is showing.
export function gameNavigate(path: string): boolean {
  if (!mount) return false;
  if (mount.router.location.pathname !== path) mount.router.push(path);
  return true;
}

// The device world, natively: only once it has a profile and is awake.
export async function tryOpenNativeLocal(joinCode: string | undefined, path: string): Promise<boolean> {
  if (state.local.state === "unavailable") return false;
  // The renderer's copy trails a profile just made (the guided setup ends
  // here), and with it the world opened in the old web view; the shell's
  // own answer decides.
  if (state.local.firstRun || !state.local.hasAccount) {
    await refresh().catch(() => undefined);
    if (state.local.firstRun || !state.local.hasAccount) return false;
  }
  if (!nativeEligible(state.local.serverVersion).ok) return false;
  // Waking the world can take a moment; the bundle loads meanwhile.
  preloadGame();
  const started = await window.odm.localStart();
  if (!started.ok) return false;
  state.local = started.status;
  const landing = landingPath(joinCode ?? "", path);
  // Nowhere in particular: the world is awake, and its home is this one.
  if (landing === "/") {
    unmountGame();
    goHome();
    return true;
  }
  return tryOpenNative(LOCAL, landing, started.status.serverVersion);
}
