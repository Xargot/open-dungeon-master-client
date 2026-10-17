// The Steam Deck layout: how the desktop app knows it is on a Deck (or
// inside Steam's Game Mode on any machine), what the player chose about it,
// and what the controller does. Pure, so the main process, the shell's
// screens and the tests all read the same rules.

// The player's choice in Settings. "auto" (the default, never stored) turns
// the layout on on a Deck and in Game Mode, and leaves a desktop alone.
export type DeckChoice = "auto" | "on" | "off";

export interface DeckSignals {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  // /sys/devices/virtual/dmi/id/board_vendor and product_name, "" when
  // unreadable (not Linux, or a sandbox that hides them).
  dmiVendor: string;
  dmiProduct: string;
  // The host's os-release; inside a flatpak that is /run/host/os-release.
  osRelease: string;
  choice: DeckChoice;
}

export interface DeckInfo {
  // Valve's handheld, or anything running SteamOS.
  device: boolean;
  // Steam's Game Mode (gamescope) draws the screen: no desktop, no window
  // frame, and the controller is the only input most players have.
  gameMode: boolean;
  // Steam started the app (a non-Steam game shortcut) or owns the session,
  // so its on-screen keyboard can be asked for.
  steam: boolean;
  // The saved choice, and the launch flag that overrides it for this run
  // ("" when the app was started without one).
  choice: DeckChoice;
  forced: "on" | "off" | "";
  // The result: the Deck layout is drawn.
  active: boolean;
}

// LCD and OLED Decks report these board names.
const DECK_BOARDS = /^(jupiter|galileo)$/i;

export function parseDeckChoice(raw: unknown): DeckChoice {
  return raw === "on" || raw === "off" ? raw : "auto";
}

// A Steam launch option can force the layout either way for one shortcut:
// "--steam-deck" on a desktop that streams to the Deck, "--no-steam-deck"
// on a Deck docked to a monitor.
export function deckFlag(argv: readonly string[]): "on" | "off" | "" {
  if (argv.includes("--no-steam-deck")) return "off";
  if (argv.includes("--steam-deck")) return "on";
  return "";
}

// That launch option again, for an update that starts the app anew
// (src/main/index.ts), so the forced layout outlives the restart.
export function deckLaunchArgs(argv: readonly string[]): string[] {
  const flag = deckFlag(argv);
  return flag === "on" ? ["--steam-deck"] : flag === "off" ? ["--no-steam-deck"] : [];
}

function osId(osRelease: string): string {
  const match = /^ID=["']?([^"'\n]*)/m.exec(osRelease);
  return (match?.[1] ?? "").trim().toLowerCase();
}

export function detectDeck(signals: DeckSignals): DeckInfo {
  const { env } = signals;
  const device =
    (signals.dmiVendor.trim().toLowerCase() === "valve" && DECK_BOARDS.test(signals.dmiProduct.trim())) ||
    env.SteamDeck === "1" ||
    osId(signals.osRelease) === "steamos";
  const gameMode = /gamescope/i.test(env.XDG_CURRENT_DESKTOP ?? "") || Boolean(env.GAMESCOPE_WAYLAND_DISPLAY);
  // Steam sets these for everything it launches, non-Steam shortcuts too.
  const steam =
    gameMode ||
    Boolean(env.SteamGameId || env.SteamAppId || env.SteamOverlayGameId) ||
    env.SteamClientLaunch === "1" ||
    env.SteamEnv === "1";
  const choice = parseDeckChoice(signals.choice);
  const forced = deckFlag(signals.argv);
  const wanted = forced || choice;
  const active = wanted === "on" ? true : wanted === "off" ? false : device || gameMode;
  return { device, gameMode, steam, choice, forced, active };
}

// The same info with a new saved choice, for the Settings switch.
export function withDeckChoice(info: DeckInfo, choice: DeckChoice): DeckInfo {
  const wanted = info.forced || choice;
  const active = wanted === "on" ? true : wanted === "off" ? false : info.device || info.gameMode;
  return { ...info, choice, active };
}

// One line for Settings about what the app found.
export function deckStatusLine(info: DeckInfo): string {
  const where = info.device
    ? info.gameMode
      ? "This is a Steam Deck in Game Mode."
      : "This is a Steam Deck in Desktop Mode."
    : info.gameMode
      ? "Steam's Game Mode is running this app."
      : "This is not a Steam Deck.";
  const forced = info.forced ? ` A launch option (--${info.forced === "on" ? "" : "no-"}steam-deck) decides for this run.` : "";
  return `${where} The Deck layout is ${info.active ? "on" : "off"}.${forced}`;
}

// The field Steam's keyboard should stay clear of, in screen pixels.
export interface FieldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function pixels(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
  return Math.max(0, Math.min(number, 16384));
}

// Steam's floating keyboard, the same deep link SDL opens on a Deck. Mode 0
// is one line (Enter closes it), 1 is many lines. A missing or malformed
// rect asks Steam to place the keyboard itself.
export function steamKeyboardUrl(field: Partial<FieldRect> | null | undefined, multiline: boolean): string {
  const rect = field ?? {};
  const query = new URLSearchParams({
    XPosition: String(pixels(rect.x)),
    YPosition: String(pixels(rect.y)),
    Width: String(pixels(rect.width)),
    Height: String(pixels(rect.height)),
    Mode: multiline ? "1" : "0",
  });
  return `steam://open/keyboard?${query.toString()}`;
}

export const STEAM_KEYBOARD_CLOSE = "steam://close/keyboard";

// What each control does, in the order Settings and the guide list them.
// The names are the Deck's own; an Xbox pad's LB/RB/LT/RT sit in the same
// places, and the navigator reads the standard mapping either way.
export const PAD_LEGEND: readonly { control: string; does: string }[] = [
  { control: "D-pad or left stick", does: "Move between buttons, fields and save slots" },
  { control: "A", does: "Press the highlighted button; on a text box, type with Steam's keyboard" },
  { control: "B", does: "Back: close a menu or dialog first, then the previous page" },
  { control: "X", does: "At the table, jump to the message box and open the keyboard" },
  { control: "L1 (hold)", does: "Push to talk in voice chat, once Audio and dice has the mic on Push to talk" },
  { control: "R1 (hold)", does: "Talk to the Dungeon Master, once the world has speech to text: hold, speak, let go, and the words land in the message box" },
  { control: "L2, R2 or right stick", does: "Scroll" },
  { control: "Menu", does: "Open the app menu" },
  { control: "View", does: "Open or close App settings" },
];

// What R1 says at a table that has a message box and no mic beside it: the
// server hides its hold-to-talk button when nothing can turn speech into
// text (no Whisper, no built-in engine, no phone recognizer).
export const NO_TALK_NOTICE = "This world has no speech to text yet. An admin can install it under Admin > Speech.";
