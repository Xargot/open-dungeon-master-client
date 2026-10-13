// A server child the shell never got to stop keeps the run tree open, which
// on Windows blocks the next start's payload swap (src/main/stale-server.ts).
// The shell ends it from the pid it wrote, but only a process started from
// the tree's own server.js, never whatever program holds the number now.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { reapStaleServer } from "../dist/main/stale-server.js";

const quiet = () => undefined;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A child ended by a signal keeps a null exitCode, so both are checked.
const exited = (child) =>
  new Promise((resolve) => (child.exitCode === null && child.signalCode === null ? child.once("exit", resolve) : resolve()));

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-stale-server-"));
  return {
    pidFile: path.join(dir, "local-server.pid"),
    serverScript: path.join(dir, "local-server", "server.js"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// A process that sits there like a server would, with `script` on its
// command line the way the shell spawns server.js.
function idle(script) {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", script], { stdio: "ignore" });
}

test("a server left running from this tree is ended and its pid file removed", async () => {
  const { pidFile, serverScript, cleanup } = world();
  const child = idle(serverScript);
  try {
    fs.writeFileSync(pidFile, String(child.pid));
    await settle(200);
    assert.equal(await reapStaleServer(pidFile, serverScript, quiet), true);
    await exited(child);
    assert.ok(!fs.existsSync(pidFile));
  } finally {
    child.kill("SIGKILL");
    cleanup();
  }
});

test("a process that merely has the number now is left alone", async () => {
  const { pidFile, serverScript, cleanup } = world();
  const other = idle(path.join(os.tmpdir(), "somebody-else.js"));
  try {
    fs.writeFileSync(pidFile, String(other.pid));
    await settle(200);
    assert.equal(await reapStaleServer(pidFile, serverScript, quiet), false);
    assert.equal(other.exitCode, null, "still running");
    assert.ok(!fs.existsSync(pidFile), "the stale pid file goes either way");
  } finally {
    other.kill("SIGKILL");
    await exited(other);
    cleanup();
  }
});

test("a pid file for a server that already ended, or none at all, is nothing to do", async () => {
  const { pidFile, serverScript, cleanup } = world();
  try {
    assert.equal(await reapStaleServer(pidFile, serverScript, quiet), false);
    const gone = idle(serverScript);
    gone.kill("SIGKILL");
    await exited(gone);
    fs.writeFileSync(pidFile, String(gone.pid));
    assert.equal(await reapStaleServer(pidFile, serverScript, quiet), false);
    assert.ok(!fs.existsSync(pidFile));
    fs.writeFileSync(pidFile, "not a pid");
    assert.equal(await reapStaleServer(pidFile, serverScript, quiet), false);
  } finally {
    cleanup();
  }
});
