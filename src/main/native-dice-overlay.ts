import type { BrowserWindow, HandlerDetails, WindowOpenHandlerResponse } from "electron";

// Only the trusted shell installs this handler; sandboxed addon frames cannot open popups.
export function nativeDiceOverlay(owner: BrowserWindow) {
  let overlay: BrowserWindow | null = null;
  const sync = () => {
    if (!overlay || overlay.isDestroyed() || owner.isDestroyed()) return;
    overlay.setBounds(owner.getContentBounds(), false);
    if (owner.isVisible() && !owner.isMinimized() && owner.isFocused()) overlay.showInactive();
    else overlay.hide();
  };
  owner.webContents.on("did-create-window", (child, details) => {
    if (details.frameName !== "odm-native-dice-overlay") return;
    overlay = child;
    child.setIgnoreMouseEvents(true, { forward: true });
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.webContents.on("will-navigate", event => event.preventDefault());
    child.on("closed", () => { if (overlay === child) overlay = null; });
    sync();
  });
  owner.on("move", sync);
  owner.on("resize", sync);
  owner.on("show", sync);
  owner.on("restore", sync);
  owner.on("focus", sync);
  owner.on("enter-full-screen", sync);
  owner.on("leave-full-screen", sync);
  const hide = () => { if (overlay && !overlay.isDestroyed()) overlay.hide(); };
  owner.on("hide", hide);
  owner.on("minimize", hide);
  owner.on("blur", hide);
  owner.once("closed", () => { if (overlay && !overlay.isDestroyed()) overlay.destroy(); });
  return ({ url, frameName }: HandlerDetails): WindowOpenHandlerResponse | null => {
    if (process.platform !== "win32" || url !== "about:blank" || frameName !== "odm-native-dice-overlay") return null;
    if (overlay && !overlay.isDestroyed()) return { action: "deny" };
    return { action: "allow", overrideBrowserWindowOptions: {
      ...owner.getContentBounds(), parent: owner, frame: false, transparent: true,
      backgroundColor: "#00000000", show: false, focusable: false, skipTaskbar: true,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, zoomFactor: 1 },
    } };
  };
}
