// SPDX-License-Identifier: AGPL-3.0-only
import { connect as netConnect } from "node:net";
import { describe, expect, it } from "vitest";
import { PLACE_DOOR_REFUSAL, PLACE_DOOR_UNSERVED, deviceHeldRefusal, THREAD_OPS, absentComputer, readJoinToken, JoinMint, PAIR_CODE_TTL_MS, MINT_JOIN_REFUSAL, PLACES_WORDS, SSH_HOSTS_REFUSAL, placeNoDaemonPortLine, type PlaceView } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { keyFingerprint } from "@wsp/engine";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";
import { report } from "./place-join.js";
import { ctx, sockets, serving, code, join, placesOf } from "./places-fixture.js";

describe("the road a pane takes to a place", () => {
  it("is refused with the place's name while that computer is not connected", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "box" });
    client.close();
    await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === false));
    await expect(ctx.runtime!.places!.road(placeId)).rejects.toThrow(absentComputer("box", null).sentence);
  });

  it("is refused with its own sentence while that computer has not said which port its daemon bound", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "box" });
    await expect(ctx.runtime!.places!.road(placeId)).rejects.toThrow(placeNoDaemonPortLine("box"));
  });
});

describe("the port a place's panes ride", () => {
  it("goes with the link that carried it, so nothing is left answering for a computer that is gone", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "box", report: report("box", { daemonPort: 4321 }) });
    const port = await ctx.runtime!.places!.road(placeId);
    expect(port).toBeGreaterThan(0);
    client.close();
    await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === false));
    await expect(
      new Promise((done, fail) => {
        const socket = netConnect({ port, host: "127.0.0.1" }, () => done(true));
        socket.once("error", fail);
      }),
    ).rejects.toThrow();
  });
});

describe("the device a join buys beside the place", () => {
  it("mints one with no scope, whose token matches and which is listed and revoked as a redeemed one is", async () => {
    const store = memoryStore();
    ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const admitted = await ctx.runtime.devices.admit("old-macbook", 1);
    expect(admitted.device.scope).toBeUndefined();
    expect(await ctx.runtime.devices.match(admitted.deviceToken)).toMatchObject({ id: admitted.deviceId, name: "old-macbook" });
    expect((await ctx.runtime.devices.list()).map(d => d.id)).toContain(admitted.deviceId);
    expect(await ctx.runtime.devices.revoke(admitted.deviceId)).toBe(true);
    expect(await ctx.runtime.devices.match(admitted.deviceToken)).toBeUndefined();
  });

  it("answers a join that asked for one, names it after the joining computer, and answers none to a join that did not", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code(), client: { name: "old-macbook" } });
    sockets.push(first.client.ws);
    // The token rides the sealed reply to the prove, since the code that bought it crossed on that frame.
    const device = first.proved["device"] as { deviceId: string; deviceToken: string };
    expect(device.deviceToken).toBeTruthy();
    expect(await ctx.runtime!.devices.match(device.deviceToken)).toMatchObject({ id: device.deviceId, name: "old-macbook" });
    expect(first.reply["device"]).toBeUndefined();
    const second = await join(hostKey, { code: await code(), name: "attic" });
    sockets.push(second.client.ws);
    expect(second.proved["device"]).toBeUndefined();
  });

  it("leaves the link bound to no device, so revoking that device closes nothing", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), client: { name: "old-macbook" } });
    sockets.push(client.ws);
    const device = (await ctx.runtime!.devices.list())[0]!;
    expect(device.name).toBe("old-macbook");
    expect(await ctx.runtime!.devices.revoke(device.id)).toBe(true);
    await new Promise(r => setTimeout(r, 50));
    expect(client.ws.readyState).toBe(client.ws.OPEN);
    expect((await placesOf()).find(p => p.id === placeId)?.present).toBe(true);
  });
});

describe("what a join is told about the wsp it joined", () => {
  it("answers the primary computer's own name off the wiring, and the signature over the transcript still verifies", async () => {
    const { hostKey } = await serving();
    const { client, reply, proved } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    expect(reply["hostName"]).toBe("zingzys-mac");
    expect(proved.ok).toBe(true);
  });
});

describe("the four events a computer you own rides the runtime's stream on", () => {
  it("carries the join with the address it came from, the link coming and going, and the remove", async () => {
    const { hostKey } = await serving();
    const watcher = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    expect((await watcher.request("events.subscribe")).ok).toBe(true);
    const { client, placeId } = await join(hostKey, { code: await code() });
    await until(() => watcher.events.some(e => e.type === "place.present"));
    const joined = watcher.events.find(e => e.type === "place.joined")!;
    expect((joined["place"] as PlaceView).id).toBe(placeId);
    expect(String(joined["from"])).toContain("127.0.0.1");
    expect(typeof joined["seq"]).toBe("number");
    expect(watcher.events.find(e => e.type === "place.present")).toMatchObject({ placeId });
    client.ws.close();
    await until(() => watcher.events.some(e => e.type === "place.absent"));
    const remover = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    expect((await remover.request("places.remove", { placeId })).ok).toBe(true);
    await until(() => watcher.events.some(e => e.type === "place.removed"));
    expect(watcher.events.filter(e => e.type === "place.removed")).toMatchObject([{ placeId }]);
    remover.close();
    watcher.close();
  });
});

describe("the door a computer you own dials", () => {
  it("is refused on a host that serves none, and answered on one that does", async () => {
    const { hostKey } = await serving();
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    const none = await c.request("places.door");
    expect(none).toMatchObject({ ok: false, error: PLACE_DOOR_UNSERVED });
    c.close();
    await ctx.srv!.close();
    const view = { port: 4420, addresses: ["http://192.168.1.20:4420"] };
    ctx.srv = await serveRuntime(ctx.runtime!, { port: 0, authToken: "host-token", devices: ctx.runtime!.devices, door: { open: async () => ({ ...view, backPort: 4420 }) } });
    const opened = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    const answer = await opened.request("places.door");
    // Where to dial is the host's answer; the key proved there is the place door's own, off the pair it signs with.
    // The port a forward over ssh lands on is this computer's business and stays off the wire.
    expect(answer["door"]).toEqual({ ...view, hostKey: keyFingerprint(hostKey.publicKey) });
    opened.close();
  });

  it("is refused on a socket let in by a ticket, as every other place op is", async () => {
    await serving();
    await ctx.srv!.close();
    ctx.srv = await serveRuntime(ctx.runtime!, { port: 0, authToken: "host-token", devices: ctx.runtime!.devices, door: { open: async () => ({ port: 4420, addresses: ["http://x:4420"] }) } });
    const own = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    const { ticket } = (await own.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    own.close();
    const relayed = await WsClient.connect(ctx.srv.port, { ticket });
    expect(await relayed.request("places.door")).toMatchObject({ ok: false, error: PLACE_DOOR_REFUSAL });
    relayed.close();
  });
});

describe("the join line and the ssh hosts the app asks for", () => {
  const view = { port: 4420, addresses: ["http://192.168.1.20:4420"], relay: "https://p_ab12cd34.usewsp.com" };
  const at = Date.parse("2026-09-24T10:00:00.000Z");

  it("mints one code into every line the door and the relay answer on, and the code is the one a join spends", async () => {
    const { hostKey } = await serving();
    await ctx.srv!.close();
    ctx.srv = await serveRuntime(ctx.runtime!, { port: 0, authToken: "host-token", devices: ctx.runtime!.devices, door: { open: async () => view }, now: () => at });
    const own = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    const answer = await own.request("places.mint");
    own.close();
    expect(answer.ok, String(answer["error"])).toBe(true);
    const minted = JoinMint.parse(answer);
    const token = minted.joins[0]!.line.split(" --code ")[1]!;
    expect(readJoinToken(token).hostKey).toBe(keyFingerprint(hostKey.publicKey));
    expect(minted).toEqual({
      joins: [
        { url: view.addresses[0], line: PLACES_WORDS.sheet.joinLine(view.addresses[0]!, token) },
        { url: view.relay, line: PLACES_WORDS.sheet.joinLine(view.relay, token), note: PLACES_WORDS.sheet.relayNote },
      ],
      expiresAt: new Date(at + PAIR_CODE_TTL_MS).toISOString(),
    });
    // The same mint wsp add spends: the code redeems once, as a pair.issue code does.
    const spending = await WsClient.connect(ctx.srv.port);
    expect((await spending.request("pair.redeem", { code: readJoinToken(token).code, name: "laptop" })).ok).toBe(true);
    spending.close();
  });

  it("hands neither a code nor the ssh hosts to a paired computer or a relayed socket", async () => {
    await serving();
    await ctx.srv!.close();
    const read: unknown[] = [];
    ctx.srv = await serveRuntime(ctx.runtime!, {
      port: 0,
      authToken: "host-token",
      devices: ctx.runtime!.devices,
      door: { open: async () => view },
      sshHosts: async rows => {
        read.push(rows);
        return [{ alias: "hetzner", hostName: "65.21.4.12", user: "root", from: "config" }];
      },
    });
    const own = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    expect(await own.request("places.sshHosts")).toMatchObject({ ok: true, hosts: [{ alias: "hetzner", hostName: "65.21.4.12", user: "root", from: "config" }] });
    expect(read).toHaveLength(1);
    const code = (await own.request("pair.issue"))["code"] as string;
    const { ticket } = (await own.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    own.close();
    const spending = await WsClient.connect(ctx.srv.port);
    const { deviceToken } = (await spending.request("pair.redeem", { code, name: "phone" })) as { deviceToken: string };
    spending.close();
    const paired = await WsClient.connect(ctx.srv.port, { token: deviceToken });
    expect(await paired.request("places.mint")).toMatchObject({ ok: false, error: deviceHeldRefusal("places.mint") });
    expect(await paired.request("places.sshHosts")).toMatchObject({ ok: false, error: deviceHeldRefusal("places.sshHosts") });
    paired.close();
    const relayed = await WsClient.connect(ctx.srv.port, { ticket });
    expect(await relayed.request("places.mint")).toMatchObject({ ok: false, error: MINT_JOIN_REFUSAL });
    expect(await relayed.request("places.sshHosts")).toMatchObject({ ok: false, error: SSH_HOSTS_REFUSAL });
    relayed.close();
    expect(read).toHaveLength(1);
    expect(THREAD_OPS).not.toContain("places.mint");
    expect(THREAD_OPS).not.toContain("places.sshHosts");
  });

  it("refuses a code on a host that serves no door", async () => {
    await serving();
    const own = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    expect(await own.request("places.mint")).toMatchObject({ ok: false, error: PLACE_DOOR_UNSERVED });
    own.close();
  });
});
