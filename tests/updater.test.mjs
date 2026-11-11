import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  detectInstallKind,
  fetchLatestReleaseVersion,
  fetchNewestReleaseVersion,
  isNewerVersion,
  packageAssetName,
  Updater,
  versionFromTag,
} from "../dist/main/updater.js";

const LINUX_OPT = "/opt/open-game-master/open-game-master-client";
const LINUX_USR = "/usr/lib/open-game-master/open-game-master-client";
const LINUX_HOME = "/home/kaleb/apps/odm/open-game-master-client";
const WIN_EXE = "C:\\Users\\kaleb\\AppData\\Local\\Programs\\odm\\odm.exe";

test("an unpackaged run is dev no matter what the environment claims", () => {
  assert.equal(detectInstallKind({ APPIMAGE: "/x.AppImage" }, LINUX_OPT, "linux", false), "dev");
  assert.equal(detectInstallKind({}, WIN_EXE, "win32", false), "dev");
});

test("linux sandbox and bundle markers win over the install path", () => {
  // AppImage mounts under /tmp but the env var is the real signal.
  assert.equal(
    detectInstallKind({ APPIMAGE: "/home/kaleb/odm.AppImage" }, "/tmp/.mount_odm/odm", "linux", true),
    "appimage",
  );
  // Flatpak and snap expose the binary under /usr inside the sandbox; the
  // env markers must take precedence over the "managed" path check.
  assert.equal(detectInstallKind({ FLATPAK_ID: "com.odm.Client" }, LINUX_USR, "linux", true), "flatpak");
  assert.equal(detectInstallKind({ SNAP: "/snap/odm/1" }, LINUX_USR, "linux", true), "snap");
});

test("package-manager territory (/usr, /opt) reads as managed", () => {
  assert.equal(detectInstallKind({}, LINUX_OPT, "linux", true), "managed");
  assert.equal(detectInstallKind({}, LINUX_USR, "linux", true), "managed");
});

test("a linux binary outside /usr and /opt is a portable unpack", () => {
  assert.equal(detectInstallKind({}, LINUX_HOME, "linux", true), "portable");
  // /usr/local is never a package manager's.
  assert.equal(detectInstallKind({}, "/usr/local/odm/open-game-master-client", "linux", true), "portable");
});

test("the rpm and deb builds name themselves through package-type", async () => {
  const { packageFormatOf } = await import("../dist/main/updater.js");
  const RPM_EXEC = "/opt/Open Game Master/open-game-master-client";
  assert.equal(detectInstallKind({}, RPM_EXEC, "linux", true, "rpm"), "managed");
  // Moved somewhere unusual, the package still owns it.
  assert.equal(detectInstallKind({}, LINUX_HOME, "linux", true, "deb"), "managed");
  // The sandbox markers still win.
  assert.equal(detectInstallKind({ APPIMAGE: "/x.AppImage" }, RPM_EXEC, "linux", true, "rpm"), "appimage");
  assert.equal(packageFormatOf("rpm\n"), "rpm");
  assert.equal(packageFormatOf("deb"), "deb");
  assert.equal(packageFormatOf("pacman"), "");
  assert.equal(packageFormatOf(""), "");
});

test("a tar.gz unpacked under /opt is not mistaken for an rpm", async () => {
  // No package-type: whatever owns /opt (the AUR package) is left to update
  // it, instead of installing the rpm beside it and restarting the old copy.
  const { Updater, packageFormatOf } = await import("../dist/main/updater.js");
  const { host } = fakeHost({ format: packageFormatOf(""), execPath: "/opt/odm/open-game-master-client" });
  const kind = detectInstallKind({}, host.execPath, "linux", true, "");
  assert.equal(kind, "managed");
  const status = await new Updater(kind, "0.12.0", async () => "0.12.1", 0, host).checkForUpdates();
  assert.equal(status.canDownload, false);
  assert.match(status.instruction, /package manager/);
});

test("flatpak-info says which installation holds the app", async () => {
  const { flatpakIsSystemWide } = await import("../dist/main/updater.js");
  const info = (appPath) => `[Application]\nname=com.opengamemaster.client\n\n[Instance]\napp-path=${appPath}\n`;
  assert.equal(flatpakIsSystemWide(info("/var/lib/flatpak/app/com.opengamemaster.client/x86_64/master/abc/files")), true);
  assert.equal(flatpakIsSystemWide(info("/home/kaleb/.local/share/flatpak/app/com.opengamemaster.client/x86_64/master/abc/files")), false);
  assert.equal(flatpakIsSystemWide(""), false);
  // An installation flatpak was pointed elsewhere for counts as the player's.
  assert.equal(flatpakIsSystemWide(info("/tmp/odm-flatpak-user/app/com.opengamemaster.client/x86_64/master/abc/files")), false);
});

test("windows splits on the portable marker, defaulting to nsis", () => {
  assert.equal(
    detectInstallKind({ PORTABLE_EXECUTABLE_DIR: "C:\\odm" }, WIN_EXE, "win32", true),
    "portable",
  );
  assert.equal(detectInstallKind({}, WIN_EXE, "win32", true), "nsis");
});

test("macOS is its own kind regardless of path", () => {
  assert.equal(detectInstallKind({}, "/Applications/ODM.app/Contents/MacOS/ODM", "darwin", true), "mac");
});

test("version compare handles unequal lengths and non-numeric junk", () => {
  assert.equal(isNewerVersion("0.2.0", "0.1.9"), true);
  assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), false);
  assert.equal(isNewerVersion("0.1.0.1", "0.1.0"), true);
  assert.equal(isNewerVersion("garbage", "0.1.0"), false);
});

test("release tags read as bare versions, junk as nothing", () => {
  assert.equal(versionFromTag("v0.9.0"), "0.9.0");
  assert.equal(versionFromTag("0.9.0"), "0.9.0");
  assert.equal(versionFromTag("nightly"), "");
  assert.equal(versionFromTag(undefined), "");
});

test("an install that cannot self-update still learns about a newer GitHub release", async () => {
  const updater = new Updater("portable", "0.7.4", async () => "0.9.0");
  const status = await updater.checkForUpdates();
  assert.equal(status.available, true);
  assert.equal(status.latest, "0.9.0");
  assert.equal(status.canSelfUpdate, false);
  assert.match(status.instruction, /releases page/);
  assert.match(status.releasesUrl, /github\.com\/.*\/releases\/latest$/);
});

test("matching or missing releases read as up to date", async () => {
  const same = await new Updater("managed", "0.9.0", async () => "0.9.0").checkForUpdates();
  assert.equal(same.available, false);
  const none = await new Updater("managed", "0.9.0", async () => "").checkForUpdates();
  assert.equal(none.available, false);
  assert.equal(none.latest, "0.9.0");
});

test("the startup check hands the renderer the full status", async () => {
  const updater = new Updater("flatpak", "0.8.1", async () => "0.9.0", 0);
  const heard = new Promise((resolve) => updater.onStatus(() => resolve(updater.progress())));
  updater.checkOnStartup();
  const progress = await heard;
  assert.equal(progress.state, "available");
  assert.equal(progress.latest, "0.9.0");
  assert.equal(progress.status.canSelfUpdate, false);
  assert.match(progress.status.instruction, /flatpak bundle/);
});

test("fetchLatestReleaseVersion reads the tag and treats 404 as no release", async () => {
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "v0.9.0" }) });
  assert.equal(await fetchLatestReleaseVersion(ok), "0.9.0");
  const missing = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.equal(await fetchLatestReleaseVersion(missing), "");
  const broken = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => fetchLatestReleaseVersion(broken), /503/);
});

test("the beta channel takes the highest version of any published release", async () => {
  let asked = "";
  const list = async (url) => {
    asked = String(url);
    return {
      ok: true,
      status: 200,
      json: async () => [
        // A fix to the stable line, published after the newer beta.
        { tag_name: "v0.20.7", prerelease: false },
        { tag_name: "v0.21.2", prerelease: true },
        { tag_name: "v0.21.3", draft: true },
        { tag_name: "v0.20.6", prerelease: false },
      ],
    };
  };
  assert.equal(await fetchNewestReleaseVersion("beta", list), "0.21.2");
  assert.match(asked, /\/releases\?per_page=\d+$/);
  await fetchNewestReleaseVersion("stable", list);
  assert.match(asked, /\/releases\/latest$/, "stable asks for GitHub's latest release, which is never a prerelease");
  const broken = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => fetchNewestReleaseVersion("beta", broken), /503/);
});

test("the updater asks for the channel the player chose, at every check", async () => {
  let channel = "stable";
  const asked = [];
  const fetchLatest = async (wanted) => {
    asked.push(wanted);
    return wanted === "beta" ? "0.21.2" : "0.20.6";
  };
  const updater = new Updater("portable", "0.20.6", fetchLatest, 0, null, () => channel);
  const stable = await updater.checkForUpdates();
  assert.deepEqual([stable.available, stable.channel], [false, "stable"]);
  channel = "beta";
  const beta = await updater.checkForUpdates();
  assert.deepEqual([beta.available, beta.latest, beta.channel], [true, "0.21.2", "beta"]);
  assert.match(beta.releasesUrl, /\/releases\/tag\/v0\.21\.2$/, "a beta links to its own release, not GitHub's latest");
  assert.deepEqual(asked, ["stable", "beta"]);
});

test("switching channels drops what the last check found", async () => {
  const updater = new Updater("flatpak", "0.8.1", async () => "0.9.0", 0);
  const heard = new Promise((resolve) => updater.onStatus(() => resolve(updater.progress())));
  updater.checkOnStartup();
  await heard;
  assert.equal(updater.lastFound()?.latest, "0.9.0");
  updater.channelChanged();
  assert.equal(updater.lastFound(), null);
  assert.equal(updater.progress().state, "idle");
});

const PACKAGE = new Uint8Array([1, 2, 3, 4]);

// The release as GitHub's API lists it: every package these tests download,
// each with the digest of `bytes`.
function releaseListing(version, bytes) {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const names = new Set();
  for (const [kind, platform, arch, format] of [
    ["managed", "linux", "x64", "rpm"],
    ["managed", "linux", "x64", "deb"],
    ["portable", "linux", "x64", ""],
    ["flatpak", "linux", "x64", "rpm"],
    ["mac", "darwin", "arm64", ""],
    ["mac", "darwin", "x64", ""],
  ]) {
    names.add(packageAssetName(version, kind, platform, arch, format));
  }
  return { assets: [...names].map((name) => ({ name, digest })) };
}

// GitHub for the updater: the release listing from the API, the package
// from the download host. `listed` is what the listing vouches for.
function githubFetch(file = PACKAGE, listed = PACKAGE) {
  return async (url) => {
    const tag = /\/releases\/tags\/v([^/]+)$/.exec(String(url));
    if (tag) return Response.json(releaseListing(tag[1], listed));
    return new Response(file, { status: 200, headers: { "content-length": String(file.byteLength) } });
  };
}

// A stand-in for the machine: records what the updater asked it to do.
function fakeHost(overrides = {}) {
  const log = { opened: [], revealed: [], ran: [], relaunched: [] };
  const host = {
    format: "rpm",
    platform: "linux",
    arch: "x64",
    execPath: "/opt/Open Game Master/open-game-master-client",
    appImagePath: "",
    downloadsDir: () => "",
    open: async (file) => void log.opened.push(file),
    reveal: (file) => void log.revealed.push(file),
    has: async () => true,
    writable: async () => true,
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      return { code: 0, stderr: "" };
    },
    relaunch: (execPath) => void log.relaunched.push(execPath ?? ""),
    fetchImpl: githubFetch(),
    ...overrides,
  };
  return { host, log };
}

// The host script goes on by itself once it has said "up"
// (afterThisFlatpak); its last act is a `flatpak run`.
async function untilRun(calls) {
  const fsp = await import("node:fs/promises");
  for (let waited = 0; waited < 15_000; waited += 100) {
    const lines = (await fsp.readFile(calls, "utf8").catch(() => "")).trim().split("\n");
    if (lines.some((line) => line.startsWith("run "))) return lines;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the host script never ran the app");
}

async function tempFolder() {
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  return fsp.mkdtemp(path.join(os.tmpdir(), "odm-update-"));
}

test("packageAssetName picks the one release file an install updates from", async () => {
  const { packageAssetName } = await import("../dist/main/updater.js");
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "x64", "rpm"), "open-game-master-client-0.12.1-x86_64.rpm");
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "x64", "deb"), "open-game-master-client-0.12.1-amd64.deb");
  assert.equal(packageAssetName("0.12.1", "portable", "linux", "x64", ""), "open-game-master-client-0.12.1-x64.tar.gz");
  assert.equal(packageAssetName("0.12.1", "flatpak", "linux", "x64", "rpm"), "open-game-master-client-0.12.1-x86_64.flatpak");
  // The zip unpacks into a bundle the app can swap in; the dmg would need mounting.
  assert.equal(packageAssetName("0.12.1", "mac", "darwin", "arm64", ""), "open-game-master-client-0.12.1-arm64-mac.zip");
  assert.equal(packageAssetName("0.12.1", "mac", "darwin", "x64", ""), "open-game-master-client-0.12.1-x64-mac.zip");
  // No package manager we know, a store install, another architecture: the app says where to go instead.
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "x64", ""), "");
  assert.equal(packageAssetName("0.12.1", "snap", "linux", "x64", "rpm"), "");
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "arm64", "deb"), "");
  assert.equal(packageAssetName("0.12.1", "portable", "win32", "x64", ""), "");
});

test("an rpm install downloads the package, installs it through pkexec and restarts", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const asked = [];
  const { host, log } = fakeHost({
    downloadsDir: () => folder,
    // dnf is there, so it wins over rpm.
    has: async (command) => ["pkexec", "dnf", "rpm"].includes(command),
    fetchImpl: async (url) => {
      asked.push(String(url));
      return githubFetch()(url);
    },
  });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  const status = await updater.checkForUpdates();
  assert.equal(status.available, true);
  assert.equal(status.canSelfUpdate, false);
  assert.equal(status.canDownload, true);
  await updater.downloadAndInstall();
  const file = path.join(folder, "open-game-master-client-0.12.1-x86_64.rpm");
  assert.deepEqual(asked, [
    // The check: does this release have an rpm at all, asked of the
    // download link rather than the rate-limited API.
    "https://github.com/Lebbitheplow/open-game-master-client/releases/download/v0.12.1/open-game-master-client-0.12.1-x86_64.rpm",
    // The download: the rpm's checksum, then the rpm.
    "https://api.github.com/repos/Lebbitheplow/open-game-master-client/releases/tags/v0.12.1",
    "https://github.com/Lebbitheplow/open-game-master-client/releases/download/v0.12.1/open-game-master-client-0.12.1-x86_64.rpm",
  ]);
  assert.deepEqual(log.ran, [["pkexec", "dnf", "install", "-y", file]]);
  assert.deepEqual(log.relaunched, [""]);
  assert.deepEqual(log.opened, []);
  // The package is gone from Downloads once it is installed.
  assert.deepEqual(await fsp.readdir(folder), []);
  assert.equal(updater.progress().state, "ready");
  assert.match(updater.progress().message, /Restarting/);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a deb install goes through apt-get without prompts", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const folder = await tempFolder();
  const { host, log } = fakeHost({
    format: "deb",
    downloadsDir: () => folder,
    has: async (command) => ["pkexec", "apt-get", "dpkg"].includes(command),
  });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  assert.equal(log.ran.length, 1);
  assert.deepEqual(log.ran[0].slice(0, 5), ["pkexec", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install"]);
  assert.deepEqual(log.relaunched, [""]);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a closed password prompt keeps the package and says so; a failed install quotes the reason", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const folder = await tempFolder();
  let answer = { code: 126, stderr: "" };
  const { host, log } = fakeHost({
    downloadsDir: () => folder,
    run: async () => answer,
  });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  await assert.rejects(() => updater.downloadAndInstall(), /cancelled/);
  assert.equal(updater.progress().state, "error");
  assert.equal((await fsp.readdir(folder)).length, 1);
  assert.deepEqual(log.relaunched, []);
  answer = { code: 1, stderr: "Error: Transaction failed\nnothing provides libfoo\n" };
  await assert.rejects(() => updater.downloadAndInstall(), /nothing provides libfoo/);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("without pkexec the package is handed to the system's installer", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const { host, log } = fakeHost({ downloadsDir: () => folder, has: async (command) => command === "dnf" });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  assert.deepEqual(log.opened, [path.join(folder, "open-game-master-client-0.12.1-x86_64.rpm")]);
  assert.deepEqual(log.ran, []);
  assert.deepEqual(log.relaunched, []);
  assert.match(updater.progress().message, /installer/);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a tar.gz install unpacks over itself and restarts, or reveals the archive when it cannot", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const { host, log } = fakeHost({
    format: "",
    execPath: "/home/kaleb/apps/odm/open-game-master-client",
    downloadsDir: () => folder,
  });
  const updater = new Updater("portable", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  const file = path.join(folder, "open-game-master-client-0.12.1-x64.tar.gz");
  assert.deepEqual(log.ran, [["tar", "-xzf", file, "-C", "/home/kaleb/apps/odm", "--strip-components=1"]]);
  assert.deepEqual(log.relaunched, [""]);
  assert.equal(updater.progress().state, "ready");

  // Not writable and no pkexec to lean on: the archive is shown instead.
  const readOnly = fakeHost({
    format: "",
    execPath: host.execPath,
    downloadsDir: () => folder,
    writable: async () => false,
    has: async (command) => command === "tar",
  });
  const stuck = new Updater("portable", "0.12.0", async () => "0.12.1", 0, readOnly.host);
  await stuck.downloadAndInstall();
  assert.deepEqual(readOnly.log.ran, []);
  assert.deepEqual(readOnly.log.revealed, [file]);
  assert.match(stuck.progress().message, /Unpack it/);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a tar.gz install in a folder only root can write goes through pkexec", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const { host, log } = fakeHost({
    format: "",
    execPath: "/usr/local/odm/open-game-master-client",
    downloadsDir: () => folder,
    writable: async () => false,
  });
  const updater = new Updater("portable", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  const file = path.join(folder, "open-game-master-client-0.12.1-x64.tar.gz");
  assert.deepEqual(log.ran, [
    ["pkexec", "tar", "-xzf", file, "-C", "/usr/local/odm", "--strip-components=1", "--no-same-owner"],
  ]);
  assert.deepEqual(log.revealed, []);
  assert.deepEqual(log.relaunched, [""]);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a Mac install swaps the bundle from the release zip", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const apps = path.join(folder, "Applications");
  const bundle = path.join(apps, "Open Game Master.app");
  await fsp.mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  await fsp.writeFile(path.join(bundle, "Contents", "MacOS", "Open Game Master"), "old");
  const { host, log } = fakeHost({
    platform: "darwin",
    arch: "arm64",
    format: "",
    execPath: path.join(bundle, "Contents", "MacOS", "Open Game Master"),
    downloadsDir: () => folder,
    // ditto stands in: it drops a new bundle into the staging folder.
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      const staging = args[args.length - 1];
      await fsp.mkdir(path.join(staging, "Open Game Master.app", "Contents", "MacOS"), { recursive: true });
      await fsp.writeFile(path.join(staging, "Open Game Master.app", "Contents", "MacOS", "Open Game Master"), "new");
      return { code: 0, stderr: "" };
    },
  });
  const updater = new Updater("mac", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  const zip = path.join(folder, "open-game-master-client-0.12.1-arm64-mac.zip");
  assert.equal(log.ran.length, 1);
  assert.deepEqual(log.ran[0].slice(0, 4), ["ditto", "-x", "-k", zip]);
  assert.equal(await fsp.readFile(path.join(bundle, "Contents", "MacOS", "Open Game Master"), "utf8"), "new");
  // No staging folder or retired bundle left beside it.
  assert.deepEqual(await fsp.readdir(apps), ["Open Game Master.app"]);
  assert.deepEqual(log.relaunched, [""]);
  await fsp.rm(folder, { recursive: true, force: true });
});

// A bundle named for the product before the rename, and the zip of a build
// named after it. Returns the folders and a ditto stand-in.
async function renamedMacSetup(fsp, path, { handInstalled = false } = {}) {
  const folder = await tempFolder();
  const apps = path.join(folder, "Applications");
  const oldExe = path.join(apps, "Open Dungeon Master.app", "Contents", "MacOS", "Open Dungeon Master");
  await fsp.mkdir(path.dirname(oldExe), { recursive: true });
  await fsp.writeFile(oldExe, "old");
  if (handInstalled) {
    const copy = path.join(apps, "Open Game Master.app", "Contents", "MacOS", "Open Game Master");
    await fsp.mkdir(path.dirname(copy), { recursive: true });
    await fsp.writeFile(copy, "by hand");
  }
  const newExe = path.join(apps, "Open Game Master.app", "Contents", "MacOS", "Open Game Master");
  const ditto = async (args) => {
    const staging = args[args.length - 1];
    await fsp.mkdir(path.join(staging, "Open Game Master.app", "Contents", "MacOS"), { recursive: true });
    await fsp.writeFile(path.join(staging, "Open Game Master.app", "Contents", "MacOS", "Open Game Master"), "new");
  };
  return { folder, apps, oldExe, newExe, ditto };
}

test("a Mac install from before the rename lands under the new name and starts from there", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  for (const handInstalled of [false, true]) {
    const { folder, apps, oldExe, newExe, ditto } = await renamedMacSetup(fsp, path, { handInstalled });
    const { host, log } = fakeHost({
      platform: "darwin",
      arch: "arm64",
      format: "",
      execPath: oldExe,
      downloadsDir: () => folder,
      run: async (command, args) => {
        log.ran.push([command, ...args]);
        await ditto(args);
        return { code: 0, stderr: "" };
      },
    });
    const updater = new Updater("mac", "0.21.3", async () => "0.22.0", 0, host);
    await updater.downloadAndInstall();
    assert.equal(await fsp.readFile(newExe, "utf8"), "new", `hand installed: ${handInstalled}`);
    // The old bundle, the hand-installed copy and the staging folder are gone.
    assert.deepEqual(await fsp.readdir(apps), ["Open Game Master.app"], `hand installed: ${handInstalled}`);
    assert.deepEqual(log.relaunched, [newExe]);
    await fsp.rm(folder, { recursive: true, force: true });
  }
});

test("a Mac install from before the rename takes its new name behind the password prompt too", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { folder, apps, oldExe, newExe, ditto } = await renamedMacSetup(fsp, path);
  const downloads = path.join(folder, "Downloads");
  await fsp.mkdir(downloads, { recursive: true });
  const { host, log } = fakeHost({
    platform: "darwin",
    arch: "x64",
    format: "",
    execPath: oldExe,
    downloadsDir: () => downloads,
    writable: async (dir) => dir !== apps,
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      if (command === "ditto") {
        await ditto(args);
        return { code: 0, stderr: "" };
      }
      return new Promise((resolve) => {
        execFile("sh", ["-c", adminScript(args)], (err, _out, stderr) => resolve({ code: err ? 1 : 0, stderr }));
      });
    },
  });
  const updater = new Updater("mac", "0.21.3", async () => "0.22.0", 0, host);
  await updater.downloadAndInstall();
  assert.deepEqual(log.ran.map((call) => call[0]), ["ditto", "osascript"]);
  assert.equal(await fsp.readFile(newExe, "utf8"), "new");
  assert.deepEqual(await fsp.readdir(apps), ["Open Game Master.app"]);
  assert.deepEqual(log.relaunched, [newExe]);
  await fsp.rm(folder, { recursive: true, force: true });
});

// The shell command inside an osascript "with administrator privileges"
// call, unescaped from its AppleScript string.
function adminScript(args) {
  const match = /^do shell script "(.*)" with administrator privileges$/s.exec(args[1]);
  assert.ok(match, args[1]);
  return match[1].replace(/\\(["\\])/g, "$1");
}

test("a Mac install the account cannot write moves the bundle behind the password prompt", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const folder = await tempFolder();
  // A quote in the path, to prove the shell and AppleScript quoting.
  const apps = path.join(folder, "Kaleb's \"Apps\"");
  const downloads = path.join(folder, "Downloads");
  await fsp.mkdir(downloads, { recursive: true });
  const bundle = path.join(apps, "Open Game Master.app");
  const exe = path.join(bundle, "Contents", "MacOS", "Open Game Master");
  await fsp.mkdir(path.dirname(exe), { recursive: true });
  await fsp.writeFile(exe, "old");
  const { host, log } = fakeHost({
    platform: "darwin",
    arch: "x64",
    format: "",
    execPath: exe,
    downloadsDir: () => downloads,
    writable: async (dir) => dir !== apps,
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      if (command === "ditto") {
        const staging = args[args.length - 1];
        await fsp.mkdir(path.join(staging, "Open Game Master.app", "Contents", "MacOS"), { recursive: true });
        await fsp.writeFile(path.join(staging, "Open Game Master.app", "Contents", "MacOS", "Open Game Master"), "new");
        return { code: 0, stderr: "" };
      }
      // osascript stands in by running the shell command it was handed.
      return new Promise((resolve) => {
        execFile("sh", ["-c", adminScript(args)], (err, _out, stderr) => resolve({ code: err ? 1 : 0, stderr }));
      });
    },
  });
  const updater = new Updater("mac", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  assert.deepEqual(log.ran.map((call) => call[0]), ["ditto", "osascript"]);
  // Unpacked next to the download, where this account can write.
  assert.equal(path.dirname(log.ran[0][log.ran[0].length - 1]), downloads);
  assert.equal(await fsp.readFile(exe, "utf8"), "new");
  assert.deepEqual(await fsp.readdir(apps), ["Open Game Master.app"]);
  assert.deepEqual(await fsp.readdir(downloads), []);
  assert.deepEqual(log.relaunched, [""]);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a Mac copy run from where Gatekeeper put it is installed into Applications", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const folder = await tempFolder();
  const exe = "/private/var/folders/xy/T/AppTranslocation/1234/d/Open Game Master.app/Contents/MacOS/Open Game Master";
  const { host, log } = fakeHost({
    platform: "darwin",
    arch: "arm64",
    format: "",
    execPath: exe,
    downloadsDir: () => folder,
    // Neither the translocated copy nor /Applications (on this test box).
    writable: async (dir) => dir === folder,
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      if (command === "ditto") {
        await fsp.mkdir(`${args[args.length - 1]}/Open Game Master.app`, { recursive: true });
      }
      return { code: 0, stderr: "" };
    },
  });
  const updater = new Updater("mac", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  assert.equal(log.ran[1][0], "osascript");
  const script = adminScript(log.ran[1].slice(1));
  assert.match(script, /mv '[^']*\/Open Game Master\.app' '\/Applications\/Open Game Master\.app'/);
  assert.doesNotMatch(script, /AppTranslocation/);
  assert.deepEqual(log.relaunched, ["/Applications/Open Game Master.app/Contents/MacOS/Open Game Master"]);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a closed Mac password prompt keeps the old app and says so", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const folder = await tempFolder();
  const { host, log } = fakeHost({
    platform: "darwin",
    arch: "arm64",
    format: "",
    execPath: "/Applications/Open Game Master.app/Contents/MacOS/Open Game Master",
    downloadsDir: () => folder,
    writable: async (dir) => dir === folder,
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      if (command === "ditto") {
        await fsp.mkdir(`${args[args.length - 1]}/Open Game Master.app`, { recursive: true });
        return { code: 0, stderr: "" };
      }
      return { code: 1, stderr: "0:180: execution error: User canceled. (-128)\n" };
    },
  });
  const updater = new Updater("mac", "0.12.0", async () => "0.12.1", 0, host);
  await assert.rejects(() => updater.downloadAndInstall(), /cancelled/);
  assert.deepEqual(log.relaunched, []);
  // The zip stays for a manual install; the staging folder does not.
  assert.deepEqual(await fsp.readdir(folder), ["open-game-master-client-0.12.1-arm64-mac.zip"]);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a flatpak installs its bundle through the host's flatpak and restarts", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const { host, log } = fakeHost({
    format: "",
    downloadsDir: () => folder,
    flatpak: { id: "com.opengamemaster.client", system: true },
  });
  const updater = new Updater("flatpak", "0.12.0", async () => "0.12.1", 0, host);
  assert.equal((await updater.checkForUpdates()).canDownload, true);
  await updater.downloadAndInstall();
  const file = path.join(folder, "open-game-master-client-0.12.1-x86_64.flatpak");
  assert.deepEqual(log.ran, [
    ["flatpak-spawn", "--host", "true"],
    // -y, not --noninteractive: that would also refuse the password prompt.
    ["flatpak-spawn", "--host", "flatpak", "install", "--system", "-y", "--bundle", file],
  ]);
  assert.deepEqual(log.opened, []);
  assert.deepEqual(log.relaunched, [""]);
  assert.deepEqual(await fsp.readdir(folder), []);
  assert.equal(updater.progress().state, "ready");

  const user = fakeHost({ format: "", downloadsDir: () => folder, flatpak: { id: "com.opengamemaster.client", system: false } });
  await new Updater("flatpak", "0.12.0", async () => "0.12.1", 0, user.host).downloadAndInstall();
  assert.equal(user.log.ran[1][4], "--user");
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a flatpak that cannot reach the host hands its bundle to the software center", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const { host, log } = fakeHost({
    format: "",
    downloadsDir: () => folder,
    flatpak: { id: "com.opengamemaster.client", system: false },
    // A bundle from before the org.freedesktop.Flatpak permission.
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      return { code: 1, stderr: "Portal call failed" };
    },
  });
  const updater = new Updater("flatpak", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  assert.deepEqual(log.ran, [["flatpak-spawn", "--host", "true"]]);
  assert.deepEqual(log.opened, [path.join(folder, "open-game-master-client-0.12.1-x86_64.flatpak")]);
  assert.deepEqual(log.relaunched, []);
  assert.match(updater.progress().message, /software center/);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a failed flatpak install says why and keeps the bundle", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const folder = await tempFolder();
  const { host, log } = fakeHost({
    format: "",
    downloadsDir: () => folder,
    flatpak: { id: "com.opengamemaster.client", system: true },
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      return args[1] === "true" ? { code: 0, stderr: "" } : { code: 1, stderr: "error: Not authorized\n" };
    },
  });
  const updater = new Updater("flatpak", "0.12.0", async () => "0.12.1", 0, host);
  await assert.rejects(() => updater.downloadAndInstall(), /Not authorized/);
  assert.equal(updater.progress().state, "error");
  assert.equal((await fsp.readdir(folder)).length, 1);
  assert.deepEqual(log.relaunched, []);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("the flatpak relaunch waits for the old sandbox, then runs the app", async () => {
  // The host half of the command, run for real against a stand-in flatpak
  // that reports the instance twice before it is gone.
  const { flatpakRelaunchCommand } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const folder = await tempFolder();
  const calls = path.join(folder, "calls");
  await fsp.writeFile(
    path.join(folder, "flatpak"),
    [
      "#!/bin/sh",
      `echo "$*" >> '${calls}'`,
      'if [ "$1" = ps ]; then',
      `  n=$(grep -c '^ps' '${calls}')`,
      '  [ "$n" -le 2 ] && echo com.opengamemaster.client',
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  const [command, args] = flatpakRelaunchCommand("com.opengamemaster.client");
  assert.equal(command, "flatpak-spawn");
  assert.deepEqual(args.slice(0, 2), ["--host", "sh"]);
  const stdout = await new Promise((resolve, reject) => {
    execFile(args[1], args.slice(2), { env: { ...process.env, PATH: `${folder}:${process.env.PATH}` } }, (err, out) =>
      err ? reject(err) : resolve(out),
    );
  });
  assert.equal(stdout, "up\n");
  const lines = await untilRun(calls);
  assert.equal(lines.filter((line) => line.startsWith("ps")).length, 3);
  assert.equal(lines[lines.length - 1], "run com.opengamemaster.client");
  // A Steam Deck launch option rides along to the new run.
  const [, withFlag] = flatpakRelaunchCommand("com.opengamemaster.client", ["--steam-deck"]);
  await fsp.writeFile(calls, "");
  await new Promise((resolve, reject) => {
    execFile(withFlag[1], withFlag.slice(2), { env: { ...process.env, PATH: `${folder}:${process.env.PATH}` } }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
  const flagged = await untilRun(calls);
  assert.equal(flagged[flagged.length - 1], "run com.opengamemaster.client --steam-deck");
  await fsp.rm(folder, { recursive: true, force: true });
});

test("replaceAppImage keeps a renamed file's name and replaces a versioned one", async () => {
  const { replaceAppImage } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const renamed = path.join(folder, "odm.AppImage");
  await fsp.writeFile(renamed, "old");
  const fresh = path.join(folder, "pending", "open-game-master-client-0.12.1-x86_64.AppImage");
  await fsp.mkdir(path.dirname(fresh), { recursive: true });
  await fsp.writeFile(fresh, "new");
  assert.equal(await replaceAppImage(renamed, fresh), renamed);
  assert.equal(await fsp.readFile(renamed, "utf8"), "new");
  assert.equal(((await fsp.stat(renamed)).mode & 0o111) !== 0, true);

  const versioned = path.join(folder, "open-game-master-client-0.12.0-x86_64.AppImage");
  await fsp.writeFile(versioned, "old");
  await fsp.writeFile(fresh, "new");
  const destination = await replaceAppImage(versioned, fresh);
  assert.equal(destination, path.join(folder, "open-game-master-client-0.12.1-x86_64.AppImage"));
  assert.equal(await fsp.readFile(destination, "utf8"), "new");
  await assert.rejects(() => fsp.stat(versioned));
  await fsp.rm(folder, { recursive: true, force: true });
});

test("the startup check waits for the page and keeps its find for a late page", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0);
  let seen = null;
  updater.onStatus(() => {
    seen = updater.progress();
  });
  let pageReady;
  const ready = new Promise((resolve) => {
    pageReady = resolve;
  });
  updater.checkOnStartup(ready);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen, null);
  assert.equal(updater.lastFound(), null);
  pageReady();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.state, "available");
  assert.equal(updater.lastFound().latest, "0.12.1");
});

test("a package that does not hash to the release's checksum is never installed", async () => {
  const fsp = await import("node:fs/promises");
  const folder = await tempFolder();
  const { host, log } = fakeHost({
    format: "deb",
    downloadsDir: () => folder,
    has: async (command) => ["pkexec", "apt-get", "dpkg"].includes(command),
    // A real deb's worth of bytes from the download host, but not the ones
    // the release lists.
    fetchImpl: githubFetch(new Uint8Array([9, 9, 9, 9]), PACKAGE),
  });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  await assert.rejects(() => updater.downloadAndInstall(), /does not match the release's checksum/);
  assert.deepEqual(log.ran, []);
  assert.deepEqual(log.relaunched, []);
  assert.equal(updater.progress().state, "error");
  assert.deepEqual(await fsp.readdir(folder), []);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a release that lists no checksum for the package downloads nothing", async () => {
  const fsp = await import("node:fs/promises");
  const folder = await tempFolder();
  const asked = [];
  const { host, log } = fakeHost({
    format: "deb",
    downloadsDir: () => folder,
    fetchImpl: async (url) => {
      asked.push(String(url));
      return Response.json({ assets: [{ name: "open-game-master-client-0.12.1-amd64.deb", digest: null }] });
    },
  });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  await assert.rejects(() => updater.downloadAndInstall(), /lists no checksum/);
  assert.ok(asked.length > 0 && asked.every((url) => url.includes("/releases/tags/v0.12.1")), "only the listing was asked for");
  assert.deepEqual(log.ran, []);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a failed package download leaves no partial file and says why", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const folder = await tempFolder();
  const { host } = fakeHost({
    format: "deb",
    downloadsDir: () => folder,
    fetchImpl: async () => new Response("no", { status: 404 }),
  });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  await assert.rejects(() => updater.downloadAndInstall(), /404/);
  assert.equal(updater.progress().state, "error");
  assert.deepEqual(await fsp.readdir(folder), []);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a release published without this install's package is not offered to it", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  // The flatpak job failed: the release lists everything but the bundle.
  const listing = (url) => {
    const download = /\/releases\/download\/v[^/]+\/(.+)$/.exec(String(url));
    if (download) return new Response(null, { status: download[1].endsWith(".flatpak") ? 404 : 302 });
    const tag = /\/releases\/tags\/v([^/]+)$/.exec(String(url));
    const all = releaseListing(tag[1], PACKAGE);
    return Response.json({ assets: all.assets.filter((asset) => !asset.name.endsWith(".flatpak")) });
  };
  const flatpak = fakeHost({ format: "", flatpak: { id: "com.opengamemaster.client", system: false }, fetchImpl: listing });
  const status = await new Updater("flatpak", "0.12.0", async () => "0.12.1", 0, flatpak.host).checkForUpdates();
  assert.equal(status.available, false);
  assert.equal(status.latest, "0.12.0");
  // The same release still reaches an rpm install, whose package is there.
  const rpm = fakeHost({ fetchImpl: listing });
  assert.equal((await new Updater("managed", "0.12.0", async () => "0.12.1", 0, rpm.host).checkForUpdates()).available, true);
  // A listing GitHub would not give does not hide the update.
  const offline = fakeHost({ format: "", flatpak: { id: "x", system: false }, fetchImpl: async () => new Response("", { status: 503 }) });
  assert.equal((await new Updater("flatpak", "0.12.0", async () => "0.12.1", 0, offline.host).checkForUpdates()).available, true);
});

// A flatpak from before the rename to Open Game Master has the old app id
// (src/main/app-names.ts): from the desktop it is offered the renamed app,
// started by Steam it keeps updating as itself.
const LEGACY_FLATPAK = "com.opendungeonmaster.client";

test("release files keep a name from before the rename on request", async () => {
  const { packageAssetName } = await import("../dist/main/updater.js");
  assert.equal(packageAssetName("0.12.1", "flatpak", "linux", "x64", "", "open-dungeon-master-client"), "open-dungeon-master-client-0.12.1-x86_64.flatpak");
  assert.equal(packageAssetName("0.12.1", "flatpak", "linux", "x64", ""), "open-game-master-client-0.12.1-x86_64.flatpak");
});

test("an old-id flatpak from the desktop is offered the renamed app at its own version, and installs it", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const { host, log } = fakeHost({
    format: "",
    downloadsDir: () => folder,
    flatpak: { id: LEGACY_FLATPAK, system: false },
    // The renamed app is not installed yet.
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      return { code: args.includes("info") ? 1 : 0, stderr: "" };
    },
  });
  const updater = new Updater("flatpak", "0.12.1", async () => "0.12.1", 0, host);
  const status = await updater.checkForUpdates();
  assert.equal(status.available, true);
  assert.equal(status.renamed, true);
  assert.equal(status.latest, "0.12.1");
  assert.equal(status.canDownload, true);
  await updater.downloadAndInstall();
  const file = path.join(folder, "open-game-master-client-0.12.1-x86_64.flatpak");
  const info = ["flatpak-spawn", "--host", "flatpak", "info", "com.opengamemaster.client"];
  assert.deepEqual(log.ran.at(-2), ["flatpak-spawn", "--host", "true"]);
  assert.deepEqual(log.ran.at(-1), ["flatpak-spawn", "--host", "flatpak", "install", "--user", "-y", "--bundle", file]);
  assert.ok(log.ran.slice(0, -2).every((call) => call.join(" ") === info.join(" ")), "before that it only asked whether the renamed app is there");
  assert.deepEqual(log.relaunched, [""], "the restart is the hand-over (index.ts)");
  assert.match(updater.progress().message, /Moving your servers and worlds/);
  // A newer release is the one offered, still as the renamed app.
  const newer = new Updater("flatpak", "0.12.1", async () => "0.12.2", 0, fakeHost({ format: "", flatpak: { id: LEGACY_FLATPAK, system: false } }).host);
  assert.equal((await newer.checkForUpdates()).latest, "0.12.2");
  await fsp.rm(folder, { recursive: true, force: true });
});

test("an old-id flatpak hands over straight away when the renamed app is installed", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const { host, log } = fakeHost({
    format: "",
    flatpak: { id: LEGACY_FLATPAK, system: true },
    // A release with no renamed bundle at all.
    fetchImpl: async () => Response.json({ assets: [] }),
  });
  const updater = new Updater("flatpak", "0.12.1", async () => "0.12.1", 0, host);
  assert.equal((await updater.checkForUpdates()).renamed, true);
  log.ran.length = 0;
  await updater.downloadAndInstall();
  assert.deepEqual(log.ran, [["flatpak-spawn", "--host", "flatpak", "info", "com.opengamemaster.client"]]);
  assert.deepEqual(log.relaunched, [""]);
});

test("an old-id flatpak started by Steam updates in place from the old-name bundle", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const viaSteam = () => fakeHost({ format: "", flatpak: { id: LEGACY_FLATPAK, system: false }, launchedBySteam: true }).host;
  assert.equal((await new Updater("flatpak", "0.12.1", async () => "0.12.1", 0, viaSteam()).checkForUpdates()).available, false);
  const listed = [];
  const host = viaSteam();
  host.fetchImpl = async (url) => {
    listed.push(String(url));
    return Response.json({ assets: [{ name: "open-dungeon-master-client-0.12.2-x86_64.flatpak" }] });
  };
  const status = await new Updater("flatpak", "0.12.1", async () => "0.12.2", 0, host).checkForUpdates();
  assert.equal(status.available, true);
  assert.equal(status.renamed, undefined);
  assert.equal(status.canDownload, true);
});

// The host half of flatpakMoveCommand, run for real in a scratch home against
// a stand-in flatpak that logs what it was asked and says whether the
// renamed app is installed.
async function runMove({ installed = true, seed = async () => {} } = {}) {
  const { flatpakMoveCommand } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const folder = await tempFolder();
  const home = path.join(folder, "home");
  await fsp.mkdir(path.join(home, ".var", "app"), { recursive: true });
  await seed(home);
  const calls = path.join(folder, "calls");
  await fsp.writeFile(
    path.join(folder, "flatpak"),
    ["#!/bin/sh", `echo "$*" >> '${calls}'`, `[ "$1" = info ] && exit ${installed ? 0 : 1}`, "exit 0"].join("\n"),
    { mode: 0o755 },
  );
  const [command, args] = flatpakMoveCommand(LEGACY_FLATPAK, "com.opengamemaster.client", false, home, ["--steam-deck"]);
  assert.equal(command, "flatpak-spawn");
  const stdout = await new Promise((resolve, reject) => {
    execFile(args[1], args.slice(2), { env: { ...process.env, PATH: `${folder}:${process.env.PATH}` } }, (err, out) =>
      err ? reject(err) : resolve(out),
    );
  });
  assert.equal(stdout, "up\n");
  const lines = (await untilRun(calls)).filter((line) => !line.startsWith("ps"));
  return { home, lines, cleanup: () => fsp.rm(folder, { recursive: true, force: true }) };
}

test("the move hands the old flatpak's data to the renamed app, removes the old one and starts the new", async () => {
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const data = (home, id) => path.join(home, ".var", "app", id, "config", "open-dungeon-master-client");
  const run = await runMove({
    seed: async (home) => {
      await fsp.mkdir(data(home, LEGACY_FLATPAK), { recursive: true });
      await fsp.writeFile(path.join(data(home, LEGACY_FLATPAK), "servers.json"), "{}");
    },
  });
  try {
    assert.equal(await fsp.readFile(path.join(data(run.home, "com.opengamemaster.client"), "servers.json"), "utf8"), "{}");
    assert.equal(await fsp.stat(path.join(run.home, ".var", "app", LEGACY_FLATPAK)).catch(() => null), null);
    assert.deepEqual(run.lines, [
      "info com.opengamemaster.client",
      `uninstall --user -y ${LEGACY_FLATPAK}`,
      "run com.opengamemaster.client --steam-deck",
    ]);
  } finally {
    await run.cleanup();
  }
});

test("the move puts the data into a renamed app that ran once but has none, and never over data it has", async () => {
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const data = (home, id) => path.join(home, ".var", "app", id, "config", "open-dungeon-master-client");
  const seedOld = async (home) => {
    await fsp.mkdir(data(home, LEGACY_FLATPAK), { recursive: true });
    await fsp.writeFile(path.join(data(home, LEGACY_FLATPAK), "servers.json"), "old");
  };
  const empty = await runMove({
    seed: async (home) => {
      await seedOld(home);
      await fsp.mkdir(path.join(home, ".var", "app", "com.opengamemaster.client", "cache"), { recursive: true });
    },
  });
  try {
    assert.equal(await fsp.readFile(path.join(data(empty.home, "com.opengamemaster.client"), "servers.json"), "utf8"), "old");
    assert.ok(empty.lines.includes(`uninstall --user -y ${LEGACY_FLATPAK}`));
  } finally {
    await empty.cleanup();
  }
  const own = await runMove({
    seed: async (home) => {
      await seedOld(home);
      await fsp.mkdir(data(home, "com.opengamemaster.client"), { recursive: true });
      await fsp.writeFile(path.join(data(home, "com.opengamemaster.client"), "servers.json"), "new");
    },
  });
  try {
    assert.equal(await fsp.readFile(path.join(data(own.home, "com.opengamemaster.client"), "servers.json"), "utf8"), "new");
    assert.equal(await fsp.readFile(path.join(data(own.home, LEGACY_FLATPAK), "servers.json"), "utf8"), "old");
    assert.deepEqual(own.lines, ["info com.opengamemaster.client", "run com.opengamemaster.client --steam-deck"], "the old app stays with its data");
  } finally {
    await own.cleanup();
  }
});

test("without the renamed app the move only starts the old flatpak again", async () => {
  const run = await runMove({ installed: false });
  try {
    assert.deepEqual(run.lines, ["info com.opengamemaster.client", `run ${LEGACY_FLATPAK} --steam-deck`]);
  } finally {
    await run.cleanup();
  }
});

// GitHub's API allows a network 60 anonymous calls an hour, and other
// programs on the same connection can spend them: the launch check then
// failed silently and the install failed on its checksum lookup. Versions
// and listings now come from github.com itself.
const rateLimited = () =>
  new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1800) },
  });

test("the latest version comes from the release page's redirect, not the API", async () => {
  const { latestFromReleasePage, fetchLatestReleaseVersion } = await import("../dist/main/updater.js");
  const asked = [];
  const page = async (url, init) => {
    asked.push([String(url), init?.method ?? "GET"]);
    if (String(url).includes("api.github.com")) return rateLimited();
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, "url", { value: "https://github.com/Lebbitheplow/open-game-master-client/releases/tag/v0.23.3" });
    return res;
  };
  assert.equal(await latestFromReleasePage(page), "0.23.3");
  assert.equal(await fetchLatestReleaseVersion(page), "0.23.3");
  assert.ok(asked.every(([url]) => !url.includes("api.github.com")), "the API was never asked");
  // A page that would not say falls back to the API, and its rate limit is
  // said as one.
  const nowhere = async (url) => (String(url).includes("api.github.com") ? rateLimited() : new Response(null, { status: 500 }));
  await assert.rejects(() => fetchLatestReleaseVersion(nowhere), /limiting update checks from this internet connection.*Try again after/);
});

test("the beta channel reads the release feed", async () => {
  const { newestInFeed, fetchNewestReleaseVersion } = await import("../dist/main/updater.js");
  const feed = `<?xml version="1.0"?><feed>
    <entry><link rel="alternate" type="text/html" href="https://github.com/x/y/releases/tag/v0.20.7"/><content>&lt;a href=&quot;https://github.com/x/y/releases/tag/v9.9.9&quot;&gt;</content></entry>
    <entry><link rel="alternate" type="text/html" href="https://github.com/x/y/releases/tag/v0.21.2"/></entry>
    <entry><link rel="alternate" type="text/html" href="https://github.com/x/y/releases/tag/nightly"/></entry>
  </feed>`;
  assert.equal(newestInFeed(feed), "0.21.2", "links in release notes are not releases");
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    return new Response(feed, { status: 200 });
  };
  assert.equal(await fetchNewestReleaseVersion("beta", fetchImpl), "0.21.2");
  assert.deepEqual(asked, ["https://github.com/Lebbitheplow/open-game-master-client/releases.atom"]);
});

test("a rate-limited checksum lookup falls back to the release's update feed", async () => {
  const { releaseChecksum, sha512FromFeed, feedFileFor } = await import("../dist/main/updater.js");
  const rpm = "open-game-master-client-0.23.3-x86_64.rpm";
  const sha512 = createHash("sha512").update(PACKAGE).digest("base64");
  const yml = `version: 0.23.3
files:
  - url: open-game-master-client-0.23.3-x86_64.AppImage
    sha512: ${createHash("sha512").update("other").digest("base64")}
    size: 1
  - url: ${rpm}
    sha512: ${sha512}
    size: 4
path: open-game-master-client-0.23.3-x86_64.AppImage
`;
  assert.equal(sha512FromFeed(yml, rpm), createHash("sha512").update(PACKAGE).digest("hex"));
  assert.equal(sha512FromFeed(yml, "missing.rpm"), "");
  assert.equal(feedFileFor(rpm), "latest-linux.yml");
  assert.equal(feedFileFor("open-game-master-client-0.23.3-x64.tar.gz"), "");
  const fetchImpl = async (url) => (String(url).endsWith("/latest-linux.yml") ? new Response(yml) : rateLimited());
  assert.deepEqual(await releaseChecksum(fetchImpl, "0.23.3", rpm), {
    algorithm: "sha512",
    hex: createHash("sha512").update(PACKAGE).digest("hex"),
  });
  // A release from before SHA256SUMS lists the tar.gz nowhere else: the
  // rate limit is what the player reads.
  await assert.rejects(
    () => releaseChecksum(fetchImpl, "0.23.3", "open-game-master-client-0.23.3-x64.tar.gz"),
    /limiting update checks/,
  );
});

test("SHA256SUMS vouches for every package, the tar.gz and flatpak included", async () => {
  const { releaseChecksum, sha256FromSums } = await import("../dist/main/updater.js");
  const tar = "open-game-master-client-0.24.0-x64.tar.gz";
  const flatpak = "open-game-master-client-0.24.0-x86_64.flatpak";
  const hex = createHash("sha256").update(PACKAGE).digest("hex");
  const sums = `${"a".repeat(64)}  latest-linux.yml\n${hex}  ${tar}\n${"b".repeat(64)} *${flatpak}\n`;
  assert.equal(sha256FromSums(sums, tar), hex);
  assert.equal(sha256FromSums(sums, flatpak), "b".repeat(64), "binary-mode lines too");
  assert.equal(sha256FromSums(sums, "nope.tar.gz"), "");
  assert.equal(sha256FromSums(sums, "x64.tar.gz"), "", "a whole name, not a suffix");
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    return String(url).endsWith("/v0.24.0/SHA256SUMS") ? new Response(sums) : rateLimited();
  };
  assert.deepEqual(await releaseChecksum(fetchImpl, "0.24.0", tar), { algorithm: "sha256", hex });
  assert.ok(asked.every((url) => !url.endsWith(".yml")), "the feed files are not needed");
  // The API, when it answers, still comes first.
  const api = async (url) =>
    String(url).includes("api.github.com")
      ? Response.json({ assets: [{ name: tar, digest: `sha256:${"c".repeat(64)}` }] })
      : new Response(sums);
  assert.equal((await releaseChecksum(api, "0.24.0", tar)).hex, "c".repeat(64));
});

test("an rpm downloads and installs while the API is rate limited", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const folder = await tempFolder();
  const rpm = "open-game-master-client-0.12.1-x86_64.rpm";
  const yml = `files:\n  - url: ${rpm}\n    sha512: ${createHash("sha512").update(PACKAGE).digest("base64")}\n`;
  const { host, log } = fakeHost({
    downloadsDir: () => folder,
    has: async (command) => ["pkexec", "dnf"].includes(command),
    fetchImpl: async (url, init) => {
      const at = String(url);
      if (at.includes("api.github.com")) return rateLimited();
      if (at.endsWith("/latest-linux.yml")) return new Response(yml);
      if (init?.method === "HEAD") return new Response(null, { status: 302 });
      return new Response(PACKAGE, { status: 200, headers: { "content-length": String(PACKAGE.byteLength) } });
    },
  });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  assert.equal((await updater.checkForUpdates()).available, true);
  await updater.downloadAndInstall();
  assert.equal(log.ran.length, 1);
  assert.equal(updater.progress().state, "ready");
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a background check that fails is retried and logged, not dropped", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const lines = [];
  let calls = 0;
  const fetchLatest = async () => {
    calls += 1;
    if (calls === 1) throw new Error("getaddrinfo ENOTFOUND github.com");
    return "0.12.1";
  };
  const updater = new Updater("managed", "0.12.0", fetchLatest, 0, { ...fakeHost().host, log: (line) => lines.push(line) });
  updater.retryDelaysMs = [5];
  updater.recheckMs = 60_000;
  const found = new Promise((resolve) => updater.onStatus(() => resolve(updater.progress())));
  // The retry timer is unref'd (it never keeps the app alive), so the test
  // holds the event loop open itself.
  const hold = setInterval(() => {}, 1000);
  updater.checkOnStartup();
  const progress = await found.finally(() => clearInterval(hold));
  assert.equal(progress.state, "available");
  assert.equal(progress.latest, "0.12.1");
  assert.equal(calls, 2);
  assert.match(lines[0], /Background update check failed: getaddrinfo ENOTFOUND/);
});

test("the background recheck waits while an install is under way", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  let calls = 0;
  const updater = new Updater("managed", "0.12.0", async () => {
    calls += 1;
    return "0.12.1";
  }, 0, fakeHost().host);
  updater.recheckMs = 5;
  // A download the player started: a failed check reported on electron-
  // updater's "error" event would otherwise mark it failed.
  updater.state = { ...updater.progress(), state: "downloading", percent: 40 };
  const hold = setInterval(() => {}, 1000);
  try {
    updater.checkOnStartup();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(calls, 0, "no check while the download runs");
    assert.equal(updater.progress().state, "downloading");
    updater.state = { ...updater.progress(), state: "idle", percent: 0 };
    const progress = await new Promise((resolve) => updater.onStatus(() => resolve(updater.progress())));
    assert.equal(progress.state, "available", "the next recheck runs once it is done");
    assert.ok(calls >= 1);
  } finally {
    clearInterval(hold);
    updater.recheckMs = 24 * 60 * 60_000;
  }
});
