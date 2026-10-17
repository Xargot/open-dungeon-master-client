// The Steam on this machine, for "Add to Steam" (src/main/steam-shortcut.ts):
// is it running, ask it to quit, start it again. From a flatpak every
// command runs on the host through flatpak-spawn (the sandbox may talk to
// org.freedesktop.Flatpak, electron-builder.yml), since Steam is a host
// process the sandbox cannot see or start.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import type { SteamHost } from "./steam-shortcut";

// The environment Steam is started with: what an AppImage's runtime and
// Electron put into this process's environment is taken back out, so Steam
// does not load libraries from a mount that goes away when this app quits.
export function cleanHostEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const appDir = env.APPDIR ?? "";
  for (const key of Object.keys(out)) {
    if (key.startsWith("ELECTRON_")) delete out[key];
  }
  for (const key of ["APPIMAGE", "APPDIR", "ARGV0", "OWD", "CHROME_DESKTOP"]) delete out[key];
  // Electron stands in another desktop name for its tray and keeps the
  // real one here.
  if (env.ORIGINAL_XDG_CURRENT_DESKTOP) {
    out.XDG_CURRENT_DESKTOP = env.ORIGINAL_XDG_CURRENT_DESKTOP;
    delete out.ORIGINAL_XDG_CURRENT_DESKTOP;
  }
  if (appDir) {
    for (const [key, value] of Object.entries(out)) {
      if (value === undefined || !value.includes(appDir)) continue;
      const kept = value.split(":").filter((part) => !part.startsWith(appDir));
      if (kept.length) out[key] = kept.join(":");
      else delete out[key];
    }
  }
  return out;
}

// Steam's client process, found without pgrep (inside a flatpak this only
// sees the sandbox, so it is the fallback, not the rule).
function steamInProc(): boolean {
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "steam") return true;
    } catch {
      // Gone, or not ours to read.
    }
  }
  return false;
}

export function systemSteamHost(flatpak: boolean, env: NodeJS.ProcessEnv = process.env): SteamHost {
  const hostEnv = cleanHostEnv(env);
  const command = (cmd: string, args: string[]): [string, string[]] =>
    flatpak ? ["flatpak-spawn", ["--host", cmd, ...args]] : [cmd, args];
  // Exit code of a host command; -1 when it could not start, and a command
  // still going after `capMs` counts as done.
  const run = (cmd: string, args: string[], capMs = 15_000): Promise<number> =>
    new Promise((resolve) => {
      const [file, argv] = command(cmd, args);
      const child = spawn(file, argv, { stdio: "ignore", env: hostEnv });
      const timer = setTimeout(() => resolve(0), capMs);
      child.once("error", () => {
        clearTimeout(timer);
        resolve(-1);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });
  return {
    async isRunning() {
      const code = await run("pgrep", ["-x", "steam"]);
      if (code === 0) return true;
      if (code === 1) return false;
      return steamInProc();
    },
    async shutdown() {
      await run("steam", ["-shutdown"]);
    },
    start() {
      // A subshell puts Steam in the background on its own, so it outlives
      // this app and, from a flatpak, the flatpak-spawn that started it.
      const [file, argv] = command("sh", ["-c", "(steam >/dev/null 2>&1 &)"]);
      const child = spawn(file, argv, { detached: true, stdio: "ignore", env: hostEnv });
      child.once("error", () => undefined);
      child.unref();
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
