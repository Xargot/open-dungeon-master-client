// The Fast processing choice on Story AI's forms (server issue 255): the
// provider's paid Fast tier, offered only while a chosen model has one, with
// its price said before it is turned on. Hidden, it reads as off, so a model
// without the tier is never saved as Fast; the device's server checks again
// before every call (its src/lib/speed-tier.ts).
import { el } from "./dom.js";
import { FAST_COST_NOTE } from "../shared/ai-setup.js";

export function speedChoice(initial: boolean): {
  row: HTMLElement;
  fast: () => boolean;
  offer: (eligible: boolean) => void;
} {
  let on = initial;
  let eligible = false;
  const row = el("div", "settings-row speed-choice");
  row.style.display = "none";
  const name = el("span", "grow settings-label", "Fast processing (premium price)");
  // The switch in the dress of the settings screen's (settings.ts): it flips
  // where it stands, so the knob slides across.
  const toggle = el("button", on ? "toggle on" : "toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-pressed", String(on));
  toggle.setAttribute("aria-label", "Fast processing");
  const word = document.createTextNode(on ? "On" : "Off");
  const track = el("span", "track");
  track.append(el("span", "knob"));
  toggle.append(word, track);
  toggle.addEventListener("click", () => {
    on = !on;
    toggle.classList.toggle("on", on);
    toggle.setAttribute("aria-pressed", String(on));
    word.data = on ? "On" : "Off";
  });
  row.append(name, toggle, el("p", "hint", FAST_COST_NOTE));
  return {
    row,
    fast: () => eligible && on,
    offer: (yes) => {
      if (yes && !eligible) row.classList.add("rise");
      eligible = yes;
      row.style.display = yes ? "" : "none";
    },
  };
}
