// Confines a whole stylesheet to one element's subtree, for the game
// screens' Tailwind build: the sheet is loaded into the shell's page,
// whose own screens must keep their look. Every style rule becomes a
// descendant rule of the scope selector, the document-level selectors
// (:root, html, body) become the scope element itself, and the rules that
// cannot live under a selector (@keyframes, @property, @font-face,
// @import, @charset, layer statements) stay at the top level.
//
// The output is flat: `.game-root .x{}`, never `.game-root{.x{}}`. Nested
// rules that start with a type selector (`h1{`) need Chrome 120, and an
// Android WebView older than that dropped the whole nested block, which
// left the game unstyled. A flat descendant selector has the same
// specificity the nested form had (`.game-root{.x{}}` is `:is(.game-root)
// .x`), so nothing else changes. @media, @supports, @container, @layer and
// @starting-style stay as wrappers around the flattened rules inside them.
//
// Keyframes: the sheet's @keyframes are hoisted to the top level with the
// shell's own sheets ahead of them in the document, so a game keyframe
// with the same name as a shell one wins document-wide. Names that
// collide with the shell's are renamed with KEYFRAME_PREFIX and every
// animation, animation-name and --animate-* value in the sheet follows.
// Only the colliding names move: the server's components refer to some
// names from JS (animationend checks, inline animation strings), and those
// must keep working inside the apps.
//
// Pure text work on the minified output, no CSS parser.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOP_LEVEL =
  /^@(keyframes|-webkit-keyframes|property|font-face|import|charset|page|counter-style|font-feature-values|font-palette-values|view-transition|position-try)\b/;
const KEYFRAMES = /^@(-webkit-)?keyframes\s+([^\s{]+)(\s*)$/;
const ANIMATED = /^(\s*)(animation|animation-name|--animate-[\w-]*)(\s*:)([\s\S]*)$/;

export const KEYFRAME_PREFIX = "odm-game-";

// Splits a block body into its top-level rules: {prelude, body} for a
// braced rule, {statement} for a semicolon-terminated one. Braces inside
// strings and url() are skipped. Comments between rules (the minifier
// keeps "/*!" licence comments) are dropped from the preludes.
export function splitRules(css) {
  const rules = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    while (i < n && /\s/.test(css[i])) i++;
    if (i >= n) break;
    const start = i;
    let depth = 0;
    let quote = "";
    let preludeEnd = -1;
    for (; i < n; i++) {
      const ch = css[i];
      // A backslash escapes the next character inside a string and outside
      // one alike: Tailwind writes a class like after:content-[''] as
      // `.after\:content-\[\'\'\]`, and reading its \' as the start of
      // a string swallowed every rule up to the next quote in the sheet.
      if (ch === "\\") {
        i++;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "/" && css[i + 1] === "*") {
        const end = css.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 1;
        continue;
      }
      if (ch === "{") {
        if (depth === 0) preludeEnd = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      } else if (ch === ";" && depth === 0) {
        i++;
        break;
      }
    }
    const uncomment = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (preludeEnd < 0) {
      const statement = uncomment(css.slice(start, i));
      if (statement) rules.push({ statement });
    } else {
      const prelude = uncomment(css.slice(start, preludeEnd));
      const body = css.slice(preludeEnd + 1, i - 1);
      rules.push({ prelude, body });
    }
  }
  return rules;
}

// Splits a declaration block on the semicolons outside quotes and
// parentheses. The pieces join back with ";" to the original text.
export function splitDeclarations(body) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

// :root, html and body point at the scope element ("&"); everything else
// nests beneath it. Written for minified preludes (no comments).
// Attributes the server writes on <html> and its stylesheet keys on: the day
// theme and the low effects setting. They stay on <html> in the apps too, so a
// selector that reads them has to keep looking there. Rewriting
// `html[data-theme="light"] .x` to `&[data-theme="light"] .x` asked the game
// root for an attribute it never carries, and a bare `[data-effects="low"] .x`
// nested under the root asked a descendant for it: between them the whole day
// theme and every low effects rule were dead inside the apps.
const DOCUMENT_ATTRIBUTE = /^(?:html|:root)?((?:\[data-(?:theme|effects)[^\]]*\])+)(?=$|[\s>+~:.#[])/;

function scopeSelector(part) {
  let selector = part.trim();
  const documentLevel = DOCUMENT_ATTRIBUTE.exec(selector);
  if (documentLevel) {
    // "html[data-theme=light] .x" and "[data-theme=light] .x" both become
    // "html[data-theme=light] & .x": the attribute on <html>, the rest
    // inside the scope. Alone, the rule lands on the scope element itself.
    const rest = selector.slice(documentLevel[0].length).trim();
    const inner = rest.replace(/(^|[\s>+~])(html|body)(?=$|[\s>+~:.#[])/g, "$1&").replace(/:root\b/g, "&");
    // "html[...] body .x": the body already IS the scope element.
    if (inner.startsWith("&")) return `html${documentLevel[1]} ${inner}`;
    return `html${documentLevel[1]} &${inner ? ` ${inner}` : ""}`;
  }
  selector = selector.replace(/:root\b/g, "&");
  selector = selector.replace(/(^|[\s>+~])(html|body)(?=$|[\s>+~:.#[])/g, "$1&");
  return selector;
}

// Splits a selector list on its top-level commas only. Tailwind class names
// carry escaped commas (`.w-\[min\(960px\,calc\(100vw-2rem\)\)\]`), and
// :is()/:where() lists and attribute values hold plain ones; none of those
// separate selectors.
export function splitSelectors(prelude) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(prelude.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(prelude.slice(start));
  return parts;
}

// The nesting form: "&" stands for the scope element.
export function scopePrelude(prelude) {
  return splitSelectors(prelude).map(scopeSelector).join(",");
}

// The flat form: "&" is written out as the scope selector, and a selector
// without one becomes a descendant of it, exactly what nesting would have
// made of it. Only a bare "&" is the nesting token: Tailwind's arbitrary
// variants put an escaped one inside a class name (`.\[\&\>header\]\:pr-9`),
// and writing the scope into that renamed the class, so no element matched.
const NESTING = /(?<!\\)&/g;

export function flattenPrelude(prelude, scope) {
  return splitSelectors(prelude)
    .map((part) => {
      const selector = scopeSelector(part);
      return selector.search(NESTING) >= 0 ? selector.replace(NESTING, scope) : `${scope} ${selector}`;
    })
    .join(",");
}

// Every keyframe name declared in a sheet.
export function keyframeNames(css) {
  const names = new Set();
  for (const match of css.matchAll(/@(?:-webkit-)?keyframes\s+([^\s{]+)/g)) names.add(match[1]);
  return names;
}

// Renames the animation names in one property value: each identifier
// outside parentheses and quotes that is in the map. Times, easings and
// keywords never are; calc(), var() and steps() are skipped whole.
export function renameAnimations(value, rename) {
  let out = "";
  let depth = 0;
  let quote = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      out += ch;
      if (ch === "\\") out += value[++i] ?? "";
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /[a-zA-Z_-]/.test(ch) && !/[\w-]/.test(value[i - 1] ?? " ")) {
      const match = /^-?[a-zA-Z_][\w-]*/.exec(value.slice(i));
      if (match) {
        const word = match[0];
        const next = value[i + word.length];
        out += next !== "(" && rename.has(word) ? rename.get(word) : word;
        i += word.length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function renameInBody(body, rename) {
  if (rename.size === 0) return body;
  return splitDeclarations(body)
    .map((declaration) => {
      const match = ANIMATED.exec(declaration);
      if (!match) return declaration;
      return `${match[1]}${match[2]}${match[3]}${renameAnimations(match[4], rename)}`;
    })
    .join(";");
}

function walk(rules, top, out, scope, rename) {
  for (const rule of rules) {
    if (rule.statement) {
      // "@layer a, b;" and @import live at the top level.
      top.push(rule.statement);
      continue;
    }
    const keyframes = KEYFRAMES.exec(rule.prelude);
    if (keyframes) {
      const name = rename.get(keyframes[2]) ?? keyframes[2];
      top.push(`@${keyframes[1] ?? ""}keyframes ${name}{${rule.body}}`);
      continue;
    }
    if (TOP_LEVEL.test(rule.prelude)) {
      top.push(`${rule.prelude}{${rule.body}}`);
      continue;
    }
    if (rule.prelude.startsWith("@")) {
      // @layer, @media, @supports, @container, @starting-style: a wrapper
      // around the flattened rules inside it.
      const inner = [];
      walk(splitRules(rule.body), top, inner, scope, rename);
      if (inner.length) out.push(`${rule.prelude}{${inner.join("")}}`);
      continue;
    }
    out.push(`${flattenPrelude(rule.prelude, scope)}{${renameInBody(rule.body, rename)}}`);
  }
}

// The shell's own keyframe names: the ones a same-named game keyframe
// would override.
export function shellKeyframeNames(dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer")) {
  const names = new Set();
  if (!fs.existsSync(dir)) return names;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".css")) continue;
    for (const name of keyframeNames(fs.readFileSync(path.join(dir, file), "utf8"))) names.add(name);
  }
  return names;
}

// options.keyframes: the names to move aside, "all" for every one in the
// sheet, or an iterable of reserved names (the shell's by default).
export function scopeCss(css, scope, options = {}) {
  const declared = keyframeNames(css);
  const reserved = options.keyframes === "all" ? declared : new Set(options.keyframes ?? shellKeyframeNames());
  const rename = new Map();
  for (const name of declared) if (reserved.has(name)) rename.set(name, `${KEYFRAME_PREFIX}${name}`);
  const top = [];
  const flat = [];
  walk(splitRules(css), top, flat, scope, rename);
  return `${top.join("")}${flat.join("")}`;
}
