import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalAssetReader } from "../dist/main/local-asset-read.js";

// The desktop page cannot fetch the files beside it, so a picture the app
// carries is read for it by the shell: only what the build's manifest
// lists, and only from inside the bundle's folder.
function bundle(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-asset-read-"));
  const game = path.join(dir, "game");
  fs.mkdirSync(path.join(game, "public", "assets", "tiles"), { recursive: true });
  fs.mkdirSync(path.join(game, "icons", "glyph"), { recursive: true });
  fs.writeFileSync(path.join(game, "public", "assets", "tiles", "grass.webp"), "grass");
  fs.writeFileSync(path.join(game, "icons", "glyph", "die.webp"), "die");
  fs.writeFileSync(path.join(dir, "secret.txt"), "outside the bundle");
  if (manifest) fs.writeFileSync(path.join(game, "public", "manifest.json"), JSON.stringify(manifest));
  return dir;
}

test("a listed file is read and an unlisted one is not", async () => {
  const dir = bundle({ "/assets/tiles/": ["grass.webp", "gone.webp"], "/assets/icons/glyph/": ["die.webp"] });
  const read = createLocalAssetReader(dir);
  assert.equal(Buffer.from(await read("/assets/tiles/grass.webp")).toString(), "grass");
  assert.equal(Buffer.from(await read("/assets/tiles/grass.webp?v=2")).toString(), "grass", "a query is dropped");
  assert.equal(Buffer.from(await read("/assets/icons/glyph/die.webp")).toString(), "die", "the icons keep their folder");
  assert.equal(await read("/assets/tiles/newer.webp"), null, "a host's newer art is the host's to send");
  assert.equal(await read("/assets/tiles/gone.webp"), null, "a listed file that is missing reads as not carried");
  assert.equal(await read("/uploads/grass.webp"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("nothing outside the bundle's folder is read", async () => {
  // A manifest that lists no icons resolves every icon path by name
  // (src/shared/local-assets.ts), so the folder check is what holds here.
  const dir = bundle({ "/assets/tiles/": ["grass.webp"] });
  const read = createLocalAssetReader(dir);
  assert.equal(await read("/assets/icons/../../secret.txt"), null);
  assert.equal(await read("/assets/icons/../../../secret.txt"), null);
  assert.equal(await read("/assets/tiles/../../../secret.txt"), null);
  assert.equal(await read(42), null);
  assert.equal(await read(null), null);
  assert.equal(await read(`/assets/tiles/${"a".repeat(600)}.webp`), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a build with no art beside it reads nothing", async () => {
  const dir = bundle(null);
  const read = createLocalAssetReader(dir);
  assert.equal(await read("/assets/tiles/grass.webp"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
