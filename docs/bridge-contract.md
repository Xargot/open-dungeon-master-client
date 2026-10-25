# Bridge contract: desktop and Android stay the same app

Two shells, one contract. The desktop shell (`src/main/`, `src/preload/`)
and the Android shell (`mobile/src/`) implement the same surfaces, so the
game and the shell UI behave the same on both. When the two sides drift, one
platform breaks with no error: "works on desktop, dead on Android" and
nothing says why.

Files and symbols are named here, not line numbers; line numbers go stale
with the next commit.

## The pairs

Each row is one surface with its two implementations and the shared module
between them. The comments at the top of most of these files say the same
thing; this page collects them in one place.

| Surface | Desktop | Android | Shared |
|---|---|---|---|
| Shell bridge (`window.odm`) | `src/preload/index.ts` (the `bridge` object) + `src/main/ipc.ts` (its handlers) | `mobile/src/bridge.ts` (the `bridge` object) | `src/shared/types.ts` (`OdmBridge`) |
| In-game door (`window.odmShell`) | `src/preload/game.ts` | `mobile/src/shell-hook.ts` | `src/shared/types.ts` (`ShellShareStatus`); the server's `src/lib/shell-host.ts` is the consumer |
| Device-hosted world | `src/main/local-server.ts` + the local flow in `src/main/ipc.ts` | `mobile/src/local-world.ts` | `src/shared/ai-setup.ts` (AI wiring) |
| Sharing a world | `src/main/tunnel.ts` (`QuickTunnel`) | `mobile/src/share-tunnel.ts` | `src/shared/broker.ts` (broker contract) |
| Room-code registry | `src/main/table-registry.ts` | the room code registry section of `mobile/src/bridge.ts` (`publishRoomCodes`) | `src/shared/broker.ts` |
| Home feed | `src/main/home-feed.ts` | `mobile/src/home-feed.ts` | `src/shared/home-feed-logic.ts` |
| Portal mode and session cookies | `src/main/window.ts` + `src/main/session-cookies.ts` | `mobile/src/bridge.ts` | `src/shared/portal-logic.ts` |
| Join links | `src/main/index.ts` | `mobile/src/bridge.ts` | `src/shared/deep-link.ts` |
| Moving a world, landing paths | `src/main/ipc.ts` | `mobile/src/bridge.ts` | `src/shared/relocate.ts`, `src/shared/open-path.ts` |
| Offer notifications (an offer only this player may answer) | `src/main/offer-notices.ts` + its `offer:notify` and `offer:clear` handlers in `src/main/ipc.ts` | `mobile/src/offer-notices.ts`, wired in `bridge.ts` | `src/shared/offer-notice.ts`; the game screens' side is `src/renderer/game/offer-watch.ts` |
| Pixels dice (Web Bluetooth) | `src/main/bluetooth.ts` + `src/preload/bluetooth-picker.ts` (device picker) | `mobile/src/ble-polyfill.ts`, `ble-polyfill-core.ts`, `ble-relay.ts` (`navigator.bluetooth` polyfill) | none: each side fills a different gap, the game just sees `navigator.bluetooth` |

## Platform-only by design

Not every capability has two sides. These are one-sided on purpose; keep
them that way unless the platform gap closes.

| Capability | Side | Why |
|---|---|---|
| `odmShell.shareLink` | Android | The webview has no `navigator.share`. The server marks it optional (`shareLink?` in `shell-host.ts`) and falls back to copy. |
| Download shim and relay (`download-shim*.ts`, `download-relay.ts`, `native-download.ts`) | Android | Electron downloads on its own; the InAppBrowser does not. |
| Idle world shutdown (`world-idle.ts`) | Android | Saves the phone's battery once the game view closes. |
| Bridge rate limiters (`throttle.ts`) | Android | The native status call is expensive on the phone. |
| In-app updater (`updater.ts`) | Desktop | The store owns updates on Android; its `updateCheck` answers "nothing to do". |
| Story memory model choice (`src/shared/story-memory.ts`) | Desktop | The phone payload leaves the embedding runtime out. |

## Rules

- A new shell capability starts as a type in `src/shared/types.ts`, then gets
  implemented in `src/preload/index.ts` + `src/main/ipc.ts` and in
  `mobile/src/bridge.ts`. Add it to one side only when it belongs in the
  platform-only table above: mark it optional in the type and add a row
  there.
- Change one side of a pair, change the other in the same PR. If the other
  side cannot follow yet, say so in the PR body.
- Behaviour both sides share goes in `src/shared/` (pure, tested with the
  desktop suite), not copied into each shell. `broker.ts` and
  `home-feed-logic.ts` are the pattern. Still duplicated, and the next
  candidates: the fallback and wait logic in `tunnel.ts` vs `share-tunnel.ts`,
  and the room-code publishing in `table-registry.ts` vs `bridge.ts`.
- `window.odmShell` has no single shared type yet: the desktop preload uses
  `ShellShareStatus` and the Android hook declares its own `ShellHost`. Check
  both by hand, and against the server's `shell-host.ts`, when it changes.
- Tests run per side: `npm test` at the root runs `tests/*.test.mjs` (desktop
  and `src/shared/`), `cd mobile && npm test` runs `mobile/tests/*.test.ts`
  (Android). A contract change needs a test on both sides. CI does not run
  either suite (`release.yml` only builds), so run both before you push.
