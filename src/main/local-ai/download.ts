import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// Shared download plumbing for the local AI installers. Every multi-gigabyte
// artifact goes through the same gate: a free-space check before the first
// byte, byte-range resume (only onto the offset the server confirms), a size
// check against Content-Length, a magic-byte sniff so a 404 HTML page can
// never land named .gguf, and sha256 verified while streaming. A network
// drop or a stall keeps the partial for resume; a failed verification
// deletes it, because those bytes can never become the right file.

export type FileKind = "gguf" | "safetensors" | "archive";

// The first bytes each kind must open with. GGUF is a literal magic;
// safetensors is an 8-byte little-endian header length followed by a JSON
// object; archives are gzip (tar.gz) or zip.
export function magicOk(kind: FileKind, header: Buffer): boolean {
  if (kind === "gguf") {
    return header.length >= 4 && header.toString("latin1", 0, 4) === "GGUF";
  }
  if (kind === "safetensors") {
    return header.length >= 9 && header[8] === 0x7b;
  }
  return (
    header.length >= 2 &&
    ((header[0] === 0x1f && header[1] === 0x8b) || (header[0] === 0x50 && header[1] === 0x4b))
  );
}

export interface HfFile {
  repo: string;
  revision: string;
  file: string;
}

export function hfFileInfo(url: string): HfFile | null {
  const match = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(url);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return { repo: match[1], revision: match[2], file: match[3] };
}

// The Hugging Face tree API lists each LFS file's sha256. It used to be best
// effort: a slow or failed answer quietly dropped the hash check and the
// model was trusted on size and header alone. Now a lookup that fails is a
// failed install the player can retry (the partial download is kept), and
// a file the repository no longer lists is refused.
export async function fetchHfSha256(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): Promise<string> {
  const info = hfFileInfo(url);
  if (!info) throw new Error("That model is not from a source the app can verify.");
  const folder = info.file.includes("/") ? `/${info.file.slice(0, info.file.lastIndexOf("/"))}` : "";
  let files: { path?: string; lfs?: { oid?: string } }[];
  try {
    const res = await fetchImpl(`https://huggingface.co/api/models/${info.repo}/tree/${info.revision}${folder}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(String(res.status));
    files = (await res.json()) as typeof files;
  } catch {
    throw new Error("Could not look up the model's checksum on Hugging Face. Check your connection and try again.");
  }
  const oid = Array.isArray(files) ? files.find((entry) => entry?.path === info.file)?.lfs?.oid : undefined;
  if (typeof oid !== "string" || !/^[0-9a-f]{64}$/.test(oid)) {
    throw new Error("Hugging Face no longer lists that model file, so it was not downloaded.");
  }
  return oid;
}

export async function freeDiskGb(dir: string): Promise<number> {
  const stat = await fs.promises.statfs(dir);
  return (stat.bavail * stat.bsize) / 1024 ** 3;
}

export async function ensureDiskSpace(dir: string, neededGb: number): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  let free: number;
  try {
    free = await freeDiskGb(dir);
  } catch {
    // Exotic filesystems can refuse statfs; the download itself still fails
    // loudly if space actually runs out.
    return;
  }
  if (free < neededGb) {
    throw new Error(
      `Not enough disk space: this needs about ${Math.ceil(neededGb)} GB free, ` +
        `but only ${Math.floor(free)} GB is available here. Free up space and try again.`,
    );
  }
}

export interface DownloadOptions {
  kind: FileKind;
  // Hex sha256 to enforce. Every caller has one now; null still skips the
  // hash and leans on size plus magic.
  sha256?: string | null;
  onProgress: (percent: number) => void;
  // A transfer that sends nothing for this long is dropped (partial kept).
  idleMs?: number;
  fetchImpl?: typeof fetch;
}

const IDLE_MS = 90_000;

// "bytes 100-199/200" -> { start: 100, total: 200 }; total -1 when "*".
function contentRange(header: string | null): { start: number; total: number } | null {
  const match = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec((header ?? "").trim());
  if (!match) return null;
  return { start: Number(match[1]), total: match[2] === "*" ? -1 : Number(match[2]) };
}

function discard(partial: string, message: string): never {
  fs.rmSync(partial, { force: true });
  throw new Error(message);
}

async function streamTo(url: string, partial: string, opts: DownloadOptions): Promise<void> {
  const offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  const idle = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const stillAlive = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => idle.abort(new Error("The download stalled. Try again; it picks up where it stopped.")),
      opts.idleMs ?? IDLE_MS,
    );
  };
  stillAlive();
  try {
    await receive(url, partial, offset, opts, idle.signal, stillAlive);
  } finally {
    clearTimeout(idleTimer);
  }
}

async function receive(
  url: string,
  partial: string,
  offset: number,
  opts: DownloadOptions,
  signal: AbortSignal,
  stillAlive: () => void,
): Promise<void> {
  const response = await (opts.fetchImpl ?? fetch)(url, {
    redirect: "follow",
    headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
    signal,
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`Download failed (${response.status}).`);
  }
  let resumed = response.status === 206;
  // A 206 must say it starts exactly where the partial ends; appending any
  // other range would splice the wrong bytes into the file.
  const range = resumed ? contentRange(response.headers.get("content-range")) : null;
  if (resumed && (!range || range.start !== offset)) {
    await response.body?.cancel().catch(() => undefined);
    fs.rmSync(partial, { force: true });
    return receive(url, partial, 0, opts, signal, stillAlive);
  }
  if (!resumed && offset > 0) fs.rmSync(partial, { force: true });
  resumed = resumed && offset > 0;
  const start = resumed ? offset : 0;
  const hash = opts.sha256 ? crypto.createHash("sha256") : null;
  if (hash && start > 0) {
    // Resumed bytes are already on disk; they must count toward the hash.
    for await (const chunk of fs.createReadStream(partial)) hash.update(chunk as Buffer);
  }
  const total = range && range.total > 0 ? range.total : Number(response.headers.get("content-length") || 0) + start;
  let done = start;
  const counter = new Transform({
    transform: (chunk: Buffer, _encoding, next) => {
      stillAlive();
      done += chunk.length;
      hash?.update(chunk);
      if (total > 0) opts.onProgress((done / total) * 100);
      next(null, chunk);
    },
  });
  if (!response.body) throw new Error("Empty response from the download server.");
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    counter,
    fs.createWriteStream(partial, { flags: resumed ? "a" : "w" }),
  );
  // A truncated stream that ended without erroring would otherwise pass for
  // a complete file. No Content-Length (chunked) skips this; magic and hash
  // still stand guard.
  if (total > start && fs.statSync(partial).size !== total) {
    discard(partial, "The download ended early (size mismatch). Try again.");
  }
  if (hash && opts.sha256 && hash.digest("hex") !== opts.sha256) {
    discard(partial, "The downloaded file failed its checksum. Try again.");
  }
}

// Streams a URL to disk with progress and byte-range resume, so a 20GB model
// survives a dropped connection without starting over, then verifies before
// the file gets its real name.
export async function downloadVerified(
  url: string,
  target: string,
  opts: DownloadOptions,
): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  await streamTo(url, partial, opts);
  const header = Buffer.alloc(16);
  const fd = fs.openSync(partial, "r");
  let read = 0;
  try {
    read = fs.readSync(fd, header, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!magicOk(opts.kind, header.subarray(0, read))) {
    discard(
      partial,
      "The download was not the expected file format (the source may have moved). Try again later.",
    );
  }
  fs.renameSync(partial, target);
}
