import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GpuInfo, HardwareInfo } from "../../shared/types";

const run = promisify(execFile);

// A best-effort hardware scan in the llmfit spirit: every graphics adapter
// with enough signal to pick a model tier and the right llama.cpp build,
// honest zeros where a platform hides the numbers. The local AI then runs
// on one of them: the player's pick, or the best card found.
//
// It used to fold every adapter into one figure, which went wrong on
// machines with an integrated GPU beside a real card: on Linux an AMD
// iGPU's shared pool made a laptop with an NVIDIA card read as one big
// unified-memory machine, and nothing said which adapter the numbers
// belonged to, so llama.cpp was never told which device to use.

const round1 = (gb: number): number => Math.round(gb * 10) / 10;

// ---------- NVIDIA ----------

// nvidia-smi's own header names the newest CUDA the driver runs; where it
// cannot be read, the driver branch says the same. Kept as the text
// nvidia-smi prints ("12.8", "13.10"): as a decimal, 13.10 would read 13.1.
export function cudaFromDriver(driver: string): string {
  const major = Number(String(driver).split(".")[0]);
  if (!Number.isFinite(major)) return "";
  const table: Array<[number, string]> = [
    [580, "13.0"], [575, "12.9"], [570, "12.8"], [560, "12.6"], [555, "12.5"], [550, "12.4"],
    [545, "12.3"], [535, "12.2"], [530, "12.1"], [525, "12.0"], [450, "11.0"],
  ];
  return table.find(([min]) => major >= min)?.[1] ?? "";
}

// One CSV row per card from
// --query-gpu=index,uuid,name,memory.total,compute_cap,driver_version.
export function parseNvidiaSmi(csv: string, cudaVersion: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const cells = line.split(",").map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const [index, uuid] = cells;
    const [memory, compute, driver] = cells.slice(-3);
    // A name may itself hold commas; it is everything between uuid and memory.
    const name = cells.slice(2, -3).join(", ");
    const mib = Number(memory);
    const cc = Number(compute);
    gpus.push({
      id: uuid || `nvidia:${index}`,
      name: name || "NVIDIA graphics card",
      vendor: "nvidia",
      vramGb: Number.isFinite(mib) ? round1(mib / 1024) : 0,
      integrated: false,
      ...(Number.isFinite(cc) && cc > 0 ? { computeCap: cc } : {}),
      ...(driver ? { driverVersion: driver } : {}),
      cudaVersion: cudaVersion || cudaFromDriver(driver ?? ""),
      index: Number(index) || 0,
    });
  }
  return gpus;
}

async function nvidiaGpus(): Promise<GpuInfo[]> {
  let csv = "";
  try {
    ({ stdout: csv } = await run("nvidia-smi", [
      "--query-gpu=index,uuid,name,memory.total,compute_cap,driver_version",
      "--format=csv,noheader,nounits",
    ], { timeout: 15_000, windowsHide: true }));
  } catch {
    // A driver from before compute_cap: ask without it.
    try {
      const { stdout } = await run("nvidia-smi", [
        "--query-gpu=index,uuid,name,memory.total,driver_version",
        "--format=csv,noheader,nounits",
      ], { timeout: 15_000, windowsHide: true });
      csv = stdout
        .split(/\r?\n/)
        .map((line) => {
          const cells = line.split(",");
          if (cells.length < 5) return "";
          const driver = cells.pop();
          return [...cells, "", driver].join(",");
        })
        .join("\n");
    } catch {
      return [];
    }
  }
  let cuda = "";
  try {
    const { stdout } = await run("nvidia-smi", [], { timeout: 15_000, windowsHide: true });
    cuda = /CUDA Version:\s*(\d+\.\d+)/.exec(stdout)?.[1] ?? "";
  } catch {
    // The driver branch stands in.
  }
  return parseNvidiaSmi(csv, cuda);
}

// ---------- Linux ----------

const PCI_VENDORS: Record<string, GpuInfo["vendor"]> = { "0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel" };

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

// amdgpu's compute view of each GPU: an APU has no local memory of its own
// (local_mem_size 0), which is how ROCm itself tells the two apart. Keyed by
// PCI domain and location (bus << 8 | device << 3 | function).
function kfdLocalMemory(): Map<string, number> {
  const out = new Map<string, number>();
  const root = "/sys/class/kfd/kfd/topology/nodes";
  let nodes: string[] = [];
  try {
    nodes = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const node of nodes) {
    const props = readText(path.join(root, node, "properties"));
    const value = (key: string) => Number(new RegExp(`^${key}\\s+(\\d+)$`, "m").exec(props)?.[1] ?? NaN);
    if (!(value("simd_count") > 0)) continue;
    out.set(`${value("domain")}:${value("location_id")}`, value("local_mem_size"));
  }
  return out;
}

function pciLocation(slot: string): string {
  // "0000:c3:00.0" -> domain 0, location 0xc300.
  const match = /^([0-9a-f]+):([0-9a-f]+):([0-9a-f]+)\.([0-7])$/i.exec(slot);
  if (!match) return "";
  const [domain, bus, device, fn] = match.slice(1).map((part) => parseInt(part ?? "0", 16)) as [number, number, number, number];
  return `${domain}:${(bus << 8) | (device << 3) | fn}`;
}

// A readable name from lspci where it is installed ("Navi 31 [Radeon RX
// 7900 XT/7900 XTX]"), else "" and the vendor stands in.
async function lspciName(slot: string): Promise<string> {
  try {
    const { stdout } = await run("lspci", ["-mm", "-s", slot], { timeout: 5_000 });
    const fields = [...stdout.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
    // Unquoted slot, then "class" "vendor" "device" ...
    return fields[2] ?? "";
  } catch {
    return "";
  }
}

// Shared GPU memory per adapter id, for the unified-memory check.
type Shared = Map<string, number>;

async function linuxGpus(shared: Shared): Promise<GpuInfo[]> {
  const gpus = await nvidiaGpus();
  const kfd = kfdLocalMemory();
  let cards: string[] = [];
  try {
    cards = fs.readdirSync("/sys/class/drm").filter((card) => /^card\d+$/.test(card));
  } catch {
    // No DRM at all (headless VM).
  }
  const seen = new Set<string>();
  for (const card of cards) {
    const device = path.join("/sys/class/drm", card, "device");
    const vendor = PCI_VENDORS[readText(path.join(device, "vendor"))];
    if (!vendor) continue;
    let slot = "";
    try {
      slot = path.basename(fs.realpathSync(device));
    } catch {
      continue;
    }
    if (seen.has(slot)) continue;
    seen.add(slot);
    // nvidia-smi already described every card its driver drives.
    if (vendor === "nvidia" && gpus.length) continue;
    const vram = Number(readText(path.join(device, "mem_info_vram_total"))) / 1024 ** 3 || 0;
    const gtt = Number(readText(path.join(device, "mem_info_gtt_total"))) / 1024 ** 3 || 0;
    let integrated: boolean;
    if (vendor === "amd") {
      const local = kfd.get(pciLocation(slot));
      integrated =
        local !== undefined && Number.isFinite(local)
          ? local === 0
          : fs.existsSync(path.join(device, "uma")) || (vram < 2 && gtt > vram * 4);
    } else {
      // i915 and xe expose no memory figures; only Arc cards are discrete.
      integrated = vendor === "intel";
    }
    const name = await lspciName(slot);
    if (vendor === "intel" && /\bArc\b|DG2|Battlemage/i.test(name)) integrated = false;
    const fallbackName = vendor === "amd" ? "AMD Radeon graphics" : vendor === "intel" ? "Intel graphics" : "NVIDIA graphics card";
    const id = `pci:${slot}`;
    if (gtt > 0) shared.set(id, gtt);
    gpus.push({
      id,
      name: name ? `${vendor === "amd" ? "AMD " : vendor === "intel" ? "Intel " : ""}${name}` : fallbackName,
      vendor,
      vramGb: round1(vram),
      integrated,
    });
  }
  return gpus;
}

// ---------- Windows ----------

// What Windows knows about its display adapters, read in one PowerShell
// call: the CIM rows (a name for every adapter) and the driver's own
// registry rows, which carry the memory as a 64-bit figure.
export type WindowsAdapters = {
  cim: Array<{ Name?: unknown; AdapterRAM?: unknown }>;
  reg: Array<{ Name?: unknown; Bytes?: unknown }>;
};

const WINDOWS_ADAPTERS_SCRIPT = [
  "$cim = @(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM)",
  "$reg = @(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Name = $_.DriverDesc; Bytes = $_.'HardwareInformation.qwMemorySize' } })",
  "@{ cim = $cim; reg = $reg } | ConvertTo-Json -Depth 4 -Compress",
].join("; ");

export async function readWindowsAdapters(): Promise<WindowsAdapters | null> {
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ADAPTERS_SCRIPT], {
      timeout: 30_000,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout) as Partial<WindowsAdapters>;
    return { cim: Array.isArray(parsed.cim) ? parsed.cim : [], reg: Array.isArray(parsed.reg) ? parsed.reg : [] };
  } catch {
    return null;
  }
}

// A registry memory figure: a number where the driver wrote a QWORD, eight
// little-endian bytes where it wrote binary.
function registryBytes(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (Array.isArray(value) && value.length && value.length <= 8 && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return value.reduceRight((sum: number, byte: number) => sum * 256 + byte, 0);
  }
  return 0;
}

const VIRTUAL_ADAPTER = /microsoft basic|remote display|virtual display|indirect display|parsec|hyper-v|vmware|virtualbox|citrix|spacedesk|displaylink|meta virtual|oray|sunlogin|idd/i;

export function vendorOf(name: string): GpuInfo["vendor"] {
  if (/nvidia|geforce|quadro|tesla|\brtx\b|\bgtx\b/i.test(name)) return "nvidia";
  if (/\bamd\b|radeon|\bati\b/i.test(name)) return "amd";
  if (/intel/i.test(name)) return "intel";
  return "";
}

// Integrated by name where Windows gives nothing better: Intel's own
// graphics except Arc cards (A380, A770, B580; "Arc Graphics" is the
// Meteor Lake iGPU), and AMD's APU graphics ("Radeon(TM) Graphics",
// "Radeon 780M", "Radeon 8060S", Vega iGPUs).
export function looksIntegrated(name: string, vendor: GpuInfo["vendor"], bytes: number): boolean {
  if (vendor === "nvidia") return false;
  if (vendor === "intel") return !/\bArc\b.*\b[AB]\d{3}/i.test(name);
  if (vendor === "amd") {
    return /Radeon(\(TM\))?\s+Graphics|Radeon(\(TM\))?\s+\d{3,4}[MS]\b|Vega\s+\d+\s+Graphics|Radeon(\(TM\))?\s+Vega/i.test(name) || (bytes > 0 && bytes < 1024 ** 3);
  }
  return bytes > 0 && bytes < 1024 ** 3;
}

// Every adapter, by name. Win32_VideoController's AdapterRAM is a 32-bit
// field: every card over 4 GB reads as 4 GB there (a 20 GB Radeon RX 7900
// XT was scanned as 4 GB, which put the whole model ladder two tiers too
// low). The driver's registry row holds the real 64-bit figure, so that
// wins wherever it is present; AdapterRAM stands in where it is not.
export function windowsGpus(adapters: WindowsAdapters | null): GpuInfo[] {
  const byName = new Map<string, number>();
  const note = (name: unknown, bytes: number) => {
    if (typeof name !== "string" || !name.trim() || VIRTUAL_ADAPTER.test(name)) return;
    byName.set(name.trim(), Math.max(byName.get(name.trim()) ?? 0, bytes));
  };
  for (const row of adapters?.cim ?? []) {
    note(row?.Name, typeof row?.AdapterRAM === "number" && Number.isFinite(row.AdapterRAM) ? Math.max(0, row.AdapterRAM) : 0);
  }
  for (const row of adapters?.reg ?? []) {
    note(row?.Name, registryBytes(row?.Bytes));
  }
  return [...byName].map(([name, bytes]) => {
    const vendor = vendorOf(name);
    return { id: `win:${name}`, name, vendor, vramGb: round1(bytes / 1024 ** 3), integrated: looksIntegrated(name, vendor, bytes) };
  });
}

// The adapter the scan would run on, in the shape the single-GPU scan had.
export function pickWindowsGpu(adapters: WindowsAdapters | null): { vramGb: number; gpuName: string; vendor: HardwareInfo["gpuVendor"] } {
  const gpu = chooseGpu(windowsGpus(adapters), "", 0);
  return { vramGb: gpu?.vramGb ?? 0, gpuName: gpu?.name ?? "", vendor: !gpu || gpu.vendor === "intel" ? "" : gpu.vendor };
}

// The Windows rows with nvidia-smi's richer rows in place of the NVIDIA
// cards they describe (same name, taken in order), plus any it saw that
// Windows did not list.
export function mergeNvidia(windows: GpuInfo[], nvidia: GpuInfo[]): GpuInfo[] {
  if (!nvidia.length) return windows;
  const left = [...nvidia];
  const out: GpuInfo[] = [];
  for (const gpu of windows) {
    if (gpu.vendor !== "nvidia") {
      out.push(gpu);
      continue;
    }
    const at = left.findIndex((smi) => smi.name.toLowerCase() === gpu.name.toLowerCase());
    if (at >= 0) out.push(...left.splice(at, 1));
    // A Windows NVIDIA row nvidia-smi does not know is a card without a
    // working driver; dropping it is better than offering it.
  }
  return [...out, ...left];
}

// ---------- choosing ----------

// Whether an adapter's model would live in system RAM: Apple Silicon, a big
// carve-out that IS most of RAM, or an AMD APU whose GTT pool
// (GPU-addressable system RAM) dwarfs its carve-out.
export function isUnified(gpu: GpuInfo, ramGb: number, sharedGb: number): boolean {
  if (gpu.vendor === "apple") return true;
  // Only for integrated GPUs: a 24 GB card in a 32 GB machine is still a
  // card, with its own memory and the RAM beside it.
  if (gpu.integrated && gpu.vramGb > 0 && gpu.vramGb >= ramGb * 0.6 && gpu.vramGb <= ramGb * 1.05) return true;
  return gpu.integrated && gpu.vendor === "amd" && sharedGb >= ramGb * 0.4 && gpu.vramGb < ramGb * 0.3;
}

// The memory the model could sit in on this adapter, for ranking.
function usableGb(gpu: GpuInfo, ramGb: number, unified: boolean): number {
  return unified ? ramGb * 0.8 : gpu.vramGb;
}

// The adapter the local AI runs on: the player's pick when it is still
// there, else the discrete card with the most memory (a card of 4 GB or
// more always beats an integrated GPU, whatever RAM the iGPU can borrow),
// else the integrated GPU that can hold the most.
export function chooseGpu(gpus: GpuInfo[], preferredId: string, ramGb: number, shared: Shared = new Map()): GpuInfo | null {
  const preferred = gpus.find((gpu) => gpu.id === preferredId);
  if (preferred) return preferred;
  const ranked = [...gpus].sort((a, b) => {
    const realA = !a.integrated && a.vramGb >= 4 ? 1 : 0;
    const realB = !b.integrated && b.vramGb >= 4 ? 1 : 0;
    if (realA !== realB) return realB - realA;
    const memA = usableGb(a, ramGb, isUnified(a, ramGb, shared.get(a.id) ?? 0));
    const memB = usableGb(b, ramGb, isUnified(b, ramGb, shared.get(b.id) ?? 0));
    if (memA !== memB) return memB - memA;
    return (b.vendor === "nvidia" ? 1 : 0) - (a.vendor === "nvidia" ? 1 : 0);
  });
  return ranked[0] ?? null;
}

export function hardwareFor(
  base: Pick<HardwareInfo, "platform" | "arch" | "ramGb">,
  gpus: GpuInfo[],
  preferredId: string,
  shared: Shared = new Map(),
): HardwareInfo {
  const gpu = chooseGpu(gpus, preferredId, base.ramGb, shared);
  const unified = gpu ? isUnified(gpu, base.ramGb, shared.get(gpu.id) ?? 0) : false;
  const vendor: HardwareInfo["gpuVendor"] = gpu?.vendor === "intel" ? "" : (gpu?.vendor ?? "");
  return {
    ...base,
    vramGb: gpu ? Math.round(unified ? base.ramGb : gpu.vramGb) : 0,
    gpuName: gpu?.name ?? "",
    gpuVendor: vendor,
    ...(gpu?.computeCap ? { gpuCompute: gpu.computeCap } : {}),
    unifiedMemory: unified,
    gpus,
    gpuId: gpu?.id ?? "",
  };
}

export async function scanHardware(preferredId = ""): Promise<HardwareInfo> {
  const ramGb = os.totalmem() / 1024 ** 3;
  const base = { platform: process.platform, arch: process.arch, ramGb: Math.round(ramGb) };
  if (process.platform === "darwin" && process.arch === "arm64") {
    const apple: GpuInfo = { id: "apple", name: "Apple Silicon", vendor: "apple", vramGb: Math.round(ramGb), integrated: true };
    return hardwareFor(base, [apple], "");
  }
  const shared: Shared = new Map();
  let gpus: GpuInfo[] = [];
  if (process.platform === "linux") {
    gpus = await linuxGpus(shared);
  } else if (process.platform === "win32") {
    const [adapters, nvidia] = await Promise.all([readWindowsAdapters(), nvidiaGpus()]);
    gpus = mergeNvidia(windowsGpus(adapters), nvidia);
  }
  return hardwareFor(base, gpus, preferredId, shared);
}
