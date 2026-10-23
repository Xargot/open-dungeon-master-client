// Remote servers: adding one, signing in or registering, connecting and
// forgetting, plus the error screen every flow falls back to. The
// behaviour here is unchanged from the single-file shell; only the frame
// around it moved.
import { CODE_SHAPE, insecureRemoteOrigin, parseRoomCode } from "../shared/deep-link.js";
import { joinFormShape } from "../shared/join-form.js";
import { landingPath } from "../shared/open-path.js";
import { backLink, formCard, intro, joinBanner, show } from "./chrome.js";
import { button, el, input } from "./dom.js";
import { tryOpenNative } from "./game-screen.js";
import { submitJoin } from "./submit-join.js";
import { forgetObjectUrls } from "./game/object-urls.js";
import { renderHome } from "./home.js";
import { connectAt, hostVersions, refresh, refreshFeed, state } from "./state.js";
import type { ServerProbe, ServerSummary } from "../shared/types";

export function renderError(message: string): void {
  state.screenName = "error";
  const card = formCard(el("h2", "", "Something went wrong"), el("p", "sub", message));
  card.append(button("secondary", "Back", () => void refresh().then(() => renderHome()), "arrowLeft"));
  show("narrow", intro("A snag on the road", ""), card);
}

export async function forgetServer(server: ServerSummary): Promise<void> {
  await window.odm.removeServer(server.id);
  forgetObjectUrls();
  await refresh();
  renderHome();
}

function longDate(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "the server's due date";
  return when.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// Deleting the player's account on one server, from the shell itself. The
// server keeps the rules (its grace period, whether a password is needed);
// this screen only asks, confirms, and tells the player what happens next.
export function renderDeleteAccount(server: ServerSummary): void {
  state.screenName = "delete-account";
  const name = server.name || server.origin;
  const form = el("form");
  const [passLabel, passField] = input("Your password", "password");
  passField.autocomplete = "current-password";
  const [confirmLabel, confirmField] = input('Type DELETE to confirm', "text");
  const error = el("p", "error");
  const submit = button("primary", "Delete my account", undefined, "trash");
  submit.type = "submit";
  submit.classList.add("block");
  submit.disabled = true;
  confirmField.addEventListener("input", () => {
    submit.disabled = confirmField.value.trim() !== "DELETE";
  });
  form.append(
    el(
      "p",
      "sub",
      `This deletes ${server.username} on ${name}: the campaigns you created there, your characters and your pictures. The server signs you out everywhere and erases the account after its grace period; signing in before then keeps it.`,
    ),
    passLabel,
    el("p", "hint", "Leave blank if you only ever sign in there with Discord."),
    confirmLabel,
    error,
    submit,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    void window.odm
      .deleteAccount({ serverId: server.id, password: passField.value })
      .then(async (result) => {
        if (!result.ok) {
          submit.disabled = false;
          error.textContent = result.error;
          return;
        }
        forgetObjectUrls();
        await refresh();
        const { deletion } = result;
        const card = formCard(
          el("h2", "", deletion.purged ? "Account deleted" : "Deletion scheduled"),
          el(
            "p",
            "sub",
            deletion.purged
              ? `Your account on ${name} and everything it owned are gone.`
              : `${name} will erase your account on ${longDate(deletion.dueAt)}. You are signed out there. To keep it, sign in again before then and choose "Keep my account".`,
          ),
        );
        card.append(
          button("secondary", "Forget this server", () => void forgetServer(server), "close"),
          button("primary", "Home", () => renderHome(), "arrowLeft"),
        );
        show("narrow", intro(name, hostOfOrigin(server.origin)), card);
      });
  });
  show(
    "narrow",
    backLink("Home", () => renderHome()),
    intro("Delete account", `${server.username} on ${name}`),
    formCard(form),
  );
  passField.focus();
}

function hostOfOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

// path is the page to land on inside the server ("" for its root); see
// connectAt for how it travels today.
export async function connectServer(
  server: ServerSummary,
  btn: HTMLButtonElement,
  path = "",
): Promise<void> {
  btn.disabled = true;
  if (window.odm.prepareRemote) {
    // Desktop uses the same identity, relocation and session checks as its
    // embedded view before handing a token to the native game screens.
    const prepared = await window.odm.prepareRemote(server.id, state.joinIntent?.code).catch(() => null);
    if (prepared && !prepared.ok) {
      btn.disabled = false;
      if (prepared.needsLogin) await signInTo(prepared.origin || server.origin, server.username);
      else renderError(prepared.error);
      return;
    }
    if (prepared?.ok) {
      hostVersions.set(server.id, prepared.version);
      const native = await tryOpenNative(
        server.id,
        landingPath(state.joinIntent?.code ?? "", path),
        prepared.version,
        prepared.session,
      ).catch(() => false);
      if (native) {
        btn.disabled = false;
        state.joinIntent = null;
        return;
      }
    }
  } else {
    // Android has its own bridge and keeps its existing native entry path.
    const probed = await window.odm.probeServer(server.origin).catch(() => null);
    if (probed?.ok) hostVersions.set(server.id, probed.probe.version);
    const version = probed?.ok ? probed.probe.version : (hostVersions.get(server.id) ?? "");
    if (version) {
      const native = await tryOpenNative(
        server.id,
        landingPath(state.joinIntent?.code ?? "", path),
        version,
      ).catch(() => false);
      if (native) {
        btn.disabled = false;
        state.joinIntent = null;
        return;
      }
    }
  }
  const result = await connectAt(server.id, state.joinIntent?.code, path);
  btn.disabled = false;
  if (result.ok) {
    state.joinIntent = null;
    return;
  }
  if (result.needsLogin) {
    await signInTo(server.origin, server.username);
    return;
  }
  renderError(result.error);
}

// The sign-in screen for a known server, reached from a lapsed session or
// the home screen's Sign in button.
export async function signInTo(origin: string, username: string): Promise<void> {
  const probed = await window.odm.probeServer(origin);
  if (probed.ok) renderAuth(probed.probe, "login", username);
  else renderError(probed.error);
}

export async function scanInvite(btn: HTMLButtonElement, detail?: HTMLElement): Promise<void> {
  const scan = window.odm.scanInvite;
  if (!scan) return;
  btn.disabled = true;
  const result = await scan();
  btn.disabled = false;
  if (!result.ok) {
    if (detail) detail.textContent = result.error;
    else renderError(result.error);
  }
}

// Feeds typed text (a room code, an invite link, a server address) into
// the same flow as a scanned or clicked invite. Resolves "" once the app
// has taken the player somewhere (a known server opened, a sign-in shown),
// else the sentence to show beside the field.
export async function openTyped(raw: string): Promise<string> {
  // A pasted invite link or server address takes the exact deep-link
  // path: auto-connect on a known server (by address, or by the world's
  // instanceId when it moved), or a join-request event that lands on
  // that server's sign-in. A bare host without a scheme is probed first
  // so the address that answered is the one the path sees; only a
  // server that never answers stays here with the error.
  if (await window.odm.openInviteLink(raw)) return "";
  // A room code is an address in disguise, so there is nothing left to
  // probe: the shell already expanded it and found no world there.
  // Saying that beats "not a server address" for a code that was read
  // out over a table and mistyped, or that expired when its host
  // stopped sharing.
  const typed = raw.trim();
  if (CODE_SHAPE.test(typed.toUpperCase()) || parseRoomCode(typed)) {
    return "No table answers to that code: no world is sharing it right now, and none of the servers you are signed in to has it. Check the code, or ask its host to open their world and try again.";
  }
  const result = await window.odm.probeServer(raw);
  if (result.ok && (await window.odm.openInviteLink(result.probe.origin))) return "";
  if (result.ok) {
    renderAuth(result.probe, "login", "");
    return "";
  }
  return result.error;
}

export function renderAdd(prefill: string): void {
  state.screenName = "add";
  const form = el("form");
  const [originLabel, originField] = input(
    "Room code, server address or invite link",
    "text",
    prefill,
  );
  originField.placeholder = "ABCD2345 or play.example.com";
  originField.inputMode = "url";
  const error = el("p", "error");
  const submit = button("primary", "Continue");
  submit.type = "submit";
  submit.classList.add("block");
  form.append(originLabel, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitJoin(() => openTyped(originField.value), submit, error);
  });
  const hint = el(
    "p",
    "hint center",
    "A room code from a friend, an invite link, or a QR link all work here.",
  );
  const card = formCard(form, hint);
  // Where there is a camera: the server's own corner QR button shows its
  // address as a code, and an invite QR carries a room code as well. Both
  // land in the same flow as a paste.
  if (window.odm.scanInvite) {
    const scan = button("secondary", "Scan a QR code", (btn) => void scanInvite(btn, error), "qr");
    scan.classList.add("block");
    card.append(scan);
  }
  show(
    "narrow",
    backLink("Home", () => renderHome()),
    intro("Add a server", "Where does your party gather?"),
    joinBanner(),
    card,
  );
  originField.focus();
}

function authTabs(
  probe: ServerProbe,
  active: "login" | "register",
  username: string,
): HTMLElement | null {
  if (!joinFormShape({ deviceWorld: probe.deviceWorld, signupMode: probe.signupMode, mode: active, hasRoomCode: false }).tabs) {
    return null;
  }
  const tabs = el("div", "tabs");
  const loginTab = el("button", active === "login" ? "active" : "", "Sign in");
  loginTab.type = "button";
  const registerTab = el("button", active === "register" ? "active" : "", "Create account");
  registerTab.type = "button";
  loginTab.addEventListener("click", () => renderAuth(probe, "login", username));
  registerTab.addEventListener("click", () => renderAuth(probe, "register", username));
  tabs.append(loginTab, registerTab);
  return tabs;
}

export function renderAuth(
  probe: ServerProbe,
  requested: "login" | "register",
  presetUsername: string,
): void {
  state.screenName = "auth";
  const name = probe.serverName || new URL(probe.origin).host;
  const form = el("form");
  // A world one of the apps is hosting takes a name and nothing else. The
  // host is a person with a phone, not an administrator: nobody should be
  // inventing a password for someone's game night, and the room code they
  // were given is the invitation. A real server is the other way round: its
  // owner keeps passwords and whatever signup rule they set, open, invite
  // only or closed, and the app follows it.
  //
  // There is no sign-in form for a device world at all, whatever was asked
  // for: the password there is one the app made up and kept, so a form
  // asking for it (which a lapsed session used to reach) was a dead end.
  // Joining again is the only door, and the copy says what became of the
  // old seat.
  // A server with no accounts has nobody to sign in as: the only thing to do
  // there is create the first one, which becomes its admin.
  const claiming = probe.needsSetup && !probe.deviceWorld;
  const mode: "login" | "register" = probe.deviceWorld || claiming ? "register" : requested;
  const reseat = probe.deviceWorld && requested === "login";
  const shape = joinFormShape({
    deviceWorld: probe.deviceWorld,
    signupMode: probe.signupMode,
    mode,
    hasRoomCode: !!state.joinIntent?.code,
  });
  const byRoomCode = mode === "register" && !shape.password;
  const [userLabel, userField] = input(
    byRoomCode ? "Your name at this table" : "Username",
    "text",
    reseat ? "" : presetUsername,
  );
  userField.autocomplete = "username";
  const [passLabel, passField] = input("Password", "password");
  passField.autocomplete = mode === "login" ? "current-password" : "new-password";
  // Said before anything is typed: a public server on plain http.
  if (insecureRemoteOrigin(probe.origin)) {
    form.append(
      el(
        "p",
        "hint warn",
        `${new URL(probe.origin).host} is not using HTTPS, so your ${shape.password ? "password, " : ""}sign-in and game cross the internet unencrypted. Ask whoever runs it for an https:// address if they have one.`,
      ),
    );
  }
  form.append(userLabel);
  if (shape.password) form.append(passLabel);
  let inviteField: HTMLInputElement | null = null;
  if (shape.accountInvite) {
    const [inviteLabel, field] = input("Account invite code", "text");
    field.placeholder = "ODM-XXXXXXXXXX";
    inviteField = field;
    form.append(inviteLabel);
    form.append(el("p", "hint", "This server is invite-only. Ask whoever runs it for a code."));
  }
  let setupField: HTMLInputElement | null = null;
  if (claiming) {
    const [setupLabel, field] = input("Setup code", "text");
    field.placeholder = "XXXX-XXXX-XXXX-XXXX";
    field.autocomplete = "off";
    field.autocapitalize = "characters";
    field.spellcheck = false;
    field.required = true;
    setupField = field;
    form.append(setupLabel);
    form.append(
      el(
        "p",
        "hint",
        "This server has no accounts yet. The first one becomes its admin and needs the one-time setup code printed in the server's log.",
      ),
    );
  }
  const error = el("p", "error");
  if (reseat) {
    form.prepend(
      el(
        "p",
        "hint",
        `Your seat at ${name} could not be reopened (the host may have removed it, or the app lost the key it kept). Join again with a name; your old character stays with the host, who can hand it back or clear it.`,
      ),
    );
  }
  if (byRoomCode && !state.joinIntent?.code) {
    // Without the room code the host's world has nothing to seat this
    // player at, and the server refuses. Say that here rather than after
    // the player has typed a name.
    form.append(
      el(
        "p",
        "hint",
        "This world only admits people with a room code. Open it with the code its host read out and you will be seated at that table.",
      ),
    );
  }
  const submit = button("primary", shape.submit);
  submit.type = "submit";
  submit.classList.add("block");
  form.append(error, submit);
  // The new sign-in's tables are asked for at once: the home otherwise
  // showed this host offline until the next refresh came round.
  const landed = async (): Promise<void> => {
    state.joinIntent = null;
    await refresh();
    renderHome();
    void refreshFeed();
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    const shared = {
      origin: probe.origin,
      username: userField.value.trim(),
      password: passField.value,
      joinCode: state.joinIntent?.code,
    };
    const call =
      mode === "login"
        ? window.odm.login(shared)
        : window.odm.register({
            ...shared,
            inviteCode: inviteField?.value.trim() ?? "",
            setupCode: setupField?.value.trim() ?? "",
            // The app mints the password for a room-code join and keeps it,
            // the way the device world's own profile works.
            generated: byRoomCode,
          });
    void call.then(async (result) => {
      submit.disabled = false;
      if (result.ok) await landed();
      else error.textContent = result.error;
    });
  });
  // Discord first when the server offers it: one tap, no password to
  // remember, and a brand-new account is created on the way if signups are
  // open. The password form stays underneath for everyone else.
  const leading: (HTMLElement | null)[] = [];
  if (probe.discord && !claiming) {
    const discord = button(
      "secondary",
      "Sign in with Discord",
      (btn) => {
        btn.disabled = true;
        error.textContent = "";
        void window.odm
          .discordLogin({ origin: probe.origin, joinCode: state.joinIntent?.code })
          .then(async (result) => {
            btn.disabled = false;
            if (result.ok) await landed();
            else error.textContent = result.error;
          });
      },
      "discord",
    );
    discord.classList.add("block");
    leading.push(discord, el("div", "divider", "or with a password"));
  }
  const notes: HTMLElement[] = [];
  if (probe.signupMode === "closed" && mode === "login") {
    notes.push(el("p", "hint center", "This server is not accepting new accounts."));
  }
  const subtitle = `${probe.origin}${probe.version ? `, server ${probe.version}` : ""}`;
  show(
    "narrow",
    backLink("Back", () => renderAdd(probe.origin)),
    intro(name, subtitle),
    joinBanner(),
    formCard(...leading, claiming ? null : authTabs(probe, mode, presetUsername), form, ...notes),
  );
  (presetUsername ? passField : userField).focus();
}
