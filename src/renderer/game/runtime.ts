// What the host's pages assume about their world, supplied by the shell:
// a same-origin API (fetch of root-relative paths goes to the host with
// the bearer token), an event stream (EventSource cannot carry a header,
// so it is a fetch-backed stand-in), pictures and audio behind the login
// (root-relative sources become object URLs fetched with the token), and
// the window.odmShell contract the pages already use inside the apps.
import type { HostClient, StreamStop } from "../api/host.js";
import type { SseEvent } from "../../shared/sse.js";
import { hostRelativePath } from "../../shared/host-fetch.js";
import { rewriteCssUrls, rootRelativeCssUrls } from "../../shared/css-urls.js";
import { localAsset } from "./local-assets.js";
import { forgetObjectUrls, hold, keepObjectUrlsFor, objectUrlFor } from "./object-urls.js";
import { canStreamAudio, liveAudioUrl } from "./live-audio.js";
import { isLiveNarrationPath } from "../../shared/live-audio.js";

// Public static files of the host: no session needed, so the address is
// rewritten in place and the browser loads them itself. Any query on the
// path (a sized variant, "?w=256") travels with it untouched.
const PUBLIC_PREFIXES = ["/assets/", "/fx/", "/sidebar-icons/", "/dice-box/", "/icon", "/apple-icon"];
// Everything else root-relative that a media element asks for is behind
// the host's login and is fetched with the token.
const MEDIA_ATTRS = ["src", "poster"];
// The battle map is an SVG, and what it shows under and on the grid (a
// backdrop, the DM's overlay, a token's portrait or plate, an effect sheet)
// is an SVG <image>, whose address is its href. Left alone it would load from
// the app's own origin and draw nothing.
const SVG_IMAGE_ATTRS = ["href"];
const MEDIA_SELECTOR = "img, audio, video, source, image";
const SVG_NS = "http://www.w3.org/2000/svg";
// What an SVG <image> shows while its protected picture is fetched: one
// transparent pixel, so nothing is asked of the app's own origin.
const BLANK_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

let active: HostClient | null = null;
let nativeFetch: typeof fetch | null = null;
let nativeEventSource: typeof EventSource | null = null;
let observer: MutationObserver | null = null;
let mediaPatched = false;
// Pictures fetched with the player's token (portraits, uploads, generated
// art) live as object URLs, kept in the ring in object-urls.ts: 256 entries
// or 96 MB, whichever fills first, the oldest retired as newer ones arrive
// and revoked only once nothing on the page still shows it. The ring
// outlives a world entry; it is emptied when the host changes.

function isRootRelative(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

// Server pages sometimes paint root-relative artwork through inline CSS
// instead of an <img> (the campaign-setting cards' cover plates, a tile
// swatch, a map thumbnail). Inside the apps those paths point nowhere
// (Electron's file:// disk root, the Capacitor page's own origin), so each
// takes the road fixMedia gives a media element: the app's own copy when the
// shell bundled it, the host directly for a public path, and an object URL
// fetched with the token for a protected one (client PR #30, widened from
// bundled assets to every host path).
const backgroundsWritten = new WeakMap<Element, string>();

function fixBackgroundImage(element: Element): void {
  if (!(element instanceof HTMLElement)) return;
  const value = element.style.backgroundImage;
  // Our own rewrite comes back through the observer; nothing to do twice.
  if (!value || backgroundsWritten.get(element) === value) return;
  if (!rootRelativeCssUrls(value).length) return;
  const client = active;
  const protectedPaths: string[] = [];
  const fixed = rewriteCssUrls(value, (hostPath) => {
    const local = localAsset(hostPath);
    if (local) return local;
    if (!client) return null;
    if (!mustFetch(client) && PUBLIC_PREFIXES.some((prefix) => hostPath.startsWith(prefix))) return `${client.origin}${hostPath}`;
    protectedPaths.push(hostPath);
    return null;
  });
  backgroundsWritten.set(element, fixed);
  if (fixed !== value) element.style.backgroundImage = fixed;
  if (!client) return;
  for (const hostPath of protectedPaths) {
    void objectUrlFor(client, hostPath).then((url) => {
      // The page may have painted something else meanwhile; only the value
      // this call wrote is swapped.
      const current = element.style.backgroundImage;
      if (!url || current !== backgroundsWritten.get(element) || !current.includes(hostPath)) return;
      hold(element, url);
      const swapped = rewriteCssUrls(current, (path) => (path === hostPath ? url : null));
      backgroundsWritten.set(element, swapped);
      element.style.backgroundImage = swapped;
    });
  }
}

// A page's fetch, whether it passes a string, a URL or a Request. A Request
// carries an absolute address resolved against the app's own page, so the
// page's origin counts as "the host" too; the method and body ride along.
function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const client = active;
  const base = nativeFetch ?? fetch;
  if (!client) return base(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = hostRelativePath(url, document.baseURI);
  if (path === null) return base(input, init);
  if (path.startsWith("/api/auth/logout")) forgetObjectUrls();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("authorization", `Bearer ${client.session.token}`);
  headers.set("x-odm-client", "shell");
  const target = `${client.origin}${path}`;
  if (!(input instanceof Request)) return base(target, { ...init, headers, credentials: "omit" });
  return rebuild(input, target).then((request) => base(request, { ...init, headers, credentials: "omit" }));
}

// The same request at another address. A Request's url is read-only and a
// streaming body needs the duplex option to be copied, so the body is read
// out and given back; the page could not have reused it anyway.
async function rebuild(input: Request, target: string): Promise<Request> {
  const body = input.body === null || input.bodyUsed ? undefined : await input.arrayBuffer();
  return new Request(target, {
    method: input.method,
    headers: input.headers,
    body,
    signal: input.signal,
    redirect: input.redirect,
    integrity: input.integrity,
    keepalive: input.keepalive,
    cache: input.cache,
  });
}

// EventSource with a bearer header, on the HostClient's stream. A stop the
// host made permanent (the session refused) closes it and dispatches an
// "error" CustomEvent whose detail is the StreamStop, so a page can tell a
// reconnect pause from the end.
class HostEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private handle: { close(): void } | null = null;

  constructor(url: string | URL) {
    super();
    this.url = typeof url === "string" ? url : url.href;
    const client = active;
    if (!client || !isRootRelative(this.url)) {
      const real = nativeEventSource;
      if (!real) throw new Error("EventSource unavailable.");
      // Not a host stream: hand the real thing back to the caller.
      return new real(this.url) as unknown as HostEventSource;
    }
    this.handle = client.stream(
      this.url,
      (event: SseEvent) => {
        const message = new MessageEvent(event.event, { data: event.data, lastEventId: event.id });
        this.dispatchEvent(message);
        if (event.event === "message") this.onmessage?.(message);
      },
      (open, stop?: StreamStop) => {
        this.readyState = stop ? 2 : open ? 1 : 0;
        const event = open ? new Event("open") : new CustomEvent<StreamStop | null>("error", { detail: stop ?? null });
        this.dispatchEvent(event);
        if (open) this.onopen?.(event);
        else this.onerror?.(event);
      },
    );
  }

  close(): void {
    this.readyState = 2;
    this.handle?.close();
    this.handle = null;
  }
}

// A page served over https (the Android app is https://localhost) may not show
// a picture addressed at a plain http host: the WebView blocks it as an
// insecure image, whatever the app's mixed content setting says, while a
// fetch to the same host is allowed. So there every host picture, public or
// not, takes the road the protected ones already take: fetched, then shown
// from an object URL. Desktop (file://) and https hosts keep the direct road.
function mustFetch(client: HostClient): boolean {
  return window.location.protocol === "https:" && client.origin.startsWith("http:");
}

// Media elements: art the app carries is pointed at the app's own copy; a
// public path is pointed at the host directly; a protected one is loaded
// through the token and swapped for a blob.
function fixMedia(element: Element): void {
  const client = active;
  for (const attr of element.localName === "image" ? SVG_IMAGE_ATTRS : MEDIA_ATTRS) {
    const value = element.getAttribute(attr);
    if (!value || !isRootRelative(value)) continue;
    if (element.getAttribute(`data-odm-${attr}`) === value) continue;
    const local = localAsset(value);
    if (local) {
      element.setAttribute(`data-odm-${attr}`, value);
      element.setAttribute(attr, local);
      continue;
    }
    if (!client) continue;
    element.setAttribute(`data-odm-${attr}`, value);
    if (!mustFetch(client) && PUBLIC_PREFIXES.some((prefix) => value.startsWith(prefix))) {
      element.setAttribute(attr, `${client.origin}${value}`);
      continue;
    }
    void objectUrlFor(client, value).then((url) => {
      if (!url || element.getAttribute(`data-odm-${attr}`) !== value) return;
      hold(element, url);
      element.setAttribute(attr, url);
    });
  }
}

// The address a media element should really load: the host for a public
// path, an object URL (fetched with the token) for a protected one. The
// second case is asynchronous, so the caller gets the object URL later.
function resolveMedia(client: HostClient, value: string, apply: (url: string) => void): string | null {
  if (!isRootRelative(value)) return null;
  if (!mustFetch(client) && PUBLIC_PREFIXES.some((prefix) => value.startsWith(prefix))) return `${client.origin}${value}`;
  void objectUrlFor(client, value).then((url) => {
    if (url) apply(url);
  });
  return null;
}

// new Audio(url), new Image() and element.src = "/..." never touch an
// attribute the observer would see before the load starts, so the src
// setters are wrapped: a public path is redirected at once, a protected
// one is fetched first and then assigned.
function patchMediaSetters(): void {
  if (mediaPatched) return;
  mediaPatched = true;
  for (const proto of [HTMLMediaElement.prototype, HTMLImageElement.prototype, HTMLSourceElement.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, "src");
    if (!descriptor?.set || !descriptor.get) continue;
    const nativeSet = descriptor.set;
    Object.defineProperty(proto, "src", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(this: HTMLElement, value: string) {
        const client = active;
        const raw = String(value);
        const local = isRootRelative(raw) ? localAsset(raw) : null;
        if (local) {
          this.setAttribute("data-odm-src", raw);
          nativeSet.call(this, local);
          return;
        }
        if (!client || !isRootRelative(raw)) {
          nativeSet.call(this, value);
          return;
        }
        this.setAttribute("data-odm-src", raw);
        // Narration still being rendered is read as it arrives rather than
        // fetched whole, so its first line is heard at once.
        if (this instanceof HTMLMediaElement && isLiveNarrationPath(raw) && canStreamAudio()) {
          nativeSet.call(this, liveAudioUrl(() => patchedFetch(raw, { cache: "no-store" })));
          return;
        }
        const direct = resolveMedia(client, raw, (url) => {
          if (this.getAttribute("data-odm-src") !== raw) return;
          hold(this, url);
          nativeSet.call(this, url);
        });
        if (direct) nativeSet.call(this, direct);
      },
    });
  }
  // An SVG <image> takes its address from an href attribute, which Preact
  // sets with setAttribute before the element is in the page. The browser
  // starts loading at once, so a host path ("/uploads/...") was asked of the
  // app's own origin and missed (a 404, then the observer's swap a beat
  // later). The battle map's tokens and backdrops and WorldForge's web of
  // portraits all draw this way. So the attribute write itself is rerouted:
  // a carried asset or a public host path is set directly, and a protected
  // one shows nothing until its object URL arrives.
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function setAttribute(this: Element, name: string, value: string): void {
    const raw = String(value);
    if (this.localName !== "image" || this.namespaceURI !== SVG_NS || !SVG_IMAGE_ATTRS.includes(name) || !isRootRelative(raw)) {
      nativeSetAttribute.call(this, name, value);
      return;
    }
    const local = localAsset(raw);
    const client = active;
    if (!local && !client) {
      nativeSetAttribute.call(this, name, value);
      return;
    }
    nativeSetAttribute.call(this, `data-odm-${name}`, raw);
    if (local) {
      nativeSetAttribute.call(this, name, local);
      return;
    }
    const direct = resolveMedia(client!, raw, (url) => {
      if (this.getAttribute(`data-odm-${name}`) !== raw) return;
      hold(this, url);
      nativeSetAttribute.call(this, name, url);
    });
    nativeSetAttribute.call(this, name, direct ?? BLANK_IMAGE);
  };

  const NativeAudio = window.Audio;
  const PatchedAudio = function Audio(this: HTMLAudioElement, src?: string): HTMLAudioElement {
    const element = new NativeAudio();
    if (src !== undefined) element.src = src;
    return element;
  } as unknown as typeof HTMLAudioElement;
  PatchedAudio.prototype = NativeAudio.prototype;
  window.Audio = PatchedAudio;
}

function scan(root: Node): void {
  if (root instanceof Element) {
    fixBackgroundImage(root);
    if (root.matches(MEDIA_SELECTOR)) fixMedia(root);
    for (const node of root.querySelectorAll("[style]")) fixBackgroundImage(node);
    for (const node of root.querySelectorAll(MEDIA_SELECTOR)) fixMedia(node);
  }
}

// One batch of mutations. A node added under another node of the same
// batch is covered by that ancestor's scan and is skipped.
function onMutations(records: MutationRecord[]): void {
  const added = new Set<Node>();
  for (const record of records) {
    if (record.type === "attributes" && record.attributeName === "style" && record.target instanceof Element) {
      fixBackgroundImage(record.target);
    }
    if (record.type === "attributes" && record.target instanceof Element && record.target.matches(MEDIA_SELECTOR)) {
      fixMedia(record.target);
    }
    for (const node of record.addedNodes) added.add(node);
  }
  for (const node of added) {
    let parent = node.parentNode;
    while (parent && !added.has(parent)) parent = parent.parentNode;
    if (!parent) scan(node);
  }
}

// A file name from Content-Disposition, or the last path piece.
function downloadName(response: Response, path: string, preferred: string): string {
  if (preferred) return preferred;
  const disposition = response.headers.get("content-disposition") ?? "";
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  if (plain?.[1]) return plain[1].trim();
  const last = path.split("?")[0]?.split("/").filter(Boolean).pop() ?? "";
  return last || "download";
}

// <a download href="/api/..."> in the app's own page would look for the
// file on disk; the bytes are fetched with the session instead and handed
// to the download manager as a blob. On Android the shell's download
// bridge (mobile/src/bridge.ts) takes the click first and this never runs.
function onDownloadClick(event: MouseEvent): void {
  const client = active;
  if (!client || event.defaultPrevented) return;
  const anchor = (event.target as Element | null)?.closest("a[href][download]");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const href = anchor.getAttribute("href") ?? "";
  if (!isRootRelative(href)) return;
  event.preventDefault();
  const preferred = anchor.getAttribute("download") ?? "";
  void patchedFetch(href)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName(response, href, preferred);
      link.style.display = "none";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    })
    .catch((error: unknown) => console.error("download failed", error));
}

// A host picture is first asked for at the app's OWN address: the page sets
// src="/uploads/x.png", which from file:// or capacitor:// is a file that does
// not exist, and only then does the observer point it at the host. That first
// request fails at once, and a component with an error fallback (the faces on
// the board's turn rail, the painted icons) hears the failure and gives the
// picture up before the real copy has been asked for. The failure of the app's
// own bogus request is not news to anyone: it stops here, in the capture
// phase, and the element is fixed straight away.
const HOST_PATHS = ["/uploads/", "/generated/", "/generated-audio/", "/ambience/", "/assets/", "/fx/", "/sidebar-icons/", "/dice-box/", "/api/"];
let errorsGuarded = false;

function guardBogusErrors(): void {
  if (errorsGuarded) return;
  errorsGuarded = true;
  document.addEventListener(
    "error",
    (event) => {
      const element = event.target;
      if (!(element instanceof Element) || !active) return;
      const failed = (element as HTMLImageElement).currentSrc || element.getAttribute("src") || element.getAttribute("href") || "";
      let path = "";
      try {
        const url = new URL(failed, document.baseURI);
        // Only the app's own origin: a picture the HOST refused is real news.
        if (url.origin !== new URL(document.baseURI).origin && url.protocol !== "file:") return;
        path = url.pathname;
      } catch {
        return;
      }
      if (!HOST_PATHS.some((prefix) => path.startsWith(prefix))) return;
      event.stopImmediatePropagation();
      // The observer may not have reached it yet; the address is still the
      // root-relative one, so clear the marker and fix it now.
      for (const attr of ["src", "href", "xlink:href"]) {
        if (element.getAttribute(`data-odm-${attr}`) === element.getAttribute(attr)) element.removeAttribute(`data-odm-${attr}`);
      }
      fixMedia(element);
    },
    true,
  );
}

// For the app's own screens that draw a game panel with no host connected
// (Settings): only the picture setters, which send the painted icons to the
// app's own copy. Nothing else of the runtime needs a host-less page.
export function installLocalAssets(): void {
  patchMediaSetters();
}

export function installRuntime(client: HostClient): void {
  active = client;
  keepObjectUrlsFor(client);
  guardBogusErrors();
  document.removeEventListener("click", onDownloadClick);
  document.addEventListener("click", onDownloadClick);
  if (!nativeFetch) {
    nativeFetch = window.fetch.bind(window);
    window.fetch = patchedFetch;
  }
  if (!nativeEventSource) {
    nativeEventSource = window.EventSource;
    window.EventSource = HostEventSource as unknown as typeof EventSource;
  }
  patchMediaSetters();
  observer ??= new MutationObserver(onMutations);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [...MEDIA_ATTRS, ...SVG_IMAGE_ATTRS, "style"],
  });
  scan(document.body);
}

export function activeHost(): HostClient | null {
  return active;
}

// The world is left: the observer stops watching the shell's own screens,
// the object URLs stay for the next entry into the same host.
export function uninstallRuntime(): void {
  active = null;
  document.removeEventListener("click", onDownloadClick);
  observer?.disconnect();
}
