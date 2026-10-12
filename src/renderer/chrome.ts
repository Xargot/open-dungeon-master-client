// The frame around every screen: the topbar with its hamburger and brand,
// the page column screens render into, the back link, intro block and form
// card, the invite banner, and the footer with the updater controls.
import type { UpdateStatus } from "../shared/types";
import { bookMark, button, chip, el, icon, iconButton, spinner } from "./dom.js";
import { renderDrawer, toggleDrawer } from "./drawer.js";
import { unmountGame } from "./game-screen.js";
import { renderHelp } from "./help.js";
import { renderHome } from "./home.js";
import { renderSettings } from "./settings.js";
import { isAndroid, refresh, state } from "./state.js";

const root = document.getElementById("app") as HTMLDivElement;
// The column screens render into; the drawer and its scrim sit beside it.
const page = el("div", "page");
let lastScreen = "";
// A shell screen laid over a running world, if any (showOverlay).
let overlay: HTMLElement | null = null;
// Cleanups a screen registers for the moment it is replaced or its overlay
// closes: a microphone test still running, a mounted component. A screen
// registers them while it is being built, before show() is called, so
// they wait in `pending` and become the shown screen's on show; the
// previous screen's run at that moment.
let pendingHooks = new Set<() => void>();
let leaveHooks = new Set<() => void>();

export function onLeaveScreen(cleanup: () => void): void {
  pendingHooks.add(cleanup);
}

function runLeaveHooks(): void {
  const hooks = [...leaveHooks];
  leaveHooks = pendingHooks;
  pendingHooks = new Set();
  for (const hook of hooks) hook();
}

// Builds the shell once: drawer, scrim and page. Screens replace the page's
// children, so the drawer keeps its scroll and open state across renders.
export function mountShell(drawer: HTMLElement, scrim: HTMLElement): void {
  root.replaceChildren(drawer, scrim, page);
}

// The Steam Deck layout (src/shared/deck.ts) is a class on <html>: the
// sheets size the shell for a 7 inch 1280x800 screen held at arm's length
// and a thumb on the touchscreen.
export function deckLayoutOn(): boolean {
  return state.appInfo?.deck?.active === true;
}

// The strip of button hints along the foot of every shell screen in the
// Deck layout (the sheet hides it inside a world, where the host's pages
// own the window).
let padHints: HTMLElement | null = null;

function padHint(glyph: string | SVGSVGElement, label: string): HTMLElement {
  const hint = el("span", "pad-hint");
  const mark = el("span", "pad-glyph");
  mark.append(glyph);
  hint.append(mark, document.createTextNode(label));
  return hint;
}

export function applyDeckLayout(): void {
  const on = deckLayoutOn();
  document.documentElement.classList.toggle("deck", on);
  if (on && !padHints) {
    padHints = el("div", "pad-hints");
    padHints.setAttribute("aria-hidden", "true");
    padHints.append(
      padHint("A", "Select"),
      padHint("B", "Back"),
      padHint(icon("menu"), "Menu"),
      padHint(icon("view"), "Settings"),
    );
    document.body.append(padHints);
  }
}

function goHome(): void {
  void refresh().then(() => renderHome());
}

// The frame's constant row, the same one the title screen wears: the
// closed book and the spaced-caps wordmark on the left; on the right the
// instruments, Home (off the home screen), the user guide, Settings, and
// the medallion that opens the menu (the device profile, the hosts, the
// invites), so no screen is ever more than one tap from any of them.
export function topbar(): HTMLElement {
  const bar = el("header", "topbar");
  const atHome = state.screenName === "home";
  const brand = el("button", atHome ? "brand" : "brand link");
  brand.type = "button";
  brand.dataset.tour = "brand";
  brand.append(bookMark(), el("span", "wordmark", "Open Dungeon Master"));
  brand.setAttribute("aria-label", atHome ? "Open Dungeon Master" : "Back home");
  if (!atHome) {
    brand.addEventListener("click", goHome);
    brand.title = "Back home";
  }
  bar.append(brand);
  const tools = el("div", "meta tools");
  tools.dataset.tour = "topbar-tools";
  if (!atHome) tools.append(iconButton("home", "Home", goHome));
  // Inside a world the guide and Settings open over it and their buttons
  // close them again; elsewhere they are screens of their own.
  const helpOpen = state.overlayName === "help";
  const settingsOpen = state.overlayName === "settings";
  if (state.screenName !== "help") {
    const help = iconButton("help", helpOpen ? "Close the guide" : "User guide", () =>
      helpOpen ? closeOverlay() : renderHelp(),
    );
    help.classList.toggle("active", helpOpen);
    tools.append(help);
  }
  if (state.screenName !== "settings") {
    const gear = iconButton("gear", settingsOpen ? "Close settings" : "Settings", () =>
      settingsOpen ? closeOverlay() : renderSettings(),
    );
    gear.classList.toggle("active", settingsOpen);
    tools.append(gear);
  }
  // The title screen's portrait medallion: the device profile's initial,
  // or the menu glyph where this build has no device world. It opens the
  // menu on every width; the rail is gone with the old dashboard.
  const menu = el("button", "tt-medallion hamburger");
  menu.type = "button";
  menu.dataset.tour = "topbar-menu";
  menu.title = "Menu";
  menu.setAttribute("aria-label", "Menu");
  const name = state.local.state === "unavailable" ? "" : state.local.username;
  if (name) menu.append(el("span", "initial", name.slice(0, 1).toUpperCase()));
  else menu.append(icon("menu"));
  menu.addEventListener("click", () => toggleDrawer());
  tools.append(menu);
  bar.append(tools);
  return bar;
}

function refreshTopbar(): void {
  page.querySelector(".topbar")?.replaceWith(topbar());
}

export function isOverlayOpen(): boolean {
  return overlay !== null;
}

// Lays a shell screen over the world on show without taking the world
// down: the call, the event stream and the table keep running underneath.
// The same screen shown again keeps its scroll position.
export function showOverlay(name: "settings" | "help", ...nodes: (HTMLElement | null)[]): void {
  const previous = overlay;
  const keepScroll = previous && state.overlayName === name ? previous.scrollTop : 0;
  runLeaveHooks();
  previous?.remove();
  const sheet = el("div", `overlay ${name}`);
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", name === "settings" ? "Settings" : "User guide");
  const panel = el("section", "screen mid overlay-panel");
  panel.append(...nodes.filter((node): node is HTMLElement => node !== null));
  sheet.append(panel);
  // Under the topbar and beside the drawer, whatever the window's shape.
  const bar = page.querySelector(":scope > .topbar");
  const top = bar ? bar.getBoundingClientRect().bottom : 0;
  sheet.style.setProperty("--overlay-top", `${Math.max(0, Math.round(top))}px`);
  sheet.style.setProperty("--overlay-left", `${Math.round(page.getBoundingClientRect().left)}px`);
  overlay = sheet;
  state.overlayName = name;
  page.append(sheet);
  sheet.scrollTop = keepScroll;
  refreshTopbar();
}

export function closeOverlay(): boolean {
  if (!overlay) return false;
  runLeaveHooks();
  overlay.remove();
  overlay = null;
  state.overlayName = "";
  refreshTopbar();
  return true;
}

// "title" is the home screen: it fills the window and carries the frame's
// row inside its own header (home.ts), the way the server's title screen
// does. "game" is a world: the host's pages own the whole window, header
// and all, exactly as they do in a browser; the app's doors are in the
// page's account menu and behind the keyboard and the back gesture.
export type Layout = "wide" | "narrow" | "mid" | "game" | "title";

// A screen re-rendering itself (a status event landing while it shows)
// keeps its scroll position and skips the entrance animation; only moving
// to another screen starts at the top.
export function show(layout: Layout, ...nodes: (HTMLElement | null)[]): void {
  // Leaving a world for any shell screen takes the native game down with
  // it; the game screen itself mounts after this call.
  if (layout !== "game") unmountGame();
  runLeaveHooks();
  overlay = null;
  state.overlayName = "";
  const same = lastScreen === state.screenName;
  lastScreen = state.screenName;
  const screen = el("section", layout === "wide" ? "screen" : `screen ${layout}`);
  if (same) screen.classList.add("still");
  screen.append(...nodes.filter((node): node is HTMLElement => node !== null));
  page.classList.toggle("game", layout === "game");
  page.classList.toggle("title", layout === "title");
  root.classList.toggle("immersive", layout === "game");
  // The title screen and a world fill the window edge to edge.
  root.classList.toggle("bleed", layout === "game" || layout === "title");
  if (layout === "game" || layout === "title") page.replaceChildren(screen);
  else page.replaceChildren(topbar(), screen);
  renderDrawer();
  // The backdrop breathes behind every shell screen; under a running
  // world it holds its last frame, so the table has the frame budget.
  if (layout === "game") window.odmTopo?.pause();
  else window.odmTopo?.resume();
  if (!same) window.scrollTo({ top: 0 });
}

export function backLink(label: string, target: () => void): HTMLButtonElement {
  const btn = el("button", "link back");
  btn.type = "button";
  btn.append(icon("arrowLeft"), document.createTextNode(label));
  btn.addEventListener("click", target);
  return btn;
}

// Title block for the focused screens: the closed book over a heading in
// the title screen's extruded gold, the way the server's pages greet a
// visitor.
export function intro(title: string, subtitle: string): HTMLElement {
  const wrap = el("div", "intro");
  wrap.append(bookMark(true));
  const text = el("div");
  const heading = el("h1");
  heading.append(el("span", "gold-face", title));
  text.append(heading);
  if (subtitle) text.append(el("p", "sub", subtitle));
  wrap.append(text);
  return wrap;
}

export function formCard(...children: (HTMLElement | null)[]): HTMLElement {
  const card = el("div", "glass grain form-card");
  card.append(...children.filter((node): node is HTMLElement => node !== null));
  return card;
}

export function joinBanner(): HTMLElement | null {
  const intent = state.joinIntent;
  if (!intent) return null;
  const banner = el("div", "panel ornate banner");
  banner.append(chip("link"));
  const grow = el("div", "grow");
  if (intent.code) {
    grow.append(el("div", "detail", "You were invited to a campaign"));
    const line = el("div");
    line.append(el("span", "code", intent.code), el("span", "detail", `  on ${intent.origin}`));
    grow.append(line);
  } else {
    // A scanned server address: there is no room to join, only a server to
    // add, and the form below already holds its address.
    grow.append(el("div", "detail", "Adding a server"), el("div", "", intent.origin));
  }
  banner.append(grow);
  return banner;
}

export function loadingScreen(title: string, detail: string): HTMLElement {
  const wrap = el("div", "loading");
  wrap.append(spinner(true), el("h2", "", title), el("p", "sub", detail));
  return wrap;
}

function rerenderHome(): void {
  if (state.screenName === "home") renderHome();
}

// One line for the footer once a check has answered.
export function updateNoteFor(update: UpdateStatus | null, latest = ""): string {
  if (!update) return `Version ${latest} is available.`;
  if (!update.available) return "You have the latest version.";
  if (update.canSelfUpdate || update.canDownload) return `Version ${update.latest} is ready to install.`;
  return `Version ${update.latest} is available. ${update.instruction}`;
}

// The update button: install when one is ready, fetch it from GitHub when
// this install cannot replace itself, otherwise check. Shared by the home
// footer and the Settings screen; rerender repaints whichever screen
// asked, once the answer lands in state.updateNote.
export function updateControls(rerender: () => void): HTMLElement {
  const update = state.updateStatus;
  if (update?.available && !update.canSelfUpdate && !update.canDownload) {
    // The shell window hands http(s) opens to the system browser.
    const get = button("primary", `Get ${update.latest}`, () => {
      window.open(update.releasesUrl);
    }, "download");
    get.classList.add("quiet-size");
    return get;
  }
  if (update?.available && (update.canSelfUpdate || update.canDownload)) {
    const install = button("primary", `Update to ${update.latest}`, (btn) => {
      btn.disabled = true;
      state.updateNote = "Starting the download...";
      void window.odm.updateInstall().then((result) => {
        if (!result.ok) {
          state.updateNote = result.error;
          rerender();
        }
      });
      rerender();
    }, "download");
    install.classList.add("quiet-size");
    return install;
  }
  return button("quiet", "Check for updates", (btn) => {
    btn.disabled = true;
    state.updateNote = "Checking...";
    void window.odm.updateCheck().then((result) => {
      if (result.ok) {
        state.updateStatus = result.update;
        state.updateNote = updateNoteFor(result.update);
      } else {
        state.updateNote = result.error;
      }
      rerender();
    });
    rerender();
  });
}

// The update popup: a modal over whatever screen is up, so a new version is
// never a line of small print. Shown once per run, when the background check
// (or an explicit one) finds a newer build. "Later" only closes it; the
// footer and Settings keep the button.
let updatePopup: HTMLElement | null = null;
let updatePopupShownFor = "";

export function isUpdatePopupOpen(): boolean {
  return updatePopup !== null;
}

export function closeUpdatePopup(): void {
  updatePopup?.remove();
  updatePopup = null;
}

export function showUpdatePopup(update: UpdateStatus): void {
  if (!update.available || updatePopupShownFor === update.latest) return;
  updatePopupShownFor = update.latest;
  closeUpdatePopup();
  const scrim = el("div", "update-popup-scrim");
  scrim.setAttribute("role", "alertdialog");
  scrim.setAttribute("aria-modal", "true");
  scrim.setAttribute("aria-label", "Update available");
  const card = el("section", "update-popup card ornate");
  const canInstall = update.canSelfUpdate || update.canDownload;
  const note = el("p", "update-popup-note", "");
  const paint = () => {
    note.textContent = state.updateNote && state.updateNote !== updateNoteFor(update) ? state.updateNote : "";
  };
  card.append(
    el("p", "eyebrow", "Update available"),
    el("h2", "", `Version ${update.latest}`),
    el(
      "p",
      "sub",
      canInstall
        ? `You are on ${update.current}. Hosts on a newer version may not open in an older app, so it is worth taking now.`
        : `You are on ${update.current}. ${update.instruction}`,
    ),
    note,
  );
  const actions = el("div", "update-popup-actions");
  const later = button("quiet", "Later", () => closeUpdatePopup());
  if (canInstall) {
    const install = button("primary", `Update to ${update.latest}`, (btn) => {
      btn.disabled = true;
      later.disabled = true;
      state.updateNote = "Starting the download...";
      paint();
      void window.odm.updateInstall().then((result) => {
        if (!result.ok) {
          state.updateNote = result.error;
          btn.disabled = false;
        }
        later.disabled = false;
        paint();
      });
    }, "download");
    actions.append(later, install);
  } else {
    actions.append(later, button("primary", `Get ${update.latest}`, () => window.open(update.releasesUrl), "download"));
  }
  card.append(actions);
  scrim.append(card);
  scrim.addEventListener("click", (event) => {
    if (event.target === scrim) closeUpdatePopup();
  });
  updatePopup = scrim;
  document.body.append(scrim);
  // Progress lines reach the popup while it is open.
  updatePopupPaint = paint;
  (canInstall ? actions.lastElementChild as HTMLElement : later).focus();
}

let updatePopupPaint: (() => void) | null = null;
export function repaintUpdatePopup(): void {
  if (updatePopup) updatePopupPaint?.();
}

// The legal links and the source, the same three the server's home ends
// on. Both hosts hand an off-origin link to the system browser.
export function legalLinks(): HTMLElement[] {
  const links: HTMLElement[] = [];
  for (const [label, href] of [
    ["Privacy policy", "https://opendungeonmaster.com/privacy/"],
    ["Terms of service", "https://opendungeonmaster.com/terms/"],
    ["GitHub", "https://github.com/Lebbitheplow/open-dungeon-master-client"],
  ] as const) {
    const link = el("a", "foot-link", label);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    links.push(link);
  }
  return links;
}

// Version, update state, the way home and the small print, in one quiet
// row at the bottom.
export function footer(): HTMLElement {
  const foot = el("footer", "foot");
  const version = state.appInfo?.version
    ? `Open Dungeon Master ${state.appInfo.version}`
    : "Open Dungeon Master";
  foot.append(el("span", "", state.updateNote || version));
  if (!isAndroid) {
    foot.append(updateControls(rerenderHome));
    foot.append(
      el(
        "span",
        "",
        deckLayoutOn()
          ? "B backs out of anything, Menu opens the menu, and the app guide has the rest of the controls."
          : "Ctrl+M brings you back here from any world.",
      ),
    );
  }
  foot.append(...legalLinks());
  return foot;
}
