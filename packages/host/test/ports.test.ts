// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LOOPBACK } from "@wsp/runtime";
import { choosePorts, listenerOf, portHolder, portInUse } from "../src/ports.js";
import type { HostLock } from "../src/host-lock.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(resolve => s.close(() => resolve()));
});

/** A listener this test holds on a free loopback port, the way another host would. */
async function held(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no address");
  return addr.port;
}

describe("ports", () => {
  it("a held port is in use and a free one is not; port 0 is always free", async () => {
    const port = await held();
    expect(await portInUse(port)).toBe(true);
    expect(await portInUse(0)).toBe(false);
  });

  it("the holder is this process when lsof can see it", async () => {
    const port = await held();
    const who = await listenerOf(port);
    // A box without lsof names nobody; one with it names the process that holds the port.
    if (who !== undefined) expect(who.pid).toBe(process.pid);
    expect(await listenerOf(await freed())).toBeUndefined();
  });

  it("the holder of a port is the wsp host whose live lock names it, whichever of its two ports it is", async () => {
    const lock = (over: Partial<HostLock> = {}): HostLock => ({ pid: process.pid, port: 4400, wsPort: 4410, startedAt: new Date().toISOString(), ...over });
    const probes = { states: ["/Users/z/.wsp/state.json"], serving: () => lock(), listener: async () => ({ command: "node", pid: 4242 }) };
    expect(await portHolder(4400, probes)).toEqual({ statePath: "/Users/z/.wsp/state.json" });
    expect(await portHolder(4410, probes)).toEqual({ statePath: "/Users/z/.wsp/state.json" });
    // A port no lock here names falls back to the process this computer can see, and to nothing when it can see none.
    expect(await portHolder(5000, probes)).toEqual({ command: "node", pid: 4242 });
    expect(await portHolder(4400, { ...probes, serving: () => undefined })).toEqual({ command: "node", pid: 4242 });
    expect(await portHolder(4400, { ...probes, states: [], listener: async () => undefined })).toBeUndefined();
  });
});

describe("choosing the pair a run binds", () => {
  const asked = { port: 4400, wsPort: 4410, named: false };
  const busy = (...ports: number[]) => async (port: number) => ports.includes(port);
  const node = async () => ({ command: "node", pid: 62569 });

  it("takes the pair as asked when both ports are free", async () => {
    expect(await choosePorts(asked, { probe: busy(), listener: node })).toEqual({ ports: { port: 4400, wsPort: 4410 } });
  });

  it("steps a pair nobody named to the next pair with both free, naming the port it stepped over and its holder", async () => {
    expect(await choosePorts(asked, { probe: busy(4400), listener: node })).toEqual({
      ports: { port: 4401, wsPort: 4411 },
      moved: { port: 4400, holder: { command: "node", pid: 62569 } },
    });
    // The websocket port alone being taken moves the pair too: the pair is what a run binds, not either port.
    expect(await choosePorts(asked, { probe: busy(4410), listener: node })).toEqual({
      ports: { port: 4401, wsPort: 4411 },
      moved: { port: 4410, holder: { command: "node", pid: 62569 } },
    });
    // Two setups already up: the third steps over both of their pairs.
    expect(await choosePorts(asked, { probe: busy(4400, 4410, 4401, 4411), listener: node })).toMatchObject({ ports: { port: 4402, wsPort: 4412 } });
  });

  it("names the holder of a stepped-over port as the host serving its state file", async () => {
    const serving = (statePath: string): HostLock | undefined =>
      statePath === "/Users/z/.wsp/state.json" ? { pid: 62569, port: 4400, wsPort: 4410, startedAt: new Date().toISOString() } : undefined;
    expect(await choosePorts(asked, { probe: busy(4400), listener: node, serving, states: ["/Users/z/.wsp-demo/state.json", "/Users/z/.wsp/state.json"] })).toEqual({
      ports: { port: 4401, wsPort: 4411 },
      moved: { port: 4400, holder: { statePath: "/Users/z/.wsp/state.json" } },
    });
  });

  it("refuses a port a person named, with its holder, rather than serving somewhere they did not ask for", async () => {
    expect(await choosePorts({ port: 4401, wsPort: 4411, named: true }, { probe: busy(4411), listener: node })).toEqual({
      taken: { port: 4411, holder: { command: "node", pid: 62569 } },
    });
  });

  it("refuses when no pair in the window is free, since a run that kept stepping would land where nobody was told", async () => {
    const every = async () => true;
    expect(await choosePorts(asked, { probe: every, listener: node })).toEqual({ taken: { port: 4400, holder: { command: "node", pid: 62569 } } });
    // The window is the ten app ports whose websocket ports sit inside the next ten; the eleventh step is refused, not taken.
    const window = Array.from({ length: 10 }, (_, i) => 4400 + i);
    expect(await choosePorts(asked, { probe: busy(...window, ...window.map(p => p + 10)), listener: node })).toEqual({
      taken: { port: 4400, holder: { command: "node", pid: 62569 } },
    });
  });

  it("probes for real: the default probe finds the listener this test holds and refuses the pair it named", async () => {
    // The only port this case speaks about is one the test holds, and a named pair never steps, so nothing another
    // process does to a neighbouring port can decide the answer. Where a pick lands is settled by the probe above.
    const port = await held();
    expect(await choosePorts({ port, wsPort: port + 10, named: true }, { listener: node })).toEqual({
      taken: { port, holder: { command: "node", pid: 62569 } },
    });
  });
});

/** A port that was free a moment ago: bound and released. */
async function freed(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
