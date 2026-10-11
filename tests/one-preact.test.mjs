import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The game screens are the server's React components compiled with Preact.
// Two copies of Preact in one bundle break every Radix `asChild`: an element
// made by one copy is not an element to the other. The mobile build runs from
// mobile/, which has its own Preact, so the check is made from there too.
const PROBE = `
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
const { gameBuildOptions, serverDir } = await import(pathToFileURL(${JSON.stringify(path.join(repo, "scripts", "build-renderer.mjs"))}).href);
const game = gameBuildOptions(serverDir());
const result = await build({ ...game, nodePaths: [...game.nodePaths, ${JSON.stringify(path.join(repo, "mobile", "node_modules"))}], outdir: "out", write: false, metafile: true, logLevel: "silent" });
const roots = new Set(Object.keys(result.metafile.inputs).flatMap((file) => {
  const normalized = file.split(path.sep).join("/");
  const marker = "node_modules/preact/";
  const index = normalized.lastIndexOf(marker);
  return index >= 0 ? [path.resolve(normalized.slice(0, index))] : [];
}));
console.log(JSON.stringify([...roots]));
`;

for (const cwd of [repo, path.join(repo, "mobile")]) {
  test(`the game bundle carries one Preact when built from ${path.relative(repo, cwd) || "the repo root"}`, {
    skip: process.platform === "win32" && cwd !== repo
      ? "Mobile builds are outside the Windows desktop target"
      : !fs.existsSync(path.join(cwd, "node_modules")),
  }, () => {
    const probe = path.join(repo, "dist", "one-preact-probe.mjs");
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, PROBE);
    try {
      const out = execFileSync(process.execPath, [probe], { cwd, encoding: "utf8" });
      const roots = JSON.parse(out.trim().split("\n").pop());
      assert.equal(roots.length, 1, `Preact was bundled from ${roots.join(" and ")}`);
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });
}

// The painted icons ship inside the app, so the app's own screens (Settings
// draws the audio and dice panel with no host connected) have them.
test("the built app carries the painted icons", () => {
  const glyphs = path.join(repo, "dist", "renderer", "game", "icons", "glyph");
  assert.ok(fs.existsSync(path.join(glyphs, "die-d20.webp")), "dist/renderer/game/icons/glyph/die-d20.webp is missing");
  assert.ok(fs.readdirSync(glyphs).length > 100);
  assert.ok(fs.existsSync(path.join(repo, "dist", "renderer", "game", "icons", "spell")));
});
