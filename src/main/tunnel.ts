import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DEFAULT_BROKER_URL,
  QUICK_URL_SHAPE,
  parseBrokerSession,
  type BrokerSession,
} from "../shared/broker";
import type { TunnelStatus } from "../shared/types";
import { rotateLog } from "./log-files";

// Hosts an offline world on the public internet through a Cloudflare quick
// tunnel: no account, no port forwarding, a random https address on
// trycloudflare.com. Friends join in any browser; the session lives as long
// as the app keeps the tunnel up. The pretty play-CODE.opendungeonmaster.com
// names come from the broker Worker; the plumbing here is the same.

const URL_WAIT_MS = 45_000;
const REACHABLE_WAIT_MS = 90_000;
// A named tunnel's warm-up is a courtesy, not a verdict, so it waits a
// fraction of that before the host is handed their address.
const WARMUP_WAIT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

// ELF on Linux, MZ on Windows: enough to reject an HTML error page that
// arrived with a 200.
function looksLikeExecutable(file: string): boolean {
  try {
    const head = Buffer.alloc(4);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    if (process.platform === "win32") return head[0] === 0x4d && head[1] === 0x5a;
    return head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
  } catch {
    return false;
  }
}

function brokerUrl(): string {
  return process.env.ODM_BROKER_URL || DEFAULT_BROKER_URL;
}

// cloudflared is a single static binary. It is fetched once per install from
// Cloudflare's official GitHub releases and never auto-updates itself
// (--no-autoupdate). It used to come from the moving "latest" release with
// only its size and header checked before it was run; now it is one pinned
// release whose SHA-256 must match the digest written here (taken from that
// release's notes and checked against the downloaded files). Raising the
// version means updating both. macOS publishes a .tgz instead of a bare
// binary; that is handled when the mac build lands.
export const CLOUDFLARED_VERSION = "2026.10.0";
const CLOUDFLARED_SHA256: Record<string, string> = {
  "cloudflared-linux-amd64": "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db",
  "cloudflared-linux-arm64": "e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08",
  "cloudflared-windows-amd64.exe": "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c",
};

function assetName(): string | null {
  if (process.platform === "linux") return `cloudflared-linux-${process.arch === "arm64" ? "arm64" : "amd64"}`;
  if (process.platform === "win32") return "cloudflared-windows-amd64.exe";
  return null;
}

// Streamed, so hashing tens of megabytes never holds up the window.
async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

export class QuickTunnel {
  private child: ChildProcess | null = null;
  private startPromise: Promise<TunnelStatus> | null = null;
  private state: TunnelStatus["state"] = "stopped";
  private url = "";
  private mode: TunnelStatus["mode"] = "";
  private session: BrokerSession | null = null;
  private stopRequested = false;
  private error = "";
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly binDir: string,
    private readonly logFile: string,
  ) {}

  status(): TunnelStatus {
    return {
      state: this.state,
      url: this.state === "running" ? this.url : "",
      mode: this.state === "running" ? this.mode : "",
      error: this.error,
    };
  }

  onStatus(listener: () => void): void {
    this.listeners.add(listener);
  }

  private setState(state: TunnelStatus["state"], error = ""): void {
    this.state = state;
    this.error = error;
    for (const listener of this.listeners) listener();
  }

  private binPath(): string {
    return path.join(this.binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  }

  async ensureBinary(): Promise<string> {
    const target = this.binPath();
    const asset = assetName();
    if (!asset) throw new Error("Sharing online is not supported on this platform yet.");
    const digest = CLOUDFLARED_SHA256[asset]!;
    // The digest the binary on disk was verified at. A binary fetched before
    // the pin (or touched since) is hashed once; one that is not the pinned
    // release is replaced.
    const verified = `${target}.sha256`;
    if (fs.existsSync(target)) {
      const known = fs.existsSync(verified) ? fs.readFileSync(verified, "utf8").trim() : "";
      if (known === digest) return target;
      if ((await sha256File(target)) === digest) {
        fs.writeFileSync(verified, digest);
        return target;
      }
      fs.rmSync(target, { force: true });
    }
    const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`;
    fs.mkdirSync(this.binDir, { recursive: true });
    const partial = `${target}.part`;
    try {
      // The overall timeout keeps a black-holed connection from pinning the
      // share flow on "starting" forever; a healthy download finishes well
      // inside it.
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok || !response.body) {
        throw new Error(
          "Downloading the tunnel helper (cloudflared) failed. Check your connection.",
        );
      }
      const expectedBytes = Number(response.headers.get("content-length") || 0);
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        fs.createWriteStream(partial, { mode: 0o755 }),
      );
      // A truncated or substituted body must not get cached as the binary
      // forever: check the size against the server's word and the file
      // header against the platform's executable magic.
      const written = fs.statSync(partial).size;
      if (expectedBytes > 0 && written !== expectedBytes) {
        throw new Error("The tunnel helper download was cut short. Try sharing again.");
      }
      if (!looksLikeExecutable(partial) || (await sha256File(partial)) !== digest) {
        throw new Error("The tunnel helper download was corrupted. Try sharing again.");
      }
      fs.renameSync(partial, target);
      fs.writeFileSync(verified, digest);
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw err;
    }
    return target;
  }

  // Asks the broker for a named CODE.play session. Any failure (offline,
  // rate limit, broker unconfigured) returns null and the quick-tunnel
  // fallback takes over.
  private async requestBrokerSession(localPort: number): Promise<BrokerSession | null> {
    try {
      const response = await fetch(`${brokerUrl()}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: localPort }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      return parseBrokerSession(await response.json(), !process.env.ODM_BROKER_URL);
    } catch {
      return null;
    }
  }

  private async releaseBrokerSession(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (!session) return;
    await fetch(`${brokerUrl()}/session/${session.code}`, {
      method: "DELETE",
      headers: { "x-session-secret": session.secret },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }

  private attachLog(child: ChildProcess): void {
    rotateLog(this.logFile);
    const log = fs.createWriteStream(this.logFile, { flags: "a" });
    child.stdout?.on("data", (chunk) => log.write(chunk));
    child.stderr?.on("data", (chunk) => log.write(chunk));
    child.once("exit", () => log.end());
  }

  // Watches cloudflared's log output for the assigned public URL.
  private captureUrl(child: ChildProcess): Promise<string> {
    return new Promise((resolve, reject) => {
      rotateLog(this.logFile);
      const log = fs.createWriteStream(this.logFile, { flags: "a" });
      let done = false;
      const finish = (err: Error | null, url = ""): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(url);
      };
      const timer = setTimeout(
        () => finish(new Error("The tunnel never reported its address (see tunnel.log).")),
        URL_WAIT_MS,
      );
      const scan = (chunk: Buffer): void => {
        log.write(chunk);
        const match = QUICK_URL_SHAPE.exec(chunk.toString());
        if (match) finish(null, match[0]);
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);
      child.once("exit", () => {
        log.end();
        finish(new Error("cloudflared exited during startup (see tunnel.log)."));
      });
    });
  }

  // A freshly minted quick-tunnel hostname takes a few seconds to appear in
  // DNS. Asking the OS resolver too early gets an NXDOMAIN that
  // systemd-resolved then negative-caches, wedging every retry. So the name
  // is confirmed over DNS-over-HTTPS first, which never touches the local
  // resolver cache.
  private async waitDns(
    host: string,
    child: ChildProcess,
    budgetMs = REACHABLE_WAIT_MS,
  ): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("The tunnel closed while warming up.");
      try {
        const response = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${host}&type=A`,
          { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) },
        );
        const body = (await response.json()) as { Answer?: unknown[] };
        if (Array.isArray(body.Answer) && body.Answer.length > 0) return;
      } catch {
        // DoH hiccup; keep waiting.
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("The tunnel's address never appeared in DNS.");
  }

  // The edge needs a moment to route a fresh quick tunnel; a URL that has
  // been printed is not yet a URL that works.
  private async waitReachable(
    url: string,
    child: ChildProcess,
    budgetMs = REACHABLE_WAIT_MS,
  ): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("The tunnel closed while warming up.");
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (response.ok) return;
      } catch {
        // Edge not ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("The tunnel came up but never became reachable.");
  }

  start(localPort: number): Promise<TunnelStatus> {
    if (this.state === "running") return Promise.resolve(this.status());
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart(localPort).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  // Spawns cloudflared for one session (named when a broker session is
  // given, quick otherwise) and waits until the address really works.
  private async launch(bin: string, localPort: number, session: BrokerSession | null): Promise<void> {
    const args = session
      ? ["tunnel", "--no-autoupdate", "run", "--token", session.tunnelToken]
      : ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${localPort}`];
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.session = session;
    this.mode = session ? "named" : "quick";
    if (session) {
      this.url = session.url;
      this.attachLog(child);
    } else {
      this.url = await this.captureUrl(child);
    }
    child.once("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.setState("error", "The share tunnel closed unexpectedly.");
      }
    });
    if (session) {
      // A named tunnel is up the moment cloudflared connects with its
      // token: the hostname, its DNS record and the ingress rule were all
      // made by the broker before this ran. The two checks below routinely
      // fail for the host alone while working for everyone else, because a
      // fresh CNAME takes time to reach this machine's resolver and a host
      // behind NAT often cannot reach its own public hostname. Falling back
      // to an anonymous trycloudflare address on either was the bug: the
      // host was handed a worse address than the one already minted. Give
      // the edge a short moment, then hand over the name regardless.
      await this.waitDns(new URL(this.url).hostname, child, WARMUP_WAIT_MS).catch(
        () => undefined,
      );
      await this.waitReachable(`${this.url}/api/health`, child, WARMUP_WAIT_MS).catch(
        () => undefined,
      );
      if (child.exitCode !== null) {
        throw new Error("The tunnel helper stopped as it started.");
      }
      return;
    }
    await this.waitDns(new URL(this.url).hostname, child);
    await this.waitReachable(`${this.url}/api/health`, child);
  }

  // Tears down a half-started attempt without touching the public state, so
  // the named-to-quick fallback does not flicker through "stopped".
  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
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
  }

  private async doStart(localPort: number): Promise<TunnelStatus> {
    this.stopRequested = false;
    this.setState("starting");
    try {
      const bin = await this.ensureBinary();
      const session = await this.requestBrokerSession(localPort);
      if (session) {
        try {
          await this.launch(bin, localPort, session);
          this.setState("running");
          return this.status();
        } catch {
          if (this.stopRequested) throw new Error("stopped");
          // The broker answered but its tunnel never came up (bad token,
          // stuck DNS, edge trouble). A quick tunnel is better than an
          // error, so release the session and try again anonymously.
          await this.killChild();
          await this.releaseBrokerSession();
        }
      }
      await this.launch(bin, localPort, null);
      this.setState("running");
    } catch (err) {
      const requested = this.stopRequested;
      await this.stop().catch(() => undefined);
      if (!requested) {
        this.setState("error", err instanceof Error ? err.message : String(err));
      }
    }
    return this.status();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.url = "";
    this.mode = "";
    await this.killChild();
    await this.releaseBrokerSession();
    this.setState("stopped");
  }
}
