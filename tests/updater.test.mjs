import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  detectInstallKind,
  fetchLatestReleaseVersion,
  isNewerVersion,
  packageAssetName,
  Updater,
  versionFromTag,
} from "../dist/main/updater.js";

const LINUX_OPT = "/opt/open-dungeon-master/open-dungeon-master-client";
const LINUX_USR = "/usr/lib/open-dungeon-master/open-dungeon-master-client";
const LINUX_HOME = "/home/kaleb/apps/odm/open-dungeon-master-client";
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
  assert.equal(detectInstallKind({}, "/usr/local/odm/open-dungeon-master-client", "linux", true), "portable");
});

test("the rpm and deb builds name themselves through package-type", async () => {
  const { packageFormatOf } = await import("../dist/main/updater.js");
  const RPM_EXEC = "/opt/Open Dungeon Master/open-dungeon-master-client";
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
  const { host } = fakeHost({ format: packageFormatOf(""), execPath: "/opt/odm/open-dungeon-master-client" });
  const kind = detectInstallKind({}, host.execPath, "linux", true, "");
  assert.equal(kind, "managed");
  const status = await new Updater(kind, "0.12.0", async () => "0.12.1", 0, host).checkForUpdates();
  assert.equal(status.canDownload, false);
  assert.match(status.instruction, /package manager/);
});

test("flatpak-info says which installation holds the app", async () => {
  const { flatpakIsSystemWide } = await import("../dist/main/updater.js");
  const info = (appPath) => `[Application]\nname=com.opendungeonmaster.client\n\n[Instance]\napp-path=${appPath}\n`;
  assert.equal(flatpakIsSystemWide(info("/var/lib/flatpak/app/com.opendungeonmaster.client/x86_64/master/abc/files")), true);
  assert.equal(flatpakIsSystemWide(info("/home/kaleb/.local/share/flatpak/app/com.opendungeonmaster.client/x86_64/master/abc/files")), false);
  assert.equal(flatpakIsSystemWide(""), false);
  // An installation flatpak was pointed elsewhere for counts as the player's.
  assert.equal(flatpakIsSystemWide(info("/tmp/odm-flatpak-user/app/com.opendungeonmaster.client/x86_64/master/abc/files")), false);
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
    execPath: "/opt/Open Dungeon Master/open-dungeon-master-client",
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

async function tempFolder() {
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  return fsp.mkdtemp(path.join(os.tmpdir(), "odm-update-"));
}

test("packageAssetName picks the one release file an install updates from", async () => {
  const { packageAssetName } = await import("../dist/main/updater.js");
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "x64", "rpm"), "open-dungeon-master-client-0.12.1-x86_64.rpm");
  assert.equal(packageAssetName("0.12.1", "managed", "linux", "x64", "deb"), "open-dungeon-master-client-0.12.1-amd64.deb");
  assert.equal(packageAssetName("0.12.1", "portable", "linux", "x64", ""), "open-dungeon-master-client-0.12.1-x64.tar.gz");
  assert.equal(packageAssetName("0.12.1", "flatpak", "linux", "x64", "rpm"), "open-dungeon-master-client-0.12.1-x86_64.flatpak");
  // The zip unpacks into a bundle the app can swap in; the dmg would need mounting.
  assert.equal(packageAssetName("0.12.1", "mac", "darwin", "arm64", ""), "open-dungeon-master-client-0.12.1-arm64-mac.zip");
  assert.equal(packageAssetName("0.12.1", "mac", "darwin", "x64", ""), "open-dungeon-master-client-0.12.1-x64-mac.zip");
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
  const file = path.join(folder, "open-dungeon-master-client-0.12.1-x86_64.rpm");
  assert.deepEqual(asked, [
    "https://api.github.com/repos/Lebbitheplow/open-dungeon-master-client/releases/tags/v0.12.1",
    "https://github.com/Lebbitheplow/open-dungeon-master-client/releases/download/v0.12.1/open-dungeon-master-client-0.12.1-x86_64.rpm",
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
  assert.deepEqual(log.opened, [path.join(folder, "open-dungeon-master-client-0.12.1-x86_64.rpm")]);
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
    execPath: "/home/kaleb/apps/odm/open-dungeon-master-client",
    downloadsDir: () => folder,
  });
  const updater = new Updater("portable", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  const file = path.join(folder, "open-dungeon-master-client-0.12.1-x64.tar.gz");
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
    execPath: "/usr/local/odm/open-dungeon-master-client",
    downloadsDir: () => folder,
    writable: async () => false,
  });
  const updater = new Updater("portable", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  const file = path.join(folder, "open-dungeon-master-client-0.12.1-x64.tar.gz");
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
  const bundle = path.join(apps, "Open Dungeon Master.app");
  await fsp.mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  await fsp.writeFile(path.join(bundle, "Contents", "MacOS", "Open Dungeon Master"), "old");
  const { host, log } = fakeHost({
    platform: "darwin",
    arch: "arm64",
    format: "",
    execPath: path.join(bundle, "Contents", "MacOS", "Open Dungeon Master"),
    downloadsDir: () => folder,
    // ditto stands in: it drops a new bundle into the staging folder.
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      const staging = args[args.length - 1];
      await fsp.mkdir(path.join(staging, "Open Dungeon Master.app", "Contents", "MacOS"), { recursive: true });
      await fsp.writeFile(path.join(staging, "Open Dungeon Master.app", "Contents", "MacOS", "Open Dungeon Master"), "new");
      return { code: 0, stderr: "" };
    },
  });
  const updater = new Updater("mac", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  const zip = path.join(folder, "open-dungeon-master-client-0.12.1-arm64-mac.zip");
  assert.equal(log.ran.length, 1);
  assert.deepEqual(log.ran[0].slice(0, 4), ["ditto", "-x", "-k", zip]);
  assert.equal(await fsp.readFile(path.join(bundle, "Contents", "MacOS", "Open Dungeon Master"), "utf8"), "new");
  // No staging folder or retired bundle left beside it.
  assert.deepEqual(await fsp.readdir(apps), ["Open Dungeon Master.app"]);
  assert.deepEqual(log.relaunched, [""]);
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
  const bundle = path.join(apps, "Open Dungeon Master.app");
  const exe = path.join(bundle, "Contents", "MacOS", "Open Dungeon Master");
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
        await fsp.mkdir(path.join(staging, "Open Dungeon Master.app", "Contents", "MacOS"), { recursive: true });
        await fsp.writeFile(path.join(staging, "Open Dungeon Master.app", "Contents", "MacOS", "Open Dungeon Master"), "new");
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
  assert.deepEqual(await fsp.readdir(apps), ["Open Dungeon Master.app"]);
  assert.deepEqual(await fsp.readdir(downloads), []);
  assert.deepEqual(log.relaunched, [""]);
  await fsp.rm(folder, { recursive: true, force: true });
});

test("a Mac copy run from where Gatekeeper put it is installed into Applications", async () => {
  const { Updater } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const folder = await tempFolder();
  const exe = "/private/var/folders/xy/T/AppTranslocation/1234/d/Open Dungeon Master.app/Contents/MacOS/Open Dungeon Master";
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
        await fsp.mkdir(`${args[args.length - 1]}/Open Dungeon Master.app`, { recursive: true });
      }
      return { code: 0, stderr: "" };
    },
  });
  const updater = new Updater("mac", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  assert.equal(log.ran[1][0], "osascript");
  const script = adminScript(log.ran[1].slice(1));
  assert.match(script, /mv '[^']*\/Open Dungeon Master\.app' '\/Applications\/Open Dungeon Master\.app'/);
  assert.doesNotMatch(script, /AppTranslocation/);
  assert.deepEqual(log.relaunched, ["/Applications/Open Dungeon Master.app/Contents/MacOS/Open Dungeon Master"]);
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
    execPath: "/Applications/Open Dungeon Master.app/Contents/MacOS/Open Dungeon Master",
    downloadsDir: () => folder,
    writable: async (dir) => dir === folder,
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      if (command === "ditto") {
        await fsp.mkdir(`${args[args.length - 1]}/Open Dungeon Master.app`, { recursive: true });
        return { code: 0, stderr: "" };
      }
      return { code: 1, stderr: "0:180: execution error: User canceled. (-128)\n" };
    },
  });
  const updater = new Updater("mac", "0.12.0", async () => "0.12.1", 0, host);
  await assert.rejects(() => updater.downloadAndInstall(), /cancelled/);
  assert.deepEqual(log.relaunched, []);
  // The zip stays for a manual install; the staging folder does not.
  assert.deepEqual(await fsp.readdir(folder), ["open-dungeon-master-client-0.12.1-arm64-mac.zip"]);
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
    flatpak: { id: "com.opendungeonmaster.client", system: true },
  });
  const updater = new Updater("flatpak", "0.12.0", async () => "0.12.1", 0, host);
  assert.equal((await updater.checkForUpdates()).canDownload, true);
  await updater.downloadAndInstall();
  const file = path.join(folder, "open-dungeon-master-client-0.12.1-x86_64.flatpak");
  assert.deepEqual(log.ran, [
    ["flatpak-spawn", "--host", "true"],
    // -y, not --noninteractive: that would also refuse the password prompt.
    ["flatpak-spawn", "--host", "flatpak", "install", "--system", "-y", "--bundle", file],
  ]);
  assert.deepEqual(log.opened, []);
  assert.deepEqual(log.relaunched, [""]);
  assert.deepEqual(await fsp.readdir(folder), []);
  assert.equal(updater.progress().state, "ready");

  const user = fakeHost({ format: "", downloadsDir: () => folder, flatpak: { id: "com.opendungeonmaster.client", system: false } });
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
    flatpak: { id: "com.opendungeonmaster.client", system: false },
    // A bundle from before the org.freedesktop.Flatpak permission.
    run: async (command, args) => {
      log.ran.push([command, ...args]);
      return { code: 1, stderr: "Portal call failed" };
    },
  });
  const updater = new Updater("flatpak", "0.12.0", async () => "0.12.1", 0, host);
  await updater.downloadAndInstall();
  assert.deepEqual(log.ran, [["flatpak-spawn", "--host", "true"]]);
  assert.deepEqual(log.opened, [path.join(folder, "open-dungeon-master-client-0.12.1-x86_64.flatpak")]);
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
    flatpak: { id: "com.opendungeonmaster.client", system: true },
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
      '  [ "$n" -le 2 ] && echo com.opendungeonmaster.client',
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  const [command, args] = flatpakRelaunchCommand("com.opendungeonmaster.client");
  assert.equal(command, "flatpak-spawn");
  assert.deepEqual(args.slice(0, 2), ["--host", "sh"]);
  const stdout = await new Promise((resolve, reject) => {
    execFile(args[1], args.slice(2), { env: { ...process.env, PATH: `${folder}:${process.env.PATH}` } }, (err, out) =>
      err ? reject(err) : resolve(out),
    );
  });
  assert.equal(stdout, "up\n");
  const lines = (await fsp.readFile(calls, "utf8")).trim().split("\n");
  assert.equal(lines.filter((line) => line.startsWith("ps")).length, 3);
  assert.equal(lines[lines.length - 1], "run com.opendungeonmaster.client");
  // A Steam Deck launch option rides along to the new run.
  const [, withFlag] = flatpakRelaunchCommand("com.opendungeonmaster.client", ["--steam-deck"]);
  await fsp.writeFile(calls, "");
  await new Promise((resolve, reject) => {
    execFile(withFlag[1], withFlag.slice(2), { env: { ...process.env, PATH: `${folder}:${process.env.PATH}` } }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
  const flagged = (await fsp.readFile(calls, "utf8")).trim().split("\n");
  assert.equal(flagged[flagged.length - 1], "run com.opendungeonmaster.client --steam-deck");
  await fsp.rm(folder, { recursive: true, force: true });
});

test("replaceAppImage keeps a renamed file's name and replaces a versioned one", async () => {
  const { replaceAppImage } = await import("../dist/main/updater.js");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const folder = await tempFolder();
  const renamed = path.join(folder, "odm.AppImage");
  await fsp.writeFile(renamed, "old");
  const fresh = path.join(folder, "pending", "open-dungeon-master-client-0.12.1-x86_64.AppImage");
  await fsp.mkdir(path.dirname(fresh), { recursive: true });
  await fsp.writeFile(fresh, "new");
  assert.equal(await replaceAppImage(renamed, fresh), renamed);
  assert.equal(await fsp.readFile(renamed, "utf8"), "new");
  assert.equal(((await fsp.stat(renamed)).mode & 0o111) !== 0, true);

  const versioned = path.join(folder, "open-dungeon-master-client-0.12.0-x86_64.AppImage");
  await fsp.writeFile(versioned, "old");
  await fsp.writeFile(fresh, "new");
  const destination = await replaceAppImage(versioned, fresh);
  assert.equal(destination, path.join(folder, "open-dungeon-master-client-0.12.1-x86_64.AppImage"));
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
      return Response.json({ assets: [{ name: "open-dungeon-master-client-0.12.1-amd64.deb", digest: null }] });
    },
  });
  const updater = new Updater("managed", "0.12.0", async () => "0.12.1", 0, host);
  await assert.rejects(() => updater.downloadAndInstall(), /lists no checksum/);
  assert.equal(asked.length, 1, "only the listing was asked for");
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
