// A server-sent events parser over raw text chunks, for the shell's own
// screens: the browser's EventSource cannot send an Authorization header,
// so the campaign stream is read through fetch and fed here. Follows the
// WHATWG event stream format: lines split on LF (CRLF and CR tolerated),
// "field: value" per line, a blank line dispatches, ":" lines are
// comments (the server's heartbeat), and "id" updates the last event id
// the client sends back on reconnect. Pure, so tests can feed it chunks.

export interface SseEvent {
  event: string;
  data: string;
  // The last id seen so far, "" until the stream sends one.
  id: string;
}

export interface SseParser {
  // Feeds one chunk of decoded text; may dispatch any number of events.
  feed(chunk: string): void;
  // The last event id seen, for the Last-Event-ID header on reconnect.
  lastEventId(): string;
}

// The headers a stream reconnect carries: the last id seen, so a host
// replays what it published while the app was backgrounded or offline
// (docs/vtt-parity-implementation-plan.md 18.3). The first connect carries
// none and takes the host's snapshot.
export function streamRequestHeaders(lastId: string): Record<string, string> {
  return { accept: "text/event-stream", ...(lastId ? { "last-event-id": lastId } : {}) };
}

// The most one event (or one unfinished line) may hold. A long-lived stream
// is legitimately unbounded in total, but no single event the server sends
// comes near this; a host that streams a line without end is cut off here
// instead of growing the buffer until the app runs out of memory.
export const SSE_MAX_EVENT_CHARS = 8 * 1024 * 1024;

export class SseOverflowError extends Error {
  constructor() {
    super("An event on the stream was larger than this app accepts.");
  }
}

export function createSseParser(
  onEvent: (event: SseEvent) => void,
  maxEventChars: number = SSE_MAX_EVENT_CHARS,
): SseParser {
  let buffer = "";
  let dataChars = 0;
  let lastId = "";
  let eventName = "";
  let dataLines: string[] = [];
  let sawData = false;

  const dispatch = (): void => {
    if (sawData) {
      onEvent({ event: eventName || "message", data: dataLines.join("\n"), id: lastId });
    }
    eventName = "";
    dataLines = [];
    dataChars = 0;
    sawData = false;
  };

  const line = (text: string): void => {
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        eventName = value;
        break;
      case "data":
        dataChars += value.length + 1;
        if (dataChars > maxEventChars) throw new SseOverflowError();
        dataLines.push(value);
        sawData = true;
        break;
      case "id":
        // A NUL in an id is ignored per spec; nothing here sends one.
        if (!value.includes("\0")) lastId = value;
        break;
      default:
        // "retry" and unknown fields: nothing to do for this reader.
        break;
    }
  };

  return {
    feed(chunk) {
      buffer += chunk;
      let start = 0;
      for (;;) {
        const lf = buffer.indexOf("\n", start);
        const cr = buffer.indexOf("\r", start);
        let end: number;
        let skip: number;
        if (lf < 0 && cr < 0) break;
        if (cr >= 0 && (lf < 0 || cr < lf)) {
          end = cr;
          skip = buffer[cr + 1] === "\n" ? 2 : 1;
          // A lone CR at the very end of the buffer might be half a CRLF.
          if (skip === 1 && cr === buffer.length - 1) break;
        } else {
          end = lf;
          skip = 1;
        }
        line(buffer.slice(start, end));
        start = end + skip;
      }
      buffer = buffer.slice(start);
      if (buffer.length > maxEventChars) throw new SseOverflowError();
    },
    lastEventId: () => lastId,
  };
}
