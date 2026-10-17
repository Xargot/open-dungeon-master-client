import assert from "node:assert/strict";
import test from "node:test";
import { harnessDescription, harnessNeedsFixing, harnessStep, harnessTag } from "../dist/shared/harness-card.js";

// A card as the device world's server sends it (its HarnessStatus).
function card(overrides = {}) {
  return {
    id: "opencode",
    label: "opencode",
    installed: true,
    version: "2.0.27",
    auth: { state: "ready" },
    models: [{ id: "llama/qwen", label: "llama/qwen" }],
    lockdown: "removed",
    lockdownProven: true,
    nativeImages: "no",
    availability: "ok",
    installHint: "curl -fsSL https://opencode.ai/v2/install | bash",
    signInHint: "opencode auth login",
    ...overrides,
  };
}

// What the server says of an opencode 1.x it does not drive.
const OLD_OPENCODE = card({
  version: "1.19.0",
  auth: { state: "unknown" },
  models: [],
  message:
    "opencode 1.19.0 is installed; Open Dungeon Master drives opencode 2.x. Upgrade with `opencode upgrade --major` (opencode 1.19 or later), or install it with `curl -fsSL https://opencode.ai/v2/install | bash`.",
});

test("an installed agent that lists no model and says why is not ready: it needs attention, with the server's message", () => {
  assert.equal(harnessNeedsFixing(OLD_OPENCODE), true);
  assert.deepEqual(harnessTag(OLD_OPENCODE), { text: "needs attention", tone: "warn" });
  assert.equal(harnessStep(OLD_OPENCODE), "fix", "the message and the install line, not a model form that would fail every turn");
  assert.equal(harnessDescription(OLD_OPENCODE), `Version 1.19.0. ${OLD_OPENCODE.message}`);
  // A config of its own the server could not read: the probe's error, no version.
  const unreadable = card({
    version: undefined,
    auth: { state: "unknown" },
    models: [],
    message: "/home/dm/.config/opencode/opencode.json could not be read: it is not valid JSON at line 2, column 5.",
  });
  assert.equal(harnessStep(unreadable), "fix");
  assert.deepEqual(harnessTag(unreadable), { text: "needs attention", tone: "warn" });
  assert.equal(harnessDescription(unreadable), unreadable.message);
});

test("a ready agent offers its models, and any message from the server still shows", () => {
  const ready = card();
  assert.equal(harnessNeedsFixing(ready), false);
  assert.deepEqual(harnessTag(ready), { text: "ready", tone: "ok" });
  assert.equal(harnessStep(ready), "models");
  assert.equal(harnessDescription(ready), "Version 2.0.27. Its own tools are removed; it only touches the table's rules.");
  const warned = card({ id: "codex", label: "Codex", lockdown: "contained", auth: { state: "ready", plan: "Plus" }, message: "Codex ignores `tools.view_image`." });
  assert.equal(harnessStep(warned), "models", "a message alone does not stop an agent with models");
  assert.equal(
    harnessDescription(warned),
    "Version 2.0.27. Its own tools are boxed in; it only touches the table's rules. Signed in (Plus). Codex ignores `tools.view_image`.",
  );
  // A program that cannot say whether it is signed in but lists models.
  assert.equal(harnessStep(card({ auth: { state: "unknown" } })), "models");
  assert.equal(harnessStep(card({ auth: { state: "unknown" }, models: [] })), "models", "no message, nothing to show instead");
});

test("an agent not installed, signed out or unavailable gets the step that fixes it", () => {
  const signedOut = card({ auth: { state: "signed-out" }, models: [], message: "opencode has no model it can use outside its own app." });
  assert.equal(harnessStep(signedOut), "signIn");
  assert.deepEqual(harnessTag(signedOut), { text: "sign in needed", tone: "warn" });
  assert.ok(harnessDescription(signedOut).endsWith(" opencode has no model it can use outside its own app."));
  const missing = card({ installed: false, version: undefined, models: [], message: "opencode was not found on this machine." });
  assert.equal(harnessStep(missing), "install");
  assert.deepEqual(harnessTag(missing), { text: "not installed", tone: "off" });
  assert.equal(harnessDescription(missing), "opencode was not found on this machine.");
  assert.equal(harnessDescription(card({ installed: false, message: undefined })), "opencode was not found on this computer.");
  const container = card({ availability: "container", installed: false, message: "This server runs in a container." });
  assert.equal(harnessStep(container), "unavailable");
  assert.deepEqual(harnessTag(container), { text: "not available here", tone: "off" });
});
