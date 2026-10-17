import type { ServerProbe } from "../shared/types";
import type { SessionState, TokenGrant } from "./odm-api";
import { LOCAL_SERVER_ID, type ServerStore, type StoredServer } from "./servers";

export type PreparedRemote =
  | { ok: true; entry: StoredServer; token: string; probe: ServerProbe }
  | { ok: false; needsLogin: boolean; error: string };

export async function prepareRemoteConnection(id: string, deps: {
  store: ServerStore;
  probe: (origin: string) => Promise<ServerProbe | null>;
  relocate: (entry: StoredServer) => Promise<StoredServer>;
  sessionState: (origin: string, token: string) => Promise<SessionState>;
  login: (origin: string, username: string, secret: string) => Promise<TokenGrant>;
}): Promise<PreparedRemote> {
  const saved = deps.store.get(id);
  if (!saved || saved.id === LOCAL_SERVER_ID) {
    return { ok: false, needsLogin: false, error: "Unknown server." };
  }
  let entry = saved;
  const notOnline = (): PreparedRemote => ({
    ok: false,
    needsLogin: false,
    error: `${entry.name} is not online right now. Ask the host to share their world, then try again.`,
  });
  // Who answers at the address on file, before anything secret is sent
  // there. A tunnel hostname is handed out per session and can later
  // belong to somebody else's world, and a world one of the apps hosts
  // answers at a new address every time it is shared again. Only a world
  // that proves it is the one this entry belongs to gets the session.
  let probe = await deps.probe(entry.origin).catch(() => null);
  if (!probe || (!!entry.instanceId && probe.instanceId !== entry.instanceId)) {
    // Nothing there, or the wrong world: ask the registry where this
    // world's room codes point today (src/shared/relocate.ts). Without
    // this a player returning to a world that had been shared again was
    // told to sign in, and on a device world the only door that screen
    // offered was a new account: a second character and no way back.
    const moved = await deps.relocate(entry);
    if (moved.origin === entry.origin) return notOnline();
    entry = moved;
    probe = await deps.probe(entry.origin).catch(() => null);
    if (!probe || (!!entry.instanceId && probe.instanceId !== entry.instanceId)) return notOnline();
  }
  let token = deps.store.token(id);
  const session = token ? await deps.sessionState(entry.origin, token) : "rejected";
  if (session === "unreachable") return notOnline();
  if (session === "rejected") {
    // An account the app made up a password for (joined by room code)
    // must never be asked for it: nobody was ever told what it is. Renew
    // the session with the stored one instead, and only fall back to the
    // sign-in form for accounts a person chose a password for.
    const secret = deps.store.secret(id);
    token = null;
    if (secret) {
      try {
        const grant = await deps.login(entry.origin, entry.username, secret);
        entry = deps.store.upsert({
          id: entry.id,
          origin: entry.origin,
          name: entry.name,
          username: grant.username,
          token: grant.token,
          tokenExpiresAt: grant.expiresAt,
        });
        token = grant.token;
      } catch {
        // A changed password requires the regular sign-in or rejoin path.
      }
    }
  }
  if (!token) {
    return {
      ok: false,
      needsLogin: true,
      error: probe.deviceWorld
        ? "Your seat at this world could not be reopened. Join again with a name, and ask the host to remove the old one."
        : "Your session expired. Sign in again.",
    };
  }
  return { ok: true, entry, token, probe };
}
