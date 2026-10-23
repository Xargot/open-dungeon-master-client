import { Menu, type App, type ContextMenuParams, type MenuItemConstructorOptions } from "electron";

// Text editing in every page the app shows: the shell, the native game
// screens, a server's own pages in the layered view, the table window.
//
// The Edit menu is what makes Cmd+C, Cmd+V, Cmd+X, Cmd+A and Cmd+Z work on
// macOS at all: Electron routes those keys through the menu's roles, and an
// app menu without Edit leaves every text field deaf to them (pasting a prompt
// into WorldForge did nothing). Windows and Linux take Ctrl+V without it, but
// no platform offers a right-click menu unless the app builds one, so a
// right-click in a field opens Cut, Copy and Paste here.

export function editMenu(): MenuItemConstructorOptions {
  return {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };
}

export type ContextFacts = Pick<ContextMenuParams, "isEditable" | "selectionText"> & {
  editFlags: Pick<ContextMenuParams["editFlags"], "canCut" | "canCopy" | "canPaste" | "canSelectAll">;
};

// What a right-click offers: a text field its editing, selected text a copy,
// anything else nothing (no menu at all, rather than an empty one).
export function contextMenuItems(facts: ContextFacts): MenuItemConstructorOptions[] {
  if (facts.isEditable) {
    return [
      { role: "cut", enabled: facts.editFlags.canCut },
      { role: "copy", enabled: facts.editFlags.canCopy },
      { role: "paste", enabled: facts.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: facts.editFlags.canSelectAll },
    ];
  }
  if (facts.selectionText.trim()) return [{ role: "copy" }];
  return [];
}

// Every web contents the app makes, now and later, gets the right-click menu.
export function wireContextMenus(app: App): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("context-menu", (_menuEvent, params) => {
      const items = contextMenuItems(params);
      if (items.length) Menu.buildFromTemplate(items).popup();
    });
  });
}
