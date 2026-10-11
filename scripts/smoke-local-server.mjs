// Boots the bundled server payload exactly the way the packaged app does
// (Electron binary in Node mode) against a throwaway database, and checks
// health, the providers probe, account creation and bearer login. No GUI.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendorDir = path.join(repo, "vendor", "server");
const electronPath = createRequire(import.meta.url)("electron");

if (!fs.existsSync(path.join(vendorDir, "server.js"))) {
  console.error("No payload at vendor/server. Run: npm run bundle-server");
  process.exit(1);
}

const port = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen({ host: "127.0.0.1", port: 0 }, () => {
    const chosen = probe.address().port;
    probe.close(() => resolve(chosen));
  });
});
const origin = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-smoke-"));

const child = spawn(electronPath, [path.join(vendorDir, "server.js")], {
  cwd: vendorDir,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    SQLITE_DB_PATH: path.join(dataDir, "smoke.sqlite"),
    DB_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  },
  stdio: ["ignore", "pipe", "inherit"],
});

// The first account on a server somebody runs takes the one-time setup
// code the server prints at boot (src/lib/setup-code.ts), so the log is
// read as it goes by and the code picked out of it.
let log = "";
child.stdout.on("data", (chunk) => {
  log += chunk.toString();
  process.stdout.write(chunk);
});
const setupCode = () => log.match(/\b([A-Z0-9]{4}-){3}[A-Z0-9]{4}\b/)?.[0];

function fail(message) {
  console.error(`FAIL: ${message}`);
  child.kill("SIGKILL");
  process.exit(1);
}

try {
  const deadline = Date.now() + 90_000;
  let healthy = false;
  while (Date.now() < deadline && !healthy) {
    if (child.exitCode !== null) fail(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
      healthy = res.ok;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!healthy) fail("server never became healthy");
  console.log("ok: /api/health");

  const providers = await (await fetch(`${origin}/api/auth/providers`)).json();
  if (providers.password !== true) fail("providers probe looks wrong");
  console.log(`ok: providers (server ${providers.version}, signupMode ${providers.signupMode})`);

  const register = await fetch(`${origin}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "smoketester", password: "smoke-pass-123", setupCode: setupCode() }),
  });
  if (register.status !== 201) fail(`register returned ${register.status} (setup code ${setupCode() ? "read from the log" : "not found in the log"})`);
  console.log("ok: first account created (admin, with the setup code from the log)");

  const token = await fetch(`${origin}/api/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "smoketester", password: "smoke-pass-123" }),
  });
  const grant = await token.json();
  if (!token.ok || !grant.token) fail(`token mint returned ${token.status}`);
  console.log("ok: bearer token minted");

  const me = await fetch(`${origin}/api/auth/me`, {
    headers: { authorization: `Bearer ${grant.token}` },
  });
  if (!me.ok) fail(`bearer auth check returned ${me.status}`);
  console.log("ok: bearer auth accepted");

  // The payload ships without the sound library (scripts/
  // prune-server-payload.mjs); the server must report an empty one, not
  // fail, and name the pack an admin can install.
  const ambience = await fetch(`${origin}/api/ambience`, { headers: { authorization: `Bearer ${grant.token}` } });
  if (!ambience.ok) fail(`ambience probe returned ${ambience.status}`);
  const library = await ambience.json();
  if (Object.keys(library.tracks ?? {}).length) fail("the payload still carries sound library tracks");
  const pack = await fetch(`${origin}/api/admin/ambience`, { headers: { authorization: `Bearer ${grant.token}` } });
  if (!pack.ok) fail(`sound pack status returned ${pack.status}`);
  const packStatus = await pack.json();
  if (!/^https:\/\/.+ambience-pack\.zip$/.test(packStatus.packUrl ?? "")) fail(`sound pack URL looks wrong: ${packStatus.packUrl}`);
  console.log(`ok: sound library absent, pack offered at ${packStatus.packUrl}`);

  console.log("SMOKE PASS");
} finally {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  await new Promise((resolve) => child.once("exit", resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
