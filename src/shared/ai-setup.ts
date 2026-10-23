// The OpenAI door of Story AI, shared by both shells. The key belongs to the
// device: it is saved once in the device world's admin settings, where every
// campaign on the device follows it (the server applies that on a device
// world), so neither shell ever writes a key into a campaign. No model is
// named here: each one is picked from what the key lists, as the server
// itself names none (server PR 298).
import type { AiModelsResult, AiSetup, HardwareInfo, LocalAiTier, SavedAi } from "./types";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

// The least graphics memory the desktop's local storyteller is offered on: a
// 16 GB card, or a unified pool whose GPU share reaches it (a 24 GB Mac).
// Below it no model plays the full rules well enough, so the app offers none
// rather than one that fumbles the table. The server's docs state the same
// minimum (docs/text-backends.md).
export const LOCAL_AI_MINIMUM_GB = 16;
// Every setup's needs, the local storyteller's with the machines it was
// measured on, on the site's guide.
export const REQUIREMENTS_URL = "https://opendungeonmaster.com/guide/start/system-requirements/";

export const NO_SAVED_AI: SavedAi = { keySaved: false, model: "", utilityModel: "" };

// The model a tier installs, as its catalog line names it ("gpt-oss-20b:
// ...", "Qwen3.6-35B-A3B at Q4: ...").
function tierModel(tier: LocalAiTier): string {
  return tier.detail.split(/:| at /)[0]?.trim() || tier.label;
}

// What Story AI's "Local AI on this machine" door says once the hardware
// scan answers, so the guided setup tells a 16 GB card it can run a
// storyteller (and a smaller machine why it cannot) before anything is
// opened. The pick is the installer's own recommendation.
export function localAiFit(hardware: HardwareInfo, tiers: LocalAiTier[]): { tag: string; desc: string } {
  const installed = tiers.find((tier) => tier.installed);
  if (installed) return { tag: "installed", desc: `${tierModel(installed)} is installed on this computer: free and private.` };
  const pick = tiers.find((tier) => tier.recommended) ?? tiers.find((tier) => tier.fits);
  if (pick) {
    return { tag: "fits this computer", desc: `Free and private: this computer runs ${tierModel(pick)}, a ${pick.sizeGb} GB download the app sets up for you.` };
  }
  const gpu = hardware.gpuName || "this computer";
  const memory = hardware.unifiedMemory ? `${hardware.ramGb} GB of unified memory` : `${hardware.vramGb} GB of graphics memory`;
  return {
    tag: "",
    desc: `Needs at least ${LOCAL_AI_MINIMUM_GB} GB of graphics memory, and ${gpu} has ${memory}. Your OpenAI key, an agent or a person tells the story here instead.`,
  };
}

// Processing speed (server issue 255): Fast is offered for any model named
// on OpenAI's API, as the server's src/lib/speed-tier.ts offers it. Which
// models have the tier is not read from the name; OpenAI's reply says what
// ran. tests/ai-setup.test.mjs holds this to the server's answer.
export function openAiFastModel(model: string): boolean {
  return Boolean(model.trim());
}

// Whether an agent program runs this model at Fast: Claude Code and Codex
// each say per model in the list the server probed from them (Claude Code's
// supportsFastMode, Codex's service tiers), as the server's
// agentSpeedEligibility reads it.
export function harnessFastModel(id: string, model: string, models: ReadonlyArray<{ id: string; fast?: boolean }>): boolean {
  if (id !== "claude" && id !== "codex") return false;
  return Boolean(model.trim()) && models.some((entry) => entry.id === model && entry.fast === true);
}

// Said before Fast is chosen, as the admin panel says it.
export const FAST_COST_NOTE =
  "Fast answers sooner for about twice the price per token (2x to 2.5x of a Codex or Claude plan's usage, paid from usage credits on Claude). It applies to every campaign this setting serves.";

function isOpenAi(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string") return false;
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return host === "openai.com" || host.endsWith(".openai.com");
  } catch {
    return false;
  }
}

// What the device already holds, read from the masked admin settings (the
// key itself never leaves the server, only whether one is set). A key for
// some other backend does not count: it could not pay for OpenAI.

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "opencode", grok: "Grok Build" };

function hostOf(url: unknown): string {
  try {
    return typeof url === "string" ? new URL(url).host : "";
  } catch {
    return "";
  }
}

// What the device world plays with now, in a player's words: who tells the
// story, what paints, what reads it aloud ("narration" is only ever the
// reading aloud, as in the server's own Help). Shown before any change is offered, so
// Story AI starts from what is set rather than a blank question.
export function currentAiSummary(body: unknown): SavedAi["summary"] | null {
  const config = (body as {
    config?: {
      text?: Record<string, unknown>;
      harness?: Record<string, unknown>;
      images?: Record<string, unknown>;
      speech?: Record<string, unknown>;
    };
  } | null)?.config;
  if (!config?.text) return null;
  const text = config.text;
  const model = typeof text.customModel === "string" ? text.customModel : "";
  const agent = typeof config.harness?.id === "string" ? AGENT_NAMES[config.harness.id] ?? config.harness.id : "";
  const story =
    text.provider === "none"
      ? "A person runs every table; no AI tells the story."
      : text.provider === "harness" && agent
        ? `${agent} tells the story, on its own sign-in.`
        : text.provider === "custom" && isOpenAi(text.customBaseUrl)
          ? `OpenAI tells the story${model ? ` (${model})` : ""}, on your key.`
          : text.provider === "custom"
            ? /127\.0\.0\.1|localhost/.test(String(text.customBaseUrl ?? ""))
              ? `A model on this computer tells the story${model ? ` (${model})` : ""}.`
              : `${model || "A model"} at ${hostOf(text.customBaseUrl) || "another server"} tells the story.`
            : text.provider === "local"
              ? `Ollama on this computer tells the story${typeof text.localTextModel === "string" && text.localTextModel ? ` (${text.localTextModel})` : ""}.`
              : "Not chosen yet.";
  const backend = config.images?.defaultBackend;
  const pictures =
    backend === "comfyui"
      ? "ComfyUI on this computer paints the pictures."
      : backend === "openai"
        ? "OpenAI paints the pictures, on your key."
        : backend === "harness"
          ? `${agent || "The agent"} paints the pictures.`
          : "Painted placeholders until something can paint.";
  const tts = config.speech?.ttsProvider;
  const narration =
    tts === "openai"
      ? "OpenAI's voices read the story aloud."
      : tts === "kokoro"
        ? "Kokoro reads the story aloud."
        : tts === "off"
          ? "The story is read on screen."
          : "Read aloud when a speech engine is found here.";
  return { story, pictures, narration };
}

export function savedAiFrom(body: unknown): SavedAi {
  const config = (body as { config?: { text?: Record<string, unknown>; harness?: Record<string, unknown> } } | null)
    ?.config;
  const text = config?.text;
  if (text?.provider === "harness" && typeof config?.harness?.id === "string" && config.harness.id) {
    return {
      ...NO_SAVED_AI,
      harnessId: config.harness.id,
      model: typeof config.harness.model === "string" ? config.harness.model : "",
      utilityModel: typeof config.harness.utilityModel === "string" ? config.harness.utilityModel : "",
      ...(config.harness.speed === "fast" ? { fast: true } : {}),
    };
  }
  if (!text || text.provider !== "custom" || !isOpenAi(text.customBaseUrl)) return NO_SAVED_AI;
  if (text.hasCustomApiKey !== true) return NO_SAVED_AI;
  return {
    keySaved: true,
    model: typeof text.customModel === "string" ? text.customModel : "",
    utilityModel: typeof text.utilityModel === "string" ? text.utilityModel : "",
    ...(text.speed === "fast" ? { fast: true } : {}),
    ...(text.utilitySpeed === "fast" ? { utilityFast: true } : {}),
  };
}

// The admin settings patch for "AI via my OpenAI key". One key covers the
// storyteller, the utility model, the pictures and dictation. A blank key
// keeps the one the device already holds (the server reads an omitted key
// as "keep"), so changing the model never means pasting the key again. The
// storyteller's model is the player's pick from the key's list; a blank
// utility model follows it. Fast is asked for each role only where the
// player chose it: the server sends it for any model on OpenAI's API, at the
// premium price. The picture and transcription models come from the key's
// own list once the key is saved (openAiMediaPatch).
export function openAiPatch(setup: AiSetup, saved: SavedAi): { patch: object } | { error: string } {
  const apiKey = setup.apiKey.trim().slice(0, 400);
  if (!apiKey && !saved.keySaved) return { error: "Enter the API key." };
  const model = setup.model.trim().slice(0, 200);
  if (!model) return { error: "Choose the Dungeon Master model from the ones your key lists." };
  const utilityModel = setup.utilityModel.trim().slice(0, 200) || model;
  const key = <K extends string>(field: K) => (apiKey ? { [field]: apiKey } : {});
  return {
    patch: {
      text: {
        provider: "custom",
        customBaseUrl: OPENAI_BASE_URL,
        customModel: model,
        ...key("customApiKey"),
        utilityProvider: "custom",
        utilityBaseUrl: OPENAI_BASE_URL,
        utilityModel,
        ...key("utilityApiKey"),
        speed: setup.fast === true ? "fast" : "",
        utilitySpeed: setup.utilityFast === true ? "fast" : "",
      },
      images: { defaultBackend: "openai", ...key("openaiApiKey") },
    },
  };
}

// The device world's admin routes the door asks, as each shell calls them:
// a POST with a JSON body, answered with the parsed reply (a refusal
// throws).
export type AdminPost = (path: string, body: object) => Promise<unknown>;

// The storyteller models a key lists, read by the device world's server as
// its guided setup reads them: only models that can narrate, with the
// catalog's pick as `recommended`. A blank key asks with the saved one, for
// OpenAI only.
export const STORY_MODELS_PATH = "/api/admin/setup";
export function storyModelsRequest(apiKey: string): object {
  return { action: "models", provider: "openai", apiKey: apiKey.trim().slice(0, 400) };
}

export function storyModelsFrom(body: unknown): AiModelsResult {
  const reply = body as { ok?: unknown; error?: unknown; models?: unknown; recommended?: unknown } | null;
  if (!reply || reply.ok !== true || !Array.isArray(reply.models)) {
    return { ok: false, error: typeof reply?.error === "string" && reply.error ? reply.error : "Your key's models could not be listed." };
  }
  const models = reply.models
    .map((entry) => entry as { id?: unknown; label?: unknown })
    .filter((entry): entry is { id: string; label?: unknown } => typeof entry.id === "string" && entry.id.trim() !== "")
    .map((entry) => ({ id: entry.id, label: typeof entry.label === "string" && entry.label ? entry.label : entry.id }));
  const recommended = typeof reply.recommended === "string" && models.some((entry) => entry.id === reply.recommended) ? reply.recommended : "";
  return { ok: true, models, recommended };
}

// The picture and transcription models a saved key runs, each from the
// key's own list as the device world's server reads it (POST
// /api/admin/models), whose `recommended` is the one obvious pick or none.
// A model the device already saved is kept. With no obvious pick the field
// stays blank and the role is reported, so the player is told where to pick.
export const MEDIA_MODELS_PATH = "/api/admin/models";
const MEDIA_LISTINGS = [
  { role: "pictures" as const, request: { action: "list", role: "image", provider: "images" } },
  { role: "dictation" as const, request: { action: "list", role: "dictation", provider: "speech", baseUrl: OPENAI_BASE_URL } },
];

// Narration on the same key, asked only when the player ticks it: the model
// from the key's own list (as the server's guided setup lists it), saved as
// the device world's speech. With no obvious pick nothing changes and the
// notice says where to choose.
const NARRATION_LISTING = { action: "list", role: "narration", provider: "speech", baseUrl: OPENAI_BASE_URL };

export async function openAiNarrationPatch(post: AdminPost): Promise<object | null> {
  const listing = (await post(MEDIA_MODELS_PATH, NARRATION_LISTING).catch(() => null)) as { recommended?: unknown } | null;
  const model = typeof listing?.recommended === "string" ? listing.recommended.trim() : "";
  return model ? { speech: { ttsProvider: "openai", ttsBaseUrl: "", ttsModel: model, ttsVoice: "" } } : null;
}

export type MediaModels = { pictures: string; dictation: string };

// What the device already saved, from the masked admin settings.
export function savedMediaModels(body: unknown): MediaModels {
  const config = (body as { config?: { images?: { openaiModel?: unknown }; speech?: { sttOpenaiModel?: unknown } } } | null)?.config;
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return { pictures: text(config?.images?.openaiModel), dictation: text(config?.speech?.sttOpenaiModel) };
}

export async function openAiMediaPatch(
  saved: MediaModels,
  post: AdminPost,
): Promise<{ patch: object | null; unpicked: Array<keyof MediaModels> }> {
  const picked: Partial<MediaModels> = {};
  const unpicked: Array<keyof MediaModels> = [];
  for (const { role, request } of MEDIA_LISTINGS) {
    if (saved[role]) continue;
    const listing = (await post(MEDIA_MODELS_PATH, request).catch(() => null)) as { recommended?: unknown } | null;
    const recommended = typeof listing?.recommended === "string" ? listing.recommended.trim() : "";
    if (recommended) picked[role] = recommended;
    else unpicked.push(role);
  }
  const patch = {
    ...(picked.pictures ? { images: { openaiModel: picked.pictures } } : {}),
    ...(picked.dictation ? { speech: { sttOpenaiModel: picked.dictation } } : {}),
  };
  return { patch: Object.keys(patch).length ? patch : null, unpicked };
}

// Where the player picks what the key's list did not settle, in the world's
// own admin page (the account menu's Admin).
export function mediaNotice(unpicked: ReadonlyArray<keyof MediaModels>): string {
  const pictures = unpicked.includes("pictures");
  const dictation = unpicked.includes("dictation");
  if (!pictures && !dictation) return "";
  const what = pictures && dictation ? "picture or transcription model" : pictures ? "picture model" : "transcription model";
  const where =
    pictures && dictation
      ? "pick them in Admin > Image generation and under OpenAI transcription in Admin > Speech"
      : pictures
        ? "pick one in Admin > Image generation"
        : "pick one under OpenAI transcription in Admin > Speech";
  const until = [pictures ? "campaigns show placeholder pictures" : "", dictation ? "dictation does not use OpenAI" : ""].filter(Boolean).join(" and ");
  return `Your key is saved. It lists no single obvious ${what}, so ${where} (the account menu's Admin, inside your world). Until then ${until}.`;
}

// The door's whole save, the same in both shells: the key and the
// storyteller, then the picture and transcription models from the key's own
// list. `notice` says what is left to pick ("" when nothing is).
export async function saveOpenAiDoor(
  setup: AiSetup,
  world: { settings(): Promise<unknown>; patch(patch: object): Promise<void>; post: AdminPost },
): Promise<{ error: string } | { notice: string }> {
  const settings = await world.settings().catch(() => null);
  const built = openAiPatch(setup, savedAiFrom(settings));
  if ("error" in built) return { error: built.error };
  await world.patch(built.patch);
  const media = await openAiMediaPatch(savedMediaModels(settings), world.post);
  if (media.patch) await world.patch(media.patch);
  let narrationNotice = "";
  if (setup.narrate) {
    const narration = await openAiNarrationPatch(world.post);
    if (narration) await world.patch(narration);
    else narrationNotice = " Your key lists no single obvious voice model, so pick one under Narration in Admin > Speech.";
  }
  return { notice: `${mediaNotice(media.unpicked)}${narrationNotice}`.trim() };
}

// The admin settings patch for "an agent I already have": the device's server
// narrates every campaign with that program on its own sign-in. Pictures are
// left as they are: a local ComfyUI keeps painting, and without one the
// tables play with placeholder art. The program's own image tool is only
// offered after a test picture from the admin page, never from here.
export function harnessPatch(setup: AiSetup): { patch: object } | { error: string } {
  const harness = setup.harness;
  if (!harness || !["claude", "codex", "opencode", "grok"].includes(harness.id)) {
    return { error: "Choose a program first." };
  }
  const speed = setup.fast === true ? "fast" : "";
  return {
    patch: {
      harness: {
        id: harness.id,
        model: harness.model.trim().slice(0, 200),
        utilityModel: harness.utilityModel.trim().slice(0, 200),
        speed,
        utilitySpeed: speed,
      },
      text: { provider: "harness" },
    },
  };
}
