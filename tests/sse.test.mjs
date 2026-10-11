import assert from "node:assert/strict";
import test from "node:test";
import { SseOverflowError, createSseParser, streamRequestHeaders } from "../dist/shared/sse.js";

function collect() {
  const events = [];
  const parser = createSseParser((event) => events.push(event));
  return { events, parser };
}

test("parses events the server's stream shape sends, ids included", () => {
  const { events, parser } = collect();
  parser.feed("id: 1\nevent: campaign_updated\ndata: {\"title\":\"x\"}\n\n");
  parser.feed("event: presence\ndata: {\"online\":[]}\n\n");
  assert.deepEqual(events, [
    { event: "campaign_updated", data: '{"title":"x"}', id: "1" },
    { event: "presence", data: '{"online":[]}', id: "1" },
  ]);
  assert.equal(parser.lastEventId(), "1");
});

test("chunks may split anywhere, even mid-line", () => {
  const { events, parser } = collect();
  const whole = "id: 7\nevent: roll_result\ndata: {\"a\":1}\n\n";
  for (const char of whole) parser.feed(char);
  assert.deepEqual(events, [{ event: "roll_result", data: '{"a":1}', id: "7" }]);
});

test("heartbeat comments dispatch nothing and multi-line data joins with newlines", () => {
  const { events, parser } = collect();
  parser.feed(": ping\n\n");
  parser.feed("data: one\ndata: two\n\n");
  assert.deepEqual(events, [{ event: "message", data: "one\ntwo", id: "" }]);
});

test("CRLF and CR line endings are accepted", () => {
  const { events, parser } = collect();
  parser.feed("event: a\r\ndata: 1\r\n\r\n");
  // A trailing lone CR is held back in case an LF follows; the next break
  // (here CRLF) releases the blank line that dispatches.
  parser.feed("event: b\rdata: 2\r\r\n");
  assert.deepEqual(
    events.map((event) => [event.event, event.data]),
    [
      ["a", "1"],
      ["b", "2"],
    ],
  );
});

test("a data line with no space after the colon keeps its value, an empty id is kept", () => {
  const { events, parser } = collect();
  parser.feed("id:\ndata:x\n\n");
  assert.deepEqual(events, [{ event: "message", data: "x", id: "" }]);
});

// docs/vtt-parity-implementation-plan.md 18.3: after a drop, the reconnect
// asks the host to replay from the last id it delivered, so a persisted
// event published while the app was backgrounded still arrives.
test("a reconnect carries the last event id and the first connect carries none", () => {
  assert.deepEqual(streamRequestHeaders(""), { accept: "text/event-stream" });
  const { events, parser } = collect();
  parser.feed("id: 41\nevent: scene_state\ndata: {}\n\n");
  const lastId = events.at(-1)?.id ?? "";
  assert.equal(lastId, "41");
  assert.deepEqual(streamRequestHeaders(lastId), { accept: "text/event-stream", "last-event-id": "41" });
});

// Audit C2: a long-lived stream is unbounded in total, but no one event or
// unfinished line may grow without end.
test("a line or an event past the ceiling is refused; ordinary traffic is not", () => {
  const events = [];
  const parser = createSseParser((event) => events.push(event), 64);
  parser.feed(`data: ${"x".repeat(40)}\n\n`);
  assert.equal(events.length, 1);
  assert.throws(() => parser.feed("data: " + "y".repeat(100)), SseOverflowError);
  const lines = createSseParser(() => undefined, 64);
  assert.throws(() => {
    for (let index = 0; index < 4; index += 1) lines.feed(`data: ${"z".repeat(20)}\n`);
  }, SseOverflowError);
  // Many small events through one parser never trip it.
  const steady = createSseParser(() => undefined, 64);
  for (let index = 0; index < 1000; index += 1) steady.feed(`event: ping\ndata: {}\n\n`);
});
