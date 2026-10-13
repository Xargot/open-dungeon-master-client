import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_MODEL,
  FAST_COST_NOTE,
  NO_SAVED_AI,
  harnessFastModel,
  harnessPatch,
  openAiFastModel,
  openAiPatch,
  savedAiFrom,
} from "../dist/shared/ai-setup.js";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.resolve(process.env.ODM_SERVER_DIR ?? path.join(repo, "..", "open-dungeon-master"));
const serverSpeedTier = path.join(serverDir, "src", "lib", "speed-tier.ts");

const setup = (apiKey, model = "", utilityModel = "") => ({ choice: "openai", apiKey, model, utilityModel });
const openAiConfig = (text) => ({
  config: { text: { provider: "custom", customBaseUrl: "https://api.openai.com/v1", ...text } },
});

test("one key covers the storyteller, the utility model and the pictures", () => {
  const built = openAiPatch(setup(" sk-1 "), NO_SAVED_AI);
  assert.equal(built.patch.text.customApiKey, "sk-1");
  assert.equal(built.patch.text.utilityApiKey, "sk-1");
  assert.equal(built.patch.images.openaiApiKey, "sk-1");
  assert.equal(built.patch.images.defaultBackend, "openai");
  assert.equal(built.patch.text.customModel, DEFAULT_MODEL);
  assert.equal(built.patch.text.utilityModel, DEFAULT_MODEL, "a blank utility model follows the storyteller");
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

test("Fast is asked for only when the door's switch is on, for both roles (server issue 255)", () => {
  const plain = openAiPatch(setup("sk-1", "gpt-6-sol"), NO_SAVED_AI);
  assert.equal(plain.patch.text.speed, "", "the provider default unless chosen");
  assert.equal(plain.patch.text.utilitySpeed, "");
  const fast = openAiPatch({ ...setup("sk-1", "gpt-6-sol", "gpt-5.6-mini"), fast: true }, NO_SAVED_AI);
  assert.equal(fast.patch.text.speed, "fast");
  assert.equal(fast.patch.text.utilitySpeed, "fast");
  const agent = harnessPatch({ choice: "harness", apiKey: "", model: "", utilityModel: "", fast: true, harness: { id: "codex", model: "gpt-6-sol", utilityModel: "" } });
  assert.equal(agent.patch.harness.speed, "fast");
  assert.equal(agent.patch.harness.utilitySpeed, "fast");
  const notTrue = harnessPatch({ choice: "harness", apiKey: "", model: "", utilityModel: "", fast: "yes", harness: { id: "claude", model: "opus", utilityModel: "" } });
  assert.equal(notTrue.patch.harness.speed, "", "only a real true turns it on");
});

test("the saved Fast choice is read back for the key and for an agent", () => {
  assert.equal(savedAiFrom(openAiConfig({ customModel: "gpt-6-sol", hasCustomApiKey: true, speed: "fast" })).fast, true);
  assert.equal(savedAiFrom(openAiConfig({ customModel: "gpt-6-sol", hasCustomApiKey: true, speed: "" })).fast, undefined);
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
// server never asks for (or hides one it would).
test("the door's Fast models are the server's", { skip: !fs.existsSync(serverSpeedTier) }, async () => {
  const server = await import(pathToFileURL(serverSpeedTier).href);
  const names = [
    "gpt-6-sol", "GPT-6-Luna", "gpt-6-astra", "gpt-6.1-sol", "gpt-5.6", "gpt-5.6-mini", "gpt-5.5", "gpt-5.1",
    "gpt-4o", "ft:gpt-6-sol:org", "gpt-6", "o4-mini", "", "  gpt-6-sol  ",
  ];
  for (const name of names) {
    assert.equal(openAiFastModel(name), server.openAiFastModel(name), `OpenAI: ${JSON.stringify(name)}`);
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
