// Which control a D-pad press lands on: from the highlighted control's box,
// the nearest box that lies in that direction, preferring one in the same
// row (or column) over a closer one off to the side. Pure geometry, so the
// rules are tested without a page.

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Direction = "up" | "down" | "left" | "right";

const centerX = (box: Box): number => (box.left + box.right) / 2;
const centerY = (box: Box): number => (box.top + box.bottom) / 2;

function contains(outer: Box, inner: Box): boolean {
  return outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom;
}

// Wholly past the highlighted control's edge (a few pixels of overlap
// forgiven), so a longer menu line above is never "to the right".
function beyond(from: Box, to: Box, dir: Direction): boolean {
  const slack = 4;
  if (dir === "right") return to.left >= from.right - slack;
  if (dir === "left") return to.right <= from.left + slack;
  if (dir === "down") return to.top >= from.bottom - slack;
  return to.bottom <= from.top + slack;
}

function intersects(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// Past the highlighted control's middle: the looser test, only for boxes
// that overlap it (the buttons inside a highlighted card).
function ahead(from: Box, to: Box, dir: Direction): boolean {
  if (!intersects(from, to)) return false;
  if (dir === "right") return centerX(to) > centerX(from) + 0.5;
  if (dir === "left") return centerX(to) < centerX(from) - 0.5;
  if (dir === "down") return centerY(to) > centerY(from) + 0.5;
  return centerY(to) < centerY(from) - 0.5;
}

// Lower is better; Infinity means the box does not lie that way at all.
// strict asks for boxes wholly past the highlighted one's edge.
export function navScore(from: Box, to: Box, dir: Direction, strict = true): number {
  // A box around the highlighted one (its card, its row) is where the
  // player already is, not somewhere to go.
  if (contains(to, from)) return Infinity;
  if (!(strict ? beyond(from, to, dir) : ahead(from, to, dir))) return Infinity;
  const horizontal = dir === "left" || dir === "right";
  const gap = Math.max(
    0,
    dir === "right"
      ? to.left - from.right
      : dir === "left"
        ? from.left - to.right
        : dir === "down"
          ? to.top - from.bottom
          : from.top - to.bottom,
  );
  // How much the two share across the direction of travel: positive when
  // they sit in the same row (or column), negative by the distance between
  // them otherwise.
  const shared = horizontal
    ? Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top)
    : Math.min(from.right, to.right) - Math.max(from.left, to.left);
  const offRow = Math.max(0, -shared);
  const drift = horizontal ? Math.abs(centerY(to) - centerY(from)) : Math.abs(centerX(to) - centerX(from));
  return gap + offRow * 6 + (shared > 0 ? 0 : 40) + drift * 0.05;
}

// The index of the best box in that direction, -1 when nothing lies there.
// Boxes clear of the highlighted one come first; only when there are none
// do overlapping ones count.
export function pickNext(from: Box, candidates: readonly Box[], dir: Direction): number {
  for (const strict of [true, false]) {
    let best = -1;
    let bestScore = Infinity;
    candidates.forEach((box, index) => {
      const score = navScore(from, box, dir, strict);
      if (score < bestScore) {
        best = index;
        bestScore = score;
      }
    });
    if (best >= 0) return best;
  }
  return -1;
}

// Where the highlight starts when nothing is highlighted yet: the box
// nearest the top left of what is on screen, reading order.
export function pickFirst(candidates: readonly Box[], viewport: { width: number; height: number }): number {
  let best = -1;
  let bestKey = Infinity;
  candidates.forEach((box, index) => {
    const onScreen = box.bottom > 0 && box.top < viewport.height && box.right > 0 && box.left < viewport.width;
    const key = (onScreen ? 0 : 1e9) + Math.max(0, box.top) * 4 + Math.max(0, box.left);
    if (key < bestKey) {
      best = index;
      bestKey = key;
    }
  });
  return best;
}

// A control that takes some D-pad presses as a change of its own value
// rather than a move away: a drawn slider (the kit's level controls) takes
// left and right, and a window splitter (the table's arrangement, server
// TableLayoutParts.tsx) takes the two directions it moves in, sideways for
// a line between columns, up and down for one between stacked panes. The
// arrow key it hears, or null when the press should move the highlight.
// A separator's orientation defaults to horizontal, as in ARIA.
export function ownArrowKey(role: string | null, orientation: string | null, dir: Direction): string | null {
  const key = dir === "left" ? "ArrowLeft" : dir === "right" ? "ArrowRight" : dir === "up" ? "ArrowUp" : "ArrowDown";
  const sideways = dir === "left" || dir === "right";
  if (role === "slider") return sideways ? key : null;
  if (role === "separator") return (orientation === "vertical") === sideways ? key : null;
  return null;
}
