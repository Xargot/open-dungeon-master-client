import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent, type OpenDialogOptions, type SaveDialogOptions } from "electron";
import type {
  ServerProbe,
  AiSetup,
  ConnectResult,
  HarnessCard,
  HarnessStatusResult,
  LocalStatus,
  Result,
  ServerSummary,
  ShellShareStatus,
  TunnelStatus,
} from "../shared/types";
import {
  CODE_SHAPE,
  normalizeOrigin,
  originCandidates,
  parseLinkOrAddress,
  codeCandidates,
  parseRoomCode,
  insecureRemoteOrigin,
  trustedTunnelOrigin,
  type JoinLink,
} from "../shared/deep-link";
import { NO_SAVED_AI, harnessPatch, openAiPatch, savedAiFrom } from "../shared/ai-setup";
import {
  STEAM_KEYBOARD_CLOSE,
  parseDeckChoice,
  steamKeyboardUrl,
  withDeckChoice,
  type DeckInfo,
  type FieldRect,
} from "../shared/deck";
import { speechStatusFrom } from "../shared/speech";
import { coverRequestUrl, type HostInput } from "../shared/home-feed-logic";
import { landingPath, safeInnerPath } from "../shared/open-path";
import { createDesktopHomeFeed, fetchCoverImage } from "./home-feed";
import type { LocalAiManager } from "./local-ai/manager";
import { wireImageAi, wireTextAi } from "./local-ai/wiring";
import type { LocalServer } from "./local-server";
import {
  deleteAccount,
  loginForToken,
  getAdminSettings,
  getHarnessStatus,
  patchAdminSettings,
  probeServer,
  registerAccount,
  sessionState,
  speechEngine,
  tokenIsValid,
  type TokenGrant,
  whoAmI,
  worldRequest,
} from "./odm-api";
import { commitWorldImport, discardWorldTransfer, exportFileName, runWorldJob } from "../shared/world-transfer";
import { LOCAL_SERVER_ID, type ServerStore, type StoredServer } from "./servers";
import { dropTables, ownedTableCodes, publishTables, resolveTable } from "./table-registry";
import { refusedAfter } from "../shared/broker";
import { portalEligible } from "../shared/portal-logic";
import { relocateWorld } from "../shared/relocate";
import {
  applyPortalCookies,
  applySessionCookie,
  clearCaches,
  clearPartition,
  partitionFor,
} from "./session-cookies";
import { RESET_PHRASE, diagnosticSummary, redactHome } from "../shared/diagnostics";
import { requestReset, type ResetOutcome } from "./reset";
import type { QuickTunnel } from "./tunnel";
import {
  parseStoryMemory,
  storyMemoryEnv,
  storyMemorySupported,
  type StoryMemoryStatus,
} from "../shared/story-memory";
import type { Updater } from "./updater";
import type { ShellWindow } from "./window";


export interface ShellContext {
  store: ServerStore;
  window: ShellWindow;
  local: LocalServer;
  tunnel: QuickTunnel;
  localAi: LocalAiManager;
  updater: Updater;
  // What src/shared/deck.ts found at start; absent where nobody asked.
  deck?: DeckInfo;
  // Starts the app again once this process is gone (index.ts); the reset
  // leaves this way. Absent in a harness, which has nowhere to go.
  relaunch?: () => void;
  // The reset this start carried out (src/main/reset.ts), if any, so the
  // Troubleshooting card can say where the previous data went.
  reset?: ResetOutcome | null;
}

export interface ShellIpc {
  handleJoinLink(link: JoinLink): Promise<void>;
  // Stops the share tunnel and takes the room codes and publicUrl down
  // with it; awaited on the way out of the app.
  shutdownShare(): Promise<void>;
}

// The largest lore document the shell will fetch for the system viewer.
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

// Everything arriving over IPC is untrusted renderer input: coerce and cap.
function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function fieldOf(value: unknown): FieldRect {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const num = (key: string): number => {
    const n = raw[key];
    return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(n, 16384)) : 0;
  };
  return { x: num("x"), y: num("y"), width: num("width"), height: num("height") };
}

function joinCodeOf(value: unknown): string {
  const code = str(value, 12).trim().toUpperCase();
  return CODE_SHAPE.test(code) ? code : "";
}

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : "Something went wrong." };
}

function summaryOf(entry: StoredServer): ServerSummary {
  return {
    id: entry.id,
    origin: entry.origin,
    name: entry.name,
    username: entry.username,
    lastUsedAt: entry.lastUsedAt,
    hasToken: true,
  };
}

export function registerIpc(ctx: ShellContext): ShellIpc {
  const { store, window: win, local, tunnel, localAi, updater } = ctx;

  // Privileged channels answer the shell's own pages only (audit S8). The
  // view's channels (the way back to the server list, the share dialog)
  // stay on ipcMain itself and check the page's origin where it matters.
  const shellIpc = {
    handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
      ipcMain.handle(channel, (event, ...args) => {
        if (!win.isShellPage(event)) throw new Error("Refused.");
        return listener(event, ...args);
      });
    },
    on(channel: string, listener: Parameters<typeof ipcMain.on>[1]): void {
      ipcMain.on(channel, (event, ...args) => {
        if (win.isShellPage(event)) listener(event, ...args);
      });
    },
  };

  const localHasAccount = (): boolean => store.token(LOCAL_SERVER_ID) !== null;
  const localStatus = (): LocalStatus =>
    local.status(localHasAccount(), store.get(LOCAL_SERVER_ID)?.username ?? "");

  // The "Switch server" entry the game's account menu shows inside the app
  // (src/preload/game.ts): drop the world's view and land on the server list.
  ipcMain.on("shell:show-servers", () => win.showManager());

  // The home screen's campaigns across every host. A world coming up or a
  // tunnel changing state is a reason to look again; the feed itself
  // announces the result as a home-feed event.
  // A world one of the apps hosts answers at a new address every time its
  // host shares it again. Asks the broker's table registry where this world's
  // room codes point now and moves the entry there, but only to an address
  // whose world proves it is the same one (src/shared/relocate.ts).
  const relocate = async (entry: StoredServer): Promise<StoredServer> => {
    const result = await relocateWorld(
      {
        origin: entry.origin,
        instanceId: entry.instanceId ?? "",
        codes: store.tableCodesFor(entry.id),
      },
      {
        probe: (origin) => probeServer(origin).catch(() => null),
        resolveTable,
      },
    );
    if (!result.found || !result.moved) return entry;
    return store.rebindOrigin(entry.id, result.origin) ?? entry;
  };

  // The home screen's half of the same idea. A host that has gone quiet is
  // looked for before it is drawn as offline, because an offline tile is not
  // tappable: without this the player never reaches the connect path above.
  const relocateHost = async (input: HostInput): Promise<string> => {
    if (input.kind === "local" || input.id === LOCAL_SERVER_ID) return "";
    const entry = store.get(input.id);
    if (!entry) return "";
    const moved = await relocate(entry);
    return moved.origin === input.origin ? "" : moved.origin;
  };

  const homeFeed = createDesktopHomeFeed({
    store,
    localStatus,
    emit: (event) => win.sendEvent(event),
    relocate: relocateHost,
  });
  const refreshHomeFeed = (): void => {
    homeFeed.refresh().catch(() => undefined);
  };
  shellIpc.handle("home:feed", () => homeFeed.refresh());
  shellIpc.handle("home:feed-cached", () => homeFeed.cached());
  // A cover for the home screen, fetched with the host's own session and
  // only from that host (the renderer names the host; the url must belong
  // to it). "" for anything that cannot be had right now.
  // The native game screens' way onto a host's API: its address and the
  // live token. The token leaves the store only for the shell's own page.
  shellIpc.handle("host:session", (_event, hostId: unknown) => {
    const id = str(hostId, 64);
    const origin = id === LOCAL_SERVER_ID ? localStatus().origin : (store.get(id)?.origin ?? "");
    const token = id ? store.token(id) : null;
    return origin && token ? { origin, token } : null;
  });
  // A host document the game screens ask to open (a lore entry's PDF): the
  // shell fetches it with the session of the host on screen and hands it to
  // the system viewer. The page cannot do it itself: a link would open the
  // system browser without the session, and the screens' own origin has no
  // such file. Only a PDF the host stores for its players, size-capped.
  const mountedHosts = new Map<number, string>();
  shellIpc.on("game:mounted", (event, hostId: unknown) => {
    mountedHosts.set(event.sender.id, str(hostId, 64));
  });
  shellIpc.handle("doc:open", async (event, docPath: unknown) => {
    const target = str(docPath, 300);
    if (!/^\/(uploads|generated)\/[A-Za-z0-9._/-]+\.pdf$/.test(target) || target.includes("..")) return false;
    const id = mountedHosts.get(event.sender.id) ?? "";
    const origin = id === LOCAL_SERVER_ID ? localStatus().origin : (store.get(id)?.origin ?? "");
    const token = id ? store.token(id) : null;
    if (!origin || !token) return false;
    try {
      const response = await fetch(`${origin}${target}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
      });
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (!response.ok || declared > MAX_DOCUMENT_BYTES) return false;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_DOCUMENT_BYTES || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return false;
      const dir = path.join(app.getPath("temp"), "odm-documents");
      await fs.promises.mkdir(dir, { recursive: true });
      const file = path.join(dir, path.basename(target));
      await fs.promises.writeFile(file, bytes);
      return (await shell.openPath(file)) === "";
    } catch {
      return false;
    }
  });
  shellIpc.handle("home:cover", async (_event, hostId: unknown, url: unknown) => {
    const id = str(hostId, 64);
    const origin = id === LOCAL_SERVER_ID ? localStatus().origin : (store.get(id)?.origin ?? "");
    const target = coverRequestUrl(origin, str(url, 700));
    const token = id ? store.token(id) : null;
    if (!target || !token) return "";
    return fetchCoverImage(target, token);
  });

  local.onStatus(() => {
    win.sendEvent({ kind: "local-status", status: localStatus() });
    // The lobby's invite dialog shows the Wi-Fi address, which comes and
    // goes with the server's binding.
    if (localPageShowing()) win.sendToGame("odm:share-status", shellShareStatus());
    refreshHomeFeed();
  });
  tunnel.onStatus(() => {
    const status = tunnel.status();
    win.sendEvent({ kind: "tunnel-status", status });
    if (localPageShowing()) win.sendToGame("odm:share-status", shellShareStatus());
    refreshHomeFeed();
    // A tunnel that died on its own (cloudflared exited, the broker's day
    // ran out) must take the codes and the publicUrl down with it, or a
    // friend keeps being sent to an address nothing answers at.
    if (status.state === "error" || status.state === "stopped") void syncPublicUrl();
  });
  localAi.onStatus(() => win.sendEvent({ kind: "local-ai-progress", status: localAi.status() }));
  updater.onStatus(() => win.sendEvent({ kind: "update-progress", progress: updater.progress() }));

  // Keeps the local server's publicUrl matching reality, so invite links and
  // QR codes generated inside the game point at the tunnel while one runs
  // (the host plays on 127.0.0.1, an address guests cannot reach) and go
  // back to normal when it stops. Best effort: links, not correctness.
  // Whenever the world's public address changes, so does where its room
  // codes point. Both the app's own Share button and the game's invite
  // dialog land here, which is why the registry is driven from this one
  // place rather than from either button.
  // The codes last published are kept in the store, not in memory, so a
  // crash or a quit can still take them offline on the next start.
  // Codes the registry is refusing from this shell (another device holds
  // them), reported to the lobby with the share status.
  let refusedCodes: string[] = [];
  const setRefusedCodes = (next: string[]): void => {
    const changed = next.join() !== refusedCodes.join();
    refusedCodes = next;
    if (changed && localPageShowing()) win.sendToGame("odm:share-status", shellShareStatus());
  };
  const syncPublicUrl = async (): Promise<void> => {
    const token = store.token(LOCAL_SERVER_ID);
    if (!token || !local.origin) return;
    const status = tunnel.status();
    const live = status.state === "running" ? status.url : "";
    // Without a tunnel, the Wi-Fi address while sharing on it: invite links
    // and QR codes made inside the game then point where a friend at the
    // table can reach. The table registry only learns public addresses.
    await patchAdminSettings(local.origin, token, { publicUrl: live || local.lanOrigin }).catch(() => undefined);
    if (live) {
      const codes = await ownedTableCodes(local.origin, token);
      const { published, refused } = await publishTables({
        codes,
        url: live,
        secretFor: (code) => store.tableSecret(code),
      });
      setRefusedCodes(refusedAfter(refusedCodes, { codes, published, refused }));
      // A code refused by the registry (claimed from another device) stays
      // in the list so it is at least dropped with the rest later.
      const before = store.publishedCodes();
      store.setPublishedCodes([...new Set([...published, ...before])]);
      return;
    }
    setRefusedCodes([]);
    const stale = store.publishedCodes();
    store.setPublishedCodes([]);
    if (stale.length > 0) {
      await dropTables({ codes: stale, secretFor: (code) => store.tableSecret(code) });
    }
  };
  // Sharing is not a moment but a span: a campaign opened while shared gets
  // its code published too, and the registry's claim is refreshed, by
  // running the publish half again every so often for as long as the
  // tunnel is up.
  const REPUBLISH_MS = 60_000;
  setInterval(() => {
    if (tunnel.status().state === "running") void syncPublicUrl();
  }, REPUBLISH_MS).unref();
  // Stopping the share on the way out: the tunnel first, then the codes
  // and the server's publicUrl. index.ts awaits this before quitting.
  const shutdownShare = async (): Promise<void> => {
    await tunnel.stop().catch(() => undefined);
    await syncPublicUrl().catch(() => undefined);
  };

  // Local worlds always run mesh voice: no media port to open, and it is the
  // only transport that survives a tunnel. Idempotent and best effort.
  const ensureLocalVoice = async (): Promise<void> => {
    const token = store.token(LOCAL_SERVER_ID);
    if (!token || !local.origin) return;
    await patchAdminSettings(local.origin, token, {
      voiceChat: { enabled: "on", mode: "mesh" },
    }).catch(() => undefined);
  };

  // Portal mode: the bundled server serves the screens and forwards data
  // calls to the host. Only when the player has it on, this build carries
  // a server, and the host is new enough for this UI; otherwise, or when
  // the local server will not start, the host's own pages open as before.
  const attachThroughPortal = async (
    entry: StoredServer,
    token: string,
    probe: ServerProbe | null,
    pathname: string,
  ): Promise<boolean> => {
    if (!store.portal() || localStatus().state === "unavailable") return false;
    const verdict = portalEligible({
      bundled: localStatus().serverVersion,
      remote: probe?.version ?? "",
    });
    if (!verdict.ok) return false;
    try {
      await local.start();
    } catch {
      return false;
    }
    const origin = local.origin;
    if (!origin) return false;
    const partition = partitionFor(entry.id);
    await applyPortalCookies(
      partition,
      origin,
      entry.origin,
      token,
      entry.tokenExpiresAt,
      local.portalSignature(entry.origin, token),
    );
    win.attachView(origin, partition, pathname, entry.origin);
    return true;
  };

  const attachRemote = async (
    entry: StoredServer,
    token: string,
    joinCode: string,
    path = "",
    known: ServerProbe | null = null,
  ): Promise<void> => {
    store.touch(entry.id);
    if (joinCode) store.rememberJoinCode(entry.id, joinCode);
    // The probe learns the world's stable id (so entries saved before the
    // server exposed one still match a device world back at a new tunnel
    // address) and the version portal mode needs. Best effort either way.
    const probe = known ?? (await probeServer(entry.origin).catch(() => null));
    if (probe) store.setInstanceId(entry.id, probe.instanceId);
    const pathname = landingPath(joinCode, path);
    if (await attachThroughPortal(entry, token, probe, pathname)) return;
    await applySessionCookie(partitionFor(entry.id), entry.origin, token, entry.tokenExpiresAt);
    win.attachView(entry.origin, partitionFor(entry.id), pathname);
  };

  shellIpc.handle("prefs:credentials", () => store.credentialStorage());
  shellIpc.handle("prefs:set-keep-sign-ins", (_event, keep: unknown) => {
    store.setKeepSignIns(keep !== false);
  });
  shellIpc.handle("prefs:portal", () => store.portal());
  shellIpc.handle("prefs:set-portal", (_event, on: unknown) => {
    store.setPortal(on !== false);
  });

  // Story memory (src/shared/story-memory.ts). Saving never restarts the
  // world by itself: only the shell screen knows whether a table is open in
  // it, so it decides when to apply. Pending means the running server still
  // uses the previous model.
  const storyMemoryStatus = (): StoryMemoryStatus => {
    const choice = store.storyMemory();
    const wanted = storyMemoryEnv(choice).EMBEDDING_MODEL;
    return {
      choice,
      pendingRestart: local.running && (local.runningEnv().EMBEDDING_MODEL ?? "") !== wanted,
      worldInUse: win.isPortalView() || localPageShowing() || tunnel.status().state === "running",
    };
  };
  const storyMemoryHere = storyMemorySupported(process.platform, process.arch);
  shellIpc.handle("prefs:story-memory", () => (storyMemoryHere ? storyMemoryStatus() : null));
  shellIpc.handle("prefs:set-story-memory", (_event, raw: unknown) => {
    if (storyMemoryHere) store.setStoryMemory(parseStoryMemory(raw));
    return storyMemoryStatus();
  });
  shellIpc.handle("prefs:apply-story-memory", async () => {
    try {
      if (storyMemoryHere && storyMemoryStatus().pendingRestart) await local.restart();
      return { ok: true, status: storyMemoryStatus() };
    } catch (err) {
      return fail(err);
    }
  });

  const connectRemote = async (
    id: string,
    joinCode: string,
    path = "",
  ): Promise<ConnectResult> => {
    const saved = store.get(id);
    if (!saved || saved.id === LOCAL_SERVER_ID) {
      return { ok: false, needsLogin: false, error: "Unknown server." };
    }
    let entry = saved;
    const notOnline = (): ConnectResult => ({
      ok: false,
      needsLogin: false,
      error: `${entry.name} is not online right now. Ask the host to share their world, then try again.`,
    });
    // Who answers at the address on file, before anything secret is sent
    // there. A tunnel hostname is handed out per session and can later
    // belong to somebody else's world, and a world one of the apps hosts
    // answers at a new address every time it is shared again. Only a world
    // that proves it is the one this entry belongs to gets the session.
    let probe = await probeServer(entry.origin).catch(() => null);
    const strangerOnFile =
      probe !== null && !!entry.instanceId && probe.instanceId !== entry.instanceId;
    if (!probe || strangerOnFile) {
      // Nothing there, or the wrong world: ask the registry where this
      // world's room codes point today (src/shared/relocate.ts). Without
      // this a player returning to a world that had been shared again was
      // told to sign in, and on a device world the only door that screen
      // offered was a new account: a second character and no way back.
      const moved = await relocate(entry);
      if (moved.origin === entry.origin) return notOnline();
      entry = moved;
      probe = await probeServer(entry.origin).catch(() => null);
      if (!probe) return notOnline();
    }
    let token = store.token(id);
    let session = token ? await sessionState(entry.origin, token) : "rejected";
    if (session === "unreachable") return notOnline();
    if (session === "rejected") {
      // An account the app made up a password for (joined by room code)
      // must never be asked for it: nobody was ever told what it is. Renew
      // the session with the stored one instead, and only fall back to the
      // sign-in form for accounts a person chose a password for.
      const secret = store.secret(id);
      token = null;
      if (secret) {
        try {
          const grant = await loginForToken(entry.origin, entry.username, secret);
          store.upsert({
            id: entry.id,
            origin: entry.origin,
            name: entry.name,
            username: grant.username,
            token: grant.token,
            tokenExpiresAt: grant.expiresAt,
          });
          token = grant.token;
          session = "ok";
        } catch {
          // The password no longer works (changed, or the account is gone).
        }
      }
    }
    if (!token) {
      return {
        ok: false,
        needsLogin: true,
        error: probe.deviceWorld
          ? "Your seat at this world could not be reopened. Join again with a name, and ask the host to remove the old one."
          : "Your session expired. Sign in again.",
      };
    }
    await attachRemote(entry, token, joinCode, path, probe);
    return { ok: true };
  };

  // Shared tail of login and register: remember the server, hand the session
  // to the web UI's partition, and show it.
  const adoptGrant = async (
    origin: string,
    grant: TokenGrant,
    joinCode: string,
    // Set when the app made the password up itself (joining by room code).
    // Kept like the device world's own profile so the session can be
    // renewed later without asking for something nobody was ever told.
    secret?: string,
  ): Promise<Result<{ server: ServerSummary }>> => {
    let name = "";
    let instanceId = "";
    try {
      const probe = await probeServer(origin);
      name = probe.serverName;
      instanceId = probe.instanceId;
    } catch {
      // The name is cosmetic; the login already proved the server is real.
    }
    const entry = store.upsert({
      origin,
      name: name || new URL(origin).host,
      username: grant.username,
      token: grant.token,
      tokenExpiresAt: grant.expiresAt,
      instanceId,
      ...(secret ? { secret } : {}),
    });
    await attachRemote(entry, grant.token, joinCode);
    return { ok: true, server: summaryOf(entry) };
  };

  const handleJoinLink = async (link: JoinLink): Promise<void> => {
    win.focus();
    let known = store.findByOrigin(link.origin);
    if (!known) {
      // A device world gets a fresh tunnel hostname every share session. If
      // the server at the new address identifies as a world this shell
      // already has an account on, move that entry to the new address and
      // walk in with the stored token instead of asking for a second login.
      // The world's id is public, so the address itself has to be one a
      // stranger could not have chosen (a tunnel hostname), or one the
      // registry confirms the code points at; a crafted link naming any
      // other origin gets the add screen, never the saved session.
      try {
        const probe = await probeServer(link.origin);
        const match = store.findByInstanceId(probe.instanceId);
        // Never from https to plain http on the open internet.
        if (match && !(match.origin.startsWith("https:") && insecureRemoteOrigin(link.origin))) {
          const trusted =
            trustedTunnelOrigin(link.origin) ||
            (!!link.code && (await resolveTable(link.code)) === link.origin);
          if (trusted) known = store.rebindOrigin(match.id, link.origin);
        }
      } catch {
        // Unreachable or not an ODM server; the add screen will say so.
      }
    }
    if (known) {
      const result = await connectRemote(known.id, link.code);
      if (result.ok) return;
    }
    win.showManager();
    win.sendEvent({
      kind: "join-request",
      origin: link.origin,
      code: link.code,
      knownServerId: known?.id ?? "",
    });
  };

  // Paste-an-invite support: the same links QR codes carry, or a server's
  // bare address (its own corner QR), typed or pasted into the Add a server
  // screen, behave exactly like a clicked deep link or a scan: a server the
  // shell already has opens with its saved session rather than being added
  // a second time.
  shellIpc.handle("servers:open-invite", async (_event, raw: unknown) => {
    const text = str(raw, 700);
    // A room code is a campaign's own code and names no address, so the
    // registry is asked where that table is right now. This is the whole
    // point of one code: the answer changes with every share session, the
    // code does not.
    const bare = codeCandidates(text);
    if (bare.table || bare.hostOrigin) {
      // The registry first: a table's code is the one a host reads out, and
      // it is the only one that survives a new tunnel. The host shape is
      // the fallback, since the two overlap and shape alone cannot tell
      // them apart.
      // The registry is cleared best effort when a host stops sharing, so an
      // answer is a lead, not a promise: the address is probed before the
      // player is sent there, and a dead one reads as "not online" rather
      // than as a sign-in that fails with the hostname blamed.
      const found = bare.table ? await resolveTable(bare.table) : "";
      if (found && (await probeServer(found).catch(() => null))) {
        await handleJoinLink({ origin: found, code: bare.table });
        return true;
      }
      if (bare.hostOrigin) {
        try {
          await probeServer(bare.hostOrigin);
        } catch {
          return false;
        }
        await handleJoinLink({ origin: bare.hostOrigin, code: "" });
        return true;
      }
      return false;
    }
    const link = parseLinkOrAddress(text);
    if (!link) return false;
    // A room code carries no address of its own: it names the broker
    // hostname it expands to. A code that is stale or mistyped therefore
    // points at a world that is not there, so it is probed before the
    // player is sent anywhere; false sends them back to the add screen,
    // which says so in the field rather than at a sign-in for nothing.
    if (parseRoomCode(text) && !store.findByOrigin(link.origin)) {
      try {
        await probeServer(link.origin);
      } catch {
        return false;
      }
    }
    await handleJoinLink(link);
    return true;
  });

  shellIpc.handle("servers:list", () => ({
    servers: store.summaries(),
    local: localStatus(),
    tunnel: tunnel.status(),
  }));

  // Sharing the local world on the internet: reachable from the home
  // screen's hero and from the game's own lobby (the invite dialog starts
  // it, since inviting people is the moment it matters).
  const startSharing = async (): Promise<Result<{ tunnel: TunnelStatus }>> => {
    try {
      await local.start();
      const port = Number(new URL(local.origin).port);
      const status = await tunnel.start(port);
      if (status.state !== "running") {
        return fail(new Error(status.error || "Sharing failed."));
      }
      await syncPublicUrl();
      // Older local worlds predate mesh voice; sharing is the moment it
      // matters, so heal the setting here too.
      await ensureLocalVoice();
      // Sharing does not change who may sign up. A world this app hosts is
      // never gated (server 0.16.7 resolves its signup mode as open): the
      // room code the host reads out and an address that dies with the
      // session are the door. Flipping it to invite-only here is what met
      // invited players with "this server needs an invite code" moments
      // after they had typed one.
      return { ok: true, tunnel: status };
    } catch (err) {
      return fail(err);
    }
  };

  shellIpc.handle("share:start", () => startSharing());

  shellIpc.handle("share:stop", async () => {
    await tunnel.stop();
    await syncPublicUrl();
    return { ok: true, tunnel: tunnel.status() };
  });

  // Sharing on this Wi-Fi only: the world answers on every interface and an
  // in-person table plays with no internet. Nothing is published anywhere;
  // the address is one friends type or scan at the table.
  const setLanSharing = async (on: boolean): Promise<Result<{ status: LocalStatus }>> => {
    try {
      if (on) await local.start();
      await local.setLanSharing(on);
      if (on && !local.lanOrigin) {
        await local.setLanSharing(false);
        return fail(new Error("This computer is not on a network right now."));
      }
      await syncPublicUrl();
      if (on) await ensureLocalVoice();
      return { ok: true, status: localStatus() };
    } catch (err) {
      return fail(err);
    }
  };
  shellIpc.handle("share:lan-start", () => setLanSharing(true));
  shellIpc.handle("share:lan-stop", () => setLanSharing(false));

  // The same switch for the game page's preload (src/preload/game.ts), only
  // honored while the page on top is the local world itself: a remote
  // server's page gets "unsupported" and draws nothing.
  const SHARE_UNSUPPORTED: ShellShareStatus = {
    supported: false,
    state: "stopped",
    url: "",
    mode: "",
    error: "",
    lanUrl: "",
  };
  const shellShareStatus = (): ShellShareStatus => ({
    supported: true,
    ...tunnel.status(),
    lanUrl: local.lanOrigin,
    refusedCodes,
  });
  const localPageShowing = (): boolean =>
    !win.isPortalView() && !!local.origin && win.viewOrigin() === local.origin;
  const fromLocalPage = (event: IpcMainInvokeEvent): boolean => {
    if (win.isPortalView()) return false;
    try {
      return !!local.origin && new URL(event.sender.getURL()).origin === local.origin;
    } catch {
      return false;
    }
  };
  ipcMain.handle("shell:share-status", (event) =>
    fromLocalPage(event) ? shellShareStatus() : SHARE_UNSUPPORTED,
  );
  ipcMain.handle("shell:share-start", async (event) => {
    if (!fromLocalPage(event)) return SHARE_UNSUPPORTED;
    const result = await startSharing();
    const status = shellShareStatus();
    return result.ok || status.error ? status : { ...status, state: "error", error: result.error };
  });
  ipcMain.handle("shell:share-stop", async (event) => {
    if (!fromLocalPage(event)) return SHARE_UNSUPPORTED;
    await tunnel.stop();
    await syncPublicUrl();
    return shellShareStatus();
  });

  shellIpc.handle("servers:probe", async (_event, raw: unknown) => {
    let lastError: unknown = null;
    for (const origin of originCandidates(str(raw, 300))) {
      try {
        return { ok: true, probe: await probeServer(origin) };
      } catch (err) {
        lastError = err;
      }
    }
    return fail(lastError ?? new Error("That does not look like a server address."));
  });

  shellIpc.handle("servers:login", async (_event, input: Record<string, unknown>) => {
    try {
      const origin = normalizeOrigin(str(input?.origin, 300));
      if (!origin) return fail(new Error("Bad server address."));
      const grant = await loginForToken(origin, str(input?.username, 24), str(input?.password, 100));
      return await adoptGrant(origin, grant, joinCodeOf(input?.joinCode));
    } catch (err) {
      return fail(err);
    }
  });

  shellIpc.handle("servers:register", async (_event, input: Record<string, unknown>) => {
    try {
      const origin = normalizeOrigin(str(input?.origin, 300));
      if (!origin) return fail(new Error("Bad server address."));
      const joinCode = joinCodeOf(input?.joinCode);
      // Joining by room code asks for a name and nothing else, so the
      // password is the app's business, not the player's.
      const generated = input?.generated === true;
      const password = generated
        ? randomBytes(24).toString("base64url")
        : str(input?.password, 100);
      const grant = await registerAccount(origin, {
        username: str(input?.username, 24),
        password,
        inviteCode: str(input?.inviteCode, 40).trim(),
        joinCode,
        setupCode: str(input?.setupCode, 40).trim(),
      });
      // An account the app made up a password for (joining by room code)
      // keeps that password, the way the device world's own profile does,
      // so the session can be renewed later without asking for something
      // the player was never told.
      return await adoptGrant(
        origin,
        grant,
        joinCode,
        generated ? password : undefined,
      );
    } catch (err) {
      return fail(err);
    }
  });

  // Discord sign-in runs in the window as a throwaway in-memory partition;
  // the harvested session then takes the same road as a password login.
  shellIpc.handle("servers:discord-login", async (_event, input: Record<string, unknown>) => {
    const partition = "odm-login";
    try {
      const origin = normalizeOrigin(str(input?.origin, 300));
      if (!origin) return fail(new Error("Bad server address."));
      const joinCode = joinCodeOf(input?.joinCode);
      // The room code rides in the return path: on an invite-only server it
      // is what vouches for a brand-new Discord account, and the callback
      // reads it from there (src/app/api/auth/discord/callback).
      const next = encodeURIComponent(joinCode ? `/join/${joinCode}` : "/");
      const minted = await win.browserLogin(
        origin,
        partition,
        `/api/auth/discord/start?next=${next}`,
      );
      const me = await whoAmI(origin, minted.token);
      return await adoptGrant(origin, { ...minted, ...me }, joinCode);
    } catch (err) {
      return fail(err);
    } finally {
      await clearPartition(partition).catch(() => undefined);
    }
  });

  shellIpc.handle("servers:connect", (_event, id: unknown, joinCode: unknown, path: unknown) =>
    connectRemote(str(id, 64), joinCodeOf(joinCode), safeInnerPath(path)),
  );

  // The account is gone (or going) on the server side, so the session it
  // minted is dropped here too; the entry stays listed so "Sign in" before
  // the due date can still keep it, and Forget removes it like any other.
  shellIpc.handle("servers:delete-account", async (_event, input: Record<string, unknown>) => {
    const serverId = str(input?.serverId, 64);
    if (!serverId || serverId === LOCAL_SERVER_ID) return fail(new Error("Unknown server."));
    const entry = store.get(serverId);
    const token = store.token(serverId);
    if (!entry || !token) {
      return fail(new Error("Sign in to this server first, then delete the account."));
    }
    try {
      const deletion = await deleteAccount(entry.origin, token, str(input?.password, 100));
      store.clearToken(serverId);
      await clearPartition(partitionFor(serverId)).catch(() => undefined);
      return { ok: true, deletion };
    } catch (err) {
      return fail(err);
    }
  });

  shellIpc.handle("servers:remove", async (_event, id: unknown) => {
    const serverId = str(id, 64);
    if (!serverId || serverId === LOCAL_SERVER_ID) return;
    store.remove(serverId);
    await clearPartition(partitionFor(serverId));
  });

  shellIpc.handle("local:start", async () => {
    try {
      await local.start();
      return { ok: true, status: localStatus() };
    } catch (err) {
      return fail(err);
    }
  });

  const adoptLocalGrant = (grant: TokenGrant, secret?: string): void => {
    store.upsert({
      id: LOCAL_SERVER_ID,
      origin: "local",
      name: "This computer",
      username: grant.username,
      token: grant.token,
      tokenExpiresAt: grant.expiresAt,
      secret,
    });
  };

  // The OS username makes a friendly default profile name; the server only
  // accepts letters, digits, _ and - at 3 to 24 characters.
  const localProfileName = (): string => {
    const name = os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
    return name.length >= 3 ? name : "player";
  };

  // A local profile should feel like no account at all: on a fresh world the
  // shell registers the owner itself with a random password it keeps (so an
  // expired token re-logs silently), and the player never sees a form.
  const provisionLocalProfile = async (): Promise<TokenGrant> => {
    const secret = randomBytes(24).toString("base64url");
    const grant = await registerAccount(local.origin, {
      username: localProfileName(),
      password: secret,
      inviteCode: "",
      setupCode: local.setupCode,
    });
    adoptLocalGrant(grant, secret);
    await ensureLocalVoice();
    return grant;
  };

  shellIpc.handle("local:create-account", async (_event, input: Record<string, unknown>) => {
    try {
      await local.start();
      const grant = await registerAccount(local.origin, {
        username: str(input?.username, 24),
        password: str(input?.password, 100),
        inviteCode: "",
        setupCode: local.setupCode,
      });
      adoptLocalGrant(grant);
      await ensureLocalVoice();
      return { ok: true, status: localStatus() };
    } catch (err) {
      return fail(err);
    }
  });

  shellIpc.handle("local:login", async (_event, input: Record<string, unknown>) => {
    try {
      await local.start();
      const grant = await loginForToken(
        local.origin,
        str(input?.username, 24),
        str(input?.password, 100),
      );
      adoptLocalGrant(grant);
      return { ok: true, status: localStatus() };
    } catch (err) {
      return fail(err);
    }
  });

  shellIpc.handle("local:configure-ai", async (_event, setup: AiSetup) => {
    try {
      const token = store.token(LOCAL_SERVER_ID);
      if (!token || !local.origin) return fail(new Error("Set up the local account first."));
      if (setup?.choice === "human") {
        // Recorded positively so the game's capability checks can say "this
        // world has a human storyteller" instead of failing against the
        // default local backend that nothing listens on.
        await patchAdminSettings(local.origin, token, { text: { provider: "none" } });
        return { ok: true };
      }
      if (setup?.choice === "harness") {
        // The program must be one the device's own server can start; its
        // status list is the only authority on that.
        const built = harnessPatch(setup);
        if ("error" in built) return fail(new Error(built.error));
        await patchAdminSettings(local.origin, token, built.patch);
        return { ok: true };
      }
      if (setup?.choice !== "openai") return { ok: true };
      const saved = savedAiFrom(await getAdminSettings(local.origin, token).catch(() => null));
      const built = openAiPatch(
        {
          choice: "openai",
          apiKey: str(setup.apiKey, 400),
          model: str(setup.model, 200),
          utilityModel: str(setup.utilityModel, 200),
          fast: setup.fast === true,
        },
        saved,
      );
      if ("error" in built) return fail(new Error(built.error));
      await patchAdminSettings(local.origin, token, built.patch);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });

  // The agent programs this computer has, as the device world's server sees
  // them (it is the server that will start them, with the PATH and sandbox it
  // actually has, so the shell does no looking of its own). Starts the world
  // if it is not running yet.
  shellIpc.handle("local:harness-status", async (_event, refresh: unknown): Promise<HarnessStatusResult> => {
    try {
      if (!local.origin) await local.start();
      const token = store.token(LOCAL_SERVER_ID);
      if (!token || !local.origin) return { ok: false, error: "Set up the local account first." };
      const body = (await getHarnessStatus(local.origin, token, refresh === true)) as {
        statuses?: HarnessCard[];
        config?: { id?: string; model?: string; utilityModel?: string; speed?: string };
      };
      return {
        ok: true,
        statuses: Array.isArray(body.statuses) ? body.statuses : [],
        current: {
          id: body.config?.id ?? "",
          model: body.config?.model ?? "",
          utilityModel: body.config?.utilityModel ?? "",
          fast: body.config?.speed === "fast",
        },
      };
    } catch (err) {
      return fail(err);
    }
  });

  // Speech-to-text for dictation in the device world: the server's built-in
  // Whisper, downloaded on request. Starts the world if it is not running,
  // as the harness status does; the server does the download and reports
  // its progress on each status read.
  const speech = async (install: boolean) => {
    try {
      if (!local.origin) await local.start();
      const token = store.token(LOCAL_SERVER_ID);
      if (!token || !local.origin) return fail(new Error("Set up the local account first."));
      return { ok: true as const, speech: speechStatusFrom(await speechEngine(local.origin, token, install)) };
    } catch (err) {
      return fail(err);
    }
  };
  shellIpc.handle("local:speech-status", () => speech(false));
  shellIpc.handle("local:speech-install", () => speech(true));

  // Moving the device world (src/shared/world-transfer.ts). The world's own
  // server packs and checks the archive in its world-transfer folder; the
  // shell only moves the file between there and where the person keeps it.
  // The world awake and a live session for its owner: the stored token, or
  // a fresh one from the profile password the app keeps.
  // A world nobody has entered yet gets its owner profile first, as
  // local:play makes it, so a new computer can take in a world straight
  // away; the import replaces it anyway.
  const localSession = async (): Promise<string> => {
    const fresh = local.status(localHasAccount()).firstRun;
    await local.start();
    const token = store.token(LOCAL_SERVER_ID);
    if (token && (await tokenIsValid(local.origin, token))) return token;
    const entry = store.get(LOCAL_SERVER_ID);
    const secret = store.secret(LOCAL_SERVER_ID);
    if (!entry && fresh) return (await provisionLocalProfile()).token;
    if (!entry || !secret) throw new Error("Enter your world from the home screen first, then try again.");
    const grant = await loginForToken(local.origin, entry.username, secret);
    adoptLocalGrant(grant, secret);
    return grant.token;
  };
  const transferPhase = (phase: string) => win.sendEvent({ kind: "world-transfer", phase });
  const saveDialog = (options: SaveDialogOptions) => {
    const parent = win.dialogParent();
    return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
  };
  const openDialog = (options: OpenDialogOptions) => {
    const parent = win.dialogParent();
    return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
  };
  const ARCHIVE_FILTERS = [
    { name: "World archive", extensions: ["gz"] },
    { name: "All files", extensions: ["*"] },
  ];
  // The checked archive waiting for the person's yes.
  let pendingImport = "";

  shellIpc.handle("local:export-world", async () => {
    try {
      const token = await localSession();
      const request = worldRequest(local.origin, token);
      const job = await runWorldJob(request, { action: "export" }, transferPhase);
      if (!job.export) throw new Error("The world was packed, but the file is missing.");
      const choice = await saveDialog({
        title: "Save your world",
        defaultPath: path.join(app.getPath("documents"), exportFileName(job.export)),
        filters: ARCHIVE_FILTERS,
      });
      if (choice.canceled || !choice.filePath) {
        await discardWorldTransfer(request);
        return { ok: true, saved: false, file: "", bytes: 0 };
      }
      transferPhase("Saving");
      await fs.promises.copyFile(path.join(local.transferDir, job.export.name), choice.filePath);
      await discardWorldTransfer(request);
      return { ok: true, saved: true, file: choice.filePath, bytes: job.export.bytes };
    } catch (err) {
      return fail(err);
    }
  });

  shellIpc.handle("local:import-pick", async () => {
    try {
      const choice = await openDialog({ title: "Import a world", properties: ["openFile"], filters: ARCHIVE_FILTERS });
      if (choice.canceled || !choice.filePaths[0]) return { ok: true, preview: null };
      const token = await localSession();
      const request = worldRequest(local.origin, token);
      await discardWorldTransfer(request);
      pendingImport = "";
      const name = `import-${randomBytes(8).toString("hex")}.tar.gz`;
      await fs.promises.mkdir(local.transferDir, { recursive: true });
      transferPhase("Copying the file");
      await fs.promises.copyFile(choice.filePaths[0], path.join(local.transferDir, name));
      try {
        const job = await runWorldJob(request, { action: "check", name }, transferPhase);
        pendingImport = name;
        return { ok: true, preview: job.preview };
      } catch (err) {
        await discardWorldTransfer(request);
        throw err;
      }
    } catch (err) {
      return fail(err);
    }
  });

  // Swaps the checked world in, then restarts it and signs its owner in
  // with a password the app makes and keeps, the way a new world's profile
  // is made: the archive never carries one.
  shellIpc.handle("local:import-commit", async () => {
    try {
      if (!pendingImport) throw new Error("Pick a world file first.");
      const secret = randomBytes(24).toString("base64url");
      const token = await localSession();
      transferPhase("Swapping your world in");
      const { owner } = await commitWorldImport(worldRequest(local.origin, token), pendingImport, secret);
      pendingImport = "";
      transferPhase("Restarting your world");
      await local.restart();
      // The pages of the world it replaced (their session, their storage)
      // belong to that world.
      await clearPartition(partitionFor(LOCAL_SERVER_ID));
      adoptLocalGrant(await loginForToken(local.origin, owner, secret), secret);
      win.sendEvent({ kind: "local-status", status: localStatus() });
      return { ok: true, owner };
    } catch (err) {
      return fail(err);
    }
  });

  shellIpc.handle("local:import-cancel", async () => {
    pendingImport = "";
    const token = store.token(LOCAL_SERVER_ID);
    if (token && local.origin) await discardWorldTransfer(worldRequest(local.origin, token));
  });

  // What the OpenAI form shows as already saved on this device. Never
  // throws: a world that is not up yet simply has nothing saved to show.
  shellIpc.handle("local:ai-saved", async () => {
    const token = store.token(LOCAL_SERVER_ID);
    if (!token || !local.origin) return NO_SAVED_AI;
    return savedAiFrom(await getAdminSettings(local.origin, token).catch(() => null));
  });

  shellIpc.handle("local:play", async (_event, joinCode: unknown, path: unknown): Promise<ConnectResult> => {
    // Read before start(): booting the server creates the database, which is
    // the "has this world ever existed" signal.
    const freshWorld = local.status(localHasAccount()).firstRun;
    try {
      await local.start();
    } catch (err) {
      return { ok: false, needsLogin: false, error: fail(err).error };
    }
    // A crash while sharing can leave a stale publicUrl behind; heal it.
    void syncPublicUrl();
    // Whatever local AI is installed warms up in the background. The first
    // AI turn or image simply waits for the load if the player beats it.
    void localAi.start();
    void localAi.startComfy();
    let token = store.token(LOCAL_SERVER_ID);
    if (token && !(await tokenIsValid(local.origin, token))) token = null;
    if (!token) {
      const entry = store.get(LOCAL_SERVER_ID);
      const secret = store.secret(LOCAL_SERVER_ID);
      if (entry && secret) {
        // The session token expired; the stored profile password signs back
        // in without bothering the player.
        try {
          const grant = await loginForToken(local.origin, entry.username, secret);
          adoptLocalGrant(grant);
          token = grant.token;
        } catch {
          // Password rejected (changed inside the game?); fall through.
        }
      }
      if (!token && freshWorld) {
        try {
          await provisionLocalProfile();
        } catch (err) {
          return { ok: false, needsLogin: false, error: fail(err).error };
        }
        // Do not attach yet: the renderer offers the one-time AI choice
        // first, then calls back in to play.
        return { ok: true, firstSetup: true };
      }
      if (!token) {
        return { ok: false, needsLogin: true, error: "Sign in to your local account." };
      }
    }
    const entry = store.get(LOCAL_SERVER_ID);
    if (!entry) {
      return { ok: false, needsLogin: true, error: "Sign in to your local account." };
    }
    await applySessionCookie(
      partitionFor(LOCAL_SERVER_ID),
      local.origin,
      token,
      entry.tokenExpiresAt,
    );
    win.attachView(
      local.origin,
      partitionFor(LOCAL_SERVER_ID),
      landingPath(joinCodeOf(joinCode), safeInnerPath(path)),
    );
    return { ok: true };
  });

  shellIpc.handle("local-ai:status", () => localAi.status());

  // The Steam Deck layout: the switch saves the choice and redraws at once;
  // the window itself (full screen in Game Mode) follows on the next start.
  let deck = ctx.deck;
  shellIpc.handle("app:info", () => ({
    version: app.getVersion(),
    installKind: updater.kind,
    update: updater.lastFound(),
    deck,
    reset: ctx.reset ? { aside: redactHome(ctx.reset.aside, os.homedir()), left: ctx.reset.left } : null,
  }));
  shellIpc.handle("deck:set-choice", (_event, raw: unknown) => {
    if (!deck) return undefined;
    const choice = parseDeckChoice(raw);
    store.setDeckChoice(choice);
    deck = withDeckChoice(deck, choice);
    return deck;
  });
  // Steam's keyboard comes and goes through its own deep links, the way SDL
  // asks for it on a Deck. Off Steam there is nobody to answer them, and
  // opening one would start Steam, so nothing is sent.
  shellIpc.handle("deck:keyboard", async (_event, open: unknown, field: unknown, multiline: unknown) => {
    if (!deck?.steam) return;
    const url =
      open === true ? steamKeyboardUrl(win.screenRect(fieldOf(field)), multiline === true) : STEAM_KEYBOARD_CLOSE;
    await shell.openExternal(url).catch(() => undefined);
  });

  // The screens' theme (docs/vtt-parity-implementation-plan.md 18.2, phase
  // 29): the OS frame follows the parchment or the night.
  shellIpc.handle("theme:set", (_event, mode: unknown) => {
    nativeTheme.themeSource = mode === "light" ? "light" : "dark";
  });
  // The table view on a second display (phase 28).
  shellIpc.handle("table:open", (_event, hostId: unknown, campaignId: unknown) =>
    win.openTableScreen(String(hostId ?? ""), String(campaignId ?? "")),
  );

  shellIpc.handle("update:check", async () => {
    try {
      return { ok: true, update: await updater.checkForUpdates() };
    } catch (err) {
      return fail(err);
    }
  });

  shellIpc.handle("update:install", async () => {
    try {
      await updater.downloadAndInstall();
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });

  // Troubleshooting (Settings): the server files the device world runs
  // from, checked against the ones this build shipped (every byte) and
  // unpacked again with everything the player made kept; the files cached
  // from servers, cleared with sign-ins and storage left alone; a summary
  // for a bug report (src/shared/diagnostics.ts); the folder the logs are
  // in. None of it touches the world's database, its key or its packs.
  shellIpc.handle("local:verify", async () => {
    try {
      return { ok: true, report: await local.verify(true) };
    } catch (err) {
      return fail(err);
    }
  });
  shellIpc.handle("local:repair", async () => {
    try {
      const result = await local.repair();
      win.sendEvent({ kind: "local-status", status: localStatus() });
      return { ok: true, ...result };
    } catch (err) {
      return fail(err);
    }
  });
  shellIpc.handle("caches:clear", async () => {
    try {
      const partitions = [partitionFor(LOCAL_SERVER_ID), ...store.list().map((entry) => partitionFor(entry.id))];
      return { ok: true, sessions: await clearCaches(partitions) };
    } catch (err) {
      return fail(err);
    }
  });
  shellIpc.handle("diag:summary", async () => {
    const world = local.diagnostics();
    const status = localStatus();
    const home = os.homedir();
    const text = diagnosticSummary({
      app: {
        version: app.getVersion(),
        installKind: updater.kind,
        platform: process.platform,
        arch: process.arch,
        os: `${os.type()} ${os.release()}`,
        runtime: `Electron ${process.versions.electron}`,
      },
      payload: world.payload,
      runTree: world.runTree,
      world: {
        state: status.state,
        error: status.error,
        firstRun: status.firstRun,
        dbPresent: world.dbPresent,
        keyPresent: world.keyPresent,
        packs: world.packs,
      },
      servers: store.list().length,
      verify: await local.verify(false).catch(() => null),
      paths: { userData: redactHome(app.getPath("userData"), home), log: redactHome(local.logFile, home) },
    });
    return { text };
  });
  // Starting over (src/main/reset.ts). The typed word guards it; the share,
  // the engines and the world are stopped first so nothing holds the folder,
  // then the marker is written and the app restarts to carry it out.
  shellIpc.handle("app:reset", async (_event, phrase: unknown) => {
    if (str(phrase, 16).trim() !== RESET_PHRASE) return fail(new Error(`Type ${RESET_PHRASE} to confirm.`));
    try {
      await shutdownShare();
      await localAi.stop().catch(() => undefined);
      await local.stop();
      requestReset(app.getPath("userData"));
      if (ctx.relaunch) ctx.relaunch();
      else {
        app.relaunch();
        app.quit();
      }
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });
  shellIpc.handle("diag:show-logs", async () => {
    // The world's log, highlighted; the data folder itself before the
    // world has ever written one.
    if (fs.existsSync(local.logFile)) shell.showItemInFolder(local.logFile);
    else await shell.openPath(app.getPath("userData"));
  });

  shellIpc.handle("local-ai:scan", async () => {
    try {
      const result = await localAi.scan();
      return { ok: true, ...result };
    } catch (err) {
      return fail(err);
    }
  });

  shellIpc.handle("local-ai:install", async (_event, tierId: unknown) => {
    try {
      await localAi.install(str(tierId, 40));
      // Point the local world's AI at the freshly installed aliases;
      // summaries go to the utility model when one fit, else to the story.
      const token = store.token(LOCAL_SERVER_ID);
      const alias = localAi.installedAlias();
      const utility = localAi.installedUtilityAlias() || alias;
      let warning = "";
      if (token && local.origin && alias) {
        warning = await wireTextAi(local.origin, token, alias, utility);
      }
      void localAi.start();
      return { ok: true, status: localAi.status(), warning };
    } catch (err) {
      return fail(err);
    }
  });

  shellIpc.handle("local-ai:install-comfy", async () => {
    try {
      await localAi.installComfy();
      const token = store.token(LOCAL_SERVER_ID);
      let warning = "";
      if (token && local.origin) {
        warning = await wireImageAi(
          local.origin,
          token,
          localAi.comfy.origin(),
          localAi.comfy.checkpointFile(),
        );
      }
      void localAi.startComfy();
      return { ok: true, status: localAi.status(), warning };
    } catch (err) {
      return fail(err);
    }
  });

  shellIpc.handle("local-ai:uninstall", async (_event, component: unknown) => {
    try {
      if (str(component, 10) === "images") await localAi.uninstallComfy();
      else await localAi.uninstallText();
      return { ok: true, status: localAi.status() };
    } catch (err) {
      return fail(err);
    }
  });

  return { handleJoinLink, shutdownShare };
}
