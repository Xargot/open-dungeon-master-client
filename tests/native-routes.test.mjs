import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.resolve(process.env.ODM_SERVER_DIR ?? path.join(repo, "..", "open-dungeon-master"));

// The server pages the apps open the old way, on purpose: the legal pages,
// which read the same anywhere.
const OPENED_THE_OLD_WAY = new Set(["/licenses", "/privacy", "/terms"]);

// Every page of the server a player reaches has a native screen. A page
// added on the server with no route here is handed to the shell's fallback
// in the apps, which a server rebuild alone never fixes: the library's build
// editor (server issue 229) was one.
function serverPages(dir, base = "") {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "api" || entry.name.startsWith("_") || entry.name.startsWith("(")) continue;
      const segment = /^\[(.+)\]$/.exec(entry.name);
      found.push(...serverPages(path.join(dir, entry.name), `${base}/${segment ? `:${segment[1]}` : entry.name}`));
    } else if (entry.name === "page.tsx") {
      found.push(base || "/");
    }
  }
  return found;
}

test("every server page a player opens has a native screen", { skip: !fs.existsSync(path.join(serverDir, "src", "app")) }, () => {
  const source = fs.readFileSync(path.join(repo, "src", "renderer", "game", "index.tsx"), "utf8");
  const routed = new Set([...source.matchAll(/pattern: "([^"]+)"/g)].map((match) => match[1]));
  const missing = serverPages(path.join(serverDir, "src", "app"))
    .filter((page) => !OPENED_THE_OLD_WAY.has(page))
    .filter((page) => !routed.has(page));
  assert.deepEqual(missing, [], `server pages with no native screen: ${missing.join(", ")}`);
});

// The server's root layout mounts the host that draws appConfirm and
// appNotice; the apps compile the pages without that layout, so the game
// root mounts it itself. Without it every question a page asked (Discard
// this copy, deleting a campaign) fell back to the web view's bare confirm().
test("the game root mounts the host's confirm dialog, as the root layout does", { skip: !fs.existsSync(path.join(serverDir, "src", "app", "layout.tsx")) }, () => {
  const layout = fs.readFileSync(path.join(serverDir, "src", "app", "layout.tsx"), "utf8");
  assert.match(layout, /<ConfirmHost \/>/, "the server's layout no longer mounts ConfirmHost; recheck what the apps need");
  const source = fs.readFileSync(path.join(repo, "src", "renderer", "game", "index.tsx"), "utf8");
  assert.match(source, /import \{ ConfirmHost \} from "@\/components\/ui\/ConfirmDialog";/);
  assert.match(source, /<ConfirmHost \/>/);
});
