import { session } from "electron";
import { PORTAL_ORIGIN_COOKIE, PORTAL_SIG_COOKIE, PORTAL_TOKEN_COOKIE } from "../shared/portal-logic";

// Each server gets its own persistent partition so cookies, storage and
// permissions never leak between servers.
export function partitionFor(serverId: string): string {
  return `persist:odm-${serverId}`;
}

// Overwriting odm_session makes Chromium report a removal of the old value
// first, which looks exactly like a logout to the cookie watcher. Writes are
// counted so the watcher can tell them apart; the count lingers one macrotask
// past set() because the removal event can arrive after the promise resolves.
let shellWrites = 0;

export function isShellCookieWrite(): boolean {
  return shellWrites > 0;
}

// Turns the shell's bearer token into the odm_session cookie the server's
// web UI expects. Cookies are origin-scoped but the token is not, so this is
// re-applied on every connect; a changed local port just means a fresh set.
export async function applySessionCookie(
  partition: string,
  origin: string,
  token: string,
  expiresAt: string,
): Promise<void> {
  const expiry = Date.parse(expiresAt);
  shellWrites += 1;
  try {
    await session.fromPartition(partition).cookies.set({
      url: origin,
      name: "odm_session",
      value: token,
      path: "/",
      httpOnly: true,
      secure: origin.startsWith("https:"),
      sameSite: "lax",
      ...(Number.isFinite(expiry) ? { expirationDate: expiry / 1000 } : {}),
    });
  } finally {
    setTimeout(() => {
      shellWrites -= 1;
    }, 0);
  }
}

// Portal mode: the cookies on the shell's local origin that tell the
// bundled server which host to forward data calls to and with which token,
// and the signature that proves the shell set them (the server's
// src/lib/portal.ts reads all three). Same write counting as the session
// cookie, since the logout watcher listens for their removal.
export async function applyPortalCookies(
  partition: string,
  localOrigin: string,
  hostOrigin: string,
  token: string,
  expiresAt: string,
  signature: string,
): Promise<void> {
  const expiry = Date.parse(expiresAt);
  const cookies = session.fromPartition(partition).cookies;
  shellWrites += 1;
  try {
    for (const [name, value] of [
      [PORTAL_ORIGIN_COOKIE, hostOrigin],
      [PORTAL_TOKEN_COOKIE, token],
      [PORTAL_SIG_COOKIE, signature],
    ] as const) {
      await cookies.set({
        url: localOrigin,
        name,
        value,
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        ...(Number.isFinite(expiry) ? { expirationDate: expiry / 1000 } : {}),
      });
    }
  } finally {
    setTimeout(() => {
      shellWrites -= 1;
    }, 0);
  }
}

export async function clearPartition(partition: string): Promise<void> {
  await session.fromPartition(partition).clearStorageData();
}

// The files Chromium cached from servers (the HTTP cache and the compiled
// script cache) for the given partitions and the shell's own session,
// leaving cookies, storage and sign-ins where they are: Troubleshooting's
// "Clear cached files". A partition comes into being on first use, so only
// the ones the server list knows are passed, never guessed.
export async function clearCaches(partitions: readonly string[]): Promise<number> {
  const sessions = [session.defaultSession, ...Array.from(new Set(partitions), (partition) => session.fromPartition(partition))];
  for (const ses of sessions) {
    await ses.clearCache();
    await ses.clearCodeCaches({});
  }
  return sessions.length;
}
