import fs from "node:fs";
import path from "node:path";
import { moveTree } from "./payload-store";
import { reapStaleServer } from "./stale-server";

// Starting over (Settings, Troubleshooting, the last row): the app's data
// folder is set aside, never deleted. The row writes a marker and restarts
// the app; the next start, before the registry, the world or any session
// has opened the folder, moves the whole folder to a dated sibling (one
// rename, so it either happens or does not) and goes on from an empty one.
// The engines a player installed for local AI and the share tunnel's binary
// are brought back across: a reset is about the world and the app's state,
// not about downloading gigabytes again. The sibling then waits for the
// player to look through it, bring it back (the README says how) or remove
// it themselves.
//
// Where the whole folder will not move (a file still held open, which
// Windows does for a moment after a process ends, or Electron's own crash
// handler and GPU cache, which exist by the time the app is ready), each
// entry is moved on its own and whatever stays is named in the outcome, so
// the player hears what was left rather than finding it later.

export const RESET_MARKER = "reset-requested";
// What stays with the app across a reset.
export const KEEP_ACROSS_RESET = ["local-ai", "bin"];

export interface ResetOutcome {
  // Where the previous data went.
  aside: string;
  // Entries that could not be moved and stayed behind, by name.
  left: string[];
}

export function requestReset(userData: string): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, RESET_MARKER), `${new Date().toISOString()}\n`);
}

export function resetPending(userData: string): boolean {
  return fs.existsSync(path.join(userData, RESET_MARKER));
}

export function withdrawReset(userData: string): void {
  fs.rmSync(path.join(userData, RESET_MARKER), { force: true });
}

// Where a reset at `now` puts the old folder: beside it, dated to the second.
export function setAsidePath(userData: string, now: Date): string {
  return `${userData}.set-aside-${now.toISOString().slice(0, 19).replace(/[:.]/g, "-")}`;
}

// Moves every entry of `userData` but KEEP_ACROSS_RESET into `aside`, one
// at a time, and answers which stayed.
export async function moveEntriesAside(userData: string, aside: string): Promise<string[]> {
  const left: string[] = [];
  await fs.promises.mkdir(aside, { recursive: true });
  for (const name of (await fs.promises.readdir(userData)).sort()) {
    if (KEEP_ACROSS_RESET.includes(name)) continue;
    try {
      await moveTree(path.join(userData, name), path.join(aside, name), true);
    } catch {
      left.push(name);
    }
  }
  return left;
}

// Carries out the reset the previous run asked for; null when none was.
export async function applyPendingReset(
  userData: string,
  now = new Date(),
  log: (line: string) => void = console.warn,
): Promise<ResetOutcome | null> {
  if (!resetPending(userData)) return null;
  withdrawReset(userData);
  // A server the previous run never got to stop would hold the tree open.
  await reapStaleServer(path.join(userData, "local-server.pid"), path.join(userData, "local-server", "server.js"), log).catch(
    () => false,
  );
  const aside = setAsidePath(userData, now);
  let whole = true;
  try {
    await moveTree(userData, aside, true);
  } catch (error) {
    whole = false;
    log(`[reset] the data folder would not move as one (${(error as NodeJS.ErrnoException).code ?? String(error)}); moving its entries one by one`);
  }
  let left: string[] = [];
  if (whole) {
    await fs.promises.mkdir(userData, { recursive: true });
    for (const name of KEEP_ACROSS_RESET) {
      const kept = path.join(aside, name);
      if (!fs.existsSync(kept)) continue;
      await moveTree(kept, path.join(userData, name), true).catch(() => log(`[reset] ${name} stayed in the set-aside folder`));
    }
  } else {
    left = await moveEntriesAside(userData, aside);
  }
  log(`[reset] the app's data was set aside at ${aside}${left.length ? `; left behind: ${left.join(", ")}` : ""}`);
  return { aside, left };
}
