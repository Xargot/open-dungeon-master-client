// The guided tour's pure half: what a step is, which steps a screen can
// show, and where the explaining card sits next to the thing it points at.
// The renderer (src/renderer/tour.ts) owns the DOM; this file owns the
// decisions, so node tests can drive them without a browser.

export interface TourStep {
  id: string;
  title: string;
  body: string;
  // data-tour values to point at, best first. An empty list is a centred
  // card with no spotlight (a welcome or a closing word).
  anchors: string[];
  // Shown instead of body when the step landed on a later anchor than its
  // first choice (the tile is not on screen yet, so the hero stands in).
  fallbackBody?: string;
  // Exact wording for a later anchor that is a real door rather than a
  // stand-in: New campaign where no Quick start is offered (a world with no
  // AI storyteller), or the drawer's Story AI. Beats fallbackBody.
  anchorBodies?: Record<string, string>;
}

export interface ResolvedStep {
  step: TourStep;
  // The anchor that was found, "" for a centred card.
  anchor: string;
  body: string;
}

// Keeps the steps whose target exists on the current screen (or that need
// none), each with the anchor that will be lit. A step none of whose
// anchors exist is skipped rather than shown pointing at nothing.
export function resolveSteps(
  steps: readonly TourStep[],
  present: (anchor: string) => boolean,
): ResolvedStep[] {
  const out: ResolvedStep[] = [];
  for (const step of steps) {
    if (step.anchors.length === 0) {
      out.push({ step, anchor: "", body: step.body });
      continue;
    }
    const index = step.anchors.findIndex(present);
    if (index < 0) continue;
    out.push({
      step,
      anchor: step.anchors[index] ?? "",
      body: step.anchorBodies?.[step.anchors[index] ?? ""] ?? (index > 0 && step.fallbackBody ? step.fallbackBody : step.body),
    });
  }
  return out;
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  // Which side of the target the card ended up on, for the pointer.
  side: "below" | "above" | "right" | "left" | "center";
}

// The card goes under the target when there is room, above it otherwise,
// beside it on a wide screen when neither fits, and centred when there is
// no target at all. Always clamped to the viewport with a margin so no
// edge of it is ever off screen.
export function placeCard(
  target: Rect | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 14,
  margin = 12,
): Placement {
  const clampLeft = (left: number): number =>
    Math.max(margin, Math.min(left, viewport.width - card.width - margin));
  const clampTop = (top: number): number =>
    Math.max(margin, Math.min(top, viewport.height - card.height - margin));
  if (!target) {
    return {
      top: clampTop((viewport.height - card.height) / 2),
      left: clampLeft((viewport.width - card.width) / 2),
      side: "center",
    };
  }
  const centredLeft = clampLeft(target.left + target.width / 2 - card.width / 2);
  const below = target.top + target.height + gap;
  if (below + card.height + margin <= viewport.height) {
    return { top: below, left: centredLeft, side: "below" };
  }
  const above = target.top - gap - card.height;
  if (above >= margin) {
    return { top: above, left: centredLeft, side: "above" };
  }
  const centredTop = clampTop(target.top + target.height / 2 - card.height / 2);
  const right = target.left + target.width + gap;
  if (right + card.width + margin <= viewport.width) {
    return { top: centredTop, left: right, side: "right" };
  }
  const left = target.left - gap - card.width;
  if (left >= margin) {
    return { top: centredTop, left, side: "left" };
  }
  // Nothing fits cleanly (a target filling the screen): overlap its lower
  // half rather than hide it entirely.
  return { top: clampTop(target.top + target.height - card.height - margin), left: centredLeft, side: "below" };
}

// Whether a tour has been seen, in the store the caller hands over (the
// renderer passes localStorage; tests pass a Map).
export interface TourStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function tourKey(tourId: string): string {
  return `odm.tour.${tourId}`;
}

export function tourSeen(store: TourStore, tourId: string): boolean {
  try {
    return store.getItem(tourKey(tourId)) === "done";
  } catch {
    return true;
  }
}

export function markTourSeen(store: TourStore, tourId: string): void {
  try {
    store.setItem(tourKey(tourId), "done");
  } catch {
    // Storage can be denied; the tour then simply shows again next launch.
  }
}
