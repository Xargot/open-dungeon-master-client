// What a sign-in leaves of a password the app made up and keeps (the device
// world's profile, an account joined by room code), so an expired session
// renews without a form. It belongs to one account: signing in as somebody
// else drops it. And a sign-in with a password the player typed proves that
// password is the account's, so a different kept one is stale (the player
// changed it inside the game): kept, it would only fail at every renewal and
// spend the account's login throttle. A sign-in that proves no password (a
// Discord account, a renewal) keeps it.
export function keptSecret(
  previous: { username: string; secret?: string | null } | null | undefined,
  username: string,
  typedPassword?: string,
): string | undefined {
  if (!previous?.secret || previous.username !== username) return undefined;
  if (typedPassword !== undefined && typedPassword !== previous.secret) return undefined;
  return previous.secret;
}
