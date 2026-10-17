// Putting the phone's own world to sleep once nobody needs it. The portal
// path (bridge.ts) starts the local server for a remote host, and the
// device world's own pages start it too; when the game web view closes,
// the server would otherwise run for the rest of the app's life. A grace
// period covers the player coming straight back.

export const IDLE_STOP_GRACE_MS = 30_000;

export interface IdleWorldInput {
  // The world is shared (tunnel up or coming up, or on the Wi-Fi): guests
  // may be on it.
  shared: boolean;
  // The app's own screens show the device world right now.
  nativeWorldOpen: boolean;
  // A game web view is open again, for any host.
  webViewOpen: boolean;
  // The web view that closed showed the device world's own pages. The
  // host may have handed out an address from there, so their world stays
  // up for those guests.
  ownWorldLeft: boolean;
}

export function shouldStopIdleWorld(input: IdleWorldInput): boolean {
  return !input.shared && !input.nativeWorldOpen && !input.webViewOpen && !input.ownWorldLeft;
}

export interface IdleStopperDeps {
  graceMs: number;
  // The facts of the moment, read when the grace period ends.
  inspect(): Promise<IdleWorldInput> | IdleWorldInput;
  stop(): Promise<void>;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export function createIdleStopper(deps: IdleStopperDeps): {
  // The web view just closed: look again once the grace period is over.
  arm(): void;
  // Something opened again; the pending look is off.
  cancel(): void;
} {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let timer: unknown = null;

  function cancel(): void {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function arm(): void {
    cancel();
    timer = setTimer(() => {
      timer = null;
      void (async () => {
        if (shouldStopIdleWorld(await deps.inspect())) await deps.stop();
      })().catch(() => undefined);
    }, deps.graceMs);
  }

  return { arm, cancel };
}
