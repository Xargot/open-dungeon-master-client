import type { AccountDeletionResult, ServerProbe, SignupMode } from "../shared/types";
import type { WorldRequest } from "../shared/world-transfer";

// Thin fetch helpers for talking to an Open Dungeon Master server's REST API
// from the main process. Errors are thrown as ApiError with a message safe to
// show in the shell UI.

const TIMEOUT_MS = 10_000;

export class ApiError extends Error {}

async function api(origin: string, pathname: string, init?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(`${origin}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError(`Could not reach ${origin}. Check the address and your connection.`);
  }
}

async function errorFrom(res: Response, fallback: string): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new ApiError(body?.error || fallback);
}

export async function probeServer(origin: string): Promise<ServerProbe> {
  const res = await api(origin, "/api/auth/providers");
  const body = res.ok
    ? ((await res.json().catch(() => null)) as {
        discord?: boolean;
        password?: boolean;
        signupMode?: string;
        serverName?: string;
        version?: string;
        instanceId?: string;
        deviceWorld?: boolean;
        needsSetup?: boolean;
      } | null)
    : null;
  if (!body || typeof body.password !== "boolean") {
    throw new ApiError(`${origin} does not look like an Open Dungeon Master server.`);
  }
  const signupMode: SignupMode =
    body.signupMode === "invite" || body.signupMode === "closed" ? body.signupMode : "open";
  return {
    origin,
    serverName: typeof body.serverName === "string" ? body.serverName : "",
    version: typeof body.version === "string" ? body.version : "",
    signupMode,
    discord: Boolean(body.discord),
    instanceId: typeof body.instanceId === "string" ? body.instanceId : "",
    // Servers older than 0.16.6 do not say, and are taken for real ones.
    deviceWorld: body.deviceWorld === true,
    needsSetup: body.needsSetup === true,
  };
}

export interface TokenGrant {
  token: string;
  expiresAt: string;
  username: string;
  isAdmin: boolean;
}

export async function loginForToken(
  origin: string,
  username: string,
  password: string,
): Promise<TokenGrant> {
  const res = await api(origin, "/api/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw await errorFrom(res, "Sign-in failed.");
  const body = (await res.json()) as {
    token: string;
    expiresAt: string;
    user: { username: string; isAdmin: boolean };
  };
  return {
    token: body.token,
    expiresAt: body.expiresAt,
    username: body.user.username,
    isAdmin: Boolean(body.user.isAdmin),
  };
}

export async function registerAccount(
  origin: string,
  input: { username: string; password: string; inviteCode: string; joinCode?: string; setupCode?: string },
): Promise<TokenGrant> {
  const payload: Record<string, string> = {
    username: input.username,
    password: input.password,
  };
  if (input.inviteCode) payload.inviteCode = input.inviteCode;
  // The room code travels with the registration: on a world an app hosts
  // it is the only door, and on an invite-only server it vouches for the
  // signup. The server looks it up without consuming it
  // (src/app/api/auth/register), and the same code then seats the player.
  if (input.joinCode) payload.joinCode = input.joinCode;
  // The code that claims a server's first account: typed by whoever runs a
  // real server (it is in the server's log), and the shell's own for the
  // world it hosts (src/main/local-server.ts). Servers ignore it otherwise.
  if (input.setupCode) payload.setupCode = input.setupCode;
  const res = await api(origin, "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await errorFrom(res, "Could not create the account.");
  // Registration set a browser cookie this process never sees; mint the
  // app's own bearer token with the same credentials.
  return loginForToken(origin, input.username, input.password);
}

// Who a session belongs to; used after a browser sign-in (Discord OAuth)
// hands the shell a token it did not mint itself.
export async function whoAmI(
  origin: string,
  token: string,
): Promise<{ username: string; isAdmin: boolean }> {
  const res = await api(origin, "/api/auth/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await errorFrom(res, "The sign-in did not produce a usable session.");
  const body = (await res.json().catch(() => null)) as {
    user?: { username?: string; isAdmin?: boolean };
  } | null;
  if (!body?.user || typeof body.user.username !== "string") {
    throw new ApiError("The sign-in did not produce a usable session.");
  }
  return { username: body.user.username, isAdmin: Boolean(body.user.isAdmin) };
}

// Whether a saved session still opens a world: "ok", "rejected" (the host
// answered and does not know this session) or "unreachable" (nothing
// answered). The two failures are different news: a rejected session wants
// a sign-in, an unreachable host wants the player told it is not online,
// which "Your session expired" used to say for both.
export type SessionState = "ok" | "rejected" | "unreachable";

export async function sessionState(origin: string, token: string): Promise<SessionState> {
  try {
    const res = await api(origin, "/api/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    // /api/auth/me answers 200 with a null user for a dead session, so the
    // body decides, not the status.
    if (!res.ok) return "rejected";
    const body = (await res.json().catch(() => null)) as { user?: unknown } | null;
    return body?.user ? "ok" : "rejected";
  } catch {
    return "unreachable";
  }
}

export async function tokenIsValid(origin: string, token: string): Promise<boolean> {
  return (await sessionState(origin, token)) === "ok";
}

export async function patchAdminSettings(
  origin: string,
  token: string,
  patch: object,
): Promise<void> {
  const res = await api(origin, "/api/admin/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await errorFrom(res, "Saving server settings failed.");
}

// The agent programs the server can start, as its admin page lists them.
export async function getHarnessStatus(origin: string, token: string, refresh: boolean): Promise<unknown> {
  const res = await api(origin, `/api/admin/harness${refresh ? "?refresh=1" : ""}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await errorFrom(res, "Reading the agent programs failed.");
  return res.json();
}

// The world's built-in speech engine (the server's Admin > Speech): its
// state, or, with install, the download started. Raw body; the caller reads
// it with speechStatusFrom.
export async function speechEngine(origin: string, token: string, install: boolean): Promise<unknown> {
  const res = await api(origin, "/api/admin/speech", {
    method: install ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) throw new ApiError("This world's server is too old for built-in speech; update the app.");
  if (!res.ok) throw await errorFrom(res, "Reading the speech engine failed.");
  return res.json();
}

// One of the world's admin routes that takes a JSON body and answers with
// one (the model listings the OpenAI door asks, src/shared/ai-setup.ts).
// The server asks the key's provider in turn, so it is given longer.
export async function postAdmin(origin: string, token: string, pathname: string, body: object, timeoutMs = 30_000): Promise<unknown> {
  const res = await api(
    origin,
    pathname,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  if (!res.ok) throw await errorFrom(res, "The world's server refused the request.");
  return res.json();
}

// Whether a server has a table under a room code: its public join preview,
// asked the way the invite page asks it (a miss counts against that
// address's lockout there, as a wrong password does, so callers ask once).
export async function tableAt(origin: string, code: string): Promise<boolean> {
  try {
    const res = await api(origin, `/api/campaigns/join/preview?code=${encodeURIComponent(code)}`, undefined, 5_000);
    return res.ok;
  } catch {
    return false;
  }
}

// One of the world's admin routes read with a GET (the sound library's
// state, src/shared/world-media.ts).
export async function getAdmin(origin: string, token: string, pathname: string): Promise<unknown> {
  const res = await api(origin, pathname, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) throw new ApiError("This world's server is too old for that; update the app.");
  if (!res.ok) throw await errorFrom(res, "The world's server refused the request.");
  return res.json();
}

// The masked admin settings: every field, with each key reduced to whether
// one is set.
export async function getAdminSettings(origin: string, token: string): Promise<unknown> {
  const res = await api(origin, "/api/admin/settings", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await errorFrom(res, "Reading server settings failed.");
  return res.json();
}

// Self-service account deletion (the server's DELETE /api/profile). Password
// accounts must send their password; Discord-only accounts send "".
export async function deleteAccount(
  origin: string,
  token: string,
  password: string,
): Promise<AccountDeletionResult> {
  const res = await api(origin, "/api/profile", {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(password ? { password } : {}),
  });
  if (!res.ok) throw await errorFrom(res, "Could not delete the account.");
  const body = (await res.json().catch(() => null)) as {
    dueAt?: string;
    graceDays?: number;
    purged?: boolean;
  } | null;
  return {
    dueAt: typeof body?.dueAt === "string" ? body.dueAt : "",
    graceDays: typeof body?.graceDays === "number" ? body.graceDays : 0,
    purged: body?.purged === true,
  };
}

// The device world's archive route (src/shared/world-transfer.ts), as the
// shared job runner calls it: status and body, never a throw on a refusal.
export function worldRequest(origin: string, token: string): WorldRequest {
  return async (method, body) => {
    const res = await api(origin, "/api/admin/world", {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}
