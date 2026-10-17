import assert from "node:assert/strict";
import test from "node:test";
import { submitJoin } from "../src/renderer/submit-join.ts";

test("a rejected join bridge restores the form and shows an error", async () => {
  const button = { disabled: false };
  const error = { textContent: "" };
  let onErrorCalls = 0;
  await submitJoin(() => Promise.reject(new Error("bridge unavailable")), button, error, () => { onErrorCalls++; });
  assert.equal(button.disabled, false);
  assert.match(error.textContent, /could not|try again|bridge unavailable/i);
  assert.equal(onErrorCalls, 1);
});

test("a join result error restores the form", async () => {
  const button = { disabled: false };
  const error = { textContent: "" };
  await submitJoin(() => Promise.resolve("No table is online"), button, error);
  assert.equal(button.disabled, false);
  assert.equal(error.textContent, "No table is online");
});

test("a successful join restores the button without showing an error", async () => {
  const button = { disabled: false };
  const error = { textContent: "previous error" };
  let onErrorCalls = 0;
  await submitJoin(() => Promise.resolve(""), button, error, () => { onErrorCalls++; });
  assert.equal(button.disabled, false);
  assert.equal(error.textContent, "");
  assert.equal(onErrorCalls, 0);
});
