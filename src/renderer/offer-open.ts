// A tapped offer notification (src/shared/offer-notice.ts): the table it
// came from opens, natively, and the offer's card is brought into view once
// the page has drawn it.
import { campaignPath, offerCardSelector, type OfferTarget } from "../shared/offer-notice.js";
import { el } from "./dom.js";
import { gameNavigate, mountedHostId } from "./game-screen.js";
import { playLocal } from "./local.js";
import { connectServer } from "./servers.js";
import { refresh, state } from "./state.js";

const LOCAL = "local";
// How long the card is looked for: a cold entry loads the table first.
const FIND_MS = 20_000;
const STEP_MS = 250;

function revealCard(offerId: string): void {
  const selector = offerCardSelector(offerId);
  const started = Date.now();
  const look = (): void => {
    const card = document.querySelector(selector);
    if (card) {
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      card.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
      return;
    }
    if (Date.now() - started < FIND_MS) setTimeout(look, STEP_MS);
  };
  look();
}

export async function openOffer(target: OfferTarget): Promise<void> {
  const path = campaignPath(target.campaignId);
  if (mountedHostId() === target.hostId && gameNavigate(path)) {
    revealCard(target.offerId);
    return;
  }
  if (target.hostId === LOCAL) {
    await playLocal(null, path);
  } else {
    if (!state.servers.some((entry) => entry.id === target.hostId)) await refresh().catch(() => undefined);
    const server = state.servers.find((entry) => entry.id === target.hostId);
    // A server taken off the list since: nothing to open.
    if (!server) return;
    await connectServer(server, el("button"), path);
  }
  revealCard(target.offerId);
}
