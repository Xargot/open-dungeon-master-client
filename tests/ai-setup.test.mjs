import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FAST_COST_NOTE,
  MEDIA_MODELS_PATH,
  NO_SAVED_AI,
  STORY_MODELS_PATH,
  harnessFastModel,
  harnessPatch,
  mediaNotice,
  openAiFastModel,
  openAiPatch,
  saveOpenAiDoor,
  savedAiFrom,
  savedMediaModels,
  storyModelsFrom,
  storyModelsRequest,
} from "../dist/shared/ai-setup.js";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.resolve(process.env.ODM_SERVER_DIR ?? path.join(repo, "..", "open-dungeon-master"));
const serverSpeedTier = path.join(serverDir, "src", "lib", "speed-tier.ts");

const setup = (apiKey, model = "", utilityModel = "") => ({ choice: "openai", apiKey, model, utilityModel });
const openAiConfig = (text) => ({
  config: { text: { provider: "custom", customBaseUrl: "https://api.openai.com/v1", ...text } },
});

test("one key covers the storyteller, the utility model and the pictures", () => {
  const built = openAiPatch(setup(" sk-1 ", "my-storyteller"), NO_SAVED_AI);
  assert.equal(built.patch.text.customApiKey, "sk-1");
  assert.equal(built.patch.text.utilityApiKey, "sk-1");
  assert.equal(built.patch.images.openaiApiKey, "sk-1");
  assert.equal(built.patch.images.defaultBackend, "openai");
  assert.equal(built.patch.text.customModel, "my-storyteller");
  assert.equal(built.patch.text.utilityModel, "my-storyteller", "a blank utility model follows the storyteller");
});

// The server names no model (its PR 298), and neither does the door: the
// storyteller is the player's pick from what the key lists.
test("no storyteller model is invented: a blank one is refused", () => {
  assert.deepEqual(openAiPatch(setup("sk-1", "  "), NO_SAVED_AI), { error: "Choose the Dungeon Master model from the ones your key lists." });
  assert.deepEqual(openAiPatch(setup("", ""), { keySaved: true, model: "", utilityModel: "" }), {
    error: "Choose the Dungeon Master model from the ones your key lists.",
  });
});

test("a blank key is refused until the device holds one, then it means keep", () => {
  assert.deepEqual(openAiPatch(setup(""), NO_SAVED_AI), { error: "Enter the API key." });
  const built = openAiPatch(setup("", "gpt-5.4-mini", "gpt-5-nano"), { keySaved: true, model: "", utilityModel: "" });
  assert.equal(built.patch.text.customModel, "gpt-5.4-mini");
  assert.equal(built.patch.text.utilityModel, "gpt-5-nano");
  // Omitted, not blank: the server reads a missing key as keep and "" as clear.
  assert.equal("customApiKey" in built.patch.text, false);
  assert.equal("utilityApiKey" in built.patch.text, false);
  assert.equal("openaiApiKey" in built.patch.images, false);
});

test("the saved state is read from the masked settings", () => {
  assert.deepEqual(
    savedAiFrom(openAiConfig({ customModel: "gpt-5.1", utilityModel: "gpt-5-mini", hasCustomApiKey: true })),
    { keySaved: true, model: "gpt-5.1", utilityModel: "gpt-5-mini" },
  );
  assert.deepEqual(savedAiFrom(openAiConfig({ hasCustomApiKey: false })), NO_SAVED_AI);
  assert.deepEqual(savedAiFrom(null), NO_SAVED_AI);
  assert.deepEqual(savedAiFrom({}), NO_SAVED_AI);
});

test("a key for another backend is not an OpenAI key", () => {
  const local = { config: { text: { provider: "custom", customBaseUrl: "http://127.0.0.1:8001/v1", hasCustomApiKey: true } } };
  assert.deepEqual(savedAiFrom(local), NO_SAVED_AI);
  const lookalike = openAiConfig({ customBaseUrl: "https://api.openai.com.evil.example/v1", hasCustomApiKey: true });
  assert.deepEqual(savedAiFrom(lookalike), NO_SAVED_AI);
  const human = { config: { text: { provider: "none", customBaseUrl: "https://api.openai.com/v1", hasCustomApiKey: true } } };
  assert.deepEqual(savedAiFrom(human), NO_SAVED_AI);
});

test("an agent the device already has narrates every campaign, and no key is ever sent", () => {
  const built = harnessPatch({
    choice: "harness",
    apiKey: "",
    model: "",
    utilityModel: "",
    harness: { id: "claude", model: " sonnet ", utilityModel: "haiku" },
  });
  assert.deepEqual(built.patch, {
    harness: { id: "claude", model: "sonnet", utilityModel: "haiku", speed: "", utilitySpeed: "" },
    text: { provider: "harness" },
  });
  assert.ok(!JSON.stringify(built.patch).includes("ApiKey"), "the agent's own sign-in is used, nothing else");
  assert.deepEqual(harnessPatch({ choice: "harness", apiKey: "", model: "", utilityModel: "" }), { error: "Choose a program first." });
  assert.deepEqual(
    harnessPatch({ choice: "harness", apiKey: "", model: "", utilityModel: "", harness: { id: "bash", model: "", utilityModel: "" } }),
    { error: "Choose a program first." },
  );
});

test("a device narrating with an agent is read back as that agent, not as a key", () => {
  const saved = savedAiFrom({
    config: { text: { provider: "harness" }, harness: { id: "opencode", model: "llama/qwen3.6-35b", utilityModel: "" } },
  });
  assert.equal(saved.harnessId, "opencode");
  assert.equal(saved.model, "llama/qwen3.6-35b");
  assert.equal(saved.keySaved, false);
  assert.deepEqual(savedAiFrom({ config: { text: { provider: "harness" }, harness: { id: "" } } }), NO_SAVED_AI);
});

// The server asks OpenAI for Fast for any named model, at the premium price,
// so each role's switch is its own: Fast for the storyteller does not bill
// every summary at it too.
test("Fast is asked for only where the door's switch for that role is on (server issue 255)", () => {
  const plain = openAiPatch(setup("sk-1", "gpt-6-sol"), NO_SAVED_AI);
  assert.equal(plain.patch.text.speed, "", "the provider default unless chosen");
  assert.equal(plain.patch.text.utilitySpeed, "");
  const fast = openAiPatch({ ...setup("sk-1", "gpt-6-sol", "gpt-5.6-mini"), fast: true }, NO_SAVED_AI);
  assert.equal(fast.patch.text.speed, "fast");
  assert.equal(fast.patch.text.utilitySpeed, "", "the utility model was not chosen for Fast");
  const both = openAiPatch({ ...setup("sk-1", "gpt-6-sol", "gpt-5.6-mini"), fast: true, utilityFast: true }, NO_SAVED_AI);
  assert.equal(both.patch.text.utilitySpeed, "fast");
  const utilityOnly = openAiPatch({ ...setup("sk-1", "gpt-6-sol", "gpt-5.6-mini"), utilityFast: true }, NO_SAVED_AI);
  assert.deepEqual([utilityOnly.patch.text.speed, utilityOnly.patch.text.utilitySpeed], ["", "fast"]);
  const agent = harnessPatch({ choice: "harness", apiKey: "", model: "", utilityModel: "", fast: true, harness: { id: "codex", model: "gpt-6-sol", utilityModel: "" } });
  assert.equal(agent.patch.harness.speed, "fast");
  assert.equal(agent.patch.harness.utilitySpeed, "fast");
  const notTrue = harnessPatch({ choice: "harness", apiKey: "", model: "", utilityModel: "", fast: "yes", harness: { id: "claude", model: "opus", utilityModel: "" } });
  assert.equal(notTrue.patch.harness.speed, "", "only a real true turns it on");
});

test("the saved Fast choice is read back for the key and for an agent", () => {
  assert.equal(savedAiFrom(openAiConfig({ customModel: "gpt-6-sol", hasCustomApiKey: true, speed: "fast" })).fast, true);
  assert.equal(savedAiFrom(openAiConfig({ customModel: "gpt-6-sol", hasCustomApiKey: true, speed: "" })).fast, undefined);
  const roles = savedAiFrom(openAiConfig({ customModel: "gpt-6-sol", hasCustomApiKey: true, speed: "", utilitySpeed: "fast" }));
  assert.deepEqual([roles.fast, roles.utilityFast], [undefined, true]);
  const agent = savedAiFrom({ config: { text: { provider: "harness" }, harness: { id: "claude", model: "opus", utilityModel: "", speed: "fast" } } });
  assert.equal(agent.fast, true);
});

// The models each program listed when the server probed it (server
// src/lib/harness/adapters): Claude Code marks Fast per model in its
// initialize answer, Codex in its service tiers.
const codexModels = [{ id: "gpt-6-sol", fast: true }, { id: "gpt-5.4", fast: false }];
const claudeModels = [{ id: "opus", fast: true }, { id: "sonnet", fast: false }, { id: "haiku" }];

test("an agent runs Fast where Claude Code or Codex lists the tier for the model", () => {
  assert.equal(harnessFastModel("codex", "gpt-6-sol", codexModels), true);
  assert.equal(harnessFastModel("codex", "gpt-5.4", codexModels), false);
  assert.equal(harnessFastModel("codex", "", codexModels), false, "the program's own default is not known to have it");
  assert.equal(harnessFastModel("claude", "opus", claudeModels), true);
  assert.equal(harnessFastModel("claude", "sonnet", claudeModels), false);
  assert.equal(harnessFastModel("claude", "claude-opus-5", claudeModels), false, "a saved model this sign-in does not list");
  assert.equal(harnessFastModel("claude", "opus", []), false, "a Claude Code that listed nothing offers nothing");
  assert.equal(harnessFastModel("opencode", "gpt-6-sol", codexModels), false);
  assert.equal(harnessFastModel("grok", "grok-5", []), false);
});

// The door offers Fast by these rules; the device's server decides by its
// own before every call. The two must agree, or the door offers a Fast the
// server never asks for (or hides one it would). On OpenAI's API the server
// offers it for any named model; which have the tier is not read from names.
test("the door's Fast models are the server's", { skip: !fs.existsSync(serverSpeedTier) }, async () => {
  const server = await import(pathToFileURL(serverSpeedTier).href);
  const names = [
    "gpt-6-sol", "GPT-6-Luna", "gpt-6-astra", "gpt-6.1-sol", "gpt-5.6", "gpt-5.6-mini", "gpt-5.5", "gpt-5.1",
    "gpt-4o", "ft:gpt-6-sol:org", "gpt-6", "o4-mini", "", "  ", "  gpt-6-sol  ",
  ];
  for (const name of names) {
    assert.equal(openAiFastModel(name), server.apiSpeedEligibility({ endpointKind: "openai", model: name }).ok, `OpenAI: ${JSON.stringify(name)}`);
  }
  for (const [harnessId, models] of [["claude", claudeModels], ["codex", codexModels], ["opencode", codexModels], ["grok", []]]) {
    for (const model of ["opus", "sonnet", "haiku", "claude-opus-5", "gpt-6-sol", "gpt-5.4", ""]) {
      assert.equal(
        harnessFastModel(harnessId, model, models),
        server.agentSpeedEligibility({ harnessId, model, models }).ok,
        `${harnessId}: ${JSON.stringify(model)}`,
      );
    }
  }
  assert.equal(FAST_COST_NOTE, server.FAST_COST_NOTE, "the price is said in the same words");
});

// ---- the picture and transcription models, from the key's own list ----

// The device world's server as the door sees it: the masked settings, every
// PATCH, and the model listings it answers (POST /api/admin/models), each
// with the `recommended` the server's registry gives.
function fakeWorld({ settings = null, recommended = {}, refuse = [] } = {}) {
  const patches = [];
  const asked = [];
  return {
    patches,
    asked,
    world: {
      settings: async () => settings,
      patch: async (patch) => {
        patches.push(patch);
      },
      post: async (path, body) => {
        asked.push({ path, body });
        if (refuse.includes(body.role)) throw new Error("This world's server does not know that role.");
        return { reachable: true, models: [], recommended: recommended[body.role] ?? "" };
      },
    },
  };
}

test("the door saves the picture and transcription models the key's list recommends", async () => {
  const fake = fakeWorld({ recommended: { image: "listed-painter", dictation: "listed-ears" } });
  const saved = await saveOpenAiDoor(setup("sk-1", "my-storyteller"), fake.world);
  assert.deepEqual(saved, { notice: "" });
  assert.equal(fake.patches[0].text.customModel, "my-storyteller", "the key and the storyteller first");
  assert.deepEqual(fake.patches[1], { images: { openaiModel: "listed-painter" }, speech: { sttOpenaiModel: "listed-ears" } });
  // Listed after the key is saved, on the device world's own route, for the
  // key the world now holds (no key travels in the listing).
  assert.deepEqual(fake.asked, [
    { path: MEDIA_MODELS_PATH, body: { action: "list", role: "image", provider: "images" } },
    { path: MEDIA_MODELS_PATH, body: { action: "list", role: "dictation", provider: "speech", baseUrl: "https://api.openai.com/v1" } },
  ]);
});

test("a picture or transcription model the device already saved is kept", async () => {
  const settings = {
    config: {
      text: { provider: "custom", customBaseUrl: "https://api.openai.com/v1", customModel: "old", hasCustomApiKey: true },
      images: { openaiModel: "chosen-painter" },
      speech: { sttOpenaiModel: "" },
    },
  };
  assert.deepEqual(savedMediaModels(settings), { pictures: "chosen-painter", dictation: "" });
  const fake = fakeWorld({ settings, recommended: { image: "listed-painter", dictation: "listed-ears" } });
  const saved = await saveOpenAiDoor(setup("", "my-storyteller"), fake.world);
  assert.deepEqual(saved, { notice: "" });
  assert.deepEqual(fake.patches[1], { speech: { sttOpenaiModel: "listed-ears" } }, "only the blank one is filled");
  assert.ok(!fake.asked.some((request) => request.body.role === "image"), "a saved pick is not listed again");
});

test("with no obvious pick the field stays blank and the player is told where to pick", async () => {
  const fake = fakeWorld({ recommended: { dictation: "listed-ears" } });
  const saved = await saveOpenAiDoor(setup("sk-1", "my-storyteller"), fake.world);
  assert.deepEqual(fake.patches[1], { speech: { sttOpenaiModel: "listed-ears" } });
  assert.match(saved.notice, /Admin > Image generation/);
  assert.doesNotMatch(saved.notice, /Admin > Speech/);
  // A listing the world's server refuses (one older than the speech role)
  // leaves that model blank too, and the key stays saved.
  const older = fakeWorld({ recommended: { image: "listed-painter" }, refuse: ["dictation"] });
  const kept = await saveOpenAiDoor(setup("sk-1", "my-storyteller"), older.world);
  assert.deepEqual(older.patches[1], { images: { openaiModel: "listed-painter" } });
  assert.match(kept.notice, /OpenAI transcription in Admin > Speech/);
  const none = fakeWorld();
  const both = await saveOpenAiDoor(setup("sk-1", "my-storyteller"), none.world);
  assert.equal(none.patches.length, 1, "nothing to write when nothing was picked");
  assert.match(both.notice, /picture or transcription model/);
  assert.equal(mediaNotice([]), "");
});

test("a refused save writes nothing", async () => {
  const fake = fakeWorld({ recommended: { image: "listed-painter" } });
  assert.deepEqual(await saveOpenAiDoor(setup("", "my-storyteller"), fake.world), { error: "Enter the API key." });
  assert.deepEqual(await saveOpenAiDoor(setup("sk-1", ""), fake.world), { error: "Choose the Dungeon Master model from the ones your key lists." });
  assert.equal(fake.patches.length, 0);
  assert.equal(fake.asked.length, 0);
});

test("the storyteller models are the key's own, from the world's setup listing", () => {
  assert.equal(STORY_MODELS_PATH, "/api/admin/setup");
  assert.deepEqual(storyModelsRequest(" sk-typed "), { action: "models", provider: "openai", apiKey: "sk-typed" });
  assert.deepEqual(
    storyModelsFrom({ ok: true, models: [{ id: "model-a", label: "Model A" }, { id: "model-b" }, { id: "" }, { label: "no id" }], recommended: "model-b" }),
    { ok: true, models: [{ id: "model-a", label: "Model A" }, { id: "model-b", label: "model-b" }], recommended: "model-b" },
  );
  assert.equal(storyModelsFrom({ ok: true, models: [{ id: "model-a" }], recommended: "not-listed" }).recommended, "", "only a listed model is recommended");
  assert.deepEqual(storyModelsFrom({ ok: false, error: "api.openai.com turned the key down." }), { ok: false, error: "api.openai.com turned the key down." });
  assert.equal(storyModelsFrom(null).ok, false);
});

// The listings the door asks for are ones the server answers: the request
// shapes are held to the server's own route schemas.
test("the door's listings match the server's routes", { skip: !fs.existsSync(path.join(serverDir, "src", "app", "api", "admin", "models", "route.ts")) }, () => {
  const models = fs.readFileSync(path.join(serverDir, "src", "app", "api", "admin", "models", "route.ts"), "utf8");
  assert.match(models, /role: z\.enum\(\[[^\]]*"image"[^\]]*"dictation"/);
  assert.match(models, /provider: z\.enum\(\[[^\]]*"images"[^\]]*"speech"/);
  const setupRoute = fs.readFileSync(path.join(serverDir, "src", "app", "api", "admin", "setup", "route.ts"), "utf8");
  assert.match(setupRoute, /action: z\.literal\("models"\)/);
  assert.match(setupRoute, /provider: z\.enum\(\["openai"/);
});

// Story AI opens on what the device world plays with now (audit C03), in a
// player's words, read from the same masked settings.
test("the current setup is said in a player's words", async () => {
  const { currentAiSummary } = await import("../dist/shared/ai-setup.js");
  assert.equal(currentAiSummary(null), null);
  const openai = currentAiSummary({
    config: {
      text: { provider: "custom", customBaseUrl: "https://api.openai.com/v1", customModel: "gpt-5.4" },
      images: { defaultBackend: "openai" },
      speech: { ttsProvider: "openai" },
    },
  });
  assert.equal(openai.story, "OpenAI tells the story (gpt-5.4), on your key.");
  assert.equal(openai.pictures, "OpenAI paints the pictures, on your key.");
  assert.equal(openai.narration, "OpenAI's voices read the story aloud.");
  const agent = currentAiSummary({ config: { text: { provider: "harness" }, harness: { id: "codex" }, images: { defaultBackend: "harness" } } });
  assert.equal(agent.story, "Codex tells the story, on its own sign-in.");
  assert.equal(agent.pictures, "Codex paints the pictures.");
  const human = currentAiSummary({ config: { text: { provider: "none" }, images: {}, speech: { ttsProvider: "off" } } });
  assert.match(human.story, /no AI tells the story/);
  assert.match(human.pictures, /placeholders/);
  assert.equal(human.narration, "The story is read on screen.");
  const local = currentAiSummary({ config: { text: { provider: "custom", customBaseUrl: "http://127.0.0.1:8001/v1", customModel: "qwen" } } });
  assert.equal(local.story, "A model on this computer tells the story (qwen).");
});

// The OpenAI door can read the story aloud on the same key: only when the
// player ticks it, with the narration model from the key's own list.
test("narration on the key is asked for only when ticked", async () => {
  const run = async (narrate, recommended) => {
    const patches = [];
    const asked = [];
    const world = {
      settings: async () => ({ config: { text: {}, images: {}, speech: {} } }),
      patch: async (patch) => void patches.push(patch),
      post: async (pathname, body) => {
        asked.push(body);
        return { recommended: body.role === "narration" ? recommended : "" };
      },
    };
    const saved = await saveOpenAiDoor({ ...setup("sk-1", "teller"), narrate }, world);
    return { saved, patches, asked };
  };
  const off = await run(false, "voice-1");
  assert.ok(!off.asked.some((body) => body.role === "narration"), "unticked, narration is not listed");
  const on = await run(true, "voice-1");
  assert.deepEqual(on.patches.at(-1), { speech: { ttsProvider: "openai", ttsBaseUrl: "", ttsModel: "voice-1", ttsVoice: "" } });
  const unpicked = await run(true, "");
  assert.match(unpicked.saved.notice, /Narration in Admin > Speech/);
  assert.ok(!unpicked.patches.some((patch) => patch.speech?.ttsProvider), "nothing is switched on without a model");
});
