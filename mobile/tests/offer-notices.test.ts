import assert from "node:assert/strict";
import { test } from "node:test";
import { createAndroidOfferNotices, type LocalNotificationsPort } from "../src/offer-notices";
import { OFFER_CHANNEL, offerNotificationNumber } from "../../src/shared/offer-notice";

// The phone's offer notification (offer-notices.ts) with the local
// notifications plugin stood in for.

const NOTICE = {
  hostId: "server-1",
  campaignId: "camp-1",
  offerId: "offer-1",
  title: "Mira Vell asks to court Kael Ashvale",
  body: "Only you can answer this. Open the table to choose.",
};

function rig({ display = "granted", foreground = false } = {}) {
  const scheduled: unknown[] = [];
  const channels: unknown[] = [];
  const cancelled: unknown[] = [];
  const notifications: LocalNotificationsPort = {
    checkPermissions: async () => ({ display }),
    createChannel: async (channel) => void channels.push(channel),
    schedule: async (options) => void scheduled.push(...options.notifications),
    cancel: async (options) => void cancelled.push(...options.notifications),
  };
  const state = { foreground };
  const offers = createAndroidOfferNotices({ notifications, foreground: () => state.foreground });
  return { offers, scheduled, channels, cancelled, state };
}

test("a backgrounded phone posts the offer once, on its own private channel", async () => {
  const { offers, scheduled, channels } = rig();
  assert.equal(await offers.show(NOTICE, true), true);
  assert.deepEqual(scheduled, [
    {
      id: offerNotificationNumber("offer-1"),
      title: NOTICE.title,
      body: NOTICE.body,
      channelId: OFFER_CHANNEL,
      smallIcon: "ic_stat_world",
      autoCancel: true,
      extra: { odmOffer: { hostId: "server-1", campaignId: "camp-1", offerId: "offer-1" } },
    },
  ]);
  assert.deepEqual(channels, [
    { id: OFFER_CHANNEL, name: "Offers for you", description: "An offer at the table that only you can answer", importance: 4, visibility: 0 },
  ]);
  assert.equal(await offers.show(NOTICE, false), false, "the same offer again");
  assert.equal(scheduled.length, 1);
});

test("in front with the card in view, nothing is posted; elsewhere in the app it is", async () => {
  const looking = rig({ foreground: true });
  assert.equal(await looking.offers.show(NOTICE, true), false);
  assert.equal(looking.scheduled.length, 0);
  const elsewhere = rig({ foreground: true });
  assert.equal(await elsewhere.offers.show(NOTICE, false), true);
});

test("without the system's permission nothing is posted or asked", async () => {
  for (const display of ["denied", "prompt", "prompt-with-rationale"]) {
    const { offers, scheduled, channels } = rig({ display });
    assert.equal(await offers.show(NOTICE, false), false, display);
    assert.equal(scheduled.length + channels.length, 0);
  }
});

test("a settled offer's notification is cancelled by the same number", async () => {
  const { offers, cancelled } = rig();
  await offers.show(NOTICE, false);
  await offers.clear("offer-1");
  await offers.clear(7);
  assert.deepEqual(cancelled, [{ id: offerNotificationNumber("offer-1") }]);
});

test("a tap reads the table and the card back; other notifications are not offers", () => {
  const { offers } = rig();
  const action = { actionId: "tap", notification: { id: 1, extra: { odmOffer: { hostId: "local", campaignId: "camp-1", offerId: "offer-1" } } } };
  assert.deepEqual(offers.tapped(action), { hostId: "local", campaignId: "camp-1", offerId: "offer-1" });
  assert.equal(offers.tapped({ actionId: "tap", notification: { id: 4201 } }), null);
  assert.equal(offers.tapped(null), null);
});

test("a notice that is not one is refused", async () => {
  const { offers, scheduled } = rig();
  assert.equal(await offers.show({ ...NOTICE, hostId: "" }, false), false);
  assert.equal(await offers.show("offer-1", false), false);
  assert.equal(scheduled.length, 0);
});
