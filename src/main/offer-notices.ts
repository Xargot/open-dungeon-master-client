// The desktop's half of an offer's system notification
// (src/shared/offer-notice.ts): the game screens hand over a notice, and the
// main process shows it with Electron's Notification unless the window is
// in front with the card in view. A click brings the window forward and
// tells the shell to open the table at the card. Electron is injected, so
// the rule is tested without it.
import { needsOfferNotice, sanitizeOfferNotice, type OfferTarget } from "../shared/offer-notice";

export interface DesktopNotification {
  on(event: "click", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
  show(): void;
  close(): void;
}

export interface DesktopOfferDeps {
  supported(): boolean;
  create(options: { title: string; body: string; icon?: string }): DesktopNotification;
  // The main window is shown, not minimized, and focused.
  foreground(): boolean;
  // Brings the window forward and sends the shell the open-offer event.
  open(target: OfferTarget): void;
  icon?: string;
}

export function createDesktopOfferNotices(deps: DesktopOfferDeps) {
  // Held until clicked or closed: a notification nothing references can be
  // collected, and its click then goes nowhere.
  const shown = new Map<string, DesktopNotification>();
  // One decision per offer, whichever window or replay asks again.
  const decided = new Set<string>();
  return {
    show(raw: unknown, cardInView: unknown): boolean {
      const notice = sanitizeOfferNotice(raw);
      if (!notice || decided.has(notice.offerId)) return false;
      decided.add(notice.offerId);
      if (!needsOfferNotice({ appForeground: deps.foreground(), cardInView: cardInView === true })) return false;
      if (!deps.supported()) return false;
      const target: OfferTarget = { hostId: notice.hostId, campaignId: notice.campaignId, offerId: notice.offerId };
      const notification = deps.create({ title: notice.title, body: notice.body, ...(deps.icon ? { icon: deps.icon } : {}) });
      notification.on("click", () => {
        shown.delete(notice.offerId);
        deps.open(target);
      });
      notification.on("close", () => shown.delete(notice.offerId));
      shown.set(notice.offerId, notification);
      notification.show();
      return true;
    },
    clear(offerId: unknown): void {
      const key = typeof offerId === "string" ? offerId : "";
      const notification = shown.get(key);
      if (!notification) return;
      shown.delete(key);
      notification.close();
    },
  };
}
