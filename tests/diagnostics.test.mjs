// The summary Troubleshooting copies for a bug report
// (src/shared/diagnostics.ts): every fact on its own line, the wrong files
// named up to a cap, home folders shortened, and nothing that is not a
// fact about the app.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeLocalAi, describeVerify, diagnosticSummary, redactHome } from "../dist/shared/diagnostics.js";

const facts = {
  app: { version: "0.17.4", installKind: "nsis", platform: "win32", arch: "x64", os: "Windows_NT 10.0.26100", runtime: "Electron 44.7.0" },
  payload: { serverVersion: "0.26.3", builtAt: "2026-10-12T07:54:39.545Z" },
  runTree: { serverVersion: "0.26.2", builtAt: "2026-10-11T00:00:00.000Z" },
  world: { state: "error", error: "The local server exited during startup (see local-server.log).", firstRun: false, dbPresent: true, keyPresent: true, packs: ["hollow_marsh"] },
  servers: 2,
  localAi: {
    installedLabel: "Qwen story model (Q4)",
    installedTierId: "qwen-q4",
    running: false,
    external: false,
    endpoint: "http://127.0.0.1:8001/v1",
    error: "The local AI server stopped 3 times in ten minutes (last exit code 139); see llama-server.log. Once the cause is fixed, start it again from Story AI, or install the story model again there.",
    comfy: { installed: true, running: true, checkpoint: "z-image-turbo.safetensors", error: "" },
  },
  verify: { unpacked: true, listed: 3786, missing: ["server.js"], changed: [".next/server/app/page.js"], hashed: false },
  paths: { userData: "~/AppData/Roaming/open-dungeon-master-client", log: "~/AppData/Roaming/open-dungeon-master-client/local-server.log" },
};

test("the summary names versions, the state of the world and the wrong files, one fact a line", () => {
  const text = diagnosticSummary(facts, new Date("2026-10-12T20:00:00.000Z"));
  assert.deepEqual(text.split("\n"), [
    "Open Dungeon Master 0.17.4 (nsis) on win32 x64, Windows_NT 10.0.26100, Electron 44.7.0",
    "Written 2026-10-12T20:00:00.000Z",
    "Bundled server: 0.26.3 built 2026-10-12T07:54:39.545Z",
    "Unpacked server: 0.26.2 built 2026-10-11T00:00:00.000Z (not the bundled build; the next start replaces it)",
    "Server files: 1 missing, 1 changed of 3786",
    "World: error (The local server exited during startup (see local-server.log).)",
    "World data: database present, key present, installed world packs hollow_marsh",
    "Saved servers: 2",
    "Local AI: Qwen story model (Q4) (qwen-q4), stopped (The local AI server stopped 3 times in ten minutes (last exit code 139); see llama-server.log. Once the cause is fixed, start it again from Story AI, or install the story model again there.)",
    "Image AI: ComfyUI running, z-image-turbo.safetensors",
    "Data folder: ~/AppData/Roaming/open-dungeon-master-client",
    "Log: ~/AppData/Roaming/open-dungeon-master-client/local-server.log",
    "  missing server.js",
    "  changed .next/server/app/page.js",
    "",
  ]);
});

test("a long list of wrong files is cut short, and a sound tree, a dev run and a never-entered world each read right", () => {
  const many = Array.from({ length: 30 }, (_, index) => `chunk-${String(index).padStart(2, "0")}.js`);
  const text = diagnosticSummary({ ...facts, verify: { ...facts.verify, missing: many, changed: [] } });
  assert.ok(text.includes("  missing chunk-19.js\n  and 10 more\n"));
  assert.ok(!text.includes("chunk-20.js"));

  const sound = diagnosticSummary({ ...facts, runTree: facts.payload, verify: { unpacked: true, listed: 3786, missing: [], changed: [], hashed: true } });
  assert.ok(sound.includes("Server files: all 3786 files present and intact\n"));
  assert.ok(!sound.includes("next start replaces"));

  const dev = diagnosticSummary({ ...facts, verify: null, runTree: null, world: { ...facts.world, firstRun: true, packs: [] } });
  assert.ok(dev.includes("Unpacked server: not unpacked yet\n"));
  assert.ok(dev.includes("Server files: no manifest to check against\n"));
  assert.ok(dev.includes(", never entered\n"));
  assert.ok(dev.includes("installed world packs none\n"));

  assert.ok(diagnosticSummary({ ...facts, verify: "skipped" }).includes("Server files: not checked\n"));
});

test("the local AI lines tell running from adopted from absent, on a phone too", () => {
  const ai = facts.localAi;
  assert.deepEqual(describeLocalAi({ ...ai, running: true, error: "" }), [
    "Local AI: Qwen story model (Q4) (qwen-q4), running at http://127.0.0.1:8001/v1",
    "Image AI: ComfyUI running, z-image-turbo.safetensors",
  ]);
  assert.equal(
    describeLocalAi({ ...ai, running: true, external: true, error: "" })[0],
    "Local AI: Qwen story model (Q4) (qwen-q4), answering at http://127.0.0.1:8001/v1, started outside the app",
  );
  assert.deepEqual(
    describeLocalAi({ ...ai, installedTierId: "", installedLabel: "", comfy: { installed: false, running: false, checkpoint: "", error: "" } }),
    ["Local AI: not installed", "Image AI: not installed"],
  );
  assert.equal(describeLocalAi({ ...ai, comfy: { installed: true, running: false, checkpoint: "", error: "The image server stopped (see comfy.log)." } })[1], "Image AI: ComfyUI stopped (The image server stopped (see comfy.log).)");
  assert.deepEqual(describeLocalAi(null), ["Local AI: not available on this device"]);
});

test("describeVerify and redactHome", () => {
  assert.equal(describeVerify(null), "no manifest to check against");
  assert.equal(describeVerify({ unpacked: false, listed: 5, missing: [], changed: [], hashed: false }), "not unpacked yet");
  assert.equal(describeVerify({ unpacked: true, listed: 5, missing: [], changed: [], hashed: false }), "all 5 files present");
  assert.equal(describeVerify({ unpacked: true, listed: 5, missing: ["a"], changed: [], hashed: true }), "1 missing of 5");
  assert.equal(redactHome("/home/kaleb/.config/odm", "/home/kaleb"), "~/.config/odm");
  assert.equal(redactHome("C:\\Users\\kaleb\\AppData", "C:\\Users\\kaleb"), "~\\AppData");
  assert.equal(redactHome("/var/lib/odm", "/home/kaleb"), "/var/lib/odm");
  assert.equal(redactHome("/home/kaleb/x", ""), "/home/kaleb/x");
});
