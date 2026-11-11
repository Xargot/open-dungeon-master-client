// The built-in art the apps carry beside the game bundle (scripts/
// build-renderer.mjs copies the server's public folders and writes a
// manifest of what it copied). A host path is answered from the local copy
// only when the manifest lists it: a host newer than the app may serve art
// the app does not have, and a missing local file cannot fall back to the
// host once the browser has asked for it. Pure, so tests can feed a manifest.

// Host folder (root-relative, trailing slash) to the file names directly in it.
export type LocalAssetManifest = Record<string, string[]>;

export interface LocalAssetIndex {
  // The address relative to the app's page ("game/public/fx/x.webp") for a
  // host path the app carries, or null when it must come from the host.
  localPath(hostPath: string): string | null;
}

// Where each host folder lives beside the bundle. The painted icons and the
// stylesheet's furniture keep the folders they always had (the shell's own
// sheet points at game/ui-art, and the icons folder predates the manifest);
// everything else mirrors the server's public tree under game/public.
const ICONS = "/assets/icons/";
const UI_ART = "/assets/ui/";

export function localFolder(hostDir: string): string {
  if (hostDir.startsWith(ICONS)) return `game/icons/${hostDir.slice(ICONS.length)}`;
  if (hostDir.startsWith(UI_ART)) return `game/ui-art/${hostDir.slice(UI_ART.length)}`;
  return `game/public${hostDir}`;
}

// Whether a page's fetch for a host file the app carries may be answered
// from the app's own copy. The board's painter reads its tiles and props
// with fetch (the server's src/lib/battlemap/render/painted.ts), and so do
// the PDF reader's worker and data files; left to the host, a board's first
// paint asked it for some 130 pictures the app already holds. Only a plain
// read is answered here, and never a catalogue: a picture at a path is the
// same picture on every host, but a manifest.json lists what that host has,
// and a host newer than the app may list art the app's own copy does not.
export function answersLocally(method: string, hostPath: string): boolean {
  if (method.toUpperCase() !== "GET") return false;
  const clean = hostPath.split(/[?#]/, 1)[0] ?? hostPath;
  return !clean.toLowerCase().endsWith(".json");
}

// The content type a host would name for a carried file, for an answer the
// shell builds itself (the desktop reads the bytes over its bridge).
const CONTENT_TYPES: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  wasm: "application/wasm",
  ttf: "font/ttf",
  woff2: "font/woff2",
};

export function assetContentType(hostPath: string): string {
  const clean = hostPath.split(/[?#]/, 1)[0] ?? hostPath;
  const dot = clean.lastIndexOf(".");
  const extension = dot > clean.lastIndexOf("/") ? clean.slice(dot + 1).toLowerCase() : "";
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export function createLocalAssetIndex(manifest: LocalAssetManifest): LocalAssetIndex {
  const dirs = new Map<string, Set<string>>();
  for (const [dir, files] of Object.entries(manifest)) dirs.set(dir, new Set(files));
  const iconsListed = [...dirs.keys()].some((dir) => dir.startsWith(ICONS));
  return {
    localPath(hostPath) {
      if (!hostPath.startsWith("/") || hostPath.startsWith("//")) return null;
      const clean = hostPath.split(/[?#]/, 1)[0] ?? hostPath;
      // A build whose manifest lists no icons (one from before the rest of
      // the art shipped) resolves every icon locally, as it always did. Once
      // the manifest lists them, an icon a newer host has and this app does
      // not goes to the host like any other unlisted file, instead of
      // pointing at a file the app does not carry.
      if (clean.startsWith(ICONS) && !iconsListed) return localFolder(ICONS) + clean.slice(ICONS.length);
      const cut = clean.lastIndexOf("/") + 1;
      const files = dirs.get(clean.slice(0, cut));
      const file = clean.slice(cut);
      if (!file || !files?.has(file)) return null;
      return localFolder(clean.slice(0, cut)) + file;
    },
  };
}
