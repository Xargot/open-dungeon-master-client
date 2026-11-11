import assert from "node:assert/strict";
import test from "node:test";
import { keptSecret } from "../dist/shared/kept-secret.js";

// What a sign-in leaves of a made-up password the app keeps (the device
// world's profile, a room-code account), on both shells.
test("a kept password stays with its account until a typed one shows it stale", () => {
  const kept = { username: "wren", secret: "minted" };
  assert.equal(keptSecret(kept, "wren"), "minted", "a renewal or a Discord sign-in proves no password");
  assert.equal(keptSecret(kept, "wren", "minted"), "minted");
  assert.equal(keptSecret(kept, "wren", "hunter22"), undefined, "the password was changed inside the game");
  assert.equal(keptSecret(kept, "kaleb"), undefined, "another account never inherits it");
  assert.equal(keptSecret({ username: "wren", secret: "" }, "wren"), undefined);
  assert.equal(keptSecret(null, "wren"), undefined);
});
