// Steam's binary KeyValues, the format of userdata/<account>/config/
// shortcuts.vdf: a type byte, a NUL-terminated key, the value, and 0x08 to
// close a map. Only the value types Steam writes are known; any other byte
// is refused, so a file this code does not understand is never rewritten.
// Kept free of electron so the tests run it under plain node.

export type VdfNode =
  | { type: "map"; entries: VdfEntry[] }
  | { type: "string"; value: string }
  | { type: "int32"; value: number }
  | { type: "float32"; value: number }
  | { type: "uint64"; value: bigint }
  | { type: "int64"; value: bigint };

export interface VdfEntry {
  key: string;
  node: VdfNode;
}

const MAP = 0x00;
const STRING = 0x01;
const INT32 = 0x02;
const FLOAT32 = 0x03;
const UINT64 = 0x07;
const END = 0x08;
const INT64 = 0x0a;

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  byte(): number {
    if (this.pos >= this.buf.length) throw new Error("The file ends inside a value.");
    return this.buf.readUInt8(this.pos++);
  }

  text(): string {
    const end = this.buf.indexOf(0, this.pos);
    if (end < 0) throw new Error("The file ends inside a name.");
    const value = this.buf.toString("utf8", this.pos, end);
    this.pos = end + 1;
    return value;
  }

  fixed(size: number): Buffer {
    if (this.pos + size > this.buf.length) throw new Error("The file ends inside a number.");
    const slice = this.buf.subarray(this.pos, this.pos + size);
    this.pos += size;
    return slice;
  }

  map(): VdfEntry[] {
    const entries: VdfEntry[] = [];
    for (;;) {
      const type = this.byte();
      if (type === END) return entries;
      const key = this.text();
      entries.push({ key, node: this.value(type) });
    }
  }

  value(type: number): VdfNode {
    switch (type) {
      case MAP:
        return { type: "map", entries: this.map() };
      case STRING:
        return { type: "string", value: this.text() };
      case INT32:
        return { type: "int32", value: this.fixed(4).readInt32LE(0) };
      case FLOAT32:
        return { type: "float32", value: this.fixed(4).readFloatLE(0) };
      case UINT64:
        return { type: "uint64", value: this.fixed(8).readBigUInt64LE(0) };
      case INT64:
        return { type: "int64", value: this.fixed(8).readBigInt64LE(0) };
      default:
        throw new Error(`Unknown value type 0x${type.toString(16)} at byte ${this.pos - 1}.`);
    }
  }
}

// The whole file is one map without a key: its entries, then 0x08. An empty
// file is an empty map (Steam has not written one yet).
export function parseBinaryVdf(buf: Buffer): VdfEntry[] {
  if (buf.length === 0) return [];
  const reader = new Reader(buf);
  const entries = reader.map();
  if (reader.pos !== buf.length) throw new Error("Bytes follow the end of the file's map.");
  return entries;
}

function writeEntries(entries: readonly VdfEntry[], out: Buffer[]): void {
  for (const { key, node } of entries) {
    const name = Buffer.from(`${key}\0`, "utf8");
    switch (node.type) {
      case "map":
        out.push(Buffer.from([MAP]), name);
        writeEntries(node.entries, out);
        out.push(Buffer.from([END]));
        break;
      case "string":
        out.push(Buffer.from([STRING]), name, Buffer.from(`${node.value}\0`, "utf8"));
        break;
      case "int32": {
        const value = Buffer.alloc(4);
        value.writeInt32LE(node.value | 0);
        out.push(Buffer.from([INT32]), name, value);
        break;
      }
      case "float32": {
        const value = Buffer.alloc(4);
        value.writeFloatLE(node.value);
        out.push(Buffer.from([FLOAT32]), name, value);
        break;
      }
      case "uint64": {
        const value = Buffer.alloc(8);
        value.writeBigUInt64LE(node.value);
        out.push(Buffer.from([UINT64]), name, value);
        break;
      }
      case "int64": {
        const value = Buffer.alloc(8);
        value.writeBigInt64LE(node.value);
        out.push(Buffer.from([INT64]), name, value);
        break;
      }
    }
  }
}

export function serializeBinaryVdf(entries: readonly VdfEntry[]): Buffer {
  const out: Buffer[] = [];
  writeEntries(entries, out);
  out.push(Buffer.from([END]));
  return Buffer.concat(out);
}

// Steam reads keys without regard to case ("AppName" and "appname" both
// appear in the wild).
export function findEntry(entries: readonly VdfEntry[], key: string): VdfEntry | undefined {
  const wanted = key.toLowerCase();
  return entries.find((entry) => entry.key.toLowerCase() === wanted);
}

export function stringOf(entries: readonly VdfEntry[], key: string): string {
  const node = findEntry(entries, key)?.node;
  return node?.type === "string" ? node.value : "";
}

export function intOf(entries: readonly VdfEntry[], key: string): number {
  const node = findEntry(entries, key)?.node;
  return node?.type === "int32" ? node.value : 0;
}

// Sets a key in place (keeping its spelling and position) or appends it.
export function setEntry(entries: VdfEntry[], key: string, node: VdfNode): void {
  const found = findEntry(entries, key);
  if (found) found.node = node;
  else entries.push({ key, node });
}
