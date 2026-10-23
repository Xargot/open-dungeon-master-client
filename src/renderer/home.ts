// The home is a title screen, the same composition the server's home
// wears ("ODM World Concepts", round 3a, and src/app/home/Dashboard.tsx
// there): the table you were last at fills the screen behind a Continue,
// the menu runs down the left like a game's main menu, the recap and
// your tables sit as raised night panels and save slots on the
// right, and the device world, the sigil boxes and the small print wait
// below the fold. Every host the player uses is on it: the device world,
// the saved servers, friends' apps reached through a tunnel. Decisions
// about what to show come from src/shared/home-view-logic.ts; this file
// only draws them.
import {
  buildGroups,
  canDeleteFromHome,
  canDuplicateFromHome,
  chapterLine,
  deviceStatusLine,
  enterLabel,
  pickContinueCampaign,
  nextCreationHost,
  pickPrimaryHost,
  reconcileLocal,
  recapText,
  seatLine,
  slotLine,
  slotMeta,
  titleEyebrow,
  agoLabel,
} from "../shared/home-view-logic.js";
import type { CampaignRow, ContinuePick, HostGroup } from "../shared/home-view-logic.js";
import type { HomeCampaign, HomeFeed, HomeHost, ServerSummary } from "../shared/types";
import { hostClient } from "./api/host.js";
import { footer, joinBanner, show, topbar } from "./chrome.js";
import { badge, el, icon, iconButton, spinner, statusDot } from "./dom.js";
import type { IconName } from "./dom.js";
import { renderLocalAi } from "./local-ai.js";
import { playLocal, shareRow } from "./local.js";
import { connectServer, openTyped, renderAdd, scanInvite, signInTo } from "./servers.js";
import { submitJoin } from "./submit-join.js";
import { DEVICE, hideOffline, isAndroid, preferredHost, refresh, refreshFeed, setHideOffline, setPreferredHost, state } from "./state.js";
import { STARTING_ROUTES } from "../shared/starting-routes.js";

const EMPTY_FEED: HomeFeed = { hosts: [], refreshedAt: "" };

// The painted plates the host serves publicly (a genre cover before anyone
// paints one, a placeholder face, the empty stage) ship inside the app too
// (scripts/build-renderer.mjs copies the server's public/assets beside the
// game sheet), so they are drawn from disk: no round trip, and they show
// for a host that is offline.
const EMPTY_STAGE = "./game/public/assets/placeholders/misc/empty.webp";

function localPlate(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const pathname = new URL(url).pathname;
    if (pathname.startsWith("/assets/") && !pathname.startsWith("/assets/icons/") && !pathname.startsWith("/assets/ui/")) {
      return `./game/public${pathname}`;
    }
  } catch {
    // Not an address; nothing to map.
  }
  return null;
}

function glyph(key: string): HTMLImageElement {
  const img = el("img", "tt-menu-glyph-img");
  img.src = `./game/icons/glyph/${key}.webp`;
  img.alt = "";
  img.draggable = false;
  return img;
}

function hostIcon(host: HomeHost): IconName {
  if (host.kind === "local") return isAndroid ? "globe" : "monitor";
  return host.kind === "tunnel" ? "link" : "server";
}

// The scheme is noise on a title screen; the host (and port, for LAN
// servers) is what a player recognizes.
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function hostName(host: HomeHost): string {
  if (host.kind === "local") return DEVICE;
  return host.name || hostOf(host.origin);
}

// Every door into a host goes through here: the device world starts if it
// sleeps, a server connects with its remembered session. path is the page
// to land on ("" for the root).
function openHost(host: HomeHost, path: string, btn: HTMLButtonElement | null): void {
  if (host.kind === "local") {
    void playLocal(btn, path);
    return;
  }
  const server = state.servers.find((entry) => entry.id === host.id);
  if (!server) {
    // The feed remembers a host the list no longer has (forgotten while
    // the cache was stale); adding it back is the honest next step.
    renderAdd(host.origin);
    return;
  }
  void connectServer(server, btn ?? el("button"), path);
}

function openCampaign(host: HomeHost, campaignId: string, btn: HTMLButtonElement | null): void {
  openHost(host, `/campaigns/${encodeURIComponent(campaignId)}`, btn);
}

// ---------- pictures ----------

// Covers and painted scenes sit behind each host's login, so the bridge
// fetches them with the host's session and answers with a data URL; the
// page cannot load them by address. Answers are kept for the session so a
// re-render is free, and a miss (host offline, session lapsed) is asked
// again on the next paint. The answers are base64 pictures, so the ring
// is small: the least recently drawn picture goes once more than
// PICTURE_CAP distinct ones have been seen.
const PICTURE_CAP = 64;
const pictures = new Map<string, Promise<string>>();

function loadPicture(hostId: string, url: string): Promise<string> {
  const key = `${hostId} ${url}`;
  let pending = pictures.get(key);
  if (pending) {
    // Re-inserting moves the key to the newest end of the map's order.
    pictures.delete(key);
    pictures.set(key, pending);
    return pending;
  }
  pending = window.odm.coverImage(hostId, url).catch(() => "");
  pictures.set(key, pending);
  void pending.then((data) => {
    if (!data) pictures.delete(key);
  });
  for (const oldest of pictures.keys()) {
    if (pictures.size <= PICTURE_CAP) break;
    pictures.delete(oldest);
  }
  return pending;
}

// Where a campaign's picture comes from, best first: the newest painted
// scene (the title screen's painting only), the cover fetched with the
// host's session, the same cover by address (a phone's shared cookie jar
// may carry the session already), and the genre plate from disk.
interface PictureSource {
  kind: "bridge" | "plain";
  url: string;
}

function pictureSources(campaign: HomeCampaign, scene: boolean): PictureSource[] {
  const out: PictureSource[] = [];
  if (scene && campaign.glance?.sceneImage) out.push({ kind: "bridge", url: campaign.glance.sceneImage });
  if (campaign.coverUrl) out.push({ kind: "bridge", url: campaign.coverUrl }, { kind: "plain", url: campaign.coverUrl });
  const plate = localPlate(campaign.placeholderUrl);
  if (plate) out.push({ kind: "plain", url: plate });
  else if (campaign.placeholderUrl) out.push({ kind: "plain", url: campaign.placeholderUrl });
  return out;
}

// Tries a picture's sources in order and hands the first that loads to
// `paint`; a source that fails to load falls through to the next.
function resolvePicture(hostId: string, sources: PictureSource[], paint: (src: string) => void): void {
  const tryFrom = (index: number): void => {
    const source = sources[index];
    if (!source) return;
    const attempt = (src: string): void => {
      const probe = new Image();
      probe.addEventListener("load", () => paint(src));
      probe.addEventListener("error", () => tryFrom(index + 1));
      probe.src = src;
    };
    if (source.kind === "plain") {
      attempt(source.url);
      return;
    }
    void loadPicture(hostId, source.url).then((data) => {
      if (data) attempt(data);
      else tryFrom(index + 1);
    });
  };
  tryFrom(0);
}

// A slot's art: the plate from disk at once, upgraded to the cover when
// the host answers.
function slotArt(host: HomeHost, campaign: HomeCampaign): HTMLElement {
  const art = el("span", "tt-slot-art");
  const img = el("img");
  img.alt = "";
  img.draggable = false;
  const plate = localPlate(campaign.placeholderUrl);
  if (plate) img.src = plate;
  art.append(img);
  resolvePicture(host.id, pictureSources(campaign, false), (src) => {
    if (img.isConnected && img.src !== src) img.src = src;
  });
  return art;
}

// ---------- the painting ----------

// The painting drifts for 48 seconds and back; a re-render (a feed event
// landing) rebuilds the screen, so the same painting picks its drift up
// where it was rather than starting again, and only a new painting fades
// in.
let shownArt = { key: "", src: "", since: 0 };

function backdrop(pick: ContinuePick | null): HTMLElement {
  const wrap = el("div", "tt-backdrop");
  wrap.setAttribute("aria-hidden", "true");
  const art = el("img", "tt-art");
  art.alt = "";
  art.draggable = false;
  const key = pick ? `${pick.host.id} ${pick.campaign.id}` : "";
  const paint = (src: string): void => {
    const now = Date.now();
    if (src !== shownArt.src || key !== shownArt.key) {
      shownArt = { key, src, since: now };
      art.classList.add("tt-art-in");
    }
    art.style.animationDelay = `-${now - shownArt.since}ms, 0ms`;
    art.src = src;
  };
  if (pick) {
    // The same table again keeps its painting from the last paint; a new
    // one starts on its genre plate and gets its cover or newest scene
    // once the host answers.
    const plate = localPlate(pick.campaign.placeholderUrl) ?? EMPTY_STAGE;
    paint(shownArt.key === key && shownArt.src ? shownArt.src : plate);
    resolvePicture(pick.host.id, pictureSources(pick.campaign, true), (src) => {
      if (art.isConnected && art.src !== src) paint(src);
    });
  } else {
    paint(EMPTY_STAGE);
  }
  wrap.append(art, el("div", "tt-scrim tt-scrim-side"), el("div", "tt-scrim tt-scrim-floor"), el("div", "tt-stars"));
  return wrap;
}

// The upper pair is pinned to the window; the lower pair rides the foot of
// the first screen (.tt-first), which grows with what it holds, so nothing
// on the title screen falls below its frame.
function corners(which: Array<"tl" | "tr" | "bl" | "br">): HTMLElement[] {
  return which.map((where) => {
    const corner = el("span", `tt-corner tt-corner-${where}`);
    corner.setAttribute("aria-hidden", "true");
    return corner;
  });
}

function reveal<T extends HTMLElement>(node: T, delayMs: number): T {
  node.classList.add("tt-reveal");
  node.style.animationDelay = `${delayMs}ms`;
  return node;
}

function brackets(): HTMLElement[] {
  return ["tl", "br"].map((where) => {
    const bracket = el("span", `tt-bracket tt-bracket-${where}`);
    bracket.setAttribute("aria-hidden", "true");
    return bracket;
  });
}

// ---------- the title block ----------

function goldTitle(text: string, small = false): HTMLElement {
  const heading = el("h1", small ? "tt-title tt-title-sm" : "tt-title");
  heading.append(el("span", "tt-title-face", text));
  return heading;
}

function eyebrow(text: string): HTMLElement {
  return el("span", "tt-eyebrow", text);
}

function chapter(text: string): HTMLElement {
  const line = el("p", "tt-chapter");
  line.append(el("span", "tt-rule"), el("span", "tt-chapter-text", text), el("span", "tt-rule tt-rule-end"));
  return line;
}

// The gold door in: the banner's gold, lit from within, a sheen that
// crosses once and a glow that breathes while the screen waits.
function enterButton(label: string, onClick: (btn: HTMLButtonElement) => void, leading: IconName = "swords"): HTMLButtonElement {
  const btn = el("button", "tt-enter");
  btn.type = "button";
  const sheen = el("span", "tt-enter-sheen");
  sheen.setAttribute("aria-hidden", "true");
  btn.append(sheen, icon(leading), document.createTextNode(label));
  btn.addEventListener("click", () => onClick(btn));
  return btn;
}

// The quiet door: a hairline of gold over the night.
function ghostButton(label: string, onClick: (btn: HTMLButtonElement) => void, leading?: IconName): HTMLButtonElement {
  const btn = el("button", "tt-ghost");
  btn.type = "button";
  if (leading) btn.append(icon(leading));
  btn.append(document.createTextNode(label));
  btn.addEventListener("click", () => onClick(btn));
  return btn;
}

// Where the table lives: the host's name with its live dot.
function sourceLine(host: HomeHost): HTMLElement {
  const line = el("span", "tt-source");
  line.append(icon(hostIcon(host)), document.createTextNode(hostName(host)), statusDot(host.status));
  line.title = host.kind === "local" ? "Hosted on this device" : host.origin;
  return line;
}

function partyFaces(host: HomeHost, campaign: HomeCampaign): HTMLElement | null {
  const faces = campaign.glance?.faces ?? [];
  if (faces.length === 0) return null;
  const wrap = el("span", "tt-faces");
  wrap.setAttribute("aria-hidden", "true");
  faces.slice(0, 5).forEach((face, index) => {
    const img = el("img", "tt-face");
    img.alt = "";
    img.title = face.name;
    img.draggable = false;
    img.style.animationDelay = `${540 + index * 60}ms`;
    const plate = localPlate(face.url);
    if (plate) img.src = plate;
    else {
      resolvePicture(host.id, [{ kind: "bridge", url: face.url }, { kind: "plain", url: face.url }], (src) => {
        if (img.isConnected) img.src = src;
      });
    }
    wrap.append(img);
  });
  return wrap;
}

function continueBlock(pick: ContinuePick): HTMLElement {
  const { host, campaign } = pick;
  const block = el("div", "tt-title-block");
  block.dataset.tour = "hero";
  block.append(reveal(eyebrow(titleEyebrow(campaign)), 140), reveal(goldTitle(campaign.title), 220));
  const line = chapterLine(campaign);
  if (line) block.append(reveal(chapter(line), 420));
  const party = el("div", "tt-party");
  const faces = partyFaces(host, campaign);
  if (faces) party.append(faces);
  party.append(el("span", "tt-seat-line", seatLine(campaign)), sourceLine(host));
  block.append(reveal(party, 520));
  const actions = el("div", "tt-actions");
  actions.append(enterButton(enterLabel(campaign), (btn) => openCampaign(host, campaign.id, btn)));
  block.append(reveal(actions, 640));
  return block;
}

// The world would not wake: unpack its server files again, keeping
// everything the player made, and try once more (Settings, Troubleshooting,
// says more and checks first).
async function repairLocal(btn: HTMLButtonElement): Promise<void> {
  const repair = window.odm.localRepair;
  if (!repair) return;
  btn.disabled = true;
  const result = await repair();
  await refresh();
  if (!result.ok) state.local = { ...state.local, state: "error", error: result.error };
  renderHome();
}

// The device world before it has a campaign to continue: first run,
// starting, a crash, or simply ready. Ready, it is the world's own home
// (the app never shows that page: it would repeat this one), so the door
// is the one that page offers: forge a new world.
function localBlock(host: HomeHost | null): HTMLElement {
  const local = state.local;
  const block = el("div", "tt-title-block");
  block.dataset.tour = "hero";
  const actions = el("div", "tt-actions");
  const device = isAndroid ? "device" : "computer";
  if (local.state === "error") {
    block.append(reveal(eyebrow("The road is dark"), 140), reveal(goldTitle(DEVICE, true), 220));
    block.append(reveal(el("p", "tt-lede", local.error || "The offline world could not start."), 420));
    actions.append(enterButton("Try again", (btn) => void playLocal(btn), "refresh"));
    if (window.odm.localRepair) actions.append(ghostButton("Repair", (btn) => void repairLocal(btn), "refresh"));
  } else if (local.firstRun) {
    block.append(reveal(eyebrow("Your first tale"), 140), reveal(goldTitle("Begin your world", true), 220));
    block.append(
      reveal(
        el(
          "p",
          "tt-lede",
          `No server needed. Your world lives on this ${device}, and friends can join from anywhere once you invite them.`,
        ),
        420,
      ),
    );
    if (local.state === "starting") actions.append(spinner(), badge("Starting"));
    else actions.append(enterButton("Start playing", (btn) => void playLocal(btn)));
  } else if (host?.lastSeenAt && host.campaigns.length === 0) {
    // Known to be empty: the same words the world's home says.
    block.append(reveal(eyebrow("Your first tale"), 140), reveal(goldTitle("Every campaign starts with an empty table.", true), 220));
    block.append(reveal(el("p", "tt-lede", "Create one and invite your friends, or join theirs with a room code below."), 420));
    if (local.state === "starting") actions.append(spinner(), badge("Starting"));
    else actions.append(enterButton("Forge a new world", (btn) => void playLocal(btn, "/?new=1")));
  } else {
    block.append(reveal(eyebrow(`Your world on this ${device}`), 140), reveal(goldTitle(DEVICE, true), 220));
    const who = el("p", "tt-lede");
    if (local.username) {
      who.append(document.createTextNode("Playing as "), el("strong", "", local.username), document.createTextNode("."));
    } else {
      who.textContent = "Offline world ready.";
    }
    block.append(reveal(who, 420));
    if (local.state === "starting") actions.append(spinner(), badge("Starting"));
    // Awake without a profile here (portal mode starts the world to serve a
    // friend's table, or the sign-in lapsed): the shell's own name or
    // sign-in screen comes first, as it always did.
    else if (!local.hasAccount) actions.append(enterButton("Start playing", (btn) => void playLocal(btn)));
    else actions.append(enterButton("Forge a new world", (btn) => void playLocal(btn, "/?new=1")));
  }
  block.append(reveal(actions, 640));
  return block;
}

// No device world in this build: the most recent server takes the title
// block so one tap continues where the player left off.
function serverBlock(server: ServerSummary): HTMLElement {
  const block = el("div", "tt-title-block");
  block.dataset.tour = "hero";
  block.append(
    reveal(eyebrow(`Continue as ${server.username}`), 140),
    reveal(goldTitle(server.name || hostOf(server.origin), true), 220),
    reveal(chapter(hostOf(server.origin)), 420),
  );
  const actions = el("div", "tt-actions");
  actions.append(enterButton("Enter", (btn) => void connectServer(server, btn)));
  block.append(reveal(actions, 640));
  return block;
}

function welcomeBlock(): HTMLElement {
  const block = el("div", "tt-title-block");
  block.dataset.tour = "hero";
  block.append(
    reveal(eyebrow("Gather your party"), 140),
    reveal(goldTitle("Every adventure starts with a table.", true), 220),
    reveal(
      el(
        "p",
        "tt-lede",
        window.odm.scanInvite
          ? "Connect to a self-hosted Open Dungeon Master, or scan or type an invite a friend sent you."
          : "Connect to a self-hosted Open Dungeon Master, or paste the room code or invite link a friend sent you.",
      ),
      420,
    ),
  );
  const actions = el("div", "tt-actions");
  actions.append(enterButton("Add a server", () => renderAdd(state.joinIntent?.origin ?? ""), "plus"));
  if (window.odm.scanInvite) actions.append(ghostButton("Scan invite", (btn) => void scanInvite(btn), "qr"));
  else actions.append(ghostButton("Paste invite", () => renderAdd(state.joinIntent?.origin ?? ""), "link"));
  block.append(reveal(actions, 640));
  return block;
}

function titleBlock(pick: ContinuePick | null, feed: HomeFeed): HTMLElement {
  if (pick) return continueBlock(pick);
  if (state.local.state === "unavailable") {
    const [latest] = state.servers;
    return latest ? serverBlock(latest) : welcomeBlock();
  }
  return localBlock(feed.hosts.find((host) => host.kind === "local") ?? null);
}

// ---------- the menu ----------

interface MenuItem {
  label: string;
  glyph: string;
  tour: string;
  onClick: (btn: HTMLButtonElement) => void;
  // A line under the name saying where it leads (the ways into a game).
  sub?: string;
}

// "Opens on ...": which host New campaign, Characters and Workshop go to,
// said once above them, with Change when there is another to choose. The
// choice is remembered (state.preferredHost) while that host answers.
function hostLine(primary: HomeHost, feed: HomeFeed): HTMLElement {
  const line = el("p", "tt-menu-host");
  line.dataset.tour = "home-host";
  line.append(icon(hostIcon(primary)), el("span", "tt-menu-host-text", `Opens on ${hostName(primary)}`));
  const next = nextCreationHost(feed, primary);
  if (next) {
    const change = el("button", "tt-menu-host-change", "Change");
    change.type = "button";
    change.title = `Open new tables, characters and workshops on ${hostName(next)} instead`;
    change.addEventListener("click", () => {
      setPreferredHost(next.id);
      renderHome();
    });
    line.append(change);
  }
  return line;
}

// A game's main menu: diamond bullets, Cinzel, the painted glyph rising
// beside the line under the pointer. The primary host's doors come first
// (a world that has never started has no pages to open yet, so they wait
// for its first run); the shell's own doors follow.
function menu(primary: HomeHost | null, feed: HomeFeed, focusJoin: () => void): HTMLElement {
  const nav = el("nav", "tt-menu");
  nav.setAttribute("aria-label", "Main menu");
  const items: MenuItem[] = [];
  const opensHere = Boolean(primary && !(primary.kind === "local" && state.local.firstRun));
  if (primary && opensHere) nav.append(reveal(hostLine(primary, feed), 760));
  if (primary && opensHere) {
    // A server whose admin keeps campaign creation offers no door for it;
    // the room code in the Join box is the way in there.
    if (primary.canCreate) {
      // Quick start is an AI-run adventure: offered, as on the website, only
      // where the host has an AI storyteller to run it.
      if (primary.offersStory) {
        items.push({ label: "Quick start", glyph: "ui-quickstart", tour: "tile-quick-start", sub: STARTING_ROUTES.starter, onClick: (btn) => openHost(primary, "/?new=starter", btn) });
      }
      items.push({ label: "New campaign", glyph: "ui-new", tour: "tile-new-campaign", sub: STARTING_ROUTES.new, onClick: (btn) => openHost(primary, "/?new=1", btn) });
    }
    items.push(
      { label: "Characters", glyph: "tab-characters", tour: "tile-characters", onClick: (btn) => openHost(primary, "/characters", btn) },
      { label: "Workshop", glyph: "system-homebrew", tour: "tile-workshop", onClick: (btn) => openHost(primary, "/workshop", btn) },
      { label: "Rulebook", glyph: "system-rules", tour: "tile-rulebook", onClick: (btn) => openHost(primary, "/rulebook", btn) },
    );
  }
  // The ways into a game come first, each with its line; the places that
  // are yours and the app's own doors stand beside them from a laptop up,
  // so the menu stays inside the title screen's frame.
  const places = items.filter((item) => !item.sub);
  const ways = items.filter((item) => item.sub);
  items.length = 0;
  items.push(...ways, { label: "Join with a code", glyph: "ui-join", tour: "tile-join", sub: STARTING_ROUTES.join, onClick: focusJoin });
  const waysCount = items.length;
  items.push(...places);
  items.push({ label: "Add a server", glyph: "system-share", tour: "tile-add-server", onClick: () => renderAdd(state.joinIntent?.origin ?? "") });
  // Story AI is chosen on the world's first run; the door only makes sense
  // once that world exists.
  if (state.local.state !== "unavailable" && !state.local.firstRun) {
    items.push({ label: "Story AI", glyph: "ui-ai", tour: "tile-story-ai", onClick: () => renderLocalAi(true) });
  }
  const groups = el("div", "tt-menu-groups");
  const waysGroup = el("div", "tt-menu-group");
  const placesGroup = el("div", "tt-menu-group");
  groups.append(waysGroup, placesGroup);
  nav.append(groups);
  items.forEach((item, index) => {
    const btn = el("button", "tt-menu-item");
    btn.type = "button";
    btn.dataset.tour = item.tour;
    const diamond = el("span", "tt-menu-diamond");
    diamond.setAttribute("aria-hidden", "true");
    const glyphWrap = el("span", "tt-menu-glyph");
    glyphWrap.setAttribute("aria-hidden", "true");
    glyphWrap.append(glyph(item.glyph));
    const text = el("span", "tt-menu-text");
    text.append(el("span", "tt-menu-label", item.label));
    if (item.sub) text.append(el("span", "tt-menu-sub", item.sub));
    btn.append(diamond, text, glyphWrap);
    btn.addEventListener("click", () => item.onClick(btn));
    (index < waysCount ? waysGroup : placesGroup).append(reveal(btn, 800 + index * 55));
  });
  return nav;
}

// "Your world is awake · server 0.23.5 · v0.15.0": one mono line at the
// foot of the menu, the way a title screen shows its build. The lamp is
// lit gold while the device world runs, ember when it could not start,
// pulsing while it wakes, unlit while it sleeps.
function statusLine(): HTMLElement {
  const { tone, text } = deviceStatusLine(state.local, state.appInfo?.version ?? "");
  const line = el("p", `tt-status tt-status-${tone}`);
  line.setAttribute("aria-live", "polite");
  const lamp = el("span", "tt-lamp");
  lamp.setAttribute("aria-hidden", "true");
  line.append(lamp, document.createTextNode(text));
  return reveal(line, 1200);
}

// ---------- the recap ----------

// "When last we left": the last thing the Dungeon Master said at that
// table, with the drop cap, and a mono line saying when.
function recapPanel(pick: ContinuePick): HTMLElement {
  const { campaign } = pick;
  const panel = el("aside", "tt-recap tt-panel");
  panel.setAttribute("aria-label", "When last we left");
  panel.append(...brackets(), el("span", "tt-panel-eyebrow", "When last we left"));
  const { text, quiet } = recapText(campaign);
  const body = el("p", quiet ? "tt-recap-text tt-recap-quiet" : "tt-recap-text");
  if (quiet) body.textContent = text;
  else body.append(el("span", "tt-dropcap", text.charAt(0)), document.createTextNode(text.slice(1)));
  panel.append(body);
  const ago = agoLabel(campaign.glance?.recapAt ?? campaign.updatedAt);
  if (ago) panel.append(el("span", "tt-mono", ago));
  return reveal(panel, 720);
}

// ---------- save slots: your tables, by host ----------

// What the last Delete or Duplicate from a slot answered when it failed,
// shown above the slots until the next one is tried.
let slotError = "";

// The device world asleep, with an owner: it wakes when one of its tables
// or a slot action needs it, so its kept list counts like a live one.
function localWakes(): boolean {
  return state.local.state === "stopped" && !state.local.firstRun && state.local.hasAccount;
}

// A slot action on the device world wakes it first; there is no "enter
// your world" step any more to have done that.
async function wakeFor(host: HomeHost): Promise<void> {
  if (host.kind !== "local" || state.local.state === "running") return;
  const started = await window.odm.localStart();
  if (!started.ok) throw new Error(started.error);
  state.local = started.status;
}

// Delete from a save slot: the same call and the same warning as the
// website's home, made with this host's session. The table on the title
// screen has a slot too, so it can be deleted from here like any other.
async function deleteFromSlot(host: HomeHost, campaign: HomeCampaign, btn: HTMLButtonElement): Promise<void> {
  if (
    !confirm(
      `Delete "${campaign.title}" for everyone? All characters, messages, and story progress are lost. This cannot be undone.`,
    )
  ) {
    return;
  }
  btn.disabled = true;
  slotError = "";
  try {
    await wakeFor(host);
    const client = await hostClient(host.id);
    if (!client) throw new Error(`Sign in to ${hostName(host)} again to delete "${campaign.title}".`);
    await client.json(`/api/campaigns/${encodeURIComponent(campaign.id)}`, { method: "DELETE" });
  } catch (error) {
    slotError = error instanceof Error && error.message ? error.message : `Could not delete "${campaign.title}".`;
  }
  await refreshFeed();
  if (state.screenName === "home") renderHome();
}

// Duplicate from a save slot: the website's slot action (a new campaign
// with the old one's world, prep and settings, nobody seated), made with
// this host's session. The world's own home, which offered it before, is
// not shown in the app.
async function duplicateFromSlot(host: HomeHost, campaign: HomeCampaign, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  slotError = "";
  try {
    await wakeFor(host);
    const client = await hostClient(host.id);
    if (!client) throw new Error(`Sign in to ${hostName(host)} again to copy "${campaign.title}".`);
    await client.json(`/api/campaigns/${encodeURIComponent(campaign.id)}/clone`, { method: "POST", body: {} });
  } catch (error) {
    slotError = error instanceof Error && error.message ? error.message : `Could not make a copy of "${campaign.title}".`;
  }
  await refreshFeed();
  if (state.screenName === "home") renderHome();
}

function slot(group: HostGroup, row: CampaignRow): HTMLElement {
  const { host } = group;
  const { campaign } = row;
  const cell = el("li", "tt-slot-cell");
  const ended = campaign.status === "ended";
  const door = el("button", ended ? "tt-slot tt-slot-ended" : "tt-slot");
  door.type = "button";
  if (host.stale) door.classList.add("tt-slot-stale");
  const art = slotArt(host, campaign);
  const status = el("span", `tt-slot-badge tt-slot-badge-${campaign.status}`, campaign.status);
  art.append(status);
  door.append(art, el("span", "tt-slot-title", campaign.title));
  if (row.action === "blocked") {
    door.classList.add("tt-slot-blocked");
    door.disabled = true;
    door.append(el("span", "tt-slot-line", row.reason));
  } else {
    door.append(el("span", "tt-slot-line", slotLine(campaign)));
    door.addEventListener("click", () => {
      if (row.action === "signIn") void signInTo(host.origin, host.username);
      else openCampaign(host, campaign.id, door);
    });
  }
  const meta = slotMeta(campaign);
  door.append(el("span", "tt-slot-meta", meta || hostName(host)));
  door.title = `${campaign.title} on ${hostName(host)}`;
  cell.append(door);
  // Beside the door, not inside it: a button cannot hold a button.
  const actions = el("span", "tt-slot-actions");
  if (canDuplicateFromHome(host, campaign, localWakes())) {
    actions.append(iconButton("copy", "Duplicate this campaign", (btn) => void duplicateFromSlot(host, campaign, btn), "tt-slot-action tt-slot-copy"));
  }
  if (canDeleteFromHome(host, campaign, localWakes())) {
    actions.append(iconButton("trash", "Delete this campaign", (btn) => void deleteFromSlot(host, campaign, btn), "tt-slot-action tt-slot-delete"));
  }
  if (actions.childElementCount) cell.append(actions);
  return cell;
}

// A dashed slot at the end of the primary host's row forges a new world.
function forgeSlot(host: HomeHost): HTMLElement {
  const cell = el("li", "tt-slot-cell");
  const btn = el("button", "tt-slot tt-slot-new");
  btn.type = "button";
  const plus = el("span", "tt-slot-new-plus");
  plus.setAttribute("aria-hidden", "true");
  plus.append(icon("plus"));
  btn.append(plus, el("span", "tt-slot-title", "Forge a new world"));
  btn.addEventListener("click", () => openHost(host, "/?new=1", btn));
  cell.append(btn);
  return cell;
}

function slotGroup(group: HostGroup, primary: HomeHost | null): HTMLElement | null {
  const { host, rows } = group;
  const forge = primary?.id === host.id && !(host.kind === "local" && state.local.firstRun);
  if (rows.length === 0 && !forge) return null;
  const wrap = el("div", `tt-slot-group ${host.status}`);
  const head = el("div", "tt-slot-host");
  head.append(icon(hostIcon(host)), el("span", "tt-slot-host-name", group.label));
  const status = el("span", `tt-slot-host-status ${host.status}`);
  status.append(statusDot(host.status), document.createTextNode(group.statusLabel));
  head.append(status);
  if (group.lastSeen) head.append(el("span", "tt-slot-host-seen", group.lastSeen));
  if (host.status === "needsLogin") {
    head.append(ghostButton("Sign in", () => void signInTo(host.origin, host.username), "logIn"));
  }
  wrap.append(head);
  const row = el("ul", "tt-slot-row");
  for (const entry of rows) row.append(slot(group, entry));
  if (forge) row.append(forgeSlot(host));
  wrap.append(row);
  return wrap;
}

// The hide-offline switch, on the title screen and in Settings; rerender
// repaints whichever screen holds it.
export function offlineToggle(rerender: () => void = renderHome): HTMLElement {
  const on = hideOffline();
  const btn = el("button", on ? "toggle on" : "toggle");
  btn.type = "button";
  btn.setAttribute("aria-pressed", String(on));
  const track = el("span", "track");
  track.append(el("span", "knob"));
  btn.append(document.createTextNode("Hide offline"), track);
  btn.addEventListener("click", () => {
    setHideOffline(!on);
    rerender();
  });
  return btn;
}

function refreshButton(): HTMLElement {
  const btn = iconButton("refresh", "Refresh", () => {
    void refreshFeed().then(() => {
      if (state.screenName === "home") renderHome();
    });
    renderHome();
  }, state.feedRefreshing ? "spin" : "");
  btn.disabled = state.feedRefreshing;
  return btn;
}

// Every table, the one on the title screen included: its slot is where it
// is deleted, the same as on the website's home.
function slots(feed: HomeFeed, primary: HomeHost | null): HTMLElement {
  const section = el("section", "tt-slots");
  section.setAttribute("aria-label", "Your tables");
  const head = el("div", "tt-slots-head");
  const groups = buildGroups(feed, { hideOffline: hideOffline(), deviceName: DEVICE, now: Date.now() });
  const count = groups.reduce((total, group) => total + group.rows.length, 0);
  head.append(el("h2", "tt-slots-eyebrow", count === 1 ? "Your table" : "Your tables"));
  const controls = el("div", "tt-slots-controls");
  controls.append(offlineToggle(), refreshButton());
  head.append(controls);
  section.append(head);
  if (slotError) section.append(el("p", "tt-error tt-shake tt-slots-error", slotError));
  let drawn = 0;
  for (const group of groups) {
    const node = slotGroup(group, primary);
    if (!node) continue;
    section.append(node);
    drawn += 1;
  }
  if (drawn === 0) {
    const empty = el("p", "tt-slots-empty");
    if (!state.feed) empty.append(spinner(), document.createTextNode(" Looking for your tables..."));
    else if (feed.hosts.length === 0) empty.textContent = "Add a server or begin your world, and your tables gather here.";
    else if (groups.length === 0) empty.textContent = "Every remote host is offline right now. Turn off Hide offline to see them.";
    else empty.textContent = "No tables yet.";
    section.append(empty);
  }
  if (feed.hosts.some((host) => host.kind === "tunnel" && host.status === "offline")) {
    section.append(
      el(
        "p",
        "tt-slots-note",
        "Tables hosted on another player's device only open while that app is online. You can rejoin the moment their host comes back.",
      ),
    );
  }
  return reveal(section, 900);
}

// ---------- below the fold ----------

// The device world's own panel: who plays there, whether it is awake, the
// storyteller and the sharing switch.
function deviceBlock(localIsHero: boolean): HTMLElement | null {
  const local = state.local;
  if (local.state === "unavailable" || local.firstRun) return null;
  const panel = el("section", "tt-device tt-panel");
  panel.setAttribute("aria-label", DEVICE);
  panel.append(...brackets());
  const head = el("div", "tt-device-head");
  const text = el("div", "tt-device-text");
  text.append(el("h2", "tt-below-eyebrow", `Your world on this ${isAndroid ? "device" : "computer"}`));
  text.append(el("p", "tt-device-name", local.username ? `Playing as ${local.username}` : DEVICE));
  const detail =
    local.state === "running"
      ? local.serverVersion
        ? `Your world is awake, server ${local.serverVersion}.`
        : "Your world is awake."
      : local.state === "starting"
        ? "Waking your world..."
        : local.state === "error"
          ? local.error || "The offline world could not start."
          : "Asleep until you open one of its tables. Friends can join once it is awake and shared.";
  text.append(el("p", "tt-below-lede", detail));
  head.append(text);
  const actions = el("div", "tt-device-actions");
  if (local.state !== "starting") {
    const storyAi = ghostButton("Story AI", () => renderLocalAi(true), "sparkles");
    storyAi.dataset.tour = "story-ai";
    actions.append(storyAi);
    if (!localIsHero) actions.append(ghostButton("New campaign here", (btn) => void playLocal(btn, "/?new=1"), "plus"));
  }
  head.append(actions);
  panel.append(head);
  if (local.state === "running") panel.append(shareRow());
  return panel;
}

// Joining someone else's table by its invite code: "join by sigil". One
// real field does the typing, the pasting and the submitting; the boxes
// over it are only how the code is shown. A link or a server address
// pasted here works too, the same as in Add a server.
function joinPanel(): { panel: HTMLElement; focus: () => void } {
  const panel = el("section", "tt-join tt-panel");
  panel.id = "join";
  panel.dataset.tour = "home-invite";
  panel.setAttribute("aria-label", "Join with a room code");
  panel.append(
    ...brackets(),
    el("h2", "tt-below-eyebrow", "Join by sigil"),
    el("p", "tt-below-lede", "A friend running a table gives you an eight-letter room code. An invite link or a server address works here too."),
  );
  const form = el("form", "tt-join-form");
  const sigil = el("label", "tt-sigil");
  sigil.setAttribute("aria-label", "Room code");
  const field = el("input", "tt-sigil-input");
  field.type = "text";
  field.autocapitalize = "characters";
  field.autocomplete = "off";
  field.spellcheck = false;
  field.required = true;
  field.setAttribute("enterkeyhint", "go");
  const boxes = el("span", "tt-sigil-boxes");
  boxes.setAttribute("aria-hidden", "true");
  const paint = (): void => {
    const value = field.value.trim();
    // A pasted link or address is longer than any code and has no boxes
    // to fill; it shows as one line instead.
    const link = /[./:]/.test(value);
    boxes.classList.toggle("tt-sigil-link", link);
    boxes.replaceChildren();
    if (link) {
      boxes.append(el("span", "tt-sigil-text", value));
      return;
    }
    const count = Math.max(8, value.length);
    for (let index = 0; index < count; index += 1) {
      const ch = value[index]?.toUpperCase() ?? "";
      const box = el("span", ch ? "tt-sigil-box tt-sigil-box-lit" : "tt-sigil-box", ch);
      if (index === value.length) box.classList.add("tt-sigil-box-next");
      boxes.append(box);
    }
  };
  field.addEventListener("input", paint);
  field.addEventListener("focus", () => boxes.classList.add("tt-sigil-focus"));
  field.addEventListener("blur", () => boxes.classList.remove("tt-sigil-focus"));
  paint();
  sigil.append(field, boxes);
  const error = el("p", "tt-error");
  const join = ghostButton("Join", () => form.requestSubmit());
  join.type = "submit";
  form.append(sigil, join);
  if (window.odm.scanInvite) form.append(ghostButton("Scan a QR code", (btn) => void scanInvite(btn, error), "qr"));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitJoin(() => openTyped(field.value), join, error, () => {
      sigil.classList.remove("tt-shake");
      void sigil.offsetWidth;
      sigil.classList.add("tt-shake");
    });
  });
  panel.append(form, error);
  const focus = (): void => {
    panel.scrollIntoView({ behavior: "smooth", block: "center" });
    field.focus({ preventScroll: true });
  };
  return { panel, focus };
}

export function renderHome(): void {
  state.screenName = "home";
  const feed = reconcileLocal(state.feed ?? EMPTY_FEED, state.local);
  // An asleep world wakes when one of its tables opens, so its last table
  // is continued from here like any other.
  const pick = pickContinueCampaign(feed, localWakes());
  const primary = pickPrimaryHost(feed, pick, preferredHost());
  const localIsHero = !pick && state.local.state !== "unavailable";
  const join = joinPanel();

  const page = el("div", "tt-page");
  const first = el("div", "tt-first");
  first.append(...corners(["bl", "br"]));
  const header = topbar();
  header.classList.add("tt-header");
  first.append(header);
  const banner = joinBanner();
  if (banner) first.append(banner);

  const stage = el("section", "tt-stage");
  stage.setAttribute("aria-label", "Title screen");
  const left = el("div", "tt-stage-left");
  left.append(titleBlock(pick, feed), menu(primary, feed, join.focus), statusLine());
  const right = el("div", "tt-stage-right");
  if (pick) right.append(recapPanel(pick));
  right.append(slots(feed, primary));
  stage.append(left, right);
  first.append(stage);
  page.append(first);

  const below = el("section", "tt-below");
  below.append(...[deviceBlock(localIsHero), join.panel, footer()].filter((node): node is HTMLElement => node !== null));
  page.append(below);

  show("title", backdrop(pick), ...corners(["tl", "tr"]), page);
}
