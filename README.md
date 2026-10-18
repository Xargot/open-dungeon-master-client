<div align="center">

<img src="https://raw.githubusercontent.com/Lebbitheplow/open-dungeon-master/main/docs/banner.png" alt="Open Dungeon Master" width="100%">

<br>

[![License: MIT](https://img.shields.io/badge/license-MIT-d4ab3a?labelColor=151229&style=flat-square)](package.json)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-d4ab3a?labelColor=151229&style=flat-square)](https://github.com/Lebbitheplow/open-dungeon-master-client/releases/latest)
[![Hosts its own world](https://img.shields.io/badge/server-built%20in-d4ab3a?labelColor=151229&style=flat-square)](#a-world-on-your-device)
[![Latest release](https://img.shields.io/github/v/release/Lebbitheplow/open-dungeon-master-client?color=d4ab3a&labelColor=151229&style=flat-square)](https://github.com/Lebbitheplow/open-dungeon-master-client/releases/latest)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-e0703a?labelColor=151229&style=flat-square)](#building-from-source)
[![Main codebase](https://img.shields.io/badge/main%20codebase-open--dungeon--master-d4ab3a?labelColor=151229&style=flat-square&logo=github)](https://github.com/Lebbitheplow/open-dungeon-master)

</div>

> [!IMPORTANT]
> **The main codebase is
> [Lebbitheplow/open-dungeon-master](https://github.com/Lebbitheplow/open-dungeon-master).**
> The game itself (rules engines, the AI Dungeon Master, the game screens and the
> server) lives there, and so do most issues and contributions. This repository only
> packages that server into the desktop and Android apps. If you are looking to run a
> server, change how the game plays, or report a bug at the table, start there.

These are the **desktop and Android apps for
[Open Dungeon Master](https://github.com/Lebbitheplow/open-dungeon-master)**, the
multiplayer D&amp;D 5e table with an AI (or human) Dungeon Master. Every app carries
a complete Open Dungeon Master server inside it, so **you do not need a server to
play**: install the app, open your world, and share a room code with your friends.
When you do have a server, the app connects to it (or to any number of them) as well.

The rules engines, the AI Dungeon Master and the game screens all come from the
[server repository](https://github.com/Lebbitheplow/open-dungeon-master); this
repository is the shell around them. It runs the bundled server on your machine or
phone, opens a public address for it when you share, runs the AI Dungeon Master on
whatever you already have (a local model it installs for you, an API key, or a CLI
agent subscription like Claude Code or Codex), and draws the game screens natively for whichever host you
play on.

<div align="center">

<img src="https://raw.githubusercontent.com/Lebbitheplow/open-dungeon-master/main/docs/screenshot-phone.png" alt="A table on a phone: DM narration above the hand of cards, the turn order and the table's tab bar" width="240">

<sub><i>A live table on a phone. The Android app hosts that world itself.</i></sub>

</div>

## Download

The latest stable release is on the
[Releases page](https://github.com/Lebbitheplow/open-dungeon-master-client/releases/latest).
Every build ships first as a beta (marked Pre-release there) and is promoted to stable
unchanged once it holds up; the desktop app offers the betas too with App settings >
This app > Beta updates. How the channels work:
[releases.md](https://github.com/Lebbitheplow/open-dungeon-master/blob/main/docs/releases.md).
More help, and the full player guide, live at
[opendungeonmaster.com](https://opendungeonmaster.com/guide/).

| Platform | File | Notes |
| --- | --- | --- |
| **Windows** (x64) | `Open-Dungeon-Master-Setup-<version>.exe` | Installer; updates itself. Not code signed: when SmartScreen says "Windows protected your PC", choose More info, then Run anyway. |
| **macOS** (Apple Silicon) | `open-dungeon-master-client-<version>-arm64-mac.dmg` | Not notarized yet: the first time macOS blocks it, open System Settings > Privacy & Security and choose Open Anyway (on macOS 14 and earlier, right-click the app and choose Open). |
| **macOS** (Intel) | `open-dungeon-master-client-<version>-x64-mac.dmg` | Same as above. |
| **Linux** (x64) | `.AppImage`, `.deb`, `.rpm`, `.tar.gz`, `.flatpak` | The AppImage carries a static runtime, so it runs on distros that no longer ship libfuse2. |
| **Android** 8.0+ (arm64) | `open-dungeon-master-client-<version>.apk` | Sideload it: allow installs from your browser or file manager when Android asks. |

**Checking a download.** The release page lists a SHA-256 checksum beside every
file; compare it with `sha256sum <file>` (or `Get-FileHash <file>` in PowerShell).
Releases after 0.17.6 also carry a build attestation, which proves a file came out
of this repository's release workflow:
`gh attestation verify <file> --repo Lebbitheplow/open-dungeon-master-client`.

## What's in the box

<table>
<tr>
<td width="50%" valign="top" align="center">
<img src="https://raw.githubusercontent.com/Lebbitheplow/open-dungeon-master/main/public/sidebar-icons/local-data.webp" width="56"><br>
<b>A world on your device</b><br>
<sub>The app runs its own Open Dungeon Master server: enter your world from the title screen and it wakes up, close the app and it sleeps. Campaigns, characters and pictures stay on your computer or phone. No account anywhere else.</sub>
</td>
<td width="50%" valign="top" align="center">
<img src="https://raw.githubusercontent.com/Lebbitheplow/open-dungeon-master/main/public/sidebar-icons/chats.webp" width="56"><br>
<b>Share it with one code</b><br>
<sub>Open a campaign lobby and the app opens a public address for your world through a Cloudflare tunnel, with no port forwarding and no router setup. Friends join with the room code, an invite link, or a QR code. For a table in the same room, share on this Wi-Fi instead and play with no internet at all.</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top" align="center">
<img src="https://raw.githubusercontent.com/Lebbitheplow/open-dungeon-master/main/public/sidebar-icons/support.webp" width="56"><br>
<b>Any server, one app</b><br>
<sub>Add servers by address and the app remembers each session. A room code finds its table wherever the host is sharing from, even though the host's address changes every time, and <code>odm://</code> invite links open straight into the app.</sub>
</td>
<td width="50%" valign="top" align="center">
<img src="https://raw.githubusercontent.com/Lebbitheplow/open-dungeon-master/main/public/sidebar-icons/story.webp" width="56"><br>
<b>Native game screens</b><br>
<sub>The app ships the game's own screens and draws them itself; only game data travels to the host. The controls match everywhere, and a shared world costs far less traffic. Much older hosts open their own pages instead.</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top" align="center">
<img src="https://raw.githubusercontent.com/Lebbitheplow/open-dungeon-master/main/public/sidebar-icons/text-model.webp" width="56"><br>
<b>Story AI, your choice</b><br>
<sub>Decide who narrates your world: a human at the table, an AI Dungeon Master on your own OpenAI API key, or, on desktop, a local model the app sizes to your hardware, downloads and runs for you, or a CLI agent you already pay for (Claude Code, Codex, opencode, Grok Build) narrating on its own subscription.</sub>
</td>
<td width="50%" valign="top" align="center">
<img src="https://raw.githubusercontent.com/Lebbitheplow/open-dungeon-master/main/public/sidebar-icons/images.webp" width="56"><br>
<b>Local scene art</b><br>
<sub>On desktop the app can also install a local ComfyUI with one curated SDXL checkpoint for portraits, scene art and battle maps. Text and image stacks install and uninstall separately.</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top" align="center">
<img src="https://raw.githubusercontent.com/Lebbitheplow/open-dungeon-master/main/public/sidebar-icons/chats.webp" width="56"><br>
<b>Dice, voice and devices</b><br>
<sub>Pixels Bluetooth dice pair on desktop and Android alike, the 3D dice tray rolls in the app, and App settings holds the microphone, playback device and every volume, reachable over any running table.</sub>
</td>
<td width="50%" valign="top" align="center">
<img src="https://raw.githubusercontent.com/Lebbitheplow/open-dungeon-master/main/public/sidebar-icons/characters.webp" width="56"><br>
<b>A title screen for home</b><br>
<sub>The table you were last at fills the screen with its latest scene and a "when last we left" recap, your other tables sit as save slots grouped by host, and a guided tour shows where everything lives.</sub>
</td>
</tr>
</table>

## A world on your device

Every build carries the Open Dungeon Master server, built from the server repository
at release time, and runs it privately on your device:

- **Desktop** starts it as a child process from the app's data folder the first time
  you enter your world. Your first visit asks for a name and signs you in; there is
  no password to remember on your own world.
- **Android** runs the same server on a Node 24 runtime built for Android, with the
  phone's built-in SQLite engine. A foreground notification shows while the world is
  shared, and **Stop hosting** in that notification ends the share.

Your world stays offline until you share it. Opening a campaign lobby starts sharing
automatically: the app asks the Open Dungeon Master broker for a public
`play-CODE.opendungeonmaster.com` address, runs `cloudflared` to it, and hands out a
room code. The code never changes for that table; it only works while you are
sharing. Voice chat relays through Cloudflare TURN, so it works across networks
without opening ports either.

Desktop and Android behave the same way on purpose. The one exception is the AI a
computer runs: a local model or a CLI agent is a desktop-only Story AI.

## Story AI

**Story AI** (on the title screen's menu, and in Settings) decides who narrates the
world on your device:

- **A human Dungeon Master.** The app keeps the sheets, dice, maps and record; a
  person narrates. Works everywhere, no model needed.
- **Your own OpenAI API key.** The AI Dungeon Master and scene images run on OpenAI,
  billed to your key.
- **A local model** (desktop only). The app scans your GPU and memory, offers the
  Qwen3.6-35B-A3B tiers that fit (Q8 down to Q2, 12 to 45 GB) or a Gemma 4 12B
  fallback for smaller machines, and adds a small Qwen3.5-4B utility model for
  summaries when there is room. It downloads a pinned llama.cpp build (Vulkan on
  Windows and Linux x64, Metal on Apple Silicon), writes the preset the AI Dungeon
  Master was tuned on, and starts and stops the model with your world.
- **An agent you already have** (desktop only, not the Flatpak build). Claude Code,
  Codex, opencode or Grok Build, installed and signed in on this computer, narrates
  on the subscription you already pay for. No API key changes hands. The program
  gets none of its own tools, only the table's rules turn by turn, the same as the
  built-in storyteller.

Scene art on desktop can come from a local ComfyUI the app installs into its own
Python virtual environment (it needs Python 3 on the machine) with the SDXL base
checkpoint, about 7 GB.

To play with an AI Dungeon Master on someone else's server, connect to a server
whose admin has set one up. Tables run by a human Dungeon Master work on every host.

## Servers and invites

- **Add a server** by its address. Each server keeps its own accounts, so you sign
  in or register there once; the app remembers the session.
- **Join with a code** takes a room code, an invite link, or a scanned QR code (the
  Android app scans with the camera). The code resolves through the broker to
  wherever that table's host is sharing from right now.
- **Invite links** (`odm://join?...`) open the app directly on desktop and Android;
  the web version of the link offers the app or the browser.
- Beside every server in the menu you can forget it on this device or delete your
  account there for good.

When you enter a host running server 0.21.0 or newer, the app draws the game screens
itself from the pages it ships, and forwards data calls, live updates, pictures and
downloads to the host with your session. Hosts from server 0.16.0 on are loaded
through the app's bundled screens as well (Settings has the switch for these older
worlds); anything older opens its own web pages inside the app.

## Updates

The desktop app checks for a new release when it starts and offers to install it.
Where it can, it installs the update itself and relaunches:

- **Windows installer, AppImage, `.tar.gz`, macOS:** replaced in place.
- **`.deb` / `.rpm`:** installed through your package manager, which asks for your
  password.
- **Flatpak:** the new bundle installs through the system's flatpak (which may ask
  for your password), or opens in your software center when the app cannot reach
  it. A release that went out without a Flatpak bundle is not offered to Flatpak
  installs until one is there.
- **Store installs** (snap, or pacman through the AUR template in
  [packaging/aur](packaging/aur)) only announce the new version and leave the
  upgrade to that store.

On Android, install the new APK over the old one; your world and its data are kept.
Android only installs an app over one signed by the same key, and the APK from this
page and the Google Play build may not be. If Android refuses to install one over
the other, take your world out first with **Move your world** in Settings, since
uninstalling the app deletes it, then bring it into the new install the same way.

An older version may refuse to open a world a newer one has changed the shape of. It
says so and leaves the world as it is; update again to open it.

## Troubleshooting

Your world lives in the app's data folder, apart from the program itself, so
an update or a reinstall never touches it:

- **Windows:** `%APPDATA%\open-dungeon-master-client`
- **macOS:** `~/Library/Application Support/open-dungeon-master-client`
- **Linux:** `~/.config/open-dungeon-master-client` (a flatpak keeps it under
  `~/.var/app/com.opendungeonmaster.client/config/`)
- **Android:** the app's private storage, which uninstalling the app removes.

Inside it, `data/` holds the world's database and its key, and `local-server/`
the server files the app unpacked from its own copy, with your uploads,
paintings, narration and installed world packs beside them. An update replaces
the server files and carries those folders across. Uninstalling the desktop app
leaves the folder where it is.

- **Switching Linux packages:** the AppImage, `.deb`, `.rpm` and `.tar.gz` share
  that one folder, so moving between them keeps your world. The Flatpak keeps its
  own, so carry the world across with **Move your world** in Settings. On a Steam
  Deck, Game Mode and Desktop Mode run the same Flatpak and see the same world.
- **On Android** the world's database sits in the app's private storage, which
  Android encrypts along with the phone, but it has no key of its own the way the
  desktop's does: the phone's built-in SQLite has no cipher. Your sign-ins are
  sealed with the Android Keystore. Phone backups and transfers to a new phone
  leave the world out, so the new phone gets your server list and asks you to
  sign in again; bring the world over with **Move your world**.

Settings has a **Troubleshooting** card for the rest, and nothing on it
deletes anything you made:

- **Check files** reads every unpacked server file against the ones the app
  shipped with and says which are missing or changed.
- **Repair** unpacks the server files again, keeping your campaigns, pictures
  and installed worlds, and wakes your world again if it was awake. The app
  does this once on its own when your world fails to start and the check finds
  the files damaged; the title screen offers it too when the world will not
  wake.
- **Clear cached files** drops what the app cached from servers; sign-ins,
  saved servers and your world stay.
- **Copy summary** puts a short report on the clipboard for a bug report:
  versions, the state of your world, whether the local story and image AI
  are installed and answering (and the last thing that stopped them), and
  which server files are wrong. It names no accounts, keys or campaign
  text, and shortens paths to `~`.
- **Show logs** opens the folder with `local-server.log` and `tunnel.log`.
  Read a log before sharing it; the world's own output goes there.
- **Reset the app** is the one row that takes your world out of the app's
  hands, so it sits last, asks you to type `RESET`, and still deletes nothing:
  the app stops your world, restarts, and on the way back in renames its data
  folder to `open-dungeon-master-client.set-aside-<date>` beside the old place
  and starts from an empty one. Local AI engines you installed stay. To bring
  the old world back, close the app, remove the new data folder and rename the
  set-aside one back; to let it go, remove the set-aside folder yourself. On
  Android the system's own Clear storage for the app does the same, and that
  one does delete.

## Building from source

### Requirements

- **Node 22+** and npm.
- **A checkout of the server repository beside this one**, at
  `../open-dungeon-master`, with its dependencies installed (`npm install` there).
  The build bundles the server's page components into the app, and
  `bundle-server` builds the embedded server from it. Point elsewhere with
  `ODM_SERVER_DIR=/path/to/open-dungeon-master`.

```bash
git clone https://github.com/Lebbitheplow/open-dungeon-master.git
git clone https://github.com/Lebbitheplow/open-dungeon-master-client.git
(cd open-dungeon-master && npm install)

cd open-dungeon-master-client
npm install
npm run bundle-server   # builds vendor/server from a clean worktree at server HEAD
npm start               # builds and launches the desktop app
```

`bundle-server` rebuilds `better-sqlite3` for Electron's ABI, so rerun it after
changing Electron or the server. `vendor/server` is a build artifact and never
committed.

### Checks

```bash
npm run lint
npm test                        # builds, then node --test over tests/
npm run smoke-local             # boots the bundled server end to end
npm run smoke-relocate          # the server tree survives a move of the data folder
node scripts/smoke-tunnel.mjs   # a real share through the broker and cloudflared
```

Every pull request runs [.github/workflows/ci.yml](.github/workflows/ci.yml): lint,
the desktop build and tests, the mobile type check and tests, the main process's
file-handling tests on Windows, and the Android unit tests. The smoke runs above are
not part of it, so run them before opening a pull request.

### Desktop packages

```bash
npm run dist:linux   # AppImage, deb, rpm, tar.gz
npm run dist:win     # NSIS installer
npm run dist:mac     # dmg and zip
```

Each one builds, stages `vendor/server` for packaging (`npm run stage-desktop`), and
runs electron-builder; output lands in `release/`. A Flatpak needs flatpak-builder
and the freedesktop runtime: `npx electron-builder --linux flatpak`.

### Android

The Android app is a Capacitor 7 project in [mobile/](mobile). You need the Android
SDK and **JDK 21** (Gradle fails under JDK 25). The Node runtime and `cloudflared`
for Android are prebuilt and published as releases of this repository:

```bash
cd mobile
npm ci
mkdir -p runtime
gh release download node-android-v24.20.0 --pattern '*.tar.gz' --dir runtime
gh release download cloudflared-android-2026.8.3 --pattern '*.tar.gz' --dir runtime
(cd runtime && sha256sum -c ../runtime.sha256)   # the digests the release build checks
tar -C runtime -xzf runtime/node-android-v24.20.0.tar.gz
tar -C runtime -xzf runtime/cloudflared-android-2026.8.3.tar.gz

npm run sync             # builds the web assets and syncs Capacitor
npm run bundle-payload   # stages the server payload and runtimes into the app
cd android && ./gradlew assembleDebug
```

`npm run bundle-server` must have run at the repository root first; the payload is
built from `vendor/server`. To rebuild the runtimes themselves, see
[mobile/scripts/build-node-android.sh](mobile/scripts/build-node-android.sh) and
[mobile/scripts/build-cloudflared-android.sh](mobile/scripts/build-cloudflared-android.sh)
(Android NDK required). The mobile code has its own checks: `npm test` and
`npm run typecheck` inside `mobile/`.

## How the repository fits together

| Path | What lives there |
| --- | --- |
| [src/main](src/main) | Electron main process: the window, the embedded server (`local-server.ts`, `run-tree.ts`), sharing (`tunnel.ts`), the table registry, Bluetooth, the updater, and the local AI manager (`local-ai/`). |
| [src/preload](src/preload) | The bridge the shell and the game pages talk through, including `window.odmShell`. |
| [src/renderer](src/renderer) | The shell UI (title screen, servers, settings, guide, tour) and `game/`, which bundles the server's own pages with Preact shims and a runtime that routes their requests to the host. |
| [src/shared](src/shared) | Platform-free logic both apps share: invites and deep links, broker calls, portal rules, the home feed. |
| [mobile](mobile) | The Android app: the Capacitor bridge in `src/`, and the native world runtime, foreground service and tunnel in `android/`. |
| [scripts](scripts) | Build, bundling and smoke-test scripts. |
| [tests](tests) | Desktop unit tests, run with `node --test`. |
| [docs](docs) | Design notes, including [the desktop-Android bridge contract](docs/bridge-contract.md) that keeps the two apps in step. |

### Releases (maintainers)

Pushing a `v<version>` tag runs [release.yml](.github/workflows/release.yml): it
bundles the server's newest release (beta or stable; a tag off `main` takes the latest
stable one), builds every desktop target plus the Flatpak, builds the signed Android
APK and app bundle, and publishes them to the release: as a beta (a prerelease) while
the repository variable `PUBLISH_AS_BETA` is `true`, otherwise as the latest release.
Publish the server release first when a client release depends on server changes.
Promote a beta that held up with
`gh release edit v<version> --prerelease=false --latest`, together with the server
release it bundles (its release body names it); the rules are in the server's
[releases.md](https://github.com/Lebbitheplow/open-dungeon-master/blob/main/docs/releases.md). The Android signing key comes from the
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`
repository secrets. Keep `package.json` and `mobile/package.json` on the same version;
the Android upload refuses a tag that does not match.

## Privacy

Your world, its campaigns and its pictures live on your device. Nothing is sent
anywhere until you share a world, add a server, or choose an online Story AI:

- **Sharing** goes through a Cloudflare tunnel; the broker only issues the address and
  the TURN credentials for voice, and the tunnel closes when you stop sharing.
- **Servers you add** receive what you do on them, like any website.
- **OpenAI** receives the story prompts only if you pick your own OpenAI key as the
  Story AI. An agent you already have sends them to its own provider, on its own
  sign-in. A local model keeps everything on your machine.

There is no telemetry.

## Credits and licenses

The apps are MIT licensed, like the
[Open Dungeon Master server](https://github.com/Lebbitheplow/open-dungeon-master),
whose README lists the credits and content licenses for the game itself. The desktop
app is built on [Electron](https://www.electronjs.org/), the Android app on
[Capacitor](https://capacitorjs.com/); sharing uses
[cloudflared](https://github.com/cloudflare/cloudflared), and local AI uses
[llama.cpp](https://github.com/ggml-org/llama.cpp),
[ComfyUI](https://github.com/comfyanonymous/ComfyUI), and models downloaded from
their publishers under their own licenses (Qwen, Gemma, Stable Diffusion XL).

<sub>Dungeons &amp; Dragons and D&amp;D are trademarks of Wizards of the Coast LLC. This
project is not affiliated with, endorsed, or sponsored by Wizards of the Coast.</sub>
