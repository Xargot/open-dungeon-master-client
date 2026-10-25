import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// src/renderer/game/autofocus.ts: an element the server's pages render with
// autoFocus takes focus when it first reaches the page, once, as React does
// on the site; Preact alone only writes the attribute, which a browser
// honours once per page load (found by server journey 5 in the app shell).
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundled = await build({
  stdin: {
    contents: 'export { installAutoFocus } from "./src/renderer/game/autofocus.ts"; export { h } from "preact";',
    resolveDir: repo,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  write: false,
  logLevel: "silent",
});
const { installAutoFocus, h } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

// Just enough of an element: focus counts, and it is in the page.
class FakeElement {
  focusCount = 0;
  isConnected = true;
  focus() {
    this.focusCount += 1;
  }
}
globalThis.HTMLElement = FakeElement;
installAutoFocus();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("an element rendered with autoFocus takes focus when it mounts, once", async () => {
  const element = new FakeElement();
  const own = { current: null };
  const vnode = h("input", { autoFocus: true, ref: own });
  assert.equal(typeof vnode.ref, "function", "the ref is wrapped");
  vnode.ref(element);
  assert.equal(own.current, element, "the page's own ref still gets the element");
  await settle();
  assert.equal(element.focusCount, 1);
  // A later render of the same element wraps the ref again: no second focus.
  h("input", { autoFocus: true }).ref(element);
  await settle();
  assert.equal(element.focusCount, 1, "a re-render took focus again");
});

test("a new element with autoFocus focuses too, and a callback ref still runs", async () => {
  const seen = [];
  const element = new FakeElement();
  const vnode = h("textarea", { autoFocus: true, ref: (value) => seen.push(value) });
  vnode.ref(element);
  vnode.ref(null);
  await settle();
  assert.deepEqual(seen, [element, null]);
  assert.equal(element.focusCount, 1);
});

test("an element without autoFocus, or a component, is left alone", () => {
  const own = { current: null };
  assert.equal(h("input", { ref: own }).ref, own);
  const Component = () => null;
  assert.equal(h(Component, { autoFocus: true }).ref, undefined);
});
