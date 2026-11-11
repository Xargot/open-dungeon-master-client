// Injected into every server page (documentStart, next to the BLE polyfill
// and download shim) so the game knows it is running inside the app. Same
// contract as the desktop preload (src/preload/game.ts), so one server-side
// check covers both:
//
//   odmShell.showServers()  the account menu's "Switch server": posts back
//       here and the bridge closes the game webview onto the server list.
//   odmShell.share          sharing the device-hosted world on the internet
//       from the campaign lobby's invite dialog. Requests go up as messages;
//       every answer (and every unsolicited change) comes back down as an
//       "odm-share-status" message on the messageFromNative event.
//   odmShell.shareLink      the OS share sheet for a link (the webview has
//       no navigator.share); the invite dialog and the server address card
//       use it to offer Share next to Copy and the QR code.
import { hookedFetch } from "./shell-hook-core";

(() => {
  interface ShareStatus {
    supported: boolean;
    state: "stopped" | "starting" | "running" | "error";
    url: string;
    mode: "" | "named" | "quick";
    error: string;
    lanUrl: string;
    refusedCodes?: string[];
  }
  interface ShellHost {
    platform: "android";
    showServers(): void;
    shareLink(input: { title: string; text: string; url: string }): Promise<boolean>;
    share: {
      status(): Promise<ShareStatus>;
      start(): Promise<ShareStatus>;
      stop(): Promise<ShareStatus>;
      subscribe(listener: (status: ShareStatus) => void): () => void;
    };
  }
  interface HookWindow {
    odmShell?: ShellHost;
    mobileApp?: { postMessage(message: unknown): void };
    AndroidInterface?: { postMessage(message: string): void };
  }
  const host = window as unknown as HookWindow;
  if (host.odmShell) return;

  function post(message: Record<string, unknown>): void {
    // mobileApp is the plugin's own bridge object, injected after load;
    // AndroidInterface is the raw JavascriptInterface it wraps.
    if (host.mobileApp && typeof host.mobileApp.postMessage === "function") {
      host.mobileApp.postMessage(message);
    } else if (host.AndroidInterface) {
      host.AndroidInterface.postMessage(JSON.stringify(message));
    }
  }

  const UNSUPPORTED: ShareStatus = {
    supported: false,
    state: "stopped",
    url: "",
    mode: "",
    error: "",
    lanUrl: "",
  };
  const listeners = new Set<(status: ShareStatus) => void>();
  const pending = new Map<number, (status: ShareStatus) => void>();
  let nextId = 1;

  window.addEventListener("messageFromNative", (event) => {
    const detail = (event as CustomEvent).detail as
      | { type?: string; id?: number; status?: ShareStatus }
      | undefined;
    if (!detail || detail.type !== "odm-share-status" || !detail.status) return;
    const status = detail.status;
    if (typeof detail.id === "number") {
      const resolve = pending.get(detail.id);
      pending.delete(detail.id);
      resolve?.(status);
    }
    for (const listener of listeners) listener(status);
  });

  function request(action: "status" | "start" | "stop"): Promise<ShareStatus> {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      post({ odmShell: "share", action, id });
      // The bridge answers within a few seconds even while a tunnel is
      // still warming up; no answer means the app side is gone.
      setTimeout(() => {
        if (pending.delete(id)) resolve(UNSUPPORTED);
      }, 20_000);
    });
  }

  host.odmShell = {
    platform: "android",
    showServers() {
      post({ odmShell: "servers" });
    },
    shareLink(input) {
      post({ odmShell: "share-link", title: input.title, text: input.text, url: input.url });
      // The sheet's outcome never comes back; the page only needs to know
      // the request left.
      return Promise.resolve(true);
    },
    share: {
      status: () => request("status"),
      start: () => request("start"),
      stop: () => request("stop"),
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };

  // The page's fetch: an old server's Log out is refused, and a session
  // that died on its own closes the page onto the server list
  // (shell-hook-core.ts).
  window.fetch = hookedFetch({
    fetch: window.fetch.bind(window),
    pageHref: () => window.location.href,
    onLogout: () => host.odmShell?.showServers(),
    onSessionLost: () => post({ odmShell: "session-lost" }),
  });
})();
