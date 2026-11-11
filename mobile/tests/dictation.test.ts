import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createNativeDictation,
  DICTATION_READY_EVENT,
  installNativeDictation,
  type DictationPlugin,
  type Handle,
} from "../src/dictation-core";

// The phone's speech recognizer as the game's dictation button sees it.

type Listener = (event: Record<string, unknown>) => void;

function fakePlugin(options: { available?: boolean; startFails?: string; text?: string } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const calls: string[] = [];
  const started: Array<{ language?: string }> = [];
  const plugin = {
    async available() {
      return { available: options.available ?? true, onDevice: true };
    },
    async start(asked: { language?: string }) {
      calls.push("start");
      started.push(asked);
      if (options.startFails) {
        throw new Error(options.startFails);
      }
    },
    async stop() {
      calls.push("stop");
      return { text: options.text ?? "  The party reached the abbey.  " };
    },
    async cancel() {
      calls.push("cancel");
    },
    async addListener(event: string, listener: Listener): Promise<Handle> {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return { remove: async () => void set.delete(listener) };
    },
  };
  const emit = (event: string, payload: Record<string, unknown>) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload);
    }
  };
  const live = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  return { plugin: plugin as unknown as DictationPlugin, emit, live, calls, started };
}

test("a take streams level and words, then stop hands back the trimmed text", async () => {
  const fake = fakePlugin();
  const dictation = createNativeDictation(fake.plugin);
  const levels: number[] = [];
  const partials: string[] = [];
  await dictation.start({ onLevel: (level) => levels.push(level), onPartial: (text) => partials.push(text) });
  fake.emit("level", { level: 0.4 });
  fake.emit("partial", { text: "The party" });
  fake.emit("partial", { text: "The party reached" });
  assert.deepEqual(levels, [0.4]);
  assert.deepEqual(partials, ["The party", "The party reached"]);
  assert.equal(await dictation.stop(), "The party reached the abbey.");
  assert.equal(fake.live(), 0, "listeners are released after the take");
  assert.deepEqual(fake.calls, ["start", "stop"]);
});

test("a recognizer that cannot start says why and leaves no listeners", async () => {
  const fake = fakePlugin({ startFails: "The microphone permission was refused." });
  const dictation = createNativeDictation(fake.plugin);
  await assert.rejects(dictation.start({}), /permission was refused/);
  assert.equal(fake.live(), 0);
});

test("a mid-take error reaches the page", async () => {
  const fake = fakePlugin();
  const dictation = createNativeDictation(fake.plugin);
  const errors: string[] = [];
  await dictation.start({ onError: (message) => errors.push(message) });
  fake.emit("error", { message: "The recognizer lost the network." });
  assert.deepEqual(errors, ["The recognizer lost the network."]);
  await dictation.cancel();
  assert.equal(fake.live(), 0);
  assert.deepEqual(fake.calls, ["start", "cancel"]);
});

test("a second take replaces the first take's listeners", async () => {
  const fake = fakePlugin();
  const dictation = createNativeDictation(fake.plugin);
  const first: string[] = [];
  await dictation.start({ onPartial: (text) => first.push(text) });
  await dictation.start({ onPartial: () => {} });
  fake.emit("partial", { text: "only the second hears this" });
  assert.deepEqual(first, []);
  assert.equal(fake.live(), 3);
});

test("the page is offered a recognizer only when the phone has one", async () => {
  const withOne: { odmDictation?: unknown; events: string[]; dispatchEvent(event: Event): boolean } = {
    events: [],
    dispatchEvent(event) {
      this.events.push(event.type);
      return true;
    },
  };
  assert.equal(await installNativeDictation(fakePlugin().plugin, withOne), true);
  assert.equal(typeof (withOne.odmDictation as { start?: unknown })?.start, "function");
  assert.deepEqual(withOne.events, [DICTATION_READY_EVENT]);

  const without: { odmDictation?: unknown; events: string[]; dispatchEvent(event: Event): boolean } = {
    events: [],
    dispatchEvent(event) {
      this.events.push(event.type);
      return true;
    },
  };
  assert.equal(await installNativeDictation(fakePlugin({ available: false }).plugin, without), false);
  assert.equal(without.odmDictation, undefined);
  assert.deepEqual(without.events, []);
});

test("a take is heard in the table's language the page names, and in the phone's own when it names none", async () => {
  const fake = fakePlugin();
  const dictation = createNativeDictation(fake.plugin);
  await dictation.start({}, { language: "it" });
  await dictation.stop();
  // A server built before the language was sent calls start(handlers) alone.
  await dictation.start({});
  await dictation.stop();
  await dictation.start({}, { language: "  " });
  await dictation.stop();
  assert.deepEqual(fake.started, [{ language: "it" }, {}, {}]);
});
