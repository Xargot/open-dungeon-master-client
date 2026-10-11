// Where the app keeps what signs a player in (audit S3): the bearer tokens,
// the passwords it made up for room-code accounts, the table secrets it
// registers room codes with, and the device world's own account. On a phone
// they go to the native store (android/.../SecretStorePlugin.java): sealed
// with a Keystore key that never leaves the phone, in a file left out of
// cloud backup and device transfer. They used to sit in plain Capacitor
// preferences beside the saved-server list, which Auto Backup copies off
// the phone. Off a phone (the browser rig) the plain preferences stand in.
//
// The saved-server list keeps everything else, so on a new phone it still
// lists the player's servers and asks them to sign in again.
//
// Pure, no Capacitor imports: secret-store.ts wires it, tests drive it.

export interface SecretBackend {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createSecretStore(backend: SecretBackend): SecretStore {
  return {
    async get(key) {
      return (await backend.get({ key })).value ?? null;
    },
    async set(key, value) {
      await backend.set({ key, value });
    },
    async remove(key) {
      await backend.remove({ key });
    },
  };
}

// A value still in the plain preferences from before: moved into the store
// and removed from where it was, then read from the store. Returns it, or
// null when there is neither.
export async function migrateSecret(
  key: string,
  store: SecretStore,
  plain: SecretBackend,
): Promise<string | null> {
  const old = (await plain.get({ key })).value;
  if (old) {
    await store.set(key, old);
    await plain.remove({ key });
    return old;
  }
  return store.get(key);
}

// The saved servers' secrets, split off the list that is saved as plain
// JSON and joined back on load.
export interface WithSecrets {
  id: string;
  token: string;
  secret?: string;
}

export const serverTokenKey = (id: string) => `server-token:${id}`;
export const serverSecretKey = (id: string) => `server-secret:${id}`;

// The list as it is saved: no token, no made-up password.
export function withoutSecrets<T extends WithSecrets>(servers: T[]): T[] {
  return servers.map((server) => {
    const copy = { ...server, token: "" };
    delete copy.secret;
    return copy;
  });
}

export async function storeServerSecrets<T extends WithSecrets>(
  servers: T[],
  store: SecretStore,
  previousIds: Iterable<string>,
): Promise<void> {
  const ids = new Set(servers.map((server) => server.id));
  for (const server of servers) {
    if (server.token) await store.set(serverTokenKey(server.id), server.token);
    else await store.remove(serverTokenKey(server.id));
    if (server.secret) await store.set(serverSecretKey(server.id), server.secret);
    else await store.remove(serverSecretKey(server.id));
  }
  // A server taken off the list takes its secrets with it.
  for (const id of previousIds) {
    if (!ids.has(id)) {
      await store.remove(serverTokenKey(id));
      await store.remove(serverSecretKey(id));
    }
  }
}

// The list as loaded: each entry's secrets put back from the store. An entry
// still carrying them in the plain JSON (saved before the store existed) has
// them moved into the store; `migrated` says the plain list must be saved
// again without them.
export async function loadServerSecrets<T extends WithSecrets>(
  servers: T[],
  store: SecretStore,
): Promise<{ servers: T[]; migrated: boolean }> {
  let migrated = false;
  const out: T[] = [];
  for (const server of servers) {
    const filled = { ...server };
    if (server.token) {
      await store.set(serverTokenKey(server.id), server.token);
      migrated = true;
    } else {
      filled.token = (await store.get(serverTokenKey(server.id))) ?? "";
    }
    if (server.secret) {
      await store.set(serverSecretKey(server.id), server.secret);
      migrated = true;
    } else {
      const secret = await store.get(serverSecretKey(server.id));
      if (secret) filled.secret = secret;
      else delete filled.secret;
    }
    out.push(filled);
  }
  return { servers: out, migrated };
}
