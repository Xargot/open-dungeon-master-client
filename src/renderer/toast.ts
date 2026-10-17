// A short notice at the foot of the screen, gone after a few seconds: the
// shell's .shell-toast (home.css), the same one the Android bridge shows its
// download notices in (mobile/src/bridge.ts). A newer notice replaces the
// one on screen.
import { el } from "./dom.js";

const TOAST_MS = 4000;
let toast: HTMLDivElement | null = null;
let timer = 0;

export function showShellToast(text: string): void {
  if (!toast) {
    toast = el("div", "shell-toast");
    toast.setAttribute("role", "status");
  }
  toast.textContent = text;
  if (!toast.isConnected) document.body.append(toast);
  window.clearTimeout(timer);
  timer = window.setTimeout(() => toast?.remove(), TOAST_MS);
}
