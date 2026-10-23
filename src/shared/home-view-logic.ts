// Pure decisions behind the home screen: which campaign the hero continues,
// which host the quick tiles act on, how campaigns group under their hosts
// and what each row says. No DOM here so the rules can be tested on their
// own and read as one list.
import type { HomeCampaign, HomeFeed, HomeHost, LocalStatus } from "./types";

export interface ContinuePick {
  host: HomeHost;
  campaign: HomeCampaign;
}

// What tapping a campaign row does. "start" is the device world asleep: the
// tap wakes it, then opens the campaign. "signIn" is a host whose session
// lapsed. "blocked" cannot be continued from here right now.
export type RowAction = "open" | "start" | "signIn" | "blocked";

export interface CampaignRow {
  campaign: HomeCampaign;
  line: string;
  action: RowAction;
  // The one-line reason a blocked row shows in place of its status.
  reason: string;
}

export interface HostGroup {
  host: HomeHost;
  label: string;
  statusLabel: string;
  // "last seen 3h ago" for hosts that are not online, "" otherwise.
  lastSeen: string;
  rows: CampaignRow[];
}

const STATUS_RANK: Record<HomeCampaign["status"], number> = { active: 0, lobby: 1, ended: 2 };

function reachable(host: HomeHost): boolean {
  return host.status === "online" || host.status === "starting";
}

function byFreshness(a: HomeCampaign, b: HomeCampaign): number {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rank !== 0) return rank;
  return (b.updatedAt || "").localeCompare(a.updatedAt || "");
}

// The device world's process state is the truth about the local host; a
// cached feed may still remember it online from last time.
export function reconcileLocal(feed: HomeFeed, local: LocalStatus): HomeFeed {
  const status: HomeHost["status"] =
    local.state === "running"
      ? "online"
      : local.state === "starting"
        ? "starting"
        : local.state === "unavailable"
          ? "unavailable"
          : "offline";
  return {
    ...feed,
    hosts: feed.hosts.map((host) =>
      host.kind === "local" ? { ...host, status, username: local.username || host.username } : host,
    ),
  };
}

// The most recently updated campaign still in play on a host that can be
// reached, with active tables ahead of lobbies still gathering.
//
// localWakes: the device world is asleep but wakes when one of its tables is
// opened, so its cached campaigns count as reachable (a world that failed to
// start, or has no owner yet, does not wake on its own).
export function pickContinueCampaign(feed: HomeFeed, localWakes = false): ContinuePick | null {
  let best: ContinuePick | null = null;
  for (const host of feed.hosts) {
    const wakes = localWakes && host.kind === "local" && host.status === "offline";
    if (!reachable(host) && !wakes) continue;
    for (const campaign of host.campaigns) {
      if (campaign.status === "ended") continue;
      if (!best || byFreshness(campaign, best.campaign) < 0) best = { host, campaign };
    }
  }
  return best;
}

// Where "New campaign", "Characters" and "Workshop" go: the hero's host,
// else the device world when this build has one, else the first online
// server (the feed lists hosts most recently used first).
export function pickPrimaryHost(feed: HomeFeed, hero: ContinuePick | null, preferredId = ""): HomeHost | null {
  // The player said where new tables go ("Opens on ... Change"): kept while
  // that host can still be reached.
  const preferred = preferredId ? creationHosts(feed).find((host) => host.id === preferredId) : undefined;
  if (preferred) return preferred;
  if (hero) return hero.host;
  const local = feed.hosts.find((host) => host.kind === "local");
  if (local && local.status !== "unavailable") return local;
  return feed.hosts.find((host) => host.kind !== "local" && host.status === "online") ?? null;
}

// The hosts New campaign, Characters and Workshop can open on: the device
// world while this build has one, and every remote host that answers. The
// home names the one in use and offers the next.
export function creationHosts(feed: HomeFeed): HomeHost[] {
  return feed.hosts.filter((host) =>
    host.kind === "local" ? host.status !== "unavailable" : host.status === "online",
  );
}

export function nextCreationHost(feed: HomeFeed, current: HomeHost | null): HomeHost | null {
  const hosts = creationHosts(feed);
  if (hosts.length < 2) return null;
  const at = current ? hosts.findIndex((host) => host.id === current.id) : -1;
  return hosts[(at + 1) % hosts.length] ?? null;
}

export function campaignLine(campaign: HomeCampaign): string {
  if (campaign.status === "ended") return "Ended";
  const party = campaign.maxPlayers
    ? `${campaign.playerCount}/${campaign.maxPlayers}`
    : `${campaign.playerCount}`;
  const parts = [campaign.status === "active" ? "Active" : "Lobby", party];
  if (campaign.playingAs) parts.push(`playing as ${campaign.playingAs}`);
  return parts.join(" · ");
}

// The hero's one line under the title: who the player is there and how
// full the table is.
export function heroLine(campaign: HomeCampaign): string {
  const party = campaign.maxPlayers
    ? `${campaign.playerCount}/${campaign.maxPlayers}`
    : `${campaign.playerCount}`;
  if (campaign.playingAs) return `Playing as ${campaign.playingAs} · ${party} party`;
  return `${campaign.status === "active" ? "Active" : "Lobby"} · ${party}`;
}

export function hostLabel(host: HomeHost, deviceName: string): string {
  if (host.kind === "local") return deviceName;
  if (host.name) return host.name;
  try {
    return new URL(host.origin).host;
  } catch {
    return host.origin;
  }
}

export function hostStatusLabel(host: HomeHost): string {
  switch (host.status) {
    case "online":
      return "online";
    case "starting":
      return "starting";
    case "needsLogin":
      return "sign in";
    case "unavailable":
      return "unavailable";
    default:
      return "offline";
  }
}

export function blockedReason(host: HomeHost): string {
  return host.kind === "tunnel" ? "Hosted on another player's app" : "Server unreachable";
}

export function rowAction(host: HomeHost): RowAction {
  if (reachable(host)) return "open";
  if (host.kind === "local") return host.status === "unavailable" ? "blocked" : "start";
  if (host.status === "needsLogin") return "signIn";
  return "blocked";
}

// Whether a save slot's actions have somewhere to go: a host that answers
// with a fresh list, so the slot is not a memory of a table already gone,
// or the device world asleep (localWakes, as for the continue pick): its
// list is its own, kept while it sleeps, and the action wakes it first.
function slotLive(host: HomeHost, localWakes: boolean): boolean {
  if (localWakes && host.kind === "local" && host.status === "offline") return true;
  return rowAction(host) === "open" && !host.stale;
}

// Whether a save slot offers Delete: the owner's alone, as on the website.
export function canDeleteFromHome(host: HomeHost, campaign: HomeCampaign, localWakes = false): boolean {
  return campaign.role === "owner" && slotLive(host, localWakes);
}

// Whether a save slot offers Duplicate, as the website's slot does. The
// server lets whoever steers the story copy it (the seated DM, or the party
// lead); the feed does not carry the lead, so the slot asks the owner and
// the DM seat, and the server's answer stands. The copy is a new campaign,
// so only on a host where this account may start one.
export function canDuplicateFromHome(host: HomeHost, campaign: HomeCampaign, localWakes = false): boolean {
  return host.canCreate && (campaign.role === "owner" || campaign.dmSeat === true) && slotLive(host, localWakes);
}

// "3h ago" style, coarse on purpose: the point is whether it was today.
export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

export interface GroupOptions {
  hideOffline: boolean;
  deviceName: string;
  now: number;
}

// One group per host, in feed order. The device world always shows (a tap
// wakes it), a build without one never does, and "hide offline" drops the
// servers and tunnels that cannot be reached right now.
export function buildGroups(feed: HomeFeed, options: GroupOptions): HostGroup[] {
  const groups: HostGroup[] = [];
  for (const host of feed.hosts) {
    if (host.status === "unavailable") continue;
    if (options.hideOffline && host.kind !== "local" && host.status === "offline") continue;
    const action = rowAction(host);
    const reason = action === "blocked" ? blockedReason(host) : "";
    const rows = [...host.campaigns].sort(byFreshness).map((campaign) => ({
      campaign,
      line: campaignLine(campaign),
      action,
      reason,
    }));
    const seen = host.status === "online" ? "" : relativeTime(host.lastSeenAt, options.now);
    groups.push({
      host,
      label: hostLabel(host, options.deviceName),
      statusLabel: hostStatusLabel(host),
      lastSeen: seen ? `last seen ${seen}` : "",
      rows,
    });
  }
  return groups;
}

// ---------- the title screen's words ----------
//
// Ports of the server's src/app/home/types.ts, so the app's title screen
// says exactly what the website's says about the same table.

// "2 days ago" for the recap and the save slots. Coarse on purpose: a
// title screen is not a log.
export function agoLabel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return weeks === 1 ? "a week ago" : `${weeks} weeks ago`;
  const months = Math.round(days / 30);
  if (months < 12) return months <= 1 ? "a month ago" : `${months} months ago`;
  const years = Math.round(days / 365);
  return years <= 1 ? "a year ago" : `${years} years ago`;
}

// Roman numerals for chapter headings ("Chapter III").
export function romanNumeral(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 3999) return String(value);
  const table: Array<[number, string]> = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
    [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let rest = value;
  let out = "";
  for (const [num, glyph] of table) {
    while (rest >= num) {
      out += glyph;
      rest -= num;
    }
  }
  return out;
}

// The eyebrow over the table's name.
export function titleEyebrow(campaign: HomeCampaign): string {
  if (campaign.status === "ended") return "A finished tale";
  if (campaign.status === "lobby") return "The table is set";
  return "Continue your tale";
}

// The door in.
export function enterLabel(campaign: HomeCampaign): string {
  if (campaign.status === "ended") return "Revisit the world";
  if (campaign.status === "lobby") return "Take your seat";
  return "Enter the world";
}

// The chapter line: "Act II, Chapter III · The Drowned Lantern" (or just
// the chapter on a host without acts), the act's name when the chapter has
// none yet, the scene after that, or the campaign's own description. ""
// when the host had none of those to give.
export function chapterLine(campaign: HomeCampaign): string {
  const chapter = campaign.glance?.chapter;
  const scene = campaign.scene?.trim() || "";
  if (chapter) {
    const act = chapter.act ? `Act ${romanNumeral(chapter.act)}, ` : "";
    const head = `${act}Chapter ${romanNumeral(chapter.index)}`;
    const title = chapter.title.trim();
    if (title) return `${head} · ${title}`;
    const actTitle = chapter.actTitle?.trim() || "";
    if (actTitle) return `${head} · ${actTitle}`;
    if (scene) return `${head} · ${scene}`;
    return head;
  }
  if (scene) return scene;
  return campaign.description?.trim() || "";
}

// One line under a table's name: who you are there and how full it is.
export function seatLine(campaign: HomeCampaign): string {
  const seats = `${campaign.playerCount} of ${campaign.maxPlayers} seats`;
  if (campaign.status === "lobby") {
    return `Lobby · ${campaign.playerCount} of ${campaign.maxPlayers} ready`;
  }
  const party = campaign.maxPlayers === 1 ? "solo" : seats;
  if (campaign.playingAs) return `Playing as ${campaign.playingAs} · ${party}`;
  if (campaign.dmSeat) return `Running the table · ${party}`;
  return `No character yet · ${party}`;
}

// The save slot's one line: what state the table is in, in a few words.
export function slotLine(campaign: HomeCampaign, now = Date.now()): string {
  if (campaign.status === "lobby") return `${campaign.playerCount} of ${campaign.maxPlayers} ready`;
  if (campaign.status === "ended") {
    const ago = agoLabel(campaign.updatedAt, now);
    return ago ? `Finished ${ago}` : "Finished";
  }
  if (campaign.dmSeat) return "Running the table";
  const ago = agoLabel(campaign.glance?.recapAt ?? campaign.updatedAt, now);
  return ago ? `Last played ${ago}` : "In play";
}

// The slot's small print: "Level 3 start · hard · solo", or "" when the
// host did not say.
export function slotMeta(campaign: HomeCampaign): string {
  const bits: string[] = [];
  if (campaign.startingLevel) bits.push(`Level ${campaign.startingLevel} start`);
  if (campaign.difficulty) bits.push(campaign.difficulty);
  if (campaign.maxPlayers === 1) bits.push("solo");
  return bits.join(" · ");
}

// "When last we left": the recap, or the quiet line the server shows in
// its place.
export function recapText(campaign: HomeCampaign): { text: string; quiet: boolean } {
  const recap = campaign.glance?.recap?.trim() || "";
  if (recap) return { text: recap, quiet: false };
  if (campaign.status === "lobby") {
    return { text: "The table is set and the seats are filling. The tale begins when the party is gathered.", quiet: true };
  }
  if (campaign.status === "ended") {
    return { text: "This tale has been told to its end. The chronicle keeps every page.", quiet: true };
  }
  return { text: "The Dungeon Master has not spoken yet. Step in and the first scene is yours.", quiet: true };
}

// The status line at the foot of the menu, the way a title screen shows
// its build: the device world's state with a lamp for it, then the app's
// version. "off" is an unlit lamp, "wait" a pulsing one, "awake" gold and
// "dozing" ember.
export type StatusTone = "off" | "wait" | "awake" | "dozing";

export function deviceStatusLine(
  local: LocalStatus,
  appVersion: string,
): { tone: StatusTone; text: string } {
  let tone: StatusTone = "off";
  let words: string;
  switch (local.state) {
    case "running":
      tone = "awake";
      words = local.serverVersion ? `Your world is awake · server ${local.serverVersion}` : "Your world is awake";
      break;
    case "starting":
      tone = "wait";
      words = "Waking your world";
      break;
    case "error":
      tone = "dozing";
      words = "Your world could not start";
      break;
    case "unavailable":
      words = "No world on this device · play on a server";
      break;
    default:
      words = local.firstRun ? "Your world has not begun" : "Your world is asleep";
  }
  const bits = [words];
  if (appVersion) bits.push(`v${appVersion}`);
  return { tone, text: bits.join(" · ") };
}
