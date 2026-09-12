// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEVICES_TICKET_REFUSAL, DEVICE_REVOKE_REFUSAL, HOST_STOPPING_CLOSE, PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH, PAIR_CODE_REFUSAL, PAIR_ISSUE_REFUSAL, WS_PATH } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { makeDevices } from "../src/devices.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";

let srv: RuntimeServer | undefined;
let http: Server | undefined;
let second: Server | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  if (http !== undefined) await new Promise<void>(done => http!.close(() => done()));
  http = undefined;
  if (second !== undefined) await new Promise<void>(done => second!.close(() => done()));
  second = undefined;
});

const rt = (store: Store = memoryStore()) => createRuntime({ backend: stubBackend(), store, adapters: {} });

async function serving(opts: { now?: () => number; store?: Store } = {}): Promise<{ store: Store }> {
  const store = opts.store ?? memoryStore();
  const runtime = rt(store);
  srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices, ...(opts.now !== undefined ? { now: opts.now } : {}) });
  return { store };
}

/** A code minted over a socket holding the host's own token, which is the only road to one. */
async function codeFrom(): Promise<string> {
  const c = await WsClient.connect(srv!.port, { token: "host-token" });
  const issued = await c.request("pair.issue");
  c.close();
  expect(issued.ok, String(issued["error"])).toBe(true);
  return issued["code"] as string;
}

describe("pairing codes", () => {
  it("mints a single-use code of the alphabet's symbols over the host's own socket", async () => {
    await serving();
    const code = await codeFrom();
    expect(code).toHaveLength(PAIR_CODE_LENGTH);
    for (const ch of code) expect(PAIR_CODE_ALPHABET).toContain(ch);
  });

  it("refuses pair.issue on a socket nothing authed", async () => {
    await serving();
    const c = await WsClient.connect(srv!.port);
    const answer = await c.request("pair.issue");
    expect(answer.ok).toBe(false);
    expect(await c.closed()).toBe(4401);
  });

  it("refuses pair.issue on a relayed socket, whose requests came from a machine", async () => {
    await serving();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(srv!.port, { ticket });
    const answer = await relayed.request("pair.issue");
    expect(answer).toMatchObject({ ok: false, error: PAIR_ISSUE_REFUSAL });
    relayed.close();
  });

  it("refuses the device ops on a socket let in by a ticket, whichever purpose the ticket had", async () => {
    await serving();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(srv!.port, { ticket });
    expect(await relayed.request("devices.list")).toMatchObject({ ok: false, error: DEVICES_TICKET_REFUSAL });
    expect(await relayed.request("devices.revoke", { deviceId: "d_1" })).toMatchObject({ ok: false, error: DEVICES_TICKET_REFUSAL });
    relayed.close();
  });

  it("refuses pair.issue on a socket holding a device token: a paired computer cannot pair another", async () => {
    await serving();
    const code = await codeFrom();
    const client = await WsClient.connect(srv!.port);
    const paired = await client.request("pair.redeem", { code, name: "laptop" });
    const answer = await client.request("pair.issue");
    expect(paired.ok).toBe(true);
    expect(answer).toMatchObject({ ok: false, error: PAIR_ISSUE_REFUSAL });
    client.close();
  });

  it("redeems a code once as the first frame of an unauthed socket, and refuses the second redeem", async () => {
    await serving();
    const code = await codeFrom();
    const first = await WsClient.connect(srv!.port);
    const got = await first.request("pair.redeem", { code, name: "laptop" });
    expect(got.ok).toBe(true);
    expect(typeof got["deviceToken"]).toBe("string");
    expect(typeof got["deviceId"]).toBe("string");
    // The socket is authed from that frame on: an op that needs auth answers rather than closing it.
    expect((await first.request("workspaces.list")).ok).toBe(true);
    first.close();

    const second = await WsClient.connect(srv!.port);
    const again = await second.request("pair.redeem", { code, name: "another" });
    expect(again).toMatchObject({ ok: false, error: PAIR_CODE_REFUSAL });
    expect(await second.closed()).toBe(4401);
  });

  it("refuses an expired code and forgets it, so a later clock does not let it in", async () => {
    let clock = 1_000;
    const { store } = await serving({ now: () => clock });
    const code = await codeFrom();
    expect(await store.get("pairings", code)).toBeDefined();
    clock += 11 * 60_000;
    const late = await WsClient.connect(srv!.port);
    const answer = await late.request("pair.redeem", { code, name: "laptop" });
    expect(answer).toMatchObject({ ok: false, error: PAIR_CODE_REFUSAL });
    expect(await store.get("pairings", code)).toBeUndefined();
    expect(await late.closed()).toBe(4401);
  });

  it("clears codes that ran out when the next one is minted, so the state file keeps no dead ones", async () => {
    let clock = 1_000;
    const { store } = await serving({ now: () => clock });
    const stale = await codeFrom();
    clock += 11 * 60_000;
    const fresh = await codeFrom();
    expect(await store.get("pairings", stale)).toBeUndefined();
    expect(await store.get("pairings", fresh)).toBeDefined();
  });

  it("keeps only the token's hash, never the token", async () => {
    const { store } = await serving();
    const code = await codeFrom();
    const client = await WsClient.connect(srv!.port);
    const { deviceToken } = (await client.request("pair.redeem", { code, name: "laptop" })) as { deviceToken: string };
    client.close();
    expect(JSON.stringify(await store.list("devices"))).not.toContain(deviceToken);
  });
});

describe("device tokens on the auth frame", () => {
  it("takes a device token, still takes the host's own, and refuses a revoked one with 4401", async () => {
    await serving();
    const code = await codeFrom();
    const paired = await WsClient.connect(srv!.port);
    const { deviceToken, deviceId } = (await paired.request("pair.redeem", { code, name: "laptop" })) as { deviceToken: string; deviceId: string };
    paired.close();

    const again = await WsClient.connect(srv!.port, { token: deviceToken });
    expect((await again.request("workspaces.list")).ok).toBe(true);
    again.close();

    const asHost = await WsClient.connect(srv!.port, { token: "host-token" });
    expect((await asHost.request("devices.revoke", { deviceId })).ok).toBe(true);
    asHost.close();

    const refused = await WsClient.connect(srv!.port);
    void refused.request("auth", { token: deviceToken });
    expect(await refused.closed()).toBe(4401);

    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    expect((await host.request("workspaces.list")).ok).toBe(true);
    host.close();
  });

  it("cuts the sockets a revoked device still holds", async () => {
    await serving();
    const code = await codeFrom();
    const device = await WsClient.connect(srv!.port);
    const { deviceId } = (await device.request("pair.redeem", { code, name: "laptop" })) as { deviceId: string };
    const cut = device.closed();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    await host.request("devices.revoke", { deviceId });
    expect(await cut).toBe(4401);
    host.close();
  });
});

describe("the device listing", () => {
  it("names each device and moves its last seen when it auths again", async () => {
    let clock = Date.parse("2026-09-11T10:00:00.000Z");
    await serving({ now: () => clock });
    const code = await codeFrom();
    const first = await WsClient.connect(srv!.port);
    const { deviceToken } = (await first.request("pair.redeem", { code, name: "maya's laptop" })) as { deviceToken: string };
    first.close();

    const paired = new Date(clock).toISOString();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const before = (await host.request("devices.list")) as { devices: { name: string; createdAt: string; lastSeenAt: string }[] };
    expect(before.devices.map(d => d.name)).toEqual(["maya's laptop"]);
    // The redeem is itself the first time this computer was seen, so the row reads the same on both counts.
    expect(before.devices[0]).toMatchObject({ createdAt: paired, lastSeenAt: paired });

    clock += 60_000;
    const back = await WsClient.connect(srv!.port, { token: deviceToken });
    back.close();
    // The auth frame's own reply does not wait on the write, so the listing is polled rather than read once.
    const moved = new Date(clock).toISOString();
    await until(async () => {
      const { devices } = (await host.request("devices.list")) as { devices: { lastSeenAt: string }[] };
      return devices[0]!.lastSeenAt === moved;
    });

    // A JSON route reading the same token must not move it: a write per request would rewrite the state file.
    clock += 60_000;
    expect(await srv!.authorize(deviceToken)).toMatchObject({ kind: "device" });
    const unmoved = (await host.request("devices.list")) as { devices: { lastSeenAt: string }[] };
    expect(unmoved.devices[0]!.lastSeenAt).not.toBe(new Date(clock).toISOString());
    host.close();
  });

  it("lets a device revoke itself and refuses it another device", async () => {
    await serving();
    const one = await WsClient.connect(srv!.port);
    const { deviceId: oneId } = (await one.request("pair.redeem", { code: await codeFrom(), name: "one" })) as { deviceId: string };
    const two = await WsClient.connect(srv!.port);
    const { deviceId: twoId } = (await two.request("pair.redeem", { code: await codeFrom(), name: "two" })) as { deviceId: string };

    expect(await one.request("devices.revoke", { deviceId: twoId })).toMatchObject({ ok: false, error: DEVICE_REVOKE_REFUSAL });
    expect(await two.request("devices.revoke", { deviceId: twoId })).toMatchObject({ ok: true, revoked: true });

    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const { devices } = (await host.request("devices.list")) as { devices: { id: string }[] };
    expect(devices.map(d => d.id)).toEqual([oneId]);
    host.close();
    one.close();
  });
});

describe("the runtime on an HTTP server's own port", () => {
  async function attached(): Promise<number> {
    const runtime = rt();
    http = createServer((_req, res) => res.end("page"));
    await new Promise<void>(done => http!.listen(0, "127.0.0.1", done));
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", attach: http, devices: runtime.devices });
    return (http.address() as { port: number }).port;
  }

  it("answers on WS_PATH of the attached server and on its own port", async () => {
    const port = await attached();
    const onPath = await WsClient.connectTo(`ws://127.0.0.1:${port}${WS_PATH}`, { token: "host-token" });
    expect((await onPath.request("workspaces.list")).ok).toBe(true);
    onPath.close();
    const onPort = await WsClient.connect(srv!.port, { token: "host-token" });
    expect((await onPort.request("workspaces.list")).ok).toBe(true);
    onPort.close();
  });

  it("answers on both attached servers, since the app's own port and the door computers you own dial carry one protocol", async () => {
    const runtime = rt();
    http = createServer((_req, res) => res.end("page"));
    second = createServer((_req, res) => res.end("page"));
    for (const server of [http, second]) await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", attach: [http, second], devices: runtime.devices });
    const ports = [http, second].map(server => (server.address() as { port: number }).port);
    for (const port of ports) {
      const on = await WsClient.connectTo(`ws://127.0.0.1:${port}${WS_PATH}`, { token: "host-token" });
      expect((await on.request("workspaces.list")).ok).toBe(true);
      on.close();
      await expect(WsClient.connectTo(`ws://127.0.0.1:${port}/socket`, {})).rejects.toThrow();
    }
    await srv.close();
    srv = undefined;
    // A close takes the runtime off both, so neither server is left upgrading into a runtime that has stopped.
    for (const port of ports) await expect(WsClient.connectTo(`ws://127.0.0.1:${port}${WS_PATH}`, {})).rejects.toThrow();
  });

  it("refuses an upgrade of any other path rather than answering it", async () => {
    const port = await attached();
    await expect(WsClient.connectTo(`ws://127.0.0.1:${port}/socket`, {})).rejects.toThrow();
  });

  it("survives a peer that resets right after an upgrade it refuses, which nothing else would catch", async () => {
    const port = await attached();
    const faults: unknown[] = [];
    const catchIt = (e: unknown): void => void faults.push(e);
    process.on("uncaughtException", catchIt);
    try {
      // The refusal writes to a raw socket the ws library never wrapped; without an error listener on it a reset
      // here reaches the process, and a host bound beyond loopback would be ended by a stranger knocking.
      for (let i = 0; i < 30; i++) {
        await new Promise<void>(done => {
          const sock = connect({ port, host: "127.0.0.1" }, () => {
            sock.write(`GET /nope HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
            sock.resetAndDestroy();
            done();
          });
          sock.on("error", () => done());
        });
      }
      // Long enough for every reset to land on the host's side of the socket.
      await new Promise(r => setTimeout(r, 500));
      expect(faults).toEqual([]);
    } finally {
      process.off("uncaughtException", catchIt);
    }
    // The host is still answering after all of it.
    const alive = await WsClient.connectTo(`ws://127.0.0.1:${port}${WS_PATH}`, { token: "host-token" });
    expect((await alive.request("workspaces.list")).ok).toBe(true);
    alive.close();
  });

  it("closes a client on WS_PATH with the stopping code, not by cutting the socket", async () => {
    const port = await attached();
    const client = await WsClient.connectTo(`ws://127.0.0.1:${port}${WS_PATH}`, { token: "host-token" });
    const closed = client.closed();
    await srv!.close();
    srv = undefined;
    expect(await closed).toBe(HOST_STOPPING_CLOSE);
  });
});

describe("one writer over the device records", () => {
  it("a revoke that lands while a last seen write is in flight stays revoked", async () => {
    const store = memoryStore();
    const door = makeDevices(store);
    const { code } = await door.issue({ now: 1_000, ttlMs: 60_000 });
    const paired = (await door.redeem(code, "laptop", 1_000))!;

    // What a paired client redialing with backoff does while somebody at the host runs wsp devices revoke: both
    // roads read the record, and without one writer the later write puts the revoked device back.
    const [, revoked] = await Promise.all([door.seen(paired.deviceId, 2_000), door.revoke(paired.deviceId)]);
    expect(revoked).toBe(true);
    expect(await door.list()).toEqual([]);
    expect(await door.match(paired.deviceToken)).toBeUndefined();
    expect(await store.get("devices", paired.deviceId)).toBeUndefined();
  });

  it("holds in the other order too, and a seen after a revoke writes nothing back", async () => {
    const store = memoryStore();
    const door = makeDevices(store);
    const { code } = await door.issue({ now: 1_000, ttlMs: 60_000 });
    const paired = (await door.redeem(code, "laptop", 1_000))!;
    const [revoked, moved] = await Promise.all([door.revoke(paired.deviceId), door.seen(paired.deviceId, 2_000)]);
    expect(revoked).toBe(true);
    expect(moved).toBeUndefined();
    expect(await door.list()).toEqual([]);
  });

  it("two sockets spending one code get one device between them", async () => {
    const store = memoryStore();
    const door = makeDevices(store);
    const { code } = await door.issue({ now: 1_000, ttlMs: 60_000 });
    const both = await Promise.all([door.redeem(code, "one", 1_000), door.redeem(code, "two", 1_000)]);
    expect(both.filter(p => p !== undefined)).toHaveLength(1);
    expect(await door.list()).toHaveLength(1);
  });
});

describe("a runtime served with no device door", () => {
  it("refuses a pair.redeem first frame in one line rather than leaving the socket open", async () => {
    const runtime = rt();
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token" });
    const client = await WsClient.connect(srv.port);
    const answer = await client.request("pair.redeem", { code: "AAAAAAAA", name: "laptop" });
    expect(answer).toMatchObject({ ok: false, error: PAIR_CODE_REFUSAL, kind: "auth" });
    expect(await client.closed()).toBe(4401);
  });

  it("still takes the host's own token, so a runtime without one is unchanged", async () => {
    const runtime = rt();
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token" });
    const client = await WsClient.connect(srv.port, { token: "host-token" });
    expect((await client.request("workspaces.list")).ok).toBe(true);
    client.close();
  });
});

describe("who a bearer token names", () => {
  it("answers host for the host's own, the device for a paired one, and nothing for anything else", async () => {
    await serving();
    const code = await codeFrom();
    const client = await WsClient.connect(srv!.port);
    const { deviceToken, deviceId } = (await client.request("pair.redeem", { code, name: "laptop" })) as { deviceToken: string; deviceId: string };
    client.close();
    expect(await srv!.authorize("host-token")).toEqual({ kind: "host" });
    expect(await srv!.authorize(deviceToken)).toMatchObject({ kind: "device", device: { id: deviceId } });
    expect(await srv!.authorize("nope")).toBeUndefined();
    expect(await srv!.authorize(undefined)).toBeUndefined();
  });
});
