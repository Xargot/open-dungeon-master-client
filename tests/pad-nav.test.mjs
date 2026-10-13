import assert from "node:assert/strict";
import test from "node:test";
import { PAD_INDEX, PadReader } from "../dist/shared/pad-input.js";
import { navScore, ownArrowKey, pickFirst, pickNext } from "../dist/shared/spatial-nav.js";

const box = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });

// A 3x3 grid of 100x40 buttons, 20px apart.
const grid = [];
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 3; col++) grid.push(box(col * 120, row * 60, 100, 40));
}

test("the D-pad walks a grid one neighbour at a time and stops at the edges", () => {
  const center = grid[4];
  const others = grid.filter((entry) => entry !== center);
  const at = (dir) => grid.indexOf(others[pickNext(center, others, dir)]);
  assert.equal(at("up"), 1);
  assert.equal(at("down"), 7);
  assert.equal(at("left"), 3);
  assert.equal(at("right"), 5);
  const corner = grid[0];
  const rest = grid.slice(1);
  assert.equal(pickNext(corner, rest, "up"), -1);
  assert.equal(pickNext(corner, rest, "left"), -1);
});

test("a control in the same row wins over a closer one off to the side", () => {
  const from = box(0, 100, 100, 40);
  const sameRowFar = box(400, 105, 100, 40);
  const diagonalNear = box(130, 10, 100, 40);
  assert.equal(pickNext(from, [diagonalNear, sameRowFar], "right"), 1);
  // Nearly aligned and close still beats aligned but far.
  const nearlyAligned = box(130, 150, 100, 40);
  assert.equal(pickNext(from, [sameRowFar, nearlyAligned], "right"), 1);
});

test("a longer menu line above is not to the right; the save slots across the screen are", () => {
  // The title screen: stacked menu lines of different widths, slots far right.
  const newCampaign = box(96, 478, 188, 30);
  const quickStart = box(96, 532, 162, 30);
  const characters = box(96, 586, 160, 30);
  const slot = box(700, 682, 176, 220);
  const candidates = [newCampaign, characters, slot];
  assert.equal(pickNext(quickStart, candidates, "right"), 2);
  assert.equal(pickNext(quickStart, candidates, "down"), 1);
  assert.equal(pickNext(quickStart, candidates, "up"), 0);
  // With nothing to the right at all, right goes nowhere rather than up.
  assert.equal(pickNext(quickStart, [newCampaign, characters], "right"), -1);
});

test("buttons inside a highlighted card are reachable, the card around a button is not a target", () => {
  const card = box(0, 0, 400, 200);
  const inner = box(250, 80, 100, 40);
  assert.equal(pickNext(card, [inner], "right"), 0);
  assert.equal(navScore(inner, card, "left"), Infinity);
  assert.equal(navScore(inner, card, "left", false), Infinity);
});

test("the first highlight is the top-left control on screen", () => {
  const offscreen = box(0, -400, 100, 40);
  const lower = box(0, 300, 100, 40);
  const top = box(500, 40, 100, 40);
  assert.equal(pickFirst([offscreen, lower, top], { width: 1280, height: 800 }), 2);
  assert.equal(pickFirst([], { width: 1280, height: 800 }), -1);
});

const rest = () => ({ buttons: new Array(17).fill(0), axes: [0, 0, 0, 0] });
const pressing = (...indices) => {
  const pad = rest();
  for (const index of indices) pad.buttons[index] = 1;
  return pad;
};

test("a press fires once on the way down, and a held direction repeats after a pause", () => {
  const reader = new PadReader();
  assert.deepEqual(reader.read([pressing(PAD_INDEX.a)], 0), [{ kind: "press", button: "a" }]);
  assert.deepEqual(reader.read([pressing(PAD_INDEX.a)], 16), []);
  assert.deepEqual(reader.read([rest()], 32), []);

  const moves = [];
  for (let t = 100; t <= 700; t += 10) {
    for (const action of reader.read([pressing(PAD_INDEX.down)], t)) moves.push([t, action.kind, action.dir]);
  }
  assert.deepEqual(moves[0], [100, "move", "down"]);
  // First repeat after 380 ms, then every 110 ms.
  assert.deepEqual(moves.map(([t]) => t), [100, 480, 590, 700]);
  // A new direction moves at once.
  assert.deepEqual(reader.read([pressing(PAD_INDEX.right)], 705), [{ kind: "move", dir: "right" }]);
});

test("the left stick steers like the D-pad along its stronger axis", () => {
  const reader = new PadReader();
  const stick = (x, y) => ({ buttons: new Array(17).fill(0), axes: [x, y, 0, 0] });
  assert.deepEqual(reader.read([stick(0.3, 0.2)], 0), []);
  assert.deepEqual(reader.read([stick(-0.9, 0.4)], 10), [{ kind: "move", dir: "left" }]);
  assert.deepEqual(reader.read([stick(0.1, -0.8)], 20), [{ kind: "move", dir: "up" }]);
});

test("the shoulders hold and let go, and a vanished pad lets go too", () => {
  const reader = new PadReader();
  assert.deepEqual(reader.read([pressing(PAD_INDEX.lb)], 0), [{ kind: "hold", button: "lb", down: true }]);
  assert.deepEqual(reader.read([pressing(PAD_INDEX.lb, PAD_INDEX.rb)], 16), [{ kind: "hold", button: "rb", down: true }]);
  assert.deepEqual(reader.read([], 32), [
    { kind: "hold", button: "lb", down: false },
    { kind: "hold", button: "rb", down: false },
  ]);
});

test("two pads read as one: a resting second pad never cancels the first", () => {
  const reader = new PadReader();
  assert.deepEqual(reader.read([rest(), pressing(PAD_INDEX.b)], 0), [{ kind: "press", button: "b" }]);
  const stick = { buttons: new Array(17).fill(0), axes: [0, 0.95, 0, 0] };
  assert.deepEqual(reader.read([rest(), stick], 10), [{ kind: "move", dir: "down" }]);
});

test("the right stick and the triggers scroll, gently at first, and rest in the deadzone", () => {
  const reader = new PadReader();
  const scrollPad = (ry, lt = 0, rt = 0) => {
    const pad = rest();
    pad.axes[3] = ry;
    pad.buttons[PAD_INDEX.lt] = lt;
    pad.buttons[PAD_INDEX.rt] = rt;
    return pad;
  };
  reader.read([scrollPad(0.1)], 0);
  assert.deepEqual(reader.read([scrollPad(0.1)], 16), []);
  const full = reader.read([scrollPad(1)], 32);
  assert.equal(full.length, 1);
  assert.equal(full[0].kind, "scroll");
  assert.ok(full[0].dy >= 24 && full[0].dy <= 26, `full deflection over 16 ms: ${full[0].dy}`);
  // A light push creeps: the fractions add up over frames.
  let crept = 0;
  for (let t = 48; t <= 48 + 16 * 30; t += 16) {
    for (const action of reader.read([scrollPad(0.3)], t)) crept += action.dy;
  }
  assert.ok(crept > 0 && crept < 60, `light push over half a second: ${crept}`);
  const up = reader.read([scrollPad(0, 1, 0)], 600);
  assert.ok(up[0].dy < 0, "the left trigger scrolls up");
});

test("a slider keeps left and right; a line between panels keeps the two directions it moves in", () => {
  assert.equal(ownArrowKey("slider", null, "right"), "ArrowRight");
  assert.equal(ownArrowKey("slider", null, "up"), null);
  // Between two columns (server TableLayoutParts.tsx): sideways resizes,
  // up and down leave it for the next control.
  assert.equal(ownArrowKey("separator", "vertical", "left"), "ArrowLeft");
  assert.equal(ownArrowKey("separator", "vertical", "right"), "ArrowRight");
  assert.equal(ownArrowKey("separator", "vertical", "down"), null);
  // Between stacked panes, and ARIA's default when none is said.
  assert.equal(ownArrowKey("separator", "horizontal", "up"), "ArrowUp");
  assert.equal(ownArrowKey("separator", null, "down"), "ArrowDown");
  assert.equal(ownArrowKey("separator", "horizontal", "left"), null);
  assert.equal(ownArrowKey("button", null, "left"), null);
  assert.equal(ownArrowKey(null, null, "right"), null);
});
