// Narration and sound in Settings, under the world this app hosts, and as
// the guided setup's last step: what reads the story aloud and the sound
// library download, both of which used to live only in the world's own
// admin page. The work is src/shared/world-media.ts; each shell wakes the
// world to ask it. What the card knows lives outside it, like the story
// memory note: Settings repaints on every status event of the world, and
// waking it sends two.
import { intro, onLeaveScreen, show } from "./chrome.js";
import { button, chip, copyText, el, input, spinner } from "./dom.js";
import type { IconName } from "./dom.js";
import { renderLocalAi, startGuidedSetup } from "./local-ai.js";
import { row, section } from "./settings.js";
import { isAndroid, state } from "./state.js";
import {
  SOUND_PACK_MB,
  cleanKokoroUrl,
  narrationInEffect,
  narrationSummary,
  soundLibraryOffer,
  soundLibrarySummary,
} from "../shared/world-media.js";
import type { NarrationChoice, NarrationStatus, SoundLibraryStatus } from "../shared/types";

// Kokoro-FastAPI's published images, as the server's guided setup offers
// them (src/app/setup/MediaSteps.tsx).
const KOKORO_COMMANDS = [
  { label: "Without a graphics card", command: "docker run -d --name kokoro --restart unless-stopped -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest" },
  { label: "With an NVIDIA graphics card", command: "docker run -d --name kokoro --restart unless-stopped --gpus all -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-gpu:latest" },
];

type Note =
  | { kind: "none" }
  | { kind: "working"; text: string }
  | { kind: "done"; text: string }
  | { kind: "error"; message: string };

const media: {
  narration: NarrationStatus | null;
  library: SoundLibraryStatus | null;
  // Asked once per visit; a failed ask says why in place of the status.
  narrationAsked: boolean;
  libraryAsked: boolean;
  narrationError: string;
  libraryError: string;
  // A download asked for and not yet answered.
  libraryStarting: boolean;
  busy: boolean;
  note: Note;
  shown: Note | null;
  poll: number;
  repaint: (() => void) | null;
  // Whether the card last drawn is still on screen (Settings repaints it
  // away and draws another).
  alive: (() => boolean) | null;
} = {
  narration: null,
  library: null,
  narrationAsked: false,
  libraryAsked: false,
  narrationError: "",
  libraryError: "",
  libraryStarting: false,
  busy: false,
  note: { kind: "none" },
  shown: null,
  poll: 0,
  repaint: null,
  alive: null,
};

let sample: HTMLAudioElement | null = null;

// A fresh visit to Settings asks the world again (Kokoro may have been
// started meanwhile); a download in flight keeps its progress.
export function forgetWorldMedia(): void {
  if (media.busy) return;
  media.narrationAsked = false;
  media.libraryAsked = false;
  media.narrationError = "";
  media.libraryError = "";
  media.note = { kind: "none" };
}

function setNote(note: Note): void {
  media.note = note;
  media.repaint?.();
}

function askNarration(): void {
  const ask = window.odm.localNarration;
  if (!ask) return;
  media.narrationAsked = true;
  void ask()
    .catch(() => ({ ok: false as const, error: "Your world did not answer." }))
    .then((result) => {
      if (result.ok) {
        media.narration = result.narration;
        media.narrationError = "";
      } else {
        media.narrationError = result.error;
      }
      media.repaint?.();
    });
}

function applyLibrary(result: Awaited<ReturnType<NonNullable<typeof window.odm.localSoundLibrary>>>): void {
  media.libraryStarting = false;
  if (result.ok) {
    media.library = result.library;
    media.libraryError = "";
  } else {
    media.libraryError = result.error;
  }
  media.repaint?.();
  window.clearTimeout(media.poll);
  // Polled while the pack comes down, and only while the card is on screen;
  // a later visit picks the progress up again.
  if (media.library?.status === "installing") {
    media.poll = window.setTimeout(() => {
      if (media.alive?.()) askLibrary(false);
    }, 1000);
  }
}

function askLibrary(install: boolean): void {
  const ask = window.odm.localSoundLibrary;
  if (!ask) return;
  media.libraryAsked = true;
  if (install) media.libraryStarting = true;
  void ask(install)
    .catch(() => ({ ok: false as const, error: "Your world did not answer." }))
    .then(applyLibrary);
}

async function choose(choice: NarrationChoice): Promise<void> {
  const save = window.odm.localSetNarration;
  if (!save || media.busy) return;
  media.busy = true;
  setNote({ kind: "working", text: "Saving..." });
  const result = await save(choice).catch(() => ({ ok: false as const, error: "Your world did not answer." }));
  media.busy = false;
  if (!result.ok) {
    setNote({ kind: "error", message: result.error });
    return;
  }
  media.narration = result.narration;
  setNote(result.notice ? { kind: "done", text: result.notice } : { kind: "none" });
}

// The sample comes back as a data URL; the desktop's page policy plays only
// blob: audio, so it is handed over as one.
function audioFrom(dataUrl: string): HTMLAudioElement {
  const comma = dataUrl.indexOf(",");
  const type = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? "audio/mpeg";
  const bytes = Uint8Array.from(atob(dataUrl.slice(comma + 1)), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const audio = new Audio(url);
  audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
  return audio;
}

async function hearSample(): Promise<void> {
  const ask = window.odm.localNarrationSample;
  if (!ask || media.busy) return;
  media.busy = true;
  setNote({ kind: "working", text: "Asking for a sample. The first one can take a few seconds." });
  const result = await ask().catch(() => ({ ok: false as const, error: "Your world did not answer." }));
  media.busy = false;
  if (!result.ok) {
    setNote({ kind: "error", message: result.error });
    return;
  }
  sample?.pause();
  sample = audioFrom(result.audio);
  void sample.play().catch(() => undefined);
  setNote({ kind: "done", text: "That is how your tables will hear the story." });
}

function noteNodes(note: Note): HTMLElement[] {
  switch (note.kind) {
    case "none":
      return [];
    case "working": {
      const line = el("p", "hint memory-working");
      line.append(spinner(), document.createTextNode(` ${note.text}`));
      return [line];
    }
    case "done":
      return [el("p", "hint", note.text)];
    case "error":
      return [el("p", "error tt-shake", note.message)];
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function voiceChoice(iconName: IconName, title: string, onClick: () => void): { btn: HTMLButtonElement; desc: HTMLElement } {
  const btn = el("button", "panel ornate choice");
  btn.type = "button";
  btn.setAttribute("role", "radio");
  btn.append(chip(iconName));
  const text = el("span", "text");
  const desc = el("span", "desc");
  text.append(el("span", "title", title), desc);
  btn.append(text);
  btn.addEventListener("click", onClick);
  return { btn, desc };
}

function kokoroHelp(): HTMLDetailsElement {
  const help = el("details", "tuning");
  help.append(el("summary", "", "How do I start Kokoro on this computer?"));
  help.append(el("p", "hint", "Kokoro-FastAPI runs in Docker. Start it once with one of these and it comes back with the computer; then press Check again."));
  for (const { label, command } of KOKORO_COMMANDS) {
    const line = el("div", "settings-row");
    const text = el("span", "grow");
    text.append(el("span", "settings-label", label), el("code", "media-command", command));
    const copy = button("secondary", "Copy", (btn) => {
      void copyText(command).then((ok) => {
        btn.lastChild!.textContent = ok ? "Copied" : "Copy failed";
      });
    }, "copy");
    line.append(text, copy);
    help.append(line);
  }
  help.append(button("secondary", "Check again", () => askNarration(), "refresh"));
  return help;
}

function kokoroElsewhere(): HTMLDetailsElement {
  const box = el("details", "tuning");
  box.append(el("summary", "", isAndroid ? "Kokoro on a computer on your network" : "Kokoro on another computer"));
  const [label, field] = input("Its address", "text", media.narration?.kokoroUrl ?? "");
  field.placeholder = "192.168.1.20:8880";
  const error = el("p", "error");
  const save = button("secondary", "Use this Kokoro", () => {
    const url = cleanKokoroUrl(field.value);
    if (!url) {
      error.textContent = "Type the address Kokoro answers on, like 192.168.1.20:8880.";
      field.focus();
      return;
    }
    error.textContent = "";
    void choose({ kind: "kokoro", url });
  }, "check");
  box.append(label, error, save);
  return box;
}

// setup: drawn by the guided setup, where the screen's own heading says
// what the card is for, and a missing OpenAI key is added without leaving
// the setup.
export function worldMediaSection(setup = false): HTMLElement | null {
  const odm = window.odm;
  if (!odm.localNarration || !odm.localSetNarration || !odm.localSoundLibrary) return null;
  if (state.local.state === "unavailable" || (state.local.firstRun && !setup)) return null;
  const { card, body } = section(
    "volume",
    "Narration and sound",
    setup ? "" : "What reads the story aloud at your tables, and the music and ambience they play, for every campaign in your world.",
  );

  // ---- reading aloud ----
  const narrationHead = el("span", "settings-label", "Reading the story aloud");
  const narrationLine = el("p", "settings-note");
  narrationLine.setAttribute("aria-live", "polite");
  const group = el("div", "choices memory-choices");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "What reads the story aloud");
  const help = isAndroid ? null : kokoroHelp();
  const elsewhere = kokoroElsewhere();
  const openai = voiceChoice("key", "OpenAI's voices", () => {
    // No key yet: Story AI's key form, which offers the voices too (in the
    // guided setup, as its first step again, so it comes back here).
    if (!media.narration?.keySaved) {
      if (setup) startGuidedSetup();
      else renderLocalAi(true);
    } else void choose({ kind: "openai" });
  });
  const kokoro = voiceChoice("cpu", "Kokoro, free", () => {
    const status = media.narration;
    if (!status) return;
    if (status.found) void choose({ kind: "kokoro", url: status.found });
    else if (status.kokoroUrl) void choose({ kind: "kokoro", url: status.kokoroUrl });
    else {
      // Nothing to point at yet: open the way to start or find one.
      const open = help ?? elsewhere;
      open.open = true;
      open.querySelector("summary")?.focus();
    }
  });
  const off = voiceChoice("book", "On screen only", () => void choose({ kind: "off" }));
  off.desc.textContent = "Nothing is read aloud; the story stays on screen.";
  group.append(openai.btn, kokoro.btn, off.btn);
  const sampleRow = row(
    "Hear how your tables will sound",
    button("secondary", "Hear a sample", () => void hearSample(), "play"),
  );
  const status = el("div", "memory-status");
  status.setAttribute("aria-live", "polite");

  // ---- the sound library ----
  const libraryHead = el("span", "settings-label", "Music and ambience");
  const libraryLine = el("p", "settings-note");
  libraryLine.setAttribute("aria-live", "polite");
  const bar = el("div", "progress");
  const fill = el("div", "progress-fill");
  bar.append(fill);
  const download = button("secondary", `Download the sound library (about ${SOUND_PACK_MB} MB)`, () => {
    askLibrary(true);
    media.repaint?.();
  }, "download");
  const libraryRow = row("Rooms, music and one-shot sounds for every table", download);

  body.append(narrationHead, narrationLine, group, sampleRow, ...(help ? [help] : []), elsewhere, status);
  body.append(libraryHead, libraryLine, bar, libraryRow);

  let shownNote: Note | null = null;
  const paint = (): void => {
    const narration = media.narration;
    narrationLine.textContent = narration
      ? narrationSummary(narration)
      : media.narrationError || "Asking your world what reads its story aloud...";
    const effect = narration ? narrationInEffect(narration) : "";
    for (const [id, choice] of [["openai", openai], ["kokoro", kokoro], ["off", off]] as const) {
      choice.btn.setAttribute("aria-checked", String(effect === id));
      choice.btn.disabled = media.busy || !narration;
    }
    openai.desc.textContent = narration?.keySaved
      ? "Natural voices on the OpenAI key this world holds, billed per passage."
      : "Needs an OpenAI key. Opens Story AI, where the key form offers the voices too.";
    kokoro.desc.textContent = narration?.found
      ? `Free, private voices from the Kokoro answering at ${hostOf(narration.found)}.`
      : narration?.kokoroUrl
        ? `Free voices from the Kokoro at ${hostOf(narration.kokoroUrl)}.`
        : isAndroid
          ? "Free voices from a Kokoro on a computer on your network. Its address goes below."
          : "Free, private voices on this computer. Kokoro is not running here yet; see how to start it below.";
    if (help) help.hidden = Boolean(narration?.found);
    sampleRow.hidden = !narration || effect === "off" || effect === "" || (effect === "openai" && !narration.keySaved);
    (sampleRow.querySelector("button") as HTMLButtonElement).disabled = media.busy;

    const library = media.library;
    libraryLine.textContent = library
      ? soundLibrarySummary(library)
      : media.libraryError || "Asking your world about its sound library...";
    const installing = library?.status === "installing";
    bar.hidden = !installing;
    fill.style.width = `${Math.max(3, Math.round((library?.progress ?? 0) * 100))}%`;
    const offer = library ? soundLibraryOffer(library) : null;
    libraryRow.hidden = !offer;
    download.disabled = media.libraryStarting;
    download.className = `btn ${offer === "again" ? "quiet" : "secondary"}`;
    download.lastChild!.textContent =
      offer === "retry" ? "Try the download again" : offer === "again" ? `Download again (about ${SOUND_PACK_MB} MB)` : `Download the sound library (about ${SOUND_PACK_MB} MB)`;

    if (shownNote === media.note) return;
    shownNote = media.note;
    const nodes = noteNodes(media.note);
    const holder = el("div", media.shown === media.note ? "memory-line settled" : "memory-line");
    media.shown = media.note;
    holder.append(...nodes);
    status.replaceChildren(...(nodes.length ? [holder] : []));
  };
  media.repaint = () => {
    if (card.isConnected) paint();
  };
  media.alive = () => card.isConnected;
  paint();
  // A repaint of Settings replaces this card with another; the sample stops
  // only once no card is left on screen.
  onLeaveScreen(() => {
    window.setTimeout(() => {
      if (media.alive?.()) return;
      sample?.pause();
      sample = null;
    }, 0);
  });

  if (!media.narrationAsked) askNarration();
  if (!media.libraryAsked) askLibrary(false);
  return card;
}

// The guided setup's last step, on a screen of its own: the same card, then
// the home screen. Everything here can be changed later in Settings.
export function renderMediaSetup(done: () => void): void {
  state.screenName = "media-setup";
  forgetWorldMedia();
  const card = worldMediaSection(true);
  if (!card) {
    done();
    return;
  }
  const finish = button("primary", "Continue", () => done(), "play");
  finish.classList.add("block");
  const actions = el("div", "actions media-setup-actions");
  actions.append(finish);
  show(
    "mid",
    intro(
      "Voices and music",
      "How your tables sound: what reads the story aloud, and the rooms, music and sound effects they play. Both are optional, and Settings changes them any time.",
    ),
    card,
    actions,
  );
}
