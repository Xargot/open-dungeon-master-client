// Dependency advisories with a decision on each (audit S4). Runs `npm audit`
// on the desktop lockfile and the mobile one, and fails on any high or
// critical advisory that scripts/audit-exceptions.json does not list with a
// reason, or lists past its expiry date. The dependency-audit workflow runs
// it weekly and on every lockfile change.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const { exceptions } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "audit-exceptions.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);

function advisoriesIn(dir) {
  let report;
  try {
    report = execFileSync("npm", ["audit", "--json"], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // npm audit exits non-zero whenever it finds anything; the JSON is still on stdout.
    report = error.stdout;
  }
  const found = new Map();
  for (const [name, entry] of Object.entries(JSON.parse(report).vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via === "object" && via.url) {
        const id = via.url.split("/").pop();
        found.set(id, { id, package: via.name ?? name, severity: via.severity, title: via.title, url: via.url });
      }
    }
  }
  return found;
}

const problems = [];
const seen = new Set();
for (const [label, dir] of [
  ["desktop", root],
  ["mobile", path.join(root, "mobile")],
]) {
  const advisories = advisoriesIn(dir);
  for (const advisory of advisories.values()) {
    seen.add(advisory.id);
    if (advisory.severity !== "high" && advisory.severity !== "critical") continue;
    const accepted = exceptions.find((entry) => entry.advisory === advisory.id);
    if (!accepted) {
      problems.push(`${label}: ${advisory.severity} ${advisory.id} in ${advisory.package}: ${advisory.title} (${advisory.url}) has no decision in scripts/audit-exceptions.json`);
    } else if (accepted.expires < today) {
      problems.push(`${label}: ${advisory.id} in ${advisory.package}: the exception expired on ${accepted.expires}; look at it again`);
    }
  }
  console.log(`${label}: ${advisories.size} advisories reported.`);
}
for (const entry of exceptions) {
  if (!seen.has(entry.advisory)) console.log(`note: ${entry.advisory} (${entry.package}) is no longer reported; its exception can go.`);
}
if (problems.length) {
  for (const problem of problems) console.error(`audit: ${problem}`);
  process.exit(1);
}
