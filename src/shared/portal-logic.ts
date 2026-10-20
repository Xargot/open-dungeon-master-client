// Portal mode: instead of loading a host's own pages, the shell serves the
// game UI from its bundled server and forwards only the data calls to the
// host (the server's src/proxy.ts does the forwarding, keyed by two cookies
// the shell plants on its local origin). The controls are then always the
// app's own, and a tunnel carries game data rather than pages and scripts.
// Pure decisions only; both shells and the tests share them.

export const PORTAL_ORIGIN_COOKIE = "odm_portal_origin";
export const PORTAL_TOKEN_COOKIE = "odm_portal_token";
// The two above signed with the secret the shell started its server with
// (ODM_PORTAL_SECRET): the server's src/lib/portal.ts forwards nothing
// without a signature that matches, so nobody who reaches a shared world
// can point it at a host of their own.
export const PORTAL_SIG_COOKIE = "odm_portal_sig";

// The first bundled server that carries the proxy.
export const PORTAL_MIN_SERVER = "0.16.0";

export function parseVersion(raw: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export type PortalVerdict = { ok: true } | { ok: false; reason: string };

// A host can be visited through the portal when the bundled UI knows how
// to be one (bundled server new enough) and the host's API is at least
// what that UI expects: same major line, minor no older. A host that is
// too old simply opens its own pages, as before.
export function portalEligible(input: { bundled: string; remote: string }): PortalVerdict {
  const bundled = parseVersion(input.bundled);
  if (!bundled) return { ok: false, reason: "This build has no bundled server." };
  const floor = parseVersion(PORTAL_MIN_SERVER)!;
  if (!atLeast(bundled, floor)) {
    return { ok: false, reason: `The bundled server ${input.bundled} predates portal mode.` };
  }
  const remote = parseVersion(input.remote);
  if (!remote) return { ok: false, reason: "The host did not say which version it runs." };
  if (remote[0] !== bundled[0] || remote[1] < bundled[1]) {
    return {
      ok: false,
      reason: `The host runs ${input.remote}; this app's screens expect ${bundled[0]}.${bundled[1]} or newer.`,
    };
  }
  return { ok: true };
}

// The first server whose API the app's own screens can call directly: it
// answers the apps' cross-origin requests (the server's src/lib/app-cors.ts)
// and routes its navigations through the app. An older host still opens
// its pages in the web view.
// Raised to the release that carries VTT parity phases 16 to 30
// (docs/vtt-parity-implementation-plan.md 18.2): the screens call routes
// an older host does not have (shops, factions, calendar, the table view).
// Raised again for the redesign (server docs/visual-overhaul-plan.md 9.0b):
// the screens save map skins and stamped props and read the turn budget and
// enemy intent, all of which an older host would drop without a word.
// Raised again for one cloak at a time (server issue 412): the screens save
// where a workshop item is worn (`wornOn`) and the DM's "wear both"
// (`layered`), which an older host drops, and the sheet counts AC and magic
// by the one-of-a-kind rules an older host's engine does not keep, so the
// AC on the sheet would not be the AC the DM rolls against.
export const NATIVE_MIN_SERVER = "0.28.2";

export function nativeEligible(remote: string): PortalVerdict {
  const version = parseVersion(remote);
  if (!version) return { ok: false, reason: "The host did not say which version it runs." };
  if (!atLeast(version, parseVersion(NATIVE_MIN_SERVER)!)) {
    return { ok: false, reason: `The host runs ${remote}; the app's screens need ${NATIVE_MIN_SERVER} or newer.` };
  }
  return { ok: true };
}
