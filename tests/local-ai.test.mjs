import assert from "node:assert/strict";
import test from "node:test";
import {
  CATALOG,
  catalogEntry,
  meetsMinimum,
  memoryBudgetGb,
  presetFor,
  RETIRED,
  sizeTiers,
  utilityFits,
  utilityPresetSection,
  UTILITY_ENTRY,
} from "../dist/main/local-ai/catalog.js";
import { hfFileInfo, magicOk } from "../dist/main/local-ai/download.js";
import { pickWindowsGpu, readWindowsAdapters } from "../dist/main/local-ai/hardware.js";
import { enginePlan } from "../dist/main/local-ai/engine.js";

const gamingPc = {
  platform: "linux",
  arch: "x64",
  ramGb: 32,
  vramGb: 16,
  gpuName: "RTX 4080",
  gpuVendor: "nvidia",
  unifiedMemory: false,
};

const smallLaptop = {
  platform: "win32",
  arch: "x64",
  ramGb: 16,
  vramGb: 0,
  gpuName: "",
  gpuVendor: "",
  unifiedMemory: false,
};

const mac = {
  platform: "darwin",
  arch: "arm64",
  ramGb: 64,
  vramGb: 64,
  gpuName: "Apple Silicon",
  gpuVendor: "apple",
  unifiedMemory: true,
};

test("llama archives exist for the three shipped platforms only", () => {
  assert.ok(enginePlan("linux", "x64", null)?.files[0].includes("ubuntu-vulkan-x64"));
  assert.ok(enginePlan("win32", "x64", null)?.files[0].includes("win-vulkan-x64"));
  assert.ok(enginePlan("darwin", "arm64", null)?.files[0].includes("macos-arm64"));
  assert.equal(enginePlan("linux", "arm64", null), null);
});

test("the ladder is ordered largest first and ends with gpt-oss-20b, the 16 GB minimum", () => {
  for (let i = 1; i < CATALOG.length; i += 1) {
    assert.ok(CATALOG[i].sizeGb < CATALOG[i - 1].sizeGb);
  }
  assert.equal(CATALOG[CATALOG.length - 1].id, "gpt-oss-20b");
  assert.equal(CATALOG[CATALOG.length - 1].needsGb, 16);
  assert.deepEqual(RETIRED.map((entry) => entry.id), ["qwen-q3", "qwen-q2", "gemma-12b"]);
  assert.ok(!CATALOG.some((entry) => RETIRED.includes(entry)));
});

test("a 16GB VRAM gaming PC gets the standard story quant via MoE offload", () => {
  const tiers = sizeTiers(gamingPc, "");
  const recommended = tiers.find((tier) => tier.recommended);
  assert.equal(recommended?.id, "qwen-q4");
  assert.equal(tiers.find((tier) => tier.id === "qwen-q8")?.fits, false);
});

test("a machine without 16 GB of graphics memory is offered no storyteller", () => {
  assert.equal(meetsMinimum(smallLaptop), false);
  const tiers = sizeTiers(smallLaptop, "");
  assert.ok(tiers.every((tier) => !tier.fits && !tier.recommended));
  // An 8 GB card is below the minimum however much memory sits beside it.
  const eightGb = { ...gamingPc, vramGb: 8, ramGb: 64 };
  assert.ok(memoryBudgetGb(eightGb) >= 28);
  assert.ok(sizeTiers(eightGb, "").every((tier) => !tier.fits));
  // A 16 GB Mac leaves its GPU about 13 GB; a 24 GB one clears the minimum.
  assert.equal(meetsMinimum({ ...mac, ramGb: 16, vramGb: 16 }), false);
  assert.equal(sizeTiers({ ...mac, ramGb: 24, vramGb: 24 }, "").find((tier) => tier.recommended)?.id, "gpt-oss-20b");
});

test("a 16 GB card with 16 GB beside it gets gpt-oss-20b, all of it on the card", () => {
  const card = { ...gamingPc, ramGb: 16 };
  const tiers = sizeTiers(card, "");
  assert.equal(tiers.find((tier) => tier.recommended)?.id, "gpt-oss-20b");
  assert.equal(tiers.find((tier) => tier.id === "qwen-q4")?.fits, false);
  const preset = presetFor(catalogEntry("gpt-oss-20b"), "/m.gguf", card);
  assert.ok(preset.includes("[gpt-oss-20b]"));
  assert.ok(preset.includes("c = 65536"));
  assert.ok(preset.includes("reasoning-budget = 1024"));
  assert.ok(!preset.includes("cpu-moe"));
  // Qwen's tuning is not gpt-oss's: no presence penalty, reasoning not off.
  assert.ok(!preset.includes("presence-penalty"));
  assert.ok(!preset.includes("reasoning = off"));
});

test("an install from before the minimum still starts and shows, and is never offered", () => {
  assert.equal(catalogEntry("gemma-12b")?.alias, "gemma-4-12b-qat");
  assert.equal(catalogEntry("qwen-q2")?.alias, "qwen3.6-35b");
  const fresh = sizeTiers(gamingPc, "");
  assert.ok(!fresh.some((tier) => RETIRED.some((entry) => entry.id === tier.id)));
  const kept = sizeTiers(smallLaptop, "gemma-12b");
  const gemma = kept.find((tier) => tier.id === "gemma-12b");
  assert.equal(gemma?.installed, true);
  assert.equal(gemma?.recommended, false);
  const q2 = sizeTiers(gamingPc, "qwen-q2");
  assert.equal(q2.find((tier) => tier.id === "qwen-q2")?.installed, true);
  assert.equal(q2.find((tier) => tier.recommended)?.id, "qwen-q4");
});

test("unified memory counts the whole pool", () => {
  const tiers = sizeTiers(mac, "");
  assert.equal(tiers.find((tier) => tier.recommended)?.id, "qwen-q8");
});

test("installed flag rides through", () => {
  const tiers = sizeTiers(gamingPc, "qwen-q4");
  assert.equal(tiers.find((tier) => tier.id === "qwen-q4")?.installed, true);
});

test("the preset carries the tuned recipe and offloads experts when needed", () => {
  const entry = catalogEntry("qwen-q4");
  const preset = presetFor(entry, "/models/x.gguf", gamingPc);
  assert.ok(preset.includes("[qwen3.6-35b]"));
  assert.ok(preset.includes("model = /models/x.gguf"));
  assert.ok(preset.includes("presence-penalty = 1.5"));
  assert.ok(preset.includes("reasoning-budget = 2048"));
  assert.ok(preset.includes("load-on-startup = true"));
  // 22GB file vs 16GB VRAM: experts spill to RAM.
  assert.ok(preset.includes("cpu-moe = true"));
});

test("no expert offload on unified memory or when VRAM holds the file", () => {
  const entry = catalogEntry("qwen-q8");
  assert.ok(!presetFor(entry, "/m.gguf", mac).includes("cpu-moe"));
  const bigCard = { ...gamingPc, vramGb: 48 };
  const q4 = catalogEntry("qwen-q4");
  assert.ok(!presetFor(q4, "/m.gguf", bigCard).includes("cpu-moe"));
});

test("the fallback preset is dense: no MoE keys, gemma sampling", () => {
  const entry = catalogEntry("gemma-12b");
  const preset = presetFor(entry, "/m.gguf", smallLaptop);
  assert.ok(preset.includes("[gemma-4-12b-qat]"));
  assert.ok(!preset.includes("cpu-moe"));
  assert.ok(!preset.includes("reasoning-budget"));
  assert.ok(preset.includes("top-k = 64"));
});

test("the utility model is a small dense GGUF from the ungated unsloth family", () => {
  assert.ok(UTILITY_ENTRY.url.startsWith("https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/"));
  assert.ok(UTILITY_ENTRY.file.endsWith(".gguf"));
  assert.ok(UTILITY_ENTRY.sizeGb < 4);
  assert.equal(UTILITY_ENTRY.moe, false);
  assert.ok(!CATALOG.some((entry) => entry.id === UTILITY_ENTRY.id));
});

test("the utility model rides along only when the budget covers both", () => {
  // 51 GB unified budget holds q4 (28) plus the utility (5) easily.
  assert.equal(utilityFits(catalogEntry("qwen-q4"), mac), true);
  // The 32 GB gaming budget is spent on the story model alone.
  assert.equal(utilityFits(catalogEntry("qwen-q4"), gamingPc), false);
  assert.equal(utilityFits(catalogEntry("gemma-12b"), smallLaptop), false);
});

test("the utility preset section loads on demand with its own alias", () => {
  const section = utilityPresetSection("/models/util.gguf");
  assert.ok(section.includes(`[${UTILITY_ENTRY.alias}]`));
  assert.ok(section.includes("model = /models/util.gguf"));
  assert.ok(section.includes("load-on-startup = false"));
  assert.ok(!section.includes("version ="));
});

test("catalog urls parse into HF repo coordinates for checksum lookup", () => {
  const info = hfFileInfo(CATALOG[0].url);
  assert.deepEqual(info, {
    repo: "unsloth/Qwen3.6-35B-A3B-GGUF",
    revision: "main",
    file: CATALOG[0].file,
  });
  assert.ok(hfFileInfo(UTILITY_ENTRY.url));
  assert.deepEqual(hfFileInfo(catalogEntry("gpt-oss-20b").url), {
    repo: "ggml-org/gpt-oss-20b-GGUF",
    revision: "main",
    file: "gpt-oss-20b-MXFP4.gguf",
  });
  assert.equal(hfFileInfo("https://example.com/not-a-model.gguf"), null);
});

test("magic sniffing accepts real files and rejects an HTML error page", () => {
  const html = Buffer.from("<!DOCTYPE html><html><body>404</body></html>");
  assert.equal(magicOk("gguf", html), false);
  assert.equal(magicOk("safetensors", html), false);
  assert.equal(magicOk("archive", html), false);
  assert.equal(magicOk("gguf", Buffer.from("GGUF   ")), true);
  const safetensors = Buffer.alloc(16);
  safetensors.writeBigUInt64LE(120n, 0);
  safetensors[8] = 0x7b;
  assert.equal(magicOk("safetensors", safetensors), true);
  assert.equal(magicOk("archive", Buffer.from([0x1f, 0x8b, 0x08, 0x00])), true);
  assert.equal(magicOk("archive", Buffer.from("PK")), true);
  assert.equal(magicOk("gguf", Buffer.alloc(0)), false);
});

// Issue 91: a 20 GB Radeon RX 7900 XT scanned as 4 GB on Windows.
const GB = 1024 ** 3;
const RX_7900_XT = "AMD Radeon RX 7900 XT";

test("a Windows card over 4 GB reads its real size from the driver's 64-bit figure, not the 32-bit AdapterRAM", () => {
  // What the 32-bit field alone says: just under 4 GB, whatever the card.
  const old = pickWindowsGpu({ cim: [{ Name: RX_7900_XT, AdapterRAM: 4293918720 }], reg: [] });
  assert.equal(Math.round(old.vramGb), 4);
  const picked = pickWindowsGpu({
    cim: [{ Name: RX_7900_XT, AdapterRAM: 4293918720 }],
    reg: [{ Name: RX_7900_XT, Bytes: 20 * GB }],
  });
  assert.equal(Math.round(picked.vramGb), 20);
  assert.equal(picked.gpuName, RX_7900_XT);
  assert.equal(picked.vendor, "amd");
});

test("the registry figure is read as a QWORD or as eight little-endian bytes", () => {
  const bytes = [0, 0, 0, 0, 5, 0, 0, 0]; // 5 * 2^32 = 20 GB
  const picked = pickWindowsGpu({ cim: [{ Name: RX_7900_XT, AdapterRAM: 4293918720 }], reg: [{ Name: RX_7900_XT, Bytes: bytes }] });
  assert.equal(Math.round(picked.vramGb), 20);
});

test("the real card is picked over an integrated adapter listed first, and over a software one", () => {
  const picked = pickWindowsGpu({
    cim: [
      { Name: "AMD Radeon(TM) Graphics", AdapterRAM: 536870912 },
      { Name: "NVIDIA GeForce RTX 4090", AdapterRAM: 4293918720 },
      { Name: "Microsoft Remote Display Adapter", AdapterRAM: null },
    ],
    reg: [
      { Name: "AMD Radeon(TM) Graphics", Bytes: 536870912 },
      { Name: "NVIDIA GeForce RTX 4090", Bytes: 24 * GB },
      { Name: "Microsoft Remote Display Adapter", Bytes: null },
    ],
  });
  assert.equal(picked.gpuName, "NVIDIA GeForce RTX 4090");
  assert.equal(Math.round(picked.vramGb), 24);
  assert.equal(picked.vendor, "nvidia");
});

test("no signal, or a driver with no 64-bit figure, degrades to what there is", () => {
  assert.deepEqual(pickWindowsGpu(null), { vramGb: 0, gpuName: "", vendor: "" });
  const small = pickWindowsGpu({ cim: [{ Name: "Intel(R) UHD Graphics", AdapterRAM: 1073741824 }], reg: [{ Name: "Intel(R) UHD Graphics" }] });
  assert.equal(small.vramGb, 1);
  assert.equal(small.vendor, "");
  assert.equal(pickWindowsGpu({ cim: [{ Name: 7, AdapterRAM: "x" }], reg: [{ Bytes: [1, 2, "x"] }] }).vramGb, 0);
});

test("the corrected scan moves the reporter's machine up the ladder and keeps a model that fits the card on the card", () => {
  const machine = { platform: "win32", arch: "x64", ramGb: 32, gpuName: RX_7900_XT, gpuVendor: "amd", unifiedMemory: false };
  const before = sizeTiers({ ...machine, vramGb: 4 }, "").find((tier) => tier.recommended);
  const after = sizeTiers({ ...machine, vramGb: 20 }, "").find((tier) => tier.recommended);
  // Misread as 4 GB the card sat below the 16 GB minimum and was offered nothing.
  assert.equal(before, undefined);
  assert.equal(after.id, "qwen-q4");
  const q2 = catalogEntry("qwen-q2");
  assert.match(presetFor(q2, "/m/q2.gguf", { ...machine, vramGb: 4 }), /cpu-moe/);
  assert.doesNotMatch(presetFor(q2, "/m/q2.gguf", { ...machine, vramGb: 20 }), /cpu-moe/);
});

// On Windows itself (the release workflow's windows-latest job): the real
// PowerShell call runs and its output parses.
test("the Windows adapter scan runs on Windows", { skip: process.platform !== "win32" }, async () => {
  const adapters = await readWindowsAdapters();
  assert.ok(adapters, "the PowerShell scan failed or printed no JSON");
  const picked = pickWindowsGpu(adapters);
  assert.ok(Number.isFinite(picked.vramGb) && picked.vramGb >= 0);
});
