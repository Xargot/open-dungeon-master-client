// The game web view's fetch, as shell-hook.ts installs it: the page's own
// calls with two things watched. Kept apart from the hook so the tests can
// run it without a web view.
//
// An old server's web UI still offers "Log out" inside the app. Letting it
// through would revoke a session the app cannot always renew (no stored
// password, Discord-only accounts) and strand the player on a login page,
// so the call never goes out and the server list opens instead. New
// servers hide the item in the shell and never send it.
//
// The session may also die on its own (src/shared/session-watch.ts): the
// first answer that says so closes the page onto the server list, where
// signing in again is the app's own door.
import { createSessionWatch } from "../../src/shared/session-watch";

export interface HookedFetchDeps {
  fetch: typeof fetch;
  // The page's own address, read at each call (the page navigates).
  pageHref(): string;
  onLogout(): void;
  onSessionLost(): void;
}

export function hookedFetch(deps: HookedFetchDeps): typeof fetch {
  const watch = createSessionWatch();
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // fetch takes the method from init over the Request's own.
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    let path = "";
    try {
      const page = new URL(deps.pageHref());
      const url = new URL(raw, page);
      if (url.origin === page.origin) path = url.pathname;
    } catch {
      // An unreadable address is nobody's logout and not the world's answer.
    }
    if (method === "POST" && path === "/api/auth/logout") {
      deps.onLogout();
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const answer = deps.fetch(input, init);
    if (path.startsWith("/api/")) {
      void answer.then(
        async (response) => {
          let signedIn: boolean | undefined;
          // Read from a copy, taken before the page's own handlers run
          // (this one was attached first), so the page still has its body.
          if (path === "/api/auth/me" && response.status === 200) {
            const copy = response.clone();
            const body = (await copy.json().catch(() => null)) as { user?: unknown } | null;
            if (body && typeof body === "object" && "user" in body) signedIn = !!body.user;
          }
          if (watch.seen(path, response.status, signedIn)) deps.onSessionLost();
        },
        () => undefined,
      );
    }
    return answer;
  };
}
