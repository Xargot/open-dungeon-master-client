// The payload prune keeps what the server runs and drops what the repo
// carries: docs and plans, scripts, sources, agent notes, CI and Docker
// files. Both bundlers rely on it, so the claim is checked on a staged tree.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { KEEP, KEEP_IN_SRC, pruneAmbienceLibrary, pruneServerPayload } from "../scripts/prune-server-payload.mjs";

function stage(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-prune-"));
  for (const rel of entries) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "x");
  }
  return dir;
}

test("everything outside the keep-list goes, and the bundled worlds survive", () => {
  const dir = stage([
    ".next/server/app/page.js",
    "node_modules/next/package.json",
    "public/assets/placeholders/plain.webp",
    "server.js",
    "package.json",
    "odm-payload.json",
    "LICENSE",
    "docs/workshop-parity-audit.md",
    "docs/ROADMAP.md",
    "scripts/test-dice.mjs",
    "workers/j-redirector/index.js",
    "src/lib/worlds/bundled/high-fantasy.json",
    "src/lib/db/core.ts",
    "src/app/page.tsx",
    "README.md",
    "CLAUDE.md",
    "AGENTS.md",
    "Dockerfile",
    ".env.example",
    ".github/workflows/ci.yml",
    "package-lock.json",
  ]);
  try {
    const dropped = pruneServerPayload(dir);
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, [
      ".next",
      "LICENSE",
      "node_modules",
      "odm-payload.json",
      "package.json",
      "public",
      "server.js",
      "src",
    ]);
    for (const entry of left) {
      assert.ok(entry === "src" || KEEP.has(entry), `${entry} survived without being kept`);
    }
    assert.ok(fs.existsSync(path.join(dir, "src", KEEP_IN_SRC, "high-fantasy.json")));
    assert.ok(!fs.existsSync(path.join(dir, "src", "lib", "db")));
    assert.ok(!fs.existsSync(path.join(dir, "src", "app")));
    assert.ok(dropped.includes("docs"));
    assert.ok(dropped.includes("CLAUDE.md"));
    assert.ok(dropped.includes("src (except " + KEEP_IN_SRC + ")"));
    // Sorted, so the bundler's log line is stable.
    assert.deepEqual(dropped, [...dropped].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a payload with no src at all prunes without complaint", () => {
  const dir = stage(["server.js", "package.json", "docs/plan.md"]);
  try {
    assert.deepEqual(pruneServerPayload(dir), ["docs"]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["package.json", "server.js"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import {
  dedupeChunks,
  dropLocalAssets,
  pruneBuildTraces,
  pruneDeadFiles,
  pruneGpuProviders,
  pruneNamedModuleDirs,
  readLocalAssetManifest,
} from "../scripts/prune-server-payload.mjs";

test("the build's file-trace manifests and the GPU providers go with the prune", () => {
  const dir = stage([
    ".next/server/app/api/health/route.js",
    ".next/server/app/api/health/route.js.nft.json",
    ".next/server/app/page.js.nft.json",
    ".next/server/chunks/x.js",
    "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1",
    "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so",
    "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_tensorrt.so",
    "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_shared.so",
    "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_providers_cuda.dll",
    "server.js",
    "package.json",
  ]);
  try {
    const dropped = pruneServerPayload(dir);
    assert.ok(dropped.includes(".next/server/**/*.nft.json (2)"), dropped.join(", "));
    assert.ok(dropped.includes("onnxruntime GPU providers (2)"), dropped.join(", "));
    assert.ok(fs.existsSync(path.join(dir, ".next/server/app/api/health/route.js")));
    assert.ok(!fs.existsSync(path.join(dir, ".next/server/app/api/health/route.js.nft.json")));
    assert.ok(!fs.existsSync(path.join(dir, ".next/server/app/page.js.nft.json")));
    const bin = path.join(dir, "node_modules/onnxruntime-node/bin/napi-v6/linux/x64");
    assert.deepEqual(fs.readdirSync(bin).sort(), ["libonnxruntime.so.1", "libonnxruntime_providers_shared.so"]);
    // A second run has nothing left to report.
    assert.equal(pruneBuildTraces(dir), 0);
    assert.equal(pruneGpuProviders(dir), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a package is pruned wherever a node_modules holds it", () => {
  const dir = stage([
    "node_modules/@img/sharp-linux-x64/lib/x.node",
    "node_modules/next/node_modules/@img/sharp-libvips-linux-x64/lib/libvips.so",
    "node_modules/next/node_modules/sharp/lib/index.js",
    "node_modules/next/dist/server.js",
    "node_modules/@huggingface/transformers/dist/x.js",
    "node_modules/imgproxy/index.js",
    "public/@img/not-a-module.txt",
  ]);
  try {
    const removed = pruneNamedModuleDirs(dir, ["@img", "sharp", "@huggingface"]);
    assert.deepEqual(removed, [
      "node_modules/@huggingface",
      "node_modules/@img",
      "node_modules/next/node_modules/@img",
      "node_modules/next/node_modules/sharp",
    ]);
    assert.ok(fs.existsSync(path.join(dir, "node_modules/next/dist/server.js")));
    assert.ok(fs.existsSync(path.join(dir, "node_modules/imgproxy/index.js")));
    assert.ok(fs.existsSync(path.join(dir, "public/@img/not-a-module.txt")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the art the shell carries leaves the payload, and only that", () => {
  const dir = stage([
    "public/assets/tiles/floor/grass.webp",
    "public/assets/tiles/floor/stone.webp",
    "public/assets/tiles/manifest.json",
    "public/assets/icons/spell/fireball.webp",
    "public/assets/ambience/rain.mp3",
    "public/fx/loop-sigil.webp",
    "public/icon-512.png",
  ]);
  const manifest = {
    "/assets/tiles/floor/": ["grass.webp", "stone.webp"],
    "/assets/tiles/": ["manifest.json"],
    "/assets/icons/spell/": ["fireball.webp", "not-in-payload.webp"],
    "/fx/": ["loop-sigil.webp"],
  };
  try {
    assert.equal(dropLocalAssets(dir, manifest), 5);
    const left = [];
    const walkDir = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walkDir(full);
        else left.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    };
    walkDir(dir);
    assert.deepEqual(left.sort(), ["public/assets/ambience/rain.mp3", "public/icon-512.png"]);
    // Emptied folders are gone too, but public/ itself stays.
    assert.ok(!fs.existsSync(path.join(dir, "public/assets/tiles")));
    assert.ok(!fs.existsSync(path.join(dir, "public/fx")));
    assert.ok(fs.existsSync(path.join(dir, "public")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the renderer's manifest is read from beside its game bundle", () => {
  const dir = stage(["game/public/manifest.json"]);
  try {
    fs.writeFileSync(path.join(dir, "game/public/manifest.json"), JSON.stringify({ "/fx/": ["a.webp"] }));
    assert.deepEqual(readLocalAssetManifest(dir), { "/fx/": ["a.webp"] });
    assert.equal(readLocalAssetManifest(path.join(dir, "nowhere")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("source maps, declarations, TypeScript sources, readmes and test folders leave; licenses and code stay", () => {
  const dir = stage([
    "node_modules/onnxruntime-common/dist/ort-common.js",
    "node_modules/onnxruntime-common/dist/ort-common.js.map",
    "node_modules/onnxruntime-common/dist/ort-common.d.ts",
    "node_modules/onnxruntime-common/lib/index.ts",
    "node_modules/onnxruntime-common/README.md",
    "node_modules/onnxruntime-common/LICENSE",
    "node_modules/onnxruntime-common/package.json",
    "node_modules/mediasoup/node/lib/test/a.test.js",
    "node_modules/mediasoup/node/lib/index.js",
    "node_modules/mediasoup/test/b.js",
    "node_modules/@jsquash/jpeg/CHANGELOG.md",
    "node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm",
    // A package whose own name is on the dead-folder list keeps its code.
    "node_modules/docs/index.js",
    "node_modules/examples/index.js",
    ".next/server/app/page.js",
    ".next/server/app/page.js.map",
    ".next/static/chunks/main.js",
    "server.js",
    "package.json",
  ]);
  try {
    const dropped = pruneServerPayload(dir);
    assert.ok(dropped.some((line) => line.startsWith("source maps, type declarations, TypeScript sources, readmes and test folders (")), dropped.join(", "));
    const gone = [
      "node_modules/onnxruntime-common/dist/ort-common.js.map",
      "node_modules/onnxruntime-common/dist/ort-common.d.ts",
      "node_modules/onnxruntime-common/lib/index.ts",
      "node_modules/onnxruntime-common/README.md",
      "node_modules/mediasoup/test",
      "node_modules/@jsquash/jpeg/CHANGELOG.md",
      ".next/server/app/page.js.map",
    ];
    for (const rel of gone) assert.ok(!fs.existsSync(path.join(dir, rel)), `${rel} should be gone`);
    const kept = [
      "node_modules/onnxruntime-common/dist/ort-common.js",
      "node_modules/onnxruntime-common/LICENSE",
      "node_modules/onnxruntime-common/package.json",
      "node_modules/mediasoup/node/lib/test/a.test.js",
      "node_modules/mediasoup/node/lib/index.js",
      "node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm",
      "node_modules/docs/index.js",
      "node_modules/examples/index.js",
      ".next/server/app/page.js",
      ".next/static/chunks/main.js",
    ];
    for (const rel of kept) assert.ok(fs.existsSync(path.join(dir, rel)), `${rel} should stay`);
    assert.equal(pruneDeadFiles(dir), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the sound library leaves the payload, the rest of public stays", () => {
  const dir = stage([
    "server.js",
    "package.json",
    "public/ambience/tavern.mp3",
    "public/ambience/battle-2.ogg",
    "public/ambience/manifest.json",
    "public/assets/placeholders/plain.webp",
    "public/uploads/.keep",
  ]);
  try {
    const dropped = pruneServerPayload(dir);
    assert.ok(dropped.includes("public/ambience (2 tracks; the admin panel installs the sound pack)"), dropped.join(", "));
    assert.ok(!fs.existsSync(path.join(dir, "public", "ambience")), "the folder goes whole, manifest included");
    assert.ok(fs.existsSync(path.join(dir, "public", "assets", "placeholders", "plain.webp")));
    assert.ok(fs.existsSync(path.join(dir, "public", "uploads", ".keep")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a payload with no sound library prunes without mentioning one", () => {
  const dir = stage(["server.js", "package.json", "public/assets/icons/a.webp"]);
  try {
    assert.equal(pruneAmbienceLibrary(dir), 0);
    assert.deepEqual(pruneServerPayload(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a chunk Turbopack wrote under several names keeps one copy; the rest hand over its exports", () => {
  const dir = stage(["server.js", "package.json"]);
  // Node reads the nearest package.json when it requires a chunk below.
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  const chunks = path.join(dir, ".next/server/chunks");
  fs.mkdirSync(path.join(chunks, "ssr"), { recursive: true });
  const body = 'module.exports=[[562810,127438,e=>{e.s(["z",0,"zod"],127438)}]];';
  fs.writeFileSync(path.join(chunks, "_1el--tkacnlaz._.js"), `${body}\n\n//# sourceMappingURL=_1el--tkacnlaz._.js.map`);
  fs.writeFileSync(path.join(chunks, "_0p92j0z9au-vu._.js"), `${body}\n\n//# sourceMappingURL=_0p92j0z9au-vu._.js.map`);
  fs.writeFileSync(path.join(chunks, "ssr/_2abc._.js"), `${body}\n`);
  fs.writeFileSync(path.join(chunks, "src_lib_other._.js"), 'module.exports=[[1,e=>{e.s(["a",0,1],1)}]];');
  // The browser-style chunks register themselves; two alike are left alone.
  fs.writeFileSync(path.join(chunks, "ssr/a.js"), '(()=>{"use strict";globalThis.X=1})();');
  fs.writeFileSync(path.join(chunks, "ssr/b.js"), '(()=>{"use strict";globalThis.X=1})();');
  try {
    const dropped = pruneServerPayload(dir);
    assert.ok(dropped.some((line) => line.startsWith(".next/server/chunks duplicates (2 copies, ")), dropped.join(", "));
    // Sorted order keeps the first name; the others require it, from wherever they sit.
    assert.equal(fs.readFileSync(path.join(chunks, "_0p92j0z9au-vu._.js"), "utf8"), `${body}\n\n//# sourceMappingURL=_0p92j0z9au-vu._.js.map`);
    assert.equal(fs.readFileSync(path.join(chunks, "_1el--tkacnlaz._.js"), "utf8"), 'module.exports=require("./_0p92j0z9au-vu._.js");\n');
    assert.equal(fs.readFileSync(path.join(chunks, "ssr/_2abc._.js"), "utf8"), 'module.exports=require("../_0p92j0z9au-vu._.js");\n');
    assert.equal(fs.readFileSync(path.join(chunks, "src_lib_other._.js"), "utf8"), 'module.exports=[[1,e=>{e.s(["a",0,1],1)}]];');
    assert.equal(fs.readFileSync(path.join(chunks, "ssr/b.js"), "utf8"), '(()=>{"use strict";globalThis.X=1})();');
    // Node hands the stub's caller the very array the kept chunk exports.
    const load = createRequire(path.join(chunks, "x.js"));
    assert.equal(load("./_1el--tkacnlaz._.js"), load("./_0p92j0z9au-vu._.js"));
    assert.equal(load("./ssr/_2abc._.js")[0][0], 562810);
    // A second pass finds nothing left to fold.
    assert.deepEqual(dedupeChunks(dir), { count: 0, bytes: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
