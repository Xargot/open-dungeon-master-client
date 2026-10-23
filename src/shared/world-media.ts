// Narration and the sound library for the device world, set from the app's
// Settings, the same in both shells. Both used to live only in the world's
// own admin page (Admin > Speech, Admin > Sound library), so a player had to
// enter the world and read about Kokoro addresses to hear the story or the
// music. Everything here goes through the routes that page uses: the masked
// settings, PATCH /api/admin/settings, the guided setup's scan of this
// computer, the narration test, and the sound pack download.
import { openAiNarrationPatch, savedAiFrom, type AdminPost } from "./ai-setup";
import type { NarrationChoice, NarrationStatus, SoundLibraryStatus } from "./types";

// The world's admin routes, as each shell calls them; a refusal throws.
export interface WorldAdmin {
  settings(): Promise<unknown>;
  patch(patch: object): Promise<void>;
  post: AdminPost;
  get(path: string): Promise<unknown>;
}

export const SETUP_PATH = "/api/admin/setup";
export const NARRATION_TEST_PATH = "/api/admin/tts-test";
export const SOUND_LIBRARY_PATH = "/api/admin/ambience";

// The release pack's size, as the world's own Sound library card says it.
export const SOUND_PACK_MB = 75;

const PROVIDERS = new Set(["", "openai", "kokoro", "off"]);
const STATES = new Set(["idle", "installing", "ready", "error"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// The masked settings and the scan's answer (null when the scan failed),
// read defensively: a newer world may add fields.
export function narrationStatusFrom(settings: unknown, scan: unknown): NarrationStatus {
  const config = (settings as { config?: { speech?: Record<string, unknown>; images?: Record<string, unknown> } } | null)
    ?.config;
  const speech = config?.speech ?? {};
  const provider = text(speech.ttsProvider);
  const kokoro = (scan as { kokoro?: { url?: unknown } | null } | null)?.kokoro;
  return {
    provider: (PROVIDERS.has(provider) ? provider : "") as NarrationStatus["provider"],
    kokoroUrl: text(speech.kokoroUrl),
    keySaved: config?.images?.hasOpenaiApiKey === true || savedAiFrom(settings).keySaved,
    found: text(kokoro?.url),
  };
}

// Which choice is in effect: an unchosen world reads aloud with a Kokoro
// that answers at the usual address, and with nothing otherwise.
export function narrationInEffect(status: NarrationStatus): "openai" | "kokoro" | "off" | "" {
  if (status.provider === "") return status.found ? "kokoro" : "";
  return status.provider;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Whether the saved Kokoro is the one the scan found (or the usual address,
// when none was saved).
function kokoroAnswers(status: NarrationStatus): boolean {
  if (!status.found) return false;
  return !status.kokoroUrl || hostOf(status.kokoroUrl) === hostOf(status.found);
}

// The card's one line about what reads the story aloud now.
export function narrationSummary(status: NarrationStatus): string {
  switch (narrationInEffect(status)) {
    case "openai":
      return status.keySaved
        ? "OpenAI's voices read the story aloud, on your key."
        : "Set to OpenAI's voices, but this world holds no OpenAI key yet, so nothing is read aloud. Add one in Story AI.";
    case "kokoro":
      if (kokoroAnswers(status)) return `Kokoro reads the story aloud, free, from ${hostOf(status.found)}.`;
      if (status.kokoroUrl && !status.found) {
        return `Kokoro at ${hostOf(status.kokoroUrl)} reads the story aloud whenever it is running there.`;
      }
      return "Set to Kokoro, but nothing answers at its usual address on this computer, so nothing is read aloud until it runs.";
    case "off":
      return "The story stays on screen; nothing is read aloud.";
    default:
      return "Nothing reads the story aloud yet. Pick a voice below.";
  }
}

// The settings patch for a choice. Model and voice are cleared on a switch
// to Kokoro, so a name only OpenAI knows is not sent to it (Kokoro's own
// defaults then apply). OpenAI's patch comes from the key's own list, in
// saveNarration.
export function narrationPatch(choice: Exclude<NarrationChoice, { kind: "openai" }>): object {
  if (choice.kind === "kokoro") {
    return { speech: { ttsProvider: "kokoro", kokoroUrl: choice.url.trim().replace(/\/+$/, "").slice(0, 500), ttsModel: "", ttsVoice: "" } };
  }
  return { speech: { ttsProvider: "off" } };
}

// A typed Kokoro address, as the world's server will be asked for it.
export function cleanKokoroUrl(raw: string): string | null {
  const typed = raw.trim();
  if (!typed) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) && !/^https?:\/\//i.test(typed)) return null;
  const withScheme = /^https?:\/\//i.test(typed) ? typed : `http://${typed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export async function readNarration(world: WorldAdmin): Promise<NarrationStatus> {
  const [settings, scan] = await Promise.all([world.settings(), world.post(SETUP_PATH, { action: "scan" }).catch(() => null)]);
  return narrationStatusFrom(settings, scan);
}

// Saves a choice and answers with what is in effect after it. `notice` says
// what is left to do ("" when nothing is).
export async function saveNarration(
  choice: NarrationChoice,
  world: WorldAdmin,
): Promise<{ error: string } | { narration: NarrationStatus; notice: string }> {
  let notice = "";
  if (choice.kind === "openai") {
    const before = narrationStatusFrom(await world.settings(), null);
    if (!before.keySaved) return { error: "This world holds no OpenAI key yet. Add one in Story AI first." };
    const patch = await openAiNarrationPatch(world.post);
    if (!patch) {
      return { error: "Your key lists no single obvious voice model. Pick one under Narration in Admin > Speech inside your world." };
    }
    await world.patch(patch);
  } else {
    await world.patch(narrationPatch(choice));
  }
  const narration = await readNarration(world);
  // A Kokoro elsewhere is not seen by the scan of this computer, so only a
  // sample can tell whether the world reaches it.
  if (choice.kind === "kokoro" && !kokoroAnswers(narration)) notice = "Saved. Use Hear a sample to check that the world reaches it.";
  return { narration, notice };
}

// One spoken line from what is saved, as an audio data URL, or the sentence
// a table would be shown when it fails.
export async function narrationSample(world: WorldAdmin): Promise<{ audio: string } | { error: string }> {
  const answer = (await world.post(NARRATION_TEST_PATH, {})) as { ok?: unknown; audio?: unknown; error?: unknown } | null;
  const audio = text(answer?.audio);
  if (answer?.ok === true && audio.startsWith("data:audio/")) return { audio };
  return { error: text(answer?.error) || "The sample did not come back." };
}

// GET/POST /api/admin/ambience, read defensively.
export function soundLibraryFrom(body: unknown): SoundLibraryStatus {
  const root = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const counts = (root.counts && typeof root.counts === "object" ? root.counts : {}) as Record<string, unknown>;
  let installed = 0;
  let total = 0;
  for (const layer of Object.values(counts)) {
    const entry = (layer && typeof layer === "object" ? layer : {}) as Record<string, unknown>;
    installed += Number(entry.installed) > 0 ? Number(entry.installed) : 0;
    total += Number(entry.total) > 0 ? Number(entry.total) : 0;
  }
  const status = String(root.status ?? "idle");
  const progress = Number(root.progress);
  return {
    installed,
    total,
    status: (STATES.has(status) ? status : "idle") as SoundLibraryStatus["status"],
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0,
    error: text(root.error),
  };
}

export function soundLibraryComplete(status: SoundLibraryStatus): boolean {
  return status.total > 0 && status.installed >= status.total;
}

// The download the card offers: the first one, another after a failure, or
// a quiet second one once a pack is in (an update may bring sounds the old
// pack lacks; the release pack itself can leave a catalog sound without
// audio, so "some missing" is not "not downloaded"). None while one runs,
// right after one finished, or with every sound in.
export function soundLibraryOffer(status: SoundLibraryStatus): "download" | "retry" | "again" | null {
  if (status.status === "installing") return null;
  if (status.status === "error") return "retry";
  if (status.installed === 0) return "download";
  if (status.status === "ready" || soundLibraryComplete(status)) return null;
  return "again";
}

export function soundLibrarySummary(status: SoundLibraryStatus): string {
  if (status.status === "installing") {
    return `Downloading the sound library: ${Math.round(status.progress * 100)}%.`;
  }
  if (status.status === "error") {
    return `The download failed: ${status.error || "no reason given"}.`;
  }
  if (soundLibraryComplete(status)) {
    return `Installed: all ${status.total} rooms, music and sounds play at your tables.`;
  }
  if (status.installed > 0) {
    return `Installed: ${status.installed} of the ${status.total} rooms, music and sounds have audio and play at your tables.`;
  }
  return `Not downloaded. The rooms, music and one-shot sounds every table can play: about ${SOUND_PACK_MB} MB, kept across updates.`;
}

export async function soundLibrary(install: boolean, world: WorldAdmin): Promise<SoundLibraryStatus> {
  const body = install ? await world.post(SOUND_LIBRARY_PATH, { action: "install" }) : await world.get(SOUND_LIBRARY_PATH);
  return soundLibraryFrom(body);
}
