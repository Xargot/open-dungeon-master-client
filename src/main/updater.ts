import type { AppUpdater, ProgressInfo } from "electron-updater";
import type { InstallKind, UpdateChannel, UpdateProgress, UpdateStatus } from "../shared/types";
import { APP_ID, LEGACY_APP_ID, LEGACY_PACKAGE_NAME, PACKAGE_NAME } from "./app-names";

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
// Two channels (docs/releases.md in the server repository). Every build is
// first published as a GitHub prerelease, the beta, and the ones that hold
// up are promoted to stable by clearing that flag. Stable, the default, asks
// for GitHub's latest release, which is never a prerelease; beta (Settings >
// This app) takes the newest release of either kind.
//
// electron-updater drags in electron at require time, so it loads lazily
// inside the class: this module must stay importable under plain node for
// the unit tests.

// The background check runs as soon as the window can hear the answer: a
// player on an old build should know before they have joined a table, since a
// mismatched app and host is its own source of trouble.
const STARTUP_CHECK_DELAY_MS = 1_200;

const REPO = "Lebbitheplow/open-game-master-client";
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
// Newest first by date, so one page holds the newest beta and anything
// published after it.
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
// The release feed GitHub publishes for every repo: the newest releases,
// prereleases included, drafts never.
const RELEASES_ATOM = `https://github.com/${REPO}/releases.atom`;
const USER_AGENT = { "User-Agent": "open-game-master-client" };

// GitHub's API answers 60 calls an hour per internet connection without a
// token, shared by every program behind it. Other software on the same
// network (a bot polling the releases every few minutes) used that up, and
// then the check at launch failed without a word and an install the player
// asked for failed on its checksum lookup, until the hour turned over. So
// versions and file listings come from github.com's own pages and release
// files, which that limit does not touch; the API is only the fallback, and
// the one place left that asks it first (a package's checksum) falls back
// to the release's SHA256SUMS, then to its update feed files.
const AFTER_STARTUP_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];
// While the app stays open, the check runs again this often.
const RECHECK_MS = 6 * 60 * 60_000;

// The error for an API answer that is not a release: a rate limit is said
// as one, with when it lifts, instead of as a bare status code.
function apiFailure(res: Response, what: string): Error {
  const remaining = res.headers?.get?.("x-ratelimit-remaining");
  if ((res.status === 403 || res.status === 429) && remaining === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    const when = Number.isFinite(reset) && reset > Date.now()
      ? ` Try again after ${new Date(reset).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
      : " Try again in a few minutes.";
    return new LookupError(`GitHub is limiting update checks from this internet connection right now (too many recent requests from it).${when}`);
  }
  return new LookupError(`GitHub answered ${res.status} while ${what}.`);
}

// GitHub could not be asked (as opposed to answering "no").
class LookupError extends Error {}

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
  prefix = PACKAGE_NAME,
): string {
  const base = `${prefix}-${version}`;
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
  // Steam started this run (src/shared/deck.ts steamLaunched).
  launchedBySteam?: boolean;
  fetchImpl?: typeof fetch;
  // One line for the updater's log file: checks that failed, installs that
  // failed and why. Nothing else records them.
  log?(line: string): void;
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

// A script the host runs for a flatpak once this copy has gone. "up" tells
// the app the host has it; the script then goes on by itself, so the
// flatpak-spawn that asked for it returns at once instead of holding this
// sandbox open for as long as the script runs (an open sandbox still reads
// as running in `flatpak ps`, and the wait below would only time out).
function afterThisFlatpak(body: string, args: readonly string[]): [string, string[]] {
  const script = [
    "echo up",
    'body="$1"; shift',
    'if command -v setsid >/dev/null 2>&1; then setsid sh -c "$body" sh "$@" </dev/null >/dev/null 2>&1 &',
    'else sh -c "$body" sh "$@" </dev/null >/dev/null 2>&1 &',
    "fi",
  ].join("\n");
  return ["flatpak-spawn", ["--host", "sh", "-c", script, "sh", body, ...args]];
}

// Waits, up to a minute, for the flatpak $1 to stop running.
const WAIT_FOR_FIRST = 'i=0; while [ "$i" -lt 120 ] && flatpak ps --columns=application | grep -qx "$1"; do sleep 0.5; i=$((i + 1)); done';

// Starts a flatpak again from outside its sandbox once the running copy is
// gone: a relaunch from inside would start the old build still mounted at
// /app, and one started too soon meets the single-instance lock and quits.
// Any args follow the id to the new run.
export function flatpakRelaunchCommand(id: string, args: readonly string[] = []): [string, string[]] {
  return afterThisFlatpak([WAIT_FOR_FIRST, 'exec flatpak run "$@"'].join("\n"), [id, ...args]);
}

// Hands a flatpak from before the rename over to the renamed app, once the
// old copy is gone: its data folder becomes the new id's (unless that one
// has data of its own, which is never overwritten), the old copy is removed
// from its installation, and the new one starts with any args. With the new
// id not installed it only starts the old one again.
export function flatpakMoveCommand(
  fromId: string,
  toId: string,
  system: boolean,
  home: string,
  args: readonly string[] = [],
): [string, string[]] {
  const body = [
    WAIT_FOR_FIRST,
    'from="$1"; to="$2"; scope="$3"; old="$4/.var/app/$1"; new="$4/.var/app/$2"; shift 4',
    'flatpak info "$to" >/dev/null 2>&1 || exec flatpak run "$from" "$@"',
    // The data folder the app pins (index.ts), under the sandbox's config.
    "data=config/open-dungeon-master-client",
    "moved=yes",
    'if [ -d "$old" ]; then',
    '  if [ ! -e "$new" ]; then mv "$old" "$new" || moved=no',
    '  elif [ -d "$old/$data" ] && [ ! -e "$new/$data" ]; then mkdir -p "$new/config" && mv "$old/$data" "$new/$data" || moved=no',
    '  elif [ -d "$old/$data" ]; then moved=no',
    "  fi",
    "fi",
    '[ "$moved" = yes ] && flatpak uninstall "$scope" -y "$from"',
    'exec flatpak run "$to" "$@"',
  ].join("\n");
  return afterThisFlatpak(body, [fromId, toId, system ? "--system" : "--user", home, ...args]);
}

// POSIX single quotes for a shell word.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// An AppleScript string literal.
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Plain numeric dotted compare; every version is x.y.z, a beta being told
// apart by its release's prerelease flag rather than a "-beta" suffix, so
// full semver rules would be dead weight.
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

export type LatestVersionFetcher = (channel: UpdateChannel) => Promise<string>;

// The newest published release on GitHub, straight from the API. No token:
// the repo is public and one call per launch sits far under the anonymous
// rate limit. A 404 means no release has shipped yet, which is "nothing to
// update to" rather than a failure worth showing the player.
export async function fetchLatestReleaseVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const fromPage = await latestFromReleasePage(fetchImpl).catch(() => null);
  if (fromPage) return fromPage;
  const res = await fetchImpl(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json", ...USER_AGENT },
  });
  if (res.status === 404) return "";
  if (!res.ok) throw apiFailure(res, "checking for updates");
  const body = (await res.json()) as { tag_name?: unknown };
  return versionFromTag(body.tag_name);
}

// The version github.com's "latest release" page redirects to
// (/releases/tag/v0.23.3); null when it would not say.
export async function latestFromReleasePage(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchImpl(RELEASES_URL, {
    method: "HEAD",
    headers: USER_AGENT,
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const tag = /\/releases\/tag\/([^/?#]+)$/.exec(typeof res.url === "string" ? res.url : "")?.[1];
  return tag ? versionFromTag(decodeURIComponent(tag)) || null : null;
}

// The highest version in the release feed, prereleases included; null when
// the feed would not say.
export async function newestFromReleaseFeed(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchImpl(RELEASES_ATOM, { headers: USER_AGENT, signal: AbortSignal.timeout(20_000) });
  if (!res.ok || typeof res.text !== "function") return null;
  return newestInFeed(await res.text()) || null;
}

export function newestInFeed(xml: string): string {
  let newest = "";
  for (const match of xml.matchAll(/<link[^>]*\/releases\/tag\/([^"'?#]+)["']/g)) {
    const version = versionFromTag(decodeURIComponent(match[1] ?? ""));
    if (version && (!newest || isNewerVersion(version, newest))) newest = version;
  }
  return newest;
}

// The newest release the channel takes. Beta is the highest version among
// the recent releases, prereleases included: by version, not list order,
// since a fix to the stable line can be published after a newer beta.
export async function fetchNewestReleaseVersion(channel: UpdateChannel, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (channel !== "beta") return fetchLatestReleaseVersion(fetchImpl);
  const fromFeed = await newestFromReleaseFeed(fetchImpl).catch(() => null);
  if (fromFeed) return fromFeed;
  const res = await fetchImpl(RELEASES_API, {
    headers: { Accept: "application/vnd.github+json", ...USER_AGENT },
  });
  if (res.status === 404) return "";
  if (!res.ok) throw apiFailure(res, "checking for updates");
  const body = (await res.json()) as unknown;
  let newest = "";
  for (const release of Array.isArray(body) ? (body as { tag_name?: unknown; draft?: unknown }[]) : []) {
    if (release?.draft === true) continue;
    const version = versionFromTag(release?.tag_name);
    if (version && (!newest || isNewerVersion(version, newest))) newest = version;
  }
  return newest;
}

// The SHA-256 GitHub computed for a release file when it was uploaded, asked
// of the API rather than the host the file downloads from. A package whose
// bytes do not hash to it is never opened, unpacked or installed.
export async function releaseAssetDigest(fetchImpl: typeof fetch, version: string, asset: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, {
      headers: { Accept: "application/vnd.github+json", ...USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new LookupError(`GitHub could not be reached while looking up version ${version}: ${reason(err)}`);
  }
  if (!res.ok) throw apiFailure(res, `looking up version ${version}`);
  const body = (await res.json()) as { assets?: { name?: unknown; digest?: unknown }[] };
  const digest = Array.isArray(body.assets) ? body.assets.find((entry) => entry?.name === asset)?.digest : undefined;
  const match = typeof digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(digest) : null;
  if (!match) throw new Error(`Version ${version} lists no checksum for ${asset}, so it was not downloaded.`);
  return match[1]!;
}

// The update feed file electron-builder publishes beside a package, which
// lists its SHA-512: the AppImage, rpm and deb in latest-linux.yml, the Mac
// zips in latest-mac.yml, the Windows installer in latest.yml.
export function feedFileFor(asset: string): string {
  if (/\.(AppImage|rpm|deb)$/.test(asset)) return "latest-linux.yml";
  if (/-mac\.zip$/.test(asset)) return "latest-mac.yml";
  if (/\.exe$/.test(asset)) return "latest.yml";
  return "";
}

// The hex SHA-512 a feed file lists for one of its files, "" if none.
export function sha512FromFeed(yml: string, asset: string): string {
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.replace(/^\s*-\s*/, "").trim() === `url: ${asset}`);
  if (start < 0) return "";
  for (const line of lines.slice(start + 1)) {
    if (/^\s*-\s*url:/.test(line) || /^\S/.test(line)) break;
    const value = /^\s*sha512:\s*(\S+)\s*$/.exec(line)?.[1];
    if (value) {
      const hex = Buffer.from(value, "base64").toString("hex");
      return hex.length === 128 ? hex : "";
    }
  }
  return "";
}

// The hex SHA-256 a SHA256SUMS file (release.yml's publish job) lists for
// one file, "" if none. Lines are "<sha256>  <name>", or "<sha256> *<name>".
export function sha256FromSums(sums: string, asset: string): string {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (match?.[2] === asset) return match[1]!.toLowerCase();
  }
  return "";
}

export interface ReleaseChecksum {
  algorithm: "sha256" | "sha512";
  hex: string;
}

// What a downloaded package must hash to: the SHA-256 GitHub's API lists
// for it, or, when the API cannot be asked (rate limited, unreachable), the
// release's SHA256SUMS, then the SHA-512 in its update feed file (releases
// from before SHA256SUMS). A release the API answered for that lists no
// checksum is still refused.
export async function releaseChecksum(fetchImpl: typeof fetch, version: string, asset: string): Promise<ReleaseChecksum> {
  try {
    return { algorithm: "sha256", hex: await releaseAssetDigest(fetchImpl, version, asset) };
  } catch (err) {
    if (!(err instanceof LookupError)) throw err;
    const releaseFile = async (name: string): Promise<string> => {
      try {
        const res = await fetchImpl(`https://github.com/${REPO}/releases/download/v${version}/${name}`, {
          headers: USER_AGENT,
          signal: AbortSignal.timeout(30_000),
        });
        return res.ok && typeof res.text === "function" ? await res.text() : "";
      } catch {
        return "";
      }
    };
    const sha256 = sha256FromSums(await releaseFile("SHA256SUMS"), asset);
    if (sha256) return { algorithm: "sha256", hex: sha256 };
    const feed = feedFileFor(asset);
    const sha512 = feed ? sha512FromFeed(await releaseFile(feed), asset) : "";
    if (sha512) return { algorithm: "sha512", hex: sha512 };
    // The API's reason is the one worth showing.
    throw err;
  }
}

// Whether a release lists a file of this name. The flatpak job is best
// effort (release.yml), so a release can go out without its bundle; an
// install that updates from that file is not told about a version it could
// not install. A listing GitHub would not give says yes, and leaves the
// download to say what is wrong.
// Asked of the download link itself (a redirect when the file is there, 404
// when it is not), not the API.
export async function releaseHasAsset(fetchImpl: typeof fetch, version: string, asset: string): Promise<boolean> {
  try {
    const res = await fetchImpl(`https://github.com/${REPO}/releases/download/v${version}/${asset}`, {
      method: "HEAD",
      headers: USER_AGENT,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    return res.status !== 404;
  } catch {
    return true;
  }
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

// Does an AppImage's file name carry a version? Such a file gives way to the
// next version's file on update; any other name is kept (and so is a Steam
// shortcut to it, src/main/steam-shortcut.ts).
export function versionedAppImageName(name: string): boolean {
  return /\d+\.\d+\.\d+/.test(name);
}

// The new AppImage takes the old one's place. Same rule as electron-updater:
// a file the player renamed (no version in its name) keeps its name, a
// versioned one is replaced by the new versioned file. The running AppImage
// keeps its mount, so the swap under it is safe.
export async function replaceAppImage(current: string, downloaded: string): Promise<string> {
  const pathModule = await import("node:path");
  const { chmod, rm } = await import("node:fs/promises");
  const currentName = pathModule.basename(current);
  const keepName = pathModule.basename(downloaded) === currentName || !versionedAppImageName(currentName);
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
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  // The background check's waits, for the tests.
  retryDelaysMs = AFTER_STARTUP_RETRY_MS;
  recheckMs = RECHECK_MS;
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
    private readonly fetchLatest: LatestVersionFetcher = (channel) => fetchNewestReleaseVersion(channel),
    private readonly startupDelayMs = STARTUP_CHECK_DELAY_MS,
    private readonly host: InstallHost | null = null,
    // Read at every check, so a change in Settings applies to the next one.
    private readonly channel: () => UpdateChannel = () => "stable",
  ) {}

  private assetFor(version: string): string {
    if (!this.host || this.canSelfUpdate()) return "";
    const prefix = this.renamedFlatpak() === "stay" ? LEGACY_PACKAGE_NAME : PACKAGE_NAME;
    return packageAssetName(version, this.kind, this.host.platform, this.host.arch, this.host.format, prefix);
  }

  // A flatpak installed under the id from before the rename. Started from
  // the desktop it offers the renamed app as its update, at this version or
  // a newer one, and installing that moves its data across (index.ts hands
  // over through flatpakMoveCommand). Started by Steam it keeps updating in
  // place under its own id: moving would leave the library's shortcut on an
  // app that is gone, and closing Steam to repoint it would close this app.
  private renamedFlatpak(): "move" | "stay" | "" {
    if (this.kind !== "flatpak" || this.host?.flatpak?.id !== LEGACY_APP_ID) return "";
    return this.host.launchedBySteam ? "stay" : "move";
  }

  // Is the renamed app installed on the host already? Then the move needs
  // no download.
  private async renamedInstalled(): Promise<boolean> {
    const host = this.host;
    if (!host || !(await host.has("flatpak-spawn"))) return false;
    return (await host.run("flatpak-spawn", ["--host", "flatpak", "info", APP_ID])).code === 0;
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
    const channel = this.channel();
    return {
      current: this.currentVersion,
      latest: latest || this.currentVersion,
      available,
      canSelfUpdate: this.canSelfUpdate(),
      canDownload: available && Boolean(this.assetFor(latest)),
      instruction: INSTRUCTIONS[this.kind],
      // "Latest" on GitHub is the stable release, so a beta links to its own page.
      releasesUrl: channel === "beta" && available ? `https://github.com/${REPO}/releases/tag/v${latest}` : RELEASES_URL,
      channel,
      ...(available && this.renamedFlatpak() === "move" ? { renamed: true } : {}),
    };
  }

  // The player switched channels: what the last check found may now be
  // wrong either way, so it is dropped until the next check.
  channelChanged(): void {
    this.found = null;
    if (this.state.state === "available") this.setProgress({ state: "idle", latest: "", status: null });
  }

  // electron-updater's feed for this check's channel. With prereleases
  // allowed and no channel name it reads the newest release of either kind
  // (its latest.yml: versions carry no "-beta" suffix), and it never offers
  // an older version, so a fix to the stable line published after a newer
  // beta is passed over.
  private async feed(): Promise<AppUpdater> {
    const updater = await this.load();
    updater.allowPrerelease = this.channel() === "beta";
    return updater;
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
  // An install that updates from a release file is only offered a version
  // whose release has that file (releaseHasAsset); the download itself
  // skips that ask, since its checksum lookup refuses a missing file anyway.
  private async checkGitHub(askForAsset = true): Promise<UpdateStatus> {
    const latest = await this.fetchLatest(this.channel());
    const newer = Boolean(latest) && isNewerVersion(latest, this.currentVersion);
    if (this.renamedFlatpak() === "move") {
      // The renamed app is the update even at this same version, and one
      // installed already (from the website, say) needs no release file.
      const version = newer ? latest : this.currentVersion;
      if (await this.renamedInstalled()) return this.statusOf(version, true);
      const asset = askForAsset ? this.assetFor(version) : "";
      if (asset && this.host && !(await releaseHasAsset(this.host.fetchImpl ?? fetch, version, asset))) {
        return this.statusOf(this.currentVersion, false);
      }
      return this.statusOf(version, true);
    }
    const asset = newer && askForAsset ? this.assetFor(latest) : "";
    if (asset && this.host && !(await releaseHasAsset(this.host.fetchImpl ?? fetch, latest, asset))) {
      return this.statusOf(this.currentVersion, false);
    }
    return this.statusOf(latest, newer);
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    // A dev run has no app-update.yml and nothing meaningful to compare.
    if (this.kind === "dev") return this.statusOf(this.currentVersion, false);
    if (!this.canSelfUpdate()) return this.checkGitHub();
    const updater = await this.feed();
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

  private note(line: string): void {
    try {
      this.host?.log?.(line);
    } catch {
      // A log that cannot be written is no reason to fail an update.
    }
  }

  private failed(err: unknown): void {
    this.note(`Update to ${this.state.latest || "the latest version"} failed: ${reason(err)}`);
    if (this.state.state === "downloading" || this.state.state === "installing" || this.state.state === "ready") {
      this.setProgress({ state: "error", error: reason(err) });
    }
  }

  // The feed route, for the kinds electron-updater knows how to fetch:
  // re-check first, since it only downloads what its own last check found,
  // and a stale renderer state must not be trusted.
  private async downloadFromFeed(): Promise<{ updater: AppUpdater; version: string; files: string[] }> {
    const updater = await this.feed();
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
    if (code !== 0) {
      this.note(`pkexec ${args.join(" ")} exited ${code}:\n${stderr.trim()}`);
      throw new Error(`The package manager could not install version ${version}${lastLine(stderr)}`);
    }
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
  // aside, the new one takes its place under its own name, and the relaunch
  // starts it from there. Its own name, because a bundle named for the
  // product before a rename (Open Dungeon Master.app) would otherwise keep
  // that name in Applications forever. A copy Gatekeeper runs from a read-only random path (never moved
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
    let target = bundle;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      const { code, stderr } = await host.run("ditto", ["-x", "-k", file, staging]);
      if (code !== 0) throw new Error(`Unpacking version ${version} failed${lastLine(stderr)}`);
      const unpacked = (await readdir(staging)).find((entry) => entry.endsWith(".app"));
      if (!unpacked) throw new Error(`The download of version ${version} did not contain an app.`);
      const fresh = pathModule.join(staging, unpacked);
      target = pathModule.join(parent, unpacked);
      if (elevated) await this.moveBundleAsAdmin(fresh, bundle, target, version);
      else await this.moveBundle(fresh, bundle, target);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.discard(file);
    this.installed(version);
    // A renamed bundle's program carries the new name too (electron-builder
    // names it after the bundle), so it is started by path.
    const renamed = target !== bundle;
    const program = renamed ? pathModule.basename(target, ".app") : pathModule.basename(host.execPath);
    host.relaunch(adrift || renamed ? pathModule.join(target, "Contents", "MacOS", program) : undefined);
  }

  // The old bundle (when there is one) steps aside and comes back if the
  // new one cannot take its place. A target under another name (the bundle
  // was renamed) that is already there, a copy installed by hand, steps
  // aside the same way.
  private async moveBundle(fresh: string, bundle: string, target: string): Promise<void> {
    const { rename, rm } = await import("node:fs/promises");
    const retired = `${bundle}.old`;
    const displaced = `${target}.old`;
    const setAside = async (from: string, to: string): Promise<boolean> => {
      await rm(to, { recursive: true, force: true });
      try {
        await rename(from, to);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return false;
      }
    };
    const hadOld = await setAside(bundle, retired);
    let hadTarget = false;
    try {
      if (target !== bundle) hadTarget = await setAside(target, displaced);
      await rename(fresh, target);
    } catch (err) {
      if (hadTarget) await rename(displaced, target).catch(() => undefined);
      if (hadOld) await rename(retired, bundle).catch(() => undefined);
      throw err;
    }
    await rm(retired, { recursive: true, force: true }).catch(() => undefined);
    if (hadTarget) await rm(displaced, { recursive: true, force: true }).catch(() => undefined);
  }

  // The same steps as one shell command run by osascript with
  // administrator privileges, which puts up the Mac's own password prompt.
  // Under a new name, the bundle's old copy and anything already at the
  // target step aside, and both come back if the move fails. With the same
  // name the target is the bundle itself, already moved aside.
  private async moveBundleAsAdmin(fresh: string, bundle: string, target: string, version: string): Promise<void> {
    const b = shellQuote(bundle);
    const r = shellQuote(`${bundle}.old`);
    const t = shellQuote(target);
    const d = shellQuote(`${target}.old`);
    const f = shellQuote(fresh);
    const script =
      `rm -rf ${r} ${d} && { [ ! -e ${b} ] || mv ${b} ${r}; } && { [ ! -e ${t} ] || mv ${t} ${d}; } && ` +
      `{ mv ${f} ${t} || { [ ! -e ${d} ] || mv ${d} ${t}; [ ! -e ${r} ] || mv ${r} ${b}; exit 1; }; } && rm -rf ${r} ${d}`;
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
    if (this.renamedFlatpak() === "move") this.moving();
    else this.installed(version);
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
    const status = await this.checkGitHub(false);
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
      const expected = await releaseChecksum(fetcher, status.latest, asset);
      stillAlive();
      const res = await fetcher(`https://github.com/${REPO}/releases/download/v${status.latest}/${asset}`, {
        headers: { "User-Agent": "open-game-master-client" },
        signal: idle.signal,
      });
      if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status} for ${asset}.`);
      const total = Number(res.headers.get("content-length")) || 0;
      if (total > MAX_PACKAGE_BYTES) throw new Error(`${asset} is larger than any release package.`);
      const out = createWriteStream(partial);
      const hash = createHash(expected.algorithm);
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
      if (hash.digest("hex") !== expected.hex) {
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
    if (this.renamedFlatpak() === "move" && (await this.renamedInstalled())) {
      this.moving();
      this.host!.relaunch();
      return;
    }
    return this.downloadPackage();
  }

  private moving(): void {
    this.setProgress({ state: "ready", percent: 100, message: "Open Game Master is installed. Moving your servers and worlds into it..." });
  }

  // A quiet background check once the page can hear the answer, then again
  // every few hours while the app stays open; failures stay silent because
  // the player did not ask, but are retried (a minute, five, fifteen) and
  // logged instead of dropped, since a launch on a network that is not up
  // yet, or a GitHub that says "not now", otherwise meant no notice until
  // the next launch. The renderer hears about a hit via the progress event,
  // which carries the full status so it can offer the right button without
  // asking again, and a page that loads later still finds it through
  // lastFound().
  checkOnStartup(pageReady: Promise<void> = Promise.resolve()): void {
    if (this.startupChecked || this.kind === "dev") return;
    this.startupChecked = true;
    void pageReady
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, this.startupDelayMs)))
      .then(() => this.backgroundCheck(0));
  }

  private async backgroundCheck(attempt: number): Promise<void> {
    // An install under way is left alone: electron-updater reports a failed
    // check on the same "error" event as a failed download, so a recheck
    // that hit a network blip mid-download marked that download failed.
    if (this.state.state === "downloading" || this.state.state === "installing" || this.state.state === "ready") {
      this.checkAgainIn(this.recheckMs, 0);
      return;
    }
    try {
      const status = await this.checkForUpdates();
      // An install under way owns the progress line.
      if (status.available && (this.state.state === "idle" || this.state.state === "available")) {
        this.found = status;
        this.setProgress({ state: "available", latest: status.latest, status });
      }
      this.checkAgainIn(this.recheckMs, 0);
    } catch (err) {
      this.note(`Background update check failed: ${reason(err)}`);
      const retry = this.retryDelaysMs[attempt];
      this.checkAgainIn(retry ?? this.recheckMs, retry === undefined ? 0 : attempt + 1);
    }
  }

  private checkAgainIn(ms: number, attempt: number): void {
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      void this.backgroundCheck(attempt);
    }, ms);
    // Never what keeps the app (or a test run) alive.
    this.recheckTimer.unref?.();
  }
}
