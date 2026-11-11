// Whether a world's answers say the player's session there has ended on
// its own: revoked by a password change elsewhere, an admin's reset, the
// account's deletion, or the thirty days running out. Inside the apps the
// app owns sign-in, so the server's own login page is a dead end (a
// password typed there is never kept, and a Discord account has none);
// the app's home, where the world asks for a sign-in the app can keep, is
// the way back. Shared by the native game screens (src/renderer/game/
// runtime.ts) and the Android web view's hook (mobile/src/shell-hook.ts).
// A page is only ever opened over a session the app has just checked; the
// one exception, a Discord sign-in running the server's signed-out pages in
// the Android web view, is ignored by the bridge that hears the news.

export const SESSION_LOST_NOTICE = "Your session at this world ended. Sign in again.";

export interface SessionWatch {
  // One answer from the world: its path (pathname, query allowed), its
  // status, and for /api/auth/me whether it named a user. True exactly once,
  // on the first answer that shows the session has gone.
  seen(path: string, status: number, signedIn?: boolean): boolean;
}

export function createSessionWatch(): SessionWatch {
  let lost = false;
  return {
    seen(path, status, signedIn) {
      if (lost) return false;
      const pathname = path.split(/[?#]/)[0] ?? path;
      if (!pathname.startsWith("/api/")) return false;
      if (pathname === "/api/auth/me") {
        // The server answers 200 with a null user for a dead session (the
        // apps' own session checks read it the same way).
        lost = status === 200 && signedIn === false;
        return lost;
      }
      // The sign-in routes answer 401 for a wrong password, which says
      // nothing about the session the page holds.
      if (pathname.startsWith("/api/auth/")) return false;
      // Everywhere else a 401 means one thing on every route: no session.
      lost = status === 401;
      return lost;
    },
  };
}
