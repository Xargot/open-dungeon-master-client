// Parsing for odm:// deep links and server origins. Pure functions with no
// Electron imports, so tests load this module under plain Node.

// Campaign room codes use the server's unambiguous invite alphabet
// (no 0/O/1/I), 4 to 12 characters.
export const CODE_SHAPE = /^[A-HJ-NP-Z2-9]{4,12}$/;

// The broker mints host codes from the same alphabet minus L, eight long
// (workers/tunnel-broker in the server repo), and the address it hands out
// is play-CODE.opendungeonmaster.com. Host code and hostname are the same
// string, which is what lets a spoken code find a host with nothing to look
// up: no broker call, no directory, just the name.
export const HOST_CODE_SHAPE = /^[A-HJKMNP-Z2-9]{8}$/;
const BROKER_ZONE = "opendungeonmaster.com";

// The room code a host reads out loud: the host's code and the table's,
// joined by a dash (ABCD2345-EFGH6789). Either half alone leaves a
// stranger stuck. The host half says which machine, the table half which
// campaign on it, so the pair is the smallest thing that gets someone all
// the way to a seat. A host code on its own is still accepted, and lands
// on that host's door with no campaign chosen.
export function roomCode(hostCode: string, inviteCode: string): string {
  const host = hostCode.trim().toUpperCase();
  const table = inviteCode.trim().toUpperCase();
  if (!HOST_CODE_SHAPE.test(host)) return "";
  return CODE_SHAPE.test(table) ? `${host}-${table}` : host;
}

// The host code inside a broker address, or "" for any other origin (a
// quick tunnel, a LAN address, someone's own domain). What the share
// screen shows, and how a server reads its own code out of its publicUrl.
export function hostCodeFromOrigin(origin: string): string {
  const host = /^https:\/\/play-([a-z0-9]+)\.opendungeonmaster\.com\/?$/.exec(
    (origin || "").trim().toLowerCase(),
  )?.[1];
  const code = (host ?? "").toUpperCase();
  return HOST_CODE_SHAPE.test(code) ? code : "";
}

// What a bare typed code might be, in the order the shells must try it.
//
// The two code shapes overlap almost completely: the broker's alphabet is
// the campaign one minus L, so all but a thirty-first of table codes also
// read as a host code. Deciding by shape therefore cannot work, and trying
// the host shape first turned a real table code into a play-CODE address
// nobody answers at. The registry is asked first because a table's code is
// what a host actually reads out; the host shape is the fallback for the
// code the share screen shows.
export interface CodeCandidates {
  // The registry lookup: a campaign's own code.
  table: string;
  // The address a host code names, or "" when it cannot be one.
  hostOrigin: string;
}

export function codeCandidates(raw: string): CodeCandidates {
  // "ABCD 2345", "abcd-2345" and a code with a phone keyboard's dash are
  // all the one code; the registry would have accepted the cleaned form,
  // so it is cleaned here rather than sent down the host-shape path alone.
  const typed = (typeof raw === "string" ? raw : "")
    .trim()
    .toUpperCase()
    .replace(/[\s‐-―−-]/g, "");
  return {
    table: CODE_SHAPE.test(typed) ? typed : "",
    hostOrigin: parseRoomCode(raw)?.origin ?? "",
  };
}

// Whether a link's origin is one the shell may move a saved entry to on the
// strength of the world's instanceId alone. That id is public (anyone who
// ever probed the world has it), so a crafted odm://join?s=https://evil
// link could otherwise rebind a saved seat to a stranger's server and hand
// it the saved session. Tunnel hostnames are minted at random by Cloudflare
// or the broker, which nobody can pick; a link that names one is taken as
// the host's own share link. Anything else must be confirmed by the
// registry (the code resolves there) before the saved session follows it.
// True for plain http to anything but this machine or a private network.
// LAN play and a world on this computer stay on http by design; a public
// server on http carries passwords, tokens and the game in the clear, so
// the sign-in form says so and a saved https world is never silently moved
// to such an address.
export function insecureRemoteOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === "http:" && !privateHost(url.hostname);
}

function privateHost(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // A bare name ("gamebox") only resolves on the local network.
  if (!host.includes(".") && !host.includes(":")) return true;
  if (/\.(local|lan|home|internal|home\.arpa)$/.test(host)) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      // Carrier-grade NAT space, which Tailscale's addresses live in.
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

export function trustedTunnelOrigin(origin: string): boolean {
  return /^https:\/\/(play-[a-z0-9]+\.opendungeonmaster\.com|[a-z0-9-]+\.trycloudflare\.com)$/.test(
    (origin || "").trim().toLowerCase(),
  );
}

// A typed or pasted room code, in every shape a person might produce:
// "ABCD2345-EFGH6789", the two halves run together, lower case, spaced,
// with the dash a phone keyboard turned into an en dash, or with the
// "play-" the address carries in front. The host half alone is a join with
// no campaign.
export function parseRoomCode(raw: string): JoinLink | null {
  if (typeof raw !== "string" || raw.length > 60) return null;
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, "");
  if (!cleaned) return null;
  const parts = cleaned.split("-").filter((part) => part.length > 0);
  // "PLAY-ABCD2345" is how the address reads; four letters can never be a
  // host code, so dropping it here cannot swallow a real one.
  if (parts[0] === "PLAY") parts.shift();
  let host = "";
  let table = "";
  if (parts.length === 1) {
    const only = parts[0] ?? "";
    if (only.length === 16) {
      host = only.slice(0, 8);
      table = only.slice(8);
    } else {
      host = only;
    }
  } else if (parts.length === 2) {
    host = parts[0] ?? "";
    table = parts[1] ?? "";
  } else {
    return null;
  }
  if (!HOST_CODE_SHAPE.test(host)) return null;
  if (table && !CODE_SHAPE.test(table)) return null;
  return { origin: `https://play-${host.toLowerCase()}.${BROKER_ZONE}`, code: table };
}

// Turns pasted input into a clean http(s) origin, or null. Re-serializing
// through URL strips userinfo tricks like https://good.com@evil.com.
export function normalizeOrigin(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return url.origin;
}

// People paste addresses without a scheme ("play.example.com",
// "192.168.1.50:3005"). Offer https first, then http, so LAN servers on
// plain http still connect; explicit schemes are taken as-is.
export function originCandidates(raw: string): string[] {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0 || trimmed.length > 300) return [];
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    const origin = normalizeOrigin(trimmed);
    return origin ? [origin] : [];
  }
  const candidates: string[] = [];
  for (const scheme of ["https", "http"]) {
    const origin = normalizeOrigin(`${scheme}://${trimmed}`);
    if (origin) candidates.push(origin);
  }
  return candidates;
}

export interface JoinLink {
  origin: string;
  code: string;
}

// odm://join?s=<server origin>&c=<CODE>, the shape the /j Worker hands out.
export function parseJoinLink(raw: string): JoinLink | null {
  if (typeof raw !== "string" || raw.length > 700) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "odm:") return null;
  const action = url.host || (url.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
  if (action !== "join") return null;
  const origin = normalizeOrigin(url.searchParams.get("s") ?? "");
  const code = (url.searchParams.get("c") ?? "").trim().toUpperCase();
  if (!origin || !CODE_SHAPE.test(code)) return null;
  return { origin, code };
}

// Any invite shape a person might paste, scan, or open: the odm:// link, the
// https interstitial link the QR codes carry
// (https://opendungeonmaster.com/j?s=...&c=CODE, also /j/CODE?s=...), or a
// server's own readable join link (https://host/join/CODE), which is the one
// people see printed next to the room code.
export function parseAnyLink(raw: string): JoinLink | null {
  const direct = parseJoinLink(raw);
  if (direct) return direct;
  if (typeof raw !== "string" || raw.length > 700) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol === "https:" && url.host === "opendungeonmaster.com") {
    if (!url.pathname.startsWith("/j")) return null;
    const origin = normalizeOrigin(url.searchParams.get("s") ?? "");
    const code = (url.searchParams.get("c") ?? url.pathname.split("/")[2] ?? "")
      .trim()
      .toUpperCase();
    if (!origin || !CODE_SHAPE.test(code)) return null;
    return { origin, code };
  }
  const joined = /^\/join\/([^/]+)\/?$/.exec(url.pathname);
  if (!joined) return null;
  const origin = normalizeOrigin(url.href);
  const code = decodeURIComponent(joined[1] ?? "").trim().toUpperCase();
  if (!origin || !CODE_SHAPE.test(code)) return null;
  return { origin, code };
}

// A bare server address, the shape the server's own floating QR button
// encodes (its origin, nothing else): scanning one means "add this server",
// with no campaign to join. Only http(s) with no path to speak of counts, so
// a join link never reads as a server address by accident; the invite shapes
// above are tried first by every caller.
export function parseServerAddress(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  const origin = normalizeOrigin(raw);
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash) return null;
  return origin;
}

// Everything a scan or a paste can carry: an invite of any shape, or a bare
// server address read as a join with no room code. Both bridges route the
// result through the one join handler, which is what keeps a server the
// player already has from being added twice: the handler matches the
// address against the saved list (and the world's instanceId when a tunnel
// came back at a new play-CODE hostname) before it ever shows a sign-in.
export function parseLinkOrAddress(raw: string): JoinLink | null {
  const link = parseAnyLink(raw);
  if (link) return link;
  const room = parseRoomCode(raw);
  if (room) return room;
  const origin = parseServerAddress(raw);
  return origin ? { origin, code: "" } : null;
}

// Picks the odm:// link out of a process argv, if one is present.
export function joinLinkFromArgv(argv: readonly string[]): JoinLink | null {
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith("odm://")) {
      const parsed = parseJoinLink(arg);
      if (parsed) return parsed;
    }
  }
  return null;
}
