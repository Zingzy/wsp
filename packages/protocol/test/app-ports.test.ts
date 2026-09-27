// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PORT,
  LOOPBACK,
  PORT_TAKEN_REFUSAL,
  WS_PATH,
  authority,
  isLoopback,
  isUrl,
  isWildcard,
  joinAddressOf,
  listenBeyondLoopbackLine,
  portHolderWords,
  portTakenLine,
  portsAsked,
  portsPickedLine,
  servedHostname,
  stateFileLine,
} from "../src/index.js";
import { ROOT, sourceFiles } from "./source-files.js";

describe("an address where an alias could go", () => {
  it("is a word with an http, https, ws or wss scheme, and nothing else", () => {
    for (const word of ["http://box:4400", "https://box.example/wsp", "ws://box:4410", "WSS://box"]) expect(isUrl(word)).toBe(true);
    for (const word of ["box", "box:4400", "127.0.0.1:14400", "ftp://box", "http:/box", ""]) expect(isUrl(word)).toBe(false);
  });

  it("the name of the computer comes back only for an address a host is served at", () => {
    expect(servedHostname("http://box:4400")).toBe("box");
    expect(servedHostname("https://box.example/wsp")).toBe("box.example");
    expect(servedHostname("HTTP://Box.Example")).toBe("box.example");
    expect(servedHostname("http://[2001:db8::5]:4400")).toBe("[2001:db8::5]");
    // A ws or wss address is where a socket is dialled, not where a host is served, and every spelling that would
    // throw out of the URL parser reads as no address rather than as a stack.
    for (const word of ["ws://box:4410", "WSS://box", "http://", "https://", "box", "ftp://box", ""]) expect(servedHostname(word)).toBeUndefined();
  });
});

describe("the port the app is served on", () => {
  it("names 4400 as the port nobody named", () => {
    expect(DEFAULT_PORT).toBe(4400);
    expect(portsAsked({})).toEqual({ port: 4400, named: false, address: LOOPBACK });
  });

  it("--port names the port, and says a person named it", () => {
    expect(portsAsked({ port: "4401" })).toEqual({ port: 4401, named: true, address: LOOPBACK });
    expect(portsAsked({ port: "5000" })).toEqual({ port: 5000, named: true, address: LOOPBACK });
  });

  it("keeps port 0 as it is, since 0 asks for any free port", () => {
    expect(portsAsked({ port: "0" })).toEqual({ port: 0, named: true, address: LOOPBACK });
  });
});

describe("the address the port is bound on", () => {
  it("binds this computer alone unless --listen names another, and an empty word is no word", () => {
    expect(portsAsked({}).address).toBe("127.0.0.1");
    expect(portsAsked({ listen: "" }).address).toBe(LOOPBACK);
    expect(portsAsked({ listen: "0.0.0.0" }).address).toBe("0.0.0.0");
    expect(portsAsked({ listen: "100.64.0.3" })).toEqual({ port: 4400, named: false, address: "100.64.0.3" });
  });

  it("reads 127.x, ::1 and localhost as this computer, and the wildcard, a private address and a hostname as beyond it", () => {
    for (const at of [LOOPBACK, "127.0.0.2", "127.1.2.3", "::1", "[::1]", "localhost"]) expect(isLoopback(at), at).toBe(true);
    for (const at of ["0.0.0.0", "::", "192.168.1.20", "100.64.0.3", "box.example.com", "1270.0.0.1", "127.evil.example", "127.0.0.1.evil.example"]) expect(isLoopback(at), at).toBe(false);
  });

  it("says once, in one line with no em dash, that the page is reachable and pairing is the gate", () => {
    const line = listenBeyondLoopbackLine("0.0.0.0");
    expect(line).toContain("0.0.0.0");
    expect(line).toContain("wsp host pair");
    expect(line).not.toContain("\u2014");
  });

  it("serves the runtime on one path, so a forwarded port carries the page and the protocol", () => {
    expect(WS_PATH).toBe("/ws");
  });

  it("names the wildcard, which covers loopback, apart from an address that answers only on itself", () => {
    for (const at of ["0.0.0.0", "::"]) expect(isWildcard(at), at).toBe(true);
    for (const at of [LOOPBACK, "::1", "100.64.0.3", "0.0.0.1"]) expect(isWildcard(at), at).toBe(false);
  });

  it("brackets an IPv6 literal in a URL authority and leaves everything else alone", () => {
    expect(authority("127.0.0.1", 4400)).toBe("127.0.0.1:4400");
    expect(authority("box.example.com", 4400)).toBe("box.example.com:4400");
    expect(authority("2001:db8::5", 4410)).toBe("[2001:db8::5]:4410");
    expect(authority("[2001:db8::5]", 4410)).toBe("[2001:db8::5]:4410");
  });
});

describe("the address a person types to join a wsp", () => {
  it("takes the authority the other computer shows as an http address, and an address that already carries one as it is", () => {
    expect(joinAddressOf("192.168.1.20:7788")).toBe("http://192.168.1.20:7788");
    expect(joinAddressOf(" 192.168.1.20:7788 ")).toBe("http://192.168.1.20:7788");
    expect(joinAddressOf("old-macbook.local:4400")).toBe("http://old-macbook.local:4400");
    expect(joinAddressOf("[::1]:4400")).toBe("http://[::1]:4400");
    expect(joinAddressOf("http://192.168.1.20:7788")).toBe("http://192.168.1.20:7788");
    expect(joinAddressOf("https://p-x.singhi.me")).toBe("https://p-x.singhi.me");
  });

  it("is nothing for a word that names no wsp: a name with no port, a socket address, an empty field", () => {
    for (const word of ["", "   ", "box", "192.168.1.20", "ws://192.168.1.20:7788", "wss://box", "http://", "192.168.1.20:", "not an address"]) {
      expect(joinAddressOf(word)).toBeUndefined();
    }
  });
});

describe("who holds a port, and the lines about it", () => {
  it("names a wsp host by the state file it serves, a process by its command and pid, and nothing else as another process", () => {
    expect(portHolderWords({ statePath: "/Users/z/.wsp/state.json" })).toBe("the host serving /Users/z/.wsp/state.json");
    expect(portHolderWords({ command: "node", pid: 62569 })).toBe("node (pid 62569)");
    expect(portHolderWords(undefined)).toBe("another process");
  });

  it("the taken line names the port and its holder", () => {
    expect(portTakenLine(4410, { command: "node", pid: 62569 })).toBe("Port 4410 is in use on this computer by node (pid 62569).");
    expect(portTakenLine(4400, undefined)).toBe("Port 4400 is in use on this computer by another process.");
  });

  it("the picked line names the port it serves on and the port it stepped over with its holder", () => {
    expect(portsPickedLine({ port: 4401 }, 4400, { statePath: "/Users/z/.wsp/state.json" })).toBe(
      "Serving on 4401; 4400 is held by the host serving /Users/z/.wsp/state.json.",
    );
  });

  it("the refusal offers stopping the holder or naming a free port with --port", () => {
    expect(PORT_TAKEN_REFUSAL).toBe("Nothing was booted. Stop that process, or name a free port with --port.");
    expect(PORT_TAKEN_REFUSAL).not.toContain("—");
  });

  it("the state file line names the file and the flag that starts a fresh setup", () => {
    expect(stateFileLine("/Users/z/.wsp/state.json")).toBe("Setting up /Users/z/.wsp/state.json; --state <path> starts a fresh setup instead.");
  });
});

describe("one home for the default port and for the loopback address", () => {
  const HOME = join("packages", "protocol", "src", "app-ports.ts");
  const HOST = join("packages", "host", "src");

  it("no other source file spells out the default port: the app and the desktop read it from here", () => {
    const copies = sourceFiles().filter(rel => rel !== HOME && /\b4400\b/.test(readFileSync(join(ROOT, rel), "utf8")));
    expect(copies).toEqual([]);
  });

  it("no source file of the host spells the loopback address: every line about where the host is reads it from here", () => {
    const copies = sourceFiles().filter(rel => rel.startsWith(HOST) && readFileSync(join(ROOT, rel), "utf8").includes(LOOPBACK));
    expect(copies).toEqual([]);
  });
});
