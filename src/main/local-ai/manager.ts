import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { GpuInfo, HardwareInfo, LocalAiStatus, LocalAiTier } from "../../shared/types";
import {
  catalogEntry,
  presetFor,
  sizeTiers,
  utilityFits,
  utilityPresetSection,
  UTILITY_ENTRY,
  type CatalogEntry,
} from "./catalog";
import { ComfyManager } from "./comfy";
import { downloadVerified, ensureDiskSpace, fetchHfSha256 } from "./download";
import {
  describeEngine,
  engineCurrent,
  engineEnv,
  enginePlan,
  engineSupported,
  findServer,
  installEngine,
  listDevices,
  pickDevice,
  planDownloadMb,
  readEngine,
  sameBackend,
  vulkanPlan,
  LLAMA_TAG,
  type EnginePlan,
} from "./engine";
import { scanHardware } from "./hardware";
import { openLog } from "../log-files";

// Installs and runs the local AI: a pinned llama.cpp build plus one curated
// model, laid out under userData/local-ai. The server preset is regenerated
// at every start so a hardware change (new GPU, more RAM) re-tunes the
// offload without a reinstall. Port 8001 is the ODM server's built-in
// default for local text AI; if something is already serving there (a
// self-managed llama-server), this manager leaves it alone and uses it.

const PORT = 8001;
const ORIGIN = `http://127.0.0.1:${PORT}`;
// What the ODM server is pointed at (wiring.ts), for status and summaries.
export const LOCAL_AI_ENDPOINT = `${ORIGIN}/v1`;

// A llama-server that was answering and then exited (a driver fault, out of
// memory, killed from outside) is started again after these delays, one per
// exit; more exits than delays inside CRASH_WINDOW_MS and the manager stops
// trying and says so, until Story AI asks for a start.
const RESTART_DELAYS_MS = [2_000, 5_000, 15_000];
const CRASH_WINDOW_MS = 10 * 60_000;

export interface LocalAiTuning {
  restartDelaysMs?: number[];
}

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
  // One start at a time: a second caller (install done, then the world
  // entered) joins the start under way instead of racing it for the port.
  private startPromise: Promise<void> | null = null;
  private crashes: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly restartDelays: number[];
  private hardware: HardwareInfo | null = null;
  // Where the last start put the model, for the status line.
  private engineWhere = "";
  private readonly listeners = new Set<() => void>();
  readonly comfy: ComfyManager;

  constructor(
    private readonly rootDir: string,
    tuning: LocalAiTuning = {},
  ) {
    this.restartDelays = tuning.restartDelaysMs ?? RESTART_DELAYS_MS;
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
  // The graphics card the player picked on the storyteller screen.
  private get gpuFile(): string {
    return path.join(this.rootDir, "gpu.json");
  }

  private gpuChoice(): string {
    try {
      const id = (JSON.parse(fs.readFileSync(this.gpuFile, "utf8")) as { gpuId?: unknown }).gpuId;
      return typeof id === "string" ? id : "";
    } catch {
      return "";
    }
  }

  private async currentHardware(): Promise<HardwareInfo> {
    this.hardware ??= await scanHardware(this.gpuChoice());
    return this.hardware;
  }

  private static selectedGpu(hardware: HardwareInfo): GpuInfo | null {
    return hardware.gpus?.find((gpu) => gpu.id === hardware.gpuId) ?? null;
  }

  private plan(hardware: HardwareInfo): EnginePlan | null {
    return enginePlan(process.platform, process.arch, LocalAiManager.selectedGpu(hardware));
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
      supported: engineSupported(process.platform, process.arch),
      installedTierId: state?.tierId ?? "",
      installedLabel: state ? (catalogEntry(state.tierId)?.label ?? "") : "",
      utilityInstalled: Boolean(state?.utilityFile),
      running: this.externalServer || (this.ready && this.child !== null && this.child.exitCode === null),
      external: this.externalServer,
      endpoint: LOCAL_AI_ENDPOINT,
      engine: state ? describeEngine(readEngine(this.binDir, state.llamaTag, process.platform), this.engineWhere) : "",
      busy: this.busy,
      progress: this.progress,
      error: this.error,
      comfy: this.comfy.status(),
    };
  }

  // gpuId is the player's pick of graphics card, kept for every later scan,
  // install and start; undefined keeps the last pick.
  async scan(gpuId?: string): Promise<{ hardware: HardwareInfo; tiers: LocalAiTier[] }> {
    if (gpuId !== undefined) {
      fs.mkdirSync(this.rootDir, { recursive: true });
      fs.writeFileSync(this.gpuFile, JSON.stringify({ gpuId }));
    }
    this.hardware = await scanHardware(this.gpuChoice());
    return {
      hardware: this.hardware,
      tiers: sizeTiers(this.hardware, this.state()?.tierId ?? ""),
    };
  }

  private llamaServerPath(): string | null {
    return findServer(this.binDir, process.platform);
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

  // The llama.cpp build for the card the local AI runs on (engine.ts),
  // replaced when this version pins another build or the card changed kind.
  private async ensureLlama(hardware: HardwareInfo): Promise<void> {
    const plan = this.plan(hardware);
    if (!plan) throw new Error("Local AI is not supported on this platform yet.");
    if (this.llamaServerPath() && engineCurrent(readEngine(this.binDir, this.state()?.llamaTag ?? "", process.platform), plan)) return;
    await installEngine({
      platform: process.platform,
      rootDir: this.rootDir,
      binDir: this.binDir,
      plan,
      fallback: vulkanPlan(process.platform, process.arch),
      onProgress: (label, percent) => this.setProgress(label, percent),
    });
  }

  // GB of free disk an engine install wants: the archives plus what they
  // unpack to (the CUDA runtime roughly doubles).
  private engineDiskGb(hardware: HardwareInfo): number {
    const plan = this.plan(hardware);
    if (!plan || (this.llamaServerPath() && engineCurrent(readEngine(this.binDir, this.state()?.llamaTag ?? "", process.platform), plan))) return 0.5;
    return Math.max(1, (planDownloadMb(plan) * 3) / 1024);
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
      const hardware = await this.currentHardware();
      const wantUtility = utilityFits(entry, hardware);
      const modelPath = path.join(this.modelsDir, entry.file);
      const utilityPath = path.join(this.modelsDir, UTILITY_ENTRY.file);
      // Check free space before the first byte, not 38 GB into the stream.
      let neededGb = this.engineDiskGb(hardware);
      if (!fs.existsSync(modelPath)) neededGb += entry.sizeGb;
      if (wantUtility && !fs.existsSync(utilityPath)) neededGb += UTILITY_ENTRY.sizeGb;
      await ensureDiskSpace(this.rootDir, neededGb);
      await this.ensureLlama(hardware);
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

  // llama-server's own health: 200 once it is up. Started with a models
  // preset it answers at once and loads a model on its first request, so
  // this is the "listening" signal the start below waits for.
  private async answersHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  // Whether what listens on the port is a model server at all: one that
  // lists its models on the OpenAI-compatible route, as the ODM server asks
  // for them. Any answer used to count, so a stray program on 8001 saying
  // 404 was adopted as the AI and the real one never started.
  private async compatibleServerAt(): Promise<boolean> {
    try {
      const response = await fetch(`${ORIGIN}/v1/models`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return false;
      const body = (await response.json().catch(() => null)) as { data?: unknown; models?: unknown } | null;
      return Array.isArray(body?.data) || Array.isArray(body?.models);
    } catch {
      return false;
    }
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const state = this.state();
    if (!state || (this.child && this.child.exitCode === null)) return;
    // Asked again, so what was adopted last time is checked again.
    this.externalServer = false;
    if (await this.compatibleServerAt()) {
      // Someone already runs an AI server here (a hand-managed llama-server,
      // Ollama behind a proxy). Theirs wins; nothing to manage.
      this.externalServer = true;
      this.error = "";
      this.emit();
      return;
    }
    const entry = catalogEntry(state.tierId);
    if (entry && this.llamaServerPath()) await this.replaceWrongEngine(state.llamaTag);
    const bin = this.llamaServerPath();
    if (!entry || !bin) {
      // Installed by the state file's word, but not runnable: say so where
      // the player looks (Story AI, the troubleshooting summary) instead of
      // leaving the world to find a refused connection on its first turn.
      this.error = !entry
        ? `The installed model (${state.tierId}) is not in this version's catalog. Install the story model again from Story AI.`
        : "The AI engine (llama-server) is missing from this install. Install the story model again from Story AI to put it back.";
      this.emit();
      throw new Error(this.error);
    }
    this.busy = "starting";
    this.emit();
    try {
      const hardware = await this.currentHardware();
      const device = await this.deviceFor(hardware, bin, state.llamaTag);
      fs.writeFileSync(
        this.presetFile,
        presetFor(entry, path.join(this.modelsDir, entry.file), hardware, device) +
          (state.utilityFile
            ? utilityPresetSection(path.join(this.modelsDir, state.utilityFile), device)
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
          env: engineEnv(bin),
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
      child.once("exit", (code, signal) => {
        // Replaced or stopped on purpose: stopServer() cleared the field first.
        if (this.child !== child) return;
        const wasReady = this.ready;
        this.child = null;
        this.ready = false;
        const why = code !== null ? `exit code ${code}` : `signal ${signal ?? "unknown"}`;
        if (!wasReady) {
          this.error = `The local AI server stopped during startup (${why}; see llama-server.log).`;
          this.emit();
          return;
        }
        this.scheduleRestart(why);
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
          if (await this.answersHealth()) return true;
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

  // An engine built for another kind of card (an NVIDIA card left on the
  // Vulkan-only build earlier versions installed, or a card swapped since)
  // is replaced before it starts. A failed download keeps the old engine:
  // it still runs, only not as well.
  private async replaceWrongEngine(legacyTag: string): Promise<void> {
    const hardware = await this.currentHardware();
    const plan = this.plan(hardware);
    const installed = readEngine(this.binDir, legacyTag, process.platform);
    if (!plan || !installed || sameBackend(installed, plan)) return;
    this.busy = "downloading";
    this.emit();
    try {
      await ensureDiskSpace(this.rootDir, this.engineDiskGb(hardware));
      await this.ensureLlama(hardware);
    } catch {
      // The installed engine carries on.
    } finally {
      this.busy = "";
      this.progress = null;
      this.emit();
    }
  }

  // The --device value that is the player's card, from what this engine
  // lists; "" leaves the choice to llama.cpp. Pinning it is what keeps an
  // integrated GPU from taking the model off the real card.
  private async deviceFor(hardware: HardwareInfo, bin: string, legacyTag: string): Promise<string> {
    const gpu = LocalAiManager.selectedGpu(hardware);
    const engine = readEngine(this.binDir, legacyTag, process.platform);
    this.engineWhere = gpu?.name ?? "";
    if (!gpu || !engine) return "";
    const devices = await listDevices(bin);
    const device = pickDevice(devices, gpu, engine.backend);
    const listed = devices.find((entry) => entry.name === device);
    this.engineWhere = listed ? `${listed.description} (${listed.name})` : `${gpu.name}, device chosen by llama.cpp`;
    return device;
  }

  // A server that was answering and went away is brought back, a few times
  // and with the reason on the status; past that the player is told where
  // to look and how to start it again.
  private scheduleRestart(why: string): void {
    const now = Date.now();
    this.crashes = this.crashes.filter((at) => now - at < CRASH_WINDOW_MS);
    this.crashes.push(now);
    const delay = this.restartDelays[this.crashes.length - 1];
    if (delay === undefined) {
      this.error =
        `The local AI server stopped ${this.crashes.length} times in ten minutes (last ${why}); see llama-server.log. ` +
        "Once the cause is fixed, start it again from Story AI, or install the story model again there.";
      this.emit();
      return;
    }
    this.error = `The local AI server stopped (${why}; see llama-server.log). Starting it again in ${Math.ceil(delay / 1000)}s...`;
    this.emit();
    this.clearRestart();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start().catch(() => undefined);
    }, delay);
    this.restartTimer.unref?.();
  }

  private clearRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  // Asked for from Story AI: the crash count is forgotten and the engine is
  // started afresh, whatever state it was left in.
  async restart(): Promise<void> {
    this.clearRestart();
    await this.stopServer();
    this.crashes = [];
    this.error = "";
    this.emit();
    await this.start();
  }

  // The status with an adopted server's liveness checked again: one that has
  // gone away is no longer "running", and the installed engine takes its
  // place. status() alone is a snapshot and never probes.
  async refresh(): Promise<LocalAiStatus> {
    if (this.externalServer && !this.startPromise && !(await this.compatibleServerAt())) {
      this.externalServer = false;
      this.error = `The AI server that was answering on port ${PORT} is gone; starting the installed one.`;
      this.emit();
      void this.start().catch(() => undefined);
    }
    return this.status();
  }

  // Stops only the llama-server, for a reinstall; stop() below is the quit
  // path and takes the image server down with it.
  private async stopServer(): Promise<void> {
    this.clearRestart();
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
      const hardware = await this.currentHardware();
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
    const targets = [this.binDir, `${this.binDir}.new`, this.modelsDir, this.stateFile, this.presetFile, this.logFile];
    // A quit mid-download can leave the llama archive or its .part behind.
    try {
      for (const file of fs.readdirSync(this.rootDir)) {
        if (file.startsWith("llama-") || file.startsWith("cudart-")) targets.push(path.join(this.rootDir, file));
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
