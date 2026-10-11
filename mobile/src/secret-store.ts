import { Capacitor, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { createSecretStore, type SecretBackend } from "./secret-store-core";

// The native half lives in android/.../SecretStorePlugin.java. Off a phone
// (the browser rig), Capacitor's preferences stand in, under their own
// prefix so nothing reads them as the old plain values.
const OdmSecrets = registerPlugin<SecretBackend>("OdmSecrets");

const browserBackend: SecretBackend = {
  get: ({ key }) => Preferences.get({ key: `odm-secret:${key}` }),
  set: ({ key, value }) => Preferences.set({ key: `odm-secret:${key}`, value }),
  remove: ({ key }) => Preferences.remove({ key: `odm-secret:${key}` }),
};

export const secretStore = createSecretStore(Capacitor.isNativePlatform() ? OdmSecrets : browserBackend);

// The plain preferences, for moving values out of them.
export const plainPreferences: SecretBackend = {
  get: (options) => Preferences.get(options),
  set: (options) => Preferences.set(options),
  remove: (options) => Preferences.remove(options),
};
