import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const game = path.join(repo, "dist", "renderer", "game");
const glyphDir = path.join(game, "icons", "glyph");

// Every glyph name written in the shell's own screens (the home menu and the
// rest of the renderer, and the phone shell's sources).
function namedGlyphs() {
  const names = new Set();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
        for (const m of fs.readFileSync(full, "utf8").matchAll(/\bglyph:\s*"([a-z0-9]+-[a-z0-9-]+)"/g)) names.add(m[1]);
      }
    }
  };
  walk(path.join(repo, "src", "renderer"));
  walk(path.join(repo, "mobile", "src"));
  return [...names].sort();
}

// The shell draws these from the bundled copy; a name the build did not
// carry shows an empty plate on a phone with no host reachable yet.
test("every glyph the shell names ships with the bundle and is in its manifest", () => {
  const names = namedGlyphs();
  assert.ok(names.includes("ui-new") && names.includes("ui-join"), "the home menu names its glyphs");
  const manifest = JSON.parse(fs.readFileSync(path.join(game, "public", "manifest.json"), "utf8"));
  const listed = new Set(manifest["/assets/icons/glyph/"] ?? []);
  const missing = names.filter((name) => !fs.existsSync(path.join(glyphDir, `${name}.webp`)) || !listed.has(`${name}.webp`));
  assert.deepEqual(missing, []);
});

// The glyphs are carried in every installer and in the Android payload, so
// each must be the server's small WebP, never a full-size original.
test("the shipped UI glyphs are compressed WebP", () => {
  const files = fs.readdirSync(glyphDir).filter((name) => /^(tab|system|ui)-/.test(name));
  assert.ok(files.length >= 77, `only ${files.length} UI glyphs shipped`);
  const heavy = [];
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(glyphDir, name));
    assert.ok(name.endsWith(".webp"), `${name} is not a WebP`);
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "RIFF", `${name} is not a RIFF file`);
    assert.equal(bytes.subarray(8, 12).toString("latin1"), "WEBP", `${name} is not WebP inside`);
    if (bytes.length > 16 * 1024) heavy.push(`${name} ${(bytes.length / 1024).toFixed(1)} KB`);
  }
  assert.deepEqual(heavy, []);
});
