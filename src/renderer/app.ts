// The shell UI's entry point: mounts the frame, wires the bridge's events
// to the screens, and paints the home. The screens themselves live in the
// sibling modules; all privileged work happens across window.odm.
import {
  applyDeckLayout,
  closeOverlay,
  closeUpdatePopup,
  isUpdatePopupOpen,
  mountShell,
  repaintUpdatePopup,
  showUpdatePopup,
  updateNoteFor,
} from "./chrome.js";
import { closeDrawer, createDrawer, isDrawerOpen, toggleDrawer } from "./drawer.js";
import { startGamepad } from "./gamepad.js";
import { renderHome } from "./home.js";
import { aiProgress } from "./local-ai.js";
import { renderAdd, renderAuth } from "./servers.js";
import { gameBack, isGameShowing, preloadGame, tryOpenNative } from "./game-screen.js";
import { renderSettings, worldTransferPhase } from "./settings.js";
import { refresh, refreshFeed, state, tunnelWatchers } from "./state.js";
import { endTour, isTourActive, maybeStartAppTour } from "./tour.js";

const { drawer, scrim } = createDrawer();
mountShell(drawer, scrim);

function goHome(): void {
  void refresh().then(() => renderHome());
}

function rerenderHome(): void {
  if (state.screenName === "home") renderHome();
}

// The way back, for Android's back gesture and a controller's B: a running
// tour ends first, then the update popup, an open drawer and a shell
// screen over a world close; then the world's previous page, and any
// inner screen returns home. layersOnly stops after the closing part. At
// home, atRoot decides what back means.
function goBack(layersOnly: boolean, atRoot: () => void): void {
  if (isTourActive()) endTour();
  else if (isUpdatePopupOpen()) closeUpdatePopup();
  else if (isDrawerOpen()) closeDrawer();
  else if (closeOverlay() || layersOnly) return;
  else if (isGameShowing() && gameBack()) return;
  else if (state.screenName === "home") atRoot();
  else goHome();
}

// Screens that show live status (the device world, the tunnel) repaint in
// place when it changes; the others keep what they have.
function rerenderLive(): void {
  if (state.screenName === "home") renderHome();
  else if (state.screenName === "settings") renderSettings();
}

window.odm.onEvent((event) => {
  if (event.kind === "show-manager") {
    goHome();
    void refreshFeed();
  } else if (event.kind === "back") {
    // Android's back gesture: home leaves the app, the way a root screen
    // should.
    goBack(false, () => void window.odm.leaveApp?.());
  } else if (event.kind === "local-status") {
    state.local = event.status;
    rerenderLive();
  } else if (event.kind === "tunnel-status") {
    state.tunnel = event.status;
    for (const watcher of tunnelWatchers) watcher();
    rerenderLive();
  } else if (event.kind === "world-transfer") {
    worldTransferPhase(event.phase);
  } else if (event.kind === "home-feed") {
    state.feed = event.feed;
    rerenderHome();
  } else if (event.kind === "local-ai-progress") {
    const installing =
      state.screenName === "local-ai-install" || state.screenName === "local-ai-comfy-install";
    const bar = aiProgress.current;
    if (installing && bar && event.status.progress) {
      bar.fill.style.width = `${event.status.progress.percent}%`;
      bar.label.textContent = `${event.status.progress.label} (${event.status.progress.percent}%)`;
    }
  } else if (event.kind === "update-progress") {
    const progress = event.progress;
    if (progress.state === "available") {
      // The background check found something: keep its status so the
      // footer and Settings offer the update button straight away.
      if (progress.status) state.updateStatus = progress.status;
      state.updateNote = updateNoteFor(progress.status, progress.latest);
      // A popup, not a line of small print: an app behind its host is a
      // source of trouble the player should hear about at once.
      if (progress.status) showUpdatePopup(progress.status);
    } else if (progress.state === "downloading") {
      state.updateNote = `Downloading update... ${progress.percent}%`;
    } else if (progress.state === "installing") {
      state.updateNote = progress.message || "Installing the update...";
    } else if (progress.state === "ready") {
      state.updateNote = progress.message || "Restarting to install the update...";
    } else if (progress.state === "error") {
      state.updateNote = progress.error;
    }
    repaintUpdatePopup();
    rerenderLive();
  } else if (event.kind === "join-request") {
    // A second pass at the same server (the address alone, once the code
    // has already brought us here) must not wipe the code: it is the whole
    // invitation, and losing it is what made a joiner meet "this server
    // needs an invite code" straight after typing one.
    const carried =
      !event.code && state.joinIntent?.origin === event.origin ? state.joinIntent.code : event.code;
    state.joinIntent = {
      origin: event.origin,
      code: carried,
      knownServerId: event.knownServerId,
    };
    void refresh().then(() => {
      if (event.knownServerId) {
        const known = state.servers.find((server) => server.id === event.knownServerId);
        if (known) {
          void window.odm.probeServer(known.origin).then((probed) => {
            if (probed.ok) renderAuth(probed.probe, "login", known.username);
            else renderHome();
          });
          return;
        }
      }
      // The address is known either way, so nobody is sent back to the
      // form to type it again. A world an app is hosting opens on joining,
      // since there is no account to sign in to yet and no password to
      // have; a server someone runs opens on sign-in, where a returning
      // player belongs, with Create account one tap away.
      void window.odm.probeServer(event.origin).then((probed) => {
        if (!probed.ok) {
          renderAdd(event.origin);
          return;
        }
        renderAuth(probed.probe, probed.probe.deviceWorld ? "register" : "login", "");
      });
    });
  }
});

void window.odm.appInfo().then((info) => {
  state.appInfo = info;
  applyDeckLayout();
  // The background check may have answered before this page was listening.
  if (info.update?.available) {
    state.updateStatus = info.update;
    state.updateNote = updateNoteFor(info.update);
    showUpdatePopup(info.update);
  }
  rerenderHome();
});

// The remembered feed paints at once; the fresh one lands as a home-feed
// event once every host has answered.
void window.odm
  .homeFeedCached()
  .then((feed) => {
    state.feed = feed;
    rerenderHome();
  })
  .catch(() => undefined);
// A controller (the Steam Deck's, or any pad) drives the shell and the
// game screens; B backs out but never leaves the app from home. Steam's
// keyboard is asked for only where Steam runs the session.
startGamepad({
  back: (layersOnly) => goBack(layersOnly, () => undefined),
  menu: () => toggleDrawer(),
  settings: () => {
    if (state.overlayName === "settings") closeOverlay();
    else if (state.screenName === "settings") goHome();
    else renderSettings();
  },
  keyboard: (field) => {
    if (!state.appInfo?.deck?.steam || !window.odm.steamKeyboard) return;
    if (!field) {
      void window.odm.steamKeyboard(false);
      return;
    }
    const box = field.getBoundingClientRect();
    const multiline = field instanceof HTMLTextAreaElement || field.isContentEditable;
    void window.odm.steamKeyboard(true, { x: box.left, y: box.top, width: box.width, height: box.height }, multiline);
  },
});

// Escape closes a shell screen laid over a world (the drawer's own
// listener closes the drawer the same way).
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && closeOverlay()) event.preventDefault();
});

// The screens' theme reaches the shell's own chrome through the same
// attribute the server sets on <html> (docs/vtt-parity-implementation-plan.md
// 18.2, phase 29); the OS frame follows through the bridge.
new MutationObserver(() => {
  const mode = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  void window.odm.setTheme?.(mode);
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

// A second window opened for the table view (phase 28) boots straight into
// the campaign's table route instead of the home screen.
const tableQuery = new URLSearchParams(window.location.search);
const tableHost = tableQuery.get("table") === "1" ? tableQuery.get("host") ?? "" : "";
const tableCampaign = tableQuery.get("campaign") ?? "";

void refresh().then(async () => {
  if (tableHost && tableCampaign) {
    // The host's version gates the native screens; the device world
    // answers from its status, a remote host from a probe.
    const server = state.servers.find((entry) => entry.id === tableHost);
    const probed = server ? await window.odm.probeServer(server.origin).catch(() => null) : null;
    const version = probed?.ok ? probed.probe.version : state.local.serverVersion;
    const opened = await tryOpenNative(tableHost, `/campaigns/${encodeURIComponent(tableCampaign)}/table`, version).catch(() => false);
    if (opened) return;
  }
  renderHome();
  void refreshFeed();
  maybeStartAppTour();
  // Once the home screen is up, the game bundle loads in the background so
  // entering a world does not start with a blank page.
  setTimeout(preloadGame, 1000);
});
