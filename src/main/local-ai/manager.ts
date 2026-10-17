import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { HardwareInfo, LocalAiStatus, LocalAiTier } from "../../shared/types";
import {
  catalogEntry,
  llamaArchiveSha256,
  llamaArchiveUrl,
  presetFor,
  sizeTiers,
  utilityFits,
  utilityPresetSection,
  LLAMA_TAG,
  UTILITY_ENTRY,
  type CatalogEntry,
} from "./catalog";
import { ComfyManager } from "./comfy";
import { downloadVerified, ensureDiskSpace, fetchHfSha256 } from "./download";
import { scanHardware } from "./hardware";
import { openLog } from "../log-files";

const runFile = promisify(execFile);

// Installs and runs the local AI: a pinned llama.cpp build plus one curated
// model, laid out under userData/local-ai. The server preset is regenerated
// at every start so a hardware change (new GPU, more RAM) re-tunes the
// offload without a reinstall. Port 8001 is the ODM server's built-in
// default for local text AI; if something is already serving there (a
// self-managed llama-server), this manager leaves it alone and uses it.

const PORT = 8001;
const ORIGIN = `http://127.0.0.1:${PORT}`;

interface InstallState {
  tierId: string;
  file: string;
  // "" when the memory budget could not cover the summaries model too.
  utilityFile: string;
  llamaTag: string;
}

export class LocalAiManager {
  private child: ChildProcess | null = null;
  private busy: LocalAiStatus["busy"] = "";
  private progress: LocalAiStatus["progress"] = null;
  private error = "";
  private externalServer = false;
  private ready = false;
  private hardware: HardwareInfo | null = null;
  private readonly listeners = new Set<() => void>();
  readonly comfy: ComfyManager;

  constructor(private readonly rootDir: string) {
    this.comfy = new ComfyManager(path.join(rootDir, "comfy"), () => this.emit());
  }

  private get binDir(): string {
    return path.join(this.rootDir, "bin");
  }
  private get modelsDir(): string {
    return path.join(this.rootDir, "models");
  }
  private get stateFile(): string {
    return path.join(this.rootDir, "state.json");
  }
  private get presetFile(): string {
    return path.join(this.rootDir, "models.ini");
  }
  private get logFile(): string {
    return path.join(this.rootDir, "llama-server.log");
  }

  onStatus(listener: () => void): void {
    this.listeners.add(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private setProgress(label: string, percent: number): void {
    this.progress = { label, percent: Math.max(0, Math.min(100, Math.round(percent))) };
    this.emit();
  }

  private state(): InstallState | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as InstallState;
      if (parsed?.tierId && fs.existsSync(path.join(this.modelsDir, parsed.file))) {
        // Pre-utility installs lack the field; a missing file means missing.
        if (
          !parsed.utilityFile ||
          !fs.existsSync(path.join(this.modelsDir, parsed.utilityFile))
        ) {
          parsed.utilityFile = "";
        }
        return parsed;
      }
    } catch {
      // Not installed.
    }
    return null;
  }

  status(): LocalAiStatus {
    const state = this.state();
    return {
      supported: llamaArchiveUrl(process.platform, process.arch) !== null,
      installedTierId: state?.tierId ?? "",
      installedLabel: state ? (catalogEntry(state.tierId)?.label ?? "") : "",
      utilityInstalled: Boolean(state?.utilityFile),
      running: this.externalServer || (this.ready && this.child !== null && this.child.exitCode === null),
      busy: this.busy,
      progress: this.progress,
      error: this.error,
      comfy: this.comfy.status(),
    };
  }

  async scan(): Promise<{ hardware: HardwareInfo; tiers: LocalAiTier[] }> {
    this.hardware = await scanHardware();
    return {
      hardware: this.hardware,
      tiers: sizeTiers(this.hardware, this.state()?.tierId ?? ""),
    };
  }

  private llamaServerPath(): string | null {
    const name = process.platform === "win32" ? "llama-server.exe" : "llama-server";
    const stack = [this.binDir];
    while (stack.length) {
      const dir = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name === name) return full;
      }
    }
    return null;
  }

  // The catalog GGUFs live on Hugging Face, whose tree API publishes each
  // LFS file's sha256; it is looked up first and verified while streaming.
  private async downloadModel(entry: CatalogEntry, target: string): Promise<void> {
    const label = `Downloading ${entry.label} (${entry.sizeGb} GB)`;
    this.setProgress(label, 0);
    const sha256 = await fetchHfSha256(entry.url);
    await downloadVerified(entry.url, target, {
      kind: "gguf",
      sha256,
      onProgress: (percent) => this.setProgress(label, percent),
    });
  }

  private async ensureLlama(): Promise<void> {
    if (this.llamaServerPath()) return;
    const url = llamaArchiveUrl(process.platform, process.arch);
    if (!url) throw new Error("Local AI is not supported on this platform yet.");
    const archive = path.join(this.rootDir, path.basename(url));
    const label = "Downloading the AI engine (llama.cpp)";
    this.setProgress(label, 0);
    await downloadVerified(url, archive, {
      kind: "archive",
      sha256: llamaArchiveSha256(url),
      onProgress: (percent) => this.setProgress(label, percent),
    });
    fs.rmSync(this.binDir, { recursive: true, force: true });
    fs.mkdirSync(this.binDir, { recursive: true });
    // bsdtar (shipped on Windows 10+ and macOS) and GNU tar both unpack
    // .tar.gz; bsdtar also reads the Windows .zip asset.
    await runFile("tar", ["-xf", archive, "-C", this.binDir]);
    fs.rmSync(archive, { force: true });
    if (!this.llamaServerPath()) {
      throw new Error("The llama.cpp archive did not contain llama-server.");
    }
  }

  async install(tierId: string): Promise<void> {
    if (this.busy) throw new Error("An install is already in progress.");
    const entry = catalogEntry(tierId);
    if (!entry) throw new Error("Unknown model choice.");
    this.busy = "downloading";
    this.error = "";
    this.emit();
    try {
      await this.stopServer();
      const hardware = this.hardware ?? (await scanHardware());
      this.hardware = hardware;
      const wantUtility = utilityFits(entry, hardware);
      const modelPath = path.join(this.modelsDir, entry.file);
      const utilityPath = path.join(this.modelsDir, UTILITY_ENTRY.file);
      // Check free space before the first byte, not 38 GB into the stream.
      // One spare GB covers the llama archive and its unpacked binaries.
      let neededGb = 1;
      if (!fs.existsSync(modelPath)) neededGb += entry.sizeGb;
      if (wantUtility && !fs.existsSync(utilityPath)) neededGb += UTILITY_ENTRY.sizeGb;
      await ensureDiskSpace(this.rootDir, neededGb);
      await this.ensureLlama();
      if (!fs.existsSync(modelPath)) {
        await this.downloadModel(entry, modelPath);
      }
      if (wantUtility && !fs.existsSync(utilityPath)) {
        await this.downloadModel(UTILITY_ENTRY, utilityPath);
      }
      const state: InstallState = {
        tierId,
        file: entry.file,
        utilityFile: wantUtility ? UTILITY_ENTRY.file : "",
        llamaTag: LLAMA_TAG,
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
      // Old tiers' files are kept until a different file is fully installed,
      // then swept, so a failed upgrade never deletes the working model.
      const keep = new Set([entry.file, ...(wantUtility ? [UTILITY_ENTRY.file] : [])]);
      for (const file of fs.readdirSync(this.modelsDir)) {
        if (!keep.has(file) && file.endsWith(".gguf")) {
          fs.rmSync(path.join(this.modelsDir, file), { force: true });
        }
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.busy = "";
      this.progress = null;
      this.emit();
    }
  }

  // The model alias the ODM server should be configured to request.
  installedAlias(): string {
    const state = this.state();
    return state ? (catalogEntry(state.tierId)?.alias ?? "") : "";
  }

  // "" when the utility model did not fit; callers fall back to the story alias.
  installedUtilityAlias(): string {
    return this.state()?.utilityFile ? UTILITY_ENTRY.alias : "";
  }

  private async portInUse(): Promise<boolean> {
    try {
      const response = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    const state = this.state();
    if (!state || (this.child && this.child.exitCode === null)) return;
    if (await this.portInUse()) {
      // Someone already runs an AI server here (a hand-managed llama-server,
      // Ollama behind a proxy). Theirs wins; nothing to manage.
      this.externalServer = true;
      this.error = "";
      return;
    }
    const entry = catalogEntry(state.tierId);
    const bin = this.llamaServerPath();
    if (!entry || !bin) return;
    this.busy = "starting";
    this.emit();
    try {
      const hardware = this.hardware ?? (await scanHardware());
      this.hardware = hardware;
      fs.writeFileSync(
        this.presetFile,
        presetFor(entry, path.join(this.modelsDir, entry.file), hardware) +
          (state.utilityFile
            ? utilityPresetSection(path.join(this.modelsDir, state.utilityFile))
            : ""),
      );
      const log = openLog(this.logFile);
      const child = spawn(
        bin,
        [
          "--host",
          "127.0.0.1",
          "--port",
          String(PORT),
          "--models-preset",
          this.presetFile,
          // Two slots: the story model plus the on-demand utility model.
          "--models-max",
          "2",
        ],
        {
          stdio: ["ignore", log, log],
          // The Vulkan build's shared libraries sit beside the binary.
          env: {
            ...process.env,
            LD_LIBRARY_PATH: `${path.dirname(bin)}:${process.env.LD_LIBRARY_PATH ?? ""}`,
          },
        },
      );
      this.child = child;
      this.ready = false;
      let launchFailed = false;
      const launchFailure = new Promise<never>((_resolve, reject) => {
        child.once("error", (err) => {
          launchFailed = true;
          if (this.child === child) {
            this.child = null;
            this.error = `The local AI server could not start: ${err.message}`;
            this.emit();
          }
          reject(new Error(`The local AI server could not start: ${err.message}`));
        });
      });
      child.once("exit", () => {
        if (this.child === child) {
          this.child = null;
          this.ready = false;
          this.error = "The local AI server stopped (see llama-server.log).";
          this.emit();
        }
      });
      fs.closeSync(log);
      // Wait for the server process, not the model: the model loads in the
      // background and the first request simply waits for it.
      // Running means answering (#40), and a program that cannot be
      // launched at all emits error and never exit (#37): either ends the
      // wait.
      const healthy = await Promise.race([launchFailure, (async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && child.exitCode === null && !launchFailed) {
          if (await this.portInUse()) return true;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return false;
      })()]);
      if (!healthy || this.child !== child || child.exitCode !== null) {
        throw new Error(child.exitCode === null
          ? "The local AI server did not become healthy in time (see llama-server.log)."
          : "The local AI server exited during startup (see llama-server.log).");
      }
      this.ready = true;
      this.error = "";
    } catch (err) {
      await this.stopServer();
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.busy = "";
      this.emit();
    }
  }

  // Stops only the llama-server, for a reinstall; stop() below is the quit
  // path and takes the image server down with it.
  private async stopServer(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.externalServer = false;
    this.ready = false;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(killer);
          child.off("exit", done);
          child.off("error", done);
          resolve();
        };
        child.once("exit", done);
        child.once("error", done);
        const killer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 8000);
        child.kill("SIGTERM");
      });
    }
  }

  async stop(): Promise<void> {
    await Promise.all([this.stopServer(), this.comfy.stop()]);
  }

  // The image stack shares the top-level busy and progress plumbing so the
  // renderer's one install screen serves both flows.
  async installComfy(): Promise<void> {
    if (this.busy) throw new Error("An install is already in progress.");
    this.busy = "downloading";
    this.error = "";
    this.emit();
    try {
      const hardware = this.hardware ?? (await scanHardware());
      this.hardware = hardware;
      await this.comfy.install(hardware, (label, percent) => this.setProgress(label, percent));
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.busy = "";
      this.progress = null;
      this.emit();
    }
  }

  async startComfy(): Promise<void> {
    await this.comfy.start();
    this.emit();
  }

  async uninstallComfy(): Promise<void> {
    await this.comfy.uninstall();
    this.emit();
  }

  // Removes the text stack (engine, models, preset) but leaves the image
  // stack alone; the two live under one root yet uninstall independently.
  async uninstallText(): Promise<void> {
    await this.stopServer();
    const targets = [this.binDir, this.modelsDir, this.stateFile, this.presetFile, this.logFile];
    // A quit mid-download can leave the llama archive or its .part behind.
    try {
      for (const file of fs.readdirSync(this.rootDir)) {
        if (file.startsWith("llama-")) targets.push(path.join(this.rootDir, file));
      }
    } catch {
      // Never installed.
    }
    for (const target of targets) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    this.error = "";
    this.emit();
  }
}
