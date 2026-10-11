import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { HardwareInfo, LocalAiStatus } from "../../shared/types";
import { downloadVerified, ensureDiskSpace } from "./download";
import { openLog } from "../log-files";

const runFile = promisify(execFile);

// Installs and runs a local ComfyUI for scene images, mirroring the llama
// manager: pinned code, a python venv, one curated checkpoint, one managed
// server process on ComfyUI's stock port. Kept apart from the text stack so
// either can be installed or removed alone.

const PORT = 8188;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Pinned ComfyUI release: the requirements set and the API surface are only
// tested against this tag. A tag can be moved, so the clone must also land
// on the commit the tag named when it was pinned.
export const COMFY_TAG = "v0.34.0";
export const COMFY_COMMIT = "12d5279438bfefc058a269eae805ceab6047777f";
const COMFY_REPO = "https://github.com/comfyanonymous/ComfyUI.git";

// The one curated checkpoint: SDXL base from Stability's ungated repo. Real
// scene art on an 8GB card, no license click-through, no account. The hash
// is pinned rather than fetched: that repo is frozen history.
export const CHECKPOINT = {
  url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors",
  file: "sd_xl_base_1.0.safetensors",
  sizeGb: 6.9,
  sha256: "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b",
};

// Torch wheels come from a hardware-specific index: CUDA for NVIDIA, ROCm
// for AMD on Linux only (no ROCm wheels exist for Windows), the CPU index
// when there is no usable GPU signal. macOS ships MPS in the default PyPI
// wheels, hence null (no extra index at all).
export function torchIndexUrl(hardware: HardwareInfo): string | null {
  if (hardware.platform === "darwin") return null;
  if (hardware.gpuVendor === "nvidia") return "https://download.pytorch.org/whl/cu124";
  if (hardware.gpuVendor === "amd" && hardware.platform === "linux") {
    return "https://download.pytorch.org/whl/rocm6.2";
  }
  return "https://download.pytorch.org/whl/cpu";
}

export interface Command {
  bin: string;
  args: string[];
}

export function venvPython(rootDir: string, platform: string): string {
  return platform === "win32"
    ? path.join(rootDir, "venv", "Scripts", "python.exe")
    : path.join(rootDir, "venv", "bin", "python");
}

// The install as data, so tests can check tag pinning and index selection
// without a multi-gigabyte run. Torch is installed before requirements.txt
// so pip resolves the hardware-matched build instead of the default one.
export function installCommands(
  rootDir: string,
  systemPython: string,
  hardware: HardwareInfo,
): [Command, Command, Command, Command] {
  const appDir = path.join(rootDir, "ComfyUI");
  const python = venvPython(rootDir, hardware.platform);
  const index = torchIndexUrl(hardware);
  const torch = ["-m", "pip", "install", "torch", "torchvision", "torchaudio"];
  if (index) torch.push("--index-url", index);
  return [
    { bin: "git", args: ["clone", "--depth", "1", "--branch", COMFY_TAG, COMFY_REPO, appDir] },
    { bin: systemPython, args: ["-m", "venv", path.join(rootDir, "venv")] },
    { bin: python, args: torch },
    { bin: python, args: ["-m", "pip", "install", "-r", path.join(appDir, "requirements.txt")] },
  ];
}

export class ComfyManager {
  private child: ChildProcess | null = null;
  private externalServer = false;
  private error = "";

  constructor(
    private readonly rootDir: string,
    private readonly onChange: () => void,
  ) {}

  private get appDir(): string {
    return path.join(this.rootDir, "ComfyUI");
  }
  private get checkpointPath(): string {
    return path.join(this.appDir, "models", "checkpoints", CHECKPOINT.file);
  }
  private get logFile(): string {
    return path.join(this.rootDir, "comfy.log");
  }

  origin(): string {
    return ORIGIN;
  }
  checkpointFile(): string {
    return CHECKPOINT.file;
  }

  private installed(): boolean {
    return (
      fs.existsSync(this.checkpointPath) && fs.existsSync(venvPython(this.rootDir, process.platform))
    );
  }

  status(): LocalAiStatus["comfy"] {
    const installed = this.installed();
    return {
      installed,
      running: this.externalServer || (this.child !== null && this.child.exitCode === null),
      checkpoint: installed ? CHECKPOINT.file : "",
      error: this.error,
    };
  }

  private async findPython(): Promise<string> {
    const names = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
    for (const name of names) {
      try {
        await runFile(name, ["--version"]);
        return name;
      } catch {
        // Keep looking.
      }
    }
    throw new Error(
      "Python 3 is required for local image generation. Install it (python.org or your package manager), then try again.",
    );
  }

  // pip's output can run to megabytes, so steps stream to comfy.log instead
  // of buffering; the label is the only progress a package install can give.
  private run(command: Command, label: string): Promise<void> {
    const log = openLog(this.logFile);
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command.bin, command.args, { stdio: ["ignore", log, log] });
      child.once("error", (err) => {
        fs.closeSync(log);
        reject(err);
      });
      child.once("exit", (code) => {
        fs.closeSync(log);
        if (code === 0) resolve();
        else reject(new Error(`${label} failed (exit ${code}); details in comfy.log.`));
      });
    });
  }

  async install(
    hardware: HardwareInfo,
    onProgress: (label: string, percent: number) => void,
  ): Promise<void> {
    // Torch wheels alone run to several GB; demand headroom beyond the
    // checkpoint before touching the network.
    await ensureDiskSpace(this.rootDir, this.installed() ? 1 : CHECKPOINT.sizeGb + 9);
    this.error = "";
    try {
      const python = await this.findPython();
      try {
        await runFile("git", ["--version"]);
      } catch {
        throw new Error("Git is required for local image generation. Install it, then try again.");
      }
      const [clone, venv, torch, reqs] = installCommands(this.rootDir, python, hardware);
      if (!fs.existsSync(path.join(this.appDir, "main.py"))) {
        // A half-finished clone cannot be resumed; start it clean.
        fs.rmSync(this.appDir, { recursive: true, force: true });
        onProgress("Downloading ComfyUI", 2);
        await this.run(clone, "Downloading ComfyUI");
        const { stdout } = await runFile("git", ["-C", this.appDir, "rev-parse", "HEAD"]);
        if (stdout.trim() !== COMFY_COMMIT) {
          fs.rmSync(this.appDir, { recursive: true, force: true });
          throw new Error(`ComfyUI ${COMFY_TAG} is not the release this app was tested with, so it was not installed.`);
        }
      }
      if (!fs.existsSync(venvPython(this.rootDir, process.platform))) {
        onProgress("Creating the Python environment", 8);
        await this.run(venv, "Creating the Python environment");
      }
      onProgress("Installing PyTorch (several GB; pip shows no progress here)", 12);
      await this.run(torch, "Installing PyTorch");
      onProgress("Installing ComfyUI's dependencies", 45);
      await this.run(reqs, "Installing ComfyUI's dependencies");
      if (!fs.existsSync(this.checkpointPath)) {
        const label = `Downloading the image model (${CHECKPOINT.sizeGb} GB)`;
        onProgress(label, 55);
        await downloadVerified(CHECKPOINT.url, this.checkpointPath, {
          kind: "safetensors",
          sha256: CHECKPOINT.sha256,
          onProgress: (percent) => onProgress(label, 55 + percent * 0.45),
        });
      }
      onProgress("Finishing up", 100);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private async portInUse(): Promise<boolean> {
    try {
      const response = await fetch(`${ORIGIN}/system_stats`, {
        signal: AbortSignal.timeout(1500),
      });
      return response.status > 0;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (!this.installed() || (this.child && this.child.exitCode === null)) return;
    if (await this.portInUse()) {
      // Someone already runs ComfyUI here (a hand-managed install). Theirs
      // wins; nothing to manage.
      this.externalServer = true;
      return;
    }
    const python = venvPython(this.rootDir, process.platform);
    const log = openLog(this.logFile);
    const child = spawn(
      python,
      [path.join(this.appDir, "main.py"), "--listen", "127.0.0.1", "--port", String(PORT)],
      { cwd: this.appDir, stdio: ["ignore", log, log] },
    );
    fs.closeSync(log);
    this.child = child;
    child.once("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.error = "The image server stopped (see comfy.log).";
        this.onChange();
      }
    });
    // Torch imports are slow on first boot; the health poll is patient. The
    // first image request simply waits if the player beats the server up.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && child.exitCode === null) {
      if (await this.portInUse()) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.externalServer = false;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const killer = setTimeout(() => child.kill("SIGKILL"), 8000);
        child.once("exit", () => {
          clearTimeout(killer);
          resolve();
        });
      });
    }
  }

  async uninstall(): Promise<void> {
    await this.stop();
    fs.rmSync(this.rootDir, { recursive: true, force: true });
    this.error = "";
  }
}
