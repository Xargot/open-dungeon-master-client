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
import { harnessDescription, harnessStep, harnessTag } from "../shared/harness-card.js";
import { speedChoice } from "./speed-choice.js";
import { renderAgentPictures } from "./local-ai.js";

type Finish = (setup: AiSetup, next?: () => void) => Promise<void>;
type Back = () => void;

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
    const tag = harnessTag(card);
    const btn = el("button", "panel ornate choice");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(card.id === current.id));
    btn.append(chip("wand"));
    const text = el("span", "text");
    const heading = el("span", "title", card.label);
    heading.append(el("span", `tag ${tag.tone}`, tag.text));
    text.append(heading, el("span", "desc", harnessDescription(card)));
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
      "Claude Code, Codex, opencode or Grok Build tells the story on its own sign-in. It gets none of its own tools: only the table's rules, turn by turn, the same as the built-in storyteller.",
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
  const step = harnessStep(card);
  if (step === "unavailable") {
    show("narrow", backToList, intro(card.label, ""), formCard(el("p", "error", card.message ?? "Not available here.")));
    return;
  }
  // Installed, but it cannot narrate as it is (opencode 1.x, or a config of
  // its own the server could not read): what is wrong, the command that
  // installs the version the server drives, and no model form to save a
  // choice that would fail every turn.
  if (step === "fix") {
    show(
      "narrow",
      backToList,
      intro(card.label, ""),
      formCard(
        el("p", "error", card.message ?? ""),
        el("p", "hint", `Fix it in a terminal on this computer, then check again. ${card.label}'s install command:`),
        copyLine(card.installHint ?? ""),
        button("primary", "Check again", again, "refresh"),
      ),
    );
    return;
  }
  if (step === "install" || step === "signIn") {
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
  // Fast where the program runs the chosen model at it: Claude Code and
  // Codex each say so per model in the list the server probed.
  const speed = speedChoice(same && current.fast === true);
  const offerFast = () =>
    speed.offer(
      harnessFastModel(card.id, story.select.value, models) || harnessFastModel(card.id, utility.select.value, models),
    );
  story.select.addEventListener("change", offerFast);
  utility.select.addEventListener("change", offerFast);
  offerFast();
  const paints = card.nativeImages !== "no";
  const scope = el(
    "p",
    "hint",
    paints
      ? `Every campaign on this computer has it tell the story from now on, on its own sign-in and plan. ${card.label} can paint too: the next screen offers it, after one test map.`
      : "Every campaign on this computer has it tell the story from now on, on its own sign-in and plan. Pictures stay as they are: a local image AI keeps painting, and otherwise the tables use their painted placeholders.",
  );
  const submit = button("primary", "Save and play", undefined, "play");
  submit.type = "submit";
  submit.classList.add("block");
  const tuning = el("details", "tuning");
  tuning.append(el("summary", "", "Optional tuning: bookkeeping model and speed"), utility.wrap, speed.row);
  form.append(story.wrap, tuning, scope, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    void finish(
      {
        choice: "harness",
        apiKey: "",
        model: "",
        utilityModel: "",
        harness: { id: card.id, model: story.select.value, utilityModel: utility.select.value },
        fast: speed.fast(),
      },
      // An agent with an image tool is offered the pictures as well.
      paints ? () => renderAgentPictures(card.label) : undefined,
    )
      .catch(() => undefined)
      .then(() => {
        submit.disabled = false;
      });
  });
  show("narrow", backToList, intro(`Tell the story with ${card.label}`, harnessDescription(card)), formCard(form));
}
