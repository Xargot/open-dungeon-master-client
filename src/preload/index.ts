import { contextBridge, ipcRenderer } from "electron";
import type { AiSetup, OdmBridge, ShellEvent } from "../shared/types";

// The whole bridge is invoke-shaped: the renderer can ask, never reach into
// Node. This preload only ever loads for the shell's own UI, not for
// connected servers' pages, which run in separate partitions with no bridge.

const bridge: OdmBridge = {
  platform: "desktop",
  // A desktop has no motor; the screens ask and nothing happens.
  haptic: () => {},
  setTheme: (mode: "dark" | "light") => ipcRenderer.invoke("theme:set", mode),
  openTableScreen: (hostId: string, campaignId: string) => ipcRenderer.invoke("table:open", hostId, campaignId),
  listServers: () => ipcRenderer.invoke("servers:list"),
  probeServer: (origin: string) => ipcRenderer.invoke("servers:probe", origin),
  login: (input) => ipcRenderer.invoke("servers:login", input),
  register: (input) => ipcRenderer.invoke("servers:register", input),
  discordLogin: (input) => ipcRenderer.invoke("servers:discord-login", input),
  connect: (serverId: string, joinCode?: string, path?: string) =>
    ipcRenderer.invoke("servers:connect", serverId, joinCode, path),
  removeServer: (serverId: string) => ipcRenderer.invoke("servers:remove", serverId),
  deleteAccount: (input) => ipcRenderer.invoke("servers:delete-account", input),
  homeFeed: () => ipcRenderer.invoke("home:feed"),
  homeFeedCached: () => ipcRenderer.invoke("home:feed-cached"),
  openInviteLink: (raw: string) => ipcRenderer.invoke("servers:open-invite", raw),
  coverImage: (hostId: string, url: string) => ipcRenderer.invoke("home:cover", hostId, url),
  hostSession: (hostId: string) => ipcRenderer.invoke("host:session", hostId),
  gameMounted: (hostId: string) => ipcRenderer.send("game:mounted", hostId),
  openDocument: (path: string) => ipcRenderer.invoke("doc:open", path),
  credentialStorage: () => ipcRenderer.invoke("prefs:credentials"),
  setKeepSignIns: (keep: boolean) => ipcRenderer.invoke("prefs:set-keep-sign-ins", keep),
  portalMode: () => ipcRenderer.invoke("prefs:portal"),
  setPortalMode: (on: boolean) => ipcRenderer.invoke("prefs:set-portal", on),
  storyMemory: () => ipcRenderer.invoke("prefs:story-memory"),
  setStoryMemory: (choice) => ipcRenderer.invoke("prefs:set-story-memory", choice),
  applyStoryMemory: () => ipcRenderer.invoke("prefs:apply-story-memory"),
  localStart: () => ipcRenderer.invoke("local:start"),
  localCreateAccount: (input) => ipcRenderer.invoke("local:create-account", input),
  localLogin: (input) => ipcRenderer.invoke("local:login", input),
  localConfigureAi: (setup: AiSetup) => ipcRenderer.invoke("local:configure-ai", setup),
  localAiSaved: () => ipcRenderer.invoke("local:ai-saved"),
  localHarnessStatus: (refresh?: boolean) => ipcRenderer.invoke("local:harness-status", Boolean(refresh)),
  localPlay: (joinCode?: string, path?: string) =>
    ipcRenderer.invoke("local:play", joinCode, path),
  shareStart: () => ipcRenderer.invoke("share:start"),
  shareStop: () => ipcRenderer.invoke("share:stop"),
  lanStart: () => ipcRenderer.invoke("share:lan-start"),
  lanStop: () => ipcRenderer.invoke("share:lan-stop"),
  localAiScan: () => ipcRenderer.invoke("local-ai:scan"),
  localAiInstall: (tierId: string) => ipcRenderer.invoke("local-ai:install", tierId),
  localAiInstallComfy: () => ipcRenderer.invoke("local-ai:install-comfy"),
  localAiUninstall: (component: "text" | "images") =>
    ipcRenderer.invoke("local-ai:uninstall", component),
  localAiStatus: () => ipcRenderer.invoke("local-ai:status"),
  localSpeechStatus: () => ipcRenderer.invoke("local:speech-status"),
  localSpeechInstall: () => ipcRenderer.invoke("local:speech-install"),
  localExportWorld: () => ipcRenderer.invoke("local:export-world"),
  localImportPick: () => ipcRenderer.invoke("local:import-pick"),
  localImportCommit: () => ipcRenderer.invoke("local:import-commit"),
  localImportCancel: () => ipcRenderer.invoke("local:import-cancel"),
  appInfo: () => ipcRenderer.invoke("app:info"),
  setDeckChoice: (choice) => ipcRenderer.invoke("deck:set-choice", choice),
  steamKeyboard: (open, field, multiline) => ipcRenderer.invoke("deck:keyboard", open, field, multiline),
  updateCheck: () => ipcRenderer.invoke("update:check"),
  updateInstall: () => ipcRenderer.invoke("update:install"),
  localVerify: () => ipcRenderer.invoke("local:verify"),
  localRepair: () => ipcRenderer.invoke("local:repair"),
  clearCaches: () => ipcRenderer.invoke("caches:clear"),
  diagnosticSummary: () => ipcRenderer.invoke("diag:summary"),
  showLogs: () => ipcRenderer.invoke("diag:show-logs"),
  resetApp: (phrase: string) => ipcRenderer.invoke("app:reset", phrase),
  onEvent: (listener) => {
    ipcRenderer.on("odm:event", (_event, payload: ShellEvent) => listener(payload));
  },
};

contextBridge.exposeInMainWorld("odm", bridge);
