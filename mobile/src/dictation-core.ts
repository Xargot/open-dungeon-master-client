// The phone's own speech recognizer, offered to the game's screens as
// window.odmDictation (the contract lives in the server's
// src/lib/native-dictation.ts). The dictation button uses it only when the
// server the player is on has no speech-to-text of its own, which is the
// case for the world this phone hosts, so a DM can speak a summary there.
//
// Kept free of Capacitor so the tests can drive it with a fake plugin;
// dictation.ts wires the real one (android/.../DictationPlugin.java).

export interface Handle {
  remove(): Promise<void>;
}

// What a take is told: the table's language as a BCP 47 tag ("it"), when the
// page is a campaign's. Unsaid, the phone hears its own language.
export interface DictationOptions {
  language?: string;
}

export interface DictationPlugin {
  available(): Promise<{ available: boolean; onDevice: boolean }>;
  start(options: DictationOptions): Promise<void>;
  stop(): Promise<{ text: string }>;
  cancel(): Promise<void>;
  addListener(event: "level", listener: (event: { level: number }) => void): Promise<Handle>;
  addListener(event: "partial", listener: (event: { text: string }) => void): Promise<Handle>;
  addListener(event: "error", listener: (event: { message: string }) => void): Promise<Handle>;
}

// The shape window.odmDictation takes, repeated here so the shell does not
// import server code.
export interface NativeDictation {
  start(
    handlers: {
      onLevel?: (level: number) => void;
      onPartial?: (text: string) => void;
      onError?: (message: string) => void;
    },
    options?: DictationOptions,
  ): Promise<void>;
  stop(): Promise<string>;
  cancel(): Promise<void>;
}

// The page listens for this to notice a recognizer that arrived after it
// drew (NATIVE_DICTATION_EVENT in the server).
export const DICTATION_READY_EVENT = "odm-dictation";

function reason(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message: unknown }).message ?? "");
    if (message) {
      return message;
    }
  }
  return fallback;
}

export function createNativeDictation(plugin: DictationPlugin): NativeDictation {
  let handles: Handle[] = [];
  // One take at a time: listeners belong to the take that added them.
  const release = async () => {
    const current = handles;
    handles = [];
    await Promise.all(current.map((handle) => handle.remove().catch(() => {})));
  };
  return {
    // A server built before the language was sent passes no options: the
    // phone hears its own language, as it always did.
    async start(handlers, options) {
      await release();
      handles = await Promise.all([
        plugin.addListener("level", (event) => handlers.onLevel?.(Number(event.level) || 0)),
        plugin.addListener("partial", (event) => handlers.onPartial?.(String(event.text ?? ""))),
        plugin.addListener("error", (event) => handlers.onError?.(String(event.message ?? ""))),
      ]);
      const language = typeof options?.language === "string" ? options.language.trim() : "";
      try {
        await plugin.start(language ? { language } : {});
      } catch (error) {
        await release();
        throw new Error(reason(error, "This phone's speech recognizer could not start."));
      }
    },
    async stop() {
      try {
        const { text } = await plugin.stop();
        return String(text ?? "").trim();
      } catch (error) {
        throw new Error(reason(error, "This phone's speech recognizer stopped."));
      } finally {
        await release();
      }
    },
    async cancel() {
      try {
        await plugin.cancel();
      } finally {
        await release();
      }
    },
  };
}

// Offers the recognizer to the page only when the phone has one: an app
// that showed a mic and then failed on every press would be worse than no
// mic. Resolves true once installed.
export async function installNativeDictation(
  plugin: DictationPlugin,
  target: { odmDictation?: NativeDictation; dispatchEvent(event: Event): boolean },
): Promise<boolean> {
  const answer = await plugin.available().catch(() => ({ available: false, onDevice: false }));
  if (!answer.available) {
    return false;
  }
  target.odmDictation = createNativeDictation(plugin);
  target.dispatchEvent(new Event(DICTATION_READY_EVENT));
  return true;
}
