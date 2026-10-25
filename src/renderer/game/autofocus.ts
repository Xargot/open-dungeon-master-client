// autoFocus as the server's pages mean it. React focuses an element rendered
// with autoFocus when it mounts; Preact only writes the autofocus attribute,
// which a browser honours once per page load, so every form those pages open
// with autoFocus (a new timeline event, a map's name, a calendar...) opened
// here with nothing focused, and a keyboard user typed into the page.
//
// The hook wraps the element's ref: the first time an element that carries
// autoFocus reaches the page, it takes focus, once, as it does on the site.
import { options, type VNode } from "preact";

const focused = new WeakSet<Element>();

type RefLike = ((value: Element | null) => void) | { current: Element | null } | null | undefined;

function setRef(ref: RefLike, value: Element | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

function focusOnce(element: Element | null) {
  if (!(element instanceof HTMLElement) || focused.has(element)) return;
  focused.add(element);
  // After the commit, as React does, once the element is in the page.
  queueMicrotask(() => {
    if (element.isConnected) element.focus();
    else requestAnimationFrame(() => element.isConnected && element.focus());
  });
}

let installed = false;

export function installAutoFocus() {
  if (installed) return;
  installed = true;
  const previous = options.vnode;
  options.vnode = (vnode: VNode) => {
    const props = vnode.props as { autoFocus?: unknown; autofocus?: unknown } | null;
    if (typeof vnode.type === "string" && props && (props.autoFocus || props.autofocus)) {
      const own = vnode.ref as RefLike;
      vnode.ref = (element: Element | null) => {
        focusOnce(element);
        setRef(own, element);
      };
    }
    previous?.(vnode);
  };
}
