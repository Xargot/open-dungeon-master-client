// A system notification for an offer only one player may answer (server
// issue 501's NPC advances, issue 503's pact approaches): the offer arrives
// at the table on the campaign's event stream as item_proposal_added, the
// game screens hand it to the shell, and the shell shows one notification
// when the app is not in front or the card is not in view. A tap opens the
// table at the card (the open-offer shell event). Pure, so both shells and
// the game screens share one rule (docs/bridge-contract.md).
//
// What the apps key on, all from the server's public offer
// (src/lib/dm/proposal-intercept.ts publicItemProposal there):
// - proposal.ownerOnly === true, or a toolName in OWNER_ONLY_TOOLS (the 501
//   advance predates the flag): only the owning player may answer it;
// - proposal.userId: that player's account, compared with the signed-in one;
// - proposal.summary: the one line the card leads with, used as the title;
// - proposal.id: one notification per offer, cleared by the matching
//   item_proposal_resolved.

export const OWNER_ONLY_TOOLS: readonly string[] = ["romance_advance"];

// How long the game screens wait after the event before asking whether the
// card is in view: the page renders it on its next tick and fades it in.
export const OFFER_RENDER_MS = 600;

// The Android channel these notifications post on, so a player can mute
// them alone in the system settings.
export const OFFER_CHANNEL = "table-offers";

const TITLE_MAX = 120;
const ID_SHAPE = /^[A-Za-z0-9_-]{1,80}$/;
const HOST_SHAPE = /^[A-Za-z0-9_.:-]{1,80}$/;
const STREAM_PATH = /^\/api\/campaigns\/([A-Za-z0-9_-]{1,80})\/events(?:[?#]|$)/;

export const OFFER_BODY = "Only you can answer this. Open the table to choose.";
const FALLBACK_TITLE = "An offer waits for you at the table";

// Where a tap lands: the host, the campaign and the offer's card.
export interface OfferTarget {
  hostId: string;
  campaignId: string;
  offerId: string;
}

// What the game screens hand the shell (window.odm.offerNotice).
export interface OfferNotice extends OfferTarget {
  title: string;
  body: string;
}

// The fields of a stream offer the rule reads.
export interface StreamOffer {
  id: string;
  userId: string;
  toolName: string;
  summary: string;
  status: string;
  ownerOnly: boolean;
}

export interface OfferStreamEvent {
  kind: "added" | "resolved";
  proposal: StreamOffer;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// The campaign a stream belongs to, from the address the page opened it at
// ("/api/campaigns/<id>/events?lastSeq=12"); "" for any other stream.
export function streamCampaignId(url: string): string {
  return STREAM_PATH.exec(url)?.[1] ?? "";
}

// An offer added or settled, from one stream event; null for anything else.
export function offerStreamEvent(eventType: string, data: unknown): OfferStreamEvent | null {
  const kind = eventType === "item_proposal_added" ? "added" : eventType === "item_proposal_resolved" ? "resolved" : null;
  if (!kind) return null;
  let payload = data;
  if (typeof data === "string") {
    try {
      payload = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const raw = (payload as { proposal?: unknown } | null)?.proposal;
  if (!raw || typeof raw !== "object") return null;
  const proposal = raw as Record<string, unknown>;
  const id = text(proposal.id);
  if (!ID_SHAPE.test(id)) return null;
  return {
    kind,
    proposal: {
      id,
      userId: text(proposal.userId),
      toolName: text(proposal.toolName),
      summary: text(proposal.summary),
      status: text(proposal.status),
      ownerOnly: proposal.ownerOnly === true,
    },
  };
}

export function isOwnerOnly(proposal: Pick<StreamOffer, "ownerOnly" | "toolName">): boolean {
  return proposal.ownerOnly || OWNER_ONLY_TOOLS.includes(proposal.toolName);
}

// The card's line as a notification title: one line, bounded.
export function offerTitle(summary: string): string {
  const line = summary.replace(/\s+/g, " ").trim();
  if (!line) return FALLBACK_TITLE;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 3).trimEnd()}...` : line;
}

// The notice for this player, or null: an offer someone else answers, one
// the lead merely watches, an ordinary offer, or one already settled.
export function offerNoticeFor(
  proposal: StreamOffer,
  viewer: { userId: string; hostId: string; campaignId: string },
): OfferNotice | null {
  if (!isOwnerOnly(proposal)) return null;
  if (proposal.status && proposal.status !== "pending") return null;
  if (!viewer.userId || proposal.userId !== viewer.userId) return null;
  if (!HOST_SHAPE.test(viewer.hostId) || !ID_SHAPE.test(viewer.campaignId)) return null;
  return {
    hostId: viewer.hostId,
    campaignId: viewer.campaignId,
    offerId: proposal.id,
    title: offerTitle(proposal.summary),
    body: OFFER_BODY,
  };
}

// The whole decision a shell makes: stay quiet only when the player is
// looking at the card already.
export function needsOfferNotice(view: { appForeground: boolean; cardInView: boolean }): boolean {
  return !(view.appForeground && view.cardInView);
}

// Where a tap lands, read back from anything (a notification's extra data,
// an IPC argument): null unless every part has its shape.
export function offerTarget(raw: unknown): OfferTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const hostId = text(value.hostId);
  const campaignId = text(value.campaignId);
  const offerId = text(value.offerId);
  if (!HOST_SHAPE.test(hostId) || !ID_SHAPE.test(campaignId) || !ID_SHAPE.test(offerId)) return null;
  return { hostId, campaignId, offerId };
}

// The game screens are untrusted input to the desktop's main process and
// the phone's bridge: a notice is rebuilt from its parts, never passed on.
export function sanitizeOfferNotice(raw: unknown): OfferNotice | null {
  const target = offerTarget(raw);
  if (!target) return null;
  const value = raw as Record<string, unknown>;
  const body = text(value.body).replace(/\s+/g, " ").trim().slice(0, TITLE_MAX * 2);
  return { ...target, title: offerTitle(text(value.title)), body: body || OFFER_BODY };
}

// The table page a tap opens.
export function campaignPath(campaignId: string): string {
  return `/campaigns/${encodeURIComponent(campaignId)}`;
}

// The offer's card on the table page: the 501 advance card, or any card
// that marks itself with data-offer-card. Ids are checked to the plain
// shape, so they need no escaping inside the selector.
export function offerCardSelector(offerId: string): string {
  if (!ID_SHAPE.test(offerId)) return "[data-offer-card=\"\"]";
  return `[data-offer-card="${offerId}"], [data-advance-card="${offerId}"]`;
}

// Android wants a 32-bit number per notification: the offer id hashed
// (FNV-1a) into a range clear of the app's own (the hosting notification
// is 4201), so the same offer always maps to the same notification.
export function offerNotificationNumber(offerId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < offerId.length; index += 1) {
    hash ^= offerId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 100_000 + (hash % 2_000_000_000);
}

// The notification the phone schedules (@capacitor/local-notifications).
export function androidOfferNotification(notice: OfferNotice) {
  return {
    id: offerNotificationNumber(notice.offerId),
    title: notice.title,
    body: notice.body,
    channelId: OFFER_CHANNEL,
    smallIcon: "ic_stat_world",
    autoCancel: true,
    extra: { odmOffer: { hostId: notice.hostId, campaignId: notice.campaignId, offerId: notice.offerId } },
  };
}

// The tapped notification's target, from its extra data.
export function offerTargetFromExtra(extra: unknown): OfferTarget | null {
  return offerTarget((extra as { odmOffer?: unknown } | null)?.odmOffer);
}

export interface OfferWatchDeps {
  // Whether the card is on the page and inside the window right now.
  cardInView(offerId: string): boolean;
  // Hands the notice to the shell, which shows it unless the app is in
  // front and the card in view.
  show(notice: OfferNotice, cardInView: boolean): void;
  // Takes a shown notice away: its offer was settled.
  clear(offerId: string): void;
  later(callback: () => void, ms: number): void;
}

export interface OfferStreamInput {
  streamUrl: string;
  eventType: string;
  data: unknown;
  hostId: string;
  // The signed-in account on that host, asked only when an owner-only offer
  // arrives.
  userId(): Promise<string>;
}

// The game screens' side: every event of every stream goes past this. An
// offer is decided once (a reconnect replays events), and one settled before
// its card was looked for is never announced.
export function createOfferWatch(deps: OfferWatchDeps) {
  const decided = new Set<string>();
  const settled = new Set<string>();
  const announced = new Set<string>();
  return {
    async onStreamEvent(input: OfferStreamInput): Promise<void> {
      const campaignId = streamCampaignId(input.streamUrl);
      if (!campaignId) return;
      const event = offerStreamEvent(input.eventType, input.data);
      if (!event) return;
      const id = event.proposal.id;
      if (event.kind === "resolved") {
        settled.add(id);
        if (announced.delete(id)) deps.clear(id);
        return;
      }
      if (decided.has(id) || settled.has(id) || !isOwnerOnly(event.proposal)) return;
      decided.add(id);
      const userId = await input.userId().catch(() => "");
      const notice = offerNoticeFor(event.proposal, { userId, hostId: input.hostId, campaignId });
      if (!notice) return;
      deps.later(() => {
        if (settled.has(id)) return;
        announced.add(id);
        deps.show(notice, deps.cardInView(id));
      }, OFFER_RENDER_MS);
    },
  };
}
