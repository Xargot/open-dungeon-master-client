// The desktop signs its portal cookies (src/main/local-server.ts,
// portalSignature) and the server it bundles forwards data calls only when
// the signature matches (the server's src/lib/portal.ts). Checked against
// the server checkout the apps are built from, so the two cannot drift.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { LocalServer } from "../dist/main/local-server.js";
import { PORTAL_ORIGIN_COOKIE, PORTAL_SIG_COOKIE, PORTAL_TOKEN_COOKIE } from "../dist/shared/portal-logic.js";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.resolve(process.env.ODM_SERVER_DIR ?? path.join(repo, "..", "open-dungeon-master"));
const serverPortal = path.join(serverDir, "src", "lib", "portal.ts");

test("the shell's signature is the one the bundled server accepts", async (t) => {
  if (!fs.existsSync(serverPortal)) {
    t.skip(`no server checkout at ${serverDir}`);
    return;
  }
  const portal = await import(pathToFileURL(serverPortal).href);
  if (typeof portal.portalSignature !== "function") {
    t.skip("this server checkout predates signed portal cookies");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-portal-sig-"));
  try {
    const local = new LocalServer(path.join(dir, "payload"), dir, path.join(dir, "renderer"));
    const token = "abcdefghijklmnopqrstuvwxyz0123456789_-";
    const host = "https://Play-Abcd.Example.com/";
    const signature = local.portalSignature(host, token);
    const secret = fs.readFileSync(path.join(dir, "data", "portal-key"), "utf8").trim();
    assert.ok(secret.length >= 32);
    if (process.platform !== "win32") {
      assert.equal((fs.statSync(path.join(dir, "data", "portal-key")).mode & 0o777).toString(8), "600");
    }
    const jar = { [PORTAL_ORIGIN_COOKIE]: host, [PORTAL_TOKEN_COOKIE]: token, [PORTAL_SIG_COOKIE]: signature };
    assert.deepEqual(portal.portalFromCookies((name) => jar[name], secret), {
      origin: "https://play-abcd.example.com",
      token,
    });
    // The same key on the next start, so open portal views keep working.
    assert.equal(new LocalServer(path.join(dir, "payload"), dir, path.join(dir, "renderer")).portalSignature(host, token), signature);
    // Without the key (a hosted server) the same cookies forward nothing.
    assert.equal(portal.portalFromCookies((name) => jar[name], undefined), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
