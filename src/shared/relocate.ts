// Finding a world that moved.
//
// A saved world is reached by its address, and a world one of the apps hosts
// gets a brand new address every time its host shares it again. The room code
// does not change, so the broker's table registry is the way back: it answers
// "the table with this code is at that address right now". This asks it, and
// then proves the world answering there is the same one before any saved
// session is handed over.
//
// That proof is not a formality. The play-CODE hostnames are minted per
// session and can later be handed to somebody else's world, so an address on
// file is not evidence of identity; only the world's own instanceId is. A
// shell that skipped the check could post a player's bearer token to a
// stranger's server.
//
// Pure orchestration over injected I/O, so both shells share it and the tests
// run under plain Node.

import { insecureRemoteOrigin } from "./deep-link";

export interface RelocateDeps {
  // The world answering at an origin, or null when nothing does.
  probe(origin: string): Promise<{ instanceId: string } | null>;
  // Where the broker's table registry says a room code is now, or "".
  resolveTable(code: string): Promise<string>;
}

export interface SavedWorld {
  // The address on file, which may be long dead.
  origin: string;
  // The world's stable id. "" for an entry saved before servers exposed one.
  instanceId: string;
  // Room codes seen on this host: every campaign the player has there.
  codes: readonly string[];
}

export type Relocation =
  | { found: true; origin: string; moved: boolean }
  | { found: false };

// A player with a long history on one host should not cost a dozen registry
// calls on every reconnect; the newest few codes find the world just as well.
export const MAX_CODES_TRIED = 8;

export async function relocateWorld(
  world: SavedWorld,
  deps: RelocateDeps,
): Promise<Relocation> {
  const saved = (world.instanceId || "").trim();
  const here = await deps.probe(world.origin).catch(() => null);
  // Still where we left it. An entry with no stable id has to take that on
  // trust, exactly as it did before this existed.
  if (here && (!saved || here.instanceId === saved)) {
    return { found: true, origin: world.origin, moved: false };
  }
  // Something answers on file, but it is not this world: the hostname was
  // recycled to another host. Fall through rather than trust the address.
  if (!saved) return { found: false };

  const tried = new Set([world.origin]);
  const codes: string[] = [];
  for (const raw of world.codes) {
    const code = (raw || "").trim().toUpperCase();
    if (code && !codes.includes(code)) codes.push(code);
    if (codes.length >= MAX_CODES_TRIED) break;
  }
  for (const code of codes) {
    const candidate = await deps.resolveTable(code).catch(() => "");
    if (!candidate || tried.has(candidate)) continue;
    tried.add(candidate);
    // A world saved at https is not followed to plain http on the open
    // internet: the saved session would cross it in the clear.
    if (world.origin.startsWith("https:") && insecureRemoteOrigin(candidate)) continue;
    const probed = await deps.probe(candidate).catch(() => null);
    if (probed && probed.instanceId === saved) {
      return { found: true, origin: candidate, moved: true };
    }
  }
  return { found: false };
}
