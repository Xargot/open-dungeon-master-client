import type { LocalAiStatus, VerifyReport } from "./types";

// The summary a player copies into a bug report (Settings, Troubleshooting):
// versions, the state of the device world, and whether the server files
// this app unpacked are the ones it shipped with. Plain text, a line per
// fact, and nothing a report should not carry: no names, keys, tokens, log
// lines or campaign text, and paths with the home folder shortened to ~.
// Both shells gather the facts; this lays them out, so the two read alike.

export interface DiagnosticFacts {
  app: { version: string; installKind: string; platform: string; arch: string; os: string; runtime: string };
  // The server payload this build ships, and the one unpacked on disk.
  payload: { serverVersion: string; builtAt: string } | null;
  runTree: { serverVersion: string; builtAt: string } | null;
  world: {
    state: string;
    error: string;
    firstRun: boolean;
    dbPresent: boolean;
    keyPresent: boolean;
    // The ids of the world packs installed in the device world.
    packs: string[];
  };
  // Saved servers, as a count: their addresses are the player's business.
  servers: number;
  // The local AI the app manages: what is installed, whether it answers,
  // and the last thing that went wrong with it. A world that opens fine
  // can still have no storyteller, and the summary used to say nothing
  // about that.
  localAi: Pick<LocalAiStatus, "installedLabel" | "installedTierId" | "running" | "external" | "endpoint" | "error" | "comfy"> | null;
  // The check of the unpacked files: null when this build has no manifest
  // to check against (a development run), "skipped" where it was not run.
  verify: VerifyReport | null | "skipped";
  paths: { userData: string; log: string };
}

// How many wrong files the summary names before it counts the rest.
const NAMED_FILES = 20;

// The word a player types to start over (Settings, Troubleshooting): the
// one action there that takes the world out of the app's hands.
export const RESET_PHRASE = "RESET";

export function redactHome(file: string, home: string): string {
  if (!home || !file.startsWith(home)) return file;
  return `~${file.slice(home.length)}`;
}

// One phrase for a check's outcome, for the summary and the Settings card.
export function describeVerify(report: VerifyReport | null): string {
  if (!report) return "no manifest to check against";
  if (!report.unpacked) return "not unpacked yet";
  const wrong = report.missing.length + report.changed.length;
  if (!wrong) return `all ${report.listed} files present${report.hashed ? " and intact" : ""}`;
  const parts: string[] = [];
  if (report.missing.length) parts.push(`${report.missing.length} missing`);
  if (report.changed.length) parts.push(`${report.changed.length} changed`);
  return `${parts.join(", ")} of ${report.listed}`;
}

// One line each for the story engine and the image engine.
export function describeLocalAi(ai: DiagnosticFacts["localAi"]): string[] {
  if (!ai) return ["Local AI: not available on this device"];
  const story = !ai.installedTierId
    ? "not installed"
    : `${ai.installedLabel || ai.installedTierId} (${ai.installedTierId}), ${
        ai.running ? (ai.external ? `answering at ${ai.endpoint}, started outside the app` : `running at ${ai.endpoint}`) : "stopped"
      }${ai.error ? ` (${ai.error})` : ""}`;
  const images = !ai.comfy.installed
    ? "not installed"
    : `ComfyUI ${ai.comfy.running ? "running" : "stopped"}${ai.comfy.checkpoint ? `, ${ai.comfy.checkpoint}` : ""}${ai.comfy.error ? ` (${ai.comfy.error})` : ""}`;
  return [`Local AI: ${story}`, `Image AI: ${images}`];
}

export function diagnosticSummary(facts: DiagnosticFacts, now = new Date()): string {
  const { app, payload, runTree, world, verify } = facts;
  const stale = payload && runTree && payload.builtAt !== runTree.builtAt;
  const lines = [
    `Open Dungeon Master ${app.version} (${app.installKind}) on ${app.platform} ${app.arch}, ${app.os}, ${app.runtime}`,
    `Written ${now.toISOString()}`,
    `Bundled server: ${payload ? `${payload.serverVersion} built ${payload.builtAt}` : "none"}`,
    `Unpacked server: ${runTree ? `${runTree.serverVersion} built ${runTree.builtAt}` : "not unpacked yet"}${stale ? " (not the bundled build; the next start replaces it)" : ""}`,
    `Server files: ${verify === "skipped" ? "not checked" : describeVerify(verify)}`,
    `World: ${world.state}${world.error ? ` (${world.error})` : ""}${world.firstRun ? ", never entered" : ""}`,
    `World data: database ${world.dbPresent ? "present" : "absent"}, key ${world.keyPresent ? "present" : "absent"}, installed world packs ${world.packs.length ? world.packs.join(", ") : "none"}`,
    `Saved servers: ${facts.servers}`,
    ...describeLocalAi(facts.localAi),
    `Data folder: ${facts.paths.userData}`,
    `Log: ${facts.paths.log}`,
  ];
  if (verify && verify !== "skipped") {
    const named = [...verify.missing.map((file) => `missing ${file}`), ...verify.changed.map((file) => `changed ${file}`)];
    for (const line of named.slice(0, NAMED_FILES)) lines.push(`  ${line}`);
    if (named.length > NAMED_FILES) lines.push(`  and ${named.length - NAMED_FILES} more`);
  }
  return `${lines.join("\n")}\n`;
}
