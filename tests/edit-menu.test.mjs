import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import Module from "node:module";

// edit-menu.js imports electron for Menu; the templates are pure, so a stub
// stands in for it under node.
const require = createRequire(import.meta.url);
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return { Menu: { buildFromTemplate: () => ({ popup() {} }) } };
  return load.call(this, request, ...rest);
};
const { contextMenuItems, editMenu } = require("../dist/main/edit-menu.js");
Module._load = load;

const flags = (on) => ({ canCut: on, canCopy: on, canPaste: on, canSelectAll: on });

test("the Edit menu carries the roles macOS needs for Cmd+V, Cmd+C, Cmd+X, Cmd+A and Cmd+Z", () => {
  const roles = editMenu().submenu.map((item) => item.role).filter(Boolean);
  assert.deepEqual(roles, ["undo", "redo", "cut", "copy", "paste", "selectAll"]);
});

test("a right-click in a text field offers cut, copy, paste and select all, as the field allows", () => {
  const items = contextMenuItems({ isEditable: true, selectionText: "", editFlags: { ...flags(false), canPaste: true, canSelectAll: true } });
  assert.deepEqual(items.map((item) => item.role ?? item.type), ["cut", "copy", "paste", "separator", "selectAll"]);
  assert.deepEqual(items.filter((item) => item.role).map((item) => item.enabled), [false, false, true, true]);
});

test("selected text offers a copy; anywhere else no menu opens", () => {
  assert.deepEqual(contextMenuItems({ isEditable: false, selectionText: "Gullhaven", editFlags: flags(false) }), [{ role: "copy" }]);
  assert.deepEqual(contextMenuItems({ isEditable: false, selectionText: "  ", editFlags: flags(false) }), []);
});
