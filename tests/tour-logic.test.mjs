import assert from "node:assert/strict";
import test from "node:test";
import {
  markTourSeen,
  placeCard,
  resolveSteps,
  tourSeen,
} from "../dist/shared/tour-logic.js";

const STEPS = [
  { id: "welcome", title: "Welcome", body: "Hello", anchors: [] },
  { id: "add", title: "Add", body: "Add a server", anchors: ["add-server", "invite"] },
  {
    id: "workshop",
    title: "Workshop",
    body: "The tile",
    anchors: ["tile-workshop", "hero"],
    fallbackBody: "Once your world begins the tile appears here",
  },
  { id: "gone", title: "Gone", body: "Never", anchors: ["nothing-here"] },
];

test("resolveSteps keeps centred steps, lights the first present anchor, and drops the rest", () => {
  const present = (anchor) => ["invite", "hero"].includes(anchor);
  const resolved = resolveSteps(STEPS, present);
  assert.deepEqual(
    resolved.map((entry) => [entry.step.id, entry.anchor, entry.body]),
    [
      ["welcome", "", "Hello"],
      ["add", "invite", "Add a server"],
      ["workshop", "hero", "Once your world begins the tile appears here"],
    ],
  );
});

test("resolveSteps uses the main body when the first anchor is there", () => {
  const resolved = resolveSteps(STEPS, (anchor) => anchor === "tile-workshop");
  assert.equal(resolved.find((entry) => entry.step.id === "workshop").body, "The tile");
});

const VIEW = { width: 400, height: 800 };
const CARD = { width: 300, height: 160 };

test("placeCard centres a card with no target", () => {
  assert.deepEqual(placeCard(null, CARD, VIEW), { top: 320, left: 50, side: "center" });
});

test("placeCard goes below a target near the top, above one near the bottom", () => {
  const top = placeCard({ top: 20, left: 40, width: 100, height: 40 }, CARD, VIEW);
  assert.equal(top.side, "below");
  assert.equal(top.top, 74);
  const bottom = placeCard({ top: 720, left: 40, width: 100, height: 40 }, CARD, VIEW);
  assert.equal(bottom.side, "above");
  assert.equal(bottom.top, 720 - 14 - 160);
});

test("placeCard never leaves the viewport", () => {
  const edge = placeCard({ top: 20, left: 380, width: 20, height: 20 }, CARD, VIEW);
  assert.ok(edge.left + CARD.width + 12 <= VIEW.width);
  assert.ok(edge.left >= 12);
});

test("placeCard sits beside a tall target on a wide screen", () => {
  const wide = { width: 1400, height: 700 };
  const placed = placeCard({ top: 10, left: 100, width: 200, height: 680 }, CARD, wide);
  assert.equal(placed.side, "right");
  assert.equal(placed.left, 314);
});

test("tourSeen and markTourSeen round-trip through the store", () => {
  const store = new Map();
  const shim = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.equal(tourSeen(shim, "app"), false);
  markTourSeen(shim, "app");
  assert.equal(tourSeen(shim, "app"), true);
  assert.equal(tourSeen(shim, "table"), false);
});

test("a store that throws counts as seen, so a broken storage never nags", () => {
  const broken = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  assert.equal(tourSeen(broken, "app"), true);
  assert.doesNotThrow(() => markTourSeen(broken, "app"));
});

test("a later anchor that is a real door gets its own wording, not the stand-in's", () => {
  const step = {
    id: "campaign",
    title: "Start a campaign",
    body: "Quick start or New campaign.",
    anchors: ["tile-quick-start", "tile-new-campaign", "hero"],
    fallbackBody: "Begin your world here.",
    anchorBodies: { "tile-new-campaign": "New campaign builds your own table." },
  };
  const on = (...present) => resolveSteps([step], (anchor) => present.includes(anchor))[0].body;
  assert.equal(on("tile-quick-start", "tile-new-campaign"), "Quick start or New campaign.");
  assert.equal(on("tile-new-campaign", "hero"), "New campaign builds your own table.");
  assert.equal(on("hero"), "Begin your world here.");
});
