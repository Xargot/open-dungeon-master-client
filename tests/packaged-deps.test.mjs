import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// electron-builder packs every package under "dependencies", with its whole
// tree, into each desktop installer. The game screens' packages are compiled
// into the renderer bundle at build time and belong under devDependencies:
// pdfjs-dist sat under "dependencies" for two releases and every installer
// carried it and its native canvas add-on (105 MB on Linux) for nothing. So
// a runtime dependency has to be one the main process or a preload loads.
test("every runtime dependency is loaded by the main process or a preload", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) sources.push(fs.readFileSync(full, "utf8"));
    }
  };
  for (const folder of ["main", "preload", "shared"]) walk(path.join(repo, "dist", folder));
  const all = sources.join("\n");
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const loaded = all.includes(`require("${name}")`) || all.includes(`require("${name}/`) || all.includes(`import("${name}")`);
    assert.ok(loaded, `"${name}" is under dependencies but nothing in dist/main, dist/preload or dist/shared loads it: move it to devDependencies, or every installer ships it`);
  }
});
