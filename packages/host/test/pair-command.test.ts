// SPDX-License-Identifier: AGPL-3.0-only
// The two commands that hand out access and take it back, and the words they
// print. Both dial the running host over loopback, so a fake client is the
// whole of what they need.
import { describe, expect, it } from "vitest";
import { deviceLines, pairLines, pairOnLoopbackLine, reachAddresses, devicesCommand, pairCommand } from "../src/pairing.js";
import type { CliIO } from "../src/cli.js";
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
  };
  return { client, asked, closes: () => closed };
}

const deps = (client: HostClient, now = Date.parse("2026-09-11T10:00:00.000Z")) => ({ dial: () => Promise.resolve(client), now: () => now });

describe("wsp pair", () => {
  it("prints the code, when it expires and the address to open, and closes its socket", async () => {
    const now = Date.parse("2026-09-11T10:00:00.000Z");
    const host = fakeHost({ "pair.issue": { code: "7K3MQP2X", expiresAt: now + 600_000 } });
    const log: string[] = [];
    expect(await pairCommand(io(log, []), { statePath: "/s/state.json" }, [], deps(host.client, now))).toBe(0);
    expect(host.asked).toEqual([{ op: "pair.issue" }]);
    expect(log[0]).toBe("code        7K3MQP2X");
    expect(log[1]).toContain("in 10m");
    expect(log[1]).toContain("2026-09-11T10:10:00.000Z");
    expect(host.closes()).toBe(1);
  });

  it("refuses a positional argument rather than taking it for something", async () => {
    const host = fakeHost({});
    await expect(pairCommand(io([], []), { statePath: "/s/state.json" }, ["laptop"], deps(host.client))).rejects.toThrow(/no positional/);
  });
});

describe("wsp devices", () => {
  it("lists what took a code, with a row per device and never a token", async () => {
    const host = fakeHost({
      "devices.list": {
        devices: [
          { id: "d_1a2b3c4d", name: "maya's laptop", createdAt: "2026-09-11T10:00:00.000Z", lastSeenAt: "2026-09-11T10:05:00.000Z" },
          { id: "d_5e6f7a8b", name: "a phone", createdAt: "2026-09-11T11:00:00.000Z" },
        ],
      },
    });
    const log: string[] = [];
    expect(await devicesCommand(io(log, []), { statePath: "/s/state.json" }, [], deps(host.client))).toBe(0);
    expect(log[0]).toContain("DEVICE");
    expect(log[1]).toContain("maya's laptop");
    expect(log[2]).toContain("never");
    expect(host.closes()).toBe(1);
  });

  it("says so plainly when nobody is paired", async () => {
    const host = fakeHost({ "devices.list": { devices: [] } });
    const log: string[] = [];
    await devicesCommand(io(log, []), { statePath: "/s/state.json" }, [], deps(host.client));
    expect(log).toEqual(["No computer is paired with this host. Run wsp pair for a code."]);
  });

  it("revokes by id, and exits non-zero on an id nothing is paired under", async () => {
    const gone = fakeHost({ "devices.revoke": { revoked: true } });
    const log: string[] = [];
    expect(await devicesCommand(io(log, []), { statePath: "/s/state.json" }, ["revoke", "d_1a2b3c4d"], deps(gone.client))).toBe(0);
    expect(gone.asked).toEqual([{ op: "devices.revoke", params: { deviceId: "d_1a2b3c4d" } }]);
    expect(log[0]).toContain("d_1a2b3c4d revoked");

    const none = fakeHost({ "devices.revoke": { revoked: false } });
    const err: string[] = [];
    expect(await devicesCommand(io([], err), { statePath: "/s/state.json" }, ["revoke", "d_nope"], deps(none.client))).toBe(1);
    expect(err[0]).toContain("no device d_nope");
  });

  it("refuses a word it does not know and a revoke with no id", async () => {
    const host = fakeHost({});
    for (const args of [["forget", "d_1"], ["revoke"], ["revoke", "d_1", "d_2"]]) {
      await expect(devicesCommand(io([], []), { statePath: "/s/state.json" }, args, deps(host.client))).rejects.toThrow(/wsp devices/);
    }
  });
});

describe("the addresses a client may use", () => {
  it("expands the wildcard to every address this computer answers on, and leaves any other address alone", () => {
    const interfaces = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [
        { address: "192.168.1.20", family: "IPv4", internal: false },
        { address: "fe80::1", family: "IPv6", internal: false },
      ],
    } as unknown as Interfaces;
    expect(reachAddresses("0.0.0.0", interfaces)).toEqual(["192.168.1.20", "[fe80::1]"]);
    expect(reachAddresses("::", interfaces)).toEqual(["192.168.1.20", "[fe80::1]"]);
    expect(reachAddresses("100.64.0.3", interfaces)).toEqual(["100.64.0.3"]);
  });

  it("falls back to loopback when this computer answers on nothing else, rather than printing no address at all", () => {
    const onlyLoopback = { lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] } as unknown as Interfaces;
    expect(reachAddresses("0.0.0.0", onlyLoopback)).toEqual(["127.0.0.1"]);
  });
});

describe("the words", () => {
  it("says a code opens nothing on a host that binds this computer alone", () => {
    expect(pairOnLoopbackLine("127.0.0.1")).toContain("--listen");
  });

  it("pads the device table's columns and never carries a token", () => {
    const lines = deviceLines([{ id: "d_1", name: "one", createdAt: "2026-09-11T10:00:00.000Z" }]);
    expect(lines[0]!.startsWith("DEVICE")).toBe(true);
    expect(lines.join("\n")).not.toContain("token");
  });

  it("pairLines names the port each address is reached on", () => {
    const lines = pairLines("7K3MQP2X", 1_000, 0, ["192.168.1.20"], 4400);
    expect(lines).toContain("open        http://192.168.1.20:4400");
  });
});
