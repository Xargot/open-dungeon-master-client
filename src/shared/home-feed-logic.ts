import { BROKER_HOST_SHAPE } from "./broker";
import type { HomeCampaign, HomeFeed, HomeGlance, HomeGlanceFace, HomeHost, LocalStatus, ShellEvent } from "./types";

// The home screen's campaign feed: every host the player uses (the device
// world, saved servers, friends' apps reached through a tunnel), each with
// its campaigns. Pure helpers and an orchestrator with injected I/O, shared
// by the desktop main process (src/main/home-feed.ts) and the Android
// bridge (mobile/src/home-feed.ts), so it all runs under plain Node in tests.

export const CAMPAIGNS_PATH = "/api/campaigns";
// The device world's host id on both shells (the desktop registry's
// LOCAL_SERVER_ID has the same value).
export const LOCAL_HOST_ID = "local";
// A host that has not answered in this long is shown from its cache.
export const HOME_FETCH_TIMEOUT_MS = 6_000;

// Quick tunnels are anonymous trycloudflare addresses (src/shared/broker.ts
// has the named play-CODE shape). Both mean "another player's app".
const QUICK_HOST_SHAPE = /^[a-z0-9-]+\.trycloudflare\.com$/;

export function isTunnelOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return BROKER_HOST_SHAPE.test(host) || QUICK_HOST_SHAPE.test(host);
}

export function hostKindFor(origin: string): "server" | "tunnel" {
  return isTunnelOrigin(origin) ? "tunnel" : "server";
}

// One host as the shell knows it before any request goes out. token is ""
// when the shell holds no live session for it.
export interface HostInput {
  id: string;
  kind: HomeHost["kind"];
  name: string;
  origin: string;
  username: string;
  lastUsedAt: string;
  token: string;
}

// What the persisted store keeps per host: the last list that came back
// and when, plus the status seen then so a cold start can show something
// before the first refresh lands.
export interface HomeCacheEntry {
  status: HomeHost["status"];
  campaigns: HomeCampaign[];
  lastSeenAt: string | null;
  // Absent in caches written before the policy existed: open.
  canCreate?: boolean;
  // Absent in caches written before the server said: offered.
  offersStory?: boolean;
}

export type HomeCache = Record<string, HomeCacheEntry>;

export type SkippedOutcome = {
  kind: "skipped";
  status: Exclude<HomeHost["status"], "online">;
  error: string;
};

// How a host's request ended: an HTTP answer, no answer at all, or no
// request because the shell already knew the answer.
export type FetchOutcome =
  | { kind: "reply"; status: number; body: unknown }
  | { kind: "failed"; error: string }
  | SkippedOutcome;

export const NEEDS_LOGIN: SkippedOutcome = { kind: "skipped", status: "needsLogin", error: "" };

// The local world's process state decides its host status without a
// request; null means it is running and should be asked like any server.
export function localOutcome(status: LocalStatus): SkippedOutcome | null {
  switch (status.state) {
    case "running":
      return null;
    case "starting":
      return { kind: "skipped", status: "starting", error: "" };
    case "unavailable":
      return { kind: "skipped", status: "unavailable", error: "" };
    case "error":
      return { kind: "skipped", status: "offline", error: status.error };
    default:
      return { kind: "skipped", status: "offline", error: "" };
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

// Covers come back host-relative (/uploads/...); the feed mixes hosts, so
// each cover is pinned to the host it came from.
function absoluteUrl(raw: string, origin: string): string | null {
  if (!raw) return null;
  try {
    return new URL(raw, origin).href;
  } catch {
    return null;
  }
}

// Covers live behind the server's login (/uploads is player uploads, not a
// public gallery, and /generated is the painted scenes), and the home
// page's image tags carry no session: the shell fetches each picture with
// the host's bearer token and hands the page a data URL. A picture is only
// ever asked of the host it was pinned to, and only under those two
// folders, so the token goes nowhere else.
export const COVER_MAX_BYTES = 4 * 1024 * 1024;

export function coverRequestUrl(hostOrigin: string, url: string): string | null {
  if (!hostOrigin || !url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== hostOrigin) return null;
  if (!parsed.pathname.startsWith("/uploads/") && !parsed.pathname.startsWith("/generated/")) return null;
  return parsed.href;
}

export function imageDataUrl(contentType: string, base64: string): string | null {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!/^image\/[a-z0-9.+-]+$/.test(type) || !base64) return null;
  return `data:${type};base64,${base64}`;
}

// The cover plate a campaign shows before anyone paints one: three per
// genre under /assets/placeholders/campaign, picked by a hash of the id so
// the pick never reshuffles. A port of campaignPlaceholder in the server's
// src/lib/placeholders.ts, kept identical so the app's home shows the same
// picture the server's home does.
const PLACEHOLDER_BASE = "/assets/placeholders/campaign";
const COVER_VARIANTS = 3;
const COVER_GENRES = new Set([
  "high-fantasy",
  "dark-fantasy",
  "mystery",
  "horror",
  "cyberpunk",
  "steampunk",
  "post-apocalyptic",
  "custom",
]);

function fnvHash(value: string): number {
  let acc = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    acc ^= value.charCodeAt(index);
    acc = Math.imul(acc, 16777619);
  }
  return acc >>> 0;
}

export function campaignPlaceholderPath(genre: string, seed: string): string {
  const slug = genre.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const known = COVER_GENRES.has(slug) ? slug : "custom";
  const variant = (fnvHash(seed || known) % COVER_VARIANTS) + 1;
  return `${PLACEHOLDER_BASE}/${known}-${variant}.webp`;
}

// The server's GET /api/campaigns body. Returns null when the body is not a
// campaign list at all; entries without an id are dropped rather than
// failing the whole host. cover and playingAs are newer fields and optional.
// The title screen's glance, when the host sends one (server 0.23.5 and
// up). Pictures are pinned to the host the way covers are.
function parseGlance(raw: unknown, origin: string): HomeGlance | null {
  if (!raw || typeof raw !== "object") return null;
  const glance = raw as Record<string, unknown>;
  const chapter = glance.chapter as
    | { index?: unknown; title?: unknown; act?: unknown; actTitle?: unknown }
    | null
    | undefined;
  const faces: HomeGlanceFace[] = [];
  if (Array.isArray(glance.faces)) {
    for (const face of glance.faces as Array<Record<string, unknown> | null>) {
      const url = absoluteUrl(str(face?.url), origin);
      if (url) faces.push({ name: str(face?.name), url });
    }
  }
  return {
    chapter:
      chapter && typeof chapter === "object" && num(chapter.index) > 0
        ? {
            index: num(chapter.index),
            title: str(chapter.title),
            act: num(chapter.act) > 0 ? num(chapter.act) : null,
            actTitle: str(chapter.actTitle),
          }
        : null,
    recap: str(glance.recap),
    recapAt: str(glance.recapAt) || null,
    sceneImage: absoluteUrl(str(glance.sceneImage), origin),
    faces,
  };
}

export function parseCampaigns(body: unknown, origin: string): HomeCampaign[] | null {
  const list = (body as { campaigns?: unknown } | null)?.campaigns;
  if (!Array.isArray(list)) return null;
  // The list never names the account it was fetched for, but a row this
  // account owns does: its ownerUserId is the account's id. With that, the
  // DM seat can be read off every row the way the server's own home does.
  let me = "";
  for (const raw of list) {
    const entry = raw as Record<string, unknown> | null;
    if (entry && entry.role === "owner" && str(entry.ownerUserId)) {
      me = str(entry.ownerUserId);
      break;
    }
  }
  const campaigns: HomeCampaign[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const id = str(entry.id);
    if (!id) continue;
    const settings = entry.gameSettings as
      | { dmMode?: unknown; genre?: unknown }
      | null
      | undefined;
    const cover = entry.cover as { url?: unknown } | null | undefined;
    const code = str(entry.inviteCode).trim().toUpperCase();
    const genre = str(entry.genre) || str(settings?.genre);
    const glance = parseGlance(entry.glance, origin);
    const level = num(entry.startingLevel);
    campaigns.push({
      id,
      title: str(entry.title) || "Untitled campaign",
      status: pick(entry.status, ["lobby", "active", "ended"] as const, "lobby"),
      playerCount: num(entry.playerCount),
      maxPlayers: num(entry.maxPlayers),
      playingAs: str(entry.playingAs) || null,
      coverUrl: absoluteUrl(str(cover?.url), origin),
      placeholderUrl: absoluteUrl(campaignPlaceholderPath(genre, id), origin),
      updatedAt: str(entry.updatedAt),
      role: pick(entry.role, ["owner", "player"] as const, "player"),
      dmMode: pick(settings?.dmMode, ["ai", "assisted", "human"] as const, "ai"),
      // Only when the host actually sent one, so a campaign without a code
      // keeps the shape it has always had in the cache.
      ...(code ? { inviteCode: code } : {}),
      // The title screen's words, only when the host had them to give.
      ...(genre ? { genre } : {}),
      ...(str(entry.description) ? { description: str(entry.description) } : {}),
      ...(str(entry.scene) ? { scene: str(entry.scene) } : {}),
      ...(level > 0 ? { startingLevel: level } : {}),
      ...(str(entry.difficulty) ? { difficulty: str(entry.difficulty) } : {}),
      ...(me ? { dmSeat: str(entry.dmUserId) === me || str(entry.assistantDmUserId) === me } : {}),
      ...(glance ? { glance } : {}),
    });
  }
  return campaigns;
}

export interface Classification {
  status: HomeHost["status"];
  // null when nothing fresh came back; the caller falls back to its cache.
  campaigns: HomeCampaign[] | null;
  // Whether the account may start a campaign there; only meaningful with a
  // fresh list. A server that does not say (before 0.25) is open.
  canCreate: boolean;
  // Whether it has an AI storyteller (Quick start is AI-run); a server that
  // does not say (before 0.27.3) is taken to have one.
  offersStory: boolean;
  error: string;
}

export function parseCanCreate(body: unknown): boolean {
  const value = (body as { canCreateCampaigns?: unknown } | null)?.canCreateCampaigns;
  return value !== false;
}

export function parseOffersStory(body: unknown): boolean {
  const value = (body as { offersStory?: unknown } | null)?.offersStory;
  return value !== false;
}

export function classifyOutcome(outcome: FetchOutcome, origin: string): Classification {
  if (outcome.kind === "skipped") {
    return { status: outcome.status, campaigns: null, canCreate: true, offersStory: true, error: outcome.error };
  }
  if (outcome.kind === "failed") return { status: "offline", campaigns: null, canCreate: true, offersStory: true, error: outcome.error };
  if (outcome.status === 401 || outcome.status === 403) {
    return { status: "needsLogin", campaigns: null, canCreate: true, offersStory: true, error: "" };
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    return { status: "offline", campaigns: null, canCreate: true, offersStory: true, error: `${origin} answered ${outcome.status}.` };
  }
  const campaigns = parseCampaigns(outcome.body, origin);
  if (!campaigns) {
    return {
      status: "offline",
      campaigns: null,
      canCreate: true,
      offersStory: true,
      error: `${origin} did not answer with a campaign list.`,
    };
  }
  return {
    status: "online",
    campaigns,
    canCreate: parseCanCreate(outcome.body),
    offersStory: parseOffersStory(outcome.body),
    error: "",
  };
}

// Fresh data wins; otherwise the cached list is shown and marked stale.
// stale is simply "not from this refresh", so an unreachable host with no
// cache is stale and empty rather than pretending to be current.
export function resolveHost(
  input: HostInput,
  outcome: FetchOutcome,
  cached: HomeCacheEntry | null,
  now: string,
): HomeHost {
  const result = classifyOutcome(outcome, input.origin);
  const fresh = result.campaigns !== null;
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    origin: input.origin,
    username: input.username,
    status: result.status,
    lastSeenAt: fresh ? now : (cached?.lastSeenAt ?? null),
    stale: !fresh,
    error: result.error,
    campaigns: result.campaigns ?? cached?.campaigns ?? [],
    canCreate: fresh ? result.canCreate : (cached?.canCreate ?? true),
    offersStory: fresh ? result.offersStory : (cached?.offersStory ?? true),
  };
}

// The instant view before any request: whatever the store remembers. The
// local world's process state is known without asking, so it overrides
// the remembered status.
export function hostFromCache(
  input: HostInput,
  cached: HomeCacheEntry | null,
  status?: HomeHost["status"],
): HomeHost {
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    origin: input.origin,
    username: input.username,
    status: status ?? cached?.status ?? (input.token ? "offline" : "needsLogin"),
    lastSeenAt: cached?.lastSeenAt ?? null,
    stale: true,
    error: "",
    campaigns: cached?.campaigns ?? [],
    canCreate: cached?.canCreate ?? true,
    offersStory: cached?.offersStory ?? true,
  };
}

export function cacheEntryFor(host: HomeHost): HomeCacheEntry {
  return {
    status: host.status,
    campaigns: host.campaigns,
    lastSeenAt: host.lastSeenAt,
    canCreate: host.canCreate,
    offersStory: host.offersStory,
  };
}

// The device world leads; everything else follows in the order the player
// last used it.
export function orderHosts<T extends { kind: HomeHost["kind"]; lastUsedAt: string }>(
  hosts: readonly T[],
): T[] {
  return [...hosts].sort((a, b) => {
    if (a.kind === "local" !== (b.kind === "local")) return a.kind === "local" ? -1 : 1;
    return b.lastUsedAt.localeCompare(a.lastUsedAt);
  });
}

export interface HomeFeedDeps {
  // Every host including the local one, in any order.
  hosts(): Promise<HostInput[]>;
  localStatus(): Promise<LocalStatus>;
  fetchCampaigns(origin: string, token: string): Promise<FetchOutcome>;
  loadCache(): Promise<HomeCache>;
  saveCache(cache: HomeCache): Promise<void>;
  emit(event: ShellEvent): void;
  now(): string;
  // Where this host is now, when the address on file has gone quiet, or ""
  // when it cannot be found. A world one of the apps hosts answers at a new
  // address every time its host shares it again, and a host shown offline is
  // not even tappable, so without this the player has no way back in at all.
  // Optional so a shell that has no registry to move can leave it out.
  relocate?(input: HostInput): Promise<string>;
}

export interface HomeFeedController {
  // Asks every host in parallel, updates the cache, pushes a home-feed event.
  refresh(): Promise<HomeFeed>;
  // The last refresh of this run, or the persisted cache before one exists
  // (refreshedAt is "" then).
  cached(): Promise<HomeFeed>;
}

export function createHomeFeed(deps: HomeFeedDeps): HomeFeedController {
  let last: HomeFeed | null = null;
  let inFlight: Promise<HomeFeed> | null = null;
  let again = false;

  async function outcomeFor(input: HostInput, local: LocalStatus): Promise<FetchOutcome> {
    if (input.kind === "local") {
      const skip = localOutcome(local);
      if (skip) return skip;
    }
    if (!input.token) return NEEDS_LOGIN;
    if (!input.origin) return { kind: "failed", error: "This host has no address." };
    return deps.fetchCampaigns(input.origin, input.token);
  }

  async function build(): Promise<HomeFeed> {
    const now = deps.now();
    const [inputs, local, cache] = await Promise.all([
      deps.hosts(),
      deps.localStatus(),
      deps.loadCache(),
    ]);
    const hosts = await Promise.all(
      orderHosts(inputs).map(async (input) => {
        let current = input;
        let outcome = await outcomeFor(current, local);
        // No answer at the address on file, or an answer that is not this
        // world's (a dead tunnel hostname still answers with an edge error
        // page for a while). Before writing the host off as offline, find
        // out whether it simply moved; a tile that says offline offers the
        // player nothing to tap. A 401 or 403 is the host itself speaking
        // and stays a sign-in matter.
        const gone =
          outcome.kind === "failed" ||
          (outcome.kind === "reply" &&
            outcome.status !== 401 &&
            outcome.status !== 403 &&
            (outcome.status < 200 || outcome.status >= 300));
        if (gone && deps.relocate) {
          const moved = await deps.relocate(current).catch(() => "");
          if (moved && moved !== current.origin) {
            current = { ...current, origin: moved };
            outcome = await outcomeFor(current, local);
          }
        }
        return resolveHost(current, outcome, cache[current.id] ?? null, now);
      }),
    );
    // Rewriting the whole record also drops hosts the player has removed.
    const next: HomeCache = {};
    for (const host of hosts) next[host.id] = cacheEntryFor(host);
    await deps.saveCache(next).catch(() => undefined);
    const feed: HomeFeed = { hosts, refreshedAt: now };
    last = feed;
    deps.emit({ kind: "home-feed", feed });
    return feed;
  }

  // One refresh at a time. A request that lands mid-flight (the local world
  // just came up) is answered with the running one and queues another, so
  // the state that triggered it is never missed.
  function refresh(): Promise<HomeFeed> {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = build().finally(() => {
      inFlight = null;
      if (again) {
        again = false;
        refresh().catch(() => undefined);
      }
    });
    return inFlight;
  }

  async function cached(): Promise<HomeFeed> {
    if (last) return last;
    const [inputs, local, cache] = await Promise.all([
      deps.hosts(),
      deps.localStatus(),
      deps.loadCache(),
    ]);
    const hosts = orderHosts(inputs).map((input) =>
      hostFromCache(
        input,
        cache[input.id] ?? null,
        input.kind === "local" ? localOutcome(local)?.status : undefined,
      ),
    );
    return { hosts, refreshedAt: "" };
  }

  return { refresh, cached };
}
