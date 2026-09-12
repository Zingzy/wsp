// SPDX-License-Identifier: AGPL-3.0-only
// The host's side of a place: the handshake a joining computer takes, the
// records and links the door holds, the workspace a join records, and the two
// ops a person's own socket reaches. The signatures here are real ed25519
// ones, so what the door verifies is what a place would send.
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import {
  NO_PLACE_INSTALLER,
  PLACE_CODE_REFUSAL,
  PLACES_TICKET_REFUSAL,
  PLACE_KEY_REFUSAL,
  PLACE_UNKNOWN_REFUSAL,
  PLACE_LINK_NONCE_BYTES,
  THREAD_OPS,
  placeDaemonPaths,
  placeAbsentLine,
  placeLinkTranscript,
  placeNoDaemonPortLine,
  placeNoLinkLine,
  workFolderIn,
  type PlaceStageEvent,
  type PlaceReport,
  type PlaceView,
} from "@wsp/protocol";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { newPlaceKeyPair, type PlaceInstallRequest, type PlaceKeyPair, type PlaceWiring } from "../src/places.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";

let srv: RuntimeServer | undefined;
let runtime: Runtime | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await srv?.close();
  srv = undefined;
  await runtime?.close();
  runtime = undefined;
});

const HERE = { name: "zingzys-mac", os: "macOS 15.0", shape: { cpu: 8, memMb: 16384 }, docker: true };

function wiring(hostKey: PlaceKeyPair, provider?: { id: string; rateUsdPerHour: number }): PlaceWiring {
  return { hostKey, provider: () => provider, here: () => HERE, addresses: () => ["http://192.168.1.20:4400"] };
}

const report = (name = "old-macbook", over: Partial<PlaceReport> = {}): PlaceReport => ({
  name,
  platform: "linux",
  arch: "x64",
  os: "Ubuntu 24.04",
  shape: { cpu: 4, memMb: 4096 },
  diskFreeBytes: 831 * 1024 * 1024 * 1024,
  login: { HOME: "/home/maya", USER: "maya", PATH: "/usr/bin" },
  docker: true,
  daemonVersion: 17,
  wsp: ["/home/maya/.npm-global/bin/wsp"],
  dialed: "http://host.docker.internal:14621",
  ...over,
});

async function serving(opts: { provider?: { id: string; rateUsdPerHour: number }; store?: Store } = {}): Promise<{ hostKey: PlaceKeyPair; store: Store }> {
  const store = opts.store ?? memoryStore();
  const hostKey = newPlaceKeyPair();
  runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey, opts.provider) });
  srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
  return { hostKey, store };
}

/** A code minted over the host's own socket, which is the only road to one. */
async function code(): Promise<string> {
  const c = await WsClient.connect(srv!.port, { token: "host-token" });
  const issued = await c.request("pair.issue");
  c.close();
  expect(issued.ok, String(issued["error"])).toBe(true);
  return issued["code"] as string;
}

const nonce = (): string => randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
const signWith = (pem: string, bytes: Uint8Array): string => sign(null, bytes, createPrivateKey(pem)).toString("base64");

/** One join, as a computer would make it: the frame, the check of the host's own signature, and the prove. */
async function join(
  hostKey: PlaceKeyPair,
  opts: { code: string; name?: string; report?: PlaceReport; proveReport?: PlaceReport; expectProved?: boolean } = { code: "" },
): Promise<{ client: WsClient; placeId: string; reply: Record<string, unknown>; proved: Record<string, unknown>; pair: PlaceKeyPair }> {
  const client = await WsClient.connect(srv!.port);
  const pair = newPlaceKeyPair();
  const mine = nonce();
  const sent = opts.report ?? report(opts.name);
  const reply = await client.request("place.join", { code: opts.code, publicKey: pair.publicKey, nonce: mine, report: sent });
  if (reply.ok !== true) return { client, placeId: "", reply, proved: {}, pair };
  const placeId = String(reply["placeId"]);
  expect(reply["hostPublicKey"]).toBe(hostKey.publicKey);
  const proved = await client.request("place.prove", {
    signature: signWith(pair.privateKeyPem, placeLinkTranscript("place", placeId, String(reply["nonce"]), mine)),
    // The second frame carries a report of its own, which a computer may send with anything in it.
    report: opts.proveReport ?? sent,
  });
  if (opts.expectProved !== false) expect(proved.ok, String(proved["error"])).toBe(true);
  return { client, placeId, reply, proved, pair };
}

/** A place that already joined, dialling in again: the handshake it runs on every attempt. */
async function relink(hostKey: PlaceKeyPair, placeId: string, pair: PlaceKeyPair, sent: PlaceReport = report()): Promise<{ client: WsClient; proved: Record<string, unknown> }> {
  const client = await WsClient.connect(srv!.port);
  const mine = nonce();
  const challenged = await client.request("place.auth", { placeId, nonce: mine });
  expect(challenged.ok, String(challenged["error"])).toBe(true);
  expect(challenged["hostPublicKey"]).toBe(hostKey.publicKey);
  const proved = await client.request("place.prove", {
    signature: signWith(pair.privateKeyPem, placeLinkTranscript("place", placeId, String(challenged["nonce"]), mine)),
    report: sent,
  });
  return { client, proved };
}

const placesOf = async (): Promise<PlaceView[]> => {
  const c = await WsClient.connect(srv!.port, { token: "host-token" });
  const answer = await c.request("places.list");
  c.close();
  expect(answer.ok, String(answer["error"])).toBe(true);
  return answer["places"] as PlaceView[];
};

describe("a code spent by a road that proves itself another way", () => {
  it("spends once: the second spend is false, whatever asks", async () => {
    const store = memoryStore();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const issued = await runtime.devices.issue({ now: 0, ttlMs: 10_000 });
    expect(await runtime.devices.spend(issued.code, 1)).toBe(true);
    expect(await runtime.devices.spend(issued.code, 2)).toBe(false);
  });

  it("still admits a device on a fresh code and refuses a spent one, which is one code store for both roads", async () => {
    const store = memoryStore();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const first = await runtime.devices.issue({ now: 0, ttlMs: 10_000 });
    expect(await runtime.devices.redeem(first.code, "a laptop", 1)).toBeDefined();
    expect(await runtime.devices.redeem(first.code, "a laptop", 2)).toBeUndefined();
    const second = await runtime.devices.issue({ now: 0, ttlMs: 10_000 });
    expect(await runtime.devices.spend(second.code, 1)).toBe(true);
    expect(await runtime.devices.redeem(second.code, "a laptop", 2)).toBeUndefined();
  });

  it("refuses a code that ran out, and spends it either way so one guess never gets two tries", async () => {
    const store = memoryStore();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const issued = await runtime.devices.issue({ now: 0, ttlMs: 10 });
    expect(await runtime.devices.spend(issued.code, 100)).toBe(false);
    expect(await runtime.devices.spend(issued.code, 5)).toBe(false);
  });
});

describe("a computer joining", () => {
  it("is recorded on a host nothing has asked a verb of yet, which is every host a place dials as it starts", async () => {
    // The records are read lazily, on the first verb; a place dials on its own and asks for none, so the roads it
    // reaches wait on that one reading rather than finding an empty host.
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const first = await join(hostKey, { code: await code() });
    sockets.push(first.client.ws);
    // A second host over the same store, asked nothing, still sees the name the first one recorded.
    await srv.close();
    await runtime.close();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const second = await join(hostKey, { code: await code() });
    sockets.push(second.client.ws);
    expect(String(second.reply["notice"])).toContain("old-macbook");
  });

  it("spends the code, records the place with its key and report, marks it default, and records one workspace of the place kind", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    expect(placeId).toMatch(/^p_[0-9a-f]{16}$/);
    const places = await placesOf();
    const row = places.find(p => p.id === placeId)!;
    expect(row).toMatchObject({ kind: "computer", name: "old-macbook", default: true, docker: true, os: "Ubuntu 24.04", present: true });
    expect(row.shape).toEqual({ cpu: 4, memMb: 4096 });
    const workspaces = await runtime!.workspaces.list();
    const ws = workspaces.find(w => w.name === "old-macbook")!;
    expect(ws.kind).toBe("place");
    expect(ws.machineId).toBe(`place:${placeId}`);
    expect(ws.home).toBe("/home/maya");
    expect(ws.folder).toBe(workFolderIn("/home/maya"));
    expect(row.workspaceId).toBe(ws.id);
  });

  it("refuses a code this host is not holding, in the one sentence every reason reads as", async () => {
    const { hostKey } = await serving();
    const { client, reply } = await join(hostKey, { code: "NOTACODE" });
    expect(String(reply["error"])).toContain("wsp add");
    expect(reply).toMatchObject({ ok: false, error: PLACE_CODE_REFUSAL, kind: "auth" });
    expect(await client.closed()).toBe(4401);
  });

  it("refuses a code a second time, so a spent code is worth nothing", async () => {
    const { hostKey } = await serving();
    const spent = await code();
    const first = await join(hostKey, { code: spent });
    sockets.push(first.client.ws);
    const second = await join(hostKey, { code: spent });
    expect(second.reply).toMatchObject({ ok: false, error: PLACE_CODE_REFUSAL });
    expect(await placesOf()).toHaveLength(2); // this computer and the one place that did join
  });

  it("refuses a report whose home is not a plain path, before the code is spent", async () => {
    const { hostKey } = await serving();
    const fresh = await code();
    const bad = await join(hostKey, { code: fresh, report: report("old-macbook", { login: { HOME: "/home/maya; rm -rf /" } }) });
    expect(bad.reply.ok).toBe(false);
    expect(String(bad.reply["error"])).toContain("not a plain path");
    // The code was not spent by a join that was never going to stand.
    const good = await join(hostKey, { code: fresh });
    sockets.push(good.client.ws);
    expect(good.placeId).not.toBe("");
  });

  it("refuses the report on the second frame by the same rule, so a join cannot slip a path past the first one", async () => {
    const { hostKey } = await serving();
    // The join frame's report is one wsp can build paths from and the prove frame's is not: one rule reads both.
    const slipped = await join(hostKey, {
      code: await code(),
      proveReport: report("old-macbook", { login: { HOME: "/home/m; rm -rf /", USER: "maya", PATH: "/usr/bin" } }),
      expectProved: false,
    });
    expect(slipped.proved).toMatchObject({ ok: false });
    expect(String(slipped.proved["error"])).toContain("not a plain path");
    expect(await slipped.client.closed()).toBe(4401);
    // Nothing was attached and nothing of it reached the workspace standing on that place.
    expect((await placesOf()).find(p => p.id === slipped.placeId)!.present).toBe(false);
    const ws = (await runtime!.workspaces.list()).find(w => w.kind === "place")!;
    expect(ws.home).toBe("/home/maya");
    expect(ws.folder).toBe(workFolderIn("/home/maya"));
  });

  it("refuses the same report on a relink, and the workspace keeps the login it had", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    joined.client.close();
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === false);
    const again = await relink(hostKey, joined.placeId, joined.pair, report("old-macbook", { login: { HOME: "/home/m; rm -rf /", USER: "maya", PATH: "/usr/bin" } }));
    expect(again.proved).toMatchObject({ ok: false });
    expect(String(again.proved["error"])).toContain("not a plain path");
    expect(await again.client.closed()).toBe(4401);
    expect((await placesOf()).find(p => p.id === joined.placeId)!.present).toBe(false);
    expect((await runtime!.workspaces.list()).find(w => w.kind === "place")!.home).toBe("/home/maya");
  });

  it("keeps a report's PATH and store folders only where they are plain paths, as the ssh read does", async () => {
    const { hostKey } = await serving();
    const sent = report("old-macbook", {
      login: { HOME: "/home/maya", USER: "maya", PATH: "/home/maya/bin:/usr/bin:/opt/a b", CLAUDE_CONFIG_DIR: "/tmp/x; rm -rf /" },
    });
    const joined = await join(hostKey, { code: await code(), report: sent });
    sockets.push(joined.client.ws);
    const kept = await runtime!.places!.reportOf(joined.placeId);
    expect(kept!.login["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    expect(kept!.login["PATH"]).toBe("/home/maya/bin:/usr/bin");
    expect(kept!.login["HOME"]).toBe("/home/maya");
  });

  it("records the place and says so as a notice when the name is one a workspace already holds", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code() });
    sockets.push(first.client.ws);
    // Two computers under one name: ids tell them apart, the second joins, and the notice says who holds the name.
    const second = await join(hostKey, { code: await code() });
    sockets.push(second.client.ws);
    expect(String(second.reply["notice"])).toContain("old-macbook");
    const row = (await placesOf()).find(p => p.id === second.placeId)!;
    expect(row.workspaceId).toBeUndefined();
    expect((await runtime!.workspaces.list()).filter(w => w.kind === "place")).toHaveLength(1);
  });
});

describe("a place dialling back in", () => {
  it("answers a signature this computer can check against the host's key over the transcript it challenged with", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    client.close();
    const again = await WsClient.connect(srv!.port);
    sockets.push(again.ws);
    const mine = nonce();
    const answer = await again.request("place.auth", { placeId, nonce: mine });
    expect(answer.ok, String(answer["error"])).toBe(true);
    expect(answer["hostPublicKey"]).toBe(hostKey.publicKey);
    const { verify } = await import("node:crypto");
    const ok = verify(
      null,
      placeLinkTranscript("host", placeId, mine, String(answer["nonce"])),
      { key: Buffer.from(hostKey.publicKey, "base64"), format: "der", type: "spki" },
      Buffer.from(String(answer["signature"]), "base64"),
    );
    expect(ok).toBe(true);
  });

  it("refuses an id this host holds no place by", async () => {
    await serving();
    const c = await WsClient.connect(srv!.port);
    const answer = await c.request("place.auth", { placeId: "p_deadbeefdeadbeef", nonce: nonce() });
    expect(answer).toMatchObject({ ok: false, error: PLACE_UNKNOWN_REFUSAL, kind: "auth" });
    expect(await c.closed()).toBe(4401);
  });

  it("refuses a prove signed over the wrong transcript, and attaches nothing", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code() });
    first.client.close();
    const other = newPlaceKeyPair();
    const c = await WsClient.connect(srv!.port);
    const mine = nonce();
    const challenged = await c.request("place.auth", { placeId: first.placeId, nonce: mine });
    const bad = await c.request("place.prove", {
      // Signed with a key this host never learned, which is what a place file copied off a computer would carry.
      signature: signWith(other.privateKeyPem, placeLinkTranscript("place", first.placeId, String(challenged["nonce"]), mine)),
      report: report(),
    });
    expect(bad).toMatchObject({ ok: false, error: PLACE_KEY_REFUSAL });
    expect(await c.closed()).toBe(4401);
  });

  it("refuses a second frame that is not the prove, and a prove on a socket that challenged nothing", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    joined.client.close();
    const wrongOrder = await WsClient.connect(srv!.port);
    await wrongOrder.request("place.auth", { placeId: joined.placeId, nonce: nonce() });
    const answer = await wrongOrder.request("status.list");
    expect(answer.ok).toBe(false);
    expect(await wrongOrder.closed()).toBe(4401);

    const bare = await WsClient.connect(srv!.port);
    const straight = await bare.request("place.prove", { signature: Buffer.alloc(64, 1).toString("base64"), report: report() });
    expect(straight.ok).toBe(false);
    expect(await bare.closed()).toBe(4401);
  });
});

describe("the socket a place proved", () => {
  it("stops being a client's: a runtime frame sent after the prove is never answered", async () => {
    const { hostKey } = await serving();
    const { client } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    // The place door holds this socket now, and what it reads are daemon frames; the runtime answers nothing. The
    // op asked is one that answers off this process alone, so silence is the door and never a read that hung.
    const raced = await Promise.race([client.request("capabilities.get"), new Promise<"silence">(done => setTimeout(() => done("silence"), 300))]);
    expect(raced).toBe("silence");
    // And a socket nothing handed over answers it at once, so the silence above is this socket's and not the op's.
    const mine = await WsClient.connect(srv!.port, { token: "host-token" });
    sockets.push(mine.ws);
    expect((await mine.request("capabilities.get")).ok).toBe(true);
  });

  it("is replaced by a newer link for the same place, since a laptop that slept dials before the old socket is known to be dead", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code() });
    const closed = first.client.closed();
    // A second link proves with the key on record: the same handshake, a fresh socket. The door cuts the first.
    const { client: again } = await relink(hostKey, first.placeId, first.pair);
    sockets.push(again.ws);
    expect(await closed).toBe(1000);
    expect((await placesOf()).find(p => p.id === first.placeId)!.present).toBe(true);
  });

  it("moves the login a turn there runs under onto what the newest link reported", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    joined.client.close();
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === false);
    // The person installed a tool under their home and restarted the agent: the next link is where wsp learns it.
    const moved = report("old-macbook", { login: { HOME: "/home/maya-moved", USER: "maya", PATH: "/home/maya/.npm-global/bin:/usr/bin" }, shape: { cpu: 8, memMb: 8192 } });
    const again = await WsClient.connect(srv!.port);
    sockets.push(again.ws);
    const mine = nonce();
    const challenged = await again.request("place.auth", { placeId: joined.placeId, nonce: mine });
    const proved = await again.request("place.prove", {
      signature: signWith(joined.pair.privateKeyPem, placeLinkTranscript("place", joined.placeId, String(challenged["nonce"]), mine)),
      report: moved,
    });
    expect(proved.ok, String(proved["error"])).toBe(true);
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === true);
    expect((await placesOf()).find(p => p.id === joined.placeId)!.shape).toEqual({ cpu: 8, memMb: 8192 });
    // The workspace standing on it reads the newest login, so every path a turn there runs under moved with it.
    const ws = (await runtime!.workspaces.list()).find(w => w.kind === "place")!;
    await until(async () => (await runtime!.workspaces.get(ws.id)).home === "/home/maya-moved");
    expect((await runtime!.workspaces.get(ws.id)).folder).toBe(workFolderIn("/home/maya-moved"));
  });

  it("marks the place absent when the socket goes, and moves its last seen", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    expect((await placesOf()).find(p => p.id === placeId)!.present).toBe(true);
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    expect((await placesOf()).find(p => p.id === placeId)!.lastSeenAt).toBeDefined();
  });
});

describe("the list of every place", () => {
  it("puts this computer first, the computers joined after it and the provider last, with exactly one default", async () => {
    const { hostKey } = await serving({ provider: { id: "box", rateUsdPerHour: 0.018 } });
    const first = await join(hostKey, { code: await code(), name: "box" });
    sockets.push(first.client.ws);
    const places = await placesOf();
    expect(places.map(p => p.kind)).toEqual(["computer", "computer", "provider"]);
    expect(places[0]).toMatchObject({ id: "here", name: HERE.name, present: true, docker: true });
    expect(places.at(-1)).toMatchObject({ id: "box", kind: "provider", rateUsdPerHour: 0.018 });
    expect(places.filter(p => p.default)).toHaveLength(1);
    expect(places.find(p => p.default)!.id).toBe(first.placeId);
  });

  it("falls back to this computer as the default when the place the mark named is gone", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    joined.client.close();
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === false);
    const removed = await remove(joined.placeId);
    expect(removed["removed"]).toBe(true);
    const places = await placesOf();
    expect(places.find(p => p.default)!.id).toBe("here");
  });

  it("is refused on a socket let in on a ticket, and is no op a thread may send", async () => {
    await serving();
    const host = await WsClient.connect(srv!.port, { token: "host-token" });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(srv!.port, { ticket });
    expect(await relayed.request("places.list")).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    expect(await relayed.request("places.remove", { placeId: "p_1" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    expect(await relayed.request("places.add", { address: "root@10.0.0.9" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    relayed.close();
    expect(THREAD_OPS).not.toContain("places.list");
    expect(THREAD_OPS).not.toContain("places.remove");
    expect(THREAD_OPS).not.toContain("places.add");
  });
});

async function remove(placeId: string): Promise<Record<string, unknown>> {
  const c = await WsClient.connect(srv!.port, { token: "host-token" });
  const answer = await c.request("places.remove", { placeId });
  c.close();
  return answer;
}

describe("taking a place back out", () => {
  it("asks the linked place to sweep itself, drops the workspace standing on it, and answers what came off", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    const before = await runtime!.workspaces.list();
    expect(before.some(w => w.kind === "place")).toBe(true);
    // The place answers place.leave with what its own sweep took; the host never guesses that list.
    client.ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as { id?: number; op?: string };
      if (frame.op === "place.leave") client.ws.send(JSON.stringify({ id: frame.id, ok: true, swept: ["the systemd user unit", "/home/maya/.wsp/place.json"] }));
    });
    const answer = await remove(placeId);
    expect(answer["removed"]).toBe(true);
    expect(answer["swept"]).toEqual(["the systemd user unit", "/home/maya/.wsp/place.json"]);
    expect(String((answer["dropped"] as string[])[0])).toContain("old-macbook");
    expect((await runtime!.workspaces.list()).some(w => w.kind === "place")).toBe(false);
    expect((await placesOf()).some(p => p.id === placeId)).toBe(false);
  });

  it("says the agent is still installed when the place was not connected to sweep", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const answer = await remove(placeId);
    expect(answer["removed"]).toBe(true);
    expect(answer["swept"]).toEqual([]);
    expect(String(answer["note"])).toContain("wsp leave on that computer");
  });

  it("answers that nothing was removed for an id this host holds no place by", async () => {
    await serving();
    expect(await remove("p_deadbeefdeadbeef")).toMatchObject({ removed: false });
  });
});

describe("a workspace on a place", () => {
  it("runs its commands over the link, refuses them with the place's name when it is not connected, and names no pane road yet", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    const ws = (await runtime!.workspaces.list()).find(w => w.kind === "place")!;
    // The exec op the host sends rides the link; the place answers it, so the test answers as the daemon would.
    client.ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as { id?: number; op?: string; cmd?: string };
      if (frame.op === "exec") client.ws.send(JSON.stringify({ id: frame.id, ok: true, exitCode: 0, stdout: `ran ${frame.cmd ?? ""}`, stderr: "", truncated: false }));
    });
    expect(await runtime!.workspaces.exec(ws.id, "hostname")).toMatchObject({ exitCode: 0, stdout: "ran hostname" });
    // The panes wait on a road from this computer to that daemon, which the round that forwards over the link answers.
    await expect(runtime!.workspaces.daemonReach(ws.id)).rejects.toThrow(/old-macbook/);
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    await expect(runtime!.workspaces.exec(ws.id, "hostname")).rejects.toThrow(/is not connected right now/);
    expect(placeDaemonPaths("/home/maya").runDir).toBe("/home/maya/.wsp/run");
  });
});

describe("putting the agent on a computer over ssh", () => {
  it("refuses on a host that wired no road onto a computer it has never met", async () => {
    const { hostKey } = await serving();
    // The wiring this host was served with names no installer, which is every host but the one with the ssh road.
    expect(hostKey).toBeDefined();
    await expect(runtime!.places!.add({ address: "root@10.0.0.9" }, Date.now())).rejects.toThrow(NO_PLACE_INSTALLER);
  });

  it("mints a code the computer spends, says what each step is doing, and answers once that computer's link is up", async () => {
    const hostKey = newPlaceKeyPair();
    const store = memoryStore();
    const stages: PlaceStageEvent[] = [];
    let handed: PlaceInstallRequest | undefined;
    runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          handed = req;
          stage("connect", "done", "Ubuntu 24.04");
          // The computer's own join, with the code the install was handed: the door spends it and the link follows.
          await join(hostKey, { code: req.code, name: "box" });
          return { name: "box", hostKey: "ssh-ed25519 SHA256:abc" };
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    // The caller mints the stream, since the steps come back before the reply that would have named it.
    const added = await runtime.places!.add({ addId: "a_mine", address: "root@10.0.0.9", name: "box" }, Date.now());
    expect(added.place.name).toBe("box");
    expect(added.place.present).toBe(true);
    expect(added.hostKey).toBe("ssh-ed25519 SHA256:abc");
    // The code and every address this host answers on are the door's to hand the installer, not the installer's to find.
    expect(handed?.code).toMatch(/^[A-Z0-9]+$/);
    expect(handed?.hostUrls).toEqual(["http://192.168.1.20:4400"]);
    expect(stages.map(s => `${s.step} ${s.state}`)).toEqual(["connect done", "join running", "join done"]);
    expect(added.addId).toBe("a_mine");
    expect(stages.every(s => s.addId === "a_mine")).toBe(true);
    expect(stages.at(-1)?.note).toContain("cores");
  });

  it("waits for the link the agent dials, not the socket the join itself opened and closed", async () => {
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async req => {
          // What happens on a real computer: its own join dials once, writes its place file and closes that socket,
          // and the unit its join installed is what opens the link a moment later.
          const { client, placeId, pair } = await join(hostKey, { code: req.code, name: "box" });
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === true));
          client.close();
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === false));
          setTimeout(() => void relink(hostKey, placeId, pair).then(({ client: link }) => sockets.push(link.ws)), 20);
          return { name: "box" };
        },
      },
      placeJoinWaitMs: 4_000,
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const added = await runtime.places!.add({ address: "root@10.0.0.9" }, Date.now());
    expect(added.place.present).toBe(true);
  });

  it("names the step an install stopped on, and the code it minted opens nothing afterwards", async () => {
    const hostKey = newPlaceKeyPair();
    const stages: PlaceStageEvent[] = [];
    let minted = "";
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          minted = req.code;
          stage("node", "running");
          throw new Error("ssh refused the login (publickey)");
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await expect(runtime.places!.add({ address: "root@10.0.0.9" }, Date.now())).rejects.toThrow("publickey");
    expect(stages.map(s => `${s.step} ${s.state}`)).toEqual(["node running", "node failed"]);
    expect(stages.at(-1)?.note).toContain("publickey");
    // An install that never reached a join leaves its code unspent, and the person's next add mints another.
    expect(await runtime.devices.spend(minted, 1)).toBe(true);
  });

  it("gives up on a computer that took the agent and never dialled, in the sentence that says what to check", async () => {
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(hostKey), install: async () => ({ name: "box" }) },
      placeJoinWaitMs: 50,
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    await expect(runtime.places!.add({ address: "root@10.0.0.9" }, Date.now())).rejects.toThrow(placeNoLinkLine("box"));
  });

});

describe("the code a person types on the computer they are sitting at", () => {
  it("comes back with every address that computer could dial this host at", async () => {
    await serving();
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    const issued = await c.request("pair.issue");
    c.close();
    expect(issued.ok, String(issued["error"])).toBe(true);
    expect(issued["joinUrls"]).toEqual(["http://192.168.1.20:4400"]);
  });

  it("writes every one of them into the reply a join gets, so the computer keeps dialling when one stops answering", async () => {
    const { hostKey } = await serving();
    const { reply } = await join(hostKey, { code: await code() });
    expect(reply["hostUrls"]).toEqual(["http://192.168.1.20:4400"]);
  });
});

describe("the road a pane takes to a place", () => {
  it("is refused with the place's name while that computer is not connected", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "box" });
    client.close();
    await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === false));
    await expect(runtime!.places!.road(placeId)).rejects.toThrow(placeAbsentLine("box"));
  });

  it("is refused with its own sentence while that computer has not said which port its daemon bound", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "box" });
    await expect(runtime!.places!.road(placeId)).rejects.toThrow(placeNoDaemonPortLine("box"));
  });
});

describe("the port a place's panes ride", () => {
  it("goes with the link that carried it, so nothing is left answering for a computer that is gone", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "box", report: report("box", { daemonPort: 4321 }) });
    const port = await runtime!.places!.road(placeId);
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
