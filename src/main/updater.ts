import type { AppUpdater, ProgressInfo } from "electron-updater";
import type { InstallKind, UpdateProgress, UpdateStatus } from "../shared/types";

// Desktop updates against the GitHub Releases feed (electron-builder.yml
// publish block). Every install channel applies the new build its own way:
// the AppImage and NSIS builds swap themselves out through electron-updater's
// feed, an rpm or deb goes through the package manager behind the system's
// password prompt, a tar.gz unpacks over itself, the Mac bundle is replaced
// from the release zip, and a flatpak bundle is installed by the host's
// flatpak. Where the app cannot write, the system's password prompt stands
// in. Only a store install (snap, pacman) keeps the old "here is where to
// get it" note.
//
// electron-updater answers null instead of checking whenever it does not
// recognise the install (on Linux that is anything but an AppImage), which
// used to read as "up to date" on a tar.gz or rpm install. So the installs
// that cannot self-update ask GitHub for the latest release directly, and
// the self-updating ones fall back to that same question when the feed
// declines to answer.
//
// electron-updater drags in electron at require time, so it loads lazily
// inside the class: this module must stay importable under plain node for
// the unit tests.

// The background check runs as soon as the window can hear the answer: a
// player on an old build should know before they have joined a table, since a
// mismatched app and host is its own source of trouble.
const STARTUP_CHECK_DELAY_MS = 1_200;

const REPO = "Lebbitheplow/open-dungeon-master-client";
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

const SELF_UPDATE_KINDS: ReadonlySet<InstallKind> = new Set(["appimage", "nsis"]);

// Installs whose new build is one file on the release: the app fetches that
// file and applies it, instead of sending the player to a web page to work
// out which of twenty assets is theirs.
export type PackageFormat = "rpm" | "deb" | "";

export function packageAssetName(
  version: string,
  kind: InstallKind,
  platform: NodeJS.Platform,
  arch: string,
  format: PackageFormat,
): string {
  const base = `open-dungeon-master-client-${version}`;
  // The zip, not the dmg: it unpacks straight into a bundle the app can
  // move over its own, with no disk image to mount and eject.
  if (platform === "darwin" && kind === "mac") return `${base}-${arch === "arm64" ? "arm64" : "x64"}-mac.zip`;
  if (platform !== "linux" || arch !== "x64") return "";
  if (kind === "managed") {
    if (format === "rpm") return `${base}-x86_64.rpm`;
    if (format === "deb") return `${base}-amd64.deb`;
    return "";
  }
  if (kind === "portable") return `${base}-x64.tar.gz`;
  if (kind === "flatpak") return `${base}-x86_64.flatpak`;
  return "";
}

// What the updater needs from the machine it runs on, behind an interface so
// the install paths run under plain node in the tests.
export interface InstallHost {
  format: PackageFormat;
  platform: NodeJS.Platform;
  arch: string;
  // The running binary: tells a tar.gz install where it lives and a Mac
  // install which bundle to replace.
  execPath: string;
  // $APPIMAGE, the file an AppImage run was started from ("" elsewhere).
  appImagePath: string;
  downloadsDir(): string;
  // Opens the file with whatever the system uses for it.
  open(file: string): Promise<void>;
  // Shows the file in the file manager.
  reveal(file: string): void;
  // Is this command on the PATH?
  has(command: string): Promise<boolean>;
  // Can this process write into the directory?
  writable(dir: string): Promise<boolean>;
  // Runs a command to completion. Rejects only when it cannot start.
  run(command: string, args: string[]): Promise<{ code: number; stderr: string }>;
  // Starts the app again once this process has quit (from a new binary when
  // one is given), then quits.
  relaunch(execPath?: string): void;
  // The flatpak this run is, and whether it sits in the system-wide
  // installation; null outside a flatpak.
  flatpak?: { id: string; system: boolean } | null;
  fetchImpl?: typeof fetch;
}

// Empty for the kinds that install themselves; shown next to "Update
// available" for the rest, and for a self-installing kind on an
// architecture the release does not carry.
const INSTRUCTIONS: Record<InstallKind, string> = {
  appimage: "",
  nsis: "",
  dev: "",
  flatpak: "Download the latest .flatpak bundle from the releases page on GitHub.",
  snap: "Update with: snap refresh",
  managed: "Update through your package manager.",
  portable: "Download the latest version from the releases page on GitHub.",
  mac: "Download the latest version from the releases page on GitHub.",
};

// How was this build installed? Decides how the app replaces itself.
// Sandbox and package-manager markers win over the path check because those
// environments still mount the binary under /usr. packageType is the
// resources/package-type file electron-builder leaves in every rpm and deb
// it builds (and nowhere else), so a tar.gz unpacked under /opt no longer
// reads as one. Without it, /usr and /opt still mean a package manager owns
// the files (the AUR package), which the app leaves to that manager;
// /usr/local and everywhere else is a tar.gz unpack.
export function detectInstallKind(
  env: NodeJS.ProcessEnv,
  execPath: string,
  platform: NodeJS.Platform,
  packaged: boolean,
  packageType = "",
): InstallKind {
  if (!packaged) return "dev";
  if (env.APPIMAGE) return "appimage";
  if (env.FLATPAK_ID) return "flatpak";
  if (env.SNAP) return "snap";
  if (platform === "win32") return env.PORTABLE_EXECUTABLE_DIR ? "portable" : "nsis";
  if (platform === "darwin") return "mac";
  if (packageType) return "managed";
  if (execPath.startsWith("/usr/local/")) return "portable";
  if (execPath.startsWith("/usr/") || execPath.startsWith("/opt/")) return "managed";
  return "portable";
}

// Which package the app updates from: the package-type electron-builder
// wrote, when it is one the release carries.
export function packageFormatOf(packageType: string): PackageFormat {
  const type = packageType.trim();
  return type === "rpm" || type === "deb" ? type : "";
}

// /.flatpak-info names the deployed app's path, which says which
// installation holds it. Anything but the system-wide one reads as the
// player's own: a new build there is still the one flatpak run prefers.
export function flatpakIsSystemWide(info: string): boolean {
  const appPath = /^app-path=(.*)$/m.exec(info)?.[1] ?? "";
  return appPath.startsWith("/var/lib/flatpak/");
}

// Starts a flatpak again from outside its sandbox once the running copy is
// gone: a relaunch from inside would start the old build still mounted at
// /app, and one started too soon meets the single-instance lock and quits.
// "up" tells the app the host has the command before it quits; the wait
// gives up after a minute. Any args follow the id to the new run.
export function flatpakRelaunchCommand(id: string, args: readonly string[] = []): [string, string[]] {
  const script = [
    "echo up",
    "exec >/dev/null 2>&1",
    "i=0",
    'while [ "$i" -lt 120 ] && flatpak ps --columns=application | grep -qx "$1"; do sleep 0.5; i=$((i + 1)); done',
    'exec flatpak run "$@"',
  ].join("; ");
  return ["flatpak-spawn", ["--host", "sh", "-c", script, "sh", id, ...args]];
}

// POSIX single quotes for a shell word.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// An AppleScript string literal.
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Plain numeric dotted compare; the release stream is x.y.z with no
// prerelease tags, so full semver rules would be dead weight.
export function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split(".").map((part) => parseInt(part, 10) || 0);
  const b = current.split(".").map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

// Release tags are "v0.9.0" or "0.9.0"; anything that is not a dotted
// version is not a release to offer.
export function versionFromTag(tag: unknown): string {
  if (typeof tag !== "string") return "";
  const bare = tag.trim().replace(/^v/i, "");
  return /^\d+(\.\d+)+$/.test(bare) ? bare : "";
}

export type LatestVersionFetcher = () => Promise<string>;

// The newest published release on GitHub, straight from the API. No token:
// the repo is public and one call per launch sits far under the anonymous
// rate limit. A 404 means no release has shipped yet, which is "nothing to
// update to" rather than a failure worth showing the player.
export async function fetchLatestReleaseVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "open-dungeon-master-client" },
  });
  if (res.status === 404) return "";
  if (!res.ok) throw new Error(`GitHub answered ${res.status} while checking for updates.`);
  const body = (await res.json()) as { tag_name?: unknown };
  return versionFromTag(body.tag_name);
}

// The SHA-256 GitHub computed for a release file when it was uploaded, asked
// of the API rather than the host the file downloads from. A package whose
// bytes do not hash to it is never opened, unpacked or installed.
export async function releaseAssetDigest(fetchImpl: typeof fetch, version: string, asset: string): Promise<string> {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "open-dungeon-master-client" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} while looking up version ${version}.`);
  const body = (await res.json()) as { assets?: { name?: unknown; digest?: unknown }[] };
  const digest = Array.isArray(body.assets) ? body.assets.find((entry) => entry?.name === asset)?.digest : undefined;
  const match = typeof digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(digest) : null;
  if (!match) throw new Error(`Version ${version} lists no checksum for ${asset}, so it was not downloaded.`);
  return match[1]!;
}

// A package bigger than this is not one of ours.
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
// A download that sends nothing for this long is given up.
const PACKAGE_IDLE_MS = 60_000;

// Before the first release ships, the feed URL serves a 404. That is
// "nothing to update to", not a failure worth showing the player.
function isMissingFeed(err: unknown): boolean {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (status === 404) return true;
  return err instanceof Error && /404/.test(err.message);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The last line a package manager printed, which is where it says why.
function lastLine(stderr: string): string {
  const lines = stderr.trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1];
  return last ? `: ${last.trim()}` : ".";
}

// Moves a file, copying when the two paths sit on different filesystems.
async function moveFile(from: string, to: string): Promise<void> {
  const { copyFile, rename, rm } = await import("node:fs/promises");
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

// The new AppImage takes the old one's place. Same rule as electron-updater:
// a file the player renamed (no version in its name) keeps its name, a
// versioned one is replaced by the new versioned file. The running AppImage
// keeps its mount, so the swap under it is safe.
export async function replaceAppImage(current: string, downloaded: string): Promise<string> {
  const pathModule = await import("node:path");
  const { chmod, rm } = await import("node:fs/promises");
  const currentName = pathModule.basename(current);
  const keepName = pathModule.basename(downloaded) === currentName || !/\d+\.\d+\.\d+/.test(currentName);
  const destination = keepName ? current : pathModule.join(pathModule.dirname(current), pathModule.basename(downloaded));
  await moveFile(downloaded, destination);
  await chmod(destination, 0o755);
  if (destination !== current) await rm(current, { force: true });
  return destination;
}

export class Updater {
  private readonly listeners = new Set<() => void>();
  private updater: AppUpdater | null = null;
  private startupChecked = false;
  private found: UpdateStatus | null = null;
  private state: UpdateProgress = {
    state: "idle",
    percent: 0,
    latest: "",
    error: "",
    message: "",
    status: null,
  };

  constructor(
    readonly kind: InstallKind,
    private readonly currentVersion: string,
    private readonly fetchLatest: LatestVersionFetcher = fetchLatestReleaseVersion,
    private readonly startupDelayMs = STARTUP_CHECK_DELAY_MS,
    private readonly host: InstallHost | null = null,
  ) {}

  private assetFor(version: string): string {
    if (!this.host || this.canSelfUpdate()) return "";
    return packageAssetName(version, this.kind, this.host.platform, this.host.arch, this.host.format);
  }

  onStatus(listener: () => void): void {
    this.listeners.add(listener);
  }

  progress(): UpdateProgress {
    return { ...this.state };
  }

  // What the background check found, for a page that loaded after it ran.
  lastFound(): UpdateStatus | null {
    return this.found;
  }

  private setProgress(patch: Partial<UpdateProgress>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private canSelfUpdate(): boolean {
    return SELF_UPDATE_KINDS.has(this.kind);
  }

  private statusOf(latest: string, available: boolean): UpdateStatus {
    return {
      current: this.currentVersion,
      latest: latest || this.currentVersion,
      available,
      canSelfUpdate: this.canSelfUpdate(),
      canDownload: available && Boolean(this.assetFor(latest)),
      instruction: INSTRUCTIONS[this.kind],
      releasesUrl: RELEASES_URL,
    };
  }

  private async load(): Promise<AppUpdater> {
    if (this.updater) return this.updater;
    const { autoUpdater } = await import("electron-updater");
    // Downloads only ever start from an explicit player click.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("download-progress", (info: ProgressInfo) => {
      this.setProgress({ state: "downloading", percent: Math.round(info.percent) });
    });
    // quitAndInstall reports a failed install here instead of throwing, so
    // without this listener a broken install read as a clean restart.
    autoUpdater.on("error", (err: Error) => {
      if (this.state.state === "downloading" || this.state.state === "installing") {
        this.setProgress({ state: "error", error: reason(err) });
      }
    });
    this.updater = autoUpdater;
    return autoUpdater;
  }

  // What GitHub says is newest, compared against this build.
  private async checkGitHub(): Promise<UpdateStatus> {
    const latest = await this.fetchLatest();
    return this.statusOf(latest, Boolean(latest) && isNewerVersion(latest, this.currentVersion));
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    // A dev run has no app-update.yml and nothing meaningful to compare.
    if (this.kind === "dev") return this.statusOf(this.currentVersion, false);
    if (!this.canSelfUpdate()) return this.checkGitHub();
    const updater = await this.load();
    try {
      const result = await updater.checkForUpdates();
      // null is electron-updater declining to look (it did not recognise
      // the install), not an answer; ask GitHub instead of calling that
      // "up to date".
      if (!result) return this.checkGitHub();
      return this.statusOf(result.updateInfo.version, result.isUpdateAvailable);
    } catch (err) {
      if (isMissingFeed(err)) return this.statusOf(this.currentVersion, false);
      throw err;
    }
  }

  private installed(version: string): void {
    this.setProgress({ state: "ready", percent: 100, message: `Version ${version} is installed. Restarting...` });
  }

  private failed(err: unknown): void {
    if (this.state.state === "downloading" || this.state.state === "installing" || this.state.state === "ready") {
      this.setProgress({ state: "error", error: reason(err) });
    }
  }

  // The feed route, for the kinds electron-updater knows how to fetch:
  // re-check first, since it only downloads what its own last check found,
  // and a stale renderer state must not be trusted.
  private async downloadFromFeed(): Promise<{ updater: AppUpdater; version: string; files: string[] }> {
    const updater = await this.load();
    const result = await updater.checkForUpdates();
    if (!result || !result.isUpdateAvailable) {
      this.setProgress({ state: "idle", percent: 0, error: "" });
      throw new Error("You already have the latest version.");
    }
    const version = result.updateInfo.version;
    this.setProgress({ state: "downloading", percent: 0, latest: version, error: "", message: "" });
    const files = await updater.downloadUpdate(result.cancellationToken);
    return { updater, version, files };
  }

  // Windows: the NSIS installer runs silently once this process is gone and
  // starts the new build itself. The default (a visible wizard, no restart)
  // is what left the download sitting there waiting for clicks.
  private async installNsis(): Promise<void> {
    try {
      const { updater, version } = await this.downloadFromFeed();
      this.setProgress({ state: "installing", percent: 100, message: `Installing version ${version}. The app restarts on its own.` });
      updater.quitAndInstall(true, true);
      if (this.state.state === "error") throw new Error(this.state.error);
      this.setProgress({ state: "ready", percent: 100, message: `Version ${version} is installing. The app restarts on its own.` });
    } catch (err) {
      this.failed(err);
      throw err;
    }
  }

  // Linux AppImage: the swap is done here rather than by quitAndInstall,
  // which starts the new AppImage while this one still holds the single
  // instance lock (so the new one quits at once) and leaves the old file's
  // launcher pointing nowhere. Relaunching after quit sidesteps both.
  private async installAppImage(): Promise<void> {
    try {
      const { version, files } = await this.downloadFromFeed();
      const downloaded = files.find((file) => file.endsWith(".AppImage")) ?? files[0];
      if (!this.host?.appImagePath || !downloaded) {
        throw new Error("The new AppImage was downloaded, but this run does not know which file to replace.");
      }
      this.setProgress({ state: "installing", percent: 100, message: `Installing version ${version}...` });
      const destination = await replaceAppImage(this.host.appImagePath, downloaded);
      this.installed(version);
      this.host.relaunch(destination);
    } catch (err) {
      this.failed(err);
      throw err;
    }
  }

  // An rpm or deb goes through the distribution's own package manager, with
  // pkexec putting up the system's password prompt: the app itself never
  // runs as root. Without pkexec or a known package manager the system's
  // installer gets the file, as before.
  private async installPackage(file: string, version: string): Promise<void> {
    const host = this.host!;
    const tools: Array<[string, string[]]> =
      host.format === "rpm"
        ? [
            ["dnf", ["install", "-y", file]],
            ["zypper", ["--non-interactive", "install", "--allow-unsigned-rpm", file]],
            ["rpm", ["-U", file]],
          ]
        : [
            ["apt-get", ["install", "-y", file]],
            ["dpkg", ["-i", file]],
          ];
    let tool: [string, string[]] | null = null;
    if (await host.has("pkexec")) {
      for (const candidate of tools) {
        if (await host.has(candidate[0])) {
          tool = candidate;
          break;
        }
      }
    }
    if (!tool) {
      this.setProgress({
        state: "ready",
        percent: 100,
        message: `Version ${version} is downloaded. Your system's installer is opening it; close this app when it asks.`,
      });
      await host.open(file);
      return;
    }
    this.setProgress({ state: "installing", percent: 100, message: `Installing version ${version}. Your system may ask for your password.` });
    const args = host.format === "deb" ? ["env", "DEBIAN_FRONTEND=noninteractive", tool[0], ...tool[1]] : [tool[0], ...tool[1]];
    const { code, stderr } = await host.run("pkexec", args);
    // 126 is the player closing the password prompt; 127 is polkit saying no.
    if (code === 126) throw new Error(`The install was cancelled. Version ${version} is in your Downloads folder.`);
    if (code !== 0) throw new Error(`The package manager could not install version ${version}${lastLine(stderr)}`);
    await this.discard(file);
    this.installed(version);
    host.relaunch();
  }

  // A tar.gz install unpacks the new build over itself. Linux replaces the
  // files under a running program without complaint; the old binaries stay
  // alive until this process quits and the relaunch starts the new ones. A
  // folder the player cannot write to (unpacked there as root) goes through
  // pkexec, and the files stay root's.
  private async unpackOver(file: string, version: string): Promise<void> {
    const host = this.host!;
    const pathModule = await import("node:path");
    const dir = pathModule.dirname(host.execPath);
    const direct = await host.writable(dir);
    const elevate = !direct && (await host.has("pkexec"));
    if (!(await host.has("tar")) || (!direct && !elevate)) {
      this.setProgress({
        state: "ready",
        percent: 100,
        message: `Version ${version} is in your Downloads folder. Unpack it over the old one.`,
      });
      host.reveal(file);
      return;
    }
    this.setProgress({
      state: "installing",
      percent: 100,
      message: elevate ? `Installing version ${version}. Your system may ask for your password.` : `Installing version ${version}...`,
    });
    // The archive wraps everything in one versioned folder.
    const args = ["-xzf", file, "-C", dir, "--strip-components=1"];
    const { code, stderr } = elevate
      ? await host.run("pkexec", ["tar", ...args, "--no-same-owner"])
      : await host.run("tar", args);
    if (elevate && code === 126) throw new Error(`The install was cancelled. Version ${version} is in your Downloads folder.`);
    if (code !== 0) throw new Error(`Unpacking version ${version} failed${lastLine(stderr)}`);
    await this.discard(file);
    this.installed(version);
    host.relaunch();
  }

  // The Mac bundle is replaced whole: the zip unpacks, the old bundle steps
  // aside, the new one takes its path, and the relaunch starts it from
  // there. A copy Gatekeeper runs from a read-only random path (never moved
  // out of Downloads) or a disk image is not where the app lives, so the
  // new build goes into Applications instead. A folder this account cannot
  // write to takes the move behind the administrator password prompt.
  private async swapBundle(file: string, version: string): Promise<void> {
    const host = this.host!;
    const pathModule = await import("node:path");
    const { mkdir, readdir, rm } = await import("node:fs/promises");
    const running = pathModule.resolve(host.execPath, "../../..");
    const adrift =
      running.includes("/AppTranslocation/") ||
      (running.startsWith("/Volumes/") && !(await host.writable(pathModule.dirname(running))));
    const bundle = adrift ? pathModule.join("/Applications", pathModule.basename(running)) : running;
    const parent = pathModule.dirname(bundle);
    const elevated = !(await host.writable(parent));
    if (!running.endsWith(".app") || !(await host.has("ditto")) || (elevated && !(await host.has("osascript")))) {
      this.setProgress({
        state: "ready",
        percent: 100,
        message: `Version ${version} is in your Downloads folder. Unpack it and drag the app into Applications over the old one.`,
      });
      host.reveal(file);
      return;
    }
    this.setProgress({
      state: "installing",
      percent: 100,
      message: elevated ? `Installing version ${version}. Your Mac may ask for your password.` : `Installing version ${version}...`,
    });
    // Beside the bundle, the swap is one rename on the same disk; the
    // elevated move starts from a folder this account can write.
    const staging = pathModule.join(elevated ? pathModule.dirname(file) : parent, `.odm-update-${version}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      const { code, stderr } = await host.run("ditto", ["-x", "-k", file, staging]);
      if (code !== 0) throw new Error(`Unpacking version ${version} failed${lastLine(stderr)}`);
      const unpacked = (await readdir(staging)).find((entry) => entry.endsWith(".app"));
      if (!unpacked) throw new Error(`The download of version ${version} did not contain an app.`);
      const fresh = pathModule.join(staging, unpacked);
      if (elevated) await this.moveBundleAsAdmin(fresh, bundle, version);
      else await this.moveBundle(fresh, bundle);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.discard(file);
    this.installed(version);
    host.relaunch(adrift ? pathModule.join(bundle, "Contents", "MacOS", pathModule.basename(host.execPath)) : undefined);
  }

  // The old bundle (when there is one) steps aside and comes back if the
  // new one cannot take its place.
  private async moveBundle(fresh: string, bundle: string): Promise<void> {
    const { rename, rm } = await import("node:fs/promises");
    const retired = `${bundle}.old`;
    await rm(retired, { recursive: true, force: true });
    let hadOld = true;
    try {
      await rename(bundle, retired);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      hadOld = false;
    }
    try {
      await rename(fresh, bundle);
    } catch (err) {
      if (hadOld) await rename(retired, bundle).catch(() => undefined);
      throw err;
    }
    await rm(retired, { recursive: true, force: true }).catch(() => undefined);
  }

  // The same steps as one shell command run by osascript with
  // administrator privileges, which puts up the Mac's own password prompt.
  private async moveBundleAsAdmin(fresh: string, bundle: string, version: string): Promise<void> {
    const b = shellQuote(bundle);
    const r = shellQuote(`${bundle}.old`);
    const f = shellQuote(fresh);
    const script = `rm -rf ${r} && { [ ! -e ${b} ] || mv ${b} ${r}; } && { mv ${f} ${b} || { [ ! -e ${r} ] || mv ${r} ${b}; exit 1; }; } && rm -rf ${r}`;
    const { code, stderr } = await this.host!.run("osascript", [
      "-e",
      `do shell script ${appleScriptString(script)} with administrator privileges`,
    ]);
    // -128 is the player closing the password prompt.
    if (/-128/.test(stderr)) throw new Error(`The install was cancelled. Version ${version} is in your Downloads folder.`);
    if (code !== 0) throw new Error(`Moving version ${version} into place failed${lastLine(stderr)}`);
  }

  // A flatpak bundle installs from the host side: flatpak-spawn reaches the
  // host's flatpak (the bundle's --talk-name=org.freedesktop.Flatpak) and
  // installs into whichever installation holds the running copy, the
  // system-wide one behind the same password prompt the software center
  // uses. A bundle built before that permission cannot reach the host, so
  // its download still goes to the software center.
  private async installFlatpak(file: string, version: string): Promise<void> {
    const host = this.host!;
    const flatpak = host.flatpak;
    const reachable =
      Boolean(flatpak) && (await host.has("flatpak-spawn")) && (await host.run("flatpak-spawn", ["--host", "true"])).code === 0;
    if (!flatpak || !reachable) {
      this.setProgress({
        state: "ready",
        percent: 100,
        message: `Version ${version} is downloaded. Your software center is opening it: choose Install there, then start the app again.`,
      });
      await host.open(file);
      return;
    }
    this.setProgress({
      state: "installing",
      percent: 100,
      message: flatpak.system ? `Installing version ${version}. Your system may ask for your password.` : `Installing version ${version}...`,
    });
    const { code, stderr } = await host.run("flatpak-spawn", [
      "--host",
      "flatpak",
      "install",
      flatpak.system ? "--system" : "--user",
      "-y",
      "--bundle",
      file,
    ]);
    if (code !== 0) throw new Error(`Flatpak could not install version ${version}${lastLine(stderr)}`);
    await this.discard(file);
    this.installed(version);
    host.relaunch();
  }

  // Once a package is applied, nothing needs to stay in Downloads.
  private async discard(file: string): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(file, { force: true }).catch(() => undefined);
  }

  private async apply(file: string, version: string): Promise<void> {
    if (this.kind === "managed") return this.installPackage(file, version);
    if (this.kind === "portable") return this.unpackOver(file, version);
    if (this.kind === "mac") return this.swapBundle(file, version);
    return this.installFlatpak(file, version);
  }

  // The package route: one file from the release into Downloads, then
  // whatever this install method needs to make it the running app.
  private async downloadPackage(): Promise<void> {
    const host = this.host;
    const status = await this.checkGitHub();
    const asset = status.available ? this.assetFor(status.latest) : "";
    if (!host || !asset) {
      throw new Error(status.available ? INSTRUCTIONS[this.kind] || "This install cannot update itself." : "You already have the latest version.");
    }
    const fetcher = host.fetchImpl ?? fetch;
    const { createHash } = await import("node:crypto");
    const { createWriteStream } = await import("node:fs");
    const { mkdir, rename, rm } = await import("node:fs/promises");
    const pathModule = await import("node:path");
    const folder = host.downloadsDir();
    await mkdir(folder, { recursive: true });
    const target = pathModule.join(folder, asset);
    const partial = `${target}.part`;
    this.setProgress({ state: "downloading", percent: 0, latest: status.latest, error: "", message: "" });
    const idle = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const stillAlive = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(new Error(`The download of ${asset} stalled. Try again.`)), PACKAGE_IDLE_MS);
    };
    try {
      const expected = await releaseAssetDigest(fetcher, status.latest, asset);
      stillAlive();
      const res = await fetcher(`https://github.com/${REPO}/releases/download/v${status.latest}/${asset}`, {
        headers: { "User-Agent": "open-dungeon-master-client" },
        signal: idle.signal,
      });
      if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status} for ${asset}.`);
      const total = Number(res.headers.get("content-length")) || 0;
      if (total > MAX_PACKAGE_BYTES) throw new Error(`${asset} is larger than any release package.`);
      const out = createWriteStream(partial);
      const hash = createHash("sha256");
      let done = 0;
      let shown = -1;
      const reader = res.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stillAlive();
        done += chunk.value.byteLength;
        if (done > MAX_PACKAGE_BYTES) {
          out.destroy();
          throw new Error(`${asset} is larger than any release package.`);
        }
        hash.update(chunk.value);
        if (!out.write(chunk.value)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
        const percent = total ? Math.min(99, Math.floor((done / total) * 100)) : 0;
        if (percent !== shown) {
          shown = percent;
          this.setProgress({ state: "downloading", percent });
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      clearTimeout(idleTimer);
      if (hash.digest("hex") !== expected) {
        throw new Error(`The download of ${asset} does not match the release's checksum, so nothing was installed. Try again.`);
      }
      await rename(partial, target);
      await this.apply(target, status.latest);
    } catch (err) {
      clearTimeout(idleTimer);
      await rm(partial, { force: true }).catch(() => undefined);
      this.failed(err);
      throw err;
    }
  }

  async downloadAndInstall(): Promise<void> {
    if (this.kind === "nsis") return this.installNsis();
    if (this.kind === "appimage") return this.installAppImage();
    return this.downloadPackage();
  }

  // One quiet background check per app run, once the page can hear the
  // answer; failures stay silent because the player did not ask. The
  // renderer hears about a hit via the progress event, which carries the
  // full status so it can offer the right button without asking again, and
  // a page that loads later still finds it through lastFound().
  checkOnStartup(pageReady: Promise<void> = Promise.resolve()): void {
    if (this.startupChecked || this.kind === "dev") return;
    this.startupChecked = true;
    void pageReady
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, this.startupDelayMs)))
      .then(() => this.checkForUpdates())
      .then((status) => {
        if (status.available) {
          this.found = status;
          this.setProgress({ state: "available", latest: status.latest, status });
        }
      })
      .catch(() => undefined);
  }
}
