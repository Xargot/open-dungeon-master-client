import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { HardwareInfo } from "../../shared/types";

const run = promisify(execFile);

// A best-effort hardware scan in the llmfit spirit: enough signal to pick a
// model tier, honest zeros where a platform hides the numbers. Getting VRAM
// slightly wrong is survivable because the MoE catalog can spill experts to
// RAM; the tier picker leans on the combined budget, not VRAM alone.

type GpuVendor = HardwareInfo["gpuVendor"];

async function linuxVramGb(): Promise<{
  vramGb: number;
  gttGb: number;
  gpuName: string;
  vendor: GpuVendor;
}> {
  // amdgpu exposes both pools in sysfs. On APUs the VRAM number is only the
  // BIOS carve-out (often 512MB-4GB) while the GTT pool is the real capacity:
  // system RAM the GPU addresses directly, which is what llama.cpp actually
  // fills with ngl 99 on these machines.
  let best = 0;
  let gtt = 0;
  let vendor: GpuVendor = "";
  try {
    for (const card of fs.readdirSync("/sys/class/drm")) {
      if (!/^card\d+$/.test(card)) continue;
      const device = path.join("/sys/class/drm", card, "device");
      try {
        const bytes = Number(fs.readFileSync(path.join(device, "mem_info_vram_total"), "utf8"));
        // mem_info_vram_total is an amdgpu-only sysfs node, so its very
        // presence identifies the vendor.
        if (Number.isFinite(bytes)) {
          best = Math.max(best, bytes / 1024 ** 3);
          vendor = "amd";
        }
      } catch {
        // This card does not expose it; keep looking.
      }
      try {
        const bytes = Number(fs.readFileSync(path.join(device, "mem_info_gtt_total"), "utf8"));
        if (Number.isFinite(bytes)) gtt = Math.max(gtt, bytes / 1024 ** 3);
      } catch {
        // Not amdgpu.
      }
    }
  } catch {
    // No DRM at all (headless VM); fall through to nvidia-smi.
  }
  let gpuName = "";
  try {
    const { stdout } = await run("nvidia-smi", [
      "--query-gpu=memory.total,name",
      "--format=csv,noheader,nounits",
    ]);
    const [mem, ...name] = (stdout.split("\n")[0] ?? "").split(",");
    const gb = Number(mem) / 1024;
    if (Number.isFinite(gb)) best = Math.max(best, gb);
    gpuName = name.join(",").trim();
    // A responding nvidia-smi means a working NVIDIA driver; as the compute
    // install target that beats an AMD iGPU sitting next to it.
    vendor = "nvidia";
  } catch {
    // No NVIDIA tooling; the sysfs number stands.
  }
  return { vramGb: best, gttGb: gtt, gpuName, vendor };
}

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
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ADAPTERS_SCRIPT]);
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

// The adapter with the most memory, and how much. Win32_VideoController's
// AdapterRAM is a 32-bit field: every card over 4 GB reads as 4 GB there (a
// 20 GB Radeon RX 7900 XT was scanned as 4 GB, which put the whole model
// ladder two tiers too low and spilled a model that fits the card into
// system RAM). The driver's registry row holds the real 64-bit figure, so
// that wins wherever it is present; AdapterRAM stands in where it is not.
// Picking by memory rather than taking the first row also keeps an
// integrated adapter listed ahead of the real card from being the answer.
export function pickWindowsGpu(adapters: WindowsAdapters | null): { vramGb: number; gpuName: string; vendor: GpuVendor } {
  const byName = new Map<string, number>();
  const note = (name: unknown, bytes: number) => {
    if (typeof name !== "string" || !name.trim()) return;
    byName.set(name.trim(), Math.max(byName.get(name.trim()) ?? 0, bytes));
  };
  for (const row of adapters?.cim ?? []) {
    note(row?.Name, typeof row?.AdapterRAM === "number" && Number.isFinite(row.AdapterRAM) ? Math.max(0, row.AdapterRAM) : 0);
  }
  for (const row of adapters?.reg ?? []) {
    note(row?.Name, registryBytes(row?.Bytes));
  }
  let gpuName = "";
  let bytes = 0;
  for (const [name, memory] of byName) {
    if (!gpuName || memory > bytes) {
      gpuName = name;
      bytes = memory;
    }
  }
  const vendor: GpuVendor = /nvidia|geforce|rtx|gtx|quadro/i.test(gpuName) ? "nvidia" : /amd|radeon/i.test(gpuName) ? "amd" : "";
  return { vramGb: bytes / 1024 ** 3, gpuName, vendor };
}

async function windowsVramGb(): Promise<{
  vramGb: number;
  gttGb: number;
  gpuName: string;
  vendor: GpuVendor;
}> {
  // No signal at all leaves the zeros, and the budget falls back to RAM.
  const picked = pickWindowsGpu(await readWindowsAdapters());
  let { vramGb, vendor } = picked;
  try {
    const { stdout } = await run("nvidia-smi", [
      "--query-gpu=memory.total",
      "--format=csv,noheader,nounits",
    ]);
    const gb = Number(stdout.split("\n")[0]) / 1024;
    if (Number.isFinite(gb)) vramGb = Math.max(vramGb, gb);
    vendor = "nvidia";
  } catch {
    // Not an NVIDIA machine.
  }
  return { vramGb, gttGb: 0, gpuName: picked.gpuName, vendor };
}

// The highest compute capability nvidia-smi reports, 0 when it gives none.
// Asked on its own so a driver that predates the field still reports the
// memory and name above.
async function nvidiaComputeCap(): Promise<number> {
  try {
    const { stdout } = await run("nvidia-smi", ["--query-gpu=compute_cap", "--format=csv,noheader"]);
    return Math.max(0, ...stdout.split("\n").map(Number).filter(Number.isFinite));
  } catch {
    return 0;
  }
}

export async function scanHardware(): Promise<HardwareInfo> {
  const ramGb = os.totalmem() / 1024 ** 3;
  const base: HardwareInfo = {
    platform: process.platform,
    arch: process.arch,
    ramGb: Math.round(ramGb),
    vramGb: 0,
    gpuName: "",
    gpuVendor: "",
    unifiedMemory: false,
  };
  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      ...base,
      vramGb: Math.round(ramGb),
      gpuName: "Apple Silicon",
      gpuVendor: "apple",
      unifiedMemory: true,
    };
  }
  const probe =
    process.platform === "linux"
      ? await linuxVramGb()
      : process.platform === "win32"
        ? await windowsVramGb()
        : { vramGb: 0, gttGb: 0, gpuName: "", vendor: "" as GpuVendor };
  // Unified memory two ways: a big carve-out that IS most of RAM, or an AMD
  // APU whose GTT pool (GPU-addressable system RAM) dwarfs its carve-out.
  const unified =
    (probe.vramGb > 0 && probe.vramGb >= ramGb * 0.6) ||
    (probe.gttGb >= ramGb * 0.4 && probe.vramGb < ramGb * 0.3);
  const compute = probe.vendor === "nvidia" ? await nvidiaComputeCap() : 0;
  return {
    ...base,
    vramGb: Math.round(unified ? ramGb : probe.vramGb),
    gpuName: probe.gpuName,
    gpuVendor: probe.vendor,
    ...(compute > 0 ? { gpuCompute: compute } : {}),
    unifiedMemory: unified,
  };
}
