import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { lanOrigin } from "../shared/lan";
import type { LocalStatus } from "../shared/types";
import { materializeRunTree } from "./run-tree";
import { openLog } from "./log-files";
import { PayloadStore } from "./payload-store";

// Runs the bundled Open Dungeon Master server (a Next.js standalone build
// produced by scripts/bundle-server.mjs) as a child process on localhost,
// using Electron's own binary in Node mode so no separate runtime ships.

interface PayloadInfo {
  serverVersion: string;
  builtAt: string;
}

const HEALTH_TIMEOUT_MS = 60_000;
const DEFAULT_PORT = 3210;

// Player-made data living inside the server tree that must survive a payload
// upgrade. The database itself lives outside the tree (SQLITE_DB_PATH).
const PRESERVED = [
  "public/uploads",
  "public/generated",
  "public/generated-audio",
  "public/ambience",
  "models",
];

function readPayloadInfo(dir: string): PayloadInfo | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, "odm-payload.json"), "utf8"),
    ) as PayloadInfo;
    if (parsed && typeof parsed.serverVersion === "string" && typeof parsed.builtAt === "string") {
      return parsed;
    }
  } catch {
    // No payload here.
  }
  return null;
}

export class LocalServer {
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private port = 0;
  private state: LocalStatus["state"] = "stopped";
  private error = "";
  private readonly listeners = new Set<() => void>();

  // Whether the server answers on every interface (friends on this Wi-Fi
  // can reach it) or on loopback only, the default. Not remembered across
  // runs: like the tunnel, Wi-Fi sharing is something the host turns on
  // for an evening, and a world should never wake up reachable because it
  // was last time.
  private bindAll = false;

  // The settings `extraEnv` handed the running server, so a caller can tell
  // whether a changed setting is live yet.
  private startedEnv: Record<string, string> = {};

  // The code that claims this world's first account, which is its admin.
  // The server is told it at start and refuses a first registration without
  // it, so the profile the shell makes is the only one that can own the
  // world: nobody who reaches the port first (another program on this
  // computer, or anyone once the world is shared) can register ahead of it.
  // Never shown, and worked out from the world's database key rather than
  // stored, so it is the same after the app restarts around a server that
  // kept running. A world that already has its owner ignores it.
  get setupCode(): string {
    return createHash("sha256").update(`odm-setup-code:${this.dbEncryptionKey()}`).digest("hex").slice(0, 32);
  }

  // `rendererDir` is the shell's own bundle (dist/renderer): the art it
  // carries is copied into the server tree rather than shipped twice.
  // `extraEnv` is read at every start: settings the shell keeps for its
  // world (the story memory model) that the server only reads at boot.
  constructor(
    private readonly payloadDir: string,
    private readonly userDataDir: string,
    private readonly rendererDir: string,
    private readonly extraEnv: () => Record<string, string> = () => ({}),
  ) {}

  // What the running server was started with; empty when it is not running.
  runningEnv(): Record<string, string> {
    return this.state === "running" ? { ...this.startedEnv } : {};
  }

  private get runDir(): string {
    return path.join(this.userDataDir, "local-server");
  }
  private get dataDir(): string {
    return path.join(this.userDataDir, "data");
  }
  private get dbPath(): string {
    return path.join(this.dataDir, "odm.sqlite");
  }
  // Where the world's server stages a world archive it packs or checks
  // (its src/lib/ops/world-archive.ts): beside the database.
  get transferDir(): string {
    return path.join(this.dataDir, "world-transfer");
  }
  get origin(): string {
    return this.port ? `http://127.0.0.1:${this.port}` : "";
  }
  get running(): boolean {
    return this.state === "running";
  }
  // Where friends on this Wi-Fi reach the world: "" unless it runs on
  // every interface and this computer is on a network.
  get lanOrigin(): string {
    return this.state === "running" && this.bindAll ? lanOrigin(os.networkInterfaces(), this.port) : "";
  }
  get sharedOnLan(): boolean {
    return this.bindAll;
  }

  // Turns Wi-Fi sharing on or off. The bundled server picks its address at
  // boot, so a running world restarts (same port, see pickPort); an open
  // page's stream reconnects on its own.
  async setLanSharing(on: boolean): Promise<void> {
    if (this.bindAll === on) return;
    this.bindAll = on;
    if (this.state === "running" || this.startPromise) await this.restart();
  }

  onStatus(listener: () => void): void {
    this.listeners.add(listener);
  }

  private setState(state: LocalStatus["state"], error = ""): void {
    this.state = state;
    this.error = error;
    for (const listener of this.listeners) listener();
  }

  status(hasAccount: boolean, username = ""): LocalStatus {
    const info = readPayloadInfo(this.payloadDir) ?? readPayloadInfo(this.runDir);
    return {
      state: info ? this.state : "unavailable",
      origin: this.state === "running" ? this.origin : "",
      firstRun: !fs.existsSync(this.dbPath),
      hasAccount,
      username,
      serverVersion: info?.serverVersion ?? "",
      error: this.error,
      lanOrigin: this.lanOrigin,
    };
  }

  // Copies the bundled payload into a writable run directory. The install
  // location can be read-only (AppImage mounts are), and the server writes
  // uploads and generated art next to its own public/ directory, so it has
  // to run from user data. Preserved directories survive upgrades.
  // Brings the run tree up to this build's payload (payload-store.ts): any
  // upgrade an earlier run left half done is finished or unwound first,
  // every time, so a matching build stamp never hides an interrupted one.
  private async syncRunTree(): Promise<void> {
    const fresh = readPayloadInfo(this.payloadDir);
    if (!fresh) throw new Error("This build has no bundled server payload.");
    const store = new PayloadStore(this.runDir, PRESERVED);
    await store.recover();
    const current = readPayloadInfo(this.runDir);
    if (current && current.builtAt === fresh.builtAt) return;
    await store.upgrade((dir) => materializeRunTree(this.payloadDir, dir, this.rendererDir));
  }

  private get bindHost(): string {
    return this.bindAll ? "0.0.0.0" : "127.0.0.1";
  }

  private listenFree(port: number): Promise<number | null> {
    return new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(null));
      probe.listen({ host: this.bindHost, port }, () => {
        const address = probe.address();
        const got = typeof address === "object" && address ? address.port : null;
        probe.close(() => resolve(got));
      });
    });
  }

  private async pickPort(): Promise<number> {
    // Reuse the previous port when free so the local origin stays stable.
    const portFile = path.join(this.userDataDir, "local-port");
    let wanted = DEFAULT_PORT;
    try {
      wanted = Number(fs.readFileSync(portFile, "utf8").trim()) || DEFAULT_PORT;
    } catch {
      // First run.
    }
    const port = (await this.listenFree(wanted)) ?? (await this.listenFree(0));
    if (!port) throw new Error("No free local port for the bundled server.");
    fs.writeFileSync(portFile, String(port));
    return port;
  }

  private async waitHealthy(child: ChildProcess): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error("The local server exited during startup (see local-server.log).");
      }
      try {
        const res = await fetch(`${this.origin}/api/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return;
      } catch {
        // Not up yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("The local server did not become healthy in time.");
  }

  start(): Promise<void> {
    if (this.state === "running") return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  // The server encrypts its SQLite database and refuses to run without a
  // key. One is minted per install and kept next to the data it protects;
  // it guards the world file at rest, not against this OS user.
  private dbEncryptionKey(): string {
    const keyFile = path.join(this.dataDir, "db-key");
    try {
      const existing = fs.readFileSync(keyFile, "utf8").trim();
      if (existing) return existing;
    } catch {
      // First run.
    }
    const key = randomBytes(32).toString("hex");
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    return key;
  }

  // The key the portal cookies are signed with (the server's src/lib/portal.ts
  // honours them only with a matching signature). Minted once and kept beside
  // the database key, so a portal view the window already holds stays valid
  // across restarts of the world.
  private portalSecret(): string {
    const keyFile = path.join(this.dataDir, "portal-key");
    try {
      const existing = fs.readFileSync(keyFile, "utf8").trim();
      if (existing.length >= 32) return existing;
    } catch {
      // First run.
    }
    const secret = randomBytes(32).toString("base64url");
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(keyFile, secret, { mode: 0o600 });
    return secret;
  }

  // What the shell plants beside the portal cookies for `hostOrigin` and
  // `token`: the same HMAC the server checks, over the origin as the server
  // normalizes it.
  portalSignature(hostOrigin: string, token: string): string {
    return createHmac("sha256", this.portalSecret()).update(`${new URL(hostOrigin).origin}\n${token}`).digest("base64url");
  }

  private async doStart(): Promise<void> {
    this.setState("starting");
    try {
      await this.syncRunTree();
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.port = await this.pickPort();
      const log = openLog(path.join(this.userDataDir, "local-server.log"));
      const extra = this.extraEnv();
      this.startedEnv = extra;
      const child = spawn(process.execPath, [path.join(this.runDir, "server.js")], {
        cwd: this.runDir,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          NODE_ENV: "production",
          PORT: String(this.port),
          HOSTNAME: this.bindHost,
          SQLITE_DB_PATH: this.dbPath,
          DB_ENCRYPTION_KEY: this.dbEncryptionKey(),
          // The spells, items, monsters and feats catalogue, staged by
          // bundle-server.mjs beside the server the way the Docker image
          // lays it out. Without it every picker in the character builder
          // and the workshop searches an empty pack.
          CONTENT_DB_PATH: path.join(this.runDir, "content", "open5e.sqlite"),
          // Tells the server it is the shell's own world, so its admin panel
          // hides what the shell manages (address, sign-ups, voice, Discord).
          ODM_DEVICE_WORLD: "1",
          ODM_SETUP_CODE: this.setupCode,
          ODM_PORTAL_SECRET: this.portalSecret(),
          // The server refuses uploads once the disk would drop below 1 GB
          // free, sized for a server's volume. This disk is the owner's own,
          // so the floor here is only what keeps the database writable; a
          // value already in the environment still wins.
          UPLOAD_MIN_FREE_BYTES: process.env.UPLOAD_MIN_FREE_BYTES || String(256 * 1024 * 1024),
          ...extra,
        },
        stdio: ["ignore", log, log],
      });
      fs.closeSync(log);
      this.child = child;
      child.once("exit", () => {
        if (this.child === child) {
          this.child = null;
          this.setState("error", "The local server stopped unexpectedly (see local-server.log).");
        }
      });
      await this.waitHealthy(child);
      this.setState("running");
    } catch (err) {
      await this.stop().catch(() => undefined);
      this.setState("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // Stops and starts again on the same port when it is still free (see
  // pickPort), so an open page and a share tunnel find the world where it was.
  async restart(): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.port = 0;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.once("exit", () => {
          clearTimeout(killer);
          resolve();
        });
      });
    }
    this.setState("stopped");
  }
}
