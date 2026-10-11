// Moving the device world to another device (the server's /api/admin/world,
// src/lib/ops/world-archive.ts there): the server packs the world into one
// file, or checks one the person picked, as a job; this starts the job,
// follows its phases and hands back the outcome. Pure, with the HTTP call
// and the clock passed in, so the desktop's main process and the phone's
// bridge share it and the tests drive it.

export interface WorldCounts {
  campaigns: number;
  users: number;
  messages: number;
  files: number;
}

export interface WorldExportResult {
  name: string;
  bytes: number;
  sha256: string;
  counts: WorldCounts;
}

// What a checked archive holds, shown before anything is replaced.
export interface WorldPreview {
  name: string;
  serverVersion: string;
  createdAt: string;
  owner: string;
  counts: WorldCounts;
}

export interface WorldJob {
  kind: "export" | "check";
  phase: string;
  done: boolean;
  error: string;
  export: WorldExportResult | null;
  preview: WorldPreview | null;
}

export type WorldRequest = (method: "GET" | "POST", body?: object) => Promise<{ status: number; data: unknown }>;

const POLL_MS = 400;
const GIVE_UP_MS = 30 * 60_000;

function errorOf(data: unknown): string {
  const error = (data as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : "";
}

function refusal(status: number, data: unknown, fallback: string): Error {
  if (status === 404) return new Error("This world's server is too old to move worlds. Update the app, then try again.");
  return new Error(errorOf(data) || fallback);
}

export async function runWorldJob(
  request: WorldRequest,
  start: { action: "export" } | { action: "check"; name: string },
  onPhase: (phase: string) => void,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now,
): Promise<WorldJob> {
  const started = await request("POST", start);
  if (started.status >= 400) throw refusal(started.status, started.data, "The world could not be moved.");
  const deadline = now() + GIVE_UP_MS;
  let last = "";
  for (;;) {
    const reply = await request("GET");
    if (reply.status >= 400) throw refusal(reply.status, reply.data, "Lost track of the world while it was being moved.");
    const job = (reply.data as { job?: WorldJob | null } | null)?.job;
    if (!job) throw new Error("Lost track of the world while it was being moved.");
    if (job.phase && job.phase !== last) {
      last = job.phase;
      onPhase(job.phase);
    }
    if (job.done) {
      if (job.error) throw new Error(job.error);
      return job;
    }
    if (now() > deadline) throw new Error("Moving the world took too long.");
    await wait(POLL_MS);
  }
}

// Swaps the checked archive in. The server stops taking play when this
// answers; the caller restarts it and signs the owner in with the password
// it sent.
export async function commitWorldImport(request: WorldRequest, name: string, ownerPassword: string): Promise<{ owner: string }> {
  const reply = await request("POST", { action: "commit", name, ownerPassword });
  if (reply.status >= 400) throw refusal(reply.status, reply.data, "The world could not be swapped in.");
  const owner = (reply.data as { owner?: unknown } | null)?.owner;
  if (typeof owner !== "string" || !owner) throw new Error("The world was swapped in, but its owner is unknown.");
  return { owner };
}

export async function discardWorldTransfer(request: WorldRequest): Promise<void> {
  await request("POST", { action: "discard" }).catch(() => undefined);
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// "2 campaigns, 3 accounts, 412 messages and 87 files"
export function describeCounts(counts: WorldCounts): string {
  return `${plural(counts.campaigns, "campaign")}, ${plural(counts.users, "account")}, ${plural(counts.messages, "message")} and ${plural(counts.files, "file")}`;
}

// The question asked before an import replaces the world.
export function describePreview(preview: WorldPreview, locale?: string): string {
  const saved = Number.isFinite(Date.parse(preview.createdAt))
    ? new Date(preview.createdAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
    : "";
  return `${describeCounts(preview.counts)}${saved ? `, saved ${saved}` : ""}. You will play as ${preview.owner}.`;
}

// The file name offered when saving: the server's own, which carries the date.
export function exportFileName(result: Pick<WorldExportResult, "name">): string {
  return /^odm-world-[0-9TZ-]+\.tar\.gz$/.test(result.name) ? result.name : "odm-world.tar.gz";
}
