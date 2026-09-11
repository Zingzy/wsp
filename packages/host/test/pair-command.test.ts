// SPDX-License-Identifier: AGPL-3.0-only
// The two commands that hand out access and take it back, and the words they
// print. Both dial the running host over loopback, so a fake client is the
// whole of what they need, and both refuse a line aimed at a host on another
// computer, which is why every call here names the home and the environment
// the run reads rather than leaving them to this process's.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advertisedUrl, deviceLines, hostSideOnlyLine, pairLines, pairOnLoopbackLine, reachAddresses, devicesCommand, pairCommand } from "../src/pairing.js";
import type { CliIO } from "../src/cli.js";
import { dialAddress } from "../src/host-lock.js";
import { setDefaultHost, writeHost, type HostRecord } from "../src/hosts.js";
import type { HostClient } from "../src/verbs.js";

type Interfaces = Parameters<typeof reachAddresses>[1];

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const io = (log: string[], err: string[]): CliIO => ({ log: l => log.push(l), error: l => err.push(l), ask: noPrompt, askSecret: noPrompt });

/** A host that answers the two ops and records what it was asked, and counts the closes so a command cannot leave a
 * socket behind. */
function fakeHost(answers: Record<string, Record<string, unknown>>): { client: HostClient; asked: { op: string; params?: Record<string, unknown> }[]; closes: () => number } {
  const asked: { op: string; params?: Record<string, unknown> }[] = [];
  let closed = 0;
  const client: HostClient = {
    request: async (op, params) => {
      asked.push({ op, ...(params !== undefined ? { params } : {}) });
      const answer = answers[op];
      if (answer === undefined) throw new Error(`no fake answer for ${op}`);
      return answer as never;
    },
    events: () => Promise.resolve(),
    onFrame: () => () => {},
    closed: new Promise<void>(() => {}),
    closeWords: () => "closed",
    close: () => {
      closed++;
    },
    terminate: () => {
      closed++;
    },
  };
  return { client, asked, closes: () => closed };
}

const deps = (client: HostClient, now = Date.parse("2026-09-11T10:00:00.000Z")) => ({ dial: () => Promise.resolve(client), now: () => now });

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A home with no hosts folder in it, which is a computer that paired with nobody: named on every call, since a
 * call that named none would read the person's own ~/.wsp and answer out of whatever they have connected. */
const NO_HOSTS = "/nowhere/wsp-home";
const here = (home = NO_HOSTS): { statePath: string; home: string; env: Record<string, string> } => ({ statePath: "/s/state.json", home, env: {} });

/** A home holding one host under the name box, and the mark that aims every line at it. */
function homeWithBox(marked: boolean): string {
  const home = mkdtempSync(join(tmpdir(), "wsp-pair-home-"));
  dirs.push(home);
  const record: HostRecord = { url: "http://box.local:4400", deviceId: "d_box", deviceToken: "tok-box", pairedAt: "2026-09-11T10:00:00.000Z" };
  writeHost(home, "box", record);
  if (marked) setDefaultHost(home, "box");
  return home;
}

describe("wsp pair", () => {
  it("prints the code, when it expires and the address to open, and closes its socket", async () => {
    const now = Date.parse("2026-09-11T10:00:00.000Z");
    const host = fakeHost({ "pair.issue": { code: "7K3MQP2X", expiresAt: now + 600_000 } });
    const log: string[] = [];
    expect(await pairCommand(io(log, []), here(), [], deps(host.client, now))).toBe(0);
    expect(host.asked).toEqual([{ op: "pair.issue" }]);
    expect(log[0]).toBe("code        7K3MQP2X");
    expect(log[1]).toContain("in 10m");
    expect(log[1]).toContain("2026-09-11T10:10:00.000Z");
    expect(host.closes()).toBe(1);
  });

  it("refuses a positional argument rather than taking it for something", async () => {
    const host = fakeHost({});
    await expect(pairCommand(io([], []), here(), ["laptop"], deps(host.client))).rejects.toThrow(/no positional/);
  });
});

describe("wsp devices", () => {
  it("lists what took a code, with a row per device and never a token", async () => {
    const host = fakeHost({
      "devices.list": {
        devices: [
          { id: "d_1a2b3c4d5e6f7a8b", name: "maya's laptop", createdAt: "2026-09-11T10:00:00.000Z", lastSeenAt: "2026-09-11T10:05:00.000Z" },
          { id: "d_5e6f7a8b1a2b3c4d", name: "a phone", createdAt: "2026-09-11T11:00:00.000Z", lastSeenAt: "2026-09-11T11:00:00.000Z" },
        ],
      },
    });
    const log: string[] = [];
    expect(await devicesCommand(io(log, []), here(), [], deps(host.client))).toBe(0);
    expect(log[0]).toContain("DEVICE");
    expect(log[1]).toContain("maya's laptop");
    expect(log[2]).toContain("a phone");
    expect(host.closes()).toBe(1);
  });

  it("says so plainly when nobody is paired", async () => {
    const host = fakeHost({ "devices.list": { devices: [] } });
    const log: string[] = [];
    await devicesCommand(io(log, []), here(), [], deps(host.client));
    expect(log).toEqual(["No computer is paired with this host. Run wsp pair for a code."]);
  });

  it("revokes by id, and exits non-zero on an id nothing is paired under", async () => {
    const gone = fakeHost({ "devices.revoke": { revoked: true } });
    const log: string[] = [];
    expect(await devicesCommand(io(log, []), here(), ["revoke", "d_1a2b3c4d"], deps(gone.client))).toBe(0);
    expect(gone.asked).toEqual([{ op: "devices.revoke", params: { deviceId: "d_1a2b3c4d" } }]);
    expect(log[0]).toContain("d_1a2b3c4d revoked");

    const none = fakeHost({ "devices.revoke": { revoked: false } });
    const err: string[] = [];
    expect(await devicesCommand(io([], err), here(), ["revoke", "d_nope"], deps(none.client))).toBe(1);
    expect(err[0]).toContain("no device d_nope");
  });

  it("refuses a word it does not know and a revoke with no id", async () => {
    const host = fakeHost({});
    for (const args of [["forget", "d_1"], ["revoke"], ["revoke", "d_1", "d_2"]]) {
      await expect(devicesCommand(io([], []), here(), args, deps(host.client))).rejects.toThrow(/wsp devices/);
    }
  });

  it("reads where the line is aimed out of the environment the run was given, not this process's", async () => {
    // The home holding the host and the mark aiming at it are named by this environment alone, so a command that
    // read process.env instead would find no host at all and hand the code out over the wire.
    const host = fakeHost({ "devices.list": { devices: [] } });
    const home = homeWithBox(true);
    await expect(devicesCommand(io([], []), { statePath: "/s/state.json", env: { WSP_HOME: home } }, [], deps(host.client))).rejects.toThrow(hostSideOnlyLine("devices", "box"));
    expect(host.asked).toEqual([]);
    expect(host.closes()).toBe(0);
  });
});

describe("a host side command aimed at a host on another computer", () => {
  it("refuses --host, and the default alias, with the one sentence that says where to run it", async () => {
    const host = fakeHost({ "devices.list": { devices: [] }, "pair.issue": { code: "7K3MQP2X", expiresAt: 0 } });
    const home = homeWithBox(false);
    // A flag naming a host this computer paired with, with nothing marked as the default.
    await expect(devicesCommand(io([], []), { ...here(home), host: "box" }, [], deps(host.client))).rejects.toThrow(hostSideOnlyLine("devices", "box"));
    await expect(pairCommand(io([], []), { ...here(home), host: "box" }, [], deps(host.client))).rejects.toThrow(hostSideOnlyLine("pair", "box"));
    // The default alias, with no flag and nothing in the environment: the aim no host on this computer wins back,
    // which is the road that reached the remote host by accident.
    const marked = homeWithBox(true);
    await expect(devicesCommand(io([], []), here(marked), [], deps(host.client))).rejects.toThrow(hostSideOnlyLine("devices", "box"));
    await expect(pairCommand(io([], []), here(marked), [], deps(host.client))).rejects.toThrow(hostSideOnlyLine("pair", "box"));
    // Nothing was dialled: a code handed out over a device token is a code the host would refuse anyway, and the
    // refusal has to read as a line the person can act on rather than as the host's own.
    expect(host.asked).toEqual([]);
    expect(host.closes()).toBe(0);
  });

  it("says which command it is and where the line was aimed, and where to run it", () => {
    expect(hostSideOnlyLine("pair", "box")).toContain("wsp pair");
    expect(hostSideOnlyLine("pair", "box")).toContain("box");
    expect(hostSideOnlyLine("devices", "http://box.local:4400")).toContain("run it in a terminal over there");
  });
});

describe("the addresses a client may use", () => {
  const interfaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [
      { address: "192.168.1.20", family: "IPv4", internal: false },
      { address: "fe80::aede:48ff:fe00:1122", family: "IPv6", internal: false },
      { address: "2001:db8::5", family: "IPv6", internal: false },
    ],
    en1: [{ address: "169.254.10.2", family: "IPv4", internal: false }],
  } as unknown as Interfaces;

  it("expands the wildcard to the addresses of the family it covers, and leaves any other address alone", () => {
    // An IPv4 wildcard listens on no IPv6 address, so naming one would send a person at another computer to a
    // port nothing answers on; the IPv6 wildcard is dual stack and covers both.
    expect(reachAddresses("0.0.0.0", interfaces)).toEqual(["192.168.1.20"]);
    expect(reachAddresses("::", interfaces)).toEqual(["192.168.1.20", "2001:db8::5"]);
    expect(reachAddresses("100.64.0.3", interfaces)).toEqual(["100.64.0.3"]);
  });

  it("leaves out the addresses that reach only the link they sit on, which no browser opens", () => {
    expect(reachAddresses("::", interfaces)).not.toContain("fe80::aede:48ff:fe00:1122");
    expect(reachAddresses("0.0.0.0", interfaces)).not.toContain("169.254.10.2");
    const linkOnly = { en0: [{ address: "fe80::1", family: "IPv6", internal: false }] } as unknown as Interfaces;
    expect(reachAddresses("::", linkOnly)).toEqual(["127.0.0.1"]);
  });

  it("the address a machine dials this host at follows the bind, and is nothing on a host no machine can reach", () => {
    // A wildcard stands for the first address that leaves this computer, and a named one is itself.
    expect(advertisedUrl("0.0.0.0", 4700, undefined, interfaces)).toBe("http://192.168.1.20:4700");
    expect(advertisedUrl("100.64.0.3", 4700, undefined, interfaces)).toBe("http://100.64.0.3:4700");
    // Loopback reaches no machine, so no turn is handed a token it could not use; --advertise is the way past that.
    expect(advertisedUrl("127.0.0.1", 4700, undefined, interfaces)).toBeUndefined();
    const onlyLoopback = { lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] } as unknown as Interfaces;
    expect(advertisedUrl("0.0.0.0", 4700, undefined, onlyLoopback)).toBeUndefined();
    // What the person named wins whatever the bind is, and a trailing slash is not part of an address.
    expect(advertisedUrl("127.0.0.1", 4700, "https://box.example/wsp/", interfaces)).toBe("https://box.example/wsp");
    expect(advertisedUrl("0.0.0.0", 4700, "  ", interfaces)).toBe("http://192.168.1.20:4700");
    // An IPv6 address is bracketed, so the url is one a machine's client parses.
    expect(advertisedUrl("2001:db8::5", 4700, undefined, interfaces)).toBe("http://[2001:db8::5]:4700");
  });

  it("brackets an IPv6 address in the line it prints, so the URL is one a browser takes", () => {
    expect(pairLines("7K3MQP2X", 1_000, 0, ["2001:db8::5"], 4400)).toContain("open        http://[2001:db8::5]:4400");
  });

  it("falls back to loopback when this computer answers on nothing else, rather than printing no address at all", () => {
    const onlyLoopback = { lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] } as unknown as Interfaces;
    expect(reachAddresses("0.0.0.0", onlyLoopback)).toEqual(["127.0.0.1"]);
  });

  it("dials the address the lock records, and turns only the wildcard into loopback", () => {
    expect(dialAddress({})).toBe("127.0.0.1");
    expect(dialAddress({ address: "0.0.0.0" })).toBe("127.0.0.1");
    expect(dialAddress({ address: "::" })).toBe("127.0.0.1");
    // Every other spelling is passed through as given: a host on ::1 or on a second loopback alias answers there
    // and nowhere else, so rewriting it to 127.0.0.1 would dial a port nothing is listening on.
    expect(dialAddress({ address: "127.0.0.1" })).toBe("127.0.0.1");
    expect(dialAddress({ address: "::1" })).toBe("::1");
    expect(dialAddress({ address: "127.0.0.2" })).toBe("127.0.0.2");
    expect(dialAddress({ address: "localhost" })).toBe("localhost");
    expect(dialAddress({ address: "100.64.0.3" })).toBe("100.64.0.3");
    expect(dialAddress({ address: "2001:db8::5" })).toBe("2001:db8::5");
  });
});

describe("the words", () => {
  it("says a code opens nothing on a host that binds this computer alone", () => {
    expect(pairOnLoopbackLine("127.0.0.1")).toContain("--listen");
  });

  it("pads the device table's columns and never carries a token", () => {
    const lines = deviceLines([{ id: "d_1", name: "one", createdAt: "2026-09-11T10:00:00.000Z", lastSeenAt: "2026-09-11T10:00:00.000Z" }]);
    expect(lines[0]!.startsWith("DEVICE")).toBe(true);
    expect(lines.join("\n")).not.toContain("token");
  });

  it("pairLines names the port each address is reached on", () => {
    const lines = pairLines("7K3MQP2X", 1_000, 0, ["192.168.1.20"], 4400);
    expect(lines).toContain("open        http://192.168.1.20:4400");
  });
});
