// The user guide: what each part of the shell is for and how to get around,
// in one scrollable screen, with the guided tour a tap away. Reachable
// from the topbar on every screen and from Settings.
import { backLink, closeOverlay, intro, show, showOverlay } from "./chrome.js";
import { button, chip, el, icon } from "./dom.js";
import type { IconName } from "./dom.js";
import { isGameShowing } from "./game-screen.js";
import { renderHome } from "./home.js";
import { renderSettings } from "./settings.js";
import { isAndroid, refresh, state } from "./state.js";
import { startAppTour } from "./tour.js";

// The full guide on the site, kept current between app releases.
export const GUIDE_URL = "https://opendungeonmaster.com/guide/";

function section(iconName: IconName, title: string, ...paragraphs: string[]): HTMLElement {
  const card = el("section", "panel ornate grain guide-section");
  const head = el("div", "guide-head");
  head.append(chip(iconName), el("h3", "", title));
  card.append(head);
  for (const text of paragraphs) card.append(el("p", "", text));
  return card;
}

export function renderHelp(): void {
  const overlaid = isGameShowing();
  if (!overlaid) state.screenName = "help";
  const device = isAndroid ? "phone" : "computer";
  const wayBack = isAndroid
    ? "On Android, the back gesture at a page's root closes that world too."
    : "On desktop, Ctrl+M brings you back from anywhere, and a controller's B button backs out of anything.";
  const scan = window.odm.scanInvite
    ? " Scan a QR code with the camera: a friend's invite, or the address code a server shows in its corner."
    : " An invite's QR code carries the same link; on a phone the app scans it.";
  const localAi = isAndroid
    ? ""
    : " On a desktop with a capable GPU, Story AI can also install a local model so nothing leaves your machine.";

  const actions = el("div", "guide-actions");
  actions.append(
    button("primary", "Replay the app tour", () => void refresh().then(() => {
      renderHome();
      startAppTour();
    }), "play"),
    button("secondary", "Settings", () => renderSettings(), "gear"),
  );
  // An anchor, not a button: both hosts hand an off-origin link to the
  // system browser (Electron through its window-open handler, Capacitor
  // as a view intent), so this works the same on desktop and Android.
  const online = el("a", "btn secondary", "");
  online.href = GUIDE_URL;
  online.target = "_blank";
  online.rel = "noopener noreferrer";
  online.append(icon("book"), document.createTextNode("Full guide online"));
  actions.append(online);

  const present = overlaid
    ? (...nodes: (HTMLElement | null)[]) =>
        showOverlay("help", backLink("Back to the game", () => closeOverlay()), ...nodes)
    : (...nodes: (HTMLElement | null)[]) => show("mid", backLink("Home", () => renderHome()), ...nodes);
  present(
    intro("User guide", "Where everything lives, and how to get around."),
    actions,
    section(
      "menu",
      "Getting around",
      `The home screen is a title screen: the table you were last at fills it, the menu runs down the left, and your tables sit as save slots on the right, where an owner can delete one. The medallion in the corner opens the menu with your hosts and every door: adding a server, invites, Story AI, Settings and this guide. Tap the wordmark on any screen to return home.`,
      `Inside a world the host's own pages fill the window, as they do in a browser. Open the account menu there and choose App home to come back here, App settings for the audio and dice controls, or App guide for this page; App settings and the guide open over the table, and closing them returns to the same game without dropping a call. ${wayBack}`,
    ),
    section(
      "server",
      "Servers and invites",
      `Add a server by its address. Each server keeps its own accounts, so you sign in (or create an account) there; the app remembers the session and opens the server with one tap from then on.`,
      `An invite from a friend is a link, or the room code their table shows. Type the code into Add a server and the app finds that table wherever its host is and takes you straight in, even though the host's address changes every time they share. The code itself never changes; it only works while the host has sharing open.${scan}`,
      `To leave a server behind, use the small buttons beside it in the menu: forget it on this device, or delete your account there for good.`,
      `When you enter a host, the app draws the screens itself and only game data travels to that server, so the controls are the same everywhere and a shared world costs less traffic. Hosts running an older server open their own pages instead. Settings has the switch.`,
    ),
    section(
      isAndroid ? "globe" : "monitor",
      `Your world on this ${device}`,
      `The app can host a world itself: no server needed. Enter it from the home screen and it wakes up; close the app and it sleeps. Your campaigns, characters and pictures stay on this ${device}.`,
      isAndroid
        ? `Your world answers on this phone alone until you share it. Share on this Wi-Fi and friends in the same room join at the address shown, with no internet at all; anyone on that network can reach the sign-in page while it is on. Share online and the app opens a public address so friends anywhere can join while the app runs. Copy the address, send it through your phone's share sheet, or show its QR code for a camera to scan.`
        : `Share on this Wi-Fi and friends in the same room join at the address shown, with no internet at all: type it into a browser or the app, or scan its QR code. The address is plain http on your own network, so anyone on that network can reach the sign-in page while it is on. Share online and the app opens a public address so friends anywhere can join while the app runs.`,
    ),
    section(
      "sparkles",
      "Story AI",
      `Story AI is what the world on this ${device} plays with: it opens on what is set now (who tells the story, what paints, what reads it aloud), then offers the choices. No AI at all, your own OpenAI API key (which can paint and read aloud too), or${isAndroid ? "" : " an agent you already pay for (Claude Code, Codex, opencode or Grok Build; Codex and Grok Build can paint as well, after one test map), or"} a model on this ${device}.${localAi}`,
      `Story AI sets up the services. Who runs a particular table (the AI, you, or a friend) is chosen when that campaign is made, and a table can always have a person in the Dungeon Master's seat. To play with an AI Dungeon Master on someone else's server, connect to a server that has AI enabled; its admin sets that up.`,
    ),
    section(
      "wand",
      "Workshop, characters, campaigns",
      `The title screen's menu opens the pages you use most on the host it names above them ("Opens on ..."): the one you were last in, unless you press Change to pick another. New campaign builds your own table: pick a genre or a world pack, decide who tells the story, and share the room code. Quick start skips all that: a prepared one-evening adventure with ready-made heroes. Every lobby offers three ways to a hero: a ready-made one, one from your library, or your own. Both doors are missing on a server whose admin keeps campaign creation; a room code is the way in there. Characters holds your adventurers and the creation wizard. The Workshop is the Dungeon Master's prep bench: maps, monsters, NPCs, lore and handouts. Join with a code drops you into the sigil boxes at the foot of the screen.`,
    ),
    section(
      "play",
      "At the table",
      `Once you are in a campaign, the Help button in its header explains every control, and offers guided tours of the table: one for players and one for the Dungeon Master's console. Each runs once on its own and can be replayed from Help.`,
      `The dice button in the campaign header turns the 3D dice on or off; when on, every roll the server makes tumbles across the screen before the result lands in the chat.`,
      `Hold the microphone beside Send to speak your turn instead of typing it. A key can hold it too: choose one as the Dictation key under Audio and dice in Settings, and its name appears on the mic. Hold it in the message box, or anywhere at the table outside another field, and let go when you are done; the words wait in the box until you press Send.`,
    ),
    isAndroid
      ? null
      : section(
          "gamepad",
          "Steam Deck and controllers",
          `On a Steam Deck the app switches to its Deck layout by itself: full screen in Game Mode, a title screen that fits the Deck's screen, and button hints along the foot. Settings has the switch; the launch options --steam-deck and --no-steam-deck decide for one Steam shortcut.`,
          `To play from Game Mode, add the app to Steam in Desktop Mode: in Settings, under Steam Deck and controllers, press Add to Steam (the first time the app opens on a Deck, it offers this itself). The app joins your Steam library with its artwork and the launch options it needs; Steam closes and opens again to take it, after asking. An AppImage named with its version is renamed first, so updates keep the shortcut working. Steam from Flathub cannot start apps outside its own sandbox; there, and anywhere else, Steam's own Games, Add a Non-Steam Game to My Library works too: pick Open Dungeon Master (the flatpak) or browse to the AppImage, and if it does not start, put --no-sandbox in its Launch Options.`,
          `A controller works on every screen, the Deck's own or any pad: the D-pad moves the highlight, A presses, B backs out, Menu opens the menu and View opens Settings. At the table, X jumps to the message box with Steam's keyboard up, holding L1 talks in voice chat (with the mic on Push to talk), and holding R1 speaks to the Dungeon Master (once the world has speech to text). While the table is being arranged (the layout button in its header), a highlighted line between two panels moves with the D-pad to resize them, and B finishes arranging. Settings lists every control.`,
          `The Deck's built-in microphone works like any other: pick it, or a headset, under Audio and dice in Settings, where the level meter shows whether it hears you.`,
        ),
    section(
      "gear",
      "Settings",
      `Settings gathers what belongs to the app itself, in four groups with a row at the top to reach each. Playing on this device: the microphone and its dictation key, playback and dice, controllers and the title screen. Your world: who plays there, sharing it, Story AI,${isAndroid ? "" : " the language your world's story memory reads (pick Many languages when your table plays in Italian, Spanish or another language),"} and moving it. Accounts and connections: saved sign-ins and older hosts. Help and maintenance: this guide, the tour, updates, and Troubleshooting: a check and a repair of the app's own server files, cached files cleared, and a summary to copy into a bug report, none of which touches anything you made. Your account, avatar and password live on each server, under its own Settings page.`,
    ),
  );
}
