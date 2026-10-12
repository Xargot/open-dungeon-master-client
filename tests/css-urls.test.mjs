import assert from "node:assert/strict";
import test from "node:test";
import { rewriteCssUrls, rootRelativeCssUrls } from "../dist/shared/css-urls.js";

// Client PR #30: a server page's inline background-image names a root-relative
// path (the campaign-setting cover plates), which inside the apps points
// nowhere. The rewrite hands each such path to a resolver and keeps the rest
// of the value as written.
test("root-relative url() values are rewritten, everything else is left alone", () => {
  const value = 'url("/assets/placeholders/world/mill.webp"), linear-gradient(black, transparent), url(/fx/dust.webp), url("https://cdn.example/x.png"), url("//cdn.example/y.png"), url(data:image/gif;base64,AAAA)';
  const resolved = rewriteCssUrls(value, (path) => (path.startsWith("/assets/") ? `game/public${path}` : null));
  assert.equal(
    resolved,
    'url("game/public/assets/placeholders/world/mill.webp"), linear-gradient(black, transparent), url(/fx/dust.webp), url("https://cdn.example/x.png"), url("//cdn.example/y.png"), url(data:image/gif;base64,AAAA)',
  );
  assert.deepEqual(rootRelativeCssUrls(value), ["/assets/placeholders/world/mill.webp", "/fx/dust.webp"]);
});

test("a value with nothing root-relative comes back unchanged", () => {
  const value = "url('https://host.example/a.webp')";
  assert.equal(rewriteCssUrls(value, () => "never"), value);
  assert.deepEqual(rootRelativeCssUrls(value), []);
  assert.deepEqual(rootRelativeCssUrls("none"), []);
});

test("a path named twice is resolved once and replaced everywhere", () => {
  const value = "url(/assets/a.webp), url('/assets/a.webp')";
  let calls = 0;
  const resolved = rewriteCssUrls(value, () => {
    calls += 1;
    return "local/a.webp";
  });
  assert.equal(resolved, 'url("local/a.webp"), url("local/a.webp")');
  assert.deepEqual(rootRelativeCssUrls(value), ["/assets/a.webp"]);
  assert.equal(calls, 2, "the rewrite asks per occurrence; callers that fetch cache by path");
});
