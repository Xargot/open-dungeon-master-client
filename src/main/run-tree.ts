import fs from "node:fs";
import path from "node:path";
import { localFolder, type LocalAssetManifest } from "../shared/local-assets";
import { MARKER, PayloadStore } from "./payload-store";

// The desktop payload is staged (scripts/stage-desktop-payload.mjs) in a
// shape electron-builder will package whole, and this puts it back into the
// shape the server runs from. Two things differ between the two:
//
//  - Every node_modules directory is packaged under MODULES_DIR instead:
//    electron-builder silently drops a node_modules folder anywhere inside
//    extraResources, and the server cannot boot without its own.
//  - The hashed-id aliases Turbopack requires external packages under
//    (mediasoup-f2b066850faeed90 and the like) travel as a list in
//    ALIASES_FILE rather than as links, and become junction-style symlinks
//    (linkModuleAliases), which need no privilege on Windows either.
//
// And the art the shell already carries beside its game bundle
// (dist/renderer/game, listed in its manifest) is left out of the payload
// and copied back into the server's public tree, so it ships once.
//
// Where the aliases are made matters. On Windows a junction holds the
// absolute path of its target, worked out when the link is made, so a link
// made while the tree was still being unpacked at local-server.new named a
// folder that stopped existing the moment payload-store.ts renamed the tree
// into place: every external the server loads lazily then failed with
// ERR_MODULE_NOT_FOUND ("Could not load the campaign", server issue #280,
// 0.17.3 to 0.17.5). So materializeRunTree does not link; the device world
// (local-server.ts) links in the tree's final place, before every start,
// and linkModuleAliases replaces an alias that no longer reaches its
// package.

export const MODULES_DIR = "modules";
export const ALIASES_FILE = "odm-module-aliases.json";

export type ModuleAliases = Record<string, string>;

// Copies `payloadDir` into `runDir` and restores it into a runnable server
// tree, short of the alias links, which the caller makes once the tree is
// where it will run (see above). `rendererDir` is where the shell's own
// bundle lives (dist/renderer, inside app.asar when packaged); when it has
// no manifest the payload is taken as complete. Asynchronous, so the copy
// (the server, its modules and the art) never holds Electron's main process;
// and the payload's marker (odm-payload.json) is written last, so a tree is
// only ever taken for a finished one once everything else is in it
// (payload-store.ts).
export async function materializeRunTree(payloadDir: string, runDir: string, rendererDir: string): Promise<void> {
  const marker = path.join(payloadDir, MARKER);
  await fs.promises.cp(payloadDir, runDir, { recursive: true, filter: (source) => source !== marker });
  restoreModuleDirs(runDir);
  await restoreLocalAssets(runDir, rendererDir);
  if (fs.existsSync(marker)) {
    await PayloadStore.writeMarker(runDir, await fs.promises.readFile(marker));
  }
}

// Renames every MODULES_DIR back to node_modules, deepest first so a
// rename never invalidates a path still to be visited.
export function restoreModuleDirs(root: string): number {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      walk(full);
      if (entry.name === MODULES_DIR) found.push(full);
    }
  };
  walk(root);
  for (const dir of found) fs.renameSync(dir, path.join(path.dirname(dir), "node_modules"));
  return found.length;
}

// Makes every alias in ALIASES_FILE a link to its package under `root`'s
// node_modules, in place: an alias that already reaches its package is left
// alone, one that reaches nothing (a junction made in local-server.new, or a
// package folder gone) or something else is replaced, and a plain folder at
// an alias name is somebody's own and left alone. Answers how many links it
// made. Cheap when all is well, so it runs before every start.
export function linkModuleAliases(root: string): number {
  const file = path.join(root, ALIASES_FILE);
  if (!fs.existsSync(file)) return 0;
  const aliases = JSON.parse(fs.readFileSync(file, "utf8")) as ModuleAliases;
  const modules = path.join(root, "node_modules");
  let made = 0;
  for (const [alias, real] of Object.entries(aliases)) {
    const target = path.join(modules, real);
    const link = path.join(modules, alias);
    if (!fs.existsSync(target)) continue;
    const state = aliasState(link, target);
    if (state === "good") continue;
    if (state === "stale") removeLink(link);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(link), target), link, "junction");
    made += 1;
  }
  return made;
}

// What stands at an alias path: nothing, a link (or folder) that reaches
// the package, or a link that reaches nothing or the wrong place. Resolved
// through the OS (realpath native) so a junction's stored path and a
// folder's own path compare equal on Windows whatever their case.
function aliasState(link: string, target: string): "missing" | "good" | "stale" {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(link);
  } catch {
    return "missing";
  }
  if (!stat.isSymbolicLink()) return "good";
  try {
    return fs.realpathSync.native(link) === fs.realpathSync.native(target) ? "good" : "stale";
  } catch {
    return "stale";
  }
}

// Removes a link without touching what it points at. Windows takes a
// directory junction off with either call depending on the Node build, so
// the second is tried when the first refuses.
function removeLink(link: string): void {
  try {
    fs.unlinkSync(link);
  } catch {
    fs.rmdirSync(link);
  }
}

// Reads files one at a time rather than with a recursive copy: the source
// sits inside app.asar when packaged, which Electron's fs only patches for
// the plain read calls (readFile, sync or promised).
export async function restoreLocalAssets(runDir: string, rendererDir: string): Promise<number> {
  const manifestFile = path.join(rendererDir, "game", "public", "manifest.json");
  if (!fs.existsSync(manifestFile)) return 0;
  const manifest = JSON.parse(await fs.promises.readFile(manifestFile, "utf8")) as LocalAssetManifest;
  let copied = 0;
  for (const [hostDir, files] of Object.entries(manifest)) {
    const from = path.join(rendererDir, localFolder(hostDir));
    const to = path.join(runDir, "public", ...hostDir.split("/").filter(Boolean));
    await fs.promises.mkdir(to, { recursive: true });
    for (const file of files) {
      const source = path.join(from, file);
      if (!fs.existsSync(source)) continue;
      await fs.promises.writeFile(path.join(to, file), await fs.promises.readFile(source));
      copied += 1;
    }
  }
  return copied;
}
