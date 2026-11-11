import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { folderBytes, packageBin } from "../scripts/package-bin.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// import() takes a URL, and on Windows an absolute path ("C:\...") is not
// one: Node stops with ERR_UNSUPPORTED_ESM_URL_SCHEME. Client PR #109 found
// two in mobile/scripts/build-www.mjs; a generated import in a test probe
// was the same fault. Every import of a computed file goes through
// pathToFileURL(...).href.
test("no script or test imports a raw file path", () => {
  const offenders = [];
  for (const dir of ["scripts", path.join("mobile", "scripts"), "tests"]) {
    for (const name of fs.readdirSync(path.join(repo, dir))) {
      if (!/\.(mjs|js|ts)$/.test(name)) continue;
      const text = fs.readFileSync(path.join(repo, dir, name), "utf8");
      if (/\bimport\(\s*path\./.test(text) || /from \$\{JSON\.stringify\(path\./.test(text)) offenders.push(path.join(dir, name));
    }
  }
  assert.deepEqual(offenders, []);
});

// node_modules/.bin holds shell scripts, and a .cmd on Windows that execFile
// cannot start without a shell; du is not there at all. npm run
// bundle-server, a step of the README's build from source, stopped on both.
test("no build script starts a .bin shim or du", () => {
  const offenders = [];
  for (const dir of ["scripts", path.join("mobile", "scripts")]) {
    for (const name of fs.readdirSync(path.join(repo, dir))) {
      if (!name.endsWith(".mjs")) continue;
      const text = fs.readFileSync(path.join(repo, dir, name), "utf8");
      if (/["']\.bin["']/.test(text) || /execFileSync\(\s*["']du["']/.test(text)) offenders.push(path.join(dir, name));
    }
  }
  assert.deepEqual(offenders, []);
});

test("a package's command resolves to its own JavaScript entry", () => {
  const modules = path.join(repo, "node_modules");
  const rebuild = packageBin(modules, "@electron/rebuild", "electron-rebuild");
  assert.ok(fs.existsSync(rebuild), rebuild);
  assert.doesNotMatch(rebuild, /[\\/]\.bin[\\/]/);
  assert.ok(fs.existsSync(packageBin(modules, "esbuild")));
  assert.throws(() => packageBin(modules, "esbuild", "nothing-by-that-name"), /no "nothing-by-that-name" command/);
  assert.ok(folderBytes(path.join(repo, "scripts")) > 0);
});
