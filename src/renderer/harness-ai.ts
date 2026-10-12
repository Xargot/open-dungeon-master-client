// Story AI's fourth door on a computer: "Use an agent I already have". The
// device world's own server lists the agent programs it can start (Claude
// Code, Codex, opencode, Grok Build), signed in and locked down, and the
// player picks one and a model. Nothing is looked for or stored by the shell
// itself: the server is what will start the program, so its answer is the
// only one that counts, and no vendor password or key is ever asked for.
import { backLink, formCard, intro, loadingScreen, show } from "./chrome.js";
import { button, chip, copyText, el } from "./dom.js";
import { renderError } from "./servers.js";
import { state } from "./state.js";
import type { AiSetup, HarnessCard, HarnessStatusResult } from "../shared/types";
import { harnessFastModel } from "../shared/ai-setup.js";
import { speedChoice } from "./speed-choice.js";

type Finish = (setup: AiSetup) => Promise<void>;
type Back = () => void;

function statusTag(card: HarnessCard): { text: string; tone: "ok" | "warn" | "off" } {
  if (card.availability !== "ok") return { text: "not available here", tone: "off" };
  if (!card.installed) return { text: "not installed", tone: "off" };
  if (card.auth.state === "signed-out") return { text: "sign in needed", tone: "warn" };
  return { text: "ready", tone: "ok" };
}

function describe(card: HarnessCard): string {
  if (card.availability !== "ok" || !card.installed) {
    return card.message ?? `${card.label} was not found on this computer.`;
  }
  const lockdown =
    card.lockdown === "removed" ? "Its own tools are removed" : "Its own tools are boxed in";
  const plan = card.auth.plan ? ` Signed in (${card.auth.plan}).` : "";
  return `${card.version ? `Version ${card.version}. ` : ""}${lockdown}; it only touches the table's rules.${plan}`;
}

function copyLine(text: string): HTMLElement {
  const row = el("div", "status-line");
  const code = el("code", "", text);
  code.style.userSelect = "all";
  const copy = button("quiet", "Copy", (btn) => {
    void copyText(text).then((ok) => {
      btn.textContent = ok ? "Copied" : "Copy";
    });
  });
  row.append(code, copy);
  return row;
}

export function renderHarnessPicker(finish: Finish, back: Back, refresh = false): void {
  state.screenName = "local-ai-harness";
  show("narrow", loadingScreen("Looking for your agents", "Checking which agent programs this computer has..."));
  void window.odm
    .localHarnessStatus(refresh)
    .catch((err: unknown): HarnessStatusResult => ({ ok: false, error: String(err) }))
    .then((result) => {
      if (state.screenName !== "local-ai-harness") return;
      if (!result.ok) {
        renderError(result.error);
        return;
      }
      drawPicker(result.statuses, result.current, finish, back);
    });
}

function drawPicker(
  statuses: HarnessCard[],
  current: { id: string; model: string; utilityModel: string; fast?: boolean },
  finish: Finish,
  back: Back,
): void {
  const choices = el("div", "choices");
  choices.setAttribute("role", "radiogroup");
  choices.setAttribute("aria-label", "Agent program");
  for (const card of statuses) {
    const tag = statusTag(card);
    const btn = el("button", "panel ornate choice");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(card.id === current.id));
    btn.append(chip("wand"));
    const text = el("span", "text");
    const heading = el("span", "title", card.label);
    heading.append(el("span", `tag ${tag.tone}`, tag.text));
    text.append(heading, el("span", "desc", describe(card)));
    btn.append(text);
    btn.addEventListener("click", () => {
      for (const other of choices.querySelectorAll("[role=radio]")) {
        other.setAttribute("aria-checked", String(other === btn));
      }
      drawDetail(card, current, finish, statuses, back);
    });
    choices.append(btn);
  }
  show(
    "mid",
    backLink("Story AI", back),
    intro(
      "Use an agent you already have",
      "Claude Code, Codex, opencode or Grok Build narrates on its own sign-in. It gets none of its own tools: only the table's rules, turn by turn, the same as the built-in storyteller.",
    ),
    choices,
    button("quiet", "Check again", () => renderHarnessPicker(finish, back, true), "refresh"),
  );
}

function drawDetail(
  card: HarnessCard,
  current: { id: string; model: string; utilityModel: string; fast?: boolean },
  finish: Finish,
  statuses: HarnessCard[],
  back: Back,
): void {
  state.screenName = "local-ai-harness-detail";
  const again = () => renderHarnessPicker(finish, back, true);
  const backToList = backLink("Agents", () => drawPicker(statuses, current, finish, back));
  if (card.availability !== "ok") {
    show("narrow", backToList, intro(card.label, ""), formCard(el("p", "error", card.message ?? "Not available here.")));
    return;
  }
  if (!card.installed || card.auth.state === "signed-out") {
    const steps = formCard(
      el(
        "p",
        "hint",
        card.installed
          ? `${card.label} is installed but not signed in. Sign it in once in a terminal, then check again.`
          : `${card.label} is not installed. Install it in a terminal, sign it in, then check again.`,
      ),
      card.installed ? null : copyLine(card.installHint ?? ""),
      copyLine(card.signInHint ?? ""),
      button("primary", "Check again", again, "refresh"),
    );
    show("narrow", backToList, intro(card.label, ""), steps);
    return;
  }

  const form = el("form");
  const models = [...card.models];
  const pick = (labelText: string, value: string, preferCheap: boolean) => {
    const wrap = el("label", "", labelText);
    const select = el("select");
    const first = el("option", "", preferCheap ? "Same as the story model" : "The program's own default");
    first.value = "";
    select.append(first);
    const ordered = preferCheap
      ? [...models].sort((a, b) => Number(Boolean(b.cheap)) - Number(Boolean(a.cheap)))
      : models;
    for (const model of ordered) {
      const option = el("option", "", model.cheap && preferCheap ? `${model.label} (light)` : model.label);
      option.value = model.id;
      select.append(option);
    }
    if (value && !models.some((model) => model.id === value)) {
      const option = el("option", "", value);
      option.value = value;
      select.append(option);
    }
    select.value = value;
    wrap.append(select);
    return { wrap, select };
  };
  const same = current.id === card.id;
  const story = pick("Story model", same ? current.model : "", false);
  const utility = pick("Bookkeeping model (summaries, Ask)", same ? current.utilityModel : "", true);
  // Fast where the program runs the chosen model at it: Claude Code on its
  // Opus models, Codex where its model list says so.
  const speed = speedChoice(same && current.fast === true);
  const offerFast = () =>
    speed.offer(
      harnessFastModel(card.id, story.select.value, models) || harnessFastModel(card.id, utility.select.value, models),
    );
  story.select.addEventListener("change", offerFast);
  utility.select.addEventListener("change", offerFast);
  offerFast();
  const scope = el(
    "p",
    "hint",
    "Every campaign on this computer narrates with it from now on, on its own sign-in and plan. Pictures stay as they are: a local image AI keeps painting, and otherwise the tables use their painted placeholders.",
  );
  const submit = button("primary", "Save and play", undefined, "play");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(story.wrap, utility.wrap, speed.row, scope, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    void finish({
      choice: "harness",
      apiKey: "",
      model: "",
      utilityModel: "",
      harness: { id: card.id, model: story.select.value, utilityModel: utility.select.value },
      fast: speed.fast(),
    })
      .catch(() => undefined)
      .then(() => {
        submit.disabled = false;
      });
  });
  show("narrow", backToList, intro(`Narrate with ${card.label}`, describe(card)), formCard(form));
}
