import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

// The bundled server is a child of the shell, and a child the shell never
// got to stop (the shell crashed, was ended from the task manager, or an
// installer closed it) lives on with the run tree as its working directory
// and its files open. On Windows a folder a process sits in cannot be
// renamed or removed, so the next start's payload swap fails with EPERM
// and the player keeps seeing the previous version's tree, or a half-moved
// one. The shell writes the child's pid beside the tree at every start and
// ends that child before touching the tree again, after checking the pid
// still belongs to a server run from this very script and not to whatever
// program has the number now.

const run = promisify(execFile);
const GRACE_MS = 5000;
const POLL_MS = 100;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: there is a process, it is somebody else's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The command line a process was started with, or "" when it cannot be
// read (gone, or not ours to look at).
export async function commandLineOf(pid: number): Promise<string> {
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    }
    if (process.platform === "win32") {
      const { stdout } = await run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`],
        { timeout: 15_000, windowsHide: true },
      );
      return stdout;
    }
    const { stdout } = await run("ps", ["-o", "command=", "-p", String(pid)], { timeout: 15_000 });
    return stdout;
  } catch {
    return "";
  }
}

// Ends the server an earlier start left running, when the pid file names
// one that is still alive and was started from `serverScript`. The pid file
// goes either way: a dead pid or somebody else's process means there is
// nothing of ours to end. Returns whether a server was ended.
export async function reapStaleServer(pidFile: string, serverScript: string, log: (line: string) => void = console.warn): Promise<boolean> {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    return false;
  }
  fs.rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !alive(pid)) return false;
  // Windows compares paths without case; a path on disk elsewhere has one case.
  if (!(await commandLineOf(pid)).toLowerCase().includes(serverScript.toLowerCase())) return false;
  log(`[local-server] ending the server an earlier start left running (pid ${pid})`);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(pid, signal);
    } catch {
      return !alive(pid);
    }
    for (let waited = 0; waited < GRACE_MS && alive(pid); waited += POLL_MS) await delay(POLL_MS);
    if (!alive(pid)) return true;
  }
  return false;
}
