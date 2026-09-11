// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DEVICES_RELAY_REFUSAL, DEVICE_REVOKE_REFUSAL, HOST_STOPPING_CLOSE, PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH, PAIR_CODE_REFUSAL, PAIR_ISSUE_REFUSAL, WS_PATH } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { WsClient } from "./ws-client.js";

let srv: RuntimeServer | undefined;
let http: Server | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  if (http !== undefined) await new Promise<void>(done => http!.close(() => done()));
  http = undefined;
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

  it("refuses the device ops on a relayed socket: who may drive this host is never a machine's to read or change", async () => {
    await serving();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(srv!.port, { ticket });
    expect(await relayed.request("devices.list")).toMatchObject({ ok: false, error: DEVICES_RELAY_REFUSAL });
    expect(await relayed.request("devices.revoke", { deviceId: "d_1" })).toMatchObject({ ok: false, error: DEVICES_RELAY_REFUSAL });
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

    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const before = (await host.request("devices.list")) as { devices: { name: string; lastSeenAt?: string }[] };
    expect(before.devices.map(d => d.name)).toEqual(["maya's laptop"]);
    expect(before.devices[0]!.lastSeenAt).toBeUndefined();

    clock += 60_000;
    const back = await WsClient.connect(srv!.port, { token: deviceToken });
    back.close();
    const after = (await host.request("devices.list")) as { devices: { lastSeenAt?: string }[] };
    expect(after.devices[0]!.lastSeenAt).toBe(new Date(clock).toISOString());
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

  it("refuses an upgrade of any other path rather than answering it", async () => {
    const port = await attached();
    await expect(WsClient.connectTo(`ws://127.0.0.1:${port}/socket`, {})).rejects.toThrow();
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
