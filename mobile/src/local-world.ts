import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type {
  AiModelsResult,
  AiSetup,
  ConnectResult,
  LocalStatus,
  NarrationChoice,
  NarrationStatus,
  RepairResult,
  Result,
  SavedAi,
  ShellEvent,
  SoundLibraryStatus,
} from "../../src/shared/types";
import { narrationSample, readNarration, saveNarration, soundLibrary, type WorldAdmin } from "../../src/shared/world-media";
import {
  NO_SAVED_AI,
  STORY_MODELS_PATH,
  saveOpenAiDoor,
  currentAiSummary,
  savedAiFrom,
  storyModelsFrom,
  storyModelsRequest,
} from "../../src/shared/ai-setup";
import {
  commitWorldImport,
  discardWorldTransfer,
  exportFileName,
  runWorldJob,
  type WorldPreview,
  type WorldRequest,
} from "../../src/shared/world-transfer";

// The device-hosted world: the same server the desktop app bundles, run by a
// Node runtime inside this app (see android/.../WorldRuntime.java) and
// reached over http://127.0.0.1. This module mirrors the desktop shell's
// local flow (src/main/ipc.ts): a profile that feels like no account at
// all, silent re-login from a kept secret, and the one-time AI choice.

export interface WorldStatus {
  available: boolean;
  state: "unavailable" | "stopped" | "starting" | "running" | "stopping" | "error";
  origin: string;
  lanOrigin: string;
  firstRun: boolean;
  serverVersion: string;
  error: string;
  // The code the running world's first account must send (WorldRuntime
  // works it out and hands it to the server). Absent on an older native
  // side, whose worlds do not ask for one.
  setupCode?: string;
  // Whether the world answers on the Wi-Fi (WorldRuntime.setLanSharing).
  sharedOnLan?: boolean;
}

// What the native side reports on its own (LocalWorldPlugin's worldEvent):
// the Node server or cloudflared leaving after they started, or a stop
// finishing. Without it JS only learns of a dead server or tunnel on its
// next status call, while the notification and the room codes keep
// advertising an address nobody answers at.
export interface WorldEvent {
  source: "world" | "tunnel";
  state: "running" | "stopped" | "error";
  message?: string;
}

// The facts behind Troubleshooting's summary (WorldRuntime.diagnostics):
// the payload this build ships and the one unpacked, what of the world's
// data is on disk, the ids of the installed world packs.
export interface WorldDiagnostics {
  payload: { serverVersion: string; builtAt: string } | null;
  runTree: { serverVersion: string; builtAt: string } | null;
  dbPresent: boolean;
  keyPresent: boolean;
  packs: string[];
}

export interface LocalWorldPlugin {
  status(): Promise<WorldStatus>;
  start(): Promise<WorldStatus>;
  stop(): Promise<WorldStatus>;
  log(): Promise<{ text: string }>;
  // Troubleshooting (WorldRuntime.repair, WorldRuntime.diagnostics): the
  // server files unpacked again with the player's folders kept, and the
  // world started again when it was awake or had failed; and the facts for
  // the summary. Absent on an older native side.
  repair?(): Promise<WorldStatus & { started: boolean }>;
  // Sharing on the Wi-Fi (WorldRuntime.setLanSharing): a running world
  // restarts on the same port. Absent on an older native side.
  lanSharing?(options: { on: boolean }): Promise<WorldStatus>;
  diagnostics?(): Promise<WorldDiagnostics>;
  // Moving the world (LocalWorldPlugin.java): copy a picked archive beside
  // the world's database ({ name: "" } when the picker is closed), or copy a
  // packed one to where the person chooses.
  pickArchive?(): Promise<{ name: string }>;
  saveArchive?(options: { name: string; suggested: string }): Promise<{ saved: boolean; label?: string }>;
  // Capacitor's event channel; optional so a fake plugin need not have one.
  addListener?(
    eventName: "worldEvent",
    listener: (event: WorldEvent) => void,
  ): Promise<PluginListenerHandle>;
}

export function parseWorldEvent(raw: unknown): WorldEvent | null {
  const event = raw as { source?: unknown; state?: unknown; message?: unknown } | null;
  if (!event || typeof event !== "object") return null;
  if (event.source !== "world" && event.source !== "tunnel") return null;
  if (event.state !== "running" && event.state !== "stopped" && event.state !== "error") return null;
  return {
    source: event.source,
    state: event.state,
    message: typeof event.message === "string" ? event.message.slice(0, 300) : "",
  };
}

export const LocalWorld = registerPlugin<LocalWorldPlugin>("LocalWorld");

// The on-device account. secret is the password the shell minted for a
// name-only profile (empty when the player chose their own), so an expired
// token renews without a form.
export interface LocalProfile {
  username: string;
  secret: string;
  token: string;
  tokenExpiresAt: string;
}

export interface TokenGrant {
  token: string;
  expiresAt: string;
  username: string;
}

export interface LocalWorldDeps {
  plugin: LocalWorldPlugin;
  // A JSON round trip that reports bad statuses instead of throwing.
  fetchJson?(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number },
  ): Promise<{ status: number; data: unknown }>;
  loadProfile(): Promise<LocalProfile | null>;
  saveProfile(profile: LocalProfile | null): Promise<void>;
  loginForToken(origin: string, username: string, password: string): Promise<TokenGrant>;
  registerAccount(
    origin: string,
    input: { username: string; password: string; inviteCode: string; setupCode?: string },
  ): Promise<TokenGrant>;
  tokenIsValid(origin: string, token: string): Promise<boolean>;
  patchAdminSettings(origin: string, token: string, patch: object): Promise<void>;
  getAdminSettings(origin: string, token: string): Promise<unknown>;
  // One of the world's admin routes that takes and answers JSON (the model
  // listings the OpenAI door asks); a refusal throws.
  postAdmin(origin: string, token: string, path: string, body: object): Promise<unknown>;
  // One read with a GET (the sound library's state); a refusal throws.
  getAdmin?(origin: string, token: string, path: string): Promise<unknown>;
  // Plants the session and opens the world's pages in the game webview.
  open(origin: string, token: string, joinCode: string, path: string): Promise<void>;
  // Plants the session alone. The bridge's own requests share the webview's
  // cookies and the server reads the cookie before a bearer token, so after
  // an import the replaced world's cookie would sign every one of them out.
  plantSession?(origin: string, token: string): Promise<void>;
  emit(event: ShellEvent): void;
  randomSecret(): string;
  // The public address while the world is shared through a tunnel, "" when
  // it is not; invite links prefer it over the Wi-Fi address.
  currentShareUrl?(): string;
}


export function tokenAlive(profile: LocalProfile | null): boolean {
  if (!profile?.token) return false;
  return !profile.tokenExpiresAt || Date.parse(profile.tokenExpiresAt) > Date.now();
}

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : "Something went wrong." };
}

export function createLocalWorld(deps: LocalWorldDeps) {
  async function status(): Promise<LocalStatus> {
    const world = await deps.plugin.status().catch(
      (): WorldStatus => ({
        available: false,
        state: "unavailable",
        origin: "",
        lanOrigin: "",
        firstRun: true,
        serverVersion: "",
        error: "",
      }),
    );
    const profile = await deps.loadProfile();
    return {
      state: world.available ? (world.state === "stopping" ? "stopped" : world.state) : "unavailable",
      origin: world.state === "running" ? world.origin : "",
      firstRun: world.firstRun,
      hasAccount: tokenAlive(profile),
      username: profile?.username ?? "",
      serverVersion: world.serverVersion,
      error: world.error,
      lanOrigin: world.state === "running" ? world.lanOrigin : "",
    };
  }

  async function announce(): Promise<void> {
    deps.emit({ kind: "local-status", status: await status() });
  }

  // Starts the server if needed and returns its local origin.
  async function start(): Promise<string> {
    const current = await deps.plugin.status();
    if (current.state === "running" && current.origin) return current.origin;
    deps.emit({ kind: "local-status", status: { ...(await status()), state: "starting" } });
    try {
      const started = await deps.plugin.start();
      if (started.state !== "running" || !started.origin) {
        throw new Error(started.error || "The world did not start.");
      }
      return started.origin;
    } finally {
      await announce();
    }
  }

  // Where invite links and QR codes made inside the game should point: the
  // tunnel while one runs (the host plays on 127.0.0.1, an address guests
  // cannot reach), otherwise the device's Wi-Fi address.
  async function publicAddress(): Promise<string> {
    const shared = deps.currentShareUrl?.() ?? "";
    if (shared) return shared;
    const world = await deps.plugin.status().catch(() => null);
    return world?.lanOrigin ?? "";
  }

  // Device worlds always run mesh voice (no media server here, and it is
  // the only transport that survives a tunnel) and keep publicUrl true.
  // Best effort, like the desktop shell's equivalents.
  async function settleWorldSettings(origin: string, token: string): Promise<void> {
    const patch: Record<string, unknown> = { voiceChat: { enabled: "on", mode: "mesh" } };
    const address = await publicAddress();
    if (address) patch.publicUrl = address;
    await deps.patchAdminSettings(origin, token, patch).catch(() => undefined);
  }

  // Called by the share tunnel as it comes and goes. Going public must not
  // mean open registration on a personal device: invite mode still lets
  // invited friends sign up, since a live room code vouches for them.
  async function publish(shareUrl: string): Promise<void> {
    const world = await deps.plugin.status().catch(() => null);
    if (!world || world.state !== "running" || !world.origin) return;
    const profile = await liveToken(world.origin);
    if (!profile) return;
    const patch: Record<string, unknown> = {
      publicUrl: shareUrl || world.lanOrigin || "",
      voiceChat: { enabled: "on", mode: "mesh" },
    };
    if (shareUrl) patch.signupMode = "invite";
    await deps.patchAdminSettings(world.origin, profile.token, patch).catch(() => undefined);
  }

  async function adopt(grant: TokenGrant, secret: string): Promise<LocalProfile> {
    const profile: LocalProfile = {
      username: grant.username,
      secret,
      token: grant.token,
      tokenExpiresAt: grant.expiresAt,
    };
    await deps.saveProfile(profile);
    return profile;
  }

  // A live token for the profile, renewing silently from the kept secret;
  // null when the player must sign in (or does not exist yet).
  async function liveToken(origin: string): Promise<LocalProfile | null> {
    const profile = await deps.loadProfile();
    if (!profile) return null;
    if (tokenAlive(profile) && (await deps.tokenIsValid(origin, profile.token))) return profile;
    if (profile.secret) {
      try {
        const grant = await deps.loginForToken(origin, profile.username, profile.secret);
        return await adopt(grant, profile.secret);
      } catch {
        // Password changed inside the game; fall through to the form.
      }
    }
    return null;
  }

  // Whether the running world still waits for its owner's account, as the
  // world itself says (needsSetup on /api/auth/providers): a database left
  // by a start that never finished is no owner. Null when it cannot say.
  async function awaitsOwner(origin: string): Promise<boolean | null> {
    if (!deps.fetchJson) return null;
    const answer = await deps.fetchJson(`${origin}/api/auth/providers`, { timeoutMs: 10_000 }).catch(() => null);
    const data = answer?.status === 200 ? (answer.data as { needsSetup?: unknown } | null) : null;
    return typeof data?.needsSetup === "boolean" ? data.needsSetup : null;
  }

  async function play(joinCode: string, path = ""): Promise<ConnectResult> {
    let origin: string;
    let freshWorld: boolean;
    try {
      freshWorld = (await deps.plugin.status()).firstRun;
      origin = await start();
    } catch (err) {
      return { ok: false, needsLogin: false, error: fail(err).error };
    }
    const profile = await liveToken(origin);
    if (!profile) {
      // A world with no owner yet asks who is playing; one whose owner
      // exists asks for the account behind it. The world says which; the
      // database file and the kept profile decide only when it cannot.
      if ((await awaitsOwner(origin)) ?? (freshWorld || !(await deps.loadProfile()))) {
        return { ok: true, firstSetup: true, needsName: true };
      }
      return { ok: false, needsLogin: true, error: "Sign in to your world." };
    }
    await settleWorldSettings(origin, profile.token);
    await deps.open(origin, profile.token, joinCode, path);
    return { ok: true };
  }

  // Empty password means "mint one for me": the profile then behaves like
  // no account at all and renews itself. A chosen password is never kept.
  async function createAccount(input: {
    username: string;
    password: string;
  }): Promise<Result<{ status: LocalStatus }>> {
    try {
      const origin = await start();
      const minted = !input.password;
      const password = minted ? deps.randomSecret() : input.password;
      // The world listens on the Wi-Fi from the moment it starts, before
      // this account exists; the code is what makes this registration, and
      // not a neighbour's, the one that owns it.
      const setupCode = (await deps.plugin.status().catch(() => null))?.setupCode ?? "";
      // A made-up password is kept before the world hears it, so a
      // registration whose answer (or the sign-in after it) is lost leaves
      // the profile able to sign in to the account it made.
      if (minted) await deps.saveProfile({ username: input.username, secret: password, token: "", tokenExpiresAt: "" });
      const grant = await deps.registerAccount(origin, {
        username: input.username,
        password,
        inviteCode: "",
        setupCode,
      });
      const profile = await adopt(grant, minted ? password : "");
      await settleWorldSettings(origin, profile.token);
      return { ok: true, status: await status() };
    } catch (err) {
      return fail(err);
    }
  }

  async function login(input: {
    username: string;
    password: string;
  }): Promise<Result<{ status: LocalStatus }>> {
    try {
      const origin = await start();
      const grant = await deps.loginForToken(origin, input.username, input.password);
      await adopt(grant, "");
      return { ok: true, status: await status() };
    } catch (err) {
      return fail(err);
    }
  }

  async function configureAi(setup: AiSetup): Promise<Result<{ notice?: string }>> {
    try {
      const origin = await start();
      const profile = await liveToken(origin);
      if (!profile) return fail(new Error("Set up your profile first."));
      const token = profile.token;
      if (setup.choice === "human") {
        await deps.patchAdminSettings(origin, token, { text: { provider: "none" } });
        return { ok: true };
      }
      if (setup.choice !== "openai") return { ok: true };
      // The key and the storyteller, then the picture and transcription
      // models from the key's own list, as the desktop shell saves them.
      const saved = await saveOpenAiDoor(setup, {
        settings: () => deps.getAdminSettings(origin, token),
        patch: (patch) => deps.patchAdminSettings(origin, token, patch),
        post: (path, body) => deps.postAdmin(origin, token, path, body),
      });
      if ("error" in saved) return fail(new Error(saved.error));
      return { ok: true, ...(saved.notice ? { notice: saved.notice } : {}) };
    } catch (err) {
      return fail(err);
    }
  }

  // The storyteller models the OpenAI key lists, for the form's model
  // fields: the typed key, or the device's saved one when none is typed.
  async function aiModels(apiKey: string): Promise<AiModelsResult> {
    try {
      const origin = await start();
      const profile = await liveToken(origin);
      if (!profile) return fail(new Error("Set up your profile first."));
      return storyModelsFrom(await deps.postAdmin(origin, profile.token, STORY_MODELS_PATH, storyModelsRequest(apiKey)));
    } catch (err) {
      return fail(err);
    }
  }

  // What the OpenAI form shows as already saved on this device. Never
  // throws: a world that is not up yet simply has nothing saved to show.
  async function aiSaved(): Promise<SavedAi> {
    try {
      const origin = await start();
      const profile = await liveToken(origin);
      if (!profile) return NO_SAVED_AI;
      const settings = await deps.getAdminSettings(origin, profile.token);
      const summary = currentAiSummary(settings);
      return summary ? { ...savedAiFrom(settings), summary } : savedAiFrom(settings);
    } catch {
      return NO_SAVED_AI;
    }
  }

  // Narration and the sound library (src/shared/world-media.ts), from
  // Settings, as the desktop shell asks them: the world woken when it is
  // asleep and asked through the routes its own admin page uses.
  async function worldAdmin(): Promise<WorldAdmin> {
    const origin = await start();
    const profile = await liveToken(origin);
    if (!profile) throw new Error("Set up your profile first.");
    const token = profile.token;
    const get = deps.getAdmin;
    return {
      settings: () => deps.getAdminSettings(origin, token),
      patch: (patch) => deps.patchAdminSettings(origin, token, patch),
      post: (path, body) => deps.postAdmin(origin, token, path, body),
      get: (path) => (get ? get(origin, token, path) : Promise.reject(new Error("Update the app to read this."))),
    };
  }

  async function narration(): Promise<Result<{ narration: NarrationStatus }>> {
    try {
      return { ok: true, narration: await readNarration(await worldAdmin()) };
    } catch (err) {
      return fail(err);
    }
  }

  async function setNarration(choice: NarrationChoice): Promise<Result<{ narration: NarrationStatus; notice?: string }>> {
    try {
      const saved = await saveNarration(choice, await worldAdmin());
      if ("error" in saved) return fail(new Error(saved.error));
      return { ok: true, narration: saved.narration, ...(saved.notice ? { notice: saved.notice } : {}) };
    } catch (err) {
      return fail(err);
    }
  }

  async function sample(): Promise<Result<{ audio: string }>> {
    try {
      const answer = await narrationSample(await worldAdmin());
      return "error" in answer ? fail(new Error(answer.error)) : { ok: true, audio: answer.audio };
    } catch (err) {
      return fail(err);
    }
  }

  async function sounds(install: boolean): Promise<Result<{ library: SoundLibraryStatus }>> {
    try {
      return { ok: true, library: await soundLibrary(install, await worldAdmin()) };
    } catch (err) {
      return fail(err);
    }
  }

  async function stop(): Promise<void> {
    await deps.plugin.stop().catch(() => undefined);
    await announce();
  }

  // Native news about the world and the tunnel. A world that went down is
  // announced as a local-status so the home screen shows it and can offer
  // a restart; every event then reaches the caller, whose tunnel side
  // settles the rest.
  function watch(onEvent: (event: WorldEvent) => void): void {
    const plugin = deps.plugin;
    if (typeof plugin.addListener !== "function") return;
    void plugin
      .addListener("worldEvent", (raw) => {
        const event = parseWorldEvent(raw);
        if (!event) return;
        if (event.source === "world") void announce();
        onEvent(event);
      })
      .catch(() => undefined);
  }

  // Moving the world (src/shared/world-transfer.ts), the way the desktop
  // shell does it (src/main/ipc.ts local:export-world and its neighbours).
  // A world nobody has entered yet gets its owner profile first, so a new
  // phone can take in a world straight away; the import replaces it anyway.
  async function ownerSession(): Promise<{ origin: string; request: WorldRequest }> {
    const fetchJson = deps.fetchJson;
    if (!fetchJson) throw new Error("This build cannot move worlds.");
    const fresh = (await deps.plugin.status()).firstRun;
    const origin = await start();
    let profile = await liveToken(origin);
    if (!profile && ((await awaitsOwner(origin)) ?? (fresh || !(await deps.loadProfile())))) {
      const made = await createAccount({ username: "player", password: "" });
      if (!made.ok) throw new Error(made.error);
      profile = await liveToken(origin);
    }
    if (!profile) throw new Error("Sign in to your world first, then try again.");
    const token = profile.token;
    // A cookie left from another session would win over the bearer token.
    await deps.plantSession?.(origin, token);
    return {
      origin,
      request: (method, body) =>
        fetchJson(`${origin}/api/admin/world`, { method, headers: { authorization: `Bearer ${token}` }, body, timeoutMs: 30_000 }),
    };
  }

  const phase = (text: string) => deps.emit({ kind: "world-transfer", phase: text });
  // The checked archive waiting for the person's yes.
  let pendingImport = "";

  async function exportWorld(): Promise<Result<{ saved: boolean; file: string; bytes: number }>> {
    try {
      const save = deps.plugin.saveArchive;
      if (!save) throw new Error("This build cannot move worlds.");
      const { request } = await ownerSession();
      const job = await runWorldJob(request, { action: "export" }, phase);
      if (!job.export) throw new Error("The world was packed, but the file is missing.");
      phase("Saving");
      const saved = await save({ name: job.export.name, suggested: exportFileName(job.export) }).finally(() =>
        discardWorldTransfer(request),
      );
      return { ok: true, saved: saved.saved, file: saved.label ?? "", bytes: saved.saved ? job.export.bytes : 0 };
    } catch (err) {
      return fail(err);
    }
  }

  async function importPick(): Promise<Result<{ preview: WorldPreview | null }>> {
    try {
      const pick = deps.plugin.pickArchive;
      if (!pick) throw new Error("This build cannot move worlds.");
      const { request } = await ownerSession();
      await discardWorldTransfer(request);
      pendingImport = "";
      const picked = await pick();
      if (!picked.name) return { ok: true, preview: null };
      try {
        const job = await runWorldJob(request, { action: "check", name: picked.name }, phase);
        pendingImport = picked.name;
        return { ok: true, preview: job.preview };
      } catch (err) {
        await discardWorldTransfer(request);
        throw err;
      }
    } catch (err) {
      return fail(err);
    }
  }

  async function importCommit(): Promise<Result<{ owner: string }>> {
    try {
      if (!pendingImport) throw new Error("Pick a world file first.");
      const { request } = await ownerSession();
      const secret = deps.randomSecret();
      phase("Swapping your world in");
      const { owner } = await commitWorldImport(request, pendingImport, secret);
      pendingImport = "";
      phase("Restarting your world");
      await deps.plugin.stop();
      const origin = await start();
      const profile = await adopt(await deps.loginForToken(origin, owner, secret), secret);
      await deps.plantSession?.(origin, profile.token);
      await announce();
      return { ok: true, owner };
    } catch (err) {
      return fail(err);
    }
  }

  async function importCancel(): Promise<void> {
    pendingImport = "";
    const world = await deps.plugin.status().catch(() => null);
    const profile = await deps.loadProfile();
    if (world?.state === "running" && world.origin && profile?.token && deps.fetchJson) {
      const fetchJson = deps.fetchJson;
      await discardWorldTransfer((method, body) =>
        fetchJson(`${world.origin}/api/admin/world`, { method, headers: { authorization: `Bearer ${profile.token}` }, body }),
      );
    }
  }

  // Unpacks the server files again, keeping everything the player made
  // (WorldRuntime.repair), the way the desktop's Troubleshooting does; the
  // world comes back when it was awake or had failed. The phone's payload
  // carries no manifest, so nothing is checked first (found is null).
  async function repair(): Promise<Result<RepairResult>> {
    const plugin = deps.plugin;
    if (!plugin.repair) return fail(new Error("This version of the app cannot repair its world."));
    try {
      const status = await plugin.repair();
      return { ok: true, found: null, started: status.started === true };
    } catch (err) {
      return fail(err);
    } finally {
      await announce();
    }
  }

  // Wi-Fi sharing, as on the desktop (src/main/ipc.ts setLanSharing): the
  // world answers on the phone alone until the player shares it on the
  // Wi-Fi. In-game invites follow the address (publish).
  async function setLanSharing(on: boolean): Promise<Result<{ status: LocalStatus }>> {
    const plugin = deps.plugin;
    if (!plugin.lanSharing) return fail(new Error("This version of the app cannot share on the Wi-Fi."));
    try {
      await plugin.lanSharing({ on });
      await publish(deps.currentShareUrl?.() ?? "");
      return { ok: true, status: await status() };
    } catch (err) {
      return fail(err);
    } finally {
      await announce();
    }
  }

  async function diagnostics(): Promise<WorldDiagnostics | null> {
    const plugin = deps.plugin;
    if (!plugin.diagnostics) return null;
    return plugin.diagnostics().catch(() => null);
  }

  return {
    status,
    start,
    play,
    createAccount,
    login,
    configureAi,
    aiSaved,
    aiModels,
    narration,
    setNarration,
    sample,
    sounds,
    stop,
    publish,
    watch,
    exportWorld,
    importPick,
    importCommit,
    importCancel,
    repair,
    setLanSharing,
    diagnostics,
  };
}
