import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLocalWorld,
  type LocalProfile,
  type LocalWorldDeps,
  type WorldStatus,
} from "../src/local-world";

// The phone-hosted world's account flow, against a fake plugin and API.

function harness(overrides: {
  world?: Partial<WorldStatus>;
  profile?: LocalProfile | null;
  tokenValid?: boolean;
  loginFails?: boolean;
  registerFails?: boolean;
  // What the world says of its owner (needsSetup); absent, it cannot say.
  awaitsOwner?: boolean;
  adminSettings?: unknown;
  // What the world's admin listings answer, by path and role (a model
  // listing's `recommended`, or the setup's story listing).
  listings?: (path: string, body: { role?: string }) => unknown;
} = {}) {
  const world: WorldStatus = {
    available: true,
    state: "stopped",
    origin: "",
    lanOrigin: "",
    firstRun: true,
    serverVersion: "0.12.1",
    error: "",
    ...overrides.world,
  };
  let profile: LocalProfile | null = overrides.profile ?? null;
  const calls: string[] = [];
  const opened: string[] = [];
  const patches: object[] = [];
  const posted: Array<{ path: string; body: object }> = [];
  const deps: LocalWorldDeps = {
    plugin: {
      status: async () => ({ ...world }),
      start: async () => {
        calls.push("start");
        world.state = "running";
        world.origin = "http://127.0.0.1:3210";
        world.lanOrigin = "http://192.168.1.9:3210";
        return { ...world };
      },
      stop: async () => {
        world.state = "stopped";
        world.origin = "";
        return { ...world };
      },
      log: async () => ({ text: "" }),
    },
    loadProfile: async () => profile,
    saveProfile: async (next) => {
      profile = next;
    },
    loginForToken: async (_origin, username, password) => {
      calls.push(`login:${username}:${password}`);
      if (overrides.loginFails) throw new Error("Wrong username or password.");
      return { token: "tok-relogin", expiresAt: "2030-01-01T00:00:00.000Z", username };
    },
    registerAccount: async (_origin, input) => {
      calls.push(`register:${input.username}:${input.password}`);
      if (overrides.registerFails) throw new Error("The world did not answer.");
      return { token: "tok-new", expiresAt: "2030-01-01T00:00:00.000Z", username: input.username };
    },
    tokenIsValid: async () => overrides.tokenValid ?? false,
    patchAdminSettings: async (_origin, _token, patch) => {
      patches.push(patch);
    },
    getAdminSettings: async () => overrides.adminSettings ?? null,
    postAdmin: async (_origin, _token, path, body) => {
      posted.push({ path, body });
      return overrides.listings ? overrides.listings(path, body as { role?: string }) : { models: [], recommended: "" };
    },
    open: async (origin, token, joinCode) => {
      opened.push(`${origin}|${token}|${joinCode}`);
    },
    emit: () => undefined,
    randomSecret: () => "minted-secret",
    ...(overrides.awaitsOwner === undefined
      ? {}
      : {
          fetchJson: async (url: string) =>
            url.endsWith("/api/auth/providers")
              ? { status: 200, data: { needsSetup: overrides.awaitsOwner } }
              : { status: 404, data: null },
        }),
  };
  return { deps, calls, opened, patches, posted, profile: () => profile, world };
}

test("a fresh world starts the server and asks for a name", async () => {
  const h = harness();
  const result = await createLocalWorld(h.deps).play("");
  assert.deepEqual(result, { ok: true, firstSetup: true, needsName: true });
  assert.deepEqual(h.calls, ["start"]);
  assert.equal(h.opened.length, 0);
});

test("a name-only profile mints and keeps a secret, then plays with it", async () => {
  const h = harness({ tokenValid: true });
  const world = createLocalWorld(h.deps);
  const created = await world.createAccount({ username: "kaleb", password: "" });
  assert.equal(created.ok, true);
  assert.equal(h.profile()?.secret, "minted-secret");
  assert.equal(h.calls.at(-1), "register:kaleb:minted-secret");
  // Mesh voice and the Wi-Fi address were written to the world's settings.
  assert.deepEqual(h.patches.at(-1), {
    voiceChat: { enabled: "on", mode: "mesh" },
    publicUrl: "http://192.168.1.9:3210",
  });
  h.world.firstRun = false;
  const played = await world.play("ABCDEF");
  assert.deepEqual(played, { ok: true });
  assert.equal(h.opened.at(-1), "http://127.0.0.1:3210|tok-new|ABCDEF");
});

test("a chosen password is never kept", async () => {
  const h = harness();
  await createLocalWorld(h.deps).createAccount({ username: "kaleb", password: "hunter2" });
  assert.equal(h.profile()?.secret, "");
  assert.equal(h.calls.at(-1), "register:kaleb:hunter2");
});

test("an expired token renews silently from the kept secret", async () => {
  const h = harness({
    world: { firstRun: false },
    profile: { username: "kaleb", secret: "s3cret", token: "old", tokenExpiresAt: "2000-01-01T00:00:00.000Z" },
  });
  const result = await createLocalWorld(h.deps).play("");
  assert.deepEqual(result, { ok: true });
  assert.ok(h.calls.includes("login:kaleb:s3cret"));
  assert.equal(h.profile()?.token, "tok-relogin");
  assert.equal(h.opened.at(-1), "http://127.0.0.1:3210|tok-relogin|");
});

test("a dead token with no secret asks for a sign-in on an existing world", async () => {
  const h = harness({
    world: { firstRun: false },
    profile: { username: "kaleb", secret: "", token: "old", tokenExpiresAt: "2000-01-01T00:00:00.000Z" },
  });
  const result = await createLocalWorld(h.deps).play("");
  assert.deepEqual(result, { ok: false, needsLogin: true, error: "Sign in to your world." });
});

test("a rejected secret falls back to the sign-in form", async () => {
  const h = harness({
    world: { firstRun: false },
    profile: { username: "kaleb", secret: "stale", token: "", tokenExpiresAt: "" },
    loginFails: true,
  });
  const result = await createLocalWorld(h.deps).play("");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.needsLogin, true);
});

test("a world whose database exists but has no account yet asks who is playing, whatever profile is kept", async () => {
  // A first start that never finished left the database; the world says it
  // has no owner, so the kept profile's rejected password is no account.
  const h = harness({
    world: { firstRun: false },
    profile: { username: "kaleb", secret: "lost", token: "", tokenExpiresAt: "" },
    loginFails: true,
    awaitsOwner: true,
  });
  assert.deepEqual(await createLocalWorld(h.deps).play(""), { ok: true, firstSetup: true, needsName: true });
});

test("a world with an owner and no kept profile asks for a sign-in, not a name it would refuse", async () => {
  const h = harness({ world: { firstRun: false }, awaitsOwner: false });
  assert.deepEqual(await createLocalWorld(h.deps).play(""), { ok: false, needsLogin: true, error: "Sign in to your world." });
});

test("a made-up password is kept before the world hears it, so a lost answer still signs in next time", async () => {
  const h = harness({ registerFails: true, tokenValid: true });
  const world = createLocalWorld(h.deps);
  const created = await world.createAccount({ username: "kaleb", password: "" });
  assert.equal(created.ok, false);
  assert.deepEqual(h.profile(), { username: "kaleb", secret: "minted-secret", token: "", tokenExpiresAt: "" });
  h.world.firstRun = false;
  assert.deepEqual(await world.play(""), { ok: true });
  assert.ok(h.calls.includes("login:kaleb:minted-secret"));
});

test("status reports the world and the profile together", async () => {
  const h = harness({
    world: { state: "running", origin: "http://127.0.0.1:3210", lanOrigin: "http://192.168.1.9:3210", firstRun: false },
    profile: { username: "kaleb", secret: "", token: "t", tokenExpiresAt: "2030-01-01T00:00:00.000Z" },
  });
  const status = await createLocalWorld(h.deps).status();
  assert.equal(status.state, "running");
  assert.equal(status.username, "kaleb");
  assert.equal(status.hasAccount, true);
  assert.equal(status.lanOrigin, "http://192.168.1.9:3210");
});

test("a build without a runtime reports the world as unavailable", async () => {
  const h = harness({ world: { available: false } });
  const status = await createLocalWorld(h.deps).status();
  assert.equal(status.state, "unavailable");
});

test("native world events announce a status for the world and reach the caller", async () => {
  const h = harness({ world: { state: "running", origin: "http://127.0.0.1:3210", firstRun: false } });
  const emitted: string[] = [];
  h.deps.emit = (event) => emitted.push(event.kind === "local-status" ? `local:${event.status.state}` : event.kind);
  let fire: (event: unknown) => void = () => undefined;
  h.deps.plugin.addListener = async (_name, listener) => {
    fire = listener as (event: unknown) => void;
    return { remove: async () => undefined };
  };
  const seen: string[] = [];
  createLocalWorld(h.deps).watch((event) => seen.push(`${event.source}:${event.state}:${event.message ?? ""}`));
  await new Promise((resolve) => setTimeout(resolve, 0));
  h.world.state = "error";
  h.world.error = "The world stopped unexpectedly.";
  fire({ source: "world", state: "error", message: "The world stopped unexpectedly." });
  fire({ source: "tunnel", state: "stopped" });
  fire({ source: "nonsense" });
  fire(null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, ["world:error:The world stopped unexpectedly.", "tunnel:stopped:"]);
  assert.deepEqual(emitted, ["local:error"]);
});

test("watch is a no-op on a plugin without an event channel", () => {
  const h = harness();
  assert.doesNotThrow(() => createLocalWorld(h.deps).watch(() => undefined));
});

// Story AI's OpenAI door: the key is the device's, saved once in the world's
// admin settings, where every campaign on the phone follows it.
const SIGNED_IN = {
  world: { state: "running" as const, origin: "http://127.0.0.1:3210", firstRun: false },
  profile: { username: "kaleb", secret: "", token: "t", tokenExpiresAt: "2030-01-01T00:00:00.000Z" },
  tokenValid: true,
};

test("the first OpenAI key is saved for the whole device, text and pictures", async () => {
  const h = harness({
    ...SIGNED_IN,
    listings: (_path, body) => ({ models: [], recommended: body.role === "image" ? "listed-painter" : body.role === "dictation" ? "listed-ears" : "" }),
  });
  const world = createLocalWorld(h.deps);
  assert.deepEqual(await world.aiSaved(), { keySaved: false, model: "", utilityModel: "" });
  const blank = await world.configureAi({ choice: "openai", apiKey: " ", model: "my-storyteller", utilityModel: "" });
  assert.equal(blank.ok, false, "no key saved yet, so a blank one is refused");
  // No model is invented for the player (the server names none either).
  const unpicked = await world.configureAi({ choice: "openai", apiKey: "sk-1", model: "", utilityModel: "" });
  assert.equal(unpicked.ok, false);
  assert.equal(h.patches.length, 0);
  const saved = await world.configureAi({ choice: "openai", apiKey: "sk-1", model: "my-storyteller", utilityModel: "" });
  assert.deepEqual(saved, { ok: true });
  const patch = h.patches[0] as { text: Record<string, string>; images: Record<string, string> };
  assert.equal(patch.text.customApiKey, "sk-1");
  assert.equal(patch.text.utilityApiKey, "sk-1");
  assert.equal(patch.text.customModel, "my-storyteller");
  assert.equal(patch.images.openaiApiKey, "sk-1");
  assert.equal(patch.images.defaultBackend, "openai");
  // Then the picture and transcription models, from the key's own list on
  // the world's server, so a phone's only painter works straight away.
  assert.deepEqual(h.patches[1], { images: { openaiModel: "listed-painter" }, speech: { sttOpenaiModel: "listed-ears" } });
  assert.deepEqual(h.posted.map((entry) => entry.path), ["/api/admin/models", "/api/admin/models"]);
});

test("a key whose list settles no picture model is saved, and the player is told where to pick one", async () => {
  const h = harness({ ...SIGNED_IN, listings: () => ({ models: [], recommended: "" }) });
  const result = await createLocalWorld(h.deps).configureAi({ choice: "openai", apiKey: "sk-1", model: "my-storyteller", utilityModel: "" });
  assert.equal(result.ok, true);
  assert.match(result.ok ? result.notice ?? "" : "", /Admin > Image generation/);
  assert.equal(h.patches.length, 1, "only the key and the storyteller were saved");
});

test("the form lists the storyteller models the key offers", async () => {
  const h = harness({
    ...SIGNED_IN,
    listings: (path) => (path === "/api/admin/setup" ? { ok: true, models: [{ id: "model-a", label: "Model A" }], recommended: "model-a" } : null),
  });
  const listed = await createLocalWorld(h.deps).aiModels(" sk-typed ");
  assert.deepEqual(listed, { ok: true, models: [{ id: "model-a", label: "Model A" }], recommended: "model-a" });
  assert.deepEqual(h.posted.at(-1), { path: "/api/admin/setup", body: { action: "models", provider: "openai", apiKey: "sk-typed" } });
});

test("changing the model keeps the key the device already holds", async () => {
  const h = harness({
    ...SIGNED_IN,
    adminSettings: {
      config: {
        text: {
          provider: "custom",
          customBaseUrl: "https://api.openai.com/v1",
          customModel: "gpt-5.1",
          utilityModel: "gpt-5-mini",
          hasCustomApiKey: true,
        },
      },
    },
  });
  const world = createLocalWorld(h.deps);
  assert.deepEqual(await world.aiSaved(), {
    keySaved: true,
    model: "gpt-5.1",
    utilityModel: "gpt-5-mini",
    // Story AI opens on what is already set (client PR 62).
    summary: {
      story: "OpenAI tells the story (gpt-5.1), on your key.",
      pictures: "Painted placeholders until something can paint.",
      narration: "Read aloud when a speech engine is found here.",
    },
  });
  const result = await world.configureAi({ choice: "openai", apiKey: "", model: "gpt-5.4-mini", utilityModel: "" });
  assert.equal(result.ok, true);
  const patch = h.patches[0] as { text: Record<string, string>; images: Record<string, string> };
  assert.equal(patch.text.customModel, "gpt-5.4-mini");
  // Omitted, not blank: the server reads a missing key as "keep" and "" as "clear".
  assert.equal("customApiKey" in patch.text, false);
  assert.equal("utilityApiKey" in patch.text, false);
  assert.equal("openaiApiKey" in patch.images, false);
});

// ---- moving the world (src/shared/world-transfer.ts) ----

// The world's /api/admin/world as a fake: a job that finishes on the first
// look, and a record of what was asked.
function transferHarness(options: { checkError?: string; saved?: boolean; pickName?: string } = {}) {
  const h = harness({
    world: { firstRun: false },
    profile: { username: "kaleb", secret: "kept", token: "tok", tokenExpiresAt: "2030-01-01T00:00:00.000Z" },
    tokenValid: true,
  });
  const asked: Array<{ method: string; body: unknown; auth: string }> = [];
  const events: string[] = [];
  let job: unknown = null;
  h.deps.emit = (event) => {
    if (event.kind === "world-transfer") events.push(event.phase);
  };
  h.deps.fetchJson = async (url, init) => {
    assert.equal(url, "http://127.0.0.1:3210/api/admin/world");
    asked.push({ method: init.method ?? "GET", body: init.body, auth: init.headers?.authorization ?? "" });
    const body = init.body as { action?: string; name?: string } | undefined;
    if (init.method === "POST" && body?.action === "export") {
      job = { kind: "export", phase: "Packing 3 of 3 files", done: true, error: "", preview: null, export: { name: "odm-world-2026-10-11T10-00-00Z.tar.gz", bytes: 4096, sha256: "a".repeat(64), counts: { campaigns: 1, users: 1, messages: 3, files: 2 } } };
      return { status: 202, data: { job } };
    }
    if (init.method === "POST" && body?.action === "check") {
      job = { kind: "check", phase: "Checking 3 of 3 files", done: true, error: options.checkError ?? "", export: null, preview: options.checkError ? null : { name: body.name, serverVersion: "0.26.2", createdAt: "2026-10-11T10:00:00.000Z", owner: "rowan", counts: { campaigns: 2, users: 3, messages: 40, files: 9 } } };
      return { status: 202, data: { job } };
    }
    if (init.method === "POST" && body?.action === "commit") return { status: 200, data: { owner: "rowan", restart: true } };
    if (init.method === "POST" && body?.action === "discard") return { status: 200, data: { ok: true } };
    return { status: 200, data: { job } };
  };
  const native: string[] = [];
  h.deps.plugin.saveArchive = async ({ name, suggested }) => {
    native.push(`save:${name}:${suggested}`);
    return options.saved === false ? { saved: false } : { saved: true, label: suggested };
  };
  h.deps.plugin.pickArchive = async () => {
    native.push("pick");
    return { name: options.pickName ?? "import-abc.tar.gz" };
  };
  return { ...h, asked, events, native };
}

test("an export packs the world on its server and saves the file where the person chooses", async () => {
  const h = transferHarness();
  const result = await createLocalWorld(h.deps).exportWorld();
  assert.deepEqual(result, { ok: true, saved: true, file: "odm-world-2026-10-11T10-00-00Z.tar.gz", bytes: 4096 });
  assert.deepEqual(h.native, ["save:odm-world-2026-10-11T10-00-00Z.tar.gz:odm-world-2026-10-11T10-00-00Z.tar.gz"]);
  assert.ok(h.asked.every((call) => call.auth === "Bearer tok"), "as the world's owner");
  assert.deepEqual(h.asked.at(-1)?.body, { action: "discard" }, "the staged copy is dropped once saved");
  assert.ok(h.events.includes("Packing 3 of 3 files"));
});

test("closing the save dialog keeps nothing and says nothing was saved", async () => {
  const h = transferHarness({ saved: false });
  const result = await createLocalWorld(h.deps).exportWorld();
  assert.deepEqual(result, { ok: true, saved: false, file: "", bytes: 0 });
  assert.deepEqual(h.asked.at(-1)?.body, { action: "discard" });
});

test("an import shows what the archive holds before anything is replaced, then signs its owner in", async () => {
  const h = transferHarness();
  const world = createLocalWorld(h.deps);
  const picked = await world.importPick();
  assert.equal(picked.ok, true);
  assert.equal(picked.ok && picked.preview?.owner, "rowan");
  assert.equal(h.asked.some((call) => (call.body as { action?: string } | undefined)?.action === "commit"), false, "a pick never commits");

  const planted: string[] = [];
  h.deps.plantSession = async (origin, token) => {
    planted.push(`${origin}|${token}`);
  };
  const committed = await world.importCommit();
  assert.deepEqual(committed, { ok: true, owner: "rowan" });
  assert.deepEqual(
    planted,
    ["http://127.0.0.1:3210|tok", "http://127.0.0.1:3210|tok-relogin"],
    "the owner's own session rides every transfer call, and the replaced world's cookie never outlives it",
  );
  const commit = h.asked.find((call) => (call.body as { action?: string } | undefined)?.action === "commit");
  assert.deepEqual(commit?.body, { action: "commit", name: "import-abc.tar.gz", ownerPassword: "minted-secret" });
  assert.ok(h.calls.includes("login:rowan:minted-secret"), "the restarted world signs its owner in with the minted password");
  assert.equal(h.profile()?.username, "rowan");
  assert.equal(h.profile()?.secret, "minted-secret");
});

test("a refused archive is dropped and nothing commits", async () => {
  const h = transferHarness({ checkError: "media/uploads/x.png is damaged: its fingerprint does not match." });
  const world = createLocalWorld(h.deps);
  const picked = await world.importPick();
  assert.deepEqual(picked, { ok: false, error: "media/uploads/x.png is damaged: its fingerprint does not match." });
  assert.deepEqual(h.asked.at(-1)?.body, { action: "discard" });
  assert.deepEqual(await world.importCommit(), { ok: false, error: "Pick a world file first." });
});

test("closing the picker is not an error", async () => {
  const h = transferHarness({ pickName: "" });
  assert.deepEqual(await createLocalWorld(h.deps).importPick(), { ok: true, preview: null });
});

test("a phone nobody has played on yet makes its owner first, so it can take a world in", async () => {
  const h = transferHarness();
  h.world.firstRun = true;
  let profile: LocalProfile | null = null;
  h.deps.loadProfile = async () => profile;
  h.deps.saveProfile = async (next) => {
    profile = next;
  };
  const picked = await createLocalWorld(h.deps).importPick();
  assert.equal(picked.ok, true);
  assert.ok(h.calls.includes("register:player:minted-secret"));
});

test("a repair unpacks the server files again and says whether the world came back", async () => {
  const h = harness({ world: { state: "running", origin: "http://127.0.0.1:3210" } });
  h.deps.plugin.repair = async () => ({ ...h.world, started: true });
  const announced: string[] = [];
  h.deps.emit = (event) => {
    if (event.kind === "local-status") announced.push(event.status.state);
  };
  assert.deepEqual(await createLocalWorld(h.deps).repair(), { ok: true, found: null, started: true });
  assert.deepEqual(announced, ["running"], "the status is announced afterwards");
});

test("an older native side cannot repair, and says so", async () => {
  const h = harness();
  const result = await createLocalWorld(h.deps).repair();
  assert.equal(result.ok, false);
  assert.equal(await createLocalWorld(h.deps).diagnostics(), null);
});

test("sharing on the Wi-Fi restarts the world there and points in-game invites at it", async () => {
  const h = harness({
    world: { state: "running", origin: "http://127.0.0.1:3210", firstRun: false },
    profile: { username: "kaleb", token: "tok", tokenExpiresAt: "2030-01-01T00:00:00.000Z", secret: "s" },
    tokenValid: true,
  });
  h.world.lanOrigin = "";
  const asked: boolean[] = [];
  h.deps.plugin.lanSharing = async ({ on }) => {
    asked.push(on);
    h.world.lanOrigin = on ? "http://192.168.1.9:3210" : "";
    h.world.sharedOnLan = on;
    return { ...h.world };
  };
  const world = createLocalWorld(h.deps);
  const on = await world.setLanSharing(true);
  assert.ok(on.ok);
  assert.equal(on.ok && on.status.lanOrigin, "http://192.168.1.9:3210");
  assert.deepEqual(h.patches.at(-1), { publicUrl: "http://192.168.1.9:3210", voiceChat: { enabled: "on", mode: "mesh" } });
  const off = await world.setLanSharing(false);
  assert.ok(off.ok);
  assert.equal(off.ok && off.status.lanOrigin, "");
  assert.deepEqual(h.patches.at(-1), { publicUrl: "", voiceChat: { enabled: "on", mode: "mesh" } });
  assert.deepEqual(asked, [true, false]);
});

test("a phone with no Wi-Fi address says so, and an older native side cannot share on the Wi-Fi", async () => {
  const h = harness({ world: { state: "running", origin: "http://127.0.0.1:3210" } });
  h.deps.plugin.lanSharing = async () => {
    throw new Error("This phone is not on a Wi-Fi network right now.");
  };
  assert.deepEqual(await createLocalWorld(h.deps).setLanSharing(true), {
    ok: false,
    error: "This phone is not on a Wi-Fi network right now.",
  });
  const older = harness();
  assert.equal((await createLocalWorld(older.deps).setLanSharing(true)).ok, false);
});
