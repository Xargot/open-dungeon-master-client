// Pictures and audio fetched with the player's token (portraits, uploads,
// generated art) live as object URLs. This is the bookkeeping around them:
// one cache per app session (kept across world entries, emptied when the
// host or the account changes, so a second look at a table does not
// download every portrait again but another account never sees the last
// one's private pictures), a byte cap beside the entry cap, and revocation
// deferred while anything still shows a URL.
import type { HostClient } from "../api/host.js";
import { createObjectUrlCache, createRevokePool } from "../../shared/object-url-cache.js";

const MAX_ENTRIES = 256;
const MAX_BYTES = 96 * 1024 * 1024;

// Who was handed which URL. `document.querySelector` finds an element on
// the page, but a `new Image()` warming a picture or a detached `Audio`
// still playing a sting is only known from here. Weak, so an element the
// page dropped does not keep its URL alive.
const holders = new Map<string, Set<WeakRef<Element>>>();

export function hold(element: Element, url: string): void {
  if (!url.startsWith("blob:")) return;
  let set = holders.get(url);
  if (!set) {
    set = new Set();
    holders.set(url, set);
  }
  set.add(new WeakRef(element));
}

function shows(element: Element, url: string): boolean {
  if (element.getAttribute("src") === url || element.getAttribute("href") === url) return true;
  return "currentSrc" in element && (element as HTMLMediaElement).currentSrc === url;
}

function inUse(url: string): boolean {
  if (document.querySelector(`[src="${url}"], [href="${url}"]`)) return true;
  // A page may copy an element's address into a background.
  for (const styled of document.querySelectorAll('[style*="blob:"]')) {
    if ((styled as HTMLElement).style.cssText.includes(url)) return true;
  }
  const set = holders.get(url);
  if (!set) return false;
  for (const ref of set) {
    const element = ref.deref();
    if (!element) set.delete(ref);
    else if (shows(element, url)) return true;
  }
  if (set.size === 0) holders.delete(url);
  return false;
}

const pool = createRevokePool({
  inUse,
  revoke(url) {
    holders.delete(url);
    URL.revokeObjectURL(url);
  },
});

const cache = createObjectUrlCache({ maxEntries: MAX_ENTRIES, maxBytes: MAX_BYTES, retire: pool.retire });

let holder = "";

// Called on every world entry: the cache serves one session at a time (the
// host and the token that signed in to it), keyed by origin and path
// (query included, so a sized variant is its own entry).
export function keepObjectUrlsFor(client: HostClient): void {
  const session = `${client.origin}\n${client.session.token}`;
  if (holder === session) return;
  holder = session;
  cache.clear();
}

// Signing out, or forgetting a server: nothing fetched with that session
// stays cached.
export function forgetObjectUrls(): void {
  holder = "";
  cache.clear();
}

export function objectUrlFor(client: HostClient, path: string): Promise<string> {
  return cache.get(`${client.origin}${path}`, () => client.blobUrl(path));
}

// Revokes what nothing shows any more; the rest waits for the next sweep.
export function sweepObjectUrls(): number {
  return pool.sweep();
}
