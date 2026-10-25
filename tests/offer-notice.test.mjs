import assert from "node:assert/strict";
import test from "node:test";
import {
  OFFER_BODY,
  OFFER_CHANNEL,
  OFFER_RENDER_MS,
  androidOfferNotification,
  campaignPath,
  createOfferWatch,
  isOwnerOnly,
  needsOfferNotice,
  offerCardSelector,
  offerNoticeFor,
  offerNotificationNumber,
  offerStreamEvent,
  offerTargetFromExtra,
  offerTitle,
  sanitizeOfferNotice,
  streamCampaignId,
} from "../dist/shared/offer-notice.js";

// An offer only one player may answer becomes a system notification for
// that player alone (server issues 501 and 503).

const ME = "user-kael";
const LEAD = "user-lead";
const STREAM = "/api/campaigns/camp-1/events?lastSeq=41";

// The server's public offer, as item_proposal_added carries it.
function advance(overrides = {}) {
  return {
    id: "offer-1",
    characterId: "sheet-kael",
    userId: ME,
    toolName: "romance_advance",
    summary: "Mira Vell asks to court Kael Ashvale",
    reason: "Walk with me tonight.",
    status: "pending",
    createdAt: "2026-10-23T12:00:00.000Z",
    advance: { suitor: "Mira Vell", portraitUrl: "", look: { gender: "female", race: "", class: "", role: "bard" } },
    ...overrides,
  };
}

const added = (proposal) => JSON.stringify({ proposal });

test("the campaign stream is told apart from every other stream", () => {
  assert.equal(streamCampaignId(STREAM), "camp-1");
  assert.equal(streamCampaignId("/api/campaigns/camp-1/events"), "camp-1");
  assert.equal(streamCampaignId("/api/notifications/stream"), "");
  assert.equal(streamCampaignId("/api/campaigns/camp-1/eventsx"), "");
  assert.equal(streamCampaignId("/api/campaigns/../x/events"), "");
});

test("offers are read from added and resolved events, anything else is ignored", () => {
  const event = offerStreamEvent("item_proposal_added", added(advance()));
  assert.deepEqual(event, {
    kind: "added",
    proposal: { id: "offer-1", userId: ME, toolName: "romance_advance", summary: "Mira Vell asks to court Kael Ashvale", status: "pending", ownerOnly: false },
  });
  assert.equal(offerStreamEvent("item_proposal_resolved", { proposal: advance({ status: "declined" }) })?.kind, "resolved");
  assert.equal(offerStreamEvent("message_added", added(advance())), null);
  assert.equal(offerStreamEvent("item_proposal_added", "{not json"), null);
  assert.equal(offerStreamEvent("item_proposal_added", added({ ...advance(), id: "bad id!" })), null);
  assert.equal(offerStreamEvent("item_proposal_added", JSON.stringify({})), null);
});

test("owner-only is the 501 advance by its tool, and any offer the server flags", () => {
  assert.equal(isOwnerOnly({ toolName: "romance_advance", ownerOnly: false }), true);
  // The 503 pact approach rides the same event family with the flag.
  assert.equal(isOwnerOnly({ toolName: "pact_approach", ownerOnly: true }), true);
  // An ordinary DM offer is the lead's to answer too: no notification.
  assert.equal(isOwnerOnly({ toolName: "give_item", ownerOnly: false }), false);
  assert.equal(isOwnerOnly({ toolName: "trade", ownerOnly: false }), false);
});

test("only the owning player gets a notice, never the lead or another player", () => {
  const viewer = { userId: ME, hostId: "server-1", campaignId: "camp-1" };
  const read = (proposal) => offerStreamEvent("item_proposal_added", added(proposal)).proposal;
  assert.deepEqual(offerNoticeFor(read(advance()), viewer), {
    hostId: "server-1",
    campaignId: "camp-1",
    offerId: "offer-1",
    title: "Mira Vell asks to court Kael Ashvale",
    body: OFFER_BODY,
  });
  assert.equal(offerNoticeFor(read(advance()), { ...viewer, userId: LEAD }), null, "the lead watching");
  assert.equal(offerNoticeFor(read(advance({ userId: "user-other" })), viewer), null, "another player's offer");
  assert.equal(offerNoticeFor(read(advance()), { ...viewer, userId: "" }), null, "no account known");
  assert.equal(offerNoticeFor(read(advance({ status: "approved" })), viewer), null, "already settled");
  assert.equal(offerNoticeFor(read(advance({ toolName: "give_item" })), viewer), null, "an ordinary offer");
  assert.ok(offerNoticeFor(read(advance({ toolName: "pact_approach", ownerOnly: true })), viewer), "a flagged pact");
  // The body never carries the suitor's words or anything else of the card.
  assert.ok(!offerNoticeFor(read(advance()), viewer).body.includes("Walk with me"));
});

test("the title is the card's one line, bounded", () => {
  assert.equal(offerTitle("  Mira Vell\nasks to court   Kael  "), "Mira Vell asks to court Kael");
  assert.equal(offerTitle(""), "An offer waits for you at the table");
  const long = offerTitle("x".repeat(300));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("..."));
});

test("a shell stays quiet only when the app is in front and the card is in view", () => {
  assert.equal(needsOfferNotice({ appForeground: true, cardInView: true }), false);
  assert.equal(needsOfferNotice({ appForeground: true, cardInView: false }), true, "another tab or page of the app");
  assert.equal(needsOfferNotice({ appForeground: false, cardInView: true }), true, "backgrounded on the table");
  assert.equal(needsOfferNotice({ appForeground: false, cardInView: false }), true);
});

function harness({ userId = ME, inView = false } = {}) {
  const shown = [];
  const cleared = [];
  const timers = [];
  let asked = 0;
  const watch = createOfferWatch({
    cardInView: () => inView,
    show: (notice, cardInView) => shown.push({ notice, cardInView }),
    clear: (id) => cleared.push(id),
    later: (callback, ms) => timers.push({ callback, ms }),
  });
  const feed = (eventType, data, streamUrl = STREAM) =>
    watch.onStreamEvent({
      streamUrl,
      eventType,
      data,
      hostId: "server-1",
      userId: async () => {
        asked += 1;
        return userId;
      },
    });
  const flush = () => {
    for (const timer of timers.splice(0)) timer.callback();
  };
  return { shown, cleared, timers, feed, flush, asked: () => asked };
}

test("the game screens hand the shell one notice per offer, after the card had time to draw", async () => {
  const rig = harness();
  await rig.feed("item_proposal_added", added(advance()));
  assert.equal(rig.timers.length, 1);
  assert.equal(rig.timers[0].ms, OFFER_RENDER_MS);
  assert.equal(rig.shown.length, 0, "nothing before the card could draw");
  rig.flush();
  assert.deepEqual(rig.shown, [
    {
      notice: { hostId: "server-1", campaignId: "camp-1", offerId: "offer-1", title: "Mira Vell asks to court Kael Ashvale", body: OFFER_BODY },
      cardInView: false,
    },
  ]);
  // A reconnect replays the event: no second notice.
  await rig.feed("item_proposal_added", added(advance()));
  rig.flush();
  assert.equal(rig.shown.length, 1);
  // Settled (answered on another device, withdrawn, lapsed): taken away.
  await rig.feed("item_proposal_resolved", added(advance({ status: "cancelled" })));
  assert.deepEqual(rig.cleared, ["offer-1"]);
});

test("the shell is told when the card is in view, and decides with what it knows of the app", async () => {
  const rig = harness({ inView: true });
  await rig.feed("item_proposal_added", added(advance()));
  rig.flush();
  assert.equal(rig.shown[0].cardInView, true);
});

test("an offer settled before its card was looked for is never announced", async () => {
  const rig = harness();
  await rig.feed("item_proposal_added", added(advance()));
  await rig.feed("item_proposal_resolved", added(advance({ status: "approved" })));
  rig.flush();
  assert.equal(rig.shown.length, 0);
  assert.deepEqual(rig.cleared, [], "nothing was shown, so nothing to take away");
});

test("other players, the lead, ordinary offers and other streams announce nothing", async () => {
  const lead = harness({ userId: LEAD });
  await lead.feed("item_proposal_added", added(advance()));
  lead.flush();
  assert.equal(lead.shown.length, 0);

  const other = harness();
  await other.feed("item_proposal_added", added(advance({ id: "offer-2", userId: "user-other" })));
  other.flush();
  assert.equal(other.shown.length, 0);

  // The 503 server sends the rest of the table only the bare id of an
  // owner-only offer (src/lib/table-delivery.ts there).
  const redacted = harness();
  await redacted.feed("item_proposal_added", added({ id: "pact-9", ownerOnly: true }));
  redacted.flush();
  assert.equal(redacted.shown.length, 0);

  // An ordinary offer never even asks who is signed in.
  const ordinary = harness();
  await ordinary.feed("item_proposal_added", added(advance({ id: "offer-3", toolName: "give_item" })));
  ordinary.flush();
  assert.equal(ordinary.shown.length, 0);
  assert.equal(ordinary.asked(), 0);

  const bell = harness();
  await bell.feed("item_proposal_added", added(advance()), "/api/notifications/stream");
  assert.equal(bell.timers.length, 0);
});

test("a pact approach flagged owner-only notifies with no client change", async () => {
  const rig = harness();
  const pact = advance({ id: "pact-1", toolName: "pact_approach", ownerOnly: true, summary: "The Ashen Court offers Kael a pact", advance: undefined });
  await rig.feed("item_proposal_added", added(pact));
  rig.flush();
  assert.equal(rig.shown.length, 1);
  assert.equal(rig.shown[0].notice.title, "The Ashen Court offers Kael a pact");
  assert.equal(rig.shown[0].notice.offerId, "pact-1");
});

test("a notice crossing into a shell is rebuilt from its parts", () => {
  const clean = sanitizeOfferNotice({
    hostId: "local",
    campaignId: "camp-1",
    offerId: "offer-1",
    title: "Mira Vell asks to court Kael Ashvale",
    body: "Only you can answer this.",
    extra: "dropped",
  });
  assert.deepEqual(clean, {
    hostId: "local",
    campaignId: "camp-1",
    offerId: "offer-1",
    title: "Mira Vell asks to court Kael Ashvale",
    body: "Only you can answer this.",
  });
  assert.equal(sanitizeOfferNotice({ ...clean, campaignId: "../x" }), null);
  assert.equal(sanitizeOfferNotice({ ...clean, offerId: "" }), null);
  assert.equal(sanitizeOfferNotice({ ...clean, hostId: "a b" }), null);
  assert.equal(sanitizeOfferNotice(null), null);
  assert.equal(sanitizeOfferNotice({ ...clean, body: "" }).body, OFFER_BODY);
  assert.equal(sanitizeOfferNotice({ ...clean, title: "y".repeat(500) }).title.length, 120);
});

test("the phone's notification carries its target and comes back from a tap", () => {
  const notice = { hostId: "server-1", campaignId: "camp-1", offerId: "offer-1", title: "Mira Vell asks to court Kael Ashvale", body: OFFER_BODY };
  const posted = androidOfferNotification(notice);
  assert.deepEqual(posted, {
    id: offerNotificationNumber("offer-1"),
    title: notice.title,
    body: OFFER_BODY,
    channelId: OFFER_CHANNEL,
    smallIcon: "ic_stat_world",
    autoCancel: true,
    extra: { odmOffer: { hostId: "server-1", campaignId: "camp-1", offerId: "offer-1" } },
  });
  assert.deepEqual(offerTargetFromExtra(posted.extra), { hostId: "server-1", campaignId: "camp-1", offerId: "offer-1" });
  assert.equal(offerTargetFromExtra({}), null);
  assert.equal(offerTargetFromExtra({ odmOffer: { hostId: "server-1", campaignId: "camp-1" } }), null);
});

test("an offer's notification number is stable, an int, and clear of the hosting notification", () => {
  const ids = ["offer-1", "offer-2", "0b7c9d5e-1a2b-4c3d-8e9f-001122334455", "x"];
  for (const id of ids) {
    const number = offerNotificationNumber(id);
    assert.equal(number, offerNotificationNumber(id));
    assert.ok(Number.isInteger(number) && number >= 100_000 && number < 2 ** 31, `${id}: ${number}`);
  }
  assert.notEqual(offerNotificationNumber("offer-1"), offerNotificationNumber("offer-2"));
});

test("a tap opens the table page and finds the card by its id", () => {
  assert.equal(campaignPath("camp-1"), "/campaigns/camp-1");
  assert.equal(offerCardSelector("offer-1"), '[data-offer-card="offer-1"], [data-advance-card="offer-1"]');
  assert.equal(offerCardSelector('x"] , body'), '[data-offer-card=""]');
});
