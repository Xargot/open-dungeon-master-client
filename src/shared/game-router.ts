// The native game screens' own history: which host page is showing, as a
// path and query, with a back stack. Pure, so the tests can drive it; the
// renderer's Next.js navigation shims read and write it, the shell's back
// gesture pops it, and the route table turns the path into a page.

export interface GameLocation {
  pathname: string;
  search: string;
}

type Listener = () => void;

function split(url: string): GameLocation {
  const hash = url.indexOf("#");
  const clean = hash >= 0 ? url.slice(0, hash) : url;
  const query = clean.indexOf("?");
  return query >= 0
    ? { pathname: clean.slice(0, query) || "/", search: clean.slice(query) }
    : { pathname: clean || "/", search: "" };
}

export function isAbsoluteUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

export class GameRouter {
  private stack: GameLocation[];
  private readonly listeners = new Set<Listener>();
  // Addresses the native screens cannot show (another site, or the host by
  // full address): handed here for the shell to open the old way.
  onLeave: ((url: string) => void) | null = null;
  // The host's bare home page, where the shell's own title screen stands in
  // for it (the device world's home is the app's home): handed here instead
  // of joining the stack. Null keeps the host's page. A home page with a
  // query (the campaign wizard's /?new=1) is still the host's, and so is
  // that page tidying its own address to "/" once the wizard is open.
  onHome: (() => void) | null = null;
  // How many times the page on screen has been refreshed: the game root
  // keys the page on it as well as on its route, so a refresh mounts the
  // page afresh and it loads its data again.
  refreshes = 0;

  constructor(initial: string) {
    this.stack = [split(initial)];
  }

  get location(): GameLocation {
    return this.stack[this.stack.length - 1] ?? { pathname: "/", search: "" };
  }

  get depth(): number {
    return this.stack.length;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private handsHome(location: GameLocation | undefined): boolean {
    if (!this.onHome || !location || location.pathname !== "/" || location.search !== "") return false;
    this.onHome();
    return true;
  }

  push(url: string): void {
    if (isAbsoluteUrl(url)) {
      this.onLeave?.(url);
      return;
    }
    if (this.handsHome(split(url))) return;
    this.stack.push(split(url));
    this.notify();
  }

  replace(url: string): void {
    if (isAbsoluteUrl(url)) {
      this.onLeave?.(url);
      return;
    }
    if (this.location.pathname !== "/" && this.handsHome(split(url))) return;
    this.stack[this.stack.length - 1] = split(url);
    this.notify();
  }

  back(): boolean {
    if (this.stack.length <= 1) return false;
    if (this.handsHome(this.stack[this.stack.length - 2])) return true;
    this.stack.pop();
    this.notify();
    return true;
  }

  // The same address, mounted afresh (the game root keys the page on
  // `refreshes`), which reloads its data the way a browser refresh would. A
  // fresh location object alone re-rendered the page and reloaded nothing:
  // the page is keyed on its route, which a refresh leaves as it was.
  refresh(): void {
    this.refreshes += 1;
    this.stack[this.stack.length - 1] = { ...this.location };
    this.notify();
  }
}

// Matches "/campaigns/:campaignId" style patterns against a path and
// returns the params, or null. One path piece per segment.
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const have = pathname.split("/").filter(Boolean);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const piece = want[i] ?? "";
    const value = have[i] ?? "";
    if (piece.startsWith(":")) {
      try {
        params[piece.slice(1)] = decodeURIComponent(value);
      } catch {
        params[piece.slice(1)] = value;
      }
    } else if (piece !== value) {
      return null;
    }
  }
  return params;
}
