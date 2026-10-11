import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalAssetIndex, localFolder } from "../dist/shared/local-assets.js";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// A host path resolves to the app's own copy only when the build's manifest
// lists it; a build whose manifest lists no icons resolves every icon
// locally; everything else goes to the host, which may be newer than the app.
test("the manifest decides which host paths the app answers itself", () => {
  const index = createLocalAssetIndex({
    "/assets/tiles/": ["grass.webp"],
    "/assets/ui/": ["scroll.webp"],
    "/fx/": ["crit-flare.webp"],
  });
  assert.equal(index.localPath("/assets/tiles/grass.webp"), "game/public/assets/tiles/grass.webp");
  assert.equal(index.localPath("/assets/tiles/grass.webp?v=2"), "game/public/assets/tiles/grass.webp", "a query is dropped");
  assert.equal(index.localPath("/assets/tiles/newer.webp"), null, "art the app was not built with comes from the host");
  assert.equal(index.localPath("/assets/tiles/"), null);
  assert.equal(index.localPath("/assets/ui/scroll.webp"), "game/ui-art/scroll.webp", "the sheet's furniture keeps its folder");
  assert.equal(index.localPath("/fx/crit-flare.webp"), "game/public/fx/crit-flare.webp");
  assert.equal(index.localPath("/assets/icons/glyph/die-d20.webp"), "game/icons/glyph/die-d20.webp", "icons need no manifest");
  assert.equal(index.localPath("/uploads/grass.webp"), null);
  assert.equal(index.localPath("//assets/tiles/grass.webp"), null);
  assert.equal(index.localPath("assets/tiles/grass.webp"), null);
});

// Audit C3: once the manifest lists icons, an icon a newer host has and the
// app does not goes to the host instead of a file the app does not carry.
test("a manifest that lists icons sends an unlisted icon to the host", () => {
  const index = createLocalAssetIndex({ "/assets/icons/glyph/": ["die-d20.webp"] });
  assert.equal(index.localPath("/assets/icons/glyph/die-d20.webp"), "game/icons/glyph/die-d20.webp");
  assert.equal(index.localPath("/assets/icons/glyph/newer-glyph.webp"), null);
  assert.equal(index.localPath("/assets/icons/cards/strike.webp"), null);
});

// The build copied every file it listed to where the runtime will look.
test("every manifest entry of the desktop build exists beside the bundle", () => {
  const game = path.join(repo, "dist", "renderer", "game");
  const file = path.join(game, "public", "manifest.json");
  assert.ok(fs.existsSync(file), "dist/renderer/game/public/manifest.json is missing");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const dirs = Object.keys(manifest);
  assert.ok(dirs.includes("/assets/tiles/"), "the tiles were not shipped");
  for (const prefix of ["/assets/ui/", "/assets/icons/", "/fx/", "/dice-box/", "/sidebar-icons/"]) {
    assert.ok(dirs.some((dir) => dir.startsWith(prefix)), `${prefix} was not shipped`);
  }
  assert.ok(!dirs.some((dir) => dir.startsWith("/ambience/")), "ambience is login-gated and must not ship");
  let count = 0;
  for (const [dir, files] of Object.entries(manifest)) {
    assert.deepEqual(files, [...files].sort((a, b) => a.localeCompare(b)), `${dir} is not sorted`);
    for (const name of files) {
      const local = path.join(repo, "dist", "renderer", localFolder(dir), name);
      assert.ok(fs.existsSync(local), `${dir}${name} is listed but ${local} is missing`);
      count += 1;
    }
  }
  assert.ok(count > 3000, `only ${count} files shipped`);
});
