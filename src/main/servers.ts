import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HomeCache } from "../shared/home-feed-logic";
import { parseDeckChoice, type DeckChoice } from "../shared/deck";
import { parseStoryMemory, type StoryMemory } from "../shared/story-memory";
import type { ServerSummary, UpdateChannel } from "../shared/types";

// The reserved id for the bundled offline server's account entry. Its origin
// changes with the local port, so it is always looked up by id, never origin.
export const LOCAL_SERVER_ID = "local";

// One remembered server. The session token is stored encrypted (OS keychain
// via safeStorage where available); everything else is plain JSON.
// secretCipher holds a password the app made up itself (the local profile's,
// or the one minted for a room-code join) so the shell can sign back in
// when the session token expires; passwords a person chose are never kept.
export interface StoredServer {
  id: string;
  origin: string;
  name: string;
  username: string;
  lastUsedAt: string;
  tokenCipher: string;
  tokenExpiresAt: string;
  secretCipher?: string;
  // The world's stable id from /api/auth/providers ("" or absent on servers
  // that predate it). Lets the shell recognize a device world that came back
  // at a new tunnel address and move this entry there instead of adding a
  // duplicate.
  instanceId?: string;
  // Room codes this entry was joined through, newest first. Kept on the
  // entry itself (not only in the home cache, which exists only once the
  // home screen has drawn this host while it was up) so a world that moved
  // can be found again by the code the player arrived with.
  joinCodes?: string[];
}

// Injected so tests can run without Electron's safeStorage.
export interface TokenCrypt {
  encrypt(plain: string): string;
  decrypt(cipher: string): string | null;
  // "keyring" when the OS really encrypts; "obscured" when it only scrambles
  // with a fixed key (Linux with no keyring: safeStorage's basic_text);
  // "none" when nothing is available and tokens are stored as they are.
  protection?(): CredentialProtection;
}

export type CredentialProtection = "keyring" | "obscured" | "none";

interface RegistryFile {
  version: 1;
  servers: StoredServer[];
  // The home screen's last campaign list per host id (the local entry
  // included), so an unreachable host still lists what it had.
  homeCache?: HomeCache;
  // Portal mode off by choice; absent means on.
  portalOff?: boolean;
  // The updater offers the nightly betas too; absent means stable only.
  betaUpdates?: true;
  // The device world's story memory (src/shared/story-memory.ts); absent
  // means the server's English default.
  storyMemory?: StoryMemory;
  // The Steam Deck layout forced on or off in Settings; absent means auto
  // (on on a Deck and in Steam's Game Mode).
  deckLayout?: "on" | "off";
  // The first-launch offer to add the app to Steam was answered; it is
  // made once, and Settings keeps the button after it.
  steamOfferAnswered?: true;
  // Per room code, the secret that claims it in the broker's table
  // registry. Kept so the same code can be pointed at next session's
  // address; nobody else can move a table this shell claimed.
  tableSecrets?: Record<string, string>;
  // Room codes this shell last pointed at a public address. Persisted so a
  // crash or a plain quit can still take them offline on the next start,
  // rather than leaving a friend's code pointing at a dead address.
  publishedCodes?: string[];
  // Sign-ins to hosts where the player typed their own password are kept
  // in memory only and gone when the app closes (Settings).
  forgetSignInsOnClose?: true;
}

const emptyRegistry = (): RegistryFile => ({ version: 1, servers: [] });

function parseRegistry(text: string): RegistryFile | null {
  try {
    const parsed = JSON.parse(text) as RegistryFile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.servers)) return parsed;
  } catch {
    // Not JSON.
  }
  return null;
}

// Windows holds a file for a moment while Defender or the indexer reads it;
// a read that fails that way is tried again before the file counts as
// unreadable. Tests shorten the wait.
const BUSY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN"]);
export const registryPatience = { attempts: 5, delayMs: 100 };

function readPatiently(file: string): string {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!BUSY_CODES.has(code) || attempt >= registryPatience.attempts) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, registryPatience.delayMs);
    }
  }
}

export class ServerStore {
  // The parsed registry and the file stamp it was read at. Most accessors
  // run on every IPC call and status event, and each used to read and parse
  // the whole file (summaries() once more per entry, through token()). A
  // stat is enough to tell whether the file changed underneath.
  private cached: { stamp: string; registry: RegistryFile } | null = null;
  // Tokens kept for this run only (forgetSignInsOnClose), by entry id.
  private readonly sessionTokens = new Map<string, string>();
  // The file is there but could not be read: this run keeps its changes in
  // memory and never writes over it.
  private unreadable = false;
  // The copy of the file this run read cleanly first, kept beside it.
  private keptLastGood = false;

  constructor(
    private readonly file: string,
    private readonly crypt: TokenCrypt,
    private readonly log: (line: string) => void = console.warn,
  ) {}

  // A copy of the registry as it read cleanly at the start of the last run
  // (the device world's made-up password lives only here), restored from
  // when the file turns up damaged.
  private get lastGood(): string {
    return `${this.file}.last-good`;
  }

  private stamp(): string {
    try {
      const stat = fs.statSync(this.file);
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return "";
    }
  }

  // A private copy: callers change it and hand it to save().
  private load(): RegistryFile {
    const stamp = this.stamp();
    if (!this.cached || this.cached.stamp !== stamp) {
      this.cached = { stamp, registry: this.read() };
    }
    return structuredClone(this.cached.registry);
  }

  // A missing file is a first run. A damaged one used to read as an empty
  // list that the next save wrote over, taking every saved server and the
  // device world's password with it; now its bytes are kept under a dated
  // name and the copy from the last clean start takes its place.
  private read(): RegistryFile {
    let text: string;
    try {
      text = readPatiently(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
      this.unreadable = true;
      this.log(`[servers] ${this.file} could not be read (${(error as Error).message}); changes stay in memory this run`);
      return emptyRegistry();
    }
    const parsed = parseRegistry(text);
    if (parsed) {
      this.unreadable = false;
      if (!this.keptLastGood) {
        this.keptLastGood = true;
        try {
          fs.writeFileSync(this.lastGood, text, { mode: 0o600 });
        } catch (error) {
          this.log(`[servers] could not keep a copy of the saved servers: ${(error as Error).message}`);
        }
      }
      return parsed;
    }
    const aside = `${this.file}.damaged-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      fs.renameSync(this.file, aside);
    } catch (error) {
      this.unreadable = true;
      this.log(`[servers] ${this.file} is damaged and could not be set aside (${(error as Error).message}); changes stay in memory this run`);
      return emptyRegistry();
    }
    let backup: RegistryFile | null = null;
    try {
      backup = parseRegistry(fs.readFileSync(this.lastGood, "utf8"));
    } catch {
      // No copy yet.
    }
    this.log(
      `[servers] ${this.file} was damaged; kept as ${path.basename(aside)}` +
        (backup ? ", the saved servers from the last start are back" : ", and there was no earlier copy to bring back"),
    );
    if (!backup) return emptyRegistry();
    this.save(backup);
    return backup;
  }

  // Written to a temp file of its own, flushed to disk, then renamed over
  // the file: a crash or power cut leaves the old file or the new one,
  // never a torn or empty one.
  private save(registry: RegistryFile): void {
    if (this.unreadable) {
      this.cached = { stamp: this.stamp(), registry: structuredClone(registry) };
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
    try {
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(registry, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
    this.cached = { stamp: this.stamp(), registry: structuredClone(registry) };
  }

  // A sign-in that may live in memory only: a host where the player typed
  // their own password (so they can type it again). The device world and
  // room-code accounts carry a password the app made up, which only this
  // file holds, so forgetting their sign-in would lock the player out.
  private sessionOnly(registry: RegistryFile, server: StoredServer): boolean {
    return !!registry.forgetSignInsOnClose && server.id !== LOCAL_SERVER_ID && !server.secretCipher;
  }

  private tokenOf(server: StoredServer): string | null {
    if (server.tokenExpiresAt && Date.parse(server.tokenExpiresAt) <= Date.now()) return null;
    const held = this.sessionTokens.get(server.id);
    if (held) return held;
    if (!server.tokenCipher) return null;
    return this.crypt.decrypt(server.tokenCipher);
  }

  // How saved sign-ins are kept, for Settings.
  credentialStorage(): { protection: CredentialProtection; keepSignIns: boolean } {
    return { protection: this.crypt.protection?.() ?? "keyring", keepSignIns: !this.load().forgetSignInsOnClose };
  }

  // Turning "keep" off moves every sign-in that may go into memory now;
  // turning it back on writes them back to the file.
  setKeepSignIns(keep: boolean): void {
    const registry = this.load();
    if (keep) delete registry.forgetSignInsOnClose;
    else registry.forgetSignInsOnClose = true;
    for (const server of registry.servers) {
      if (!keep && this.sessionOnly(registry, server) && server.tokenCipher) {
        const token = this.crypt.decrypt(server.tokenCipher);
        if (token) this.sessionTokens.set(server.id, token);
        server.tokenCipher = "";
      } else if (keep && this.sessionTokens.has(server.id)) {
        server.tokenCipher = this.crypt.encrypt(this.sessionTokens.get(server.id)!);
        this.sessionTokens.delete(server.id);
      }
    }
    this.save(registry);
  }

  // Remote servers only, most recently used first.
  list(): StoredServer[] {
    return this.load()
      .servers.filter((server) => server.id !== LOCAL_SERVER_ID)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  summaries(): ServerSummary[] {
    return this.list().map((server) => ({
      id: server.id,
      origin: server.origin,
      name: server.name,
      username: server.username,
      lastUsedAt: server.lastUsedAt,
      hasToken: this.tokenOf(server) !== null,
    }));
  }

  get(id: string): StoredServer | null {
    return this.load().servers.find((server) => server.id === id) ?? null;
  }

  findByOrigin(origin: string): StoredServer | null {
    return (
      this.load().servers.find(
        (server) => server.id !== LOCAL_SERVER_ID && server.origin === origin,
      ) ?? null
    );
  }

  findByInstanceId(instanceId: string): StoredServer | null {
    if (!instanceId) return null;
    return (
      this.load().servers.find(
        (server) => server.id !== LOCAL_SERVER_ID && server.instanceId === instanceId,
      ) ?? null
    );
  }

  // Adds or refreshes a server entry. Remote entries dedupe by origin, then
  // by the world's instanceId (a device world back at a new tunnel address);
  // the local entry is addressed by its fixed id.
  upsert(input: {
    id?: string;
    origin: string;
    name: string;
    username: string;
    token: string;
    tokenExpiresAt: string;
    secret?: string;
    instanceId?: string;
  }): StoredServer {
    const registry = this.load();
    const existing =
      registry.servers.find((server) =>
        input.id ? server.id === input.id : server.id !== LOCAL_SERVER_ID && server.origin === input.origin,
      ) ??
      (input.id || !input.instanceId
        ? undefined
        : registry.servers.find(
            (server) => server.id !== LOCAL_SERVER_ID && server.instanceId === input.instanceId,
          ));
    // A stored password belongs to one account. Signing in to the same
    // host as somebody else must not keep the old one, or the next renewal
    // tries user B with A's password and burns B's login throttle.
    const sameAccount = !existing || existing.username === input.username;
    const entry: StoredServer = {
      id: existing?.id ?? input.id ?? randomUUID(),
      origin: input.origin,
      name: input.name,
      username: input.username,
      lastUsedAt: new Date().toISOString(),
      tokenCipher: this.crypt.encrypt(input.token),
      tokenExpiresAt: input.tokenExpiresAt,
      // A token refresh must not drop the stored local password.
      secretCipher:
        input.secret !== undefined
          ? this.crypt.encrypt(input.secret)
          : sameAccount
            ? existing?.secretCipher
            : undefined,
      instanceId: input.instanceId || existing?.instanceId,
      joinCodes: existing?.joinCodes,
    };
    if (this.sessionOnly(registry, entry)) {
      this.sessionTokens.set(entry.id, input.token);
      entry.tokenCipher = "";
    } else {
      this.sessionTokens.delete(entry.id);
    }
    if (existing) {
      registry.servers[registry.servers.indexOf(existing)] = entry;
    } else {
      registry.servers.push(entry);
    }
    this.save(registry);
    return entry;
  }

  // The decrypted session token, or null when absent, expired, or
  // undecryptable (e.g. the OS keychain changed).
  token(id: string): string | null {
    const server = this.get(id);
    return server ? this.tokenOf(server) : null;
  }

  // The stored local profile password, or null when absent or undecryptable.
  secret(id: string): string | null {
    const server = this.get(id);
    if (!server?.secretCipher) return null;
    return this.crypt.decrypt(server.secretCipher);
  }

  // Forgets only the session token. The entry stays (so the server list
  // still offers the server) and so does any stored local profile secret,
  // which is what lets the local world's next Play sign back in silently.
  clearToken(id: string): void {
    const registry = this.load();
    const server = registry.servers.find((entry) => entry.id === id);
    this.sessionTokens.delete(id);
    if (!server || !server.tokenCipher) return;
    server.tokenCipher = "";
    server.tokenExpiresAt = "";
    this.save(registry);
  }

  touch(id: string): void {
    const registry = this.load();
    const server = registry.servers.find((entry) => entry.id === id);
    if (!server) return;
    server.lastUsedAt = new Date().toISOString();
    this.save(registry);
  }

  // Moves an entry to a new address, keeping its id, token and home cache:
  // the same world reached a different way, not a different server.
  rebindOrigin(id: string, origin: string): StoredServer | null {
    const registry = this.load();
    const server = registry.servers.find((entry) => entry.id === id);
    if (!server) return null;
    server.origin = origin;
    server.lastUsedAt = new Date().toISOString();
    this.save(registry);
    return server;
  }

  // Best-effort backfill for entries saved before the server exposed its
  // instanceId (or before this shell stored it).
  setInstanceId(id: string, instanceId: string): void {
    if (!instanceId) return;
    const registry = this.load();
    const server = registry.servers.find((entry) => entry.id === id);
    if (!server || server.instanceId === instanceId) return;
    server.instanceId = instanceId;
    this.save(registry);
  }

  remove(id: string): void {
    this.sessionTokens.delete(id);
    const registry = this.load();
    registry.servers = registry.servers.filter((server) => server.id !== id);
    if (registry.homeCache) delete registry.homeCache[id];
    this.save(registry);
  }

  portal(): boolean {
    return !this.load().portalOff;
  }

  setPortal(on: boolean): void {
    const registry = this.load();
    if (on) delete registry.portalOff;
    else registry.portalOff = true;
    this.save(registry);
  }

  updateChannel(): UpdateChannel {
    return this.load().betaUpdates ? "beta" : "stable";
  }

  setUpdateChannel(channel: UpdateChannel): void {
    const registry = this.load();
    if (channel === "beta") registry.betaUpdates = true;
    else delete registry.betaUpdates;
    this.save(registry);
  }

  storyMemory(): StoryMemory {
    return parseStoryMemory(this.load().storyMemory);
  }

  setStoryMemory(choice: StoryMemory): void {
    const registry = this.load();
    if (choice === "english") delete registry.storyMemory;
    else registry.storyMemory = choice;
    this.save(registry);
  }

  deckChoice(): DeckChoice {
    return parseDeckChoice(this.load().deckLayout);
  }

  setDeckChoice(choice: DeckChoice): void {
    const registry = this.load();
    if (choice === "auto") delete registry.deckLayout;
    else registry.deckLayout = choice;
    this.save(registry);
  }

  steamOfferAnswered(): boolean {
    return this.load().steamOfferAnswered === true;
  }

  answerSteamOffer(): void {
    const registry = this.load();
    registry.steamOfferAnswered = true;
    this.save(registry);
  }

  // The secret that claims a room code in the broker's table registry,
  // minted once per code and kept, so the same code can be pointed at the
  // address this world answers at today and again at tomorrow's.
  tableSecret(code: string): string {
    const key = code.trim().toUpperCase();
    const registry = this.load();
    const existing = registry.tableSecrets?.[key];
    if (typeof existing === "string" && existing.length >= 16) return existing;
    const secret = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 8);
    registry.tableSecrets = { ...(registry.tableSecrets ?? {}), [key]: secret };
    this.save(registry);
    return secret;
  }

  // The room code an entry was just joined through, kept newest first.
  rememberJoinCode(id: string, code: string): void {
    const clean = (code || "").trim().toUpperCase();
    if (!clean) return;
    const registry = this.load();
    const server = registry.servers.find((entry) => entry.id === id);
    if (!server) return;
    const rest = (server.joinCodes ?? []).filter((entry) => entry !== clean);
    server.joinCodes = [clean, ...rest].slice(0, 8);
    this.save(registry);
  }

  // Room codes seen on this host: the ones the player joined through, then
  // every campaign the home screen last listed there. These are the keys
  // the broker's table registry answers "where is that world now" for, which
  // is how a saved entry finds a world that came back at a new address
  // (src/shared/relocate.ts).
  tableCodesFor(id: string): string[] {
    const codes: string[] = [];
    for (const code of this.get(id)?.joinCodes ?? []) {
      if (code && !codes.includes(code)) codes.push(code);
    }
    for (const campaign of this.homeCache()[id]?.campaigns ?? []) {
      const code = (campaign.inviteCode ?? "").trim().toUpperCase();
      if (code && !codes.includes(code)) codes.push(code);
    }
    return codes;
  }

  publishedCodes(): string[] {
    const codes = this.load().publishedCodes;
    return Array.isArray(codes) ? codes.filter((code) => typeof code === "string") : [];
  }

  setPublishedCodes(codes: readonly string[]): void {
    const registry = this.load();
    registry.publishedCodes = [...codes];
    this.save(registry);
  }

  homeCache(): HomeCache {
    const cache = this.load().homeCache;
    return cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
  }

  // Replaces the whole record: the feed writes every host it knows in one
  // go, which also forgets hosts that are gone.
  saveHomeCache(cache: HomeCache): void {
    const registry = this.load();
    registry.homeCache = cache;
    this.save(registry);
  }
}
