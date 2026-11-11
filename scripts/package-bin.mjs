// A package's command as a script this Node runs. node_modules/.bin holds a
// shell script on Linux and macOS and a .cmd on Windows, and execFile cannot
// start a .cmd without a shell (Node refuses since the 2024 spawn fix), so
// `npm run bundle-server` stopped there on Windows. The package's own bin
// entry is plain JavaScript and runs anywhere.
import fs from "node:fs";
import path from "node:path";

export function packageBin(modulesDir, name, command = name) {
  const dir = path.join(modulesDir, ...name.split("/"));
  const { bin } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const file = typeof bin === "string" ? bin : bin?.[command];
  if (!file) throw new Error(`${name} has no "${command}" command.`);
  return path.join(dir, file);
}

// What a folder holds, in bytes, for the build's closing line (du is not on
// Windows). Links are counted as themselves, not followed.
export function folderBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? folderBytes(full) : fs.lstatSync(full).size;
  }
  return total;
}
