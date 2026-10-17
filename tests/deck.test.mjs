import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_TALK_NOTICE,
  PAD_LEGEND,
  STEAM_KEYBOARD_CLOSE,
  deckFlag,
  deckLaunchArgs,
  deckStatusLine,
  detectDeck,
  parseDeckChoice,
  steamKeyboardUrl,
  withDeckChoice,
} from "../dist/shared/deck.js";

const quiet = { env: {}, argv: [], dmiVendor: "", dmiProduct: "", osRelease: "", choice: "auto" };

test("a desktop is no Deck and the layout stays off on auto", () => {
  const info = detectDeck({ ...quiet, osRelease: 'NAME="Fedora Linux"\nID=fedora\n', dmiVendor: "ASUSTeK" });
  assert.deepEqual(info, { device: false, gameMode: false, steam: false, choice: "auto", forced: "", active: false });
});

test("both Deck boards, SteamOS and Steam's SteamDeck=1 all count as the handheld", () => {
  for (const product of ["Jupiter", "Galileo\n"]) {
    assert.equal(detectDeck({ ...quiet, dmiVendor: "Valve\n", dmiProduct: product }).device, true);
  }
  assert.equal(detectDeck({ ...quiet, dmiVendor: "Valve", dmiProduct: "Index" }).device, false);
  assert.equal(detectDeck({ ...quiet, osRelease: 'NAME="SteamOS"\nID=steamos\nID_LIKE=arch\n' }).device, true);
  assert.equal(detectDeck({ ...quiet, osRelease: 'ID="steamos"\n' }).device, true);
  assert.equal(detectDeck({ ...quiet, osRelease: "ID=arch\nID_LIKE=steamos\n" }).device, false);
  assert.equal(detectDeck({ ...quiet, env: { SteamDeck: "1" } }).device, true);
  assert.equal(detectDeck({ ...quiet, env: { SteamDeck: "0" } }).device, false);
  const deck = detectDeck({ ...quiet, dmiVendor: "Valve", dmiProduct: "Jupiter" });
  assert.equal(deck.active, true);
  assert.equal(deck.gameMode, false);
});

test("Game Mode is gamescope, on a Deck or anywhere else, and means Steam is there", () => {
  const byDesktop = detectDeck({ ...quiet, env: { XDG_CURRENT_DESKTOP: "gamescope" } });
  assert.equal(byDesktop.gameMode, true);
  assert.equal(byDesktop.steam, true);
  assert.equal(byDesktop.active, true);
  assert.equal(byDesktop.device, false);
  assert.equal(detectDeck({ ...quiet, env: { GAMESCOPE_WAYLAND_DISPLAY: "gamescope-0" } }).gameMode, true);
  assert.equal(detectDeck({ ...quiet, env: { XDG_CURRENT_DESKTOP: "KDE" } }).gameMode, false);
});

test("a non-Steam shortcut launch is seen from Steam's own variables", () => {
  for (const env of [{ SteamGameId: "16045389826520522752" }, { SteamAppId: "0" }, { SteamClientLaunch: "1" }, { SteamEnv: "1" }]) {
    const info = detectDeck({ ...quiet, env });
    assert.equal(info.steam, true, JSON.stringify(env));
    assert.equal(info.active, false, "Steam on a desktop alone does not switch the layout");
  }
});

test("the saved choice decides over auto, and a launch flag decides over both", () => {
  const deck = { ...quiet, dmiVendor: "Valve", dmiProduct: "Galileo" };
  assert.equal(detectDeck({ ...deck, choice: "off" }).active, false);
  assert.equal(detectDeck({ ...quiet, choice: "on" }).active, true);
  assert.equal(detectDeck({ ...deck, choice: "on", argv: ["app", "--no-steam-deck"] }).active, false);
  assert.equal(detectDeck({ ...quiet, choice: "off", argv: ["app", "--steam-deck"] }).active, true);
  assert.equal(deckFlag(["--steam-deck", "--no-steam-deck"]), "off");
  assert.equal(deckFlag(["odm://join/X"]), "");
  // An update's restart passes the flag on, and nothing else (a join link
  // would join again).
  assert.deepEqual(deckLaunchArgs(["app", "odm://join/X", "--steam-deck"]), ["--steam-deck"]);
  assert.deepEqual(deckLaunchArgs(["app", "--steam-deck", "--no-steam-deck"]), ["--no-steam-deck"]);
  assert.deepEqual(deckLaunchArgs(["app", "odm://join/X"]), []);
  assert.equal(parseDeckChoice("on"), "on");
  assert.equal(parseDeckChoice("sideways"), "auto");
  assert.equal(parseDeckChoice(undefined), "auto");
});

test("changing the choice in Settings recomputes the layout but keeps a launch flag's word", () => {
  const deck = detectDeck({ ...quiet, dmiVendor: "Valve", dmiProduct: "Jupiter" });
  assert.equal(withDeckChoice(deck, "off").active, false);
  assert.equal(withDeckChoice(deck, "auto").active, true);
  const forced = detectDeck({ ...quiet, argv: ["--steam-deck"] });
  assert.equal(withDeckChoice(forced, "off").active, true);
  assert.equal(withDeckChoice(forced, "off").choice, "off");
});

test("the status line says what was found and who decided", () => {
  assert.equal(
    deckStatusLine(detectDeck({ ...quiet, dmiVendor: "Valve", dmiProduct: "Jupiter", env: { XDG_CURRENT_DESKTOP: "gamescope" } })),
    "This is a Steam Deck in Game Mode. The Deck layout is on.",
  );
  assert.equal(deckStatusLine(detectDeck(quiet)), "This is not a Steam Deck. The Deck layout is off.");
  assert.match(deckStatusLine(detectDeck({ ...quiet, argv: ["--no-steam-deck"] })), /--no-steam-deck/);
});

test("Steam's keyboard link carries a clean rect and the line mode", () => {
  assert.equal(
    steamKeyboardUrl({ x: 100.4, y: 650.6, width: 800, height: 44 }, true),
    "steam://open/keyboard?XPosition=100&YPosition=651&Width=800&Height=44&Mode=1",
  );
  assert.equal(
    steamKeyboardUrl({ x: -5, y: Number.NaN, width: 1e9, height: "40" }, false),
    "steam://open/keyboard?XPosition=0&YPosition=0&Width=16384&Height=0&Mode=0",
  );
  assert.equal(steamKeyboardUrl(null, false), "steam://open/keyboard?XPosition=0&YPosition=0&Width=0&Height=0&Mode=0");
  assert.equal(STEAM_KEYBOARD_CLOSE, "steam://close/keyboard");
});

// Each shoulder works only once something is set up, and says what: L1 once
// Audio and dice has the mic on Push to talk, R1 once the world has speech to
// text (the server hides its mic without it, and R1 then shows NO_TALK_NOTICE).
test("the shoulders' lines say what each needs before it talks", () => {
  const line = (control) => PAD_LEGEND.find((entry) => entry.control.startsWith(control)).does;
  assert.match(line("L1"), /, once Audio and dice has the mic on Push to talk$/);
  assert.match(line("R1"), /^Talk to the Dungeon Master, once the world has speech to text: /);
  assert.match(NO_TALK_NOTICE, /^This world has no speech to text yet\./);
});

test("the legend names every control the navigator answers to", () => {
  const controls = PAD_LEGEND.map((entry) => entry.control).join(" | ");
  for (const name of ["D-pad", "A", "B", "X", "L1", "R1", "L2", "Menu", "View"]) {
    assert.match(controls, new RegExp(`\\b${name}\\b`), name);
  }
});
