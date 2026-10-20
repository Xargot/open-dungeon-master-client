// How the shell brings the device world's owner in without a form: the
// stored session, a fresh one from the password the shell made up, or the
// owner's profile made on a world that has none yet.
//
// Whether the world has an owner is asked of the running world itself
// (needsSetup on /api/auth/providers), not judged by its database file. A
// first start that timed out (a slow disk, an antivirus reading every file),
// sharing, or the AI setup can each leave a database behind before the
// owner's account exists; such a world used to ask for a sign-in to an
// account nobody had, and its server's own page for a setup code that only
// the shell holds. The file test stays as the answer when the world cannot
// say.
//
// The profile's name and password are kept before the world hears them, so
// a registration whose answer, or the sign-in after it, is lost leaves the
// shell holding the password of the account it made, and the next entry
// signs in with it.
import type { TokenGrant } from "./odm-api";

export interface LocalOwnerDeps {
  // The stored session token, or null (absent, expired, undecryptable).
  token(): string | null;
  tokenIsValid(token: string): Promise<boolean>;
  // The kept profile: its name, and the password the shell made up for it
  // (null when the player chose one, or it cannot be read back).
  profile(): { username: string; secret: string | null } | null;
  login(username: string, password: string): Promise<TokenGrant>;
  // Registers the world's first account with the shell's setup code.
  register(username: string, password: string): Promise<TokenGrant>;
  // Whether the running world has no account yet; null when it cannot say.
  awaitsOwner(): Promise<boolean | null>;
  // Keeps a profile whose account does not exist yet (no session).
  hold(username: string, secret: string): void;
  adopt(grant: TokenGrant, secret?: string): void;
  profileName(): string;
  mintSecret(): string;
}

export type LocalEntry =
  | { kind: "session"; token: string }
  | { kind: "created"; grant: TokenGrant }
  | { kind: "needs-login" };

// Makes the owner's profile. A name and password an earlier attempt kept are
// used again, so the account is the one the shell can sign in to.
export async function provisionOwner(deps: LocalOwnerDeps): Promise<TokenGrant> {
  const kept = deps.profile();
  const username = kept?.username || deps.profileName();
  const secret = kept?.secret || deps.mintSecret();
  deps.hold(username, secret);
  const grant = await deps.register(username, secret);
  deps.adopt(grant, secret);
  return grant;
}

// A session for the owner of the running world. `fresh` is whether the
// database file was missing before the world started, used only when the
// world cannot say whether it has an owner.
export async function enterLocalWorld(deps: LocalOwnerDeps, fresh: boolean): Promise<LocalEntry> {
  const token = deps.token();
  if (token && (await deps.tokenIsValid(token))) return { kind: "session", token };
  const kept = deps.profile();
  if (kept?.secret) {
    try {
      const grant = await deps.login(kept.username, kept.secret);
      deps.adopt(grant);
      return { kind: "session", token: grant.token };
    } catch {
      // Rejected: the password was changed inside the game, or the account
      // never came to be. The world says which.
    }
  }
  if ((await deps.awaitsOwner()) ?? fresh) {
    return { kind: "created", grant: await provisionOwner(deps) };
  }
  return { kind: "needs-login" };
}
