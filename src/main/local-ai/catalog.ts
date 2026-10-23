import { LOCAL_AI_MINIMUM_GB } from "../../shared/ai-setup";
import type { HardwareInfo, LocalAiTier } from "../../shared/types";

// The curated local AI catalog: one story model in a quant ladder, and
// gpt-oss-20b for the 16 GB minimum below it. Deliberately tiny; the point is
// a working table, not a model browser.
//
// The story model is Qwen3.6-35B-A3B, the same model the ODM server's
// defaults were tuned against. A3B means ~3B active parameters per token
// (mixture of experts), which is what makes big-model quality viable on
// modest hardware: experts that do not fit in VRAM can sit in system RAM
// (cpu-moe) at a tolerable speed cost. All files come from ungated repos
// (Unsloth's Dynamic quants, ggml-org's gpt-oss), so downloads need no
// Hugging Face account.

const QWEN_BASE = "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main";
const GEMMA_BASE = "https://huggingface.co/unsloth/gemma-4-12b-it-qat-GGUF/resolve/main";
const GPT_OSS_BASE = "https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/resolve/main";

// Pinned llama.cpp build. Vulkan on Linux/Windows covers AMD, NVIDIA and
// Intel with one binary; macOS arm64 uses Metal. Pinned rather than latest
// because the generated server preset depends on this build's flags.
export const LLAMA_TAG = "b10621";
const LLAMA_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}`;

// The SHA-256 GitHub lists for each pinned archive. Raising LLAMA_TAG means
// updating these from the new release's assets.
const LLAMA_SHA256: Record<string, string> = {
  [`llama-${LLAMA_TAG}-bin-ubuntu-vulkan-x64.tar.gz`]: "3db8e4411033ef4531072be43377e859bcdbf9640c7bb36f9656e538eabd0978",
  [`llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`]: "2672d85bf87c8280d94dee01eb6a86280046878f70a07d786a93637fa9081163",
  [`llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz`]: "429c8270608600188035e5e92f7d78dffb7900904fe7dd7e6a84f48068cd13cf",
};

export function llamaArchiveSha256(url: string): string | null {
  return LLAMA_SHA256[url.slice(url.lastIndexOf("/") + 1)] ?? null;
}

export function llamaArchiveUrl(platform: string, arch: string): string | null {
  if (platform === "linux" && arch === "x64") {
    return `${LLAMA_BASE}/llama-${LLAMA_TAG}-bin-ubuntu-vulkan-x64.tar.gz`;
  }
  if (platform === "win32" && arch === "x64") {
    return `${LLAMA_BASE}/llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`;
  }
  if (platform === "darwin" && arch === "arm64") {
    return `${LLAMA_BASE}/llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz`;
  }
  return null;
}

export interface CatalogEntry {
  id: string;
  label: string;
  detail: string;
  // The model alias the OpenAI-compatible API serves; becomes the preset
  // section name and the ODM server's configured model.
  alias: string;
  url: string;
  file: string;
  sizeGb: number;
  // File size plus KV cache and runtime overhead at the shipped context.
  needsGb: number;
  moe: boolean;
  // Whose samplers and reasoning settings the preset carries.
  family: "qwen" | "gpt-oss" | "gemma";
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "qwen-q8",
    label: "Story model, full quality",
    detail: "Qwen3.6-35B-A3B at Q8: what the AI DM was tuned on, effectively lossless.",
    alias: "qwen3.6-35b",
    url: `${QWEN_BASE}/Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf`,
    file: "Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf",
    sizeGb: 38.5,
    needsGb: 45,
    moe: true,
    family: "qwen",
  },
  {
    id: "qwen-q6",
    label: "Story model, high quality",
    detail: "Qwen3.6-35B-A3B at Q6: indistinguishable from full quality at most tables.",
    alias: "qwen3.6-35b",
    url: `${QWEN_BASE}/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf`,
    file: "Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf",
    sizeGb: 31.9,
    needsGb: 38,
    moe: true,
    family: "qwen",
  },
  {
    id: "qwen-q4",
    label: "Story model, standard",
    detail: "Qwen3.6-35B-A3B at Q4: the sweet spot of quality per gigabyte.",
    alias: "qwen3.6-35b",
    url: `${QWEN_BASE}/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`,
    file: "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
    sizeGb: 22.2,
    needsGb: 28,
    moe: true,
    family: "qwen",
  },
  {
    id: "gpt-oss-20b",
    label: "Story model for 16 GB",
    detail: "gpt-oss-20b: OpenAI's open model, the smallest that plays the full rules.",
    alias: "gpt-oss-20b",
    url: `${GPT_OSS_BASE}/gpt-oss-20b-MXFP4.gguf`,
    file: "gpt-oss-20b-MXFP4.gguf",
    sizeGb: 12.1,
    needsGb: 16,
    moe: true,
    family: "gpt-oss",
  },
];

// Tiers offered before the 16 GB minimum. An install of one still starts and
// shows as installed; none is offered again. Where they fit, gpt-oss-20b
// plays the full rules as well as the 35B at Q2 and Q3 did, faster and in
// less memory (the server's docs/text-backends.md has the runs), and Gemma
// 4 12B plays only on the short rules.
export const RETIRED: CatalogEntry[] = [
  {
    id: "qwen-q3",
    label: "Story model, compact",
    detail: "Qwen3.6-35B-A3B at Q3: noticeably compressed, still the real model.",
    alias: "qwen3.6-35b",
    url: `${QWEN_BASE}/Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf`,
    file: "Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf",
    sizeGb: 16.9,
    needsGb: 22,
    moe: true,
    family: "qwen",
  },
  {
    id: "qwen-q2",
    label: "Story model, minimum",
    detail: "Qwen3.6-35B-A3B at Q2: rough edges, but big-model reasoning survives.",
    alias: "qwen3.6-35b",
    url: `${QWEN_BASE}/Qwen3.6-35B-A3B-UD-Q2_K_XL.gguf`,
    file: "Qwen3.6-35B-A3B-UD-Q2_K_XL.gguf",
    sizeGb: 12.3,
    needsGb: 17,
    moe: true,
    family: "qwen",
  },
  {
    id: "gemma-12b",
    label: "Small machine fallback",
    detail: "Gemma 4 12B (quantization-aware): a capable narrator when the story model cannot fit.",
    alias: "gemma-4-12b-qat",
    url: `${GEMMA_BASE}/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf`,
    file: "gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
    sizeGb: 6.8,
    needsGb: 10,
    moe: false,
    family: "gemma",
  },
];

// The utility model: a small second model the ODM server uses for summaries
// and other short helper calls, so the story model's KV cache stays on the
// story. The Qwen3.6 generation ships no 4B model, so this is Qwen3.5-4B,
// the newest 4B-class instruct GGUF in the same ungated Unsloth family
// (unsloth/Qwen3.5-4B-GGUF, UD-Q4_K_XL, 2.9 GB). Installed alongside the
// story model only when the memory budget covers both.
export const UTILITY_ENTRY: CatalogEntry = {
  id: "qwen-utility",
  label: "Utility model",
  detail: "Qwen3.5-4B: a small helper for summaries beside the story model.",
  alias: "qwen3.5-4b",
  url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-UD-Q4_K_XL.gguf",
  file: "Qwen3.5-4B-UD-Q4_K_XL.gguf",
  sizeGb: 2.9,
  needsGb: 5,
  moe: false,
  family: "qwen",
};

// The memory the model can sit in on the GPU: the card, or the share of a
// unified pool the system leaves it.
export function graphicsMemoryGb(hardware: HardwareInfo): number {
  return hardware.unifiedMemory ? hardware.ramGb * 0.8 : hardware.vramGb;
}

export function meetsMinimum(hardware: HardwareInfo): boolean {
  return graphicsMemoryGb(hardware) >= LOCAL_AI_MINIMUM_GB;
}

// Whether the machine can hold the utility model next to a story tier.
export function utilityFits(entry: CatalogEntry, hardware: HardwareInfo): boolean {
  return entry.needsGb + UTILITY_ENTRY.needsGb <= memoryBudgetGb(hardware);
}

// How much model this machine can carry. MoE with cpu-moe means system RAM
// genuinely counts: attention lives on the GPU and the expert weights
// stream from RAM at ~3B active parameters per token.
export function memoryBudgetGb(hardware: HardwareInfo): number {
  if (hardware.unifiedMemory) {
    return hardware.ramGb * 0.8;
  }
  if (hardware.vramGb >= 4) {
    return hardware.vramGb + hardware.ramGb * 0.5;
  }
  // CPU-only: the OS, the ODM server and a browser share the same RAM. No
  // story tier is offered here (meetsMinimum); the budget still sizes the
  // utility model beside an install made before the minimum.
  return hardware.ramGb * 0.65;
}

export function sizeTiers(
  hardware: HardwareInfo,
  installedTierId: string,
): LocalAiTier[] {
  const budget = memoryBudgetGb(hardware);
  const enough = meetsMinimum(hardware);
  const kept = RETIRED.filter((entry) => entry.id === installedTierId);
  const tiers = [...CATALOG, ...kept].map((entry) => ({
    id: entry.id,
    label: entry.label,
    detail: entry.detail,
    sizeGb: entry.sizeGb,
    needsGb: entry.needsGb,
    fits: enough && entry.needsGb <= budget,
    recommended: false,
    installed: entry.id === installedTierId,
  }));
  const best = tiers.find((tier) => tier.fits && CATALOG.some((entry) => entry.id === tier.id));
  if (best) {
    best.recommended = true;
  }
  return tiers;
}

export function catalogEntry(tierId: string): CatalogEntry | null {
  return [...CATALOG, ...RETIRED].find((entry) => entry.id === tierId) ?? null;
}

// The llama-server models preset for an installed tier. The Qwen section is
// a transcript of a long-lived production tuning for exactly this model and
// use (ODM narration): non-thinking sampling with presence penalty 1.5,
// KV at q8_0, thinking allowed per-request but hard-budgeted so a runaway
// deliberation cannot stall a turn for minutes. The presence penalty is the
// tuning's, not what ODM runs with: the server sends presence_penalty 0 on
// every request to a local endpoint (its model-client.ts and
// sampling-logic.ts, deliberately, since a positive penalty over the long DM
// prompt suppresses tool calls), and a per-request value overrides the
// preset, so the 1.5 below never reaches ODM's own calls. Repetition is
// stopped on the server, by its stream guard, not here.
export function presetFor(
  entry: CatalogEntry,
  modelPath: string,
  hardware: HardwareInfo,
): string {
  // Experts to RAM when the file cannot live in VRAM. Never on unified
  // memory, where the distinction does not exist.
  const offload =
    entry.moe && !hardware.unifiedMemory && entry.sizeGb > Math.max(hardware.vramGb - 2, 0);
  const lines = [
    "version = 1",
    "",
    `; Generated by the Open Dungeon Master app for ${entry.file}.`,
    "; Regenerated on every launch; edits belong in the app, not here.",
    `[${entry.alias}]`,
    `model = ${modelPath}`,
    "ngl = 99",
    "fa = on",
    "jinja = true",
    "load-on-startup = true",
  ];
  if (offload) {
    lines.push("cpu-moe = true");
  }
  if (entry.family === "qwen") {
    lines.push(
      "c = 65536",
      "ctk = q8_0",
      "ctv = q8_0",
      "temp = 0.7",
      "top-p = 0.95",
      "top-k = 20",
      "min-p = 0.0",
      "presence-penalty = 1.5",
      "reasoning = off",
      "reasoning-budget = 2048",
      "reasoning-budget-message = Enough deliberation. Decide now: emit the exact tool calls the rules require, or answer directly.",
    );
  } else if (entry.family === "gpt-oss") {
    // As gpt-oss-20b was measured for the 16 GB minimum: the chat template's
    // own reasoning, capped, and llama.cpp's default samplers.
    lines.push("c = 65536", "ctk = q8_0", "ctv = q8_0", "reasoning-budget = 1024");
  } else {
    lines.push(
      "c = 32768",
      "ctk = q8_0",
      "ctv = q8_0",
      "temp = 1.0",
      "top-p = 0.95",
      "top-k = 64",
      "min-p = 0.0",
    );
  }
  return `${lines.join("\n")}\n`;
}

// Appended to the story preset when the utility model is installed. Loaded
// on demand rather than at startup: summaries are occasional, and boot
// should spend its memory bandwidth on the story model. Sampling follows
// Qwen's published instruct defaults for the 4B line.
export function utilityPresetSection(modelPath: string): string {
  const lines = [
    "",
    `[${UTILITY_ENTRY.alias}]`,
    `model = ${modelPath}`,
    "ngl = 99",
    "fa = on",
    "jinja = true",
    "load-on-startup = false",
    "c = 16384",
    "ctk = q8_0",
    "ctv = q8_0",
    "temp = 0.7",
    "top-p = 0.8",
    "top-k = 20",
    "min-p = 0.0",
  ];
  return `${lines.join("\n")}\n`;
}
