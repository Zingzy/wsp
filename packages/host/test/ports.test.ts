// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LOOPBACK } from "@wsp/runtime";
import { listenerOf, portClash, portInUse } from "../src/ports.js";

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

  it("the clash sentence names the first taken port and its holder, or another process when nobody can be named", async () => {
    expect(await portClash([4400, 4410], async () => false)).toBeUndefined();
    expect(await portClash([4400, 4410], async p => p === 4410, async () => ({ command: "node", pid: 4242 }))).toBe("Port 4410 is in use on this computer by node (pid 4242).");
    expect(await portClash([4400, 4410], async () => true, async () => undefined)).toBe("Port 4400 is in use on this computer by another process.");
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
