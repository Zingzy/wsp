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
  PLACE_DOOR_REFUSAL,
  PLACE_DOOR_UNSERVED,
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
import { createRuntime, wiredPlace, type Runtime } from "../src/runtime.js";
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

/** The addresses a joining computer is told to dial, as the host's own door answers them: the install is handed
 * them rather than reading them a second time. */
const DOOR = ["http://192.168.1.20:4400"];

const HERE = { name: "zingzys-mac", os: "macOS 15.0", shape: { cpu: 8, memMb: 16384 }, docker: true };

function wiring(hostKey: PlaceKeyPair, provider?: { id: string; rateUsdPerHour: number }): PlaceWiring {
  return { hostKey, provider: () => provider, here: () => HERE, hostName: () => "zingzys-mac" };
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
  agents: [],
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
  opts: { code: string; name?: string; client?: { name: string }; report?: PlaceReport; proveReport?: PlaceReport; expectProved?: boolean; answers?: (c: WsClient) => void } = { code: "" },
): Promise<{ client: WsClient; placeId: string; reply: Record<string, unknown>; proved: Record<string, unknown>; pair: PlaceKeyPair }> {
  const client = await WsClient.connect(srv!.port);
  // What this computer answers is on the socket before the handshake is: the host may send its first frame the
  // moment the prove lands, and a computer that only starts listening afterwards would miss it.
  opts.answers?.(client);
  const pair = newPlaceKeyPair();
  const mine = nonce();
  const sent = opts.report ?? report(opts.name);
  const reply = await client.request("place.join", { code: opts.code, publicKey: pair.publicKey, nonce: mine, report: sent, ...(opts.client === undefined ? {} : { client: opts.client }) });
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
async function relink(
  hostKey: PlaceKeyPair,
  placeId: string,
  pair: PlaceKeyPair,
  sent: PlaceReport = report(),
  answers?: (c: WsClient) => void,
): Promise<{ client: WsClient; proved: Record<string, unknown> }> {
  const client = await WsClient.connect(srv!.port);
  answers?.(client);
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
    await expect(runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow(NO_PLACE_INSTALLER);
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
    const added = await runtime.places!.add({ addId: "a_mine", address: "root@10.0.0.9", name: "box", hostUrls: DOOR }, Date.now());
    expect(added.place.name).toBe("box");
    expect(added.place.present).toBe(true);
    expect(added.hostKey).toBe("ssh-ed25519 SHA256:abc");
    // The code and every address this host answers on are the door's to hand the installer, not the installer's to find.
    expect(handed?.code).toMatch(/^[A-Z0-9]+$/);
    // The door's reading, handed down: the install reads no addresses of its own.
    expect(handed?.hostUrls).toEqual(DOOR);
    expect(stages.map(s => `${s.step} ${s.state}`)).toEqual(["connect done", "join running", "join done"]);
    expect(added.addId).toBe("a_mine");
    expect(stages.every(s => s.addId === "a_mine")).toBe(true);
    // The one fact the box's own row does not already carry: a size here as well cuts the line the app draws.
    expect(stages.at(-1)?.note).toBe("docker yes");
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
    const added = await runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
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
    await expect(runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow("publickey");
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
    await expect(runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow(placeNoLinkLine("box"));
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

describe("the device a join buys beside the place", () => {
  it("mints one with no scope, whose token matches and which is listed and revoked as a redeemed one is", async () => {
    const store = memoryStore();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const admitted = await runtime.devices.admit("old-macbook", 1);
    expect(admitted.device.scope).toBeUndefined();
    expect(await runtime.devices.match(admitted.deviceToken)).toMatchObject({ id: admitted.deviceId, name: "old-macbook" });
    expect((await runtime.devices.list()).map(d => d.id)).toContain(admitted.deviceId);
    expect(await runtime.devices.revoke(admitted.deviceId)).toBe(true);
    expect(await runtime.devices.match(admitted.deviceToken)).toBeUndefined();
  });

  it("answers a join that asked for one, names it after the joining computer, and answers none to a join that did not", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code(), client: { name: "old-macbook" } });
    sockets.push(first.client.ws);
    const device = first.reply["device"] as { deviceId: string; deviceToken: string };
    expect(device.deviceToken).toBeTruthy();
    expect(await runtime!.devices.match(device.deviceToken)).toMatchObject({ id: device.deviceId, name: "old-macbook" });
    const second = await join(hostKey, { code: await code(), name: "attic" });
    sockets.push(second.client.ws);
    expect(second.reply["device"]).toBeUndefined();
  });

  it("leaves the link bound to no device, so revoking that device closes nothing", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), client: { name: "old-macbook" } });
    sockets.push(client.ws);
    const device = (await runtime!.devices.list())[0]!;
    expect(device.name).toBe("old-macbook");
    expect(await runtime!.devices.revoke(device.id)).toBe(true);
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
    const watcher = await WsClient.connect(srv!.port, { token: "host-token" });
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
    const remover = await WsClient.connect(srv!.port, { token: "host-token" });
    expect((await remover.request("places.remove", { placeId })).ok).toBe(true);
    await until(() => watcher.events.some(e => e.type === "place.removed"));
    expect(watcher.events.filter(e => e.type === "place.removed")).toMatchObject([{ placeId }]);
    remover.close();
    watcher.close();
  });
});

describe("the door a computer you own dials", () => {
  it("is refused on a host that serves none, and answered on one that does", async () => {
    await serving();
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    const none = await c.request("places.door");
    expect(none).toMatchObject({ ok: false, error: PLACE_DOOR_UNSERVED });
    c.close();
    await srv!.close();
    const view = { port: 4420, addresses: ["http://192.168.1.20:4420"] };
    srv = await serveRuntime(runtime!, { port: 0, authToken: "host-token", devices: runtime!.devices, door: { open: async () => view } });
    const opened = await WsClient.connect(srv.port, { token: "host-token" });
    const answer = await opened.request("places.door");
    expect(answer).toMatchObject({ ok: true, door: view });
    opened.close();
  });

  it("is refused on a socket let in by a ticket, as every other place op is", async () => {
    await serving();
    await srv!.close();
    srv = await serveRuntime(runtime!, { port: 0, authToken: "host-token", devices: runtime!.devices, door: { open: async () => ({ port: 4420, addresses: ["http://x:4420"] }) } });
    const own = await WsClient.connect(srv.port, { token: "host-token" });
    const { ticket } = (await own.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    own.close();
    const relayed = await WsClient.connect(srv.port, { ticket });
    expect(await relayed.request("places.door")).toMatchObject({ ok: false, error: PLACE_DOOR_REFUSAL });
    relayed.close();
  });
});

/** A joined computer that forks: it answers the machine ops on the socket it opened, as the agent on it does, and
 * records what the host asked it for. Nothing here is the server half itself, which lives with the agent; this is
 * one computer's worth of answers, so the runtime's own roads are what the test is reading. */
interface ForkingPlace {
  created: Record<string, unknown>[];
  killed: string[];
  paused: number;
  resumed: number;
  snapshots: string[];
  tunnels: { tunnelId: string; port: number }[];
  /** What the next create answers with instead of a machine; cleared after one use. */
  refuseCreate?: { error: string; kind: string; status: number };
  /** Every op the host sent, in order. */
  ops: string[];
  /** How many times each op was asked. */
  asked: Record<string, number>;
  /** The ask of the machine's own daemon check that first answers yes; every one before it answers no. */
  daemonAnswersAfter: number;
  /** Holds every resume frame until it is called, for a wake a test wants in flight. */
  holdResumes(): () => void;
}

const PLACE_FACTS = {
  offer: "docker",
  capabilities: {
    liveCloneForks: false,
    pauseMode: "memory",
    resize: false,
    replacesMachine: true,
    previewUrls: false,
    signedUrls: false,
    containers: false,
    callbackRelay: true,
    diskSnapshots: true,
    snapshotListing: true,
    templates: true,
    kept: false,
    sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0 }],
  },
  pricing: { defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" } },
  lifecycle: { budgets: { wakeAttempts: 1, daemonAnswersMs: 30_000 } },
  baseTemplates: { sandbox: "ubuntu:24.04", desktop: "ubuntu:24.04" },
};

const PLACE_ROADS = { previewUrl: true, daemonAnswers: true, putBytes: true, describe: true, facts: true, metrics: true };

function forks(
  client: WsClient,
  capacity: {
    cores: number;
    memMb: number;
    memRoomMb: number;
    machineMemMb: number;
    diskFreeBytes: number;
    images: { id: string; sizeBytes: number }[];
    machines: { running: number; paused: number };
  } = {
    cores: 4,
    memMb: 8192,
    memRoomMb: 9000,
    machineMemMb: 4096,
    diskFreeBytes: 10 * 1024 * 1024 * 1024,
    images: [{ id: "sha256:i", sizeBytes: 4 * 1024 * 1024 * 1024 }],
    machines: { running: 1, paused: 0 },
  },
): ForkingPlace {
  let held: ((...args: never[]) => void)[] | undefined;
  const seen: ForkingPlace = {
    created: [],
    killed: [],
    paused: 0,
    resumed: 0,
    snapshots: [],
    tunnels: [],
    ops: [],
    asked: {},
    daemonAnswersAfter: 1,
    holdResumes: () => {
      held = [];
      return () => {
        for (const release of held ?? []) release();
        held = undefined;
      };
    },
  };
  let made = 0;
  // The container's own word for itself, as a Docker daemon would answer it: a wake reads it before it resumes.
  let state: "running" | "paused" = "running";
  client.ws.on("message", raw => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    const op = typeof frame["op"] === "string" ? frame["op"] : undefined;
    if (op === undefined) return;
    const id = frame["id"];
    const say = (payload: Record<string, unknown>): void => client.ws.send(JSON.stringify({ id, ok: true, ...payload }));
    const machine = (machineId: string): Record<string, unknown> => ({ machine: { id: machineId, kind: "sandbox", daemonSupervisor: "entrypoint", roads: PLACE_ROADS } });
    if (op.startsWith("machine.") || op.startsWith("tunnel.")) seen.ops.push(op);
    seen.asked[op] = (seen.asked[op] ?? 0) + 1;
    switch (op) {
      case "machine.backend":
        return say(PLACE_FACTS);
      case "machine.capacity":
        return say(capacity);
      case "machine.create": {
        if (seen.refuseCreate !== undefined) {
          const refusal = seen.refuseCreate;
          delete seen.refuseCreate;
          return void client.ws.send(JSON.stringify({ id, ok: false, ...refusal }));
        }
        seen.created.push(frame["spec"] as Record<string, unknown>);
        return say(machine(`k${++made}`));
      }
      case "machine.get":
        return say(machine(String(frame["machineId"])));
      case "machine.state":
        return say({ state });
      case "machine.exec":
        return say({ result: { exitCode: 0, stdout: "", stderr: "" } });
      case "machine.describe":
        return say({ shape: { cpu: 2, memMb: 4096 } });
      case "machine.facts":
        return say({ facts: { os: "Ubuntu 24.04", uptimeMs: 1000, folder: "/root" } });
      case "machine.metrics":
        return say({});
      case "machine.daemonAnswers":
        return say({ answers: (seen.asked[op] ?? 0) >= seen.daemonAnswersAfter });
      case "machine.previewUrl":
        return say({ reach: { url: "http://127.0.0.1:49155", token: "", expiresAt: 1 } });
      case "machine.snapshot":
        seen.snapshots.push(String(frame["name"]));
        return say({ snapshotId: `sha256:${String(frame["name"])}` });
      case "machine.pause":
        seen.paused++;
        state = "paused";
        return say({});
      case "machine.resume": {
        seen.resumed++;
        state = "running";
        if (held === undefined) return say({});
        held.push(() => say({}));
        return;
      }
      case "machine.kill":
        seen.killed.push(String(frame["machineId"]));
        return say({});
      case "machine.putBytes":
        return say({});
      // A container mints no signed URL, as the Docker machine's own answer says; a nap that would have exported a
      // vault through one reads the refusal and keeps the vault it had.
      case "machine.downloadUrl":
      case "machine.uploadUrl":
        return void client.ws.send(JSON.stringify({ id, ok: false, error: "a container serves no signed URL" }));
      case "tunnel.open":
        seen.tunnels.push({ tunnelId: String(frame["tunnelId"]), port: Number(frame["port"]) });
        return say({});
      case "tunnel.write":
      case "tunnel.close":
        return say({});
      case "exec":
        return say({ exitCode: 0, stdout: "", stderr: "", truncated: false });
      default:
        return;
    }
  });
  return seen;
}

describe("a fork on a computer you joined", () => {
  it("lands on that computer's backend and not on this host's, and the record and the view say where", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store, adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const made = await runtime.workspaces.create({ golden: "snap_g", name: "x", on: "srv" });
    expect(place.created).toHaveLength(1);
    expect(backend.machines).toHaveLength(0);
    expect(made.place).toBe(placeId);
    expect((await runtime.workspaces.get(made.id)).place).toBe(placeId);
    expect(await store.get("workspaces", made.id)).toMatchObject({ place: placeId });
    // The place a fork landed on is where the next one lands when nobody says.
    expect((await placesOf()).find(p => p.default)!.id).toBe(placeId);
  });

  it("says the computer it was forked on where a record names one, and this host's own provider otherwise", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, places: wiredPlace("solari", backend), placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    const there = await runtime.workspaces.create({ golden: "snap_g", name: "x", on: "srv" });
    // The fork stands on a computer that offers Docker, and this host forks at Solari: the row says Docker, which
    // is what made it, and place says which computer it is on.
    expect(there.provider).toBe("docker");
    expect(there.place).toBeDefined();
    await runtime.places!.markUsed(undefined);
    const here = await runtime.workspaces.create({ golden: "snap_g", name: "y" });
    expect(here.provider).toBe("solari");
    expect(here.place).toBeUndefined();
    // A computer the person owns is forked by nobody, so it names no provider at all.
    expect((await runtime.workspaces.list()).find(w => w.kind === "place")!.provider).toBeUndefined();
  });

  it("takes the default place when nobody names one, and the host's own provider when that is the default", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    await runtime.workspaces.create({ golden: "snap_g", name: "x" });
    expect(place.created).toHaveLength(1);
    expect(backend.machines).toHaveLength(0);
    // The provider named as the place a fork lands on: the host's own backend takes it and the record carries none.
    await runtime.places!.markUsed(undefined);
    const second = await runtime.workspaces.create({ golden: "snap_g", name: "y" });
    expect(backend.machines).toHaveLength(1);
    expect(second.place).toBeUndefined();
    expect(place.created).toHaveLength(1);
  });

  it("refuses a word that names no place, and names what this host holds", async () => {
    const { hostKey } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 } });
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    await expect(runtime!.workspaces.create({ golden: "snap_g", name: "x", on: "nowhere" })).rejects.toThrow(/no place named nowhere; you have .*srv.*solari/);
  });

  it("refuses a computer that forks nowhere, in its own words", async () => {
    const { hostKey } = await serving();
    const { client } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { docker: false }), answers: c => forks(c) });
    sockets.push(client.ws);
    await expect(runtime!.workspaces.create({ golden: "snap_g", name: "x", on: "srv" })).rejects.toThrow(/srv runs your agents but has no Docker/);
    expect((await runtime!.workspaces.list()).filter(w => w.name === "x")).toEqual([]);
  });

  it("names the wall when that computer holds no copy of the image, and records nothing", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    place.refuseCreate = { error: "no such image: snap_g", kind: "missing", status: 404 };
    await expect(runtime!.workspaces.create({ golden: "snap_g", name: "x", on: "srv" })).rejects.toThrow(/srv holds no copy of snap_g/);
    expect((await runtime!.workspaces.list()).filter(w => w.name === "x")).toEqual([]);
  });

  it("gives the daemon on a machine that was stopped the whole budget to answer, rather than one ask at the start", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const made = await runtime.workspaces.create({ golden: "snap_g", name: "x", on: "srv" });
    await runtime.workspaces.nap(made.id);
    // The daemon says no to the wake's first ask and yes to its second, which is a container still coming up off
    // its own layers; the machine that comes back is the one that napped and not a fresh fork of the image.
    const asked = place.asked["machine.daemonAnswers"] ?? 0;
    place.daemonAnswersAfter = asked + 2;
    expect((await runtime.workspaces.wake(made.id)).machineId).toBe(made.machineId);
    expect(place.asked["machine.daemonAnswers"]).toBeGreaterThan(asked + 1);
  });

  it("naps and wakes on that computer and never on this host's provider", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const made = await runtime.workspaces.create({ golden: "snap_g", name: "x", on: "srv" });
    await runtime.workspaces.nap(made.id);
    expect(place.paused).toBe(1);
    await runtime.workspaces.wake(made.id);
    expect(place.resumed).toBe(1);
    expect(backend.machines).toHaveLength(0);
  });

  it("takes a snapshot of a fork on that computer there, and asks this host's provider for none", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store, adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    // A fork of a project golden carries that project from birth, which is what the verb names the image after;
    // nothing is imported here, since what this test reads is which computer the snapshot is taken on.
    await store.put("project-goldens", "snap_p", {
      snapshotId: "snap_p",
      golden: "snap_g",
      projects: [{ name: "proj", dest: "/root/proj", importedAt: "2026-09-12T00:00:00.000Z", size: 20 }],
      workspaceId: "ws_older",
      workspaceName: "older",
      createdAt: "2026-09-12T00:00:00.000Z",
    });
    const made = await runtime.workspaces.create({ golden: "snap_p", name: "x", on: "srv" });
    const golden = await runtime.workspaces.snapshot(made.id);
    expect(place.snapshots).toHaveLength(1);
    expect(place.snapshots[0]).toContain("proj");
    expect(golden.snapshotId).toBe(`sha256:${place.snapshots[0]!}`);
    expect(backend.snapshots).toEqual([]);
  });

  it("says the computer is not connected rather than asking the provider anything, and reads it again when it is back", async () => {
    const { hostKey } = await serving();
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    const made = await runtime!.workspaces.create({ golden: "snap_g", name: "x", on: "srv" });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const away = (await runtime!.status.list()).find(r => r.id === made.id)!;
    expect(away.reach.state).toBe("unreachable");
    expect(away.reason).toContain("srv is not connected right now");
    expect(away.machineState).toBe("running");
    const back = await relink(hostKey, placeId, key, report("srv"), c => forks(c));
    sockets.push(back.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    await until(async () => (await runtime!.status.list()).find(r => r.id === made.id)!.reach.state !== "unreachable");
  });

  it("leaves a fork that was live through the blip alone, wake and all, when its computer dials again", async () => {
    const { hostKey } = await serving();
    let first!: ForkingPlace;
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => (first = forks(c)) });
    sockets.push(client.ws);
    const made = await runtime!.workspaces.create({ golden: "snap_g", name: "x", on: "srv" });
    await runtime!.workspaces.nap(made.id);
    // A wake in flight across the relink: the machine resumes and its daemon says no, so the wake is still asking
    // when the computer's new socket lands.
    first.daemonAnswersAfter = Number.MAX_SAFE_INTEGER;
    const waking = runtime!.workspaces.wake(made.id);
    await until(async () => first.resumed === 1);
    let second!: ForkingPlace;
    const back = await relink(hostKey, placeId, key, report("srv"), c => (second = forks(c)));
    sockets.push(back.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    // The second caller joins the wake in flight rather than finding a record the presence beat replaced.
    const joined = runtime!.workspaces.wake(made.id);
    expect((await waking).id).toBe(made.id);
    expect((await joined).id).toBe(made.id);
    // One resume and one create between the two sockets: the wake was joined, not started again, and nothing
    // forked the image afresh behind it.
    expect(first.resumed + second.resumed).toBe(1);
    expect(first.created.length + second.created.length).toBe(1);
    // And the record was never read again off the store: a fork this host was holding live is left exactly as it
    // is, which is what keeps the wake, the nap and the delete in flight from being thrown away by a beat.
    expect(second.ops).not.toContain("machine.get");
  });

  it("holds a fork on a computer that is away at host start, and reads its machine once it dials in", async () => {
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const first = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(first.client.ws);
    const made = await runtime.workspaces.create({ golden: "snap_g", name: "x", on: "srv" });
    await runtime.workspaces.nap(made.id);
    first.client.close();
    await srv.close();
    await runtime.close();
    // A second host over the same store, with that computer away: the record keeps the word it was left with.
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    expect((await runtime.workspaces.get(made.id)).phase).toBe("napping");
    let place!: ForkingPlace;
    const back = await relink(hostKey, first.placeId, first.pair, report("srv"), c => (place = forks(c)));
    sockets.push(back.client.ws);
    await until(async () => place.ops.includes("machine.get"));
  });

  it("carries one port on this computer to one port on that one, for as long as the host runs", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const first = await runtime!.places!.forward(placeId, 32768);
    const again = await runtime!.places!.forward(placeId, 32768);
    expect(again.localPort).toBe(first.localPort);
    await dialLocal(first.localPort);
    await until(async () => place.tunnels.some(t => t.port === 32768));
    // The listener stays bound while that computer is away: the route this host handed out keeps its port.
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    await expect(dialLocal(first.localPort, true)).resolves.toBe("cut");
    let second!: ForkingPlace;
    const back = await relink(hostKey, placeId, key, report("srv"), c => (second = forks(c)));
    sockets.push(back.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    expect((await runtime!.places!.forward(placeId, 32768)).localPort).toBe(first.localPort);
    await dialLocal(first.localPort);
    await until(async () => second.tunnels.some(t => t.port === 32768));
  });

  it("counts a napping fork in the column too, so it agrees with the workspace list", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      // One running and one napping machine on that computer, as its own backend counts them under a stopping nap.
      answers: c =>
        forks(c, {
          cores: 4,
          memMb: 8192,
          memRoomMb: 9000,
          machineMemMb: 4096,
          diskFreeBytes: 10 * 1024 * 1024 * 1024,
          images: [{ id: "sha256:i", sizeBytes: 4 * 1024 * 1024 * 1024 }],
          machines: { running: 1, paused: 1 },
        }),
    });
    sockets.push(client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.forks !== undefined);
    expect((await placesOf()).find(p => p.id === placeId)!.forks).toEqual({ running: 2, room: 2 });
  });

  it("shows how many forks a place holds of how many it takes", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.forks !== undefined);
    // Nine thousand megabytes of room at four thousand a fork is two; ten gigabytes of disk at four an image is two.
    expect((await placesOf()).find(p => p.id === placeId)!.forks).toEqual({ running: 1, room: 2 });
  });

  it("refuses to take a computer out from under the forks standing on it, and sweeps nothing", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const swept: string[] = [];
    client.ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as { op?: string };
      if (frame.op === "place.leave") swept.push("asked");
    });
    await runtime!.workspaces.create({ golden: "snap_g", name: "x", on: "srv" });
    await expect(runtime!.places!.remove(placeId)).rejects.toThrow(/srv still holds a fork \(x\); delete them first/);
    expect(swept).toEqual([]);
    expect(place.killed).toEqual([]);
  });
});

/** One connection to a port this host is forwarding; answers what it read, or "cut" when the far side refused it. */
function dialLocal(port: number, expectCut = false): Promise<string> {
  return new Promise((done, fail) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.on("error", e => (expectCut ? done("cut") : fail(e)));
    socket.on("close", () => done(expectCut ? "cut" : "closed"));
    socket.on("connect", () => {
      socket.write("hello");
      if (!expectCut) setTimeout(() => socket.destroy(), 60);
    });
  });
}
