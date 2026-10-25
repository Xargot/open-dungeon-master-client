// The phone's half of an offer's system notification
// (src/shared/offer-notice.ts): the game screens hand over a notice, and it
// is posted through @capacitor/local-notifications unless the app is in
// front with the card in view. A tap sends the shell the open-offer event.
// The plugin is injected, so the rule is tested without a device.
import {
  androidOfferNotification,
  needsOfferNotice,
  OFFER_CHANNEL,
  offerNotificationNumber,
  offerTargetFromExtra,
  sanitizeOfferNotice,
  type OfferTarget,
} from "../../src/shared/offer-notice";

export interface LocalNotificationsPort {
  checkPermissions(): Promise<{ display: string }>;
  createChannel(channel: {
    id: string;
    name: string;
    description?: string;
    importance?: 1 | 2 | 3 | 4 | 5;
    visibility?: -1 | 0 | 1;
  }): Promise<void>;
  schedule(options: { notifications: Array<ReturnType<typeof androidOfferNotification>> }): Promise<unknown>;
  cancel(options: { notifications: Array<{ id: number }> }): Promise<void>;
}

export interface AndroidOfferDeps {
  notifications: LocalNotificationsPort;
  // The app is in front and its page visible.
  foreground(): boolean;
}

export function createAndroidOfferNotices(deps: AndroidOfferDeps) {
  const { notifications } = deps;
  const decided = new Set<string>();
  let channel: Promise<void> | null = null;
  return {
    async show(raw: unknown, cardInView: unknown): Promise<boolean> {
      const notice = sanitizeOfferNotice(raw);
      if (!notice || decided.has(notice.offerId)) return false;
      decided.add(notice.offerId);
      if (!needsOfferNotice({ appForeground: deps.foreground(), cardInView: cardInView === true })) return false;
      try {
        // The player's answer to the system's question stands: nothing is
        // posted, and nothing asked, without a grant.
        if ((await notifications.checkPermissions()).display !== "granted") return false;
        // A channel of their own, so these can be muted alone; private on a
        // locked screen.
        channel ??= notifications
          .createChannel({
            id: OFFER_CHANNEL,
            name: "Offers for you",
            description: "An offer at the table that only you can answer",
            importance: 4,
            visibility: 0,
          })
          .catch(() => undefined);
        await channel;
        await notifications.schedule({ notifications: [androidOfferNotification(notice)] });
        return true;
      } catch {
        return false;
      }
    },
    async clear(offerId: unknown): Promise<void> {
      if (typeof offerId !== "string" || !offerId) return;
      await notifications.cancel({ notifications: [{ id: offerNotificationNumber(offerId) }] }).catch(() => undefined);
    },
    // The tapped notification's target, or null for any other notification.
    tapped(action: unknown): OfferTarget | null {
      return offerTargetFromExtra((action as { notification?: { extra?: unknown } } | null)?.notification?.extra);
    },
  };
}
