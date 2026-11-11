import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdleStopper, shouldStopIdleWorld, type IdleWorldInput } from "../src/world-idle";

// Whether the phone's own world may sleep once the game web view closed.

const IDLE: IdleWorldInput = { shared: false, nativeWorldOpen: false, webViewOpen: false, ownWorldLeft: false };

test("the world sleeps only when nobody could be using it", () => {
  assert.equal(shouldStopIdleWorld(IDLE), true, "a remote host's portal session ended");
  assert.equal(shouldStopIdleWorld({ ...IDLE, shared: true }), false, "guests may be on the tunnel");
  assert.equal(shouldStopIdleWorld({ ...IDLE, nativeWorldOpen: true }), false, "the app's own screens show it");
  assert.equal(shouldStopIdleWorld({ ...IDLE, webViewOpen: true }), false, "a web view came back");
  assert.equal(shouldStopIdleWorld({ ...IDLE, ownWorldLeft: true }), false, "Wi-Fi guests may be on the host's own world");
  assert.equal(
    shouldStopIdleWorld({ shared: true, nativeWorldOpen: true, webViewOpen: true, ownWorldLeft: true }),
    false,
  );
});

function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    fire() {
      for (const [id, entry] of [...pending]) {
        pending.delete(id);
        entry.fn();
      }
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("arm waits out the grace period, looks, and stops an idle world", async () => {
  const timers = fakeTimers();
  let stops = 0;
  let facts: IdleWorldInput = { ...IDLE };
  const stopper = createIdleStopper({
    graceMs: 30_000,
    inspect: async () => facts,
    stop: async () => {
      stops += 1;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  stopper.arm();
  assert.equal([...timers.pending.values()][0]?.ms, 30_000);
  assert.equal(stops, 0, "nothing happens before the grace period");
  timers.fire();
  await settle();
  assert.equal(stops, 1);

  // The facts at the end of the wait decide, not the ones at the close.
  facts = { ...IDLE, nativeWorldOpen: true };
  stopper.arm();
  timers.fire();
  await settle();
  assert.equal(stops, 1);
});

test("cancel and a second arm both discard the pending look", async () => {
  const timers = fakeTimers();
  let stops = 0;
  const stopper = createIdleStopper({
    graceMs: 30_000,
    inspect: () => IDLE,
    stop: async () => {
      stops += 1;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  stopper.arm();
  stopper.cancel();
  assert.equal(timers.pending.size, 0);
  stopper.arm();
  stopper.arm();
  assert.equal(timers.pending.size, 1, "one look at a time");
  timers.fire();
  await settle();
  assert.equal(stops, 1);
  assert.doesNotThrow(() => stopper.cancel());
});

test("a failing look or stop is swallowed", async () => {
  const timers = fakeTimers();
  const stopper = createIdleStopper({
    graceMs: 1,
    inspect: () => {
      throw new Error("no facts");
    },
    stop: async () => undefined,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  stopper.arm();
  assert.doesNotThrow(() => timers.fire());
  await settle();
});

test("an adventure import keeps an idle world up, and the world is looked at again until it ends", async () => {
  const timers = fakeTimers();
  let stops = 0;
  let facts: IdleWorldInput = { ...IDLE, importing: true };
  const stopper = createIdleStopper({ graceMs: 30_000, inspect: () => facts, stop: async () => void (stops += 1), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  assert.equal(shouldStopIdleWorld(facts), false, "an import is running");
  stopper.arm();
  timers.fire();
  await settle();
  assert.equal(stops, 0, "the world stopped mid-import");
  assert.equal(timers.pending.size, 1, "nobody looks again once the import ends");
  facts = { ...IDLE, importing: false };
  timers.fire();
  await settle();
  assert.equal(stops, 1, "the world stayed up after the import ended");
});
