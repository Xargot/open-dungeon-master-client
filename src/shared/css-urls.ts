// Root-relative addresses inside a CSS value ("url(/assets/x.webp)"), the way
// a server page writes a cover plate or a tile swatch into an inline
// background-image. Inside the apps such a path points nowhere (Electron's
// file:// disk root, the Capacitor page's own origin), so each is handed to a
// resolver, which answers the address to use or null to leave it alone.
// Pure, so tests can feed values without a DOM.

const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;

export function isRootRelativePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

// Every root-relative path the value names, in order, each once.
export function rootRelativeCssUrls(value: string): string[] {
  const paths: string[] = [];
  for (const match of value.matchAll(CSS_URL)) {
    const target = match[2] ?? "";
    if (isRootRelativePath(target) && !paths.includes(target)) paths.push(target);
  }
  return paths;
}

// The value with each root-relative path the resolver answers replaced; a
// path it answers null for stays as written.
export function rewriteCssUrls(value: string, resolve: (path: string) => string | null): string {
  return value.replace(CSS_URL, (whole, _quote: string, target: string) => {
    if (!isRootRelativePath(target)) return whole;
    const resolved = resolve(target);
    return resolved ? `url("${resolved}")` : whole;
  });
}
