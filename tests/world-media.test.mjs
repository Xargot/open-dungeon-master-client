import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanKokoroUrl,
  narrationInEffect,
  narrationPatch,
  narrationSample,
  narrationStatusFrom,
  narrationSummary,
  readNarration,
  saveNarration,
  soundLibrary,
  soundLibraryComplete,
  soundLibraryFrom,
  soundLibraryOffer,
  soundLibrarySummary,
} from "../dist/shared/world-media.js";

// Narration and the sound library as Settings sets them, outside the world.

const KEYED = { config: { text: { provider: "custom", customBaseUrl: "https://api.openai.com/v1", hasCustomApiKey: true }, images: { hasOpenaiApiKey: true }, speech: { ttsProvider: "" } } };
const BARE = { config: { text: { provider: "none" }, images: { hasOpenaiApiKey: false }, speech: { ttsProvider: "", kokoroUrl: "" } } };

// A world that answers from tables and records what was asked of it.
function fakeWorld({ settings = BARE, scan = { kokoro: null }, posts = {}, gets = {} } = {}) {
  const calls = { patches: [], posts: [], gets: [] };
  let current = structuredClone(settings);
  return {
    calls,
    world: {
      settings: async () => current,
      patch: async (patch) => {
        calls.patches.push(patch);
        if (patch.speech) current = { ...current, config: { ...current.config, speech: { ...current.config.speech, ...patch.speech } } };
      },
      post: async (path, body) => {
        calls.posts.push({ path, body });
        if (path === "/api/admin/setup") return scan;
        if (path in posts) return typeof posts[path] === "function" ? posts[path](body) : posts[path];
        throw new Error(`unexpected POST ${path}`);
      },
      get: async (path) => {
        calls.gets.push(path);
        if (path in gets) return gets[path];
        throw new Error(`unexpected GET ${path}`);
      },
    },
  };
}

test("a fresh world with nothing running reads aloud with nothing, and says so", () => {
  const status = narrationStatusFrom(BARE, { kokoro: null });
  assert.deepEqual(status, { provider: "", kokoroUrl: "", keySaved: false, found: "" });
  assert.equal(narrationInEffect(status), "");
  assert.match(narrationSummary(status), /Nothing reads the story aloud yet/);
});

test("an unchosen world with Kokoro answering here already reads aloud with it", () => {
  const status = narrationStatusFrom(BARE, { kokoro: { url: "http://127.0.0.1:8880", voices: ["af_heart"] } });
  assert.equal(narrationInEffect(status), "kokoro");
  assert.match(narrationSummary(status), /Kokoro reads the story aloud, free, from 127\.0\.0\.1:8880/);
});

test("the OpenAI key counts from the picture key or Story AI's key door", () => {
  assert.equal(narrationStatusFrom(KEYED, null).keySaved, true);
  const doorOnly = { config: { ...KEYED.config, images: {} } };
  assert.equal(narrationStatusFrom(doorOnly, null).keySaved, true);
  assert.equal(narrationStatusFrom(BARE, null).keySaved, false);
});

test("each saved choice says what it does, including the ones that cannot work yet", () => {
  const say = (speech, scan = null, settings = BARE) =>
    narrationSummary(narrationStatusFrom({ config: { ...settings.config, speech } }, scan));
  assert.match(say({ ttsProvider: "openai" }, null, KEYED), /OpenAI's voices read the story aloud, on your key/);
  assert.match(say({ ttsProvider: "openai" }), /holds no OpenAI key yet/);
  assert.match(say({ ttsProvider: "kokoro" }), /nothing answers at its usual address/);
  assert.match(say({ ttsProvider: "kokoro", kokoroUrl: "http://192.168.1.20:8880" }), /Kokoro at 192\.168\.1\.20:8880 reads the story aloud whenever/);
  assert.match(say({ ttsProvider: "off" }), /stays on screen/);
  assert.equal(narrationStatusFrom({ config: { speech: { ttsProvider: "bogus" } } }, null).provider, "");
});

test("a switch to Kokoro clears an OpenAI model and voice; off only turns it off", () => {
  assert.deepEqual(narrationPatch({ kind: "kokoro", url: "http://127.0.0.1:8880/" }), {
    speech: { ttsProvider: "kokoro", kokoroUrl: "http://127.0.0.1:8880", ttsModel: "", ttsVoice: "" },
  });
  assert.deepEqual(narrationPatch({ kind: "off" }), { speech: { ttsProvider: "off" } });
});

test("a typed Kokoro address gains its scheme and loses its trailing slash; junk is refused", () => {
  assert.equal(cleanKokoroUrl("192.168.1.20:8880"), "http://192.168.1.20:8880");
  assert.equal(cleanKokoroUrl(" https://kokoro.lan/ "), "https://kokoro.lan");
  assert.equal(cleanKokoroUrl("http://box:8880/v1/"), "http://box:8880/v1");
  assert.equal(cleanKokoroUrl(""), null);
  assert.equal(cleanKokoroUrl("http://"), null);
  assert.equal(cleanKokoroUrl("ftp://box"), null);
});

test("reading asks the settings and the scan of this computer; a failed scan finds nothing", async () => {
  const { world, calls } = fakeWorld({ scan: { kokoro: { url: "http://127.0.0.1:8880" } } });
  assert.equal((await readNarration(world)).found, "http://127.0.0.1:8880");
  assert.deepEqual(calls.posts, [{ path: "/api/admin/setup", body: { action: "scan" } }]);
  const broken = fakeWorld();
  broken.world.post = async () => {
    throw new Error("down");
  };
  assert.equal((await readNarration(broken.world)).found, "");
});

test("OpenAI's voices take the model the key lists, and are refused without a key", async () => {
  const keyed = fakeWorld({ settings: KEYED, posts: { "/api/admin/models": { recommended: "gpt-4o-mini-tts" } } });
  const saved = await saveNarration({ kind: "openai" }, keyed.world);
  assert.deepEqual(keyed.calls.patches, [{ speech: { ttsProvider: "openai", ttsBaseUrl: "", ttsModel: "gpt-4o-mini-tts", ttsVoice: "" } }]);
  assert.equal(saved.narration.provider, "openai");
  assert.equal(saved.notice, "");

  const bare = fakeWorld();
  assert.match((await saveNarration({ kind: "openai" }, bare.world)).error, /no OpenAI key yet/);
  assert.deepEqual(bare.calls.patches, []);

  const unclear = fakeWorld({ settings: KEYED, posts: { "/api/admin/models": { recommended: "" } } });
  assert.match((await saveNarration({ kind: "openai" }, unclear.world)).error, /no single obvious voice model/);
  assert.deepEqual(unclear.calls.patches, []);
});

test("Kokoro and off save at once and answer with what is in effect", async () => {
  const found = { kokoro: { url: "http://127.0.0.1:8880" } };
  const { world, calls } = fakeWorld({ scan: found });
  const kokoro = await saveNarration({ kind: "kokoro", url: "http://127.0.0.1:8880" }, world);
  assert.equal(narrationInEffect(kokoro.narration), "kokoro");
  assert.equal(kokoro.notice, "", "the Kokoro the scan found needs no check");
  const lan = await saveNarration({ kind: "kokoro", url: "http://192.168.1.20:8880" }, world);
  assert.match(lan.notice, /Hear a sample/, "one on another computer is only proven by a sample");
  const off = await saveNarration({ kind: "off" }, world);
  assert.equal(narrationInEffect(off.narration), "off");
  assert.equal(off.notice, "");
  assert.equal(calls.patches.length, 3);
});

test("a sample comes back as audio, or as the sentence a table would see", async () => {
  const good = fakeWorld({ posts: { "/api/admin/tts-test": { ok: true, audio: "data:audio/mpeg;base64,AAAA" } } });
  assert.deepEqual(await narrationSample(good.world), { audio: "data:audio/mpeg;base64,AAAA" });
  assert.deepEqual(good.calls.posts, [{ path: "/api/admin/tts-test", body: {} }]);
  const bad = fakeWorld({ posts: { "/api/admin/tts-test": { ok: false, error: "The Kokoro speech server did not answer." } } });
  assert.deepEqual(await narrationSample(bad.world), { error: "The Kokoro speech server did not answer." });
  const odd = fakeWorld({ posts: { "/api/admin/tts-test": { ok: true, audio: "javascript:alert(1)" } } });
  assert.deepEqual(await narrationSample(odd.world), { error: "The sample did not come back." });
});

const EMPTY_LIBRARY = {
  counts: { bed: { installed: 0, total: 30, files: 0 }, music: { installed: 0, total: 25, files: 0 }, sting: { installed: 0, total: 22, files: 0 } },
  files: 0,
  packUrl: "https://example.test/ambience-pack.zip",
  status: "idle",
  progress: 0,
  error: "",
  result: null,
};

test("the sound library counts every layer and says what is missing", () => {
  const empty = soundLibraryFrom(EMPTY_LIBRARY);
  assert.deepEqual(empty, { installed: 0, total: 77, status: "idle", progress: 0, error: "" });
  assert.match(soundLibrarySummary(empty), /Not downloaded.*about 75 MB/);
  assert.equal(soundLibraryComplete(empty), false);

  const partial = soundLibraryFrom({ ...EMPTY_LIBRARY, counts: { ...EMPTY_LIBRARY.counts, bed: { installed: 30, total: 30 } } });
  assert.match(soundLibrarySummary(partial), /^Installed: 30 of the 77 rooms, music and sounds have audio/);

  const full = soundLibraryFrom({
    ...EMPTY_LIBRARY,
    status: "ready",
    progress: 1,
    counts: { bed: { installed: 30, total: 30 }, music: { installed: 25, total: 25 }, sting: { installed: 22, total: 22 } },
  });
  assert.equal(soundLibraryComplete(full), true);
  assert.match(soundLibrarySummary(full), /^Installed: all 77/);
});

test("the card offers the first download, a retry, or a quiet second one; never a loop after a pack lands", () => {
  const counts = (installed) => ({ bed: { installed, total: 30 }, music: { installed: 0, total: 25 }, sting: { installed: 0, total: 22 } });
  assert.equal(soundLibraryOffer(soundLibraryFrom(EMPTY_LIBRARY)), "download");
  assert.equal(soundLibraryOffer(soundLibraryFrom({ ...EMPTY_LIBRARY, status: "installing" })), null);
  assert.equal(soundLibraryOffer(soundLibraryFrom({ ...EMPTY_LIBRARY, status: "error", error: "x" })), "retry");
  // The 0.28.3 pack leaves one catalog sound (spell_dark) without audio:
  // just installed, nothing more is offered; on a later visit, a quiet one.
  assert.equal(soundLibraryOffer(soundLibraryFrom({ ...EMPTY_LIBRARY, status: "ready", counts: counts(29) })), null);
  assert.equal(soundLibraryOffer(soundLibraryFrom({ ...EMPTY_LIBRARY, counts: counts(29) })), "again");
  const full = { bed: { installed: 30, total: 30 }, music: { installed: 25, total: 25 }, sting: { installed: 22, total: 22 } };
  assert.equal(soundLibraryOffer(soundLibraryFrom({ ...EMPTY_LIBRARY, counts: full })), null);
});

test("a download in flight shows its percentage; a failure says why; junk reads as empty", () => {
  assert.equal(soundLibrarySummary(soundLibraryFrom({ ...EMPTY_LIBRARY, status: "installing", progress: 0.426 })), "Downloading the sound library: 43%.");
  assert.match(soundLibrarySummary(soundLibraryFrom({ ...EMPTY_LIBRARY, status: "error", error: "github.com answered 404." })), /The download failed: github\.com answered 404\./);
  assert.deepEqual(soundLibraryFrom(null), { installed: 0, total: 0, status: "idle", progress: 0, error: "" });
  assert.equal(soundLibraryFrom({ status: "installing", progress: 7 }).progress, 1);
});

test("the library is read with a GET and downloaded with the release pack's POST", async () => {
  const { world, calls } = fakeWorld({
    gets: { "/api/admin/ambience": EMPTY_LIBRARY },
    posts: { "/api/admin/ambience": { ...EMPTY_LIBRARY, status: "installing", progress: 0 } },
  });
  assert.equal((await soundLibrary(false, world)).status, "idle");
  assert.deepEqual(calls.gets, ["/api/admin/ambience"]);
  assert.equal((await soundLibrary(true, world)).status, "installing");
  assert.deepEqual(calls.posts, [{ path: "/api/admin/ambience", body: { action: "install" } }]);
});
