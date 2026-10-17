// Drives an installed copy of the app the way a player's machine runs it,
// for the release's install and upgrade check (.github/workflows/release.yml
// windows-install). The world is started through the installed app's own
// LocalServer (its app.asar, the Electron binary in Node mode, the payload
// it ships), so each version is checked with the code it shipped.
//
//   node scripts/smoke-installed.mjs install <Setup.exe> <dir>
//       Installs (or upgrades) an NSIS build silently into <dir>.
//   node scripts/smoke-installed.mjs world <app binary> seed|verify|start <work dir>
//       seed:   starts the world in <work dir>, notes its id and leaves a
//               mark in the run tree's data folder (where installed world
//               packs live).
//       verify: starts it again (after an upgrade) and checks the same
//               world came back, the mark survived the new payload, and
//               every module alias reaches its package (server issue 280).
//       start:  starts a world in an empty folder: a clean install.
//   node scripts/smoke-installed.mjs launch <app binary>
//       Opens the app itself and checks it is still up 25 seconds later.
//
// The world phases run inside the installed binary and must keep working
// with the LocalServer of the release before this one, which seed runs on.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const [mode, ...args] = process.argv.slice(2);
const MARKER = "ci-upgrade-marker.txt";

function fail(message) {
  console.error(`[smoke-installed] ${message}`);
  process.exit(1);
}

// Inside the installed binary a failed check throws, so the world's server
// is stopped on the way out instead of left running.
function refuse(message) {
  throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function install(setup, dir) {
  if (!setup || !dir) fail("usage: install <Setup.exe> <dir>");
  const result = spawnSync(path.resolve(setup), ["/S", `/D=${path.resolve(dir)}`], { stdio: "inherit" });
  if (result.status !== 0) fail(`${setup} exited with ${result.status ?? result.error?.message}`);
  const exe = path.join(dir, "Open Dungeon Master.exe");
  for (let waited = 0; !fs.existsSync(exe); waited += 1000) {
    if (waited > 120_000) fail(`${exe} did not appear after the install`);
    await sleep(1000);
  }
  console.log(`installed ${setup} into ${dir}`);
}

function world(binary, phase, work) {
  if (!binary || !["seed", "verify", "start"].includes(phase) || !work) {
    fail("usage: world <app binary> seed|verify|start <work dir>");
  }
  const result = spawnSync(path.resolve(binary), [self, "--inside", phase, path.resolve(work)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    timeout: 10 * 60_000,
  });
  if (result.status !== 0) fail(`the ${phase} phase failed (${result.status ?? result.error?.message})`);
}

async function launch(binary) {
  if (!binary) fail("usage: launch <app binary>");
  const child = spawn(path.resolve(binary), [], { stdio: "ignore", env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" } });
  let exit = null;
  child.once("exit", (code, signal) => (exit = { code, signal }));
  await sleep(25_000);
  if (exit) fail(`the app exited within 25 seconds (${JSON.stringify(exit)})`);
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill();
  console.log("the app started and stayed up");
}

// Every alias the run tree lists must reach its package: a link left
// pointing into local-server.new, or at nothing, fails here.
function checkAliases(runDir) {
  const file = path.join(runDir, "odm-module-aliases.json");
  if (!fs.existsSync(file)) return 0;
  const aliases = JSON.parse(fs.readFileSync(file, "utf8"));
  let checked = 0;
  for (const [alias, real] of Object.entries(aliases)) {
    const link = path.join(runDir, "node_modules", alias);
    const target = path.join(runDir, "node_modules", real);
    if (!fs.existsSync(target)) continue;
    let reached = "";
    try {
      reached = fs.realpathSync.native(link);
    } catch (error) {
      refuse(`module alias ${alias} reaches nothing (${error.message})`);
    }
    if (reached !== fs.realpathSync.native(target)) refuse(`module alias ${alias} reaches ${reached}, not ${target}`);
    if (!fs.existsSync(path.join(link, "package.json"))) refuse(`module alias ${alias} has no package.json through the link`);
    checked += 1;
  }
  return checked;
}

async function inside(phase, work) {
  const resources =
    process.platform === "darwin"
      ? path.join(path.dirname(process.execPath), "..", "Resources")
      : path.join(path.dirname(process.execPath), "resources");
  const asar = path.join(resources, "app.asar");
  const require = createRequire(import.meta.url);
  const appVersion = require(path.join(asar, "package.json")).version;
  const { LocalServer } = require(path.join(asar, "dist", "main", "local-server.js"));
  const userData = path.join(work, "userData");
  const runDir = path.join(userData, "local-server");
  const notes = path.join(work, "seed.json");
  fs.mkdirSync(userData, { recursive: true });

  const local = new LocalServer(path.join(resources, "server"), userData, path.join(asar, "dist", "renderer"));
  try {
    await local.start();
    const origin = local.origin;
    const health = await fetch(`${origin}/api/health`);
    if (!health.ok) refuse(`/api/health answered ${health.status}`);
    const providers = await (await fetch(`${origin}/api/auth/providers`)).json();
    const instanceId = String(providers.instanceId ?? "");
    if (!instanceId) refuse("/api/auth/providers gave no instanceId");
    const aliases = checkAliases(runDir);
    // The payload the run tree was last built from (a dry run of the
    // release can carry the same version number as the last release, but
    // never the same build).
    const builtAt = String(JSON.parse(fs.readFileSync(path.join(runDir, "odm-payload.json"), "utf8")).builtAt ?? "");
    console.log(`app ${appVersion}, server ${providers.version ?? "?"}, world ${instanceId}, ${aliases} module aliases reach their packages`);

    if (phase === "seed") {
      // The folder installed world packs go in; a fresh tree may not have it yet.
      fs.mkdirSync(path.join(runDir, "data"), { recursive: true });
      fs.writeFileSync(path.join(runDir, "data", MARKER), instanceId);
      fs.writeFileSync(notes, JSON.stringify({ appVersion, serverVersion: providers.version, builtAt, instanceId }, null, 2));
    } else if (phase === "verify") {
      const seeded = JSON.parse(fs.readFileSync(notes, "utf8"));
      if (seeded.builtAt === builtAt) refuse(`the upgrade did not bring a new server payload (built ${builtAt} both times)`);
      if (instanceId !== seeded.instanceId) refuse(`a different world came up: ${instanceId}, seeded ${seeded.instanceId}`);
      const marker = path.join(runDir, "data", MARKER);
      if (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8") !== seeded.instanceId) {
        refuse("the mark left in the run tree's data folder did not survive the upgrade");
      }
      if (fs.existsSync(`${runDir}.new`)) refuse("local-server.new was left behind");
      console.log(`upgraded ${seeded.appVersion} -> ${appVersion}: the same world, its data folder kept`);
    }
  } finally {
    await local.stop().catch(() => undefined);
  }
}

if (mode === "--inside") {
  await inside(args[0], args[1]).catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
else if (mode === "install") await install(args[0], args[1]);
else if (mode === "world") world(args[0], args[1], args[2]);
else if (mode === "launch") await launch(args[0]);
else fail("usage: install | world | launch (see the top of this file)");
