import fs from "node:fs";
import path from "node:path";
import { createLocalAssetIndex, type LocalAssetIndex, type LocalAssetManifest } from "../shared/local-assets";

// The art the shell carries beside its game bundle, read for the shell's
// own page. The board's painter reads its tiles and props with fetch, and
// the desktop page is a file: fetch does not read the files beside it, and
// the page's own policy (connect-src) allows only hosts. So the page asks
// here instead of asking the host for a picture the app already holds
// (src/renderer/game/runtime.ts). Only a file the build's manifest lists is
// read, and only from inside the bundle's folder.

export type LocalAssetReader = (hostPath: unknown) => Promise<Uint8Array | null>;

const MAX_PATH = 512;

// `rendererDir` is the shell's own bundle (dist/renderer, inside app.asar
// when packaged, which Electron's fs reads through readFile).
export function createLocalAssetReader(rendererDir: string): LocalAssetReader {
  const root = path.join(rendererDir, "game");
  let index: Promise<LocalAssetIndex | null> | null = null;
  const load = async (): Promise<LocalAssetIndex | null> => {
    try {
      const text = await fs.promises.readFile(path.join(root, "public", "manifest.json"), "utf8");
      return createLocalAssetIndex(JSON.parse(text) as LocalAssetManifest);
    } catch {
      // A build with no art beside it: everything comes from the host.
      return null;
    }
  };
  return async (hostPath) => {
    if (typeof hostPath !== "string" || hostPath.length > MAX_PATH) return null;
    index ??= load();
    const rel = (await index)?.localPath(hostPath);
    if (!rel) return null;
    const file = path.resolve(rendererDir, rel);
    if (!file.startsWith(root + path.sep)) return null;
    try {
      return await fs.promises.readFile(file);
    } catch {
      return null;
    }
  };
}
