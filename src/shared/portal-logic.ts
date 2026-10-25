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
// Raised again for hands and gear and the table's fight pace (server issues
// 424 and 432): the table settings save how often fights come
// (`combatPace`), which an older host drops, so the picker springs back to
// Balanced; the Hand deals gear cards (draw, stow, drop, pick up, a shield)
// whose moves and costs an older host's DM has no tool to carry out; and the
// builder says the DM reads the whole backstory, which an older host cuts.
// Raised again for the table's pace and breaks (server 0.28.4, PRs 438, 453,
// 455 and 464): the settings save when the AI DM answers (`waitForTable`),
// which an older host drops, and the table calls routes an older host does
// not have (a break, a Pass, the party backstory); a wizard the app opens
// from its home returns there only on a host that knows to send it back.
// Raised again for workshop classes and whole names (server 0.29.0, PRs 470,
// 476 and 477): the workshop saves a class of the table's own, a kind an
// older host refuses, and the builder offers it; a Market line picked from
// the catalog keeps the row it is (`srdName`) when it is renamed, which an
// older host drops, so a renamed line would sell as no item at all.
// Raised again for one tool per intent, stat blocks read whole and the SRD
// creature table (server 0.29.1, issues 471, 473 and 480): the DM console
// sets an enemy's condition and deals an enemy's damage through
// set_condition and apply_damage, and teleports a token through move_token,
// which an older host refuses or reads as a character's; the workshop saves
// an attack made as a bonus action, a swarm's weaker blow and a creature's
// resistance to a condition, which an older host drops, so the block springs
// back; and the console offers any creature for True Polymorph and
// Shapechange, which an older host refuses as no beast.
// Also needed from the same release for Workshop references (server
// workshop import audit, 2026-10-22): the builder and the level-up dialog
// say which of a player's own subclasses a table leaves out, and an older
// host names every class's subclasses there, so a fighter's list would
// explain away a wizard's; the creator, the import picker and Homebrew read
// what failed and what a rename carried from answers an older host does not
// give.
// Also needed from the same release for the board and the hero chooser
// (server PRs 481, 493 and 494): Help me build asks the confirm sheet to
// judge a hero not stored yet, which an older host refuses as no hero
// picked; Undo move calls a route an older host does not have; and the
// party card's "In fights" picker saves who commands a companion
// (`commandedBy`), which an older host drops, so the picker springs back to
// the DM.
// And from 0.30.0 (server issue 501): the Bonds tab's "Open to advances from
// NPCs" switch saves through PUT /sheet/romance, which an older host does
// not have, and "Drawn to" on a hero or an NPC is a field an older host
// drops, so the chips spring back to blank.
// Also needed from 0.30.0 (server PRs 499, 508 and 509, issue 503): the hero
// chooser's "Pregens your DM offers" and the confirm sheet's owed picks call
// routes and read fields an older host does not have; the Market's Haggle by
// Intimidation or Deception sends a skill an older host takes as Persuasion;
// a World entry's kept import version is answered by a route an older host
// does not have; and the companion conscience, pacts and combat sides read
// rows an older host never writes.
export const NATIVE_MIN_SERVER = "0.30.0";

export function nativeEligible(remote: string): PortalVerdict {
  const version = parseVersion(remote);
  if (!version) return { ok: false, reason: "The host did not say which version it runs." };
  if (!atLeast(version, parseVersion(NATIVE_MIN_SERVER)!)) {
    return { ok: false, reason: `The host runs ${remote}; the app's screens need ${NATIVE_MIN_SERVER} or newer.` };
  }
  return { ok: true };
}
