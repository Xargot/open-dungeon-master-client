// The device world: entering it (which starts it), the first-run name and
// the account screens, and the share row that shows the world's public
// address and the switch for it.
import { hostCodeFromOrigin } from "../shared/deep-link.js";
import { encodeQr, qrSvg } from "../shared/qr.js";
import { backLink, formCard, intro, show } from "./chrome.js";
import { badge, button, copyText, el, input, spinner } from "./dom.js";
import { tryOpenNativeLocal } from "./game-screen.js";
import { renderHome } from "./home.js";
import { renderLocalAi } from "./local-ai.js";
import { renderSettings } from "./settings.js";
import type { TunnelStatus } from "../shared/types.js";
import { isAndroid, localPlayAt, refresh, state } from "./state.js";

// Opens the device world, starting it first when it sleeps. path is the
// page to land on ("" for the world's root).
export async function playLocal(btn: HTMLButtonElement | null, path = ""): Promise<void> {
  if (btn) btn.disabled = true;
  // The app's own screens once the world has a profile; the first run and
  // a lapsed sign-in go through the shell's own flow below.
  const native = await tryOpenNativeLocal(state.joinIntent?.code, path).catch(() => false);
  if (native) {
    if (btn) btn.disabled = false;
    state.joinIntent = null;
    return;
  }
  const result = await localPlayAt(state.joinIntent?.code, path);
  if (btn) btn.disabled = false;
  if (result.ok) {
    if (result.needsName) {
      // A fresh device world: who is playing comes first, then who narrates.
      renderLocalName();
      return;
    }
    if (result.firstSetup) {
      // The shell just created the local profile; the only choice worth a
      // screen is who tells the story.
      renderLocalAi();
      return;
    }
    state.joinIntent = null;
    return;
  }
  if (result.needsLogin) {
    renderLocalAccount("login");
  } else {
    await refresh();
    renderHome();
  }
}

export function openLocal(path: string): Promise<void> {
  return playLocal(null, path);
}

// Repaints whichever screen holds the share row.
function rerenderShareScreen(): void {
  if (state.screenName === "home") renderHome();
  else if (state.screenName === "settings") renderSettings();
}

// The public address as a QR code: the app's scanner reads it as a server
// to add, a phone camera opens it in a browser. Built inline (the shell's
// own encoder in src/shared/qr.ts), so it works offline and under the
// page's script-src 'self' policy.
function qrPanel(url: string): HTMLElement {
  const panel = el("div", "qr-panel");
  const frame = el("div", "qr-frame");
  frame.innerHTML = qrSvg(encodeQr(url));
  frame.querySelector("svg")?.setAttribute("aria-label", `QR code for ${url}`);
  panel.append(
    frame,
    el(
      "p",
      "hint center",
      "Scan with the Open Dungeon Master app to add this world, or with a phone camera to open it in a browser.",
    ),
  );
  return panel;
}

// Sharing only means anything while the world runs, and it is a property
// of that world rather than a peer of it. The campaign lobby's invite dialog
// can start it too, so this row is the overview and the off switch as much
// as the way in. While shared, the address can be copied, sent
// through the system share sheet where there is one, or shown as a QR.
export function shareRow(): HTMLElement {
  const row = el("div", "hero-actions stacked share-row");
  const tunnel = state.tunnel;
  if (tunnel.state === "running") {
    row.append(badge("Shared online", true));
    // The invite friends actually need leads: a campaign's room code, from
    // its lobby (Invite there has the link and the QR too). While shared,
    // every code this world's campaigns have points here. The address and
    // the host code come after, for someone with no code to hand.
    row.append(
      el(
        "span",
        "status-line",
        "Friends join with a campaign's room code from its lobby, while this app stays open.",
      ),
    );
    const code = hostCodeFromOrigin(tunnel.url);
    row.append(
      el(
        "span",
        "status-line quiet",
        code ? `Without a code: ${tunnel.url}, or host code ${code}.` : `Without a code: ${tunnel.url}`,
      ),
    );
    const copy = button("secondary", "Copy link", () => {
      void copyText(tunnel.url).then((worked) => {
        copy.lastChild!.textContent = worked ? "Copied" : "Copy failed";
        setTimeout(() => (copy.lastChild!.textContent = "Copy link"), 1500);
      });
    }, "copy");
    row.append(copy);
    if (window.odm.shareLink) {
      row.append(
        button("secondary", "Share", () => {
          void window.odm.shareLink?.({
            title: "Join my world on Open Dungeon Master",
            text: `Join my world on Open Dungeon Master: ${tunnel.url}`,
            url: tunnel.url,
          });
        }, "share"),
      );
    }
    row.append(
      button("secondary", state.shareQrOpen ? "Hide QR" : "QR code", () => {
        state.shareQrOpen = !state.shareQrOpen;
        rerenderShareScreen();
      }, "qr"),
    );
    const stop = button("quiet", "Stop sharing", (btn) => {
      btn.disabled = true;
      state.shareQrOpen = false;
      void window.odm.shareStop();
    });
    row.append(stop);
    if (state.shareQrOpen) row.append(qrPanel(tunnel.url));
    return row;
  }
  if (tunnel.state === "starting") {
    row.append(spinner(), el("span", "status-line", "Opening a public address..."));
    return row;
  }
  const lan = state.local.lanOrigin;
  if (lan) {
    // Sharing on this Wi-Fi: the address friends at the table type or scan.
    // Online sharing can still be opened on top of it.
    row.append(badge("Shared on this Wi-Fi", true));
    row.append(
      el(
        "span",
        "status-line",
        "Friends on the same network join with a campaign's room code, or open this address in a browser or the app. No internet needed; it stays open until you stop sharing or quit.",
      ),
    );
    row.append(el("span", "status-line quiet", lan));
    const copy = button("secondary", "Copy address", () => {
      void copyText(lan).then((worked) => {
        copy.lastChild!.textContent = worked ? "Copied" : "Copy failed";
        setTimeout(() => (copy.lastChild!.textContent = "Copy address"), 1500);
      });
    }, "copy");
    row.append(copy);
    row.append(
      button("secondary", state.shareQrOpen ? "Hide QR" : "QR code", () => {
        state.shareQrOpen = !state.shareQrOpen;
        rerenderShareScreen();
      }, "qr"),
    );
    row.append(shareOnlineButton(tunnel));
    row.append(
      button("quiet", "Stop Wi-Fi sharing", (btn) => {
        btn.disabled = true;
        state.shareQrOpen = false;
        void window.odm.lanStop().then(async () => {
          await refresh().catch(() => undefined);
          rerenderShareScreen();
        });
      }),
    );
    if (state.shareQrOpen) row.append(qrPanel(lan));
    return row;
  }
  const idle = lan
    ? `On your Wi-Fi at ${lan}. Share online and friends anywhere can join with a campaign's room code.`
    : `Share on this Wi-Fi for a table in the same room, no internet needed. Share online${isAndroid ? " while the app runs" : ""} and friends anywhere can join with a campaign's room code.`;
  const line = el("span", "status-line", state.lanError || (tunnel.state === "error" ? tunnel.error : idle));
  row.append(line);
  if (state.local.state !== "unavailable") {
    row.append(
      button("secondary", state.lanError ? "Try Wi-Fi again" : "Share on this Wi-Fi", (btn) => {
        btn.disabled = true;
        state.lanError = "";
        void window.odm.lanStart().then(async (result) => {
          if (!result.ok) state.lanError = result.error;
          await refresh().catch(() => undefined);
          rerenderShareScreen();
        });
      }, "wifi"),
    );
  }
  row.append(shareOnlineButton(tunnel));
  return row;
}

function shareOnlineButton(tunnel: TunnelStatus): HTMLButtonElement {
  return button(
    "secondary",
    tunnel.state === "error" ? "Try sharing again" : "Share online",
    (btn) => {
      btn.disabled = true;
      void window.odm.shareStart().then(async (result) => {
        if (!result.ok) state.tunnel = { state: "error", url: "", mode: "", error: result.error };
        await refresh().catch(() => undefined);
        rerenderShareScreen();
      });
    },
    "globe",
  );
}

export function renderLocalAccount(mode: "create" | "login"): void {
  state.screenName = "local-account";
  const form = el("form");
  const [userLabel, userField] = input("Username", "text", mode === "login" ? state.local.username : "");
  userField.autocomplete = "username";
  const [passLabel, passField] = input("Password", "password");
  passField.autocomplete = mode === "login" ? "current-password" : "new-password";
  const error = el("p", "error");
  const submit = button("primary", mode === "create" ? "Create" : "Sign in");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(userLabel, passLabel, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    const credentials = { username: userField.value.trim(), password: passField.value };
    const call =
      mode === "create"
        ? window.odm.localCreateAccount(credentials)
        : window.odm.localLogin(credentials);
    void call.then((result) => {
      submit.disabled = false;
      if (!result.ok) {
        error.textContent = result.error;
        return;
      }
      state.local = result.status;
      if (mode === "create") {
        renderLocalAi();
      } else {
        void playLocal(null);
      }
    });
  });
  show(
    "narrow",
    backLink("Home", () => renderHome()),
    intro(
      mode === "create" ? "Create your account" : "Sign in to your world",
      mode === "create"
        ? "This account lives only on this computer and becomes the world's owner."
        : "Use the account you created for offline play.",
    ),
    formCard(form),
  );
  (mode === "login" && state.local.username ? passField : userField).focus();
}

// First launch of a device world: the name the table will know the player
// by. The shell mints and keeps the password, so this is the whole form.
export function renderLocalName(): void {
  state.screenName = "local-name";
  const form = el("form");
  const [nameLabel, nameField] = input("Your name", "text");
  nameField.placeholder = "How the table will know you";
  nameField.autocomplete = "username";
  nameField.maxLength = 24;
  const error = el("p", "error");
  const submit = button("primary", "Start playing", undefined, "play");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(nameLabel, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    void window.odm
      .localCreateAccount({ username: nameField.value.trim(), password: "" })
      .then((result) => {
        submit.disabled = false;
        if (!result.ok) {
          error.textContent = result.error;
          return;
        }
        state.local = result.status;
        renderLocalAi();
      });
  });
  show(
    "narrow",
    backLink("Home", () => void refresh().then(() => renderHome())),
    intro(
      "Name your adventurer",
      "Your world lives on this device. Pick the name friends will see at the table; letters, digits, _ and - only.",
    ),
    formCard(form, el("p", "hint center", "You can add a password later in the game's settings.")),
  );
  nameField.focus();
}
