// The game screens' half of an offer's system notification
// (src/shared/offer-notice.ts): every event of the host's streams passes
// here on its way to the page, and an offer only this player may answer is
// handed to the shell (window.odm.offerNotice), which decides with what it
// knows of the app being in front.
import type { HostClient } from "../api/host.js";
import type { SseEvent } from "../../shared/sse.js";
import { createOfferWatch, offerCardSelector } from "../../shared/offer-notice.js";

// The signed-in account per host session, asked once and only when an
// owner-only offer first arrives.
const accounts = new WeakMap<HostClient, Promise<string>>();

function accountOf(client: HostClient): Promise<string> {
  let account = accounts.get(client);
  if (!account) {
    account = client
      .json<{ user?: { id?: unknown } | null }>("/api/auth/me")
      .then((body) => (typeof body?.user?.id === "string" ? body.user.id : ""));
    // A failed ask is asked again next time rather than remembered.
    account.catch(() => accounts.delete(client));
    accounts.set(client, account);
  }
  return account;
}

// On the page, laid out, and at least partly inside the window, in a page
// the player can see.
function cardInView(offerId: string): boolean {
  if (document.visibilityState !== "visible") return false;
  const card = document.querySelector(offerCardSelector(offerId));
  if (!card) return false;
  const box = card.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return false;
  return box.bottom > 0 && box.right > 0 && box.top < window.innerHeight && box.left < window.innerWidth;
}

const watch = createOfferWatch({
  cardInView,
  show(notice, inView) {
    void window.odm?.offerNotice?.(notice, inView).catch(() => false);
  },
  clear(offerId) {
    void window.odm?.clearOfferNotice?.(offerId).catch(() => undefined);
  },
  later: (callback, ms) => void setTimeout(callback, ms),
});

export function watchStreamEvent(client: HostClient, streamUrl: string, event: SseEvent): void {
  if (!window.odm?.offerNotice) return;
  const hostId = (window as { odmMountedHostId?: string }).odmMountedHostId ?? "";
  if (!hostId) return;
  void watch
    .onStreamEvent({ streamUrl, eventType: event.event, data: event.data, hostId, userId: () => accountOf(client) })
    .catch(() => undefined);
}
