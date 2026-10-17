import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The hold-to-dictate key (server issue 291) is chosen on the server's
// screens, which the apps draw, and refused there when it would fight
// something. The desktop app's own menu takes its accelerators before a page
// sees them, and the controller's L1 sends voice chat's push-to-talk key, so
// every one of those must be a key the server's rules refuse. A menu item
// added here with a free key fails this until the server keeps it too.

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.resolve(process.env.ODM_SERVER_DIR ?? path.join(repo, "..", "open-dungeon-master"));
const rulesFile = path.join(serverDir, "src", "lib", "dictation-shortcut.ts");
const windowSource = fs.readFileSync(path.join(repo, "src", "main", "window.ts"), "utf8");
const gamepadSource = fs.readFileSync(path.join(repo, "src", "renderer", "gamepad.ts"), "utf8");

// What Electron binds a menu role to when the template names no accelerator.
const ROLE_ACCELERATORS = {
  quit: ["CmdOrCtrl+Q"],
  reload: ["CmdOrCtrl+R"],
  forceReload: ["Shift+CmdOrCtrl+R"],
  toggleDevTools: ["Alt+CmdOrCtrl+I"],
  resetZoom: ["CmdOrCtrl+0"],
  zoomIn: ["CmdOrCtrl+Plus", "CmdOrCtrl+="],
  zoomOut: ["CmdOrCtrl+-"],
  togglefullscreen: ["F11", "Ctrl+Cmd+F"],
  close: ["CmdOrCtrl+W"],
  minimize: ["CmdOrCtrl+M"],
};

const KEY_CODES = { "+": "Equal", Plus: "Equal", "=": "Equal", "-": "Minus", "0": "Digit0" };

// One accelerator as the chords a press of it makes on each platform.
function chordsOf(accelerator) {
  const parts = accelerator.split("+").filter(Boolean);
  const key = accelerator.endsWith("++") ? "+" : parts.pop();
  const code = KEY_CODES[key] ?? (/^[A-Z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key);
  const plus = key === "Plus" || key === "+";
  const make = (mac) => ({
    code,
    ctrl: parts.some((part) => part === "Ctrl" || part === "Control" || (!mac && (part === "CmdOrCtrl" || part === "CommandOrControl"))),
    alt: parts.some((part) => part === "Alt" || part === "Option"),
    shift: plus || parts.includes("Shift"),
    meta: parts.some((part) => part === "Cmd" || part === "Command" || part === "Super" || (mac && (part === "CmdOrCtrl" || part === "CommandOrControl"))),
    label: key,
  });
  return [make(false), make(true)];
}

test("the desktop menu's accelerators and the pad's push-to-talk key are refused as the dictation key", { skip: !fs.existsSync(rulesFile) }, async () => {
  const { chordProblem } = await import(pathToFileURL(rulesFile).href);
  const accelerators = [
    ...[...windowSource.matchAll(/accelerator:\s*"([^"]+)"/g)].map((match) => match[1]),
    ...[...windowSource.matchAll(/role:\s*"([^"]+)"/g)].flatMap((match) => ROLE_ACCELERATORS[match[1]] ?? []),
  ];
  assert.ok(accelerators.includes("CmdOrCtrl+M"), "the menu's Home shortcut was found");
  assert.ok(accelerators.includes("F11"), "the full screen role's shortcut was found");
  for (const accelerator of accelerators) {
    for (const chord of chordsOf(accelerator)) {
      assert.ok(chordProblem(chord), `${accelerator} (${JSON.stringify(chord)}) is free as a dictation key, but the menu takes it first`);
    }
  }
  const ptt = /const PTT_CODE = "([^"]+)"/.exec(gamepadSource)?.[1];
  assert.equal(ptt, "Backquote");
  assert.match(chordProblem({ code: ptt, ctrl: false, alt: false, shift: false, meta: false, label: "`" }), /push-to-talk/);
});

test("a key the server accepts is one no menu item or pad button sends", { skip: !fs.existsSync(rulesFile) }, async () => {
  const { chordProblem } = await import(pathToFileURL(rulesFile).href);
  assert.equal(chordProblem({ code: "KeyM", ctrl: false, alt: true, shift: false, meta: false, label: "M" }), null);
  assert.equal(chordProblem({ code: "F8", ctrl: false, alt: false, shift: false, meta: false, label: "F8" }), null);
});
