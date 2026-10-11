import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_SHAPE,
  insecureRemoteOrigin,
  joinLinkFromArgv,
  normalizeOrigin,
  originCandidates,
  parseAnyLink,
  parseJoinLink,
  codeCandidates,
  parseLinkOrAddress,
  parseRoomCode,
  parseServerAddress,
  hostCodeFromOrigin,
  roomCode,
  trustedTunnelOrigin,
} from "../dist/shared/deep-link.js";

test("normalizeOrigin keeps clean http(s) origins", () => {
  assert.equal(normalizeOrigin("https://play.example.com/lobby?x=1"), "https://play.example.com");
  assert.equal(normalizeOrigin("http://192.168.1.50:3005"), "http://192.168.1.50:3005");
});

test("normalizeOrigin rejects junk", () => {
  assert.equal(normalizeOrigin("ftp://example.com"), null);
  assert.equal(normalizeOrigin("javascript:alert(1)"), null);
  assert.equal(normalizeOrigin("https://good.com@evil.com"), null);
  assert.equal(normalizeOrigin(""), null);
  assert.equal(normalizeOrigin("x".repeat(301)), null);
});

test("originCandidates tries https then http for bare hosts", () => {
  assert.deepEqual(originCandidates("play.example.com"), [
    "https://play.example.com",
    "http://play.example.com",
  ]);
  assert.deepEqual(originCandidates("https://play.example.com"), ["https://play.example.com"]);
  assert.deepEqual(originCandidates("ftp://x"), []);
});

test("parseJoinLink accepts the /j Worker shape", () => {
  const link = parseJoinLink("odm://join?s=https%3A%2F%2Fplay.example.com&c=abcd2345");
  assert.deepEqual(link, { origin: "https://play.example.com", code: "ABCD2345" });
});

test("parseJoinLink rejects bad codes, schemes and actions", () => {
  assert.equal(parseJoinLink("odm://join?s=https://x.com&c=ab"), null);
  assert.equal(parseJoinLink("odm://join?s=https://x.com&c=ABCD0IL1"), null);
  assert.equal(parseJoinLink("odm://steal?s=https://x.com&c=ABCD2345"), null);
  assert.equal(parseJoinLink("https://join?s=https://x.com&c=ABCD2345"), null);
  assert.equal(parseJoinLink("odm://join?s=ftp://x.com&c=ABCD2345"), null);
});

test("parseAnyLink accepts both the odm and https invite shapes", () => {
  const expected = { origin: "https://play.example.com", code: "ABCD2345" };
  assert.deepEqual(
    parseAnyLink("odm://join?s=https%3A%2F%2Fplay.example.com&c=ABCD2345"),
    expected,
  );
  assert.deepEqual(
    parseAnyLink("https://opendungeonmaster.com/j?s=https%3A%2F%2Fplay.example.com&c=abcd2345"),
    expected,
  );
  assert.deepEqual(
    parseAnyLink("https://opendungeonmaster.com/j/abcd2345?s=https%3A%2F%2Fplay.example.com"),
    expected,
  );
  assert.deepEqual(
    parseAnyLink("  https://opendungeonmaster.com/j?s=https%3A%2F%2Fplay.example.com&c=ABCD2345 "),
    expected,
  );
});

test("parseAnyLink rejects lookalike hosts, plain http and bad codes", () => {
  assert.equal(parseAnyLink("https://evil.com/j?s=https%3A%2F%2Fx.com&c=ABCD2345"), null);
  assert.equal(parseAnyLink("http://opendungeonmaster.com/j?s=https%3A%2F%2Fx.com&c=ABCD2345"), null);
  assert.equal(parseAnyLink("https://opendungeonmaster.com/other?s=https%3A%2F%2Fx.com&c=ABCD2345"), null);
  assert.equal(parseAnyLink("https://opendungeonmaster.com/j?s=https%3A%2F%2Fx.com&c=ABCD01"), null);
  assert.equal(parseAnyLink("https://opendungeonmaster.com/j?c=ABCD2345"), null);
  assert.equal(parseAnyLink("play.example.com"), null);
});

test("joinLinkFromArgv finds the deep link among flags", () => {
  const argv = ["electron", "--flag", "odm://join?s=https://x.com&c=ABCD2345"];
  assert.deepEqual(joinLinkFromArgv(argv), { origin: "https://x.com", code: "ABCD2345" });
  assert.equal(joinLinkFromArgv(["electron", "."]), null);
});

test("code shape matches the server invite alphabet", () => {
  assert.ok(CODE_SHAPE.test("ABCDEF"));
  assert.ok(!CODE_SHAPE.test("ABC"));
  assert.ok(!CODE_SHAPE.test("ABCDEFGHJKLMN"));
  assert.ok(!CODE_SHAPE.test("ABCO23"));
});

test("parseAnyLink accepts a server's own readable /join/CODE link", () => {
  assert.deepEqual(parseAnyLink("https://play.example.com/join/abcd2345"), {
    origin: "https://play.example.com",
    code: "ABCD2345",
  });
  assert.deepEqual(parseAnyLink("http://192.168.1.50:3005/join/ABCD2345/"), {
    origin: "http://192.168.1.50:3005",
    code: "ABCD2345",
  });
  assert.equal(parseAnyLink("https://play.example.com/join/ab"), null);
  assert.equal(parseAnyLink("https://play.example.com/join/ABCD2345/extra"), null);
  assert.equal(parseAnyLink("https://play.example.com/lobby"), null);
});

test("parseServerAddress takes a bare origin and nothing more", () => {
  assert.equal(parseServerAddress("http://192.168.1.50:3005"), "http://192.168.1.50:3005");
  assert.equal(parseServerAddress("https://play.example.com/"), "https://play.example.com");
  assert.equal(parseServerAddress("  https://play.example.com  "), "https://play.example.com");
  // A join link is an invite, not a server address; callers try invites first
  // and this must not swallow one that failed to parse as an invite.
  assert.equal(parseServerAddress("https://play.example.com/join/ABCD2345"), null);
  assert.equal(parseServerAddress("https://play.example.com/?x=1"), null);
  assert.equal(parseServerAddress("play.example.com"), null);
  assert.equal(parseServerAddress("ftp://play.example.com"), null);
  assert.equal(parseServerAddress("https://good.com@evil.com"), null);
});

test("parseLinkOrAddress reads invites first, then a bare address as a codeless join", () => {
  assert.deepEqual(parseLinkOrAddress("https://play.example.com/join/abcd2345"), {
    origin: "https://play.example.com",
    code: "ABCD2345",
  });
  assert.deepEqual(parseLinkOrAddress("odm://join?s=https%3A%2F%2Fplay.example.com&c=ABCD2345"), {
    origin: "https://play.example.com",
    code: "ABCD2345",
  });
  // The server's own corner QR: an address and nothing else.
  assert.deepEqual(parseLinkOrAddress("https://play-abcd1234.opendungeonmaster.com/"), {
    origin: "https://play-abcd1234.opendungeonmaster.com",
    code: "",
  });
  assert.deepEqual(parseLinkOrAddress("http://192.168.1.50:3005"), {
    origin: "http://192.168.1.50:3005",
    code: "",
  });
  // A malformed invite is neither: it must not silently become an address.
  assert.equal(parseLinkOrAddress("https://play.example.com/join/ab"), null);
  assert.equal(parseLinkOrAddress("play.example.com"), null);
  assert.equal(parseLinkOrAddress(""), null);
});

test("parseRoomCode expands a room code into the host it names", () => {
  assert.deepEqual(parseRoomCode("ABCD2345-EFGH6789"), {
    origin: "https://play-abcd2345.opendungeonmaster.com",
    code: "EFGH6789",
  });
  // The host half alone is a join with no table chosen.
  assert.deepEqual(parseRoomCode("ABCD2345"), {
    origin: "https://play-abcd2345.opendungeonmaster.com",
    code: "",
  });
});

test("parseRoomCode forgives how people actually type a code", () => {
  const expected = {
    origin: "https://play-abcd2345.opendungeonmaster.com",
    code: "EFGH6789",
  };
  assert.deepEqual(parseRoomCode("abcd2345-efgh6789"), expected);
  assert.deepEqual(parseRoomCode("  ABCD2345 - EFGH6789  "), expected);
  assert.deepEqual(parseRoomCode("ABCD2345EFGH6789"), expected);
  // A phone keyboard's en dash, and the play- the address wears in front.
  assert.deepEqual(parseRoomCode("ABCD2345\u2013EFGH6789"), expected);
  assert.deepEqual(parseRoomCode("play-ABCD2345-EFGH6789"), expected);
});

test("parseRoomCode rejects what cannot be a host code", () => {
  // L is in the campaign alphabet but not the broker's, so a table code
  // holding one can never be read as a host.
  assert.equal(parseRoomCode("ABCL2345"), null);
  assert.equal(parseRoomCode("ABCD234"), null);
  assert.equal(parseRoomCode("ABCD2345-EF"), null);
  assert.equal(parseRoomCode("ABCD2345-EFGH6789-IJKL"), null);
  assert.equal(parseRoomCode("ABCD2345-EFGH678O"), null);
  assert.equal(parseRoomCode("play.example.com"), null);
  assert.equal(parseRoomCode(""), null);
});

test("parseLinkOrAddress takes a room code alongside links and addresses", () => {
  assert.deepEqual(parseLinkOrAddress("ABCD2345-EFGH6789"), {
    origin: "https://play-abcd2345.opendungeonmaster.com",
    code: "EFGH6789",
  });
  // An invite link still wins: it names its own server, code and all.
  assert.deepEqual(parseLinkOrAddress("https://play.example.com/join/WXYZ2345"), {
    origin: "https://play.example.com",
    code: "WXYZ2345",
  });
});

test("hostCodeFromOrigin reads a code back out of a broker address", () => {
  assert.equal(hostCodeFromOrigin("https://play-abcd2345.opendungeonmaster.com"), "ABCD2345");
  assert.equal(hostCodeFromOrigin("https://play-abcd2345.opendungeonmaster.com/"), "ABCD2345");
  // Quick tunnels, LAN addresses and other domains have no code to show.
  assert.equal(hostCodeFromOrigin("https://abc.trycloudflare.com"), "");
  assert.equal(hostCodeFromOrigin("http://192.168.1.50:3005"), "");
  assert.equal(hostCodeFromOrigin(""), "");
});

test("roomCode joins the halves, and round-trips through the parser", () => {
  assert.equal(roomCode("ABCD2345", "EFGH6789"), "ABCD2345-EFGH6789");
  // No table half yet, or a solo campaign: the host half stands alone.
  assert.equal(roomCode("ABCD2345", ""), "ABCD2345");
  assert.equal(roomCode("", "EFGH6789"), "");
  assert.deepEqual(parseRoomCode(roomCode("ABCD2345", "EFGH6789")), {
    origin: "https://play-abcd2345.opendungeonmaster.com",
    code: "EFGH6789",
  });
});

test("a bare code offers the registry lookup first, the host shape second", () => {
  // The two alphabets differ by one letter, so all but a thirty-first of
  // table codes also read as a host code. Choosing by shape sent real table
  // codes to a play-CODE address nobody answers at, which is why a code
  // never connected while the tunnel itself was fine.
  assert.deepEqual(codeCandidates("EFGH6789"), {
    table: "EFGH6789",
    hostOrigin: "https://play-efgh6789.opendungeonmaster.com",
  });
  // An L can only be a table code: the broker's alphabet leaves it out.
  assert.deepEqual(codeCandidates("klmn2345"), {
    table: "KLMN2345",
    hostOrigin: "",
  });
  // Neither: an address, a link, or junk.
  assert.deepEqual(codeCandidates("play.example.com"), { table: "", hostOrigin: "" });
  assert.deepEqual(codeCandidates(""), { table: "", hostOrigin: "" });
});

test("the join screen offers a password only where one can exist", async () => {
  const { joinFormShape } = await import("../dist/shared/join-form.js");
  // A world an app is hosting: a name and nothing else, and no dead-end
  // sign-in tab, because the password is one the app made up and kept.
  for (const signupMode of ["open", "invite", "closed"]) {
    for (const mode of ["login", "register"]) {
      assert.deepEqual(
        joinFormShape({ deviceWorld: true, signupMode, mode, hasRoomCode: false }),
        { password: false, accountInvite: false, tabs: false, submit: "Join the table" },
        `${signupMode}/${mode}`,
      );
    }
  }
  // A server someone runs keeps passwords and its own signup rule.
  assert.deepEqual(joinFormShape({ deviceWorld: false, signupMode: "open", mode: "register", hasRoomCode: false }), {
    password: true, accountInvite: false, tabs: true, submit: "Create account",
  });
  assert.deepEqual(joinFormShape({ deviceWorld: false, signupMode: "invite", mode: "register", hasRoomCode: false }), {
    password: true, accountInvite: true, tabs: true, submit: "Create account",
  });
  // Arriving with a room code vouches, so no account code is asked for.
  assert.deepEqual(joinFormShape({ deviceWorld: false, signupMode: "invite", mode: "register", hasRoomCode: true }), {
    password: true, accountInvite: false, tabs: true, submit: "Create account",
  });
  // Closed: no way to make an account at all.
  assert.equal(joinFormShape({ deviceWorld: false, signupMode: "closed", mode: "login", hasRoomCode: false }).tabs, false);
});

test("a typed code is cleaned before the registry is asked", () => {
  // A space or a dash inside a code used to fail the shape test and skip
  // the registry, so only the host-shape guess ran and a real table code
  // read as "not online".
  assert.equal(codeCandidates("ABCD 2345").table, "ABCD2345");
  assert.equal(codeCandidates("abcd-2345").table, "ABCD2345");
  assert.equal(codeCandidates("abcd–2345").table, "ABCD2345");
});

test("a saved seat follows only a tunnel hostname or a registry-confirmed address", () => {
  assert.equal(trustedTunnelOrigin("https://play-abcd2345.opendungeonmaster.com"), true);
  assert.equal(trustedTunnelOrigin("https://quiet-river-1234.trycloudflare.com"), true);
  assert.equal(trustedTunnelOrigin("https://evil.example"), false);
  assert.equal(trustedTunnelOrigin("http://play-abcd2345.opendungeonmaster.com"), false);
  assert.equal(trustedTunnelOrigin("https://play-abcd2345.opendungeonmaster.com.evil.example"), false);
});

// Audit S9: plain http is expected on this machine and the local network,
// and flagged for anything that crosses the open internet.
test("plain http is insecure only off this machine and off private networks", () => {
  for (const origin of [
    "http://127.0.0.1:3005",
    "http://localhost:3005",
    "http://192.168.1.50:3005",
    "http://10.0.0.7",
    "http://172.20.3.4:3005",
    "http://100.101.102.103:3005",
    "http://169.254.1.2",
    "http://gamebox:3005",
    "http://gamebox.local:3005",
    "http://box.home.arpa",
    "http://[::1]:3005",
    "http://[fd12:3456::1]:3005",
    "https://play.example.com",
    "https://203.0.113.5",
  ]) {
    assert.equal(insecureRemoteOrigin(origin), false, origin);
  }
  for (const origin of ["http://play.example.com", "http://203.0.113.5:3005", "http://172.32.0.1", "http://[2001:db8::1]:3005"]) {
    assert.equal(insecureRemoteOrigin(origin), true, origin);
  }
  assert.equal(insecureRemoteOrigin("not a url"), false);
});
