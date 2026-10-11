import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { encodeQr, qrSvg } from "../dist/shared/qr.js";

// The server repo carries the qrcode npm package; when the sibling checkout
// is present the encoder is checked against it module for module, with the
// mask forced on both sides so only the encoding itself is under test.
const serverDir = process.env.ODM_SERVER_DIR ?? "/home/lebbi/open-dungeon-master";
const REFERENCE = path.join(serverDir, "node_modules", "qrcode");
const reference = existsSync(path.join(REFERENCE, "package.json"))
  ? createRequire(import.meta.url)(REFERENCE)
  : null;

function referenceModules(text, ecl, mask) {
  const code = reference.create([{ data: text, mode: "byte" }], {
    errorCorrectionLevel: ecl,
    maskPattern: mask,
  });
  const rows = [];
  for (let y = 0; y < code.modules.size; y++) {
    const row = [];
    for (let x = 0; x < code.modules.size; x++) row.push(Boolean(code.modules.get(y, x)));
    rows.push(row);
  }
  return { version: code.version, rows };
}

test("encodeQr picks a version, a mask, and a square of the right size", () => {
  const code = encodeQr("https://play-abcd.opendungeonmaster.com");
  assert.equal(code.size, code.version * 4 + 17);
  assert.ok(code.mask >= 0 && code.mask <= 7);
  assert.equal(code.modules.length, code.size);
  assert.ok(code.modules.every((row) => row.length === code.size));
  // The top-left finder pattern: a dark 7x7 ring around a dark 3x3 core.
  assert.equal(code.modules[0][0], true);
  assert.equal(code.modules[1][1], false);
  assert.equal(code.modules[3][3], true);
  // The dark module beside the bottom-left finder is always set.
  assert.equal(code.modules[code.size - 8][8], true);
});

test("a forced mask is honoured", () => {
  for (let mask = 0; mask < 8; mask++) {
    assert.equal(encodeQr("hello", "M", mask).mask, mask);
  }
});

test("qrSvg draws every dark module and nothing else", () => {
  const code = encodeQr("odm");
  const svg = qrSvg(code, { quiet: 1 });
  const dark = code.modules.flat().filter(Boolean).length;
  assert.equal((svg.match(/h1v1h-1z/g) ?? []).length, dark);
  assert.ok(svg.startsWith("<svg "));
  assert.ok(svg.includes(`viewBox="0 0 ${code.size + 2} ${code.size + 2}"`));
});

test(
  "matches the qrcode package across versions, levels and masks",
  { skip: reference ? false : "sibling server checkout not present" },
  () => {
    const samples = [
      "a",
      "https://play-abcd.opendungeonmaster.com",
      "https://opendungeonmaster.com/j?s=https%3A%2F%2Fplay-wxyz.opendungeonmaster.com&c=ABCD2345",
      "https://quiet-river-of-many-words-flowing-onward.trycloudflare.com/join/ABCD2345",
      "ü".repeat(40),
      "x".repeat(120),
      "y".repeat(230),
      "z".repeat(500),
      "w".repeat(1200),
      "v".repeat(2900),
    ];
    for (const text of samples) {
      for (const ecl of ["L", "M", "Q", "H"]) {
        for (const mask of [0, 3, 7]) {
          let mine;
          try {
            mine = encodeQr(text, ecl, mask);
          } catch {
            // Past version 40 for this level: the reference must agree.
            assert.throws(() => referenceModules(text, ecl, mask), `${text.length} chars at ${ecl}`);
            continue;
          }
          const theirs = referenceModules(text, ecl, mask);
          assert.equal(mine.version, theirs.version, `version for ${text.length} chars at ${ecl}`);
          assert.deepEqual(
            mine.modules,
            theirs.rows,
            `modules for ${text.length} chars at ${ecl}, mask ${mask}`,
          );
        }
      }
    }
  },
);

test(
  "the automatic mask is the one the qrcode package would pick",
  { skip: reference ? false : "sibling server checkout not present" },
  () => {
    for (const text of ["https://play-abcd.opendungeonmaster.com", "x".repeat(300), "ODM"]) {
      const mine = encodeQr(text, "M");
      const theirs = reference.create([{ data: text, mode: "byte" }], { errorCorrectionLevel: "M" });
      assert.equal(mine.mask, theirs.maskPattern, `mask for ${text}`);
    }
  },
);
