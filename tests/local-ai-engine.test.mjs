// Which llama.cpp build the local AI installs and which device it runs on
// (src/main/local-ai/engine.ts, hardware.ts), after a Windows laptop with
// integrated graphics beside an NVIDIA card ran the story model on the
// integrated GPU, and every NVIDIA machine got the Vulkan build.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { enginePlan, vulkanPlan, parseDevices, pickDevice, engineCurrent, cudaAtLeast, findServer, readEngine, swapInEngine, LLAMA_TAG } = require("../dist/main/local-ai/engine.js");
const { windowsGpus, mergeNvidia, parseNvidiaSmi, hardwareFor, cudaFromDriver, isUnified } = require("../dist/main/local-ai/hardware.js");
const { presetFor, utilityPresetSection, catalogEntry } = require("../dist/main/local-ai/catalog.js");

const rtx = (extra = {}) => ({
  id: "GPU-1", name: "NVIDIA GeForce RTX 4070 Laptop GPU", vendor: "nvidia", vramGb: 8, integrated: false,
  computeCap: 8.9, cudaVersion: "13.4", index: 0, ...extra,
});

test("an NVIDIA card gets the CUDA build its driver can run, else Vulkan", () => {
  assert.equal(enginePlan("win32", "x64", rtx()).backend, "cuda13");
  assert.deepEqual(enginePlan("win32", "x64", rtx()).files, [`llama-${LLAMA_TAG}-bin-win-cuda-13.4-x64.zip`, "cudart-llama-bin-win-cuda-13.4-x64.zip"]);
  assert.equal(enginePlan("linux", "x64", rtx()).files[1], `cudart-llama-${LLAMA_TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`, "the runtime comes along");
  // A driver that runs CUDA 13.0 is older than the 13.4 toolkit: its PTX
  // would not compile, so the CUDA 12 build it can run.
  assert.equal(enginePlan("win32", "x64", rtx({ cudaVersion: "13.0" })).backend, "cuda12");
  assert.equal(enginePlan("linux", "x64", rtx({ cudaVersion: "12.6" })).backend, "vulkan", "Linux's CUDA 12 build is 12.8");
  assert.equal(enginePlan("win32", "x64", rtx({ cudaVersion: "12.6" })).backend, "cuda12", "Windows' is 12.4");
  // CUDA 13 dropped Pascal.
  assert.equal(enginePlan("win32", "x64", rtx({ computeCap: 6.1, name: "GeForce GTX 1080" })).backend, "cuda12");
  assert.equal(enginePlan("win32", "x64", rtx({ cudaVersion: "" })).backend, "vulkan", "no working driver");
});

test("CUDA versions compare part by part, so 13.10 is past 13.4", () => {
  assert.equal(cudaAtLeast("13.10", "13.4"), true);
  assert.equal(cudaAtLeast("13.4", "13.4"), true);
  assert.equal(cudaAtLeast("13.3", "13.4"), false);
  assert.equal(cudaAtLeast("12.10", "12.8"), true);
  assert.equal(cudaAtLeast("", "12.4"), false);
  assert.equal(cudaAtLeast(undefined, "12.4"), false);
  assert.equal(enginePlan("linux", "x64", rtx({ cudaVersion: "13.10" })).backend, "cuda13");
  assert.equal(enginePlan("linux", "x64", rtx({ cudaVersion: "12.10" })).backend, "cuda12");
});

test("AMD, Intel and no GPU run Vulkan; Apple Silicon Metal; others nothing", () => {
  assert.equal(enginePlan("win32", "x64", { id: "a", name: "AMD Radeon RX 7900 XT", vendor: "amd", vramGb: 20, integrated: false }).backend, "vulkan");
  assert.equal(enginePlan("linux", "x64", null).backend, "vulkan");
  assert.equal(enginePlan("darwin", "arm64", { id: "apple", name: "Apple Silicon", vendor: "apple", vramGb: 64, integrated: true }).backend, "metal");
  assert.equal(enginePlan("darwin", "x64", null), null);
  assert.equal(enginePlan("win32", "arm64", rtx()), null);
  assert.equal(vulkanPlan("darwin", "arm64"), null);
});

test("an engine counts as current only at this tag and the planned kind, or after its fallback", () => {
  const cuda = enginePlan("win32", "x64", rtx());
  assert.equal(engineCurrent({ tag: LLAMA_TAG, backend: "cuda13" }, cuda), true);
  assert.equal(engineCurrent({ tag: LLAMA_TAG, backend: "vulkan" }, cuda), false, "an NVIDIA card left on Vulkan is replaced");
  assert.equal(engineCurrent({ tag: LLAMA_TAG, backend: "vulkan", wanted: "cuda13" }, cuda), true, "a fallback is not retried every start");
  assert.equal(engineCurrent({ tag: "b10621", backend: "cuda13" }, cuda), false);
  assert.equal(engineCurrent(null, cuda), false);
});

const laptopVulkan = `
ggml_vulkan: Found 2 Vulkan devices:
Available devices:
  Vulkan0: Intel(R) UHD Graphics 770 (16226 MiB, 15000 MiB free)
  Vulkan1: NVIDIA GeForce RTX 4070 Laptop GPU (8188 MiB, 7800 MiB free)
`;

test("the device list is read from llama-server --list-devices", () => {
  assert.deepEqual(parseDevices(laptopVulkan), [
    { name: "Vulkan0", description: "Intel(R) UHD Graphics 770", totalMiB: 16226 },
    { name: "Vulkan1", description: "NVIDIA GeForce RTX 4070 Laptop GPU", totalMiB: 8188 },
  ]);
  assert.deepEqual(parseDevices("Available devices:\n  (none)\n"), []);
  assert.deepEqual(
    parseDevices("  Vulkan0: AMD Radeon 8060S Graphics (RADV GFX1151) (123392 MiB, 122496 MiB free)"),
    [{ name: "Vulkan0", description: "AMD Radeon 8060S Graphics (RADV GFX1151)", totalMiB: 123392 }],
  );
});

test("the chosen card is pinned by name, never an integrated GPU of another vendor", () => {
  const devices = parseDevices(laptopVulkan);
  assert.equal(pickDevice(devices, rtx(), "vulkan"), "Vulkan1", "not the UHD that reports more memory");
  // The player picked the iGPU on purpose.
  assert.equal(pickDevice(devices, { id: "i", name: "Intel(R) UHD Graphics 770", vendor: "intel", vramGb: 0, integrated: true }, "vulkan"), "Vulkan0");
  // Vulkan cannot see the NVIDIA card: leave it to llama.cpp rather than
  // pin the Intel GPU.
  assert.equal(pickDevice(devices.slice(0, 1), rtx(), "vulkan"), "");
  assert.equal(pickDevice(devices, null, "vulkan"), "");
  assert.equal(pickDevice([], rtx(), "cuda13"), "");
});

test("twin cards: CUDA by nvidia-smi's index, Vulkan by memory", () => {
  const twins = parseDevices("  CUDA0: NVIDIA GeForce RTX 3090 (24576 MiB, 24000 MiB free)\n  CUDA1: NVIDIA GeForce RTX 3090 (24576 MiB, 24000 MiB free)");
  assert.equal(pickDevice(twins, rtx({ name: "NVIDIA GeForce RTX 3090", index: 1 }), "cuda13"), "CUDA1");
  const amd = parseDevices("  Vulkan0: AMD Radeon Graphics (RADV GFX1103_R1) (32000 MiB, 30000 MiB free)\n  Vulkan1: AMD Radeon RX 7600 (RADV NAVI33) (8176 MiB, 8000 MiB free)");
  assert.equal(pickDevice(amd, { id: "p", name: "AMD Radeon graphics", vendor: "amd", vramGb: 8, integrated: false }, "vulkan"), "Vulkan1");
  assert.equal(pickDevice(amd, { id: "q", name: "AMD Radeon graphics", vendor: "amd", vramGb: 0.5, integrated: true }, "vulkan"), "Vulkan0");
});

test("nvidia-smi rows, names with commas included", () => {
  const rows = parseNvidiaSmi("0, GPU-aaa, NVIDIA GeForce RTX 4070 Laptop GPU, 8188, 8.9, 581.42\n1, GPU-bbb, NVIDIA RTX A6000, Ada, 49140, 8.6, 581.42\n", "13.0");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: "GPU-aaa", name: "NVIDIA GeForce RTX 4070 Laptop GPU", vendor: "nvidia", vramGb: 8, integrated: false, computeCap: 8.9, driverVersion: "581.42", cudaVersion: "13.0", index: 0 });
  assert.equal(rows[1].name, "NVIDIA RTX A6000, Ada");
  assert.equal(rows[1].vramGb, 48);
  assert.equal(parseNvidiaSmi("0, GPU-c, Tesla P40, 24576, , 535.54", "")[0].cudaVersion, "12.2", "the driver branch stands in");
  assert.equal(cudaFromDriver("580.65.06"), "13.0");
  assert.equal(cudaFromDriver("garbage"), "");
});

const windowsLaptop = {
  cim: [
    { Name: "Intel(R) UHD Graphics", AdapterRAM: 134217728 },
    { Name: "NVIDIA GeForce RTX 4070 Laptop GPU", AdapterRAM: 4293918720 },
    { Name: "Microsoft Basic Display Adapter", AdapterRAM: 0 },
  ],
  reg: [
    { Name: "Intel(R) UHD Graphics", Bytes: 134217728 },
    { Name: "NVIDIA GeForce RTX 4070 Laptop GPU", Bytes: 8585740288 },
  ],
};

test("a Windows laptop lists both adapters and runs on the NVIDIA card", () => {
  const smi = parseNvidiaSmi("0, GPU-aaa, NVIDIA GeForce RTX 4070 Laptop GPU, 8188, 8.9, 581.42", 13.0);
  const gpus = mergeNvidia(windowsGpus(windowsLaptop), smi);
  assert.deepEqual(gpus.map((gpu) => [gpu.name, gpu.integrated]), [
    ["Intel(R) UHD Graphics", true],
    ["NVIDIA GeForce RTX 4070 Laptop GPU", false],
  ]);
  const hardware = hardwareFor({ platform: "win32", arch: "x64", ramGb: 32 }, gpus, "");
  assert.equal(hardware.gpuId, "GPU-aaa");
  assert.equal(hardware.gpuVendor, "nvidia");
  assert.equal(hardware.vramGb, 8);
  assert.equal(hardware.unifiedMemory, false);
  // The player's pick wins, and an unknown id falls back to the best.
  assert.equal(hardwareFor({ platform: "win32", arch: "x64", ramGb: 32 }, gpus, "win:Intel(R) UHD Graphics").gpuName, "Intel(R) UHD Graphics");
  assert.equal(hardwareFor({ platform: "win32", arch: "x64", ramGb: 32 }, gpus, "gone").gpuId, "GPU-aaa");
});

test("an AMD APU beside an NVIDIA card no longer makes the machine 'unified'", () => {
  const apu = { id: "pci:0000:c4:00.0", name: "AMD Phoenix1", vendor: "amd", vramGb: 0.5, integrated: true };
  const card = rtx({ id: "GPU-z", vramGb: 12 });
  const shared = new Map([[apu.id, 31]]);
  const hardware = hardwareFor({ platform: "linux", arch: "x64", ramGb: 64 }, [apu, card], "", shared);
  assert.equal(hardware.gpuId, "GPU-z");
  assert.equal(hardware.unifiedMemory, false);
  assert.equal(hardware.vramGb, 12);
  // Picking the APU makes it unified, as an APU alone always was.
  const onApu = hardwareFor({ platform: "linux", arch: "x64", ramGb: 64 }, [apu, card], apu.id, shared);
  assert.equal(onApu.unifiedMemory, true);
  assert.equal(onApu.vramGb, 64);
  // A 24 GB card in a 32 GB machine is a card, not unified memory.
  assert.equal(isUnified(rtx({ vramGb: 24 }), 32, 0), false);
});

test("the preset pins the device for both models", () => {
  const hardware = { platform: "win32", arch: "x64", ramGb: 32, vramGb: 8, gpuName: "", gpuVendor: "nvidia", unifiedMemory: false };
  const story = presetFor(catalogEntry("gpt-oss-20b"), "C:/m.gguf", hardware, "CUDA0");
  assert.match(story, /^device = CUDA0$/m);
  assert.match(utilityPresetSection("C:/u.gguf", "CUDA0"), /^device = CUDA0$/m);
  assert.doesNotMatch(presetFor(catalogEntry("gpt-oss-20b"), "C:/m.gguf", hardware), /^device/m, "no device: llama.cpp chooses");
});

test("the installed engine is read for the platform it is given, not the one running the test", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-engine-"));
  try {
    fs.mkdirSync(path.join(dir, "llama-b10621"));
    fs.writeFileSync(path.join(dir, "llama-b10621", "llama-server.exe"), "");
    assert.equal(findServer(dir, "win32"), path.join(dir, "llama-b10621", "llama-server.exe"));
    assert.equal(findServer(dir, "linux"), null, "a Linux install looks for llama-server");
    assert.deepEqual(readEngine(dir, "b10621", "win32"), { tag: "b10621", backend: "vulkan" }, "a legacy Windows install was the Vulkan build");
    assert.equal(readEngine(dir, "b10621", "darwin"), null);
    fs.writeFileSync(path.join(dir, "llama-b10621", "llama-server"), "");
    assert.deepEqual(readEngine(dir, "b10621", "darwin"), { tag: "b10621", backend: "metal" }, "a legacy Mac install was the Metal build");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a new engine that cannot take the old one's place leaves the old engine whole", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-engine-"));
  const bin = path.join(dir, "bin");
  const staging = `${bin}.new`;
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "llama-server"), "old");
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, "llama-server"), "new");
    // Windows refuses the move while a file in the new folder is held open.
    const locked = {
      ...fs,
      existsSync: fs.existsSync,
      rmSync: fs.rmSync,
      renameSync: (from, to) => {
        if (from === staging) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
        fs.renameSync(from, to);
      },
    };
    assert.throws(() => swapInEngine(staging, bin, locked), /EPERM/);
    assert.equal(fs.readFileSync(path.join(bin, "llama-server"), "utf8"), "old", "the engine that worked is still there");

    swapInEngine(staging, bin);
    assert.equal(fs.readFileSync(path.join(bin, "llama-server"), "utf8"), "new");
    assert.equal(fs.existsSync(`${bin}.old`), false, "the old engine is cleared once the new one is in place");
    assert.equal(fs.existsSync(staging), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
