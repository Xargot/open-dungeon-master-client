import assert from "node:assert/strict";
import test from "node:test";
import {
  KEYFRAME_PREFIX,
  flattenPrelude,
  keyframeNames,
  renameAnimations,
  scopeCss,
  scopePrelude,
  shellKeyframeNames,
  splitDeclarations,
  splitRules,
  splitSelectors,
} from "../scripts/scope-css.mjs";

test("splitRules separates statements and braced rules and ignores braces in strings", () => {
  const rules = splitRules(`@layer a,b;.x{color:red}.y{background:url("a{b}c")}@media (min-width:1px){.z{top:0}}`);
  assert.deepEqual(rules, [
    { statement: "@layer a,b;" },
    { prelude: ".x", body: "color:red" },
    { prelude: ".y", body: 'background:url("a{b}c")' },
    { prelude: "@media (min-width:1px)", body: ".z{top:0}" },
  ]);
});

test("splitRules reads an escaped quote in a selector as part of the name, not as a string's start", () => {
  // Tailwind's after:content-[''] (the builder's 44 px tap rings) escapes
  // its quotes; the scoper used to open a string at the first \' and
  // swallow every rule up to the next quote in the sheet, which left the
  // game unstyled in the apps.
  const css = String.raw`.after\:content-\[\'\'\]:after{content:""}.x{color:red}@media (hover:hover){.y{top:0}}`;
  assert.deepEqual(splitRules(css), [
    { prelude: String.raw`.after\:content-\[\'\'\]:after`, body: 'content:""' },
    { prelude: ".x", body: "color:red" },
    { prelude: "@media (hover:hover)", body: ".y{top:0}" },
  ]);
  const out = scopeCss(css, ".game-root", { keyframes: [] });
  assert.equal(out, String.raw`.game-root .after\:content-\[\'\'\]:after{content:""}.game-root .x{color:red}@media (hover:hover){.game-root .y{top:0}}`);
  let depth = 0;
  for (const ch of out) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
  assert.equal(depth, 0);
});

test("splitRules drops the comments between rules, the licence comment Tailwind keeps included", () => {
  const rules = splitRules(`/*! tailwindcss v4 | MIT */\n@layer properties{@supports (x:y){*{--a:0}}}/* note */.x{color:red}/* tail */`);
  assert.deepEqual(rules, [
    { prelude: "@layer properties", body: "@supports (x:y){*{--a:0}}" },
    { prelude: ".x", body: "color:red" },
  ]);
  // A brace inside a comment does not open a block.
  assert.deepEqual(splitRules(`/* { */.y{top:0}`), [{ prelude: ".y", body: "top:0" }]);
  const out = scopeCss(`/*! licence */@layer properties{@supports (x:y){*,:before{--a:0}}}`, ".game-root");
  assert.equal(out, "@layer properties{@supports (x:y){.game-root *,.game-root :before{--a:0}}}");
});

test("splitDeclarations keeps semicolons inside strings and functions", () => {
  const body = `background:url("data:image/svg+xml;charset=utf8,x");animation:a 1s,b 2s;--x:calc(1px;2px)`;
  const parts = splitDeclarations(body);
  assert.deepEqual(parts, [`background:url("data:image/svg+xml;charset=utf8,x")`, "animation:a 1s,b 2s", "--x:calc(1px;2px)"]);
  assert.equal(parts.join(";"), body);
});

test("scopePrelude turns the document selectors into the scope and leaves the rest", () => {
  assert.equal(scopePrelude(":root,:host"), "&,:host");
  assert.equal(scopePrelude("body::before"), "&::before");
  assert.equal(scopePrelude("html"), "&");
  assert.equal(scopePrelude(".body-copy>body"), ".body-copy>&");
  assert.equal(scopePrelude("*,:before,:after,::backdrop"), "*,:before,:after,::backdrop");
  assert.equal(scopePrelude(".tbody,tbody"), ".tbody,tbody");
});

test("scopePrelude keeps the document's theme and effects attributes on <html>", () => {
  // The server writes data-theme and data-effects on <html>, in the apps too.
  assert.equal(scopePrelude('html[data-theme="light"] .plate-row'), 'html[data-theme="light"] & .plate-row');
  assert.equal(scopePrelude('[data-theme="light"] .seg-pill'), 'html[data-theme="light"] & .seg-pill');
  assert.equal(scopePrelude('[data-effects="low"] .ambient-dust::before'), 'html[data-effects="low"] & .ambient-dust::before');
  assert.equal(scopePrelude("html[data-theme=light]"), "html[data-theme=light] &");
  assert.equal(scopePrelude(':root[data-theme="light"]'), 'html[data-theme="light"] &');
  assert.equal(scopePrelude('html[data-theme="light"] body'), 'html[data-theme="light"] &');
  assert.equal(scopePrelude('html[data-theme="light"] body .glass'), 'html[data-theme="light"] & .glass');
  assert.equal(scopePrelude('.a,[data-effects="low"] .b'), '.a,html[data-effects="low"] & .b');
  // An attribute that lives on an ordinary element is left to nest as usual.
  assert.equal(scopePrelude('[data-state="open"] .x'), '[data-state="open"] .x');
});

test("splitSelectors splits on top-level commas only", () => {
  const tailwind = ".w-\\[min\\(960px\\,calc\\(100vw-2rem\\)\\)\\]";
  assert.deepEqual(splitSelectors(`${tailwind},.b`), [tailwind, ".b"]);
  assert.deepEqual(splitSelectors(":is(h1, h2) .x,[data-a=\"1,2\"]"), [":is(h1, h2) .x", "[data-a=\"1,2\"]"]);
  assert.deepEqual(splitSelectors(".a"), [".a"]);
});

test("flattenPrelude keeps a class name with escaped commas whole", () => {
  // The new campaign wizard's dialog sizes itself with such a class; split
  // on every comma, the rule became two broken selectors and was dropped.
  const tailwind = ".w-\\[min\\(960px\\,calc\\(100vw-2rem\\)\\)\\]";
  assert.equal(flattenPrelude(`${tailwind},.b`, ".game-root"), `.game-root ${tailwind},.game-root .b`);
  assert.equal(flattenPrelude(":is(h1, h2) .x", ".game-root"), ".game-root :is(h1, h2) .x");
  assert.equal(scopePrelude(`${tailwind},body`), `${tailwind},&`);
});

test("flattenPrelude leaves the escaped & inside a Tailwind arbitrary variant alone", () => {
  // [&>header]:pr-9 is how a wizard makes room for its close button.
  const variant = String.raw`.\[\&\>header\]\:pr-9>header`;
  assert.equal(flattenPrelude(variant, ".game-root"), `.game-root ${variant}`);
  assert.equal(flattenPrelude(`${variant},:root`, ".game-root"), `.game-root ${variant},.game-root`);
});

test("flattenPrelude writes the scope out: descendant rules, the scope itself, and <html> attributes ahead of it", () => {
  const scope = ".game-root";
  assert.equal(flattenPrelude("h1,p", scope), ".game-root h1,.game-root p");
  assert.equal(flattenPrelude(":root,:host", scope), ".game-root,.game-root :host");
  assert.equal(flattenPrelude("body::before", scope), ".game-root::before");
  assert.equal(flattenPrelude(".body-copy>body", scope), ".body-copy>.game-root");
  assert.equal(flattenPrelude("*,:after", scope), ".game-root *,.game-root :after");
  assert.equal(flattenPrelude('html[data-theme="light"] .plate-row', scope), 'html[data-theme="light"] .game-root .plate-row');
  assert.equal(flattenPrelude("html[data-theme=light]", scope), "html[data-theme=light] .game-root");
  assert.equal(flattenPrelude('[data-effects="low"] .dust::before', scope), 'html[data-effects="low"] .game-root .dust::before');
  assert.equal(flattenPrelude('html[data-theme="light"] body .glass', scope), 'html[data-theme="light"] .game-root .glass');
});

test("renameAnimations touches only the named animations, anywhere in a list", () => {
  const rename = new Map([
    ["spin", "odm-game-spin"],
    ["fade-up", "odm-game-fade-up"],
  ]);
  assert.equal(renameAnimations("spin 1s linear infinite", rename), "odm-game-spin 1s linear infinite");
  assert.equal(renameAnimations("1s linear infinite spin", rename), "1s linear infinite odm-game-spin");
  assert.equal(
    renameAnimations("pop-in var(--dur-quick) var(--ease-spring) backwards, fade-up 1.8s ease-in-out .4s infinite", rename),
    "pop-in var(--dur-quick) var(--ease-spring) backwards, odm-game-fade-up 1.8s ease-in-out .4s infinite",
  );
  // Inside functions nothing moves, and a name that is a function is not a name.
  assert.equal(renameAnimations("var(--spin,spin) calc(var(--n) * -1.7s) steps(1, end) spin(", rename), "var(--spin,spin) calc(var(--n) * -1.7s) steps(1, end) spin(");
  assert.equal(renameAnimations('"spin" spin-fast spinner', rename), '"spin" spin-fast spinner');
  assert.equal(renameAnimations("none!important", rename), "none!important");
});

test("keyframeNames lists a sheet's keyframes, vendor prefixed ones too", () => {
  assert.deepEqual([...keyframeNames("@keyframes a{}@-webkit-keyframes b{to{x:1}}.c{animation:d 1s}")], ["a", "b"]);
});

test("shellKeyframeNames reads the shell's sheets", () => {
  const names = shellKeyframeNames();
  assert.ok(names.has("fade-up"));
  assert.ok(names.has("spin"));
  assert.deepEqual([...shellKeyframeNames("/nonexistent/dir")], []);
});

// Every style rule of the output, at any depth of @-rule wrappers, with the
// wrappers it sits in.
function styleRules(css, wrappers = []) {
  const found = [];
  for (const rule of splitRules(css)) {
    if (rule.statement) continue;
    if (/^@(-webkit-)?keyframes\b/.test(rule.prelude)) continue;
    if (rule.prelude.startsWith("@")) {
      if (/^@(layer|media|supports|container|starting-style)\b/.test(rule.prelude)) found.push(...styleRules(rule.body, [...wrappers, rule.prelude]));
      continue;
    }
    found.push({ ...rule, wrappers });
  }
  return found;
}

const SAMPLE = [
  "@layer theme,base;",
  "@layer theme{:root,:host{--c:red;--animate-spin:spin 1s linear infinite;--animate-wiggle:wiggle 2s}@keyframes spin{to{transform:rotate(1turn)}}}",
  "@layer base{*,:after{margin:0}body{color:var(--c)}h1{font-size:2rem}p{margin:0}}",
  "@media (min-width:640px){.sm\\:flex{display:flex}@supports (display:grid){.grid{display:grid}}}",
  "@layer utilities{@media (hover:hover){.hover\\:x:hover{color:red}}}",
  "@property --tw-x{syntax:'*';inherits:false}",
  'html[data-theme="light"] .plate{color:#000}',
  '[data-effects="low"] .dust::before{animation:none}',
  ".spin{animation:var(--animate-spin)}",
  ".fade{animation:fade-up .3s ease both,wiggle 1s;animation-name:fade-up,wiggle}",
  ".body-copy>body{color:red}",
  "@keyframes fade-up{from{opacity:0}}",
  "@-webkit-keyframes wiggle{to{rotate:1deg}}",
  ".panel{border:1px solid}",
].join("");

test("scopeCss flattens every style rule under the scope, keeps the wrappers, and hoists keyframes", () => {
  const out = scopeCss(SAMPLE, ".game-root", { keyframes: [] });
  assert.equal(
    out,
    [
      "@layer theme,base;",
      "@keyframes spin{to{transform:rotate(1turn)}}",
      "@property --tw-x{syntax:'*';inherits:false}",
      "@keyframes fade-up{from{opacity:0}}",
      "@-webkit-keyframes wiggle{to{rotate:1deg}}",
      "@layer theme{.game-root,.game-root :host{--c:red;--animate-spin:spin 1s linear infinite;--animate-wiggle:wiggle 2s}}",
      "@layer base{.game-root *,.game-root :after{margin:0}.game-root{color:var(--c)}.game-root h1{font-size:2rem}.game-root p{margin:0}}",
      "@media (min-width:640px){.game-root .sm\\:flex{display:flex}@supports (display:grid){.game-root .grid{display:grid}}}",
      "@layer utilities{@media (hover:hover){.game-root .hover\\:x:hover{color:red}}}",
      'html[data-theme="light"] .game-root .plate{color:#000}',
      'html[data-effects="low"] .game-root .dust::before{animation:none}',
      ".game-root .spin{animation:var(--animate-spin)}",
      ".game-root .fade{animation:fade-up .3s ease both,wiggle 1s;animation-name:fade-up,wiggle}",
      ".body-copy>.game-root{color:red}",
      ".game-root .panel{border:1px solid}",
    ].join(""),
  );
});

test("scopeCss leaves no nesting inside a style rule and starts every selector at the scope", () => {
  const out = scopeCss(SAMPLE, ".game-root");
  const rules = styleRules(out);
  assert.ok(rules.length >= 14);
  for (const rule of rules) {
    assert.ok(!rule.body.includes("{"), `nested block in ${rule.prelude}{${rule.body}}`);
    for (const selector of rule.prelude.split(",")) {
      assert.match(selector, /^(html\[data-[^\]]+\] )?(\.game-root|.*[\s>+~]\.game-root)/, selector);
    }
  }
  // Keyframes never end up inside a layer or a media wrapper.
  const top = splitRules(out).filter((rule) => rule.prelude && /^@(-webkit-)?keyframes/.test(rule.prelude));
  assert.equal(top.length, 3);
  assert.ok(!/@(layer|media)[^{]*\{[^}]*@keyframes/.test(out));
});

test("scopeCss renames the keyframes that collide with the shell and every use of them", () => {
  const out = scopeCss(SAMPLE, ".game-root", { keyframes: ["spin", "fade-up", "twinkle"] });
  assert.ok(out.includes(`@keyframes ${KEYFRAME_PREFIX}spin{`));
  assert.ok(out.includes(`@keyframes ${KEYFRAME_PREFIX}fade-up{`));
  // A reserved name the sheet never declares is not invented.
  assert.ok(!out.includes(`${KEYFRAME_PREFIX}twinkle`));
  // A game keyframe of its own keeps its name, so the server's JS still finds it.
  assert.ok(out.includes("@-webkit-keyframes wiggle{"));
  assert.ok(out.includes(`--animate-spin:${KEYFRAME_PREFIX}spin 1s linear infinite;--animate-wiggle:wiggle 2s`));
  assert.ok(out.includes(`.game-root .fade{animation:${KEYFRAME_PREFIX}fade-up .3s ease both,wiggle 1s;animation-name:${KEYFRAME_PREFIX}fade-up,wiggle}`));
  assert.ok(!out.includes("--animate-spin:spin") && !out.includes("@keyframes spin{"), "an unprefixed spin survived");
  // Keyframes are not wrapped in a layer.
  assert.ok(out.startsWith(`@layer theme,base;@keyframes ${KEYFRAME_PREFIX}spin{`));
});

test("scopeCss with keyframes: 'all' prefixes every name in the sheet", () => {
  const out = scopeCss(SAMPLE, ".game-root", { keyframes: "all" });
  assert.ok(out.includes(`@-webkit-keyframes ${KEYFRAME_PREFIX}wiggle{`));
  assert.ok(out.includes(`--animate-wiggle:${KEYFRAME_PREFIX}wiggle 2s`));
  assert.ok(out.includes(`animation-name:${KEYFRAME_PREFIX}fade-up,${KEYFRAME_PREFIX}wiggle}`));
});

test("scopeCss defaults to the shell's keyframe names", () => {
  const out = scopeCss(SAMPLE, ".game-root");
  assert.ok(out.includes(`@keyframes ${KEYFRAME_PREFIX}fade-up{`));
  assert.ok(out.includes(`@keyframes ${KEYFRAME_PREFIX}spin{`));
  assert.ok(out.includes("@-webkit-keyframes wiggle{"));
});
