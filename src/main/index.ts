import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { app, safeStorage, session, shell } from "electron";
import { deckLaunchArgs, detectDeck, steamLaunched } from "../shared/deck";
import { APP_ID, LEGACY_APP_ID } from "./app-names";
import { joinLinkFromArgv, parseJoinLink, type JoinLink } from "../shared/deep-link";
import { LocalAiManager } from "./local-ai/manager";
import { LocalServer } from "./local-server";
import { registerIpc, type ShellIpc } from "./ipc";
import { applyPendingReset } from "./reset";
import { LOCAL_SERVER_ID, ServerStore, type TokenCrypt } from "./servers";
import { storyMemoryEnv, storyMemorySupported } from "../shared/story-memory";
import { QuickTunnel } from "./tunnel";
import { repointRenamedShortcut } from "./steam-shortcut";
import { systemSteamHost } from "./steam-host";
import {
  detectInstallKind,
  flatpakIsSystemWide,
  flatpakMoveCommand,
  flatpakRelaunchCommand,
  packageFormatOf,
  Updater,
} from "./updater";
import { ShellWindow } from "./window";
import { wireContextMenus } from "./edit-menu";
import { isolateShellPages } from "./isolation";
import { isUnsealHelper, recoverRenamedSeals, runUnsealHelper, unsealWithRenamedKey } from "./renamed-key";

// The app's name as the keychain knows it; see app.setName at the bottom.
const KEYCHAIN_NAME = "open-dungeon-master-client";

// Session tokens go through the OS keychain when one is available. The
// "plain:" fallback (headless Linux without a keyring) is marked so tokens
// encrypted one way are never misread the other. On Linux with no keyring,
// safeStorage still "encrypts", with a fixed key (its basic_text backend),
// which protects nothing; Settings says so rather than claim a keyring.
function makeCrypt(): TokenCrypt {
  return {
    protection() {
      if (!safeStorage.isEncryptionAvailable()) return "none";
      if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") return "obscured";
      return "keyring";
    },
    encrypt(plain: string): string {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.encryptString(plain).toString("base64");
      }
      return `plain:${Buffer.from(plain, "utf8").toString("base64")}`;
    },
    decrypt(cipher: string): string | null {
      try {
        if (cipher.startsWith("plain:")) {
          return Buffer.from(cipher.slice(6), "base64").toString("utf8");
        }
        return safeStorage.decryptString(Buffer.from(cipher, "base64"));
      } catch {
        return null;
      }
    },
  };
}

function main(): void {
  // This local working copy keeps the existing dev profile separate from the installed app.
  app.setPath("userData", path.join(app.getPath("appData"), app.isPackaged ? "open-dungeon-master-client" : "open-dungeon-master-client-dev"));
  // Cut, Copy and Paste on a right-click, in every page the app shows.
  wireContextMenus(app);

  let pendingJoin: JoinLink | null = joinLinkFromArgv(process.argv);
  let ipc: ShellIpc | null = null;
  let win: ShellWindow | null = null;

  const dispatch = (link: JoinLink): void => {
    if (ipc) {
      void ipc.handleJoinLink(link);
    } else {
      pendingJoin = link;
    }
  };

  // Development runs must not replace the installed app's protocol handler.
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient("odm");
  }

  app.on("second-instance", (_event, argv) => {
    win?.focus();
    const link = joinLinkFromArgv(argv);
    if (link) dispatch(link);
  });

  // macOS delivers deep links here instead of argv.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    const link = parseJoinLink(url);
    if (link) dispatch(link);
  });

  void app.whenReady().then(async () => {
    // Windows shows an app's notifications (an offer only this player may
    // answer) under the id of its Start menu shortcut, which electron-builder
    // names after appId.
    if (process.platform === "win32") app.setAppUserModelId(APP_ID);
    // The shell's own pages (the main window and the table screen) are
    // cross-origin isolated before either loads (src/main/isolation.ts).
    isolateShellPages(session.defaultSession);
    // A reset the previous run asked for (src/main/reset.ts) comes first,
    // before the registry, the world or any session opens the folder.
    const reset = await applyPendingReset(app.getPath("userData")).catch((err: unknown) => {
      console.error("[reset] the app's data could not be set aside", err);
      return null;
    });
    const store = new ServerStore(path.join(app.getPath("userData"), "servers.json"), makeCrypt());
    // What 0.22.0 sealed under the name it alone ran as is opened by a
    // helper under that name and sealed again under this one, once, before
    // anything signs in (src/main/renamed-key.ts). Windows seals with no
    // name, and a run that cannot seal has nothing to seal it again with.
    if (process.platform !== "win32" && safeStorage.isEncryptionAvailable()) {
      await recoverRenamedSeals(store, (ciphers) =>
        unsealWithRenamedKey(ciphers, {
          execPath: process.execPath,
          appPath: process.defaultApp ? app.getAppPath() : null,
        }),
      ).catch((err: unknown) => console.error("[keychain] the sign-ins 0.22.0 sealed could not be opened", err));
    }
    const payloadDir = app.isPackaged
      ? path.join(process.resourcesPath, "server")
      : path.join(app.getAppPath(), "vendor", "server");
    // The story memory model is read at every start, so a changed setting
    // reaches the server on its next (re)start. Where the package carries
    // no embedding runtime there is nothing to choose and nothing is passed.
    const local = new LocalServer(
      payloadDir,
      app.getPath("userData"),
      path.join(__dirname, "..", "renderer"),
      (): Record<string, string> =>
        storyMemorySupported(process.platform, process.arch) ? storyMemoryEnv(store.storyMemory()) : {},
    );
    const tunnel = new QuickTunnel(
      path.join(app.getPath("userData"), "bin"),
      path.join(app.getPath("userData"), "tunnel.log"),
    );
    const localAi = new LocalAiManager(path.join(app.getPath("userData"), "local-ai"));
    // Which package this install came from: electron-builder writes
    // resources/package-type into the rpm and deb it builds, and nowhere
    // else, so it is the package manager's own claim on these files.
    let packageType = "";
    if (app.isPackaged && process.platform === "linux") {
      try {
        packageType = fs.readFileSync(path.join(process.resourcesPath, "package-type"), "utf8").trim();
      } catch {
        // An AppImage, flatpak or tar.gz: no package behind it.
      }
    }
    // A flatpak updates into the installation that holds it.
    let flatpak: { id: string; system: boolean } | null = null;
    if (process.env.FLATPAK_ID) {
      let info = "";
      try {
        info = fs.readFileSync("/.flatpak-info", "utf8");
      } catch {
        // Not readable: the per-user installation is the safe guess.
      }
      flatpak = { id: process.env.FLATPAK_ID, system: flatpakIsSystemWide(info) };
    }
    // Is the command on the PATH? Decides which package manager (and
    // whether pkexec) an install can lean on.
    const onPath = async (command: string): Promise<boolean> => {
      for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        if (!dir) continue;
        try {
          await fs.promises.access(path.join(dir, command), fs.constants.X_OK);
          return true;
        } catch {
          // Not here; try the next directory.
        }
      }
      return false;
    };
    // The new binary starts once this process is gone: from an AppImage
    // the mount goes with the process, so the path must be the file. A
    // flatpak is started again by the host, which waits for this
    // sandbox to close; the app quits once the host has the command.
    // A Steam Deck launch option goes along either way. The updater and
    // the reset (Settings, Troubleshooting) both leave this way.
    const launchedBySteam = steamLaunched(process.env);
    // A flatpak from before the rename, started from the desktop, hands
    // over to the renamed app once that is installed (flatpakMoveCommand),
    // taking a Steam shortcut to it along first.
    const flatpakCommand = async (id: string, system: boolean, args: string[]): Promise<[string, string[]]> => {
      if (id !== LEGACY_APP_ID || launchedBySteam) return flatpakRelaunchCommand(id, args);
      const installed = await new Promise<boolean>((resolve) => {
        const probe = spawn("flatpak-spawn", ["--host", "flatpak", "info", APP_ID], { stdio: "ignore" });
        probe.once("error", () => resolve(false));
        probe.once("exit", (code) => resolve(code === 0));
      });
      if (!installed) return flatpakRelaunchCommand(id, args);
      await repointRenamedShortcut({ home: os.homedir(), artDir: path.join(process.resourcesPath, "steam") }, systemSteamHost(true)).catch(
        (err: unknown) => console.error("[rename] the Steam shortcut still starts the old app", err),
      );
      return flatpakMoveCommand(id, APP_ID, system, os.homedir(), args);
    };
    const startFromHost = (command: string, args: string[]): void => {
      const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      let quitting = false;
      const quit = (): void => {
        if (quitting) return;
        quitting = true;
        app.quit();
      };
      child.stdout.once("data", quit);
      child.once("error", quit);
      child.once("exit", quit);
      setTimeout(quit, 5_000);
      child.unref();
    };
    const relaunch = (execPath?: string): void => {
      if (!flatpak) {
        app.relaunch(execPath ? { execPath, args: deckLaunchArgs(process.argv) } : undefined);
        app.quit();
        return;
      }
      void flatpakCommand(flatpak.id, flatpak.system, deckLaunchArgs(process.argv)).then(([command, args]) => startFromHost(command, args));
    };
    const updater = new Updater(
      detectInstallKind(process.env, process.execPath, process.platform, app.isPackaged, packageType),
      app.getVersion(),
      undefined,
      undefined,
      {
        format: packageFormatOf(packageType),
        platform: process.platform,
        arch: process.arch,
        execPath: process.execPath,
        // Read when an update installs: Add to Steam may have renamed the
        // AppImage since start (src/main/steam-shortcut.ts).
        get appImagePath() {
          return process.env.APPIMAGE ?? "";
        },
        downloadsDir: () => app.getPath("downloads"),
        open: async (file) => {
          const failure = await shell.openPath(file);
          if (failure) {
            shell.showItemInFolder(file);
            throw new Error(`The update is in your Downloads folder, but nothing here opens it: ${failure}`);
          }
        },
        reveal: (file) => shell.showItemInFolder(file),
        has: onPath,
        writable: async (dir) => {
          try {
            await fs.promises.access(dir, fs.constants.W_OK);
            return true;
          } catch {
            return false;
          }
        },
        run: (command, args) =>
          new Promise((resolve, reject) => {
            const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            child.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString();
            });
            child.on("error", reject);
            child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
          }),
        relaunch,
        flatpak,
        launchedBySteam,
        // userData/updater.log: why a check or an install failed, which
        // otherwise went nowhere. Rotated like the other logs.
        log: (line) => {
          const file = path.join(app.getPath("userData"), "updater.log");
          try {
            if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.1`);
          } catch {
            // No log yet.
          }
          fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
        },
      },
      // Settings > This app > Beta updates, read at every check.
      () => store.updateChannel(),
    );

    // The Steam Deck layout (src/shared/deck.ts): the hardware, the OS
    // (inside a flatpak the host's os-release is under /run/host), Steam's
    // markers in the environment, a launch flag, and the saved choice.
    const readText = (file: string): string => {
      if (process.platform !== "linux") return "";
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return "";
      }
    };
    const deck = detectDeck({
      env: process.env,
      argv: process.argv,
      dmiVendor: readText("/sys/devices/virtual/dmi/id/board_vendor"),
      dmiProduct: readText("/sys/devices/virtual/dmi/id/product_name"),
      osRelease: readText("/run/host/os-release") || readText("/etc/os-release"),
      choice: store.deckChoice(),
    });
    win = new ShellWindow();
    win.create({ fullscreen: deck.gameMode, maximize: deck.active && deck.device });
    // A logout inside the server's web UI already revoked the session
    // server-side; forget the matching stored token so the server list does
    // not offer a dead one. The local entry keeps its secretCipher, so the
    // next Play signs back in silently, which is the desired local behavior.
    win.onSessionRevoked((origin) => {
      const entry =
        origin === local.origin ? store.get(LOCAL_SERVER_ID) : store.findByOrigin(origin);
      if (entry) store.clearToken(entry.id);
    });
    ipc = registerIpc({ store, window: win, local, tunnel, localAi, updater, deck, relaunch: () => relaunch(), reset });
    // Not before the page listens: an answer sent into a loading window was
    // lost, and the player never saw the popup.
    updater.checkOnStartup(win.whenPageReady());

    // AI cleanup starts immediately. Keep the local server available for
    // sharing cleanup, but attempt its stop by the same total deadline.
    let shutdownPromise: Promise<void> | null = null;
    let quitQueued = false;
    let allowQuit = false;
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cap = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 3000);
        });
        const settle = (operation: () => Promise<unknown>): Promise<void> => {
          try {
            return Promise.resolve(operation()).then(() => undefined, () => undefined);
          } catch {
            return Promise.resolve();
          }
        };
        const share = settle(() => Promise.all([ipc?.shutdownShare(), ipc?.shutdownNative()]).then(() => {}));
        const ai = settle(() => localAi.stop());
        try {
          await Promise.race([share, cap]);
          const localStop = settle(() => local.stop());
          await Promise.race([Promise.all([share, ai, localStop]), cap]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      })();
      return shutdownPromise;
    };
    const requestQuit = (): void => {
      if (quitQueued) return;
      quitQueued = true;
      void shutdown().finally(() => {
        allowQuit = true;
        app.quit();
      });
    };
    app.on("before-quit", (event) => {
      if (allowQuit) return;
      event.preventDefault();
      requestQuit();
    });
    app.on("window-all-closed", requestQuit);

    await win.whenPageReady();
    if (pendingJoin) {
      const link = pendingJoin;
      pendingJoin = null;
      void ipc.handleJoinLink(link);
    }
  });
}

// The name the operating system's keychain knows this app by. safeStorage
// files its key as "<app name> Safe Storage" (the macOS Keychain, the Linux
// secret service), and every saved sign-in, the device world's included, is
// sealed with it. Those keys were made under the package's name,
// open-dungeon-master-client: Electron names an app after package.json's
// productName, and the packaged package.json has none, only "name". So that
// name stays here, set before anything reads it: any other leaves every
// saved sign-in unreadable, as "Open Dungeon Master" did in 0.22.0 (client
// issue 100). What people see (the window, the menus, the installer, the
// Dock) comes from productName, Open Game Master. The one-shot helper that
// opens what 0.22.0 sealed runs under that release's name instead.
if (isUnsealHelper(process.argv)) {
  runUnsealHelper(app, safeStorage, process.argv);
} else {
  app.setName(KEYCHAIN_NAME);
  if (app.requestSingleInstanceLock()) {
    main();
  } else {
    app.quit();
  }
}
