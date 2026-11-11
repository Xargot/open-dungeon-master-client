import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { GpuInfo } from "../../shared/types";
import { downloadVerified } from "./download";

const runFile = promisify(execFile);

// Which llama.cpp build runs the story model, and on which device.
//
// Pinned to the build behind llama.cpp's v0.9.0 release (b12110), not to the
// newest nightly: the generated models preset depends on this build's flags,
// and each archive's SHA-256 is checked against the table below. Raising
// LLAMA_TAG means copying the new release's digests (GitHub lists one per
// asset) into ASSETS.
//
// The build follows the card the local AI runs on: CUDA for an NVIDIA card
// whose driver runs the CUDA version the build was made with, Vulkan for
// AMD, Intel and older NVIDIA drivers, Metal on Apple Silicon. The device is
// then pinned by name from `llama-server --list-devices`, so a machine with
// an integrated GPU beside the real card never ends up running the model on
// the wrong one.
export const LLAMA_TAG = "b12110";
const BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}`;

export type EngineBackend = "cuda13" | "cuda12" | "vulkan" | "metal";

interface Asset {
  sha256: string;
  // Download size, for the disk check and the progress label.
  mb: number;
}

const ASSETS: Record<string, Asset> = {
  [`llama-${LLAMA_TAG}-bin-ubuntu-vulkan-x64.tar.gz`]: { sha256: "a5d741940956ec62e8783aee7e5a4c7c761af867d6f027c3277a51e1a3ac59b0", mb: 36 },
  [`llama-${LLAMA_TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`]: { sha256: "2afd2ca540da119570b1dac36b5a2c862bb03a3b789c46661dfa55e600f5b19b", mb: 168 },
  [`cudart-llama-${LLAMA_TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`]: { sha256: "9b1110161943882ec85c8e9ae641075ee8c962a50f8f1e36534ee65ea1e56ed9", mb: 440 },
  [`llama-${LLAMA_TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz`]: { sha256: "4af1e1da23661db4a5b84b29aae16ebc053df689c5b8b1427c4670f2c6406d8c", mb: 187 },
  [`cudart-llama-${LLAMA_TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz`]: { sha256: "6f1d562086d84ae85df880d3711079ec225602b51d530608e5001600625067dd", mb: 594 },
  [`llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`]: { sha256: "9732a5e48887ca54d0bfe4af4324dc85fd56cd8cda19b52df3542fa6ebe6874f", mb: 38 },
  [`llama-${LLAMA_TAG}-bin-win-cuda-13.4-x64.zip`]: { sha256: "dc910a969190b5d42e189afd73117f6bbdd8dd8ed6586342c5e0b82cab62c673", mb: 169 },
  // The Windows runtime archives carry no build number in their names.
  "cudart-llama-bin-win-cuda-13.4-x64.zip": { sha256: "738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668", mb: 424 },
  [`llama-${LLAMA_TAG}-bin-win-cuda-12.4-x64.zip`]: { sha256: "1ce755bc3a061889234048f88e33328e17971eaad73c4666cfeb26026b317fee", mb: 287 },
  "cudart-llama-bin-win-cuda-12.4-x64.zip": { sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6", mb: 391 },
  [`llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz`]: { sha256: "4f5b8de12e0b9516658ca6a5764c6ffb3d7c659c3dd538556b1413c7b4050662", mb: 17 },
};

export interface EnginePlan {
  backend: EngineBackend;
  // For people: "CUDA 13", "Vulkan".
  label: string;
  // The first archive holds llama-server; the rest are runtime libraries
  // that must sit beside it (the CUDA builds look in their own folder).
  files: string[];
}

const LABELS: Record<EngineBackend, string> = {
  cuda13: "CUDA 13",
  cuda12: "CUDA 12",
  vulkan: "Vulkan",
  metal: "Metal",
};

export function backendLabel(backend: string): string {
  return LABELS[backend as EngineBackend] ?? backend;
}

export function engineSupported(platform: string, arch: string): boolean {
  return (platform === "linux" || platform === "win32") ? arch === "x64" : platform === "darwin" && arch === "arm64";
}

function build(platform: string, backend: EngineBackend): EnginePlan {
  const linux = platform === "linux";
  const files: Record<EngineBackend, string[]> = {
    vulkan: [linux ? `llama-${LLAMA_TAG}-bin-ubuntu-vulkan-x64.tar.gz` : `llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`],
    cuda13: linux
      ? [`llama-${LLAMA_TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`, `cudart-llama-${LLAMA_TAG}-bin-ubuntu-cuda-13.4-x64.tar.gz`]
      : [`llama-${LLAMA_TAG}-bin-win-cuda-13.4-x64.zip`, "cudart-llama-bin-win-cuda-13.4-x64.zip"],
    cuda12: linux
      ? [`llama-${LLAMA_TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz`, `cudart-llama-${LLAMA_TAG}-bin-ubuntu-cuda-12.8-x64.tar.gz`]
      : [`llama-${LLAMA_TAG}-bin-win-cuda-12.4-x64.zip`, "cudart-llama-bin-win-cuda-12.4-x64.zip"],
    metal: [`llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz`],
  };
  return { backend, label: LABELS[backend], files: files[backend] };
}

// The CUDA version each build was compiled with. The driver must run at
// least that version: these builds carry PTX for most cards, and a driver
// older than the toolkit cannot compile it ("the provided PTX was compiled
// with an unsupported toolchain" on the first request), so CUDA's
// minor-version compatibility does not hold here.
function cudaToolkit(platform: string, backend: "cuda13" | "cuda12"): string {
  if (backend === "cuda13") return "13.4";
  return platform === "linux" ? "12.8" : "12.4";
}

// Whether a CUDA version ("13.10", as nvidia-smi prints it) is at least
// another, part by part: read as decimals 13.10 would be 13.1 and fall below
// 13.4.
export function cudaAtLeast(version: string | number | undefined, min: string): boolean {
  const parts = (value: string) => value.split(".").map((part) => parseInt(part, 10) || 0);
  const have = parts(String(version ?? ""));
  const want = parts(min);
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    const diff = (have[i] ?? 0) - (want[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

// What to install for the card the local AI runs on. null where the app has
// no build for the platform.
export function enginePlan(platform: string, arch: string, gpu: GpuInfo | null | undefined): EnginePlan | null {
  if (!engineSupported(platform, arch)) return null;
  if (platform === "darwin") return build(platform, "metal");
  if (gpu?.vendor === "nvidia") {
    const cuda = gpu.cudaVersion;
    const cc = gpu.computeCap ?? 0;
    // CUDA 13 dropped Maxwell, Pascal and Volta (compute capability < 7.5).
    if (cudaAtLeast(cuda, cudaToolkit(platform, "cuda13")) && (cc === 0 || cc >= 7.5)) return build(platform, "cuda13");
    if (cudaAtLeast(cuda, cudaToolkit(platform, "cuda12")) && (cc === 0 || cc >= 5)) return build(platform, "cuda12");
  }
  // AMD and Intel run best and most reliably on Vulkan (the ROCm and SYCL
  // builds need runtimes most machines do not have); so does an NVIDIA card
  // whose driver is too old for either CUDA build.
  return build(platform, "vulkan");
}

// The plan to fall back on when a CUDA build cannot see the card.
export function vulkanPlan(platform: string, arch: string): EnginePlan | null {
  if (!engineSupported(platform, arch) || platform === "darwin") return null;
  return build(platform, "vulkan");
}

export function engineUrl(file: string): string {
  return `${BASE}/${file}`;
}

export function engineSha256(file: string): string | null {
  return ASSETS[file]?.sha256 ?? null;
}

export function planDownloadMb(plan: EnginePlan): number {
  return plan.files.reduce((sum, file) => sum + (ASSETS[file]?.mb ?? 0), 0);
}

// ---------- devices ----------

export interface LlamaDevice {
  // What --device takes: "CUDA0", "Vulkan1", "MTL0".
  name: string;
  description: string;
  totalMiB: number;
}

// `llama-server --list-devices` prints
//   Available devices:
//     Vulkan0: AMD Radeon 8060S Graphics (RADV GFX1151) (123392 MiB, 122496 MiB free)
export function parseDevices(output: string): LlamaDevice[] {
  const devices: LlamaDevice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_-]*\d+):\s+(.+?)\s+\((\d+)\s*MiB,\s*\d+\s*MiB free\)\s*$/.exec(line);
    if (match?.[1] && match[2] && match[3]) {
      devices.push({ name: match[1], description: match[2], totalMiB: Number(match[3]) });
    }
  }
  return devices;
}

const VENDOR_WORDS: Record<string, RegExp> = {
  nvidia: /nvidia|geforce|quadro|tesla|\brtx\b|\bgtx\b/i,
  amd: /\bamd\b|radeon|\bati\b/i,
  intel: /intel|\barc\b|iris|\buhd\b/i,
};

const GENERIC = new Set(["graphics", "gpu", "laptop", "corporation", "inc", "advanced", "micro", "devices", "ati", "radv"]);

function tokens(name: string): Set<string> {
  const words = name
    .toLowerCase()
    .replace(/\((tm|r)\)|™|®/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((word) => (word.length > 1 || /\d/.test(word)) && !GENERIC.has(word));
  const out = new Set(words);
  // "Navi 31" and "NAVI31" are the same chip.
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]}${words[i + 1]}`);
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const word of a) if (b.has(word)) n += /\d/.test(word) ? 2 : 1;
  return n;
}

// The --device value that is the chosen card, "" when no listed device can
// be told to be it (llama.cpp's own choice then stands: discrete cards
// before integrated ones). Never a device of another vendor, so an Intel or
// AMD iGPU is not picked for an NVIDIA card that Vulkan cannot see.
export function pickDevice(devices: LlamaDevice[], gpu: GpuInfo | null | undefined, backend: EngineBackend): string {
  if (!gpu || backend === "metal") return "";
  const prefix = backend === "vulkan" ? "Vulkan" : "CUDA";
  const vendorWord = VENDOR_WORDS[gpu.vendor];
  const candidates = devices.filter(
    (device) => device.name.startsWith(prefix) && (backend !== "vulkan" || !vendorWord || vendorWord.test(device.description)),
  );
  if (!candidates.length) return "";
  const want = tokens(gpu.name);
  const scored = candidates.map((device) => ({ device, score: overlap(want, tokens(device.description)) }));
  const best = Math.max(...scored.map((entry) => entry.score));
  let tied = scored.filter((entry) => entry.score === best).map((entry) => entry.device);
  // A Vulkan device that shares nothing with the name is only taken when
  // the vendor check already narrowed it to one.
  if (best === 0 && backend === "vulkan" && candidates.length > 1) return "";
  if (tied.length > 1 && backend !== "vulkan" && gpu.index !== undefined) {
    // CUDA counts in PCI order here (CUDA_DEVICE_ORDER), as nvidia-smi does.
    const byIndex = tied.find((device) => device.name === `${prefix}${gpu.index}`);
    if (byIndex) tied = [byIndex];
  }
  if (tied.length > 1) {
    // Same name twice (two AMD cards known only as "Radeon"): the one whose
    // memory matches. An integrated GPU reports shared RAM, so it is the
    // larger one.
    const expectMiB = gpu.vramGb * 1024;
    tied.sort((a, b) =>
      gpu.integrated ? b.totalMiB - a.totalMiB : Math.abs(a.totalMiB - expectMiB) - Math.abs(b.totalMiB - expectMiB),
    );
  }
  return tied[0]?.name ?? "";
}

// ---------- the installed engine ----------

export interface InstalledEngine {
  tag: string;
  backend: EngineBackend;
  // What the plan asked for, when a fallback was installed instead (a CUDA
  // build that could not see the card): the same plan is then not retried
  // at every start.
  wanted?: EngineBackend;
}

const MARKER = "engine.json";

export function findServer(dir: string, platform: string): string | null {
  const name = platform === "win32" ? "llama-server.exe" : "llama-server";
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  return null;
}

// The engine in binDir. One from before the marker existed was always the
// Vulkan build (Metal on a Mac), at the tag state.json recorded.
export function readEngine(binDir: string, legacyTag: string, platform: string): InstalledEngine | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(binDir, MARKER), "utf8")) as InstalledEngine;
    if (parsed?.tag && parsed.backend in LABELS) return parsed;
  } catch {
    // No marker: a legacy install, or none.
  }
  if (!findServer(binDir, platform)) return null;
  return { tag: legacyTag || "unknown", backend: platform === "darwin" ? "metal" : "vulkan" };
}

// Whether the installed engine is the right kind for the plan.
export function sameBackend(installed: InstalledEngine, plan: EnginePlan): boolean {
  return installed.backend === plan.backend || installed.wanted === plan.backend;
}

export function engineCurrent(installed: InstalledEngine | null, plan: EnginePlan): boolean {
  return installed !== null && installed.tag === LLAMA_TAG && sameBackend(installed, plan);
}

// llama-server's environment: its shared libraries sit beside it (Linux
// looks there through LD_LIBRARY_PATH too), and CUDA counts cards in PCI
// order, the order nvidia-smi's index uses.
export function engineEnv(bin: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LD_LIBRARY_PATH: `${path.dirname(bin)}:${process.env.LD_LIBRARY_PATH ?? ""}`,
    CUDA_DEVICE_ORDER: "PCI_BUS_ID",
  };
}

export async function listDevices(bin: string): Promise<LlamaDevice[]> {
  try {
    const { stdout, stderr } = await runFile(bin, ["--list-devices"], {
      env: engineEnv(bin),
      timeout: 60_000,
      windowsHide: true,
    });
    return parseDevices(`${stdout}\n${stderr}`);
  } catch (err) {
    const out = err as { stdout?: unknown; stderr?: unknown };
    return parseDevices(`${String(out.stdout ?? "")}\n${String(out.stderr ?? "")}`);
  }
}

function moveFilesInto(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const full = path.join(from, entry.name);
    if (entry.isDirectory()) moveFilesInto(full, to);
    else fs.renameSync(full, path.join(to, entry.name));
  }
}

type Progress = (label: string, percent: number) => void;

// Downloads and unpacks one plan into an empty folder: the first archive as
// it comes, the runtime archives flattened in beside llama-server.
async function unpackPlan(plan: EnginePlan, platform: string, rootDir: string, target: string, onProgress: Progress): Promise<string> {
  const total = Math.max(1, planDownloadMb(plan));
  let done = 0;
  const label = `Downloading the AI engine (llama.cpp ${LLAMA_TAG}, ${plan.label}, about ${total} MB)`;
  let bin: string | null = null;
  for (const [i, file] of plan.files.entries()) {
    const archive = path.join(rootDir, file);
    const share = (ASSETS[file]?.mb ?? 0) / total;
    await downloadVerified(engineUrl(file), archive, {
      kind: "archive",
      sha256: engineSha256(file),
      onProgress: (percent) => onProgress(label, done + share * percent),
    });
    done += share * 100;
    // bsdtar (shipped on Windows 10+ and macOS) and GNU tar both unpack
    // .tar.gz; bsdtar also reads the Windows .zip assets.
    if (i === 0) {
      await runFile("tar", ["-xf", archive, "-C", target]);
      bin = findServer(target, platform);
      if (!bin) throw new Error("The llama.cpp archive did not contain llama-server.");
    } else {
      const extra = path.join(target, `.extra-${i}`);
      fs.mkdirSync(extra, { recursive: true });
      await runFile("tar", ["-xf", archive, "-C", extra]);
      moveFilesInto(extra, path.dirname(bin as string));
      fs.rmSync(extra, { recursive: true, force: true });
    }
    fs.rmSync(archive, { force: true });
  }
  return bin as string;
}

type SwapFs = Pick<typeof fs, "existsSync" | "renameSync" | "rmSync">;

// Puts the staged engine where the current one is. The current one is moved
// aside first and put back if the staged one cannot take its place: deleting
// it in place can stop partway on Windows (a file the running server or an
// antivirus scan holds open), which left neither engine whole. A leftover
// aside folder is cleared by the next install.
export function swapInEngine(staging: string, binDir: string, ops: SwapFs = fs): void {
  const aside = `${binDir}.old`;
  ops.rmSync(aside, { recursive: true, force: true });
  const had = ops.existsSync(binDir);
  if (had) ops.renameSync(binDir, aside);
  try {
    ops.renameSync(staging, binDir);
  } catch (err) {
    if (had) ops.renameSync(aside, binDir);
    throw err;
  }
  try {
    ops.rmSync(aside, { recursive: true, force: true });
  } catch {
    // Still held open: the new engine is in place, and the next install clears it.
  }
}

// Installs the plan's engine beside the current one and swaps it in only
// once it is whole, so a failed or cancelled download never leaves the
// player without the engine that worked. A CUDA build that cannot see any
// CUDA device (a driver that is missing or too old after all) is replaced
// by the Vulkan build, which runs on every vendor's driver.
export async function installEngine(opts: {
  // The platform the plan was made for, which names the binary.
  platform: string;
  rootDir: string;
  binDir: string;
  plan: EnginePlan;
  fallback: EnginePlan | null;
  onProgress: Progress;
}): Promise<InstalledEngine> {
  const staging = `${opts.binDir}.new`;
  const fresh = () => {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
  };
  try {
    fresh();
    let bin = await unpackPlan(opts.plan, opts.platform, opts.rootDir, staging, opts.onProgress);
    let backend = opts.plan.backend;
    if (backend.startsWith("cuda")) {
      opts.onProgress("Checking the AI engine can see your graphics card", 100);
      const devices = await listDevices(bin);
      if (!devices.some((device) => device.name.startsWith("CUDA"))) {
        if (!opts.fallback) throw new Error("The CUDA build of llama.cpp could not find your NVIDIA card. Update the NVIDIA driver and install again.");
        fresh();
        bin = await unpackPlan(opts.fallback, opts.platform, opts.rootDir, staging, opts.onProgress);
        backend = opts.fallback.backend;
      }
    }
    const engine: InstalledEngine = { tag: LLAMA_TAG, backend, ...(backend !== opts.plan.backend ? { wanted: opts.plan.backend } : {}) };
    fs.writeFileSync(path.join(staging, MARKER), JSON.stringify(engine, null, 2));
    swapInEngine(staging, opts.binDir);
    return engine;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

export function describeEngine(engine: InstalledEngine | null, where: string): string {
  if (!engine) return "";
  return `llama.cpp ${engine.tag}, ${backendLabel(engine.backend)}${where ? ` on ${where}` : ""}`;
}
