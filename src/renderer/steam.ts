// "Add to Steam" in Settings, under Steam Deck and controllers (the work is
// src/main/steam-shortcut.ts): the row, Steam's restart question while
// Steam is open, and what happened. The note lives outside the card like
// the Troubleshooting note, since Settings repaints on every status event of
// the world. The same add is offered once in a popup at first launch on a
// Steam Deck in Desktop Mode.
import { isUpdatePopupOpen } from "./chrome.js";
import { button, el, spinner } from "./dom.js";
import { isDrawerOpen } from "./drawer.js";
import { isGameShowing } from "./game-screen.js";
import { state } from "./state.js";
import { appTourSeen, isTourActive } from "./tour.js";
import type { SteamAddResult } from "../shared/types.js";

type SteamNote =
  | { kind: "none" }
  | { kind: "working"; restarting: boolean }
  | { kind: "confirm" }
  | { kind: "done"; text: string }
  | { kind: "error"; message: string };

const steam: {
  note: SteamNote;
  repaint: (() => void) | null;
  popupPaint: (() => void) | null;
  shown: SteamNote | null;
} = {
  note: { kind: "none" },
  repaint: null,
  popupPaint: null,
  shown: null,
};

function setNote(note: SteamNote): void {
  steam.note = note;
  steam.repaint?.();
  steam.popupPaint?.();
}

// A fresh visit to Settings starts without the last answer.
export function forgetSteamNote(): void {
  if (steam.note.kind !== "working") steam.note = { kind: "none" };
}

function doneText(result: Extract<SteamAddResult, { state: "added" | "updated" }>): string {
  const library = result.persona ? `${result.persona}'s Steam library` : "your Steam library";
  const what = result.state === "added" ? `Added to ${library}, with its artwork.` : `The app's place in ${library} and its artwork are up to date.`;
  const when = result.restarted ? " Steam is starting again." : " It shows up the next time Steam starts.";
  const where = state.appInfo?.deck?.device ? " In Game Mode it waits under Non-Steam in your library." : "";
  const moved = result.moved ? ` The app's file is now ${result.moved}, a name that stays the same through updates.` : "";
  return `${what}${when}${where}${moved}`;
}

async function add(restart: boolean): Promise<void> {
  const ask = window.odm.addToSteam;
  if (!ask || steam.note.kind === "working") return;
  setNote({ kind: "working", restarting: restart });
  const result = await ask(restart).catch(
    (): SteamAddResult => ({ ok: false, error: "The app could not reach Steam's files." }),
  );
  if (!result.ok) setNote({ kind: "error", message: result.error });
  else if (result.state === "needs-restart") setNote({ kind: "confirm" });
  else setNote({ kind: "done", text: doneText(result) });
}

// The note's lines. Settings draws Steam's restart question with its own
// buttons; the popup keeps its buttons in its footer (inline false).
function noteNodes(note: SteamNote, inline = true): HTMLElement[] {
  switch (note.kind) {
    case "none":
      return [];
    case "working": {
      const line = el("p", "hint memory-working");
      const text = note.restarting ? "Closing Steam, adding the app and opening Steam again" : "Adding the app to Steam";
      line.append(spinner(), document.createTextNode(` ${text}...`));
      return [line];
    }
    case "confirm": {
      const question = el("p", "", "Steam is open. It has to close and open again to take the new game, so anything running in Steam, a game or a download, stops too.");
      if (!inline) return [question];
      const actions = el("div", "transfer-actions");
      actions.append(
        button("primary", "Restart Steam and add", () => void add(true), "refresh"),
        button("secondary", "Not now", () => setNote({ kind: "none" })),
      );
      return [question, actions];
    }
    case "done":
      return [el("p", "hint", note.text)];
    case "error":
      return [el("p", "error tt-shake", note.message)];
  }
}

// The row and its note, or nothing where the app cannot add itself (not
// Linux, a development run, or no Steam here).
export function steamRows(): HTMLElement[] {
  if (!state.appInfo?.addToSteam || !window.odm.addToSteam) return [];
  const launched = Boolean(state.appInfo.deck?.steam);
  const line = el("div", "settings-row");
  const go = button("secondary", "Add to Steam", () => void add(false), "gamepad");
  line.append(el("span", "grow", "Put this app in your Steam library with its artwork, so it starts from Game Mode like any game"), go);
  if (launched) {
    line.append(el("p", "hint", "Steam started this run, so the app is in your Steam library already. To add it again, start it from your desktop."));
  }
  const status = el("div", "memory-status");
  status.setAttribute("aria-live", "polite");

  let shownNote: SteamNote | null = null;
  const paint = (): void => {
    go.disabled = launched || steam.note.kind === "working" || steam.note.kind === "confirm";
    if (shownNote === steam.note) return;
    shownNote = steam.note;
    const nodes = noteNodes(steam.note);
    const holder = el("div", steam.shown === steam.note ? "memory-line settled" : "memory-line");
    steam.shown = steam.note;
    holder.append(...nodes);
    status.replaceChildren(...(nodes.length ? [holder] : []));
  };
  steam.repaint = () => {
    if (status.isConnected) paint();
  };
  paint();
  return [line, status];
}

// ---------- the first-launch offer ----------

// The popup over the title screen. Every way out (Not now, Done, B, Escape,
// a click beside it) answers the offer, which is then never made again;
// Settings keeps the button. It stays up while an add is running.
let offer: HTMLElement | null = null;

export function isSteamOfferOpen(): boolean {
  return offer !== null;
}

export function closeSteamOffer(): void {
  if (!offer || steam.note.kind === "working") return;
  offer.remove();
  offer = null;
  steam.popupPaint = null;
  void window.odm.answerSteamOffer?.();
}

function showSteamOffer(): void {
  if (offer) return;
  steam.note = { kind: "none" };
  const scrim = el("div", "update-popup-scrim");
  scrim.setAttribute("role", "alertdialog");
  scrim.setAttribute("aria-modal", "true");
  scrim.setAttribute("aria-label", "Add to Steam");
  const card = el("section", "update-popup card ornate");
  const status = el("div", "memory-status");
  status.setAttribute("aria-live", "polite");
  const actions = el("div", "update-popup-actions");
  card.append(
    el("p", "eyebrow", "Steam Deck"),
    el("h2", "", "Play from Game Mode"),
    el(
      "p",
      "sub",
      "Add Open Dungeon Master to your Steam library, with its artwork, and it starts from Game Mode like any other game. Settings keeps this button if you would rather wait.",
    ),
    status,
    actions,
  );
  scrim.append(card);
  scrim.addEventListener("click", (event) => {
    if (event.target === scrim) closeSteamOffer();
  });
  scrim.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSteamOffer();
  });

  const paint = (): void => {
    const note = steam.note;
    const nodes = noteNodes(note, false);
    const holder = el("div", "memory-line");
    holder.append(...nodes);
    status.replaceChildren(...(nodes.length ? [holder] : []));
    const notNow = (): HTMLButtonElement => button("quiet", "Not now", () => closeSteamOffer());
    let primary: HTMLButtonElement | null = null;
    if (note.kind === "none") primary = button("primary", "Add to Steam", () => void add(false), "gamepad");
    else if (note.kind === "confirm") primary = button("primary", "Restart Steam and add", () => void add(true), "refresh");
    else if (note.kind === "done") primary = button("primary", "Done", () => closeSteamOffer(), "check");
    if (note.kind === "working") actions.replaceChildren();
    else if (note.kind === "error") actions.replaceChildren(button("secondary", "Close", () => closeSteamOffer()));
    else if (note.kind === "done") actions.replaceChildren(primary as HTMLButtonElement);
    else actions.replaceChildren(notNow(), primary as HTMLButtonElement);
    (primary ?? actions.querySelector("button") ?? card).focus();
  };
  steam.popupPaint = paint;
  offer = scrim;
  document.body.append(scrim);
  paint();
}

// At first launch: once the main process says the offer is due, it waits
// for a quiet title screen (the tour over, no update popup, no menu open,
// no world in front) and then appears.
export function maybeOfferSteam(): void {
  const due = window.odm.steamOffer;
  if (!due) return;
  void due()
    .then((wanted) => {
      if (!wanted) return;
      const timer = setInterval(() => {
        const quiet =
          state.screenName === "home" &&
          !isGameShowing() &&
          appTourSeen() &&
          !isTourActive() &&
          !isUpdatePopupOpen() &&
          !isDrawerOpen();
        if (!quiet) return;
        clearInterval(timer);
        showSteamOffer();
      }, 1000);
    })
    .catch(() => undefined);
}
