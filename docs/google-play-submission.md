# Google Play submission: declarations and policy audit

Audited 2026-09-04 against the client repo at `main` (f667952) and the server
repo at `main` (ce9438c). Subject of the audit is the Android app only:
`com.opendungeonmaster.app`.

**Re-checked 2026-09-06** against client `main` at v0.7.3 (1eda722) and server
`main` at 0.16.3 (33fac2d), the two versions a submission would carry today.
Every code and build finding below is still fixed, and the permission list in
1.1 was re-read from the released v0.7.3 APK rather than from the source
manifest. What changed since the first pass and needed new wording here:

- The version facts are 0.7.3 / versionCode **703**, not the 0.4.1 / 40001
  this document used to claim. The formula is unchanged
  (major*10000 + minor*100 + patch); with a major of 0 it simply yields
  three digits, and the released 0.4.0 APK reads 400. Nothing was ever
  stamped with a five-digit code, so the sequence still only grows.
- Since 0.7.0 the app draws the game screens itself and sends the host only
  data calls (portal and native modes). That changes how the app is
  described to a reviewer, and it puts a second set of third-party
  JavaScript libraries inside the APK (1.3).
- Voice chat reaches Cloudflare's STUN and TURN servers, and the credentials
  come from the same developer-run Worker as the tunnel. The Data safety
  answers in 1.6 covered only the Share path and are now wider.
- Sign-in with Discord, the world pack registry hosted on Google Drive, and
  an OpenRouter default for the custom model provider are all recipients the
  first pass did not list.

The off-app work has moved too: the marketing site is live, the broker's
hashed rate limit is deployed, and `assetlinks.json` is being served. What
is left is the Play-managed signing certificate, the console forms and the
closed test. Each finding carries a "Done" line saying what landed.

Everything below is split into two halves. Part 1 is what Google asks you to
declare in the Play Console, answered from the code. Part 2 is the audit
against Play policy, ordered by how hard it blocks a submission.

---

## Part 0: build facts a reviewer will ask about

| Fact | Value | Where |
| --- | --- | --- |
| Application ID | `com.opendungeonmaster.app` | `mobile/android/app/build.gradle` |
| versionName / versionCode | 0.7.3 / 703 | derived from the repo root `package.json` by `mobile/android/app/build.gradle`; read back from the released APK with `apkanalyzer manifest version-code` |
| minSdk / targetSdk / compileSdk | 26 / 36 / 36 | `mobile/android/variables.gradle` |
| ABIs shipped | `arm64-v8a`, `x86_64` | `mobile/scripts/bundle-android-payload.mjs` |
| Artifacts CI produces | signed **arm64-v8a APK** (GitHub download, split per ABI since the 2026-09-23 size work) and signed **AAB** (Play upload, which Play splits per device); the x86_64 APK is built for the emulator launch check and not published. Before the draft goes live the release checks the signed APK's dex for every plugin method R8 must keep and starts the x86_64 APK on an emulator | `.github/workflows/release.yml` |
| Native libraries | `libnode.so` (Node 24.20.0), `libcloudflared.so` (cloudflared 2026.8.3), `libc++_shared.so` | `mobile/android/app/src/main/jniLibs/` |
| 16 KB page alignment | Yes, all three ELF LOAD segments align at 0x4000 | verified with `readelf -lW` |
| 64-bit support | Yes, both shipped ABIs are 64-bit | no 32-bit ABI is built |
| Signing | env-driven release keystore, PKCS12, alias `odm` | keystore at `~/.local/share/odm/odm-release.keystore` |
| Obfuscation | `minifyEnabled false` | no mapping file to upload |

### What the app actually does, in reviewer terms

Open Dungeon Master is a tabletop roleplaying client for Dungeons and Dragons
5th Edition campaigns. The Android app can work in three modes:

1. **Host on the phone.** The APK carries a full Node.js runtime plus the
   game server as a zip in assets. On first run the server is unpacked into
   app-private storage and launched as a child process on `127.0.0.1`. The
   game UI is that local server rendered in a WebView.
2. **Share that world.** An optional Cloudflare tunnel (`libcloudflared.so`,
   run as a second child process) publishes the phone's local server so
   friends can join from anywhere. A foreground service keeps it alive.
3. **Join someone else's server.** The user types a server address or scans a
   QR invite and plays on that server.

Mode 3 changed in 0.7.x and a reviewer will see the newer shape. The app now
carries the game's screens in its own assets and asks the host only for data:

- **Native screens** (host at server 0.16.1 or newer): the app renders the
  host's pages itself, in its own WebView, and calls the host's JSON API
  across origins.
- **Portal** (host at 0.16.0): same screens, served from the app's bundled
  copy of the server, which forwards the data calls to the host.
- **The host's own pages** (anything older, and any host that fails the
  version check): the old behaviour, that server loaded in a WebView.

`src/shared/portal-logic.ts` holds the version gate. The practical effect for
this document is that the microphone, camera and Bluetooth prompts now come
from the app's own WebView rather than from a remote page, and that the
report and block affordances in B-3 ship inside the APK instead of arriving
from whichever host the player joined.

There is no Open Dungeon Master account, no developer-run game backend, and
no hosted service. The one piece of developer-run infrastructure is a
Cloudflare Worker: it mints tunnel hostnames, and it hands out short-lived
Cloudflare TURN credentials for voice chat (see Data safety, below).

---

## Part 1: Play Console declarations

### 1.1 Permissions

Every permission in the merged release manifest. Re-verified 2026-09-06 with
`apkanalyzer manifest permissions` against the **released v0.7.3 APK**: the
sixteen entries below are exactly what ships, both location permissions carry
`maxSdkVersion='30'`, and nothing new arrived with the bundled game screens
(targetSdk reads 36, minSdk 26, versionCode 703 on the same build).

**Declared deliberately in `mobile/android/app/src/main/AndroidManifest.xml`:**

| Permission | Runtime prompt? | Why the app needs it |
| --- | --- | --- |
| `INTERNET` | No | Reaching a remote game server, and the tunnel. |
| `ACCESS_NETWORK_STATE` | No | Knowing whether the phone is on Wi-Fi so the LAN join address can be offered. |
| `FOREGROUND_SERVICE` | No | Keeps the phone-hosted world running while the host uses another app. |
| `FOREGROUND_SERVICE_SPECIAL_USE` | No | Type for the above. See 1.2. |
| `RECORD_AUDIO` | Yes | Voice chat between players at the table, and push-to-talk speech to text. Both run in the app's own WebView now that it draws the game screens; on an older host they run in the host's page instead. |
| `MODIFY_AUDIO_SETTINGS` | No | Routing voice chat audio. |
| `POST_NOTIFICATIONS` | Yes (Android 13+) | The hosting notification, plus turn alerts and session reminders. |
| `CAMERA` | Yes | Scanning a QR invite card. Paired with `<uses-feature android:required="false">` so camera-less devices can still install. |
| `BLUETOOTH_SCAN` (with `neverForLocation`) | Yes (Android 12+) | Pairing Pixels smart dice so physical rolls enter the game. |

**Pulled in by the `@capacitor-community/bluetooth-le` plugin:**

| Permission | Note |
| --- | --- |
| `BLUETOOTH_CONNECT` | Talking to a paired Pixels die. |
| `BLUETOOTH` (`maxSdkVersion=30`) | Legacy pre-Android-12 path. |
| `BLUETOOTH_ADMIN` (`maxSdkVersion=30`) | Legacy pre-Android-12 path. |
| `ACCESS_FINE_LOCATION` (`maxSdkVersion=30`) | Capped in the app manifest; Android 8 to 11 need it to BLE-scan. See B-4. |
| `ACCESS_COARSE_LOCATION` (`maxSdkVersion=30`) | Same. |

**Pulled in by `@capacitor/local-notifications`:**

| Permission | Note |
| --- | --- |
| `WAKE_LOCK` | Delivering a scheduled local notification. |
| `RECEIVE_BOOT_COMPLETED` | Re-registering scheduled notifications after a reboot. |

**Not requested, and worth stating in the listing because reviewers look for
them:** no `QUERY_ALL_PACKAGES`, no `READ_MEDIA_IMAGES` or `READ_MEDIA_VIDEO`
(image uploads go through the system document picker), no
`MANAGE_EXTERNAL_STORAGE`, no `SCHEDULE_EXACT_ALARM` or `USE_EXACT_ALARM`, no
`REQUEST_INSTALL_PACKAGES`, no SMS or call log permissions, no background
location.

### 1.2 Foreground service declaration

Play requires a separate declaration for every foreground service type, with
a video or description showing the user-visible feature.

- Service: `WorldService` (`mobile/android/app/src/main/java/com/opendungeonmaster/app/WorldService.java`)
- Type declared: `specialUse`
- `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` already set in the manifest: "Runs the
  player's own tabletop game server so friends on the same network can join
  while the app is in the background."
- User-visible behavior: a low-importance ongoing notification titled "Your
  world is shared" with a "Stop hosting" action. It starts only when the user
  shares the world, never during solo play, and stops on swipe-away.

Google asks for three things per type, and the use case here is **Other**,
since none of the preset ones describes a game server.

**Functionality**

> The user's phone hosts the tabletop game session other players are
> connected to. Open Dungeon Master runs a small game server on the device;
> when the user taps "Share online", an outbound tunnel publishes that server
> so invited friends can join from their own devices. The foreground service
> keeps that server and tunnel alive while the user switches to another app
> during play. It starts only when the user chooses to share, never during
> solo play, and it stops when the user taps "Stop hosting" or swipes the app
> away.

**User impact if the task is deferred or interrupted**

> Every connected player is disconnected mid-session. The host's device is
> the only copy of the game, so there is no server elsewhere to fall back to:
> play stops for everyone at the table until the host reopens the app and
> shares again. If the task is deferred at start, the address the host just
> handed out does not resolve and nobody can join.

**The demonstration video.** Two devices, about ninety seconds, filmed side
by side or with the joiner's screen cut in. The strings below are the ones
`WorldService.java` and the share screen actually produce, so the video and
this declaration agree.

| Time | Shot | Must be visible |
| --- | --- | --- |
| 0:00 | Open the app, enter the world hosted on this phone | The game running on the host device |
| 0:10 | Back out to Settings, "Share online" section, tap **Share online** | The button being tapped |
| 0:15 | Sharing starts | "Opening a public address...", then the **Shared online** badge with the address, and the notification appearing |
| 0:25 | Pull the shade down | "Your world is shared", "Friends can join at ... while this stays on.", and the **Stop hosting** action |
| 0:35 | Second device opens that address and joins | The joiner's screen in the game |
| 0:50 | Host presses Home and uses another app for 15 to 20 seconds | The host app clearly backgrounded, the ongoing notification still there |
| 1:05 | On the second device, take a turn or send a message | The session still live while the host is elsewhere |
| 1:15 | Host returns, pulls the shade, taps **Stop hosting** | The notification going away |
| 1:25 | Second device reloads and cannot reach the world | Sharing genuinely ended |

The 0:50 to 1:05 stretch is the argument: without the service Android kills
the server process there and the player at 1:05 is dropped. Keep that even if
everything else is trimmed. The help page asks only for a link and does not
name a platform; use an unlisted YouTube video, which reviewers can open
without signing in, rather than a Drive link that prompts for access. The
address on screen is a tunnel address that dies with the session, so showing
it costs nothing.

See finding B-5 for the risk that Google pushes back on `specialUse`.

### 1.3 Third-party SDKs and libraries

There is no analytics, attribution, crash-reporting, or advertising SDK in
the app. Google Play Services is not linked (`google-services.json` is absent
and the plugin block is skipped).

| Component | Version | License | What it does | Collects user data? |
| --- | --- | --- | --- | --- |
| Capacitor (`@capacitor/core`, `/android`) | ^7.0.0 | MIT | Native shell and JS bridge | No |
| `@capacitor/app` | ^7.0.0 | MIT | App lifecycle and deep link events | No |
| `@capacitor/preferences` | ^7.0.0 | MIT | Stores the server address and local profile | Local only |
| `@capacitor/filesystem` | ^7.1.8 | MIT | Saves exported character and campaign files | Local only |
| `@capacitor/share` | ^7.0.4 | MIT | System share sheet for invite links and exports | No |
| `@capacitor/local-notifications` | ^7.0.7 | MIT | Turn alerts and session reminders | No |
| `@capacitor/barcode-scanner` | ^2.2.6 | MIT | Scans the QR invite card | No |
| `@capacitor-community/bluetooth-le` | ^7.3.2 | MIT | Pixels smart dice pairing | No |
| `@capgo/inappbrowser` | ^7.0.0 | MPL-2.0 | The WebView the game runs in | No |
| AndroidX appcompat / coordinatorlayout / core-splashscreen | see `variables.gradle` | Apache-2.0 | UI plumbing | No |
| Node.js (bundled as `libnode.so`) | 24.20.0 | MIT | Runs the bundled game server on device | No |
| cloudflared (bundled as `libcloudflared.so`) | 2026.8.3 | Apache-2.0 | Optional outbound tunnel so friends can join | Connection metadata reaches Cloudflare |
| Bundled server dependencies | see server `package.json` | mixed OSS | The game itself: Next.js, better-sqlite3 (pruned on Android), mediasoup, pdf-lib, jszip, docx, Radix UI | No |

**The game screens the app now carries (new since 0.7.0).** `mobile/www/game`
is the host's own page components compiled against Preact, about 6.5 MB of
JavaScript and CSS in the APK's assets. Every library in it is a build-time
dependency of this repo, none of them phones anywhere: they render, and the
data comes from the host the user chose.

| Component | Version | License | What it does | Collects user data? |
| --- | --- | --- | --- | --- |
| `preact` (+ `preact/compat`) | ^10.29.8 | MIT | The runtime the host's React components are compiled onto | No |
| Radix UI (dialog, dropdown, tooltip, alert dialog) | ^1.x / ^2.x | MIT | Dialogs, menus and tooltips in those screens | No |
| `lucide-react` | ^1.41.0 | ISC | Icons | No |
| `tailwindcss` / `@tailwindcss/cli` | ^4.3.3 | MIT | Builds the stylesheet at build time | No |
| `clsx`, `tailwind-merge` | ^2.1.1 / ^3.6.0 | MIT | Class name helpers | No |
| `zod` | ^4.5.4 | MIT | Validates what the host sends back | No |
| `pdf-lib` | ^1.17.1 | MIT | Character sheet PDF export, on device | No |
| `@3d-dice/dice-box-threejs` (three.js) | ^0.0.12 | MIT | The 3D dice roller; its models and textures are fetched from the host, not a CDN | No |
| `@systemic-games/pixels-web-connect` | ^1.3.1 | MIT | Pixels dice over the app's Web Bluetooth bridge | No |
| `mediasoup-client` | ^3.23.1 | ISC | Voice chat client when the host runs an SFU (an Android host cannot; the worker is pruned) | Audio to the host |
| `qrcode`, `react-easy-crop` | ^1.5.4 / ^6.2.3 | MIT | Invite QR codes, avatar cropping | No |
| `@fontsource/cinzel` | ^5.3.0 | OFL-1.1 | The display face, bundled, not fetched | No |

Note for the console: cloudflared is the only component that sends anything
to a third party by design, and only when the user taps Share; voice chat is
the other network path that leaves the table, over Cloudflare's STUN and TURN
(1.6). `sharp`, `onnxruntime-node`, `better-sqlite3-multiple-ciphers` and the
mediasoup worker are pruned from the Android payload, so their native code is
not in the APK. The bundled fonts, dice assets and icons are all local files;
the app loads no script, style or font from any CDN.

### 1.4 Ads

**No ads.** There is no ad SDK, no ad mediation, no ad identifier use, and no
`com.google.android.gms.permission.AD_ID` permission. Answer "No, my app does
not contain ads" and leave the advertising ID declaration empty.

### 1.5 In-app purchases and monetization

**None.** No Play Billing library, no external payment flow, no donation or
subscription link anywhere in the client or server code. The app is free and
MIT licensed. Answer "No" to in-app purchases, and "Free" for pricing.

Because there is nothing to buy, the Payments policy and the alternative
billing rules do not apply.

### 1.6 Data safety

The honest headline is that the developer runs almost no infrastructure, but
"almost" is not "none", and the Data safety form has to reflect the exception.

**Data the app stores only on the user's device or the user's own server:**

| Data | Where | Notes |
| --- | --- | --- |
| Username and salted password hash | app-private SQLite on the phone, or the remote server the user joins | Never leaves that machine. |
| Campaign text, characters, chat messages, dice history | same | This is the game. |
| Uploaded and generated images and audio | app-private `files/` | |
| An OpenAI API key, if the user supplies one | the on-device server's settings table | The user pastes their own key. |

**Data that reaches a third party, and when:**

| Recipient | Trigger | What is sent |
| --- | --- | --- |
| Cloudflare (`broker.opendungeonmaster.com`, developer-operated Worker; older builds use `odm-tunnel-broker.tunnel-broker.workers.dev`, the same Worker) | User taps Share to publish their world | The local port number, plus the IP address Cloudflare attaches to the request. The Worker keeps a per-address rate-limit counter in its own SQLite store keyed by a salted SHA-256 of the address (24 hour TTL), never the address itself, plus a session record. See finding B-6. |
| Cloudflare (tunnel edge, `trycloudflare.com` or `play-CODE.opendungeonmaster.com`) | same | All game traffic between remote players and the phone transits the tunnel. |
| Cloudflare DoH (`cloudflare-dns.com/dns-query`) | same | A DNS lookup for the new tunnel hostname, to confirm it resolved. |
| The same Worker, at `/turn` | **A table starts voice chat**, not only on Share | The host asks for short-lived Cloudflare Realtime TURN credentials and caches them for 30 minutes. The request carries no game content; Cloudflare sees the asking address. An operator can set `ODM_ICE_BROKER_URL=off` to opt out, and a phone-hosted world asks for itself. |
| Cloudflare STUN and TURN (`stun.cloudflare.com`, `turn.cloudflare.com`) | Voice chat, from each player's device | The device's public address, so peers can find each other, and the audio itself whenever a direct peer connection cannot be made and the call has to be relayed. Nothing is stored there. |
| Google STUN (`stun.l.google.com`) | Voice chat, only when the broker is unreachable or switched off | The device's public address. Fallback path only (`src/lib/voice/mesh.ts`). |
| Discord (`discord.com`) | Only if the server's operator configured Discord sign-in and the user picks it | The OAuth exchange, and the Discord account's id, name and avatar come back to that server. |
| Google Drive (`drive.google.com`) | Only when an **admin** browses or installs a world pack from the default registry | The request for the registry index or a pack manifest. The registry is a static file; an operator can repoint it or set it to `off` (`src/lib/worlds/install.ts`). |
| OpenAI (`api.openai.com`) | Only if the user chooses the OpenAI option and pastes their own key | Prompts and game text, per OpenAI's own policy. |
| OpenRouter (`openrouter.ai`) or any other base URL | The custom provider option defaults to OpenRouter's API; nothing is sent until an operator saves a key | Prompts and game text, to whoever that endpoint belongs to. |
| Whatever server the user joins | User joins a friend's game | Everything they type in that game, and push-to-talk clips: the recording is posted to that server, which transcribes it with a speech service on its own machine unless its operator pointed `STT_URL` elsewhere. |
| A model provider the server operator configured | Set by the operator, not by the app | Prompts and game content. |

**Recommended form answers:** declare that the app collects "App activity"
and "Personal info: user IDs" in the sense that a user-chosen display name
and game content travel to the server the user chose to join, that it is not
shared with the developer, that data is encrypted in transit, and that users
can request deletion. Also declare **"Audio: voice or sound recordings"**,
collected but not shared: voice chat carries live audio between players (and
through Cloudflare's TURN relay when a direct connection fails), and a
push-to-talk clip is uploaded to the user's chosen server to be transcribed.
Neither is stored by the developer, and the transcript, not the audio, is
what the game keeps. Then use the free-text and privacy policy to explain
the self-hosted model. Do **not** claim "no data collected", because the
tunnel broker sees IP addresses, the Share path routes game traffic through
Cloudflare, and voice chat reaches Cloudflare whenever a table talks.

### 1.7 Account creation and deletion

The app does create accounts, on the phone-hosted server or on the server the
user joins. Play's account deletion requirement is satisfied in-app:
`/settings` has a "Delete account" section. Since server 0.13.0 deletion is
scheduled rather than immediate: `DELETE /api/profile` signs the account out
everywhere and stamps a due date, the purge job erases it after the admin-set
grace period (`accountDeletionGraceDays`, 0 to 90, default 14), and signing
in before then offers "Keep my account". Admins can erase any account at once
from `AdminUsersPanel`. Say so on the form: the console asks whether deletion
is immediate or delayed, and the honest answer is "delayed by up to the
server's grace period, default 14 days, undoable until then".

For the console's "Data deletion" URL requirement the site now has
`https://opendungeonmaster.com/delete-account/` (site repo,
`src/pages/delete-account.html`), which walks through both the per-server
account and a device-hosted world. Checked 2026-09-06: it answers 200, as do
`/privacy/` and `/terms/` (B-7).

### 1.8 Target audience and content rating

**Recommended target age group: 18 and over.** Reasoning:

- The AI Dungeon Master is whatever model the server operator pointed at.
  There is no content filter the app can guarantee, and the terms of service
  already say so.
- Players type free-form text to each other and can talk over voice chat.
- A user can point the app at any server on the internet.

Choosing 18+ keeps the app out of the Families policy and out of Designed for
Families entirely, which is the right call here.

**Suggested IARC questionnaire answers:**

| Question | Answer | Basis |
| --- | --- | --- |
| Violence | Yes, fantasy or cartoon violence, non-graphic | Turn-based 5e combat with hit points, monsters, and character death. No depiction beyond prose and optional generated art. |
| Blood or gore | Mild, prose only | Dark fantasy and horror genres are selectable. |
| Sexual content or nudity | No explicit content | The live DM prompt hard-codes fade to black: "Intimacy is available only to partners and always FADES TO BLACK ... No explicit sexual content, ever, however the table asks" (`src/lib/dm/prompt.ts`, `relationshipRules`). Romance is a relationship ladder only. See finding B-1 for dead code that contradicts this. |
| Profanity | Possible, user-generated | Players type freely; the model may swear. |
| Controlled substances | Incidental, fantasy setting | Taverns and potions. |
| Gambling | No | Dice are a game mechanic, no wagering, no simulated gambling. |
| Users interact | **Yes** | Multiplayer text chat and voice chat. |
| Users can share content | **Yes** | Campaigns, characters, images, and files are shared with the party. |
| Shares user location | No | The app never reads location, and the location permissions are now capped at API 30 (B-4). |
| Digital purchases | No | |
| Unrestricted internet access | **Yes** | The user can enter any server URL, and the WebView loads it. |
| Generative AI | **Yes** | Declare it. The narration, and optionally images, are model output. |

Expect this to land at Teen or Mature 17+ from IARC, with the AI and open
interaction answers being what drives it upward.

### 1.9 Declarations that do not apply

Not a financial, health, medical, VPN, government, blockchain, dating, news,
or child-directed app. No COVID or contact tracing. No device or call
recording. No accessibility service. No SDK that collects an advertising ID.

### 1.10 Release notes for the upload

Play allows 500 characters per language in "What's new", and the field is
required on every release. Both drafts below are under that; neither uses
the Dungeons and Dragons name, since the listing should describe a 5e
tabletop game rather than lean on someone else's trademark.

**For the first upload (v0.7.3, versionCode 703), 493 characters:**

```
First test build. Open Dungeon Master runs a 5e tabletop campaign with an AI Dungeon Master, on your own phone or on a server you choose.

- Host a world on your phone and share it with friends over a private link
- Join a table by address or QR invite
- Voice chat, 3D dice, Pixels smart dice, character sheets and maps
- A workshop for monsters, items, spells and lore
- Report and block tools at every table

No account with us: your world stays on your device, or on the server you joined.
```

**If a version-by-version note is wanted instead (0.7.3), 438 characters:**

```
- The app now draws every host's screens itself, so a table looks and works the same wherever you play
- Guided tours for the workshop, and a written guide behind the help button in every tool
- Pick lists instead of typing names: monsters, roll tables, items, cast, lore, spells, conditions and skills
- Settings, audio and dice controls open over a table instead of leaving it
- Steadier rejoining after a shared world's address changes
```

---

## Part 2: Policy and technical audit

Ordered by severity. Anything marked BLOCKER will stop the upload or the
review as things stand today.

### BLOCKER B-1: the app cannot be uploaded as an APK

`.github/workflows/release.yml` builds and signs a universal APK
(`:app:packageRelease`, 134 MB). Google Play has required an Android App
Bundle for all new apps since August 2021 and will reject the APK at upload.

**Fix.** Add an `:app:bundleRelease` step and publish the `.aab`. Keep the APK
for the GitHub release and sideloaders, since that is a genuinely useful
distribution channel for this project. With ABI splits, the per-device
download drops to roughly 85 MB (49 MB server payload plus about 32 MB of
compressed arm64 native code), comfortably under Play's 200 MB download cap.
Uploading the current universal build as a single artifact would be near that
cap for no reason.

**Done 2026-09-05.** `release.yml` runs `assembleRelease bundleRelease` and
uploads both `open-dungeon-master-client-<v>.apk` and `<v>.aab` to the GitHub
release; the AAB is what goes into the Play Console. Verified locally: the
bundle task builds at API 36 alongside the APK.

You will also need to decide on Play App Signing. Google will ask to manage
the signing key. If you enroll, the keystore at
`~/.local/share/odm/odm-release.keystore` becomes the upload key, and losing
it stops being fatal to updates. Enrolling is the safer choice, but note the
Play-signed APK will have a **different** certificate fingerprint than the
GitHub-released APK, which matters for App Links (see B-7). You decided to
enroll; the outstanding half is copying the Google-managed fingerprint into
the `j-redirector` Worker afterwards.

The different certificate also matters to players, and more than App Links do.
Android only installs an app over one signed by the same key, so a phone with
the GitHub APK cannot take the Play build (or the other way round) without
uninstalling first, and uninstalling deletes the phone's world. When enrolling,
Play offers to sign with a key you upload instead of one it generates ("Use a
different key", exported from `odm-release.keystore` with Google's PEPK tool).
Doing that keeps both channels on one certificate: either build installs over
the other, and assetlinks needs no second fingerprint. The cost is that the
key in `~/.local/share/odm` stays as precious as it is today, since Google
then holds a copy of it rather than a key of its own. Either way, the README
tells players to use Move your world before switching channels.

**Version codes, checked 2026-09-06.** The released v0.7.3 APK reads
versionCode 703 and versionName 0.7.3; the 0.4.0 build before it reads 400.
The formula never produced the five-digit codes an earlier draft of this
document quoted, so the sequence Play sees will only grow, as long as minor
and patch stay under 100 (0.17.100 would collide with 0.18.0); the build now
stops on a version past that. Since 1eda722 the
version is read from the repo root `package.json` rather than
`mobile/package.json`, which is what stopped the 0.7.3 tag from shipping an
app stamped 0.7.2.

### BLOCKER B-2: targetSdk 35 is below the current Play requirement

`variables.gradle` sets `targetSdkVersion = 35` (Android 15). Play's annual
target API rule required new apps and updates to target API 36 (Android 16)
from 31 August 2026. That date has passed, so a 0.3.1 build will be refused.

**Done 2026-09-05.** `variables.gradle` is at compileSdk 36 / targetSdk 36
and the release build passes locally (`apkanalyzer manifest target-sdk`
reports 36). The edge-to-edge and foreground service paths still want a run
on a real Android 16 device before upload.

**Fix.** Move `compileSdkVersion` and `targetSdkVersion` to 36, then retest
the two places most likely to break: the edge-to-edge handling that
`capacitor.config.ts` already forces with `adjustMarginsForEdgeToEdge`, and
the foreground service start path in `WorldService`. Confirm the exact
current requirement in the Play Console before you build, since the API level
floor moves every August.

### BLOCKER B-3: no in-app way to report AI-generated or user-generated content

Grepping the whole server UI finds no report or flag affordance. Two Play
policies both require one:

- **Generative AI apps** must give users an in-app mechanism to report or flag
  offensive AI-generated content, and that reporting has to inform moderation.
- **User-generated content** requires an in-app system for reporting content
  and users, plus a way to block abusive users.

The app has an AI narrator and multiplayer chat, so both apply. The
self-hosted architecture does not exempt you. Google's position is that the
app must offer the mechanism, and it is fine for the report to route to the
server operator rather than to you.

**Done 2026-09-05, server commit 6a6e4f2.** Every DM passage and every other
player's message carries a flag button (hover on player rows), and the
character menu in the party list offers Report player and Block player. The
report dialog (`ReportDialog.tsx`) takes a reason and notes, with "Also
block" on player targets; `POST /api/campaigns/:id/reports` stores the
report with a copy of the text as it read and notifies every admin. The
admin panel has a Reports tab (`AdminReportsPanel.tsx`, `/api/admin/reports`)
to read and resolve them. Blocks (`/api/profile/blocks`, listed under
Account settings) hide that player's table messages from the blocker and
refuse private chats and friend requests both ways. The party lead or owner
can mute a member from the lobby or the character menu
(`POST /api/campaigns/:id/mute`); `requireVoice` in `campaign-api.ts` turns
muted members away from actions, asks and side chats, and the composer says
why. `scripts/test-moderation.mjs` covers the data layer. Wording for the
listing and the console's UGC questions: reports go to the admins of the
server the player chose; the app has no central moderation because it has
no central service.

**Fix.** A modest version satisfies this: a report action on each DM message
and each player message that writes a row to a `reports` table on that
server, surfaced in the existing admin panel, plus a per-user block or mute
that the party lead and the admin can act on. The admin panel and the
`AdminUsersPanel` delete path already give you the moderation half. Document
in the listing that reports go to the operator of the server the player
chose, and that the app itself has no central moderation because there is no
central service.

### B-4: location permissions ship in the APK but are never used

The release APK declares `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION`
with no `maxSdkVersion`, inherited from `@capacitor-community/bluetooth-le`.
The app's own manifest already goes out of its way to mark `BLUETOOTH_SCAN`
`neverForLocation` specifically so Android 12+ never prompts for location, so
the intent is clear and correct. The declaration is the leftover.

This matters for three reasons: location is a sensitive permission that draws
extra review, the Play listing will show "location" to users, and the Data
safety form and IARC questionnaire both ask about location in a way that is
now awkward to answer cleanly.

**Done 2026-09-05.** Both overrides are in the manifest and
`apkanalyzer manifest permissions` on the API 36 build shows
`ACCESS_FINE_LOCATION' maxSdkVersion='30` and the same for coarse.

**Fix.** In `mobile/android/app/src/main/AndroidManifest.xml`, override both
with `android:maxSdkVersion="30"` and `tools:node="replace"`, matching the
pattern already used for `BLUETOOTH_SCAN`. Devices on API 26 to 30 genuinely
need fine location to BLE-scan, so capping rather than removing preserves the
Pixels dice feature on older phones. After the change, re-run
`apkanalyzer manifest permissions` and confirm the cap landed.

### B-5: `specialUse` foreground service is the type Google pushes back on hardest

The manifest comment is candid that no typed category fits a game server, and
that is a reasonable reading. But Google reviews every `specialUse`
declaration by hand and rejects it when it believes an existing type applies.
A reviewer may well argue that `dataSync` or `connectedDevice` covers
"maintaining a network connection so remote players stay connected".

**Prepare for it rather than be surprised.** Record a short screen capture of
the flow: user taps Share, the notification appears, a second device joins,
the user switches to another app, play continues, the user taps Stop hosting.
Attach it to the declaration. Have a fallback plan to switch to `dataSync` if
the declaration is refused, which is a one-line manifest change plus the
matching `FOREGROUND_SERVICE_DATA_SYNC` permission.

### B-6: the tunnel broker keeps raw IP addresses

`workers/tunnel-broker/src/index.js` rate limits by writing a KV key of the
form `ip:<cf-connecting-ip>:<date>` and `turn:<ip>:<date>`, with TTLs of
24 hours and 35 days respectively. That is a persisted identifier held by
developer-run infrastructure, so it is not covered by Play's "processed
ephemerally" exemption, and it contradicts the current privacy policy's flat
claim of "No data is sold, shared, or transmitted to any third party,
including the creator of Open Dungeon Master."

**Done 2026-09-05, deployed.** `rateLimited()` keys on
`sha256(RATE_LIMIT_SALT + ":" + ip)`; unsalted if the secret is missing, so
the limit never switches off. The secret was set with
`npx wrangler secret put RATE_LIMIT_SALT` and the Worker redeployed. The
privacy policy describes the broker, what it sees, and the 24 hour hashed
retention. Re-checked 2026-09-06: the Worker answers, including `/turn`,
which is what pulled the voice path into 1.6.

**Fix, in order of preference.** Hash the IP with a server-side salt before
using it as the KV key, which preserves the rate limit exactly and stops you
holding the address. Then update the privacy policy to say the broker exists,
what it sees, and for how long. This is a small change that turns an
inaccurate policy into an accurate one.

### B-7: privacy policy URL is required (the site was down; it is up now)

Play requires a publicly reachable privacy policy URL on the store listing,
and it must cover the app specifically. Two problems:

1. `https://opendungeonmaster.com/` returned HTTP 522 (Cloudflare cannot reach
   the origin) on every attempt during this audit on 2026-09-04. A dead URL
   fails review outright. The same outage means
   `/.well-known/assetlinks.json` is not being served, so the `autoVerify`
   App Links intent filter for `/j` invite pages will not verify, and QR
   invites will fall back to the browser.
2. The existing policy at `src/app/privacy/page.tsx` is written for
   self-hosters. It does not mention the Android app's camera, microphone,
   Bluetooth, or notification permissions, the tunnel broker, Cloudflare as a
   transit provider, or the on-device OpenAI key path.

**Findings 2026-09-05.** The site was never published anywhere: there is no
GitHub repo or Pages site for `open-dungeon-master-site`, and the Cloudflare
DNS records for the apex point at an origin that does not exist, hence the
522. The site repo (`/home/lebbi/open-dungeon-master-site`, not yet under
git) now builds `/privacy/` and `/delete-account/` from
`src/pages/privacy.html` and `src/pages/delete-account.html`, linked from a
Legal column in the footer, and `npm test` there passes. Publishing is the
outstanding step and needs your go, since it means a public repo: push
`dist/` (or the repo with a Pages workflow) to GitHub Pages with a `CNAME`
of `opendungeonmaster.com`, then point the apex at Pages in Cloudflare DNS
(proxied is fine; the Workers routes for `/j*` and `/.well-known/assetlinks.json`
keep running in front). The server's own `/privacy` and `/terms` pages were
also rewritten to cover the app permissions, the broker, Cloudflare, the
on-device AI key, reports, and deletion steps, so every server shows the
same story. The `j-redirector` Worker's last deploy predates its assetlinks
route; redeploy it after adding the Play-managed fingerprint to
`ANDROID_CERT_SHA256`.

**Done 2026-09-06, except the signing fingerprint.** The site is live:
`/`, `/privacy/`, `/terms/` and `/delete-account/` all answer 200, and
`/.well-known/assetlinks.json` serves two fingerprints, the debug key
`01:3E:...` and the release keystore `94:39:...`. The policy is
app-specific and covers the permissions in 1.1, the broker, Cloudflare, the
on-device AI key, Discord sign-in, reports and deletion. Two gaps that the
0.7.x code opened are written up as B-11 and B-12 below.

**Still to do.** Once you enroll in Play App Signing, add the
**Google-managed** certificate fingerprint from the console to the
`j-redirector` Worker's `ANDROID_CERT_SHA256` and redeploy, keeping the
release keystore's fingerprint listed so the GitHub-released APK keeps
verifying too. Until then a Play-installed build will not verify the `/j`
App Link and QR invites will open in the browser.

### B-8: `allowBackup="true"` sends the whole game database to Google Drive

The manifest sets `android:allowBackup="true"` with no `dataExtractionRules`
or `fullBackupContent`. Android's auto backup will therefore copy the app's
`files/` directory to the user's Google Drive, which on this app means the
campaign SQLite database, every uploaded image, password hashes for accounts
on the phone-hosted server, and the user's OpenAI API key if they entered
one.

This is not a Play policy violation on its own, but it is a real privacy
exposure that contradicts the app's own "your data stays on that server"
promise, and it will look bad if a reviewer or a user notices.

**Done 2026-09-05.** The manifest points `dataExtractionRules` at
`res/xml/data_extraction_rules.xml` (Android 12+) and `fullBackupContent` at
`res/xml/backup_rules.xml` (older); both exclude `files/data`, `files/server`,
`files/server.keep`, `files/local-server.log` and every database from cloud
backup and device transfer, so only the Capacitor preferences (saved servers,
local profile) follow the user to a new phone. Verified in the built APK.

**Fix.** Either set `android:allowBackup="false"`, or add a
`dataExtractionRules` XML that excludes `files/data/`, `files/server/`, and
`files/*.log` from both cloud backup and device-to-device transfer. Excluding
is better than disabling if you want users to keep their profile across a
phone upgrade.

### B-9: dead code in the server contradicts the shipped content rules

`src/lib/story-prompt.ts` line 18 contains a system prompt reading "This is
private adult fiction. Consensual NSFW content is allowed and should be
embraced ... Do not sanitize sexual tension, profanity, nudity, or explicit
adult intimacy."

To be clear about what is actually true at runtime: `buildStoryMessages`, the
only function that uses that string, has **no callers anywhere in the repo**.
The live D&D path builds its prompt from `src/lib/dm/prompt.ts`, whose
`relationshipRules` says the opposite and mandates fade to black. The string
is a leftover from the upstream Open Dungeon fork. So the app's behavior is
Play-compliant today.

It is still worth removing before you submit. The repo is public, the string
ships inside `server-payload.zip` in the APK, and Play's Sexual Content and
Profanity policy plus the Generative AI policy both prohibit apps that
facilitate generating sexual content. If anyone reviewing the app or the
source finds that prompt, "it is unreachable" is a much weaker answer than
its not being there.

**Done 2026-09-05, server commit 6a6e4f2.** The three system prompts and
`buildStoryMessages` are gone; the exported helpers stay and the suite
passes.

**Fix.** Delete `DEFAULT_SYSTEM`, `IMAGE_SYSTEM`, `IMAGE_DISABLED_SYSTEM`, and
`buildStoryMessages` from `story-prompt.ts`. The exported helpers the DM path
actually uses (`stripReasoningArtifacts`, `extractStoryText`,
`parseStoryModelResult`, `createStreamingArtifactFilter`,
`packStoryHistory`, `dimensionsForImage`) all stay.

### B-10: personal developer accounts need closed testing before production

If the Play developer account is a personal account created after 13 November
2023, Google requires a closed test with at least 12 testers opted in
continuously for 14 days before you can apply for production access. This is
a scheduling constraint, not a code one, but it adds two weeks minimum to the
timeline and people routinely discover it the week they wanted to ship.

Check the account type in the console now. If it applies, start recruiting
the 12 testers before you finish the code fixes above.

### B-11: the privacy policy does not cover the voice chat path

Found on the 2026-09-06 re-check. The live policy frames every Cloudflare
sentence as "when you share a world", and says plainly: "The developer
receives nothing at any other time."

That is no longer exactly true. `meshIceServers()` in the server's
`src/lib/voice/mesh.ts` calls the developer's broker at `/turn` whenever a
table starts voice chat, and hands the players Cloudflare STUN and TURN
servers; when two players cannot connect directly, their audio is relayed
through `turn.cloudflare.com`. On a phone-hosted world the machine making
that broker call is the user's own phone. A reviewer comparing the Data
safety form against the policy would find voice audio and a developer-run
endpoint that the policy does not mention.

**Fix, in the site repo** (`/home/lebbi/open-dungeon-master-site`,
`src/pages/privacy.html`), and in the server's `/privacy` page so both tell
the same story. Two sentences are enough, in the Cloudflare paragraph:

> Voice chat also uses Cloudflare. When your table starts a call, the server
> you are on asks the same broker for short-lived credentials to Cloudflare's
> STUN and TURN servers, which help your devices find each other and, when a
> direct connection is impossible, relay the call. Nothing said on the call is
> stored, by Cloudflare or by anyone else. A server operator can switch this
> off, in which case calls use public STUN alone.

Then move the policy's effective date, and soften "The developer receives
nothing at any other time" to name voice chat as the second case.

### B-12: the world pack registry is a third party the policy does not list

`src/lib/worlds/install.ts` browses and installs world packs from a registry
that defaults to a file on Google Drive. It is admin-only, nothing installs
by itself, and what comes back is a JSON manifest of prose, tables and
thumbnails rather than code, so the Device and Network Abuse policy is still
satisfied. But the request does reach Google, and neither the privacy policy
nor the Data safety notes mention it.

**Fix.** One line under Data sharing: browsing or installing an optional
world pack fetches it from the registry the server is pointed at, which by
default is a file hosted on Google Drive, and an operator can repoint it or
turn it off. Worth a sentence to a reviewer too, since packs are third-party
settings material and `UnofficialPackNotice.tsx` already says so in the UI.

### Watch items, not blockers

- **`usesCleartextTraffic="true"`** is justified by the comment (LAN servers
  are commonly plain HTTP, and the connect flow tries HTTPS first). Play
  allows it. It will show up in the pre-launch report as a security note.
  Consider narrowing it to a network security config that permits cleartext
  only for private address ranges, which keeps the LAN case and closes the
  general one.
- **Executing bundled binaries.** `WorldRuntime` and `ShareTunnel` launch
  `libnode.so` and `libcloudflared.so` as child processes. This is legitimate
  under the Device and Network Abuse policy because both binaries ship inside
  the APK and nothing executable is downloaded at runtime. `WorldRuntime`'s
  only network call is a health check against `127.0.0.1`. Keep it that way:
  the moment the app fetches code or a payload update from the network, that
  policy stops being satisfied. World packs (B-12) are the one thing fetched
  after install, and they are JSON manifests validated against a schema, not
  code. Worth a sentence in the console notes to a reviewer so the two large
  `.so` files do not look suspicious.
- **App size.** 130 MB APK, 128 MB bundle at 0.7.4, of which the game screens
  the app now carries are about 6.5 MB. Measured against the 0.7.3 artifacts,
  stripping `libc++_shared.so` (B-13) took the universal APK and the bundle
  down by 3.6 MB each. Per ABI, which is what a user actually downloads from
  Play, the library went from 2.30 MB to 0.40 MB compressed, so about 1.8 MB
  off an install; on disk it is the full 7.6 MB, since Android extracts
  `useLegacyPackaging` jniLibs at install time and the footprint is roughly
  double the download either way. Users on cheap devices will feel the rest
  of it. Not a policy matter.
- **The two Play Console upload warnings** (seen on the first test upload,
  2026-09-07) are both advisory and neither blocks a release.
  - *No deobfuscation file.* `minifyEnabled false`, so there is no mapping
    file and stack traces are already unobfuscated. Turning R8 on would trim
    part of the 28 MB of dex, but Capacitor resolves its plugins
    reflectively, so it needs keep rules and a pass over every plugin path on
    a device. Not worth doing mid closed-test; revisit when there is time to
    test it properly.
  - *No deobfuscation file, the size half (B-13).* The one real find behind
    that warning had nothing to do with R8: the NDK's `libc++_shared.so` was
    shipping with its debug info and full symbol table, 8.8 MB on arm64 and
    8.4 MB on x86_64. Nothing on the phone reads it, so
    `bundle-android-payload.mjs` now runs `llvm-strip` over it as it stages,
    leaving 1.2 MB with every dynamic symbol intact. Shipped in 0.7.4.
  - *No native debug symbols.* Worth knowing why this one barely applies: the
    app calls `System.loadLibrary` nowhere. `libnode.so` and
    `libcloudflared.so` are PIE executables that `WorldRuntime` and
    `ShareTunnel` launch as child processes, and both are already stripped,
    so no native frame ever appears in a crash Play can see. Adding
    `ndk { debugSymbolLevel 'SYMBOL_TABLE' }` would silence the warning and
    little else.
- **The four "app quality" suggestions in the console** (seen 2026-10-10)
  are recommendations, not policy checks, and none of them blocks a release.
  - *Edge-to-edge may not display for all users.* Done: `MainActivity` now
    calls `EdgeToEdge.enable` with transparent bars and light icons on every
    Android version, which is the alternative the note itself offers.
    Capacitor's forced margins keep the page between the bars as before, so
    the look is unchanged; the window background fills the bars.
  - *Deprecated edge-to-edge APIs or parameters.* The app's own
    `statusBarColor` and `navigationBarColor` theme attributes are gone from
    `styles.xml`. The other source was `@capgo/inappbrowser` 7.29.4's
    `WebViewDialog` (`setStatusBarColor`, `setNavigationBarColor`,
    `setDecorFitsSystemWindows`). Upstream replaced those in its 8.x line
    with a `SystemUiChromeSupport` helper (androidx `WindowCompat` plus the
    status bar color view), and 8.x needs Capacitor 8, so
    `mobile/patches/@capgo+inappbrowser+7.29.4.patch` backports that helper
    and `patch-package` applies it on every `npm ci`. Drop the patch when
    the plugin moves to 8.x. Below Android 15 the bars now take the dialog
    theme's default color instead of the toolbar color, which for the app's
    near-black toolbar is invisible.
  - *Picture-in-picture.* An engagement suggestion aimed at video apps.
    Nothing in the app plays video that a corner window would serve. Skip.
  - *Resizability and orientation restrictions.* The merged release manifest
    has no `screenOrientation`, `resizeableActivity` or aspect-ratio
    attributes, and no `setRequestedOrientation` call exists in the app, the
    plugins or the scanner library, so there is nothing to remove. The one
    real to-do behind it is a layout pass on a tablet or foldable.
- **The WebView loads arbitrary user-entered server URLs.** This is core to
  the product and is fine, but it is the reason the IARC "unrestricted
  internet access" answer is yes, and it is worth one line in the listing
  description so it does not read as a hidden browser. Since 0.7.x most
  hosts are drawn by the app's own screens instead, which makes the app read
  less like a browser, not more, but the fallback path is still there for
  hosts older than 0.16.1.
- **Optional world packs are third-party settings material.** They install
  only when an admin chooses one, carry their own licenses, and the UI says
  so (`UnofficialPackNotice.tsx`). Keep that notice: it is the difference
  between offering a pack and passing someone else's setting off as yours.
- **No armeabi-v7a.** Only 64-bit ABIs are built, so 32-bit-only devices
  cannot install. Play is fine with this. It just narrows reach.
- **`minifyEnabled false`.** Allowed. It does mean the APK is trivially
  decompilable, which for an MIT-licensed open source project is a non-issue.

---

## Pre-submission checklist

State as of the 2026-09-06 re-check, at client v0.7.3 / server 0.16.3.

Code and build:

- [x] B-1: publish an AAB, keep the APK for GitHub releases (CI uploads both)
- [ ] B-1: enroll in Play App Signing and record both certificate fingerprints
- [x] B-2: move compileSdk and targetSdk to 36 (still: retest edge-to-edge and the FGS start on a real Android 16 device)
- [x] B-3: add in-app content reporting and user blocking (server 6a6e4f2, bundled; since 0.7.x it also ships in the app's own screens)
- [x] B-4: cap both location permissions at `maxSdkVersion="30"`
- [x] B-6: hash IPs in the tunnel broker's rate limit keys
- [x] B-8: add `dataExtractionRules` excluding `files/data/` and `files/server/`
- [x] B-9: delete the unused NSFW prompt from `story-prompt.ts`
- [x] Re-run `apkanalyzer manifest permissions`, this time on the released v0.7.3 APK, and diff against 1.1 (matches: sixteen permissions, both location caps, targetSdk 36, versionCode 703)
- [x] B-13: strip `libc++_shared.so` while staging the runtime (0.7.4; 1.8 MB off a per-ABI download, 7.6 MB off disk)
- [x] Tag the client release that carries all of the above (v0.7.3 is the upload candidate)

Off-app:

- [x] B-7: publish the site so `opendungeonmaster.com` resolves (live; `/`, `/privacy/`, `/terms/`, `/delete-account/` all 200)
- [x] B-7: write the Android-specific privacy policy and the data deletion page (site `/privacy/`, `/delete-account/`; server `/privacy`, `/terms`)
- [x] B-7: redeploy `j-redirector` so `/.well-known/assetlinks.json` is served (serving the debug and release-keystore fingerprints)
- [ ] B-7: add the Play-managed fingerprint to `ANDROID_CERT_SHA256` and redeploy, after enrolling in Play App Signing
- [x] B-6: `wrangler secret put RATE_LIMIT_SALT` in `workers/tunnel-broker`, then `wrangler deploy`
- [ ] B-11: add the voice chat paragraph to the site's and the server's privacy policy, and move the effective date
- [ ] B-12: list the world pack registry under Data sharing in both policies
- [ ] B-10: confirm developer account type and start the 12-tester closed test if required

Console forms, answered from Part 1:

- [ ] Data safety (1.6)
- [ ] Foreground service declaration plus demo video (1.2)
- [ ] Content rating questionnaire (1.8)
- [ ] Target audience: 18 and over (1.8)
- [ ] Ads: none (1.4)
- [ ] Government apps, financial features, health: all no (1.9)
- [ ] Account deletion URL (1.7)
- [ ] Store listing: screenshots, feature graphic, short and full description
- [ ] What's new text for the first upload (0.7.3)
