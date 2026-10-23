import path from "node:path";
import { BrowserWindow, Menu, WebContentsView, screen, session, shell, type WebContents, type WebFrameMain } from "electron";
import type { FieldRect } from "../shared/deck";
import type { ShellEvent } from "../shared/types";
import { appIconPath } from "./app-icon";
import { autoConfirmBluetoothPairing, wireBluetoothChooser } from "./bluetooth";
import { editMenu } from "./edit-menu";
import { PORTAL_TOKEN_COOKIE } from "../shared/portal-logic";
import { isShellCookieWrite } from "./session-cookies";

// One window. Its own page is the shell UI (server picker, login, wizard);
// a connected server's web app renders in a WebContentsView layered on top,
// in that server's partition, with no preload and no bridge. Ctrl+M (or the
// View menu) drops back to the shell.

// The server's own words for the errors its Discord callback can end on
// (src/app/AuthForm.tsx keeps the same map), so a refused sign-up says why.
function discordErrorText(code: string): string {
  switch (code) {
    case "signups_disabled":
      return "Signups are disabled on this server.";
    case "invite_required":
      return "This server needs an invite code or a live room code to create an account.";
    case "invite_invalid":
      return "That invite code is not valid (or has been used up).";
    default:
      return "Discord sign-in failed. Try again.";
  }
}

// The shell page's own background (src/renderer/style.css --background),
// painted by every window and view before and between the pages they show.
const SHELL_BACKGROUND = "#0a0817";

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function openExternally(url: string): void {
  if (url.startsWith("https:") || url.startsWith("http:")) void shell.openExternal(url);
}

// Server pages get microphone (voice chat), notifications (session
// reminders and turn alerts), clipboard and fullscreen, and nothing else.
// Requests from any other origin are denied outright.
// The requesting page's parsed origin must match exactly: a prefix test let
// "http://host:3000.evil.example" pass for "http://host:3000".
function hardenPartition(partition: string, origin: string): void {
  const allowed = new Set([
    "media",
    "notifications",
    "clipboard-sanitized-write",
    "fullscreen",
    "pointerLock",
  ]);
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed.has(permission) && sameOrigin(details.requestingUrl, origin));
  });
  // Web Bluetooth (Pixels dice) skips the permission handler; its chooser
  // and pairing prompts are wired per view in attachView.
  autoConfirmBluetoothPairing(ses);
}

export class ShellWindow {
  private win: BrowserWindow | null = null;
  private view: WebContentsView | null = null;
  private currentOrigin = "";
  // The host a portal view forwards to, "" when the view shows a server's
  // own pages or the device world itself.
  private portalHost = "";
  private unwatchCookies: (() => void) | null = null;
  private onRevoked: ((origin: string) => void) | null = null;
  // Set while a browser-based sign-in (Discord OAuth) occupies the view.
  private loginCancel: ((reason: Error) => void) | null = null;

  // Fired when the server's own web UI logs the user out while its view is
  // attached. The window cannot forget the stored token itself (no store
  // access here); index.ts wires the handler where both pieces exist.
  onSessionRevoked(handler: (origin: string) => void): void {
    this.onRevoked = handler;
  }

  // Steam's Game Mode draws one window over the whole screen with no frame,
  // so the app starts full screen there; a Deck in Desktop Mode starts
  // maximized, since the default size is the whole 1280x800 panel and the
  // taskbar would cut it off.
  create(options: { fullscreen?: boolean; maximize?: boolean } = {}): void {
    this.win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      fullscreen: options.fullscreen === true,
      // Shown once the page has painted (ready-to-show below): a window
      // shown at once paints white on Windows until the renderer's first
      // frame, and backgroundColor alone did not cover that.
      show: false,
      backgroundColor: SHELL_BACKGROUND,
      icon: appIconPath(),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const contents = this.win.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      openExternally(url);
      return { action: "deny" };
    });
    // The shell's own page draws the game screens now, so it pairs Pixels
    // dice over Web Bluetooth too: same chooser and pairing prompts as a
    // server's page in its view.
    wireBluetoothChooser(contents, () => this.win);
    autoConfirmBluetoothPairing(contents.session);
    contents.on("will-navigate", (event) => event.preventDefault());
    this.win.on("resize", () => this.layout());
    this.win.on("closed", () => {
      this.win = null;
      this.view = null;
    });
    Menu.setApplicationMenu(this.buildMenu());
    const win = this.win;
    win.once("ready-to-show", () => {
      if (win.isDestroyed()) return;
      if (options.maximize && !options.fullscreen) win.maximize();
      win.show();
    });
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  // A box in the shell page's CSS pixels, in screen pixels: where Steam's
  // keyboard must not cover the field being typed into.
  screenRect(field: FieldRect): FieldRect | null {
    if (!this.win) return null;
    const zoom = this.win.webContents.getZoomFactor();
    const bounds = this.win.getContentBounds();
    const scale = screen.getDisplayMatching(bounds).scaleFactor;
    return {
      x: (bounds.x + field.x * zoom) * scale,
      y: (bounds.y + field.y * zoom) * scale,
      width: field.width * zoom * scale,
      height: field.height * zoom * scale,
    };
  }

  // The table view on a second screen (docs/vtt-parity-implementation-plan.md
  // 13.2 and 18.2): a second shell window on the display the main window is
  // not on, booting straight into the campaign's table route. One at a time;
  // asking again brings the open one forward.
  private tableWin: BrowserWindow | null = null;

  openTableScreen(hostId: string, campaignId: string): boolean {
    if (!hostId || !campaignId) return false;
    if (this.tableWin && !this.tableWin.isDestroyed()) {
      this.tableWin.focus();
      return true;
    }
    const displays = screen.getAllDisplays();
    const here = this.win ? screen.getDisplayMatching(this.win.getBounds()) : screen.getPrimaryDisplay();
    const target = displays.find((display) => display.id !== here.id) ?? here;
    const table = new BrowserWindow({
      x: target.bounds.x,
      y: target.bounds.y,
      width: target.bounds.width,
      height: target.bounds.height,
      fullscreen: displays.length > 1,
      autoHideMenuBar: true,
      show: false,
      backgroundColor: SHELL_BACKGROUND,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        sandbox: true,
      },
    });
    table.webContents.on("will-navigate", (event) => event.preventDefault());
    table.once("ready-to-show", () => {
      if (!table.isDestroyed()) table.show();
    });
    table.on("closed", () => {
      this.tableWin = null;
    });
    this.tableWin = table;
    const query = new URLSearchParams({ table: "1", host: hostId, campaign: campaignId });
    void table.loadFile(path.join(__dirname, "../renderer/index.html"), { search: `?${query.toString()}` });
    return true;
  }

  private buildMenu(): Menu {
    return Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [{ role: "quit" }],
      },
      editMenu(),
      {
        label: "View",
        submenu: [
          {
            label: "Home",
            accelerator: "CmdOrCtrl+M",
            click: () => this.showManager(),
          },
          { type: "separator" },
          { role: "reload" },
          {
            label: "Developer Tools",
            accelerator: "CmdOrCtrl+Shift+I",
            click: () => {
              const contents = this.view?.webContents ?? this.win?.webContents;
              if (!contents) return;
              if (contents.isDevToolsOpened()) contents.closeDevTools();
              else contents.openDevTools({ mode: "detach", activate: true });
            },
          },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
    ]);
  }

  focus(): void {
    if (!this.win) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
  }

  whenPageReady(): Promise<void> {
    const contents = this.win?.webContents;
    if (!contents || !contents.isLoading()) return Promise.resolve();
    return new Promise((resolve) => contents.once("did-finish-load", () => resolve()));
  }

  // True when an IPC message came from one of the shell's own pages (the
  // main window or the table screen), from its top frame and still showing
  // the app's own file: never a server's page in the view on top, a frame
  // inside a page, or a page that somehow got navigated elsewhere.
  isShellPage(event: { sender: WebContents; senderFrame: WebFrameMain | null }): boolean {
    const own = [this.win, this.tableWin].some((w) => !!w && !w.isDestroyed() && w.webContents === event.sender);
    const frame = event.senderFrame;
    return own && !!frame && frame.parent === null && frame.url.startsWith("file:");
  }

  sendEvent(event: ShellEvent): void {
    this.win?.webContents.send("odm:event", event);
  }

  // The window a file dialog belongs to, so it opens over the app.
  dialogParent(): BrowserWindow | null {
    return this.win;
  }

  // The origin of the server page on top, "" when the manager is showing.
  viewOrigin(): string {
    return this.view ? this.currentOrigin : "";
  }

  // True while the local origin on screen is a portal to another host (so
  // the page must not be mistaken for the device world).
  isPortalView(): boolean {
    return !!this.view && !!this.portalHost;
  }

  // Pushes to the game page's preload (src/preload/game.ts).
  sendToGame(channel: string, payload: unknown): void {
    this.view?.webContents.send(channel, payload);
  }

  private layout(): void {
    if (!this.win || !this.view) return;
    const [width, height] = this.win.getContentSize();
    this.view.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 });
  }

  attachView(origin: string, partition: string, pathname: string, portalHost = ""): void {
    if (!this.win) return;
    this.detachView();
    this.portalHost = portalHost;
    hardenPartition(partition, origin);
    // The game preload exposes one thing, window.odmShell.showServers, so
    // the server's own account menu can offer the way back here.
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "../preload/game.js"),
      },
    });
    this.view = view;
    this.currentOrigin = origin;
    // A WebContentsView is white until its page paints, and again between
    // the pages it navigates: dark, like the shell page under it.
    view.setBackgroundColor(SHELL_BACKGROUND);
    this.watchForLogout(partition, origin);
    // The game UI pairs Pixels dice over Web Bluetooth; the shell provides
    // the device chooser Electron does not ship.
    wireBluetoothChooser(view.webContents, () => this.win);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (sameOrigin(url, origin)) {
        void view.webContents.loadURL(url);
      } else {
        openExternally(url);
      }
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      if (!sameOrigin(url, origin)) {
        event.preventDefault();
        openExternally(url);
      }
    });
    this.win.contentView.addChildView(view);
    this.layout();
    void view.webContents.loadURL(`${origin}${pathname}`);
  }

  // Runs a server's own browser sign-in (Discord OAuth) in a throwaway
  // partition and resolves with the session the callback plants as the
  // odm_session cookie. The consent page lives on discord.com, so unlike a
  // game view this one may navigate anywhere over http(s); popups still go
  // to the system browser. Ctrl+M cancels. The view is torn down either
  // way; the caller re-attaches a proper game view with the session.
  browserLogin(
    origin: string,
    partition: string,
    startPath: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const win = this.win;
    if (!win) return Promise.reject(new Error("The window is gone."));
    this.cancelLogin(new Error("Sign-in was interrupted."));
    this.detachView();
    hardenPartition(partition, origin);
    const ses = session.fromPartition(partition);
    const view = new WebContentsView({
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.view = view;
    this.currentOrigin = origin;
    view.setBackgroundColor(SHELL_BACKGROUND);
    const host = new URL(origin).hostname;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        settled = true;
        ses.cookies.off("changed", onCookie);
        view.webContents.off("did-navigate", onNavigate);
        view.webContents.off("did-fail-load", onLoadFailure);
        this.loginCancel = null;
        if (this.view === view) this.detachView();
      };
      const fail = (message: string): void => {
        if (settled) return;
        cleanup();
        reject(new Error(message));
      };
      const onCookie = (
        _event: Electron.Event,
        cookie: Electron.Cookie,
        _cause: string,
        removed: boolean,
      ): void => {
        if (settled || removed || cookie.name !== "odm_session") return;
        if (cookie.domain && cookie.domain.replace(/^\./, "") !== host) return;
        const expiresAt = cookie.expirationDate
          ? new Date(cookie.expirationDate * 1000).toISOString()
          : "";
        cleanup();
        resolve({ token: cookie.value, expiresAt });
      };
      // A failed round trip lands back on the server as /?error=discord; a
      // server without Discord configured answers the start URL itself
      // with an error status instead of redirecting to the consent page.
      const onNavigate = (_event: Electron.Event, url: string, status: number): void => {
        if (settled) return;
        if (!sameOrigin(url, origin)) return;
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return;
        }
        if (parsed.pathname === new URL(`${origin}${startPath}`).pathname && status >= 400) {
          fail("This server has not set up Discord sign-in.");
          return;
        }
        const error = parsed.searchParams.get("error");
        if (!error) return;
        // The same words the server's own login form uses for these codes
        // (src/app/AuthForm.tsx), so a refusal says what to do about it.
        fail(discordErrorText(error));
      };
      const onLoadFailure = (
        _event: Electron.Event,
        code: number,
        description: string,
        _url: string,
        isMainFrame: boolean,
      ): void => {
        // Redirects abort the previous navigation while OAuth continues.
        if (isMainFrame && code !== -3) fail(`Discord sign-in could not load: ${description}`);
      };
      this.loginCancel = (reason) => {
        if (settled) return;
        cleanup();
        reject(reason);
      };
      ses.cookies.on("changed", onCookie);
      view.webContents.on("did-navigate", onNavigate);
      view.webContents.on("did-fail-load", onLoadFailure);
      view.webContents.setWindowOpenHandler(({ url }) => {
        openExternally(url);
        return { action: "deny" };
      });
      view.webContents.on("will-navigate", (event, url) => {
        if (!/^https?:/.test(url)) event.preventDefault();
      });
      win.contentView.addChildView(view);
      this.layout();
      void view.webContents.loadURL(`${origin}${startPath}`).catch((err: unknown) => {
        if (settled || (err instanceof Error && err.message.includes("ERR_ABORTED"))) return;
        fail(`Discord sign-in could not load: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  private cancelLogin(reason: Error): void {
    const cancel = this.loginCancel;
    this.loginCancel = null;
    cancel?.(reason);
  }

  // Logging out inside the server's web UI revokes the session server-side;
  // left alone, the shell would keep a dead token and the user would be
  // stranded on the server's embedded login page. A real logout removes
  // odm_session explicitly (or overwrites it expired); the shell's own
  // applySessionCookie writes are flagged and skipped, and natural expiry
  // ("expired") is already covered by the stored token's expiry check.
  private watchForLogout(partition: string, origin: string): void {
    const cookies = session.fromPartition(partition).cookies;
    const host = new URL(origin).hostname;
    const listener = (
      _event: Electron.Event,
      cookie: Electron.Cookie,
      cause: string,
      removed: boolean,
    ): void => {
      // The session cookie on a server's own pages, or the portal's token
      // cookie on the local origin: either going away is a logout.
      const watched = this.portalHost ? PORTAL_TOKEN_COOKIE : "odm_session";
      if (!removed || cookie.name !== watched) return;
      if (cause !== "explicit" && cause !== "expired-overwrite") return;
      if (isShellCookieWrite()) return;
      if (cookie.domain && cookie.domain.replace(/^\./, "") !== host) return;
      if (this.currentOrigin !== origin) return;
      this.onRevoked?.(this.portalHost || origin);
      this.showManager();
    };
    cookies.on("changed", listener);
    this.unwatchCookies = () => cookies.off("changed", listener);
  }

  private detachView(): void {
    this.unwatchCookies?.();
    this.unwatchCookies = null;
    if (!this.win || !this.view) return;
    this.win.contentView.removeChildView(this.view);
    this.view.webContents.close();
    this.view = null;
    this.currentOrigin = "";
    this.portalHost = "";
  }

  showManager(): void {
    if (this.loginCancel) {
      this.cancelLogin(new Error("Sign-in cancelled."));
      this.sendEvent({ kind: "show-manager" });
      return;
    }
    if (!this.view) return;
    this.detachView();
    this.sendEvent({ kind: "show-manager" });
  }
}
