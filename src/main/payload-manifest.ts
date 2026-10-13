import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { VerifyReport } from "../shared/types";
import { MARKER } from "./payload-store";
import { MODULES_DIR } from "./run-tree";

// What the staged payload holds, file by file, so a run tree can be checked
// against the build it came from. The payload's build stamp (odm-payload.json,
// compared at every start) says which build was unpacked, not whether every
// file of it is still there: an antivirus that quarantines a file, a copy
// torn by a crash that got past the marker, a folder somebody tidied by hand,
// all leave a tree whose stamp matches and whose server no longer starts, and
// the only advice a player could be given was to delete their data. The
// staging step (scripts/stage-desktop-payload.mjs) writes this manifest at
// the top of the payload; the shell reads it to check the tree (sizes, or
// the bytes themselves) and rebuilds the tree from the bundled payload when
// it is wrong, keeping everything the player made (local-server.ts
// PRESERVED).
//
// Paths are payload-relative with "/" separators, as staged: every module
// folder is under MODULES_DIR there and under node_modules in the run tree
// (run-tree.ts), and runTreePath() maps one to the other. The art the shell
// restores into the tree from its own bundle and the alias links are not in
// the payload, so they are not listed; nor is the marker, which the unpack
// writes last, nor the manifest itself.

export const MANIFEST = "odm-payload-manifest.json";

export interface ManifestEntry {
  size: number;
  sha256: string;
}

export interface PayloadManifest {
  version: 1;
  files: Record<string, ManifestEntry>;
}

// How many files are read at once while checking a tree.
const WIDTH = 16;
// How many files the staging step hashes at once.
const HASHERS = 8;

const SKIP = new Set([MARKER, MANIFEST]);

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// Every regular file under `dir` (links, the marker and the manifest left
// out), payload-relative, sorted.
export function listPayloadFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (full: string, rel: string): void => {
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(full, entry.name), child);
      else if (entry.isFile() && !(rel === "" && SKIP.has(entry.name))) out.push(child);
    }
  };
  walk(dir, "");
  return out.sort();
}

// Runs `work` over `items` a few at a time.
async function each<T>(items: readonly T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await work(next);
  };
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker));
}

// Writes the manifest for the payload at `dir`, at its top, and returns it.
export async function writePayloadManifest(dir: string): Promise<PayloadManifest> {
  const files: Record<string, ManifestEntry> = {};
  await each(listPayloadFiles(dir), HASHERS, async (rel) => {
    const full = path.join(dir, ...rel.split("/"));
    files[rel] = { size: fs.statSync(full).size, sha256: await hashFile(full) };
  });
  const sorted = Object.fromEntries(Object.keys(files).sort().map((rel) => [rel, files[rel]!]));
  const manifest: PayloadManifest = { version: 1, files: sorted };
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest) + "\n");
  return manifest;
}

// The manifest at the top of a payload, or null when it carries none (a
// development run from vendor/server, or a payload staged before there
// were manifests).
export function readPayloadManifest(dir: string): PayloadManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")) as PayloadManifest;
    if (parsed?.version === 1 && parsed.files && typeof parsed.files === "object") return parsed;
  } catch {
    // None here.
  }
  return null;
}

// Where a payload file lands in the run tree: run-tree.ts renames every
// MODULES_DIR back to node_modules.
export function runTreePath(runDir: string, rel: string): string {
  return path.join(runDir, ...rel.split("/").map((part) => (part === MODULES_DIR ? "node_modules" : part)));
}

// Checks the run tree at `runDir` against the manifest of the payload at
// `payloadDir`: every file's presence and size, and with `hash` its bytes
// too (a file of the right size can still be the wrong file; hashing the
// whole tree takes a second or two, so a start checks sizes and the explicit
// check in Settings hashes). Null when the payload has no manifest. A tree
// without the payload's marker has not been unpacked yet, and there is
// nothing to check: the next start unpacks it.
export async function verifyRunTree(
  payloadDir: string,
  runDir: string,
  options: { hash?: boolean } = {},
): Promise<VerifyReport | null> {
  const manifest = readPayloadManifest(payloadDir);
  if (!manifest) return null;
  const entries = Object.entries(manifest.files);
  const report: VerifyReport = { unpacked: true, listed: entries.length, missing: [], changed: [], hashed: options.hash === true };
  if (!fs.existsSync(path.join(runDir, MARKER))) return { ...report, unpacked: false };
  await each(entries, WIDTH, async ([rel, expected]) => {
    const file = runTreePath(runDir, rel);
    let size = -1;
    try {
      const stat = await fs.promises.stat(file);
      if (stat.isFile()) size = stat.size;
    } catch {
      // Missing.
    }
    if (size < 0) report.missing.push(rel);
    else if (size !== expected.size) report.changed.push(rel);
    else if (options.hash && (await hashFile(file).catch(() => "")) !== expected.sha256) report.changed.push(rel);
  });
  report.missing.sort();
  report.changed.sort();
  return report;
}
