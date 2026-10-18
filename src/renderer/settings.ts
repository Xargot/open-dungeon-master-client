// App settings, reachable from every screen: updates, the device world's
// switches (Story AI, its account page, sharing online with copy, share
// and QR), the home screen's hide-offline toggle, help and the tour, and
// the legal links. Servers keep their own account settings; this screen
// says so and points there.
import {
  applyDeckLayout,
  backLink,
  closeOverlay,
  intro,
  onLeaveScreen,
  show,
  showOverlay,
  updateControls,
} from "./chrome.js";
import { button, chip, copyText, el, icon, input, spinner } from "./dom.js";
import type { IconName } from "./dom.js";
import { isGameShowing, mountDeviceSettings } from "./game-screen.js";
import { offlineToggle, renderHome } from "./home.js";
import { GUIDE_URL, renderHelp } from "./help.js";
import { openLocal, shareRow } from "./local.js";
import { renderLocalAi } from "./local-ai.js";
import { DEVICE, isAndroid, refresh, refreshFeed, state } from "./state.js";
import { PAD_LEGEND, deckStatusLine, type DeckChoice } from "../shared/deck.js";
import type { StoryMemory, StoryMemoryStatus } from "../shared/story-memory.js";
import { describePreview, formatBytes, type WorldPreview } from "../shared/world-transfer.js";
import { RESET_PHRASE, describeVerify } from "../shared/diagnostics.js";
import { forgetSteamNote, steamRows } from "./steam.js";
import { startAppTour } from "./tour.js";

function section(iconName: IconName, title: string, detail: string): {
  card: HTMLElement;
  body: HTMLElement;
} {
  const card = el("section", "panel ornate grain settings-section");
  const head = el("div", "settings-head");
  head.append(chip(iconName));
  const text = el("div", "grow");
  text.append(el("h3", "", title));
  if (detail) text.append(el("p", "detail", detail));
  head.append(text);
  const body = el("div", "settings-body");
  card.append(head, body);
  return { card, body };
}

function row(label: string, control: HTMLElement): HTMLElement {
  const line = el("div", "settings-row");
  line.append(el("span", "grow", label), control);
  return line;
}

// Microphone, playback, levels and dice: the server's own DeviceSettings
// panel, drawn by the game bundle into this card. Its controls write the
// stores the table reads, so a call or table in progress follows along.
function audioSection(): HTMLElement {
  const { card, body } = section(
    "sliders",
    "Audio and dice",
    "The microphone and output this device uses, the key that holds the table's mic, how loud each part of the table is, and the dice on it. Changes reach a call or a table already in progress.",
  );
  const host = el("div", "game-root device-settings");
  host.append(spinner());
  body.append(host);
  // The panel arrives after the screen is shown; whichever comes first,
  // leaving the screen takes the panel (and any microphone test) down.
  let gone = false;
  let unmount: (() => void) | null = null;
  onLeaveScreen(() => {
    gone = true;
    unmount?.();
  });
  void mountDeviceSettings(host)
    .then((release) => {
      if (gone) release();
      else unmount = release;
    })
    .catch(() => {
      host.replaceChildren(el("p", "hint", "The audio and dice controls did not load."));
    });
  return card;
}

// The Steam Deck layout and the controller (src/shared/deck.ts): Auto, On
// or Off, what the app found about this machine, and what every control
// does. Desktop only; the window itself follows the choice next start.
function deckSection(): HTMLElement | null {
  const deck = state.appInfo?.deck;
  const setChoice = window.odm.setDeckChoice;
  if (isAndroid || !deck || !setChoice) return null;
  const { card, body } = section("gamepad", "Steam Deck and controllers", deckStatusLine(deck));
  const choices = el("div", "deck-choice");
  choices.setAttribute("role", "radiogroup");
  choices.setAttribute("aria-label", "Steam Deck layout");
  const options: readonly [DeckChoice, string][] = [
    ["auto", "Auto"],
    ["on", "On"],
    ["off", "Off"],
  ];
  for (const [choice, label] of options) {
    const btn = button("secondary", label, () => {
      void setChoice(choice).then((next) => {
        if (next && state.appInfo) state.appInfo.deck = next;
        applyDeckLayout();
        renderSettings();
      });
    });
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(deck.choice === choice));
    choices.append(btn);
  }
  body.append(row("Deck layout. Auto turns it on on a Steam Deck and in Steam's Game Mode", choices), ...steamRows());
  const legend = el("dl", "pad-legend");
  for (const entry of PAD_LEGEND) legend.append(el("dt", "", entry.control), el("dd", "", entry.does));
  body.append(el("span", "settings-label", "The controller, on every screen and at the table"), legend);
  return card;
}

// Stable or beta updates (src/main/updater.ts). Asked for on each paint, like
// portal mode; until the answer lands the switch shows stable.
let betaUpdates: boolean | null = null;

function appSection(): HTMLElement {
  const version = state.appInfo?.version ? `Version ${state.appInfo.version}` : "";
  const { card, body } = section(
    "cpu",
    "This app",
    isAndroid
      ? `${version}${version ? ". " : ""}Updates arrive through Google Play.`
      : version,
  );
  if (!isAndroid) {
    const note = el("p", "settings-note", state.updateNote);
    body.append(note, updateControls(() => renderSettings()));
    const askChannel = window.odm.updateChannel;
    const setChannel = window.odm.setUpdateChannel;
    if (askChannel && setChannel) {
      if (betaUpdates === null) {
        void askChannel().then((channel) => {
          betaUpdates = channel === "beta";
          if (state.screenName === "settings") renderSettings();
        });
      }
      body.append(
        row(
          "Beta updates: offer each night's build before it is promoted to stable. Turned off, the app keeps the version it has until a stable release passes it.",
          switchButton(betaUpdates ?? false, (next) => {
            betaUpdates = next;
            void setChannel(next ? "beta" : "stable").then(() => {
              state.updateStatus = null;
              state.updateNote = next ? "Beta updates are on." : "Updates are back on stable releases.";
              if (state.screenName === "settings") renderSettings();
            });
          }),
        ),
      );
    }
  }
  return card;
}

function deviceSection(): HTMLElement | null {
  const local = state.local;
  if (local.state === "unavailable") return null;
  const { card, body } = section(
    isAndroid ? "globe" : "monitor",
    DEVICE,
    local.firstRun
      ? "Your world has not begun yet. Enter it from the home screen and these switches wake up."
      : local.username
        ? `Playing as ${local.username}.${local.lanOrigin ? ` On your Wi-Fi at ${local.lanOrigin}.` : ""}`
        : "",
  );
  if (local.firstRun) return card;
  body.append(
    row(
      "Who tells the story: a human, your OpenAI key" + (isAndroid ? "" : ", or a local model"),
      button("secondary", "Story AI", () => renderLocalAi(true), "sparkles"),
    ),
  );
  const account = button("secondary", "Open", () => void openLocal("/settings"), "user");
  const accountRow = row("Your account in this world: name, avatar, password", account);
  if (local.state !== "running") {
    account.disabled = true;
    accountRow.append(el("p", "hint", "Enter your world first; its settings page opens once it is awake."));
  }
  body.append(accountRow);
  const share = el("div", "settings-share");
  share.append(el("span", "settings-label", isAndroid ? "Share online" : "Sharing"));
  share.append(
    local.state === "running"
      ? shareRow()
      : el("p", "hint", "Sharing starts once your world is awake. Enter it, then come back here or use the campaign lobby's invite dialog."),
  );
  body.append(share);
  return card;
}

// Moving the device world to another device (src/shared/world-transfer.ts):
// export packs it into one file the person saves, import checks a file they
// pick, says what is in it, and only then replaces the world. Kept outside
// the card for the same reason as the story memory note: the screen
// repaints on every status event of the world, and an import restarts it.
type TransferNote =
  | { kind: "none" }
  | { kind: "working"; action: "export" | "import" }
  | { kind: "saved"; file: string; bytes: number }
  | { kind: "confirm"; preview: WorldPreview }
  | { kind: "imported"; owner: string }
  | { kind: "error"; message: string };

const transfer: {
  note: TransferNote;
  busy: boolean;
  // What the world's server says it is doing, updated in place.
  phase: string;
  phaseText: Text | null;
  repaint: (() => void) | null;
  shown: TransferNote | null;
} = { note: { kind: "none" }, busy: false, phase: "", phaseText: null, repaint: null, shown: null };

// A world-transfer event from the shell: the phase line changes where it
// stands, without a repaint.
export function worldTransferPhase(phase: string): void {
  transfer.phase = phase;
  if (transfer.phaseText) transfer.phaseText.data = ` ${phase}...`;
}

function transferNote(note: TransferNote): HTMLElement[] {
  switch (note.kind) {
    case "none":
      return [];
    case "working": {
      const line = el("p", "hint memory-working");
      transfer.phaseText = document.createTextNode(` ${transfer.phase || (note.action === "export" ? "Packing your world" : "Opening the file")}...`);
      line.append(spinner(), transfer.phaseText);
      return [line, el("p", "hint", "Keep the app open until this finishes.")];
    }
    case "saved":
      return [
        el("p", "hint", `Saved to ${note.file} (${formatBytes(note.bytes)}).`),
        el("p", "hint", "Anyone holding the file can read the campaigns in it, so keep it somewhere private. Keys and sign-ins were left out."),
      ];
    case "confirm": {
      const replace = button("primary", "Replace my world", () => void commitWorld(), "upload");
      const cancel = button("secondary", "Keep my world", () => cancelImport());
      const actions = el("div", "transfer-actions");
      actions.append(replace, cancel);
      const lines = [
        el("p", "", `Replace your world with this one? ${describePreview(note.preview)}`),
        el("p", "hint", "Everything in your world now is replaced. It stays on this device, set aside, until your next import."),
      ];
      if (isGameShowing()) {
        replace.disabled = true;
        lines.push(el("p", "hint warn", "Leave the table first: the world restarts to take the new one in."));
      }
      return [...lines, actions];
    }
    case "imported":
      return [
        el("p", "hint", `Your world is in place, and you play as ${note.owner}. If it used an AI key, enter it again in Story AI.`),
      ];
    case "error":
      return [el("p", "error tt-shake", note.message)];
  }
}

function setTransfer(note: TransferNote, busy = false): void {
  transfer.note = note;
  transfer.busy = busy;
  if (note.kind !== "working") transfer.phaseText = null;
  transfer.repaint?.();
}

async function exportWorld(): Promise<void> {
  const exporter = window.odm.localExportWorld;
  if (!exporter || transfer.busy) return;
  transfer.phase = "";
  setTransfer({ kind: "working", action: "export" }, true);
  const result = await exporter();
  if (!result.ok) setTransfer({ kind: "error", message: result.error });
  else setTransfer(result.saved ? { kind: "saved", file: result.file, bytes: result.bytes } : { kind: "none" });
}

async function pickWorld(): Promise<void> {
  const picker = window.odm.localImportPick;
  if (!picker || transfer.busy) return;
  transfer.phase = "";
  setTransfer({ kind: "working", action: "import" }, true);
  const result = await picker();
  if (!result.ok) setTransfer({ kind: "error", message: result.error });
  else setTransfer(result.preview ? { kind: "confirm", preview: result.preview } : { kind: "none" });
}

async function commitWorld(): Promise<void> {
  const commit = window.odm.localImportCommit;
  if (!commit || transfer.busy || isGameShowing()) return;
  transfer.phase = "";
  setTransfer({ kind: "working", action: "import" }, true);
  const result = await commit();
  setTransfer(result.ok ? { kind: "imported", owner: result.owner } : { kind: "error", message: result.error });
  await refresh();
  void refreshFeed();
  if (isGameShowing() ? state.overlayName === "settings" : state.screenName === "settings") renderSettings();
}

function cancelImport(): void {
  void window.odm.localImportCancel?.();
  setTransfer({ kind: "none" });
}

function transferSection(): HTMLElement | null {
  const bridge = window.odm;
  if (!bridge.localExportWorld || !bridge.localImportPick || !bridge.localImportCommit) return null;
  if (state.local.state === "unavailable") return null;
  const { card, body } = section(
    "download",
    "Move your world",
    "Save your whole world to one file, or replace it with one saved on another device. Keys and sign-ins never travel: enter your AI key again on the new device.",
  );
  const exportButton = button("secondary", "Export world", () => void exportWorld(), "download");
  const importButton = button("secondary", "Import world", () => void pickWorld(), "upload");
  body.append(
    row("Every campaign, account, picture and narration in one file", exportButton),
    row("Replace this world with one from a file", importButton),
  );
  const status = el("div", "memory-status");
  status.setAttribute("aria-live", "polite");
  body.append(status);

  let shownNote: TransferNote | null = null;
  const paint = (): void => {
    exportButton.disabled = transfer.busy || state.local.firstRun;
    importButton.disabled = transfer.busy;
    if (shownNote === transfer.note) return;
    shownNote = transfer.note;
    const nodes = transferNote(transfer.note);
    const line = el("div", transfer.shown === transfer.note ? "memory-line settled" : "memory-line");
    transfer.shown = transfer.note;
    line.append(...nodes);
    status.replaceChildren(...(nodes.length ? [line] : []));
  };
  transfer.repaint = () => {
    if (card.isConnected) paint();
  };
  paint();
  return card;
}

// A switch in the same dress as the home screen's hide-offline toggle. It
// flips where it stands, so the knob slides across (.toggle's transition)
// instead of a repaint swapping in one that is already there.
function switchButton(initial: boolean, onChange: (next: boolean) => void): HTMLElement {
  let on = initial;
  const btn = el("button", on ? "toggle on" : "toggle");
  btn.type = "button";
  btn.setAttribute("aria-pressed", String(on));
  const label = document.createTextNode(on ? "On" : "Off");
  const track = el("span", "track");
  track.append(el("span", "knob"));
  btn.append(label, track);
  btn.addEventListener("click", () => {
    on = !on;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
    label.data = on ? "On" : "Off";
    onChange(on);
  });
  return btn;
}

// Portal mode (src/shared/portal-logic.ts). The answer is asked for on
// each paint; until it lands the row shows the default.
let portalOn: boolean | null = null;

function worldsSection(): HTMLElement | null {
  if (state.local.state === "unavailable") return null;
  if (portalOn === null) {
    void window.odm.portalMode().then((on) => {
      portalOn = on;
      if (state.screenName === "settings") renderSettings();
    });
  }
  const { card, body } = section(
    "link",
    "Visiting hosts",
    "Hosts running server 0.16.1 or newer are drawn by the app itself: its own screens, fed by the host's data. This setting covers older hosts.",
  );
  const line = row(
    "Load older worlds through the app: a host on server 0.16.0 gets this app's bundled screens, with only game data travelling to it. Hosts older than that open their own pages regardless.",
    switchButton(portalOn ?? true, (next) => {
      portalOn = next;
      void window.odm.setPortalMode(next);
    }),
  );
  body.append(line);
  return card;
}

// Saved sign-ins (desktop only; the phone keeps them in the Android
// Keystore). Where the computer has no keyring the app can use, the tokens
// are only scrambled: the card says so, and offers to keep sign-ins for
// this run only.
let credentials: { protection: "keyring" | "obscured" | "none"; keepSignIns: boolean } | null = null;

function signInsSection(): HTMLElement | null {
  const ask = window.odm.credentialStorage;
  if (!ask) return null;
  if (credentials === null) {
    void ask().then((answer) => {
      credentials = answer;
      if (state.screenName === "settings") renderSettings();
    });
    return null;
  }
  const { card, body } = section(
    "key",
    "Saved sign-ins",
    credentials.protection === "keyring"
      ? "Kept encrypted with this computer's keyring."
      : "This computer has no keyring the app can use, so saved sign-ins are only scrambled, not encrypted: anyone who can read your files could use them.",
  );
  body.append(
    row(
      "Stay signed in to servers after the app closes. Off: a server where you typed your own password asks for it again next time. Your own world and room-code accounts stay signed in either way, since only this app holds their passwords.",
      switchButton(credentials.keepSignIns, (next) => {
        if (credentials) credentials.keepSignIns = next;
        void window.odm.setKeepSignIns?.(next);
      }),
    ),
  );
  return card;
}

// Story memory (src/shared/story-memory.ts): which model the device world
// searches its story with. Built once per paint and then updated in place,
// so the chosen card's edge and lift travel through the .choice transitions
// instead of a re-render swapping the cards. Absent on the phone and null
// where the package has no embedding runtime: then the card leaves.
const MEMORY_CHOICES: { id: StoryMemory; icon: IconName; title: string; desc: string }[] = [
  {
    id: "english",
    icon: "book",
    title: "English",
    desc: "Light and quick, and the best fit when your table plays in English. About 90 MB, downloaded once.",
  },
  {
    id: "multilingual",
    icon: "globe",
    title: "Many languages",
    desc: "Italian, Spanish, French, German, Portuguese and about 45 more, and still sound in English. About 135 MB, downloaded once.",
  },
];

// What the card says below the choices. Kept outside the card: the screen
// repaints itself on every status event of the device world (a restart
// sends three), and the line must outlive those repaints.
type MemoryNote =
  | { kind: "none" }
  | { kind: "working" }
  | { kind: "rereading" }
  | { kind: "later" }
  | { kind: "offer"; why: string }
  | { kind: "error"; message: string };

const memory: {
  current: StoryMemoryStatus | null;
  busy: boolean;
  note: MemoryNote;
  repaint: (() => void) | null;
  // The note last laid on screen: a rebuilt card lays it again settled, so
  // only a new note rises in.
  shown: MemoryNote | null;
} = { current: null, busy: false, note: { kind: "none" }, repaint: null, shown: null };

function memoryNote(note: MemoryNote, apply: () => void): HTMLElement[] {
  switch (note.kind) {
    case "none":
      return [];
    case "working": {
      const line = el("p", "hint memory-working");
      line.append(spinner(), document.createTextNode(" Restarting your world with its new memory..."));
      return [line];
    }
    case "rereading":
      return [el("p", "hint", "Your world is re-reading its story in the background. Until it finishes, search finds things by keyword, so play on.")];
    case "later":
      return [el("p", "hint", "Saved. Your world uses it the next time it wakes, and re-reads its story then.")];
    case "offer":
      return [
        el("p", "hint", `Saved. ${note.why ? `${note.why} ` : ""}It takes effect the next time your world starts.`),
        row("Switch now instead", button("secondary", "Restart now", apply, "refresh")),
        el("p", "hint", "Anyone at the table reconnects after a few seconds; a turn in progress is lost."),
      ];
    case "error":
      return [el("p", "error", `Your world did not restart: ${note.message}`)];
  }
}

async function applyMemory(): Promise<void> {
  const bridge = window.odm;
  if (!bridge.applyStoryMemory || memory.busy) return;
  memory.busy = true;
  memory.note = { kind: "working" };
  memory.repaint?.();
  const result = await bridge.applyStoryMemory();
  memory.busy = false;
  if (result.ok) {
    memory.current = result.status;
    memory.note = { kind: "rereading" };
    memory.repaint?.();
    return;
  }
  // A world that did not come back changes the rest of the screen too.
  memory.note = { kind: "error", message: result.error };
  if (isGameShowing() ? state.overlayName === "settings" : state.screenName === "settings") renderSettings();
}

async function chooseMemory(id: StoryMemory): Promise<void> {
  const bridge = window.odm;
  if (!bridge.setStoryMemory || memory.busy || !memory.current || memory.current.choice === id) return;
  memory.current = { ...memory.current, choice: id };
  memory.repaint?.();
  const status = await bridge.setStoryMemory(id);
  memory.current = status;
  if (!status.pendingRestart) {
    // Back to the model the world already runs, or a world asleep.
    memory.note = state.local.state === "running" ? { kind: "none" } : { kind: "later" };
    memory.repaint?.();
    return;
  }
  if (isGameShowing()) memory.note = { kind: "offer", why: "A table is open in your world." };
  else if (status.worldInUse) {
    memory.note = {
      kind: "offer",
      why: state.tunnel.state === "running" ? "Your world is shared online." : "Your world is open in this window.",
    };
  } else {
    await applyMemory();
    return;
  }
  memory.repaint?.();
}

function memorySection(): HTMLElement | null {
  const bridge = window.odm;
  if (!bridge.storyMemory || !bridge.setStoryMemory || !bridge.applyStoryMemory) return null;
  if (state.local.state === "unavailable" || state.local.firstRun) return null;
  const { card, body } = section(
    "scroll",
    "Story memory",
    "How your world finds earlier scenes, lore and notes when the story calls back to them. Pick the language your table plays in.",
  );
  const group = el("div", "choices memory-choices");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Story memory language");
  const status = el("div", "memory-status");
  status.setAttribute("aria-live", "polite");
  body.append(group, status);

  const cards = new Map<StoryMemory, HTMLButtonElement>();
  for (const option of MEMORY_CHOICES) {
    const btn = el("button", "panel ornate choice");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.append(chip(option.icon));
    const text = el("span", "text");
    text.append(el("span", "title", option.title), el("span", "desc", option.desc));
    btn.append(text);
    btn.addEventListener("click", () => void chooseMemory(option.id));
    cards.set(option.id, btn);
    group.append(btn);
  }

  // In place: the chosen card's edge and lift ride the .choice transitions,
  // and only a changed note lays a new line (whose fade-up then plays).
  let shownNote: MemoryNote | null = null;
  const paint = (): void => {
    for (const [id, btn] of cards) {
      btn.setAttribute("aria-checked", String(memory.current?.choice === id));
      btn.disabled = memory.busy || !memory.current;
    }
    if (shownNote === memory.note) return;
    shownNote = memory.note;
    const nodes = memoryNote(memory.note, () => void applyMemory());
    const line = el("div", memory.shown === memory.note ? "memory-line settled" : "memory-line");
    memory.shown = memory.note;
    line.append(...nodes);
    status.replaceChildren(...(nodes.length ? [line] : []));
  };
  memory.repaint = () => {
    if (card.isConnected) paint();
  };
  paint();

  if (!memory.busy) {
    void bridge.storyMemory().then((answer) => {
      if (!answer) {
        card.remove();
        return;
      }
      if (memory.busy) return;
      memory.current = answer;
      if (answer.pendingRestart && memory.note.kind === "none") {
        memory.note = { kind: "offer", why: answer.worldInUse || isGameShowing() ? "Your world is in use." : "" };
      }
      memory.repaint?.();
    });
  }
  return card;
}

// Troubleshooting: the server files the app unpacked for the device world,
// checked against the ones it shipped with and unpacked again without
// touching anything the player made; the files cached from servers; a
// summary for a bug report; the log folder. Each row is offered only where
// the shell has the action (the phone checks nothing and keeps no log
// folder to open). The note below the rows lives outside the card like the
// transfer note: a repair restarts the world, whose status events repaint
// this screen.
type TroubleNote =
  | { kind: "none" }
  | { kind: "working"; what: string }
  | { kind: "done"; text: string }
  | { kind: "error"; message: string }
  // The reset's question, with the typed word that answers it.
  | { kind: "reset-confirm" };

const trouble: { note: TroubleNote; busy: boolean; repaint: (() => void) | null; shown: TroubleNote | null } = {
  note: { kind: "none" },
  busy: false,
  repaint: null,
  shown: null,
};

function setTrouble(note: TroubleNote, busy = false): void {
  trouble.note = note;
  trouble.busy = busy;
  trouble.repaint?.();
}

function troubleNote(note: TroubleNote): HTMLElement[] {
  switch (note.kind) {
    case "none":
      return [];
    case "working": {
      const line = el("p", "hint memory-working");
      line.append(spinner(), document.createTextNode(` ${note.what}...`));
      return [line];
    }
    case "done":
      return [el("p", "hint", note.text)];
    case "error":
      return [el("p", "error tt-shake", note.message)];
    case "reset-confirm": {
      const [label, field] = input(`Type ${RESET_PHRASE} to confirm`, "text");
      const go = button("quiet danger", "Set aside and restart", () => void resetApp(field.value), "trash");
      go.disabled = true;
      field.addEventListener("input", () => {
        go.disabled = field.value.trim() !== RESET_PHRASE;
      });
      const keep = button("secondary", "Keep everything", () => setTrouble({ kind: "none" }));
      const actions = el("div", "transfer-actions");
      actions.append(go, keep);
      return [
        el("p", "", "Set aside everything this app keeps on this computer, and restart it empty?"),
        el(
          "p",
          "hint",
          "Your world and its key, installed worlds, pictures and narration, saved servers and sign-ins all go. Nothing is deleted: they wait in a dated folder beside the app's data folder until you remove it yourself, and the README says how to bring them back. Local AI engines you installed stay.",
        ),
        label,
        actions,
      ];
    }
  }
}

async function resetApp(phrase: string): Promise<void> {
  const reset = window.odm.resetApp;
  if (!reset || trouble.busy || isGameShowing()) return;
  setTrouble({ kind: "working", what: "Putting your world to sleep and setting its folder aside" }, true);
  const result = await reset(phrase);
  // On success the app restarts and this screen is gone.
  if (!result.ok) setTrouble({ kind: "error", message: result.error });
}

async function checkFiles(): Promise<void> {
  const check = window.odm.localVerify;
  if (!check || trouble.busy) return;
  setTrouble({ kind: "working", what: "Reading every server file" }, true);
  const result = await check();
  if (!result.ok) {
    setTrouble({ kind: "error", message: result.error });
    return;
  }
  const report = result.report;
  if (!report) setTrouble({ kind: "done", text: "This build carries no list to check against (a development run)." });
  else if (!report.unpacked) setTrouble({ kind: "done", text: "Nothing to check yet: the server files are unpacked the first time you enter your world." });
  else if (report.missing.length + report.changed.length === 0) setTrouble({ kind: "done", text: `All ${report.listed} server files are present and intact.` });
  else setTrouble({ kind: "done", text: `Server files ${describeVerify(report)} are wrong. Repair puts them back; your campaigns, pictures and installed worlds are kept.` });
}

async function repairFiles(): Promise<void> {
  const repair = window.odm.localRepair;
  if (!repair || trouble.busy || isGameShowing()) return;
  setTrouble({ kind: "working", what: "Unpacking the server files again" }, true);
  const result = await repair();
  if (!result.ok) {
    setTrouble({ kind: "error", message: result.error });
  } else {
    const found = result.found;
    const wrong = found?.unpacked ? found.missing.length + found.changed.length : 0;
    const what = wrong
      ? `Server files ${describeVerify(found)} were wrong and are back in place.`
      : "The server files are freshly unpacked; nothing was found wrong with them before.";
    const world = result.started ? "Your world is awake again." : "Your world wakes from the new files the next time you enter it.";
    setTrouble({ kind: "done", text: `${what} ${world}` });
  }
  await refresh();
  if (isGameShowing() ? state.overlayName === "settings" : state.screenName === "settings") renderSettings();
}

async function clearCachedFiles(): Promise<void> {
  const clear = window.odm.clearCaches;
  if (!clear || trouble.busy) return;
  setTrouble({ kind: "working", what: "Clearing cached files" }, true);
  const result = await clear();
  setTrouble(
    result.ok
      ? { kind: "done", text: "Cached files cleared. Pages load fresh from each server next time; your sign-ins and your world are untouched." }
      : { kind: "error", message: result.error },
  );
}

async function copySummary(): Promise<void> {
  const summary = window.odm.diagnosticSummary;
  if (!summary || trouble.busy) return;
  setTrouble({ kind: "working", what: "Gathering the summary" }, true);
  const { text } = await summary();
  const copied = await copyText(text);
  setTrouble(
    copied
      ? { kind: "done", text: "Copied. Paste it into your bug report: it names versions, the state of your world and which server files are wrong, and nothing private." }
      : { kind: "error", message: "The summary could not be copied." },
  );
}

function troubleshootingSection(): HTMLElement | null {
  const bridge = window.odm;
  if (state.local.state === "unavailable") return null;
  if (!bridge.localRepair && !bridge.diagnosticSummary) return null;
  const { card, body } = section(
    "refresh",
    "Troubleshooting",
    "For a world that will not wake, or an app that looks wrong after an update. Nothing here touches your campaigns, pictures, installed worlds or sign-ins.",
  );
  const buttons: HTMLButtonElement[] = [];
  let repairButton: HTMLButtonElement | null = null;
  const add = (label: string, control: HTMLButtonElement, hint = ""): void => {
    buttons.push(control);
    const line = row(label, control);
    if (hint) line.append(el("p", "hint", hint));
    body.append(line);
  };
  if (bridge.localVerify) {
    add("Check the server files this app unpacked against the ones it shipped with", button("secondary", "Check files", () => void checkFiles(), "check"));
  }
  if (bridge.localRepair) {
    repairButton = button("secondary", "Repair", () => void repairFiles(), "refresh");
    add(
      "Unpack the server files again, keeping everything you made. Your world restarts if it is awake",
      repairButton,
      isGameShowing() ? "Leave the table first: the world restarts to take the fresh files." : "",
    );
  }
  if (bridge.clearCaches) {
    add("Clear the files the app cached from servers. Sign-ins, saved servers and your world stay", button("secondary", "Clear cached files", () => void clearCachedFiles(), "trash"));
  }
  if (bridge.diagnosticSummary) {
    add(
      "Copy a summary for a bug report: versions, the state of your world, which server files are wrong. No names, keys or campaign text",
      button("secondary", "Copy summary", () => void copySummary(), "copy"),
    );
  }
  if (bridge.showLogs) {
    add("Open the folder that holds the app's log files", button("secondary", "Show logs", () => void bridge.showLogs?.(), "scroll"));
  }
  // The one row that takes the world out of the app's hands sits last,
  // in red, held while a table is open, and asks for a typed word.
  let resetButton: HTMLButtonElement | null = null;
  if (bridge.resetApp) {
    resetButton = button("quiet danger", "Reset the app", () => setTrouble({ kind: "reset-confirm" }), "trash");
    add(
      "Start over: set everything this app keeps on this computer aside (nothing is deleted) and restart it empty",
      resetButton,
      isGameShowing() ? "Leave the table first." : "",
    );
  }
  const status = el("div", "memory-status");
  status.setAttribute("aria-live", "polite");
  body.append(status);
  const came = state.appInfo?.reset;
  if (came) {
    body.append(
      el(
        "p",
        "hint",
        `This start set your previous data aside at ${came.aside}.${came.left.length ? ` Left behind, still held open: ${came.left.join(", ")}.` : ""} Bring it back or remove it as the README says.`,
      ),
    );
  }

  let shownNote: TroubleNote | null = null;
  const paint = (): void => {
    for (const btn of buttons) btn.disabled = trouble.busy || ((btn === repairButton || btn === resetButton) && isGameShowing());
    if (shownNote === trouble.note) return;
    shownNote = trouble.note;
    const nodes = troubleNote(trouble.note);
    const line = el("div", trouble.shown === trouble.note ? "memory-line settled" : "memory-line");
    trouble.shown = trouble.note;
    line.append(...nodes);
    status.replaceChildren(...(nodes.length ? [line] : []));
  };
  trouble.repaint = () => {
    if (card.isConnected) paint();
  };
  paint();
  return card;
}

function homeSection(): HTMLElement {
  const { card, body } = section("scroll", "Title screen", "");
  body.append(row("Hide the save slots of hosts that are offline", offlineToggle(() => renderSettings())));
  return card;
}

function helpSection(): HTMLElement {
  const { card, body } = section("help", "Help", "");
  body.append(
    row("Where everything lives and how to get around", button("secondary", "User guide", () => renderHelp(), "book")),
    row(
      "Walk through the title screen again",
      button("secondary", "Replay tour", () => void refresh().then(() => {
        renderHome();
        startAppTour();
      }), "play"),
    ),
  );
  return card;
}

function serversNote(): HTMLElement | null {
  if (state.servers.length === 0) return null;
  const { card, body } = section(
    "server",
    "Servers",
    "Each server keeps your account, avatar and password on its own Settings page: open the server and use the account menu there. Forgetting a server or deleting your account on it is in the menu beside the server's name.",
  );
  body.remove();
  return card;
}

function legalSection(): HTMLElement {
  const { card, body } = section("link", "Links", "");
  for (const [label, href] of [
    ["User guide online", GUIDE_URL],
    ["Privacy policy", "https://opendungeonmaster.com/privacy/"],
    ["Terms of service", "https://opendungeonmaster.com/terms/"],
  ] as const) {
    const link = el("a", "settings-link", label);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.append(icon("chevronRight"));
    body.append(link);
  }
  return card;
}

export function renderSettings(): void {
  // A status event repainting this screen keeps the story memory note; a
  // fresh visit starts without one (unless a restart is still running).
  const again = isGameShowing() ? state.overlayName === "settings" : state.screenName === "settings";
  // A story memory restart sends the world's status three times (stopped,
  // starting, running). Rebuilding for each would swap the cards out under
  // their transitions; the restart ends where the screen already stands
  // (running), so those repaints are skipped and applyMemory settles it.
  if (again && memory.busy) return;
  if (!again && !memory.busy) memory.note = { kind: "none" };
  if (!again && !trouble.busy) trouble.note = { kind: "none" };
  if (!again) forgetSteamNote();
  // Four everyday jobs, each under its own heading and one tap away from
  // the row at the top: what this device plays like, the world it hosts,
  // the hosts it signs in to, and help and repair (which is never asked of
  // anyone before they can play). Every card is the one it always was.
  const sections = (): (HTMLElement | null)[] => {
    const groups: Array<{ id: string; label: string; detail: string; cards: (HTMLElement | null)[] }> = [
      {
        id: "settings-device",
        label: "Playing on this device",
        detail: "Only on this device: sound, microphone, dice, controllers and the title screen.",
        cards: [audioSection(), deckSection(), homeSection()],
      },
      {
        id: "settings-world",
        label: `Your world on this ${isAndroid ? "device" : "computer"}`,
        detail: "The world this app hosts: who plays there, its Story AI, its memory, and moving it.",
        cards: [deviceSection(), memorySection(), transferSection()],
      },
      {
        id: "settings-accounts",
        label: "Accounts and connections",
        detail: "Servers and friends' worlds this app signs in to.",
        cards: [signInsSection(), worldsSection(), serversNote()],
      },
      {
        id: "settings-help",
        label: "Help and maintenance",
        detail: "Guides, updates, and repairs if something goes wrong.",
        cards: [helpSection(), appSection(), troubleshootingSection(), legalSection()],
      },
    ];
    const shown = groups.filter((group) => group.cards.some(Boolean));
    const contents = el("nav", "settings-contents");
    contents.setAttribute("aria-label", "Settings sections");
    for (const group of shown) {
      const jump = el("button", "settings-jump", group.label);
      jump.type = "button";
      jump.addEventListener("click", () => {
        const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        document.getElementById(group.id)?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
      });
      contents.append(jump);
    }
    return [
      intro("Settings", "What this device plays like, the world it hosts, your sign-ins, and help."),
      contents,
      ...shown.flatMap((group) => {
        const head = el("div", "settings-group");
        head.id = group.id;
        head.append(el("h2", "settings-group-title", group.label), el("p", "settings-group-detail", group.detail));
        return [head, ...group.cards];
      }),
    ];
  };
  // Inside a world, Settings opens over the table so the call and the
  // stream keep running; the way back is to the game, not home.
  if (isGameShowing()) {
    showOverlay("settings", backLink("Back to the game", () => closeOverlay()), ...sections());
    return;
  }
  state.screenName = "settings";
  show("mid", backLink("Home", () => renderHome()), ...sections());
}
