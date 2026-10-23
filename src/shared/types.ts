// Types crossing the preload bridge between the shell UI and the main
// process. Pure declarations only: this file is shared by the CommonJS main
// build and the browser renderer build, so it must stay runtime-free.

import type { DeckChoice, DeckInfo, FieldRect } from "./deck";
import type { StoryMemory, StoryMemoryStatus } from "./story-memory";
import type { WorldPreview } from "./world-transfer";

export type SignupMode = "open" | "invite" | "closed";

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

// What /api/auth/providers reveals about a server before logging in.
export interface ServerProbe {
  origin: string;
  serverName: string;
  version: string;
  signupMode: SignupMode;
  discord: boolean;
  // The world's identity across addresses ("" on servers that predate it).
  // Device worlds get a fresh tunnel hostname every share session; this is
  // how the shell recognizes one it already has an account on.
  instanceId: string;
  // A world one of the apps is hosting, rather than a server someone runs
  // and administers (servers older than 0.16.6 do not say, and are taken
  // for real servers). Joining one takes a name and nothing else: nobody
  // should be inventing a password for a game on someone's phone. A real
  // server keeps passwords and whatever signup rule its owner set.
  deviceWorld: boolean;
  // A server nobody has signed up to yet: its first account
  // becomes the admin and takes the one-time setup code from the server's
  // log, so the form asks for it. False on older servers, which do not say.
  needsSetup: boolean;
}

// A remembered server, minus its stored credential.
export interface ServerSummary {
  id: string;
  origin: string;
  name: string;
  username: string;
  lastUsedAt: string;
  hasToken: boolean;
}

export interface LocalStatus {
  // "unavailable" means this build carries no bundled server payload.
  state: "unavailable" | "stopped" | "starting" | "running" | "error";
  origin: string;
  firstRun: boolean;
  hasAccount: boolean;
  // The on-device profile's name, "" until one exists. Shown on the home
  // screen so the default door says who it opens for.
  username: string;
  serverVersion: string;
  error: string;
  // Where friends on the same network reach a device-hosted world ("" when
  // not hosting or not on a network). The phone's world always answers on
  // its Wi-Fi; the desktop's only while Wi-Fi sharing is on (lanStart).
  // Both shells share online through a tunnel.
  lanOrigin: string;
}

// The server files the app unpacked for its world, checked against the ones
// it shipped with (src/main/payload-manifest.ts). Desktop only: the phone's
// payload carries no manifest yet.
export interface VerifyReport {
  // False when the payload has not been unpacked yet (a world never
  // entered): nothing to check, the next start unpacks it.
  unpacked: boolean;
  // How many files the shipped payload lists.
  listed: number;
  // Payload-relative paths of the files missing from the tree, and of those
  // whose size (or, when hashed, whose bytes) differ from the shipped file.
  missing: string[];
  changed: string[];
  hashed: boolean;
}

// What a repair (the server files unpacked again, keeping everything the
// player made) found and did.
export interface RepairResult {
  // The check before the rebuild; null when this build carries no manifest
  // to check against.
  found: VerifyReport | null;
  // Whether the world was started again afterwards: it is when it was awake
  // or had failed before, and left asleep otherwise.
  started: boolean;
}

// The offline-play setup wizard's AI step. "human" changes nothing on the
// server; campaigns simply run with a human Dungeon Master.
export interface AiSetup {
  choice: "openai" | "human" | "harness";
  apiKey: string;
  model: string;
  utilityModel: string;
  // "harness": an agent program already installed and signed in on this
  // computer (Claude Code, Codex, opencode, Grok Build) narrates instead.
  harness?: { id: HarnessId; model: string; utilityModel: string };
  // The provider's paid Fast tier (server issue 255), for the storyteller.
  // On OpenAI the server asks for it for any named model, at the premium
  // price, so each role is chosen on its own: utilityFast is the utility
  // model's.
  fast?: boolean;
  utilityFast?: boolean;
  // The OpenAI door: read the story aloud with OpenAI's voices too, on the
  // same key (the narration model from the key's own list).
  narrate?: boolean;
}

// The storyteller models an OpenAI key lists, as the device world's server
// reads them (its guided setup's listing), with the catalog's pick.
export type AiModelsResult = Result<{ models: Array<{ id: string; label: string }>; recommended: string }>;

export type HarnessId = "claude" | "codex" | "opencode" | "grok";

// One agent program as the device world's server sees it (its
// GET /api/admin/harness). The shell never looks for programs itself: the
// bundled server is the one that will start them, so its answer is the truth.
export interface HarnessCard {
  id: HarnessId;
  label: string;
  installed: boolean;
  version?: string;
  auth: { state: "ready" | "signed-out" | "unknown"; plan?: string; account?: string };
  // fast: Codex lists a Fast tier for the model on this sign-in.
  models: Array<{ id: string; label: string; cheap?: boolean; fast?: boolean }>;
  lockdown: "removed" | "contained";
  lockdownProven: boolean;
  nativeImages: "no" | "untested" | "verified";
  availability: "ok" | "container" | "sandboxed-package" | "phone";
  message?: string;
  installHint?: string;
  signInHint?: string;
}

export type HarnessStatusResult =
  | { ok: true; statuses: HarnessCard[]; current: { id: string; model: string; utilityModel: string; fast?: boolean } }
  | { ok: false; error: string };

// What Story AI already holds for this device, so the OpenAI form can show
// it instead of asking again. The key itself never leaves the device's
// server; keySaved only says one is there.
export interface SavedAi {
  keySaved: boolean;
  model: string;
  utilityModel: string;
  // Set when the device narrates with an agent program.
  harnessId?: string;
  // The storyteller runs at the provider's Fast tier, and the utility model.
  fast?: boolean;
  utilityFast?: boolean;
  // What the device world uses now, in words, for the top of Story AI
  // (currentAiSummary in ai-setup.ts). Older shells ignore it.
  summary?: { story: string; pictures: string; narration: string };
}

// firstSetup: the shell just auto-provisioned the local profile, so the
// renderer should offer the one-time AI choice before entering the world.
// needsName: a fresh phone world has no OS username to borrow, so the
// renderer asks for one before the profile is created.
export type ConnectResult =
  | { ok: true; firstSetup?: boolean; needsName?: boolean }
  | { ok: false; needsLogin: boolean; error: string };

export type NativeRemotePreparation =
  | { ok: true; session: { origin: string; token: string }; version: string }
  | { ok: false; needsLogin: boolean; error: string; origin: string };

// A tunnel sharing the local world at a public https address. "named" means
// a broker-issued play-CODE address; "quick" is the trycloudflare fallback.
export interface TunnelStatus {
  state: "stopped" | "starting" | "running" | "error";
  url: string;
  mode: "" | "named" | "quick";
  error: string;
}

// What a game page inside the shell learns about sharing through
// window.odmShell.share (the server's src/lib/shell-host.ts mirrors this).
// supported is false on pages of remote servers: only the shell's own world
// can be shared from here.
export interface ShellShareStatus extends TunnelStatus {
  supported: boolean;
  // The Wi-Fi address of a device-hosted world, "" when there is none.
  lanUrl: string;
  // Room codes the table registry would not take from this shell because
  // another device claimed them first; the lobby tells the host.
  refusedCodes?: string[];
}

// What the hardware scan learned; sizes in whole GB.
export interface HardwareInfo {
  platform: string;
  arch: string;
  ramGb: number;
  // 0 when no GPU signal was found. On unified-memory machines (Apple
  // Silicon) this equals ramGb.
  vramGb: number;
  gpuName: string;
  // Which GPU stack to install compute for; "" when no signal was found.
  gpuVendor: "" | "nvidia" | "amd" | "apple";
  // An NVIDIA card's compute capability (8.9 for an RTX 4090, 12.0 for an
  // RTX 5090), which picks the CUDA build of torch. Absent when unknown.
  gpuCompute?: number;
  unifiedMemory: boolean;
}

// One entry of the curated model catalog, sized against this machine.
export interface LocalAiTier {
  id: string;
  label: string;
  detail: string;
  sizeGb: number;
  needsGb: number;
  fits: boolean;
  recommended: boolean;
  installed: boolean;
}

export interface LocalAiStatus {
  supported: boolean;
  installedTierId: string;
  // Human label for the installed tier, for status display.
  installedLabel: string;
  // Whether the small summaries model sits beside the story model.
  utilityInstalled: boolean;
  running: boolean;
  // Running means a server the app did not start answers on the port.
  external: boolean;
  // Where the device world's text AI is pointed (http://127.0.0.1:8001/v1).
  endpoint: string;
  busy: "" | "scanning" | "downloading" | "starting";
  progress: { label: string; percent: number } | null;
  error: string;
  // The local image generation stack, installed and removed independently.
  comfy: {
    installed: boolean;
    running: boolean;
    checkpoint: string;
    error: string;
  };
}

// The device world's built-in speech-to-text (the server's Admin > Speech),
// as the desktop's Local AI screen shows it.
export interface LocalSpeechStatus {
  installed: boolean;
  status: "idle" | "installing" | "ready" | "error";
  // 0 to 1 while the model downloads.
  progress: number;
  error: string;
  downloadMb: number;
  // Which engine the world's dictation uses right now.
  active: "whisper" | "builtin" | "openai" | "none";
}

// What reads the device world's story aloud (the server's Admin > Speech
// narration), as Settings shows it outside the world
// (src/shared/world-media.ts).
export interface NarrationStatus {
  // The saved choice; "" was never chosen and means Kokoro at its usual
  // address, which reads aloud only when one answers there.
  provider: "" | "openai" | "kokoro" | "off";
  // The saved Kokoro address, "" for the usual one.
  kokoroUrl: string;
  // An OpenAI key the world already holds (Story AI's key door).
  keySaved: boolean;
  // A Kokoro this computer answers on, its address; "" when none does.
  found: string;
}

export type NarrationChoice = { kind: "openai" } | { kind: "kokoro"; url: string } | { kind: "off" };

// The device world's sound library (the server's Admin > Sound library):
// how many of the catalog's sounds have audio, and a pack download.
export interface SoundLibraryStatus {
  installed: number;
  total: number;
  status: "idle" | "installing" | "ready" | "error";
  // 0 to 1 while the pack downloads.
  progress: number;
  error: string;
}

// How this build reached the machine; decides whether the app may replace
// itself ("appimage", "nsis") or must point at the real update channel.
export type InstallKind =
  | "appimage"
  | "flatpak"
  | "snap"
  | "managed"
  | "portable"
  | "nsis"
  | "mac"
  | "dev";

// "android" never comes out of detectInstallKind; it is the mobile shell
// identifying itself so the About card can skip the update controls.
export interface AppInfo {
  version: string;
  installKind: InstallKind | "android";
  // What the background check had found by the time the page asked: a
  // renderer that loaded after the check still hears about it.
  update?: UpdateStatus | null;
  // The Steam Deck layout (src/shared/deck.ts). Desktop only.
  deck?: DeckInfo;
  // The reset this start carried out (src/main/reset.ts): where the
  // previous data went, and what could not be moved. Desktop only.
  reset?: { aside: string; left: string[] } | null;
  // A Linux install Steam is there to take as a non-Steam game
  // (src/main/steam-shortcut.ts). Desktop only.
  addToSteam?: boolean;
}

// Adding the app to Steam. "needs-restart": Steam is open and would write
// its old list back on the way out, so nothing was changed; the same call
// with restart true closes Steam, adds the app and opens Steam again.
// moved: where an AppImage went to keep one name through updates.
export type SteamAddResult =
  | { ok: true; state: "added" | "updated"; persona: string; restarted: boolean; moved: string }
  | { ok: true; state: "needs-restart" }
  | { ok: false; error: string };

// Which releases the desktop updater offers. Every build is published as a
// GitHub prerelease first, the beta; the ones that hold up are promoted to
// stable by clearing that flag (docs/releases.md in the server repository).
export type UpdateChannel = "stable" | "beta";

export interface UpdateStatus {
  current: string;
  latest: string;
  available: boolean;
  canSelfUpdate: boolean;
  // The app can fetch this install's release file itself and apply it: the
  // package manager for an rpm or deb, an unpack over the install for a
  // tar.gz or the Mac bundle, the host's flatpak for a flatpak bundle.
  canDownload: boolean;
  // Human words for installs that cannot self-update ("flatpak update", ...).
  instruction: string;
  // Where the new build lives, for the installs that fetch it themselves.
  releasesUrl: string;
  // The channel the answer came from.
  channel: UpdateChannel;
}

// "available" is the once-per-run background check finding something; the
// rest narrate an explicit download started from the About card.
// "installing" is the stretch between the download and the restart, when
// the system may be asking for a password.
export interface UpdateProgress {
  state: "idle" | "available" | "downloading" | "installing" | "ready" | "error";
  percent: number;
  latest: string;
  error: string;
  // What "ready" means for this install, when it is not a restart.
  message: string;
  // Filled in with "available": what the background check found, so the
  // renderer can show the same button an explicit check would.
  status: UpdateStatus | null;
}

// One campaign as the home screen lists it, from any host. playingAs is the
// player's character name there, null when they have none yet or run it.
// The title screen's glance at a table (server 0.23.5 and up): the last
// thing the Dungeon Master said, the open chapter, the newest painted
// scene and the party's faces. Absent from hosts older than that.
export interface HomeGlanceFace {
  name: string;
  // Absolute on the host: a portrait under /uploads (behind the login) or
  // a public placeholder plate.
  url: string;
}

export interface HomeGlance {
  // act and actTitle arrive from server 0.23.7 and up (the arc's acts are
  // announced to the table); older hosts send neither.
  chapter: { index: number; title: string; act: number | null; actTitle: string } | null;
  recap: string;
  recapAt: string | null;
  // Absolute on the host, under /generated (behind the login), or null.
  sceneImage: string | null;
  faces: HomeGlanceFace[];
}

export interface HomeCampaign {
  id: string;
  title: string;
  status: "lobby" | "active" | "ended";
  playerCount: number;
  maxPlayers: number;
  playingAs: string | null;
  coverUrl: string | null;
  // What the title screen says under the name and on a save slot. All
  // optional: entries cached before these existed keep their shape, and
  // an older host never sends them.
  genre?: string;
  description?: string;
  scene?: string;
  startingLevel?: number;
  difficulty?: string;
  // True when this account holds the DM or assistant DM seat there. Known
  // only when the host's list let the shell learn the account's id.
  dmSeat?: boolean;
  glance?: HomeGlance;
  // The plate the server's own home draws before anyone paints a cover:
  // one of three per genre, picked by the campaign id (the same rule as
  // the server's src/lib/placeholders.ts), served publicly from the host.
  placeholderUrl: string | null;
  updatedAt: string;
  role: "owner" | "player";
  dmMode: "ai" | "assisted" | "human";
  // The campaign's room code. Kept because it is the one handle on a world
  // that never changes: when a host shares again at a new address, the
  // broker's table registry turns this back into "where that world is now"
  // (src/shared/relocate.ts). Absent on entries cached before this existed.
  inviteCode?: string;
}

// A place the player has campaigns: the device world ("local"), a saved
// server, or another player's app reached through a tunnel address. stale
// means the campaigns did not come from this refresh (the host was not
// reachable, so the last remembered list is shown).
export interface HomeHost {
  id: string;
  kind: "local" | "server" | "tunnel";
  name: string;
  origin: string;
  username: string;
  status: "online" | "offline" | "needsLogin" | "starting" | "unavailable";
  lastSeenAt: string | null;
  stale: boolean;
  error: string;
  campaigns: HomeCampaign[];
  // Whether this account may start a campaign there: the server's shared
  // host policy (its campaign list says so; older servers do not, and are
  // taken as open).
  canCreate: boolean;
  // Whether that server has an AI storyteller: Quick start is an AI-run
  // adventure, offered only where one can run it (older servers do not
  // say, and are taken to have one).
  offersStory: boolean;
}

// refreshedAt is "" for a feed served from the cache before any refresh.
export interface HomeFeed {
  hosts: HomeHost[];
  refreshedAt: string;
}

export type ShellEvent =
  | { kind: "show-manager" }
  // The platform back gesture (Android): leave the current screen for home,
  // or, from home, leave the app.
  | { kind: "back" }
  | { kind: "join-request"; origin: string; code: string; knownServerId: string }
  | { kind: "local-status"; status: LocalStatus }
  | { kind: "tunnel-status"; status: TunnelStatus }
  | { kind: "local-ai-progress"; status: LocalAiStatus }
  | { kind: "update-progress"; progress: UpdateProgress }
  // What the device world's server is doing while it packs or checks a
  // world archive (src/shared/world-transfer.ts).
  | { kind: "world-transfer"; phase: string }
  // After every feed refresh, including the ones a local-status or
  // tunnel-status change sets off.
  | { kind: "home-feed"; feed: HomeFeed };

// What a server answers when the player deletes their account there. The
// server signs the account out everywhere and erases it after graceDays
// (at once when purged is true); signing in before dueAt keeps it.
export interface AccountDeletionResult {
  dueAt: string;
  graceDays: number;
  purged: boolean;
}

export interface OdmBridge {
  // Lets the shared shell UI adapt copy and layout per shell.
  platform: "desktop" | "android";
  // What the device can draw (docs/vtt-parity-implementation-plan.md 18.2,
  // phase 16): "low" switches the server screens' effects down without
  // user agent sniffing. Absent on desktop, which always draws in full.
  deviceClass?: "low" | "standard";
  // A short buzz for a hit, a crit, your turn or a tap (phase 17). A
  // no-op where the platform has no motor.
  haptic?(kind: "hit" | "crit" | "turn" | "tap"): void;
  // Opens a host document (a PDF page set) with the system viewer
  // (phase 21). Absent where the platform's own viewer will do.
  openDocument?(path: string): Promise<boolean>;
  // The desktop's game screens say which host they show, so a document the
  // page asks to open is fetched with that host's session (doc:open).
  gameMounted?(hostId: string): void;
  // The screens' theme (phase 29), so the shell's chrome and the OS
  // frame can follow the parchment or the night.
  setTheme?(mode: "dark" | "light"): Promise<void>;
  // The table view on a second display (phase 28), desktop only.
  openTableScreen?(hostId: string, campaignId: string): Promise<boolean>;
  listServers(): Promise<{ servers: ServerSummary[]; local: LocalStatus; tunnel: TunnelStatus }>;
  probeServer(origin: string): Promise<Result<{ probe: ServerProbe }>>;
  login(input: {
    origin: string;
    username: string;
    password: string;
    joinCode?: string;
  }): Promise<Result<{ server: ServerSummary }>>;
  register(input: {
    origin: string;
    username: string;
    password: string;
    inviteCode: string;
    // Joining by room code: the app mints and keeps the password, so the
    // player only picks a name.
    generated?: boolean;
    joinCode?: string;
    // The one-time code that claims a fresh server's first account.
    setupCode?: string;
  }): Promise<Result<{ server: ServerSummary }>>;
  // Sign in through the server's Discord OAuth in a web view; the shell
  // harvests the session the callback plants and remembers the server like
  // a password login would. Only offered when the probe says discord: true.
  discordLogin(input: { origin: string; joinCode?: string }): Promise<Result<{ server: ServerSummary }>>;
  // `path` lands on a page of the host (a campaign, /characters, /?new=1)
  // instead of the root; a join code takes precedence. Sanitized in
  // src/shared/open-path.ts before it touches a URL.
  connect(serverId: string, joinCode?: string, path?: string): Promise<ConnectResult>;
  // Desktop validates remote identity and session before opening native screens.
  prepareRemote?(serverId: string, joinCode?: string): Promise<NativeRemotePreparation>;
  // Android only: the back gesture on the home screen leaves the app.
  leaveApp?(): Promise<void>;
  // Feeds a pasted invite link (odm:// or the https /j shape) or a bare
  // server address into the same flow as a clicked deep link or a scan: a
  // server the player already has (by address, or by the world's instanceId
  // when a tunnel came back at a new hostname) opens with its saved session
  // instead of being added again. False means the text was neither.
  openInviteLink(raw: string): Promise<boolean>;
  // One campaign cover as a data URL, fetched with the host's session (the
  // server keeps uploads behind its login). "" when it cannot be had.
  coverImage(hostId: string, url: string): Promise<string>;
  // The system share sheet, where the platform has one (Android). Absent
  // on desktop, so the share buttons are withheld rather than dead. False
  // means the sheet was dismissed or could not open.
  shareLink?(input: { title: string; text: string; url: string }): Promise<boolean>;
  // Portal mode (src/shared/portal-logic.ts): worlds load their screens
  // from the app's bundled server and only game data travels to the host.
  // On by default; a host too old for it opens its own pages regardless.
  portalMode(): Promise<boolean>;
  setPortalMode(on: boolean): Promise<void>;
  // Which releases the updater offers: stable by default, or each night's
  // beta as well. Desktop only; absent on the phone, which updates through
  // Google Play.
  updateChannel?(): Promise<UpdateChannel>;
  setUpdateChannel?(channel: UpdateChannel): Promise<void>;
  // How the desktop keeps saved sign-ins: absent on the phone, whose
  // secrets sit in the Android Keystore.
  credentialStorage?(): Promise<{ protection: "keyring" | "obscured" | "none"; keepSignIns: boolean }>;
  setKeepSignIns?(keep: boolean): Promise<void>;
  // Story memory (src/shared/story-memory.ts): the embedding model the
  // device world searches its story with. Desktop only; null on a desktop
  // whose package carries no embedding runtime (Intel Macs), absent on the
  // phone, so the setting is withheld rather than dead. Setting it saves
  // the choice; applying restarts the world so the server picks it up.
  storyMemory?(): Promise<StoryMemoryStatus | null>;
  setStoryMemory?(choice: StoryMemory): Promise<StoryMemoryStatus>;
  applyStoryMemory?(): Promise<Result<{ status: StoryMemoryStatus }>>;
  // The shell's native game screens call a host's API themselves. This
  // hands them the host's address and the live bearer token for it (the
  // device world included, by its host id), or null without a session.
  hostSession(hostId: string): Promise<{ origin: string; token: string } | null>;
  // Present only where a camera scanner exists (Android). Scans one QR code
  // and routes a recognized invite into the join flow, or a bare server
  // address (the server's own corner QR button) into the add-server flow.
  scanInvite?(): Promise<Result>;
  removeServer(serverId: string): Promise<void>;
  // Deletes the player's account on one remote server (the server's own
  // grace period applies). The stored session is dropped; the entry stays so
  // a sign-in before the due date can still keep the account.
  deleteAccount(input: {
    serverId: string;
    password: string;
  }): Promise<Result<{ deletion: AccountDeletionResult }>>;
  // The home screen's campaigns across hosts: homeFeed asks every host
  // (6 s cap each) and pushes a home-feed event; homeFeedCached answers at
  // once from the last refresh or the persisted cache.
  homeFeed(): Promise<HomeFeed>;
  homeFeedCached(): Promise<HomeFeed>;
  localStart(): Promise<Result<{ status: LocalStatus }>>;
  localCreateAccount(input: {
    username: string;
    password: string;
  }): Promise<Result<{ status: LocalStatus }>>;
  localLogin(input: { username: string; password: string }): Promise<Result<{ status: LocalStatus }>>;
  // notice: what the player still has to pick, and where, once the key is
  // saved (a picture or transcription model the key's list does not settle).
  localConfigureAi(setup: AiSetup): Promise<Result<{ notice?: string }>>;
  localAiSaved(): Promise<SavedAi>;
  // The storyteller models the key lists ("" for the one already saved).
  localAiModels(apiKey: string): Promise<AiModelsResult>;
  // The agent programs the device world's server can start. Desktop only;
  // the phone answers that there is no such thing on a phone.
  localHarnessStatus(refresh?: boolean): Promise<HarnessStatusResult>;
  // The saved agent paints one test map the way a table asks for one and,
  // when it comes back, becomes the device world's painter (the server's
  // POST /api/admin/harness picture then adopt). Desktop only.
  localHarnessPictures?(): Promise<{ ok: true; image: string; moved: number } | { ok: false; error: string }>;
  localPlay(joinCode?: string, path?: string): Promise<ConnectResult>;
  shareStart(): Promise<Result<{ tunnel: TunnelStatus }>>;
  shareStop(): Promise<Result<{ tunnel: TunnelStatus }>>;
  // Wi-Fi sharing: the desktop's world answers on every interface so an
  // in-person table plays with no internet at all. Desktop only; the
  // phone's world is on its Wi-Fi already and answers that it is.
  lanStart(): Promise<Result<{ status: LocalStatus }>>;
  lanStop(): Promise<Result<{ status: LocalStatus }>>;
  localAiScan(): Promise<Result<{ hardware: HardwareInfo; tiers: LocalAiTier[] }>>;
  // warning is "" or a sentence: the install worked but wiring the world's
  // settings to it failed and needs a hand.
  localAiInstall(tierId: string): Promise<Result<{ status: LocalAiStatus; warning: string }>>;
  localAiInstallComfy(): Promise<Result<{ status: LocalAiStatus; warning: string }>>;
  localAiUninstall(component: "text" | "images"): Promise<Result<{ status: LocalAiStatus; warning?: string }>>;
  localAiStatus(): Promise<LocalAiStatus>;
  // Starts the installed story AI again after it stopped or gave up.
  localAiStart(): Promise<Result<{ status: LocalAiStatus }>>;
  // Speech-to-text for dictation in the device world. Desktop only: the
  // phone dictates with its own recognizer, so it leaves these out.
  localSpeechStatus?(): Promise<Result<{ speech: LocalSpeechStatus }>>;
  localSpeechInstall?(): Promise<Result<{ speech: LocalSpeechStatus }>>;
  // Narration and the sound library for the device world, set from
  // Settings so nobody has to enter the world for them. Each wakes the
  // world when it is asleep. The sample is one spoken line as an audio
  // data URL.
  localNarration?(): Promise<Result<{ narration: NarrationStatus }>>;
  localSetNarration?(choice: NarrationChoice): Promise<Result<{ narration: NarrationStatus; notice?: string }>>;
  localNarrationSample?(): Promise<Result<{ audio: string }>>;
  localSoundLibrary?(install: boolean): Promise<Result<{ library: SoundLibraryStatus }>>;
  // Moving the device world to another device (src/shared/world-transfer.ts):
  // pack it into one file the person saves (saved is false when they close
  // the save dialog), or check a file they pick (preview is null when they
  // close the picker) and, once they agree, swap it in and sign its owner in.
  localExportWorld?(): Promise<Result<{ saved: boolean; file: string; bytes: number }>>;
  localImportPick?(): Promise<Result<{ preview: WorldPreview | null }>>;
  localImportCommit?(): Promise<Result<{ owner: string }>>;
  localImportCancel?(): Promise<void>;
  appInfo(): Promise<AppInfo>;
  // Troubleshooting (Settings): the server files the app unpacked, checked
  // against the ones it shipped with; unpacked again with everything the
  // player made kept (and the world started again when it was awake or had
  // failed); the files cached from servers cleared, sign-ins and storage
  // left alone; a summary for a bug report, with nothing private in it; and
  // the folder the logs are in. Each is absent where a shell has no such
  // thing (the phone checks nothing and keeps no log folder to open), so
  // the row is withheld rather than dead.
  localVerify?(): Promise<Result<{ report: VerifyReport | null }>>;
  localRepair?(): Promise<Result<RepairResult>>;
  clearCaches?(): Promise<Result<{ sessions: number }>>;
  diagnosticSummary?(): Promise<{ text: string }>;
  showLogs?(): Promise<void>;
  // Starting over: everything the app keeps set aside (never deleted) and
  // the app restarted empty, once the typed word matches RESET_PHRASE.
  // Desktop only; the phone's system settings clear an app's storage.
  resetApp?(phrase: string): Promise<Result>;
  // The Steam Deck layout switch in Settings; answers with the info as it
  // stands after the change. Desktop only.
  setDeckChoice?(choice: DeckChoice): Promise<DeckInfo>;
  // Steam's on-screen keyboard over a text field (field in CSS pixels of
  // this window), or put away. A no-op unless Steam runs the session.
  steamKeyboard?(open: boolean, field?: FieldRect, multiline?: boolean): Promise<void>;
  // This install into the Steam library as a non-Steam game, with its
  // artwork (Settings, Steam Deck and controllers). Desktop only.
  addToSteam?(restart: boolean): Promise<SteamAddResult>;
  // The same offered once at first launch, on a Steam Deck in Desktop Mode:
  // whether to offer it now, and that the player answered.
  steamOffer?(): Promise<boolean>;
  answerSteamOffer?(): Promise<void>;
  updateCheck(): Promise<Result<{ update: UpdateStatus }>>;
  updateInstall(): Promise<Result>;
  onEvent(listener: (event: ShellEvent) => void): void;
}
