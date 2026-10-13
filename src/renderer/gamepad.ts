// Controller navigation for the shell and the game screens it draws: the
// Steam Deck's controls (Steam Input's virtual pad) or any pad the Gamepad
// API reports. The D-pad walks a highlight between controls by where they
// sit on screen, A presses, B backs out, the shoulders talk, and Steam's
// keyboard comes up for text boxes. Nothing here runs until a pad speaks.
import { PadReader, type PadAction, type PadSnapshot } from "../shared/pad-input.js";
import { ownArrowKey, pickFirst, pickNext, type Box, type Direction } from "../shared/spatial-nav.js";

export interface PadHooks {
  // The shell's own way back (app.ts): its layers first, then the world's
  // previous page, then home. layersOnly asks only for the former.
  back(layersOnly: boolean): void;
  menu(): void;
  settings(): void;
  // Steam's keyboard over a text box, or put away (field null).
  keyboard(field: HTMLElement | null): void;
}

// Everything a pad can land on. Roving-focus widgets (Radix menus, tabs)
// park their inactive items at tabindex -1, so the interactive roles are
// taken whatever their tabindex says.
const FOCUSABLE = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "summary",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[tabindex]",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='slider']",
].join(",");
const ROVING = "[role='tab'],[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio'],[role='option']";

// The layer a pad works inside, topmost first: the update popup, the tour,
// an open menu or list, a modal dialog, the drawer, a shell screen over
// the world. Outside them the whole page.
const LAYERS = [
  "body > .update-popup-scrim",
  "body > .tour-card",
  "[role='menu'],[role='listbox']",
  "[aria-modal='true'],[role='alertdialog'],dialog:modal",
  "#app.drawer-open > .drawer",
  "#app > .page > .overlay",
];

// The game's hooks for talking (server: Composer.tsx, PushToTalk.tsx and
// useVoicePrefs.ts PTT_KEY).
const COMPOSER = "[data-tour='composer-input']";
const TALK_BUTTON = "[data-tour='composer-talk']";
const PTT_CODE = "Backquote";

function visible(element: Element): boolean {
  if (element.closest("[inert],[aria-hidden='true']")) return false;
  const box = element.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return false;
  return getComputedStyle(element).visibility !== "hidden";
}

function usable(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") return false;
  if (element.tabIndex < 0 && !element.matches(ROVING)) return false;
  return visible(element);
}

function topLayer(): Element | null {
  for (const selector of LAYERS) {
    const found = [...document.querySelectorAll(selector)].filter(visible);
    const last = found.at(-1);
    if (last) return last;
  }
  return null;
}

function candidates(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll(FOCUSABLE)].filter(usable);
}

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function isTextField(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLTextAreaElement || element.isContentEditable) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image"].includes(element.type);
}

function fire(element: Element, type: string): void {
  element.dispatchEvent(new Event(type, { bubbles: true }));
}

// The scroller under the highlight (or the middle of the screen) that can
// still move along the asked axis; the page itself when none can.
function scrollerFor(from: Element | null, vertical: boolean): Element {
  let node: Element | null = from ?? document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node);
    const overflow = vertical ? style.overflowY : style.overflowX;
    const room = vertical ? node.scrollHeight > node.clientHeight + 1 : node.scrollWidth > node.clientWidth + 1;
    if (room && /(auto|scroll|overlay)/.test(overflow)) return node;
    node = node.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

export function startGamepad(hooks: PadHooks): void {
  const reader = new PadReader();
  const root = document.documentElement;
  let running = false;
  let talkTarget: HTMLElement | null = null;
  let pttDown = false;

  // The highlight shows while the pad is in use and hides at the first
  // touch, mouse move or key press, the way consoles and Steam do it.
  const padActive = (): void => root.classList.add("pad-active");
  const padIdle = (event: Event): void => {
    if (event.isTrusted) root.classList.remove("pad-active");
  };
  window.addEventListener("pointerdown", padIdle, true);
  window.addEventListener("mousemove", (event) => {
    if (Math.abs(event.movementX) + Math.abs(event.movementY) > 2) padIdle(event);
  }, true);
  window.addEventListener("keydown", padIdle, true);

  const scope = (): ParentNode => topLayer() ?? document.body;

  const current = (): HTMLElement | null => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) return null;
    const layer = topLayer();
    if (layer && !layer.contains(active)) return null;
    return usable(active) ? active : null;
  };

  const highlight = (element: HTMLElement): void => {
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  // Nothing highlighted yet: the screen's main door if it has one (the
  // title screen's Enter, a form's primary button), else the first control
  // in reading order.
  const start = (): HTMLElement | null => {
    const within = scope();
    const list = candidates(within);
    const preferred = list.find((element) => element.matches("[autofocus],.tt-enter,.btn.primary"));
    if (preferred) return preferred;
    const index = pickFirst(list.map(boxOf), { width: window.innerWidth, height: window.innerHeight });
    return index >= 0 ? (list[index] ?? null) : null;
  };

  const move = (dir: Direction): void => {
    const from = current();
    if (!from) {
      const first = start();
      if (first) highlight(first);
      return;
    }
    // A list or a slider takes left and right as its own: the next value.
    if ((dir === "left" || dir === "right") && from instanceof HTMLSelectElement && from.options.length) {
      const step = dir === "right" ? 1 : -1;
      from.selectedIndex = (from.selectedIndex + step + from.options.length) % from.options.length;
      fire(from, "input");
      fire(from, "change");
      return;
    }
    if ((dir === "left" || dir === "right") && from instanceof HTMLInputElement && from.type === "range") {
      if (dir === "right") from.stepUp();
      else from.stepDown();
      fire(from, "input");
      fire(from, "change");
      return;
    }
    // A drawn slider (the kit's level controls) and a line between the
    // table's panels step on their arrow keys (ownArrowKey).
    const own = ownArrowKey(from.getAttribute("role"), from.getAttribute("aria-orientation"), dir);
    if (own) {
      from.dispatchEvent(new KeyboardEvent("keydown", { key: own, code: own, bubbles: true, cancelable: true }));
      return;
    }
    const list = candidates(scope()).filter((element) => element !== from);
    const index = pickNext(boxOf(from), list.map(boxOf), dir);
    const next = index >= 0 ? list[index] : undefined;
    if (next) {
      highlight(next);
      return;
    }
    // Nothing further that way on screen: show more of the page instead.
    if (dir === "up" || dir === "down") {
      const scroller = scrollerFor(from, true);
      scroller.scrollBy({ top: (dir === "down" ? 1 : -1) * window.innerHeight * 0.4, behavior: "smooth" });
    }
  };

  const activate = (): void => {
    const target = current();
    if (!target) {
      const first = start();
      if (first) highlight(first);
      return;
    }
    if (isTextField(target)) {
      target.focus();
      hooks.keyboard(target);
      return;
    }
    if (target instanceof HTMLSelectElement && target.options.length) {
      target.selectedIndex = (target.selectedIndex + 1) % target.options.length;
      fire(target, "input");
      fire(target, "change");
      return;
    }
    target.click();
  };

  // B: whatever the page has open hears Escape first (Radix closes its
  // menus and dialogs on it, the shell its overlay, the drawer, the tour).
  // With nothing open, the shell goes back a page.
  const back = (): void => {
    const layer = topLayer();
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    const escape = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
    target.dispatchEvent(escape);
    if (escape.defaultPrevented) return;
    if (!layer) {
      hooks.back(false);
      return;
    }
    // The layer did not close on Escape: the shell closes its own (the
    // update popup has no Escape of its own); a page's dialog stays.
    if (topLayer() === layer) hooks.back(true);
  };

  // X: the table's message box, with the keyboard up.
  const compose = (): void => {
    const box = [...document.querySelectorAll(COMPOSER)].find(usable) ?? (isTextField(current()) ? current() : null);
    if (!box) return;
    highlight(box);
    hooks.keyboard(box);
  };

  // L1: voice chat's push-to-talk key, held for as long as the button is.
  const pushToTalk = (down: boolean): void => {
    if (down === pttDown) return;
    pttDown = down;
    window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code: PTT_CODE, key: "`", bubbles: true }));
  };

  // R1: the composer's hold-to-talk button, pressed and released.
  const talk = (down: boolean): void => {
    if (down) {
      const button = [...document.querySelectorAll(TALK_BUTTON)].find(usable);
      if (!button) return;
      talkTarget = button;
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true }));
      return;
    }
    const button = talkTarget;
    talkTarget = null;
    button?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true }));
  };

  const scroll = (dx: number, dy: number): void => {
    const from = current();
    if (dy) scrollerFor(from, true).scrollBy({ top: dy, behavior: "instant" });
    if (dx) scrollerFor(from, false).scrollBy({ left: dx, behavior: "instant" });
  };

  const perform = (action: PadAction): void => {
    if (action.kind === "hold") {
      if (action.button === "lb") pushToTalk(action.down);
      else talk(action.down);
      return;
    }
    padActive();
    if (action.kind === "move") move(action.dir);
    else if (action.kind === "scroll") scroll(action.dx, action.dy);
    else if (action.button === "a") activate();
    else if (action.button === "b") back();
    else if (action.button === "x") compose();
    else if (action.button === "menu") hooks.menu();
    else if (action.button === "view") hooks.settings();
  };

  const snapshots = (): PadSnapshot[] => {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
    return pads
      .filter((pad): pad is Gamepad => pad !== null && pad.connected)
      .map((pad) => ({ buttons: pad.buttons.map((button) => button.value), axes: [...pad.axes] }));
  };

  const frame = (now: number): void => {
    const pads = snapshots();
    for (const action of reader.read(pads, now)) perform(action);
    if (pads.length === 0) {
      running = false;
      return;
    }
    requestAnimationFrame(frame);
  };

  const run = (): void => {
    if (running) return;
    running = true;
    requestAnimationFrame(frame);
  };
  window.addEventListener("gamepadconnected", run);
  // Losing the window lets go of anything held, so a mic never stays open
  // behind Steam's menu.
  window.addEventListener("blur", () => {
    pushToTalk(false);
    talk(false);
  });
  // A pad that was already awake before this page loaded.
  if (snapshots().length) run();

  // Steam's keyboard for a text box touched on screen (Game Mode has no
  // other keyboard), and put away when typing ends.
  let touchedAt = 0;
  window.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") touchedAt = performance.now();
  }, true);
  document.addEventListener("focusin", (event) => {
    if (isTextField(event.target as Element) && performance.now() - touchedAt < 800) {
      hooks.keyboard(event.target as HTMLElement);
    }
  });
  document.addEventListener("focusout", (event) => {
    if (isTextField(event.target as Element) && !isTextField(event.relatedTarget as Element | null)) {
      hooks.keyboard(null);
    }
  });
}
