import fs from "node:fs";
import path from "node:path";

// Where the desktop's unpacked server lives and how a new payload replaces
// it without ever holding the only copy of player data in a folder that is
// about to be deleted. The same layout and the same guarantees as the
// Android app's PayloadStore.java, which this follows step for step:
//
//   local-server/       the live tree; odm-payload.json inside it is the commit marker
//   local-server.new    a payload being unpacked; complete once its marker exists
//   local-server.old    the previous tree during the swap, deleted last
//   local-server.keep   what the older copy-based upgrade used; merged back if found
//
// The copy-based upgrade this replaces copied the player's folders into
// .keep, deleted the live tree, unpacked the new one, and copied .keep back.
// The next start deleted .keep before looking at it, so a crash after the
// live tree was gone erased the only copy of every upload and painting. And
// every copy ran synchronously on Electron's main process, freezing the
// window for as long as the player's media took to copy, twice.
//
// An upgrade unpacks into .new (marker written last), moves the PRESERVED
// folders across by rename (the same disk, so no copy), renames the live
// tree to .old and .new into its place, then deletes .old. recover() runs
// before every start and finishes or unwinds whatever an earlier run left.

export const MARKER = "odm-payload.json";

// Windows holds a file or folder for a moment after the program using it
// has gone, and Defender and the search indexer open the files an unpack
// just wrote, so a rename or delete there fails with EPERM or EBUSY and
// succeeds a moment later; Linux calls a folder nobody may write into
// EACCES. Those are retried, for about five seconds. Anything else (another
// disk, a missing source) is not. Tests shorten the wait.
const LOCK_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
export const lockPatience = { attempts: 20, delayMs: 250 };

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function code(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? "";
}

export type Unpack = (dir: string) => Promise<void>;

export class PayloadStore {
  readonly server: string;
  readonly fresh: string;
  readonly old: string;
  readonly keep: string;

  constructor(
    runDir: string,
    // Player-made data inside the server tree that must survive an upgrade.
    private readonly preserved: readonly string[],
  ) {
    this.server = runDir;
    this.fresh = `${runDir}.new`;
    this.old = `${runDir}.old`;
    this.keep = `${runDir}.keep`;
  }

  static hasMarker(dir: string): boolean {
    try {
      return fs.statSync(path.join(dir, MARKER)).isFile();
    } catch {
      return false;
    }
  }

  // Writes the marker through a temp name so a torn write never passes for
  // a finished unpack.
  static async writeMarker(dir: string, bytes: Buffer | string): Promise<void> {
    const part = path.join(dir, `${MARKER}.part`);
    await fs.promises.writeFile(part, bytes);
    await fs.promises.rename(part, path.join(dir, MARKER));
  }

  // Puts the tree back into a consistent shape after an interrupted upgrade.
  // Cheap when there is nothing to do, so it runs every start. Order
  // matters: a leftover .keep or .old is folded into the live tree first, so
  // that a complete .new then swaps in over a tree that holds everything the
  // player made.
  async recover(): Promise<void> {
    if (isDirectory(this.keep)) {
      // The copy-based upgrade died between deleting the live tree and
      // copying back.
      if (isDirectory(this.server)) await this.movePreserved(this.keep, this.server, true);
      else await rename(this.keep, this.server);
      await deleteTree(this.keep);
    }
    if (isDirectory(this.old)) {
      // The swap got past renaming the live tree aside. Anything preserved
      // still inside it was never moved out, so it wins over the new tree.
      if (isDirectory(this.server)) await this.movePreserved(this.old, this.server, true);
      else await rename(this.old, this.server);
      await discardOldTree(this.old);
    }
    if (isDirectory(this.fresh)) {
      if (PayloadStore.hasMarker(this.fresh)) {
        // Unpack finished; the moves and the swap may be part way through.
        if (isDirectory(this.server)) {
          await this.movePreserved(this.server, this.fresh, true);
          await this.swap();
        } else {
          await rename(this.fresh, this.server);
        }
      } else {
        // Unpack was interrupted before the marker, so nothing of the
        // player's was moved in yet. Fill any gap in the live tree from it
        // rather than trust that, then drop it.
        if (isDirectory(this.server)) await this.movePreserved(this.fresh, this.server, false);
        await deleteTree(this.fresh);
      }
    }
  }

  // Replaces the live tree with a freshly unpacked payload, keeping the
  // PRESERVED folders.
  async upgrade(unpack: Unpack): Promise<void> {
    await this.recover();
    await fs.promises.mkdir(this.fresh, { recursive: true });
    try {
      await unpack(this.fresh);
      if (!PayloadStore.hasMarker(this.fresh)) throw new Error(`The payload has no ${MARKER}`);
    } catch (error) {
      // Nothing of the player's has moved yet, so the half-written tree can go.
      await deleteTree(this.fresh);
      throw error;
    }
    if (isDirectory(this.server)) {
      await this.movePreserved(this.server, this.fresh, true);
      await this.swap();
    } else {
      await rename(this.fresh, this.server);
    }
  }

  private async swap(): Promise<void> {
    await rename(this.server, this.old);
    await rename(this.fresh, this.server);
    await discardOldTree(this.old);
  }

  private async movePreserved(from: string, to: string, overwrite: boolean): Promise<void> {
    for (const rel of this.preserved) {
      const source = path.join(from, rel);
      if (exists(source)) await moveTree(source, path.join(to, rel), overwrite);
    }
  }
}

function exists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

async function rename(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      if (!LOCK_CODES.has(code(error)) || attempt >= lockPatience.attempts) throw error;
      await delay(lockPatience.delayMs);
    }
  }
}

export async function deleteTree(target: string): Promise<void> {
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: lockPatience.attempts, retryDelay: lockPatience.delayMs });
}

// The tree a swap has replaced holds nothing the player needs any more, so
// a lock that outlasts the retries is noted and left for the next start's
// recover() rather than failing this start with the new tree in place.
async function discardOldTree(target: string): Promise<void> {
  try {
    await deleteTree(target);
  } catch (error) {
    console.warn(`[payload-store] ${target} could not be removed yet; the next start will try again`, error);
  }
}

// Moves a file or directory by rename when it can, copying only when the
// rename fails because the target is on another disk (EXDEV), and merges
// into whatever already exists at the target. With overwrite false, files
// already at the target are left alone. A locked source is retried by
// rename() and then fails outright: copying around a lock and deleting
// what could be deleted would leave the player's files split across two
// trees.
export async function moveTree(from: string, to: string, overwrite: boolean): Promise<void> {
  if (!exists(to)) {
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (code(error) !== "EXDEV") throw error;
      await fs.promises.cp(from, to, { recursive: true });
      await deleteTree(from);
      return;
    }
  }
  if (isDirectory(from) && isDirectory(to)) {
    for (const child of await fs.promises.readdir(from)) {
      await moveTree(path.join(from, child), path.join(to, child), overwrite);
    }
    await fs.promises.rmdir(from).catch(() => undefined);
    return;
  }
  if (!overwrite) return;
  await deleteTree(to);
  try {
    await rename(from, to);
  } catch (error) {
    if (code(error) !== "EXDEV") throw error;
    await fs.promises.cp(from, to, { recursive: true });
    await deleteTree(from);
  }
}
