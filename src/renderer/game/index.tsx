// The native game screens: the host's pages, drawn by the app itself from
// the same components the server's site is built from, fed by the host's
// API over the shell's session. Mounted by the shell (app.ts) into its own
// page column, so the app's topbar and menu stay above every screen.
//
// Routes map a host path to a page module; a path with no native page is
// handed back to the shell (onLeave), which opens it the old way.
import { Component, Suspense, lazy, useEffect, useMemo, type ComponentType, type ReactNode } from "preact/compat";
import { render } from "preact";
import { DeviceSettings } from "@/components/DeviceSettings";
import { ConfirmHost } from "@/components/ui/ConfirmDialog";
import { PageSkeleton, type SkeletonKind } from "@/components/PageSkeleton";
import { HostClient, type HostSession } from "../api/host.js";
import { GameRouter, matchRoute } from "./router.js";
import { setNavigation } from "./shims/next-navigation.js";
import { resolvedParams } from "./params.js";
import { installLocalAssets, installRuntime, uninstallRuntime } from "./runtime.js";
import { useSyncExternalStore } from "preact/compat";

type PageModule = { default: ComponentType<{ params: unknown; searchParams?: unknown }> };

interface Route {
  pattern: string;
  load: () => Promise<PageModule>;
  // The shape the page holds while its code loads (the server's own
  // skeletons), so the screen arrives in place instead of after a spinner.
  skeleton?: SkeletonKind;
}

// The host's pages, by path. Each is the server's own page component.
const ROUTES: Route[] = [
  { pattern: "/", load: () => import("@/app/page"), skeleton: "home" },
  { pattern: "/campaigns/:campaignId", load: () => import("@/app/campaigns/[campaignId]/page"), skeleton: "lobby" },
  {
    pattern: "/campaigns/:campaignId/character",
    load: () => import("@/app/campaigns/[campaignId]/character/page"),
    skeleton: "sheet",
  },
  // The table view (docs/vtt-parity-implementation-plan.md 13.2): the
  // board, the scene and the title cards with no chrome, for a second
  // screen at an in-person table.
  { pattern: "/campaigns/:campaignId/table", load: () => import("@/app/campaigns/[campaignId]/table/page"), skeleton: "table" },
  { pattern: "/characters", load: () => import("@/app/characters/page"), skeleton: "roster" },
  { pattern: "/characters/new", load: () => import("@/app/characters/new/page") },
  { pattern: "/characters/:characterId", load: () => import("@/app/characters/[characterId]/page"), skeleton: "sheet" },
  // The library's build editor and "Duplicate and edit" (server issue 229).
  { pattern: "/characters/:characterId/edit", load: () => import("@/app/characters/[characterId]/edit/page") },
  // The hero page a new character's first save lands on (server PR #442).
  { pattern: "/characters/:characterId/ready", load: () => import("@/app/characters/[characterId]/ready/page") },
  { pattern: "/workshop", load: () => import("@/app/workshop/page"), skeleton: "shelf" },
  { pattern: "/workshop/:workshopId", load: () => import("@/app/workshop/[workshopId]/page"), skeleton: "hub" },
  { pattern: "/settings", load: () => import("@/app/settings/page") },
  { pattern: "/friends", load: () => import("@/app/friends/page"), skeleton: "list" },
  { pattern: "/admin", load: () => import("@/app/admin/page") },
  // The guided setup: the admin panel's settings one question at a time,
  // for a server this app is signed in to as an admin.
  { pattern: "/setup", load: () => import("@/app/setup/page") },
  { pattern: "/reference", load: () => import("@/app/reference/page"), skeleton: "list" },
  // The rulebook: the whole SRD 5.1 as a book.
  { pattern: "/rulebook", load: () => import("@/app/rulebook/page") },
  { pattern: "/join/:code", load: () => import("@/app/join/[code]/page") },
];

const pages = new Map<string, ComponentType<{ params: unknown; searchParams?: unknown }>>();

function pageFor(route: Route): ComponentType<{ params: unknown; searchParams?: unknown }> {
  let page = pages.get(route.pattern);
  if (!page) {
    page = lazy(route.load);
    pages.set(route.pattern, page);
  }
  return page;
}

class Boundary extends Component<{ children: ReactNode; onError: (error: unknown) => void }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }
  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

// A route change crossfades instead of cutting, the same thing the server's
// pages do through React (src/app/template.tsx there). The browser snapshots
// the outgoing page, the router swaps, and the snapshot fades into the new
// page. Only the game root takes part (home.css takes the document's
// transition name away), so the shell's topbar above it stays live. Skipped
// under reduced motion and where the API is missing, which leaves the plain
// swap.
type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => Promise<void>) => { finished: Promise<void>; ready?: Promise<void> };
};

function withViewTransition(root: HTMLElement, update: () => void): void {
  const start = (document as ViewTransitionDocument).startViewTransition;
  if (!start || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  // The root is named for the transition only. A name that stayed would
  // make it a stacking context, and the pages' fixed dialogs and overlays
  // (the new campaign wizard, the dice) would then sit under the shell's
  // topbar instead of over it.
  root.style.viewTransitionName = "odm-game";
  const transition = start.call(document, () => {
    update();
    // Preact renders on its next tick; hold the snapshot until that has run.
    // A timer, NOT requestAnimationFrame: the browser suppresses rendering,
    // and with it every animation frame, while a view transition waits for
    // this promise. Waiting on a frame meant waiting for the browser's own
    // four second timeout, with the old page frozen on screen, on every
    // change of page.
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  const unname = (): void => {
    root.style.viewTransitionName = "";
  };
  transition.finished.then(unname, unname);
  // A route change that lands while this one is still fading skips it, and
  // the browser rejects `ready` with "Transition was skipped": expected, and
  // not an error (the Workshop's place-in-the-URL navigation does it on a
  // replace that follows a push).
  transition.ready?.catch(() => undefined);
}

function GameApp({ router, root, onLeave }: { router: GameRouter; root: HTMLElement; onLeave: (url: string) => void }) {
  // One subscription for the life of the mount (a fresh function each
  // render would resubscribe each time). Every route change crossfades,
  // a change of query included: Kaleb wants the full set of transitions
  // on every device (decided 2026-09-22). Only the game root is captured,
  // so the shell's topbar stays live and the snapshot is smaller.
  const subscribe = useMemo(
    () => (listener: () => void) => router.subscribe(() => withViewTransition(root, listener)),
    [router, root],
  );
  const location = useSyncExternalStore(subscribe, () => router.location);
  let matched: { route: Route; params: Record<string, string> } | null = null;
  for (const route of ROUTES) {
    const params = matchRoute(route.pattern, location.pathname);
    if (params) {
      matched = { route, params };
      break;
    }
  }
  // A path with no native page is handed to the shell once per navigation:
  // the location object is new for each one and the same across the
  // re-renders in between, so an effect keyed on it never asks twice.
  const unmatched = matched ? null : location;
  useEffect(() => {
    if (unmatched) onLeave(unmatched.pathname + unmatched.search);
  }, [unmatched, onLeave]);
  // The promises the page gets are kept per route and per query, so an
  // effect a page keys on them runs when the address changes and not on
  // every render of this root.
  const routeKey = matched ? `${matched.route.pattern}${JSON.stringify(matched.params)}` : "";
  const routeParams = matched?.params ?? {};
  // routeKey carries the params' whole content, so it stands in for them.
  const params = useMemo(() => resolvedParams(routeParams), [routeKey]);
  const searchParams = useMemo(
    () => resolvedParams(Object.fromEntries(new URLSearchParams(location.search))),
    [location.search],
  );
  if (!matched) return <PageSkeleton />;
  // A plain global write, made during render on purpose: the page's
  // useParams() reads it synchronously on its own first render, which comes
  // before any effect of this component would run. It has no subscribers,
  // so writing it again on a re-render changes nothing.
  setNavigation(router, params.__value);
  const Page = pageFor(matched.route);
  // The query is not part of the key: a filter or tab in the address updates
  // the page it belongs to instead of tearing it down and starting it again.
  // A refresh is: it mounts the page afresh, so the page loads its data again.
  return (
    <>
      <Boundary
        key={`${routeKey}#${router.refreshes}`}
        onError={(error) => {
          console.error("game page failed", error);
          onLeave(location.pathname + location.search);
        }}
      >
        {/* The dust layer is the shell's (index.html, style.css): one for the
            whole app, under the stars and the topographic lines. */}
        <Suspense fallback={<PageSkeleton kind={matched.route.skeleton} />}>
          <Page params={params} searchParams={searchParams} />
        </Suspense>
      </Boundary>
      {/* The host's own confirm and notice (appConfirm, appNotice), which the
          server's root layout mounts: without one here every question a page
          asked fell back to the web view's bare confirm() and alert(), such
          as Discard this copy and deleting a campaign. Outside the page's
          boundary, so a question survives the page it was asked from. */}
      <ConfirmHost />
    </>
  );
}

export interface GameMount {
  router: GameRouter;
  unmount(): void;
}

export interface GameOptions {
  session: HostSession;
  path: string;
  // A path with no native page, or a full URL off the host: the shell
  // opens it the old way (web view) or in the browser.
  onLeave(url: string): void;
  // The host's bare home page, when the shell's title screen stands in for
  // it (GameRouter.onHome).
  onHome?(): void;
}

// A plain anchor in a host page (not a next/link) would take the whole
// window to the address; inside the app it goes through the router
// instead. Downloads, new tabs, modifier clicks and hash links are left
// to the browser and the download bridge.
function linkTarget(event: MouseEvent, origin: string): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as Element | null)?.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.hasAttribute("download")) return null;
  if (anchor.target && anchor.target !== "_self") return null;
  const raw = anchor.getAttribute("href") ?? "";
  if (raw.startsWith("#")) return null;
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  if (raw.startsWith(`${origin}/`)) return raw.slice(origin.length);
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  return null;
}

export function mountGame(root: HTMLElement, options: GameOptions): GameMount {
  const client = new HostClient(options.session);
  installRuntime(client);
  const router = new GameRouter(options.path);
  router.onLeave = options.onLeave;
  router.onHome = options.onHome ?? null;
  const onClick = (event: MouseEvent): void => {
    const url = linkTarget(event, client.origin);
    if (url === null) return;
    event.preventDefault();
    router.push(url);
  };
  root.addEventListener("click", onClick);
  // Warm the page a pointer or a finger is heading for: its code is fetched
  // on hover or touch, so the click lands on a page that is already loaded.
  const warmed = new Set<string>();
  const onIntent = (event: Event): void => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]");
    const raw = anchor?.getAttribute("href") ?? "";
    if (!raw.startsWith("/") || raw.startsWith("//")) return;
    const pathname = raw.split(/[?#]/)[0] ?? raw;
    const route = ROUTES.find((candidate) => matchRoute(candidate.pattern, pathname));
    if (!route || warmed.has(route.pattern)) return;
    warmed.add(route.pattern);
    void route.load().catch(() => warmed.delete(route.pattern));
  };
  root.addEventListener("pointerover", onIntent, { passive: true });
  root.addEventListener("touchstart", onIntent, { passive: true });
  render(<GameApp router={router} root={root} onLeave={options.onLeave} />, root);
  return {
    router,
    unmount() {
      root.removeEventListener("click", onClick);
      root.removeEventListener("pointerover", onIntent);
      root.removeEventListener("touchstart", onIntent);
      render(null, root);
      uninstallRuntime();
    },
  };
}

// Loads a path's page module ahead of time (the shell calls this for the
// host home while its own home screen is idle). The lazy component is
// created too, so the first render finds it resolved.
export function prefetch(path: string): void {
  for (const route of ROUTES) {
    if (!matchRoute(route.pattern, path)) continue;
    pageFor(route);
    void route.load().catch(() => undefined);
    return;
  }
}

// The machine's audio and dice controls (the server's DeviceSettings), for
// the shell's own Settings screen: the same stores the table's hooks read,
// so a change here reaches a call or a table already running.
export function mountDeviceSettings(root: HTMLElement): () => void {
  installLocalAssets();
  render(<DeviceSettings />, root);
  return () => render(null, root);
}

declare global {
  interface Window {
    odmGame?: {
      mountGame: typeof mountGame;
      mountDeviceSettings: typeof mountDeviceSettings;
      prefetch: typeof prefetch;
    };
  }
}

window.odmGame = { mountGame, mountDeviceSettings, prefetch };
