// SPDX-License-Identifier: AGPL-3.0-only
// The host's side of a place: the handshake a joining computer takes, the
// records and links the door holds, the workspace a join records, and the two
// ops a person's own socket reaches. The signatures here are real ed25519
// ones, so what the door verifies is what a place would send.
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
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
  DAEMON_VERSION,
  placeCurrentLine,
  THREAD_OPS,
  placeDaemonPaths,
  absentComputer,
  placeBuildsNoImageLine,
  placeForksNowhereLine,
  placeCannotBootLine,
  placeNotAWorkspaceLine,
  placeNotAWorkspaceFix,
  workspaceState,
  placeLinkTranscript,
  joinToken,
  readJoinToken,
  placeNoDaemonPortLine,
  placeNoLinkLine,
  placeDialBackLine,
  workFolderIn,
  copyStoppedLine,
  type GoldenStageEvent,
  type PlaceStageEvent,
  type PlaceReport,
  type PlaceView,
} from "@wsp/protocol";
import { createRuntime, wiredPlace, type GoldenRecipe, type PlaceBackends, type Runtime } from "../src/runtime.js";
import { COPY_RECIPE, dfOk, recipeWith } from "./image-fixtures.js";
import { NoProviderBackend, keyFingerprint, type MachineBackend } from "@wsp/engine";
import { NO_PLACE_UPDATER, newPlaceKeyPair, type PlaceInstallRequest, type PlaceKeyPair, type PlaceUpdateRequest, type PlaceUpdater, type PlaceWiring } from "../src/places.js";
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

const HERE = { name: "zingzys-mac", os: "macOS 15.0", shape: { cpu: 8, memMb: 16384 }, engine: "docker" as const };

function wiring(hostKey: PlaceKeyPair, provider?: { id: string; rateUsdPerHour: number }, update?: PlaceUpdater): PlaceWiring {
  return { hostKey, provider: () => provider, here: () => HERE, hostName: () => "zingzys-mac", ...(update === undefined ? {} : { update }) };
}

const report = (name = "old-macbook", over: Partial<PlaceReport> = {}): PlaceReport => ({
  name,
  platform: "linux",
  arch: "x64",
  os: "Ubuntu 24.04",
  shape: { cpu: 4, memMb: 4096 },
  diskFreeBytes: 831 * 1024 * 1024 * 1024,
  login: { HOME: "/home/maya", USER: "maya", PATH: "/usr/bin" },
  runsWorkspaces: true,
  engine: "none",
  daemonVersion: 17,
  agents: [],
  wsp: ["/home/maya/.npm-global/bin/wsp"],
  dialed: "http://192.168.1.20:14621",
  ...over,
});

async function serving(opts: { provider?: { id: string; rateUsdPerHour: number }; store?: Store; relinkWaitMs?: number; update?: PlaceUpdater; updateWaitMs?: number } = {}): Promise<{ hostKey: PlaceKeyPair; store: Store }> {
  const store = opts.store ?? memoryStore();
  const hostKey = newPlaceKeyPair();
  runtime = createRuntime({
    backend: stubBackend(),
    store,
    adapters: {},
    placeLinks: wiring(hostKey, opts.provider, opts.update),
    ...(opts.relinkWaitMs !== undefined ? { placeRelinkWaitMs: opts.relinkWaitMs } : {}),
    ...(opts.updateWaitMs !== undefined ? { placeUpdateWaitMs: opts.updateWaitMs } : {}),
  });
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
    expect(second.placeId).toMatch(/^p_[0-9a-f]{16}$/);
    expect((await placesOf()).filter(p => p.name === "old-macbook")).toHaveLength(2);
  });

  it("spends the code, records the place with its key and report, marks it default, and records no workspace of its own", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    expect(placeId).toMatch(/^p_[0-9a-f]{16}$/);
    const places = await placesOf();
    const row = places.find(p => p.id === placeId)!;
    expect(row).toMatchObject({ kind: "computer", name: "old-macbook", default: true, takesForks: true, os: "Ubuntu 24.04", present: true });
    expect(row.shape).toEqual({ cpu: 4, memMb: 4096 });
    // The computer is a place, not a workspace: nothing is on the sidebar or in wsp workspaces until a fork lands.
    expect(await runtime!.workspaces.list()).toEqual([]);
  });

  it("refuses a computer whose kernel cannot boot the image, in the doctor's own sentence, and writes no record for it", async () => {
    const { hostKey, store } = await serving();
    const blocked = "this computer's kernel has no overlay filesystem, which wsp stacks a workspace's layers on";
    const { client, reply } = await join(hostKey, { code: await code(), report: report("laptop", { runsWorkspaces: false, workspacesBlocked: blocked }) });
    sockets.push(client.ws);
    expect(String(reply["error"])).toBe(placeCannotBootLine("laptop", blocked));
    expect((await placesOf()).filter(p => p.id !== "here")).toEqual([]);
    expect(await store.list("places")).toEqual([]);
  });

  it("names a word that is a place and not a workspace with the road to a workspace there, rather than calling it missing", async () => {
    const { hostKey } = await serving();
    const { client } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    // What wsp run <place> and wsp exec <place> meet: both resolve their target through this one reading.
    await expect(runtime!.workspaces.resolve("old-macbook")).rejects.toThrow(placeNotAWorkspaceLine("old-macbook"));
    await expect(runtime!.workspaces.resolve("old-macbook")).rejects.toThrow(placeNotAWorkspaceFix("old-macbook"));
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
    // Nothing was attached and the record kept the home the join proved, not the one the slipped report carried.
    expect((await placesOf()).find(p => p.id === slipped.placeId)!.present).toBe(false);
    expect((await runtime!.places!.reportOf(slipped.placeId))!.login["HOME"]).toBe("/home/maya");
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
    expect((await runtime!.places!.reportOf(joined.placeId))!.login["HOME"]).toBe("/home/maya");
  });

  it("turns a linked box down the moment it says its kernel no longer boots the image, and keeps the sentence on the row", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code(), answers: c => forks(c) });
    sockets.push(joined.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === true);
    const BLOCKED = "this computer's kernel has no overlay filesystem, which wsp stacks a workspace's layers on";
    const again = await relink(hostKey, joined.placeId, joined.pair, report("old-macbook", { runsWorkspaces: false, workspacesBlocked: BLOCKED }));
    // The same sentence the join would have refused with: one gate, read on the join and on every link after it.
    expect(again.proved).toMatchObject({ ok: false });
    expect(String(again.proved["error"])).toBe(placeCannotBootLine("old-macbook", BLOCKED));
    expect(await again.client.closed()).toBe(4401);
    // The link is cut and the row says why, where every other refusal of a dial is kept; no forks-nowhere row and
    // no place that reads present while nothing can be asked of it.
    await until(async () => {
      const at = (await placesOf()).find(p => p.id === joined.placeId)!;
      return at.present === false && at.dialled !== undefined;
    });
    const row = (await placesOf()).find(p => p.id === joined.placeId)!;
    expect(row.dialled).toMatchObject({ answered: false, said: placeCannotBootLine("old-macbook", BLOCKED) });
    expect(row.takesForks).toBe(true);
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

  it("records a second computer under a name another place already holds, since a place is no workspace and ids tell them apart", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code() });
    sockets.push(first.client.ws);
    const second = await join(hostKey, { code: await code() });
    sockets.push(second.client.ws);
    expect(second.reply["notice"]).toBeUndefined();
    expect((await placesOf()).filter(p => p.name === "old-macbook").map(p => p.id).sort()).toEqual([first.placeId, second.placeId].sort());
    expect(await runtime!.workspaces.list()).toEqual([]);
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
    // The record reads the newest login, so every path a fork there is built from moved with it.
    await until(async () => (await runtime!.places!.reportOf(joined.placeId))!.login["HOME"] === "/home/maya-moved");
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
    expect(places[0]).toMatchObject({ id: "here", name: HERE.name, present: true, takesForks: false });
    expect(places.at(-1)).toMatchObject({ id: "box", kind: "provider", rateUsdPerHour: 0.018, takesForks: true });
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
    expect(await relayed.request("places.dial", { placeId: "p_1" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
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

describe("moving a place onto the daemon this host deploys", () => {
  /** What the host's own updater does, in miniature: the binary in parts over the link the place is holding, each
   * under one upload id with the sha256 of the whole, and the path the place answered with. */
  const overTheLink = (bytes: Uint8Array, asked: { req: PlaceUpdateRequest }[]): PlaceUpdater => async req => {
    asked.push({ req });
    const half = Math.ceil(bytes.length / 2);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let at = "";
    for (const [seq, part] of [bytes.subarray(0, half), bytes.subarray(half)].entries()) {
      const answer = await req.link!.request("place.update", { uploadId: "u1", seq, last: seq === 1, data: Buffer.from(part).toString("base64"), sha256 });
      at = typeof answer["at"] === "string" ? answer["at"] : at;
    }
    return { road: "link", at };
  };

  /** A place that takes the parts as the daemon does: appended in order, and the last one answered with where the
   * binary landed. What it was sent is kept so the test can read the whole of it back. */
  const takesParts = (landed: Buffer[], sent: { sha256: string[]; uploads: string[] }) => (c: WsClient): void => {
    c.ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as { id?: number; op?: string; data?: string; sha256?: string; uploadId?: string; last?: boolean };
      if (frame.op !== "place.update") return;
      landed.push(Buffer.from(String(frame.data), "base64"));
      sent.sha256.push(String(frame.sha256));
      sent.uploads.push(String(frame.uploadId));
      c.ws.send(JSON.stringify({ id: frame.id, ok: true, ...(frame.last === true ? { at: "/home/maya/.wsp/daemon/wsp-daemon", kept: "/home/maya/.wsp/daemon/wsp-daemon.old" } : {}) }));
    });
  };

  const update = async (placeId: string): Promise<Record<string, unknown>> => {
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    const answer = await c.request("places.update", { placeId });
    c.close();
    return answer;
  };

  it("puts the binary over the link as bytes, and the row reads the new version once that computer dials back on it", async () => {
    const binary = Buffer.from("a daemon built for this box's chip, twice as long as one part");
    const asked: { req: PlaceUpdateRequest }[] = [];
    const { hostKey } = await serving({ update: overTheLink(binary, asked), updateWaitMs: 5_000 });
    const landed: Buffer[] = [];
    const sent = { sha256: [] as string[], uploads: [] as string[] };
    const behind = report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 });
    const { client, placeId, pair } = await join(hostKey, { code: await code(), report: behind, answers: takesParts(landed, sent) });
    sockets.push(client.ws);

    // The computer restarts its agent on the new binary and dials back saying so, which is what the wait is for.
    const back = setTimeout(() => {
      client.close();
      void relink(hostKey, placeId, pair, report("old-macbook", { daemonVersion: DAEMON_VERSION })).then(({ client: fresh }) => sockets.push(fresh.ws));
    }, 200);
    back.unref?.();
    const answer = await update(placeId);

    expect(answer.ok, String(answer["error"])).toBe(true);
    expect(answer["name"]).toBe("old-macbook");
    expect(answer["from"]).toBe(DAEMON_VERSION - 1);
    expect(answer["to"]).toBe(DAEMON_VERSION);
    expect(answer["road"]).toBe("link");
    expect(answer["at"]).toBe("/home/maya/.wsp/daemon/wsp-daemon");
    // The row a person reads says it too, and says nothing about being behind any more.
    const row = (await placesOf()).find(p => p.id === placeId)!;
    expect(row.daemonVersion).toBe(DAEMON_VERSION);

    // The binary arrived whole, in order, as bytes on the link and never as a command: two parts under one upload
    // id, each carrying the sha256 of the whole, and what landed is byte for byte what was sent.
    expect(landed).toHaveLength(2);
    expect(Buffer.concat(landed)).toEqual(binary);
    expect(new Set(sent.uploads)).toEqual(new Set(["u1"]));
    expect(new Set(sent.sha256)).toEqual(new Set([createHash("sha256").update(binary).digest("hex")]));
    // The updater is told what the place said about itself, which is how the chip is picked, and handed the link.
    expect(asked).toHaveLength(1);
    expect(asked[0]!.req.report.arch).toBe("x64");
    expect(asked[0]!.req.name).toBe("old-macbook");
  });

  it("answers what the row still reads, with the reason, when the computer has not come back on it inside the wait", async () => {
    const asked: { req: PlaceUpdateRequest }[] = [];
    const { hostKey } = await serving({ update: overTheLink(Buffer.from("a daemon"), asked), updateWaitMs: 300 });
    const behind = report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 });
    const { client, placeId } = await join(hostKey, { code: await code(), report: behind, answers: takesParts([], { sha256: [], uploads: [] }) });
    sockets.push(client.ws);
    const answer = await update(placeId);
    expect(answer.ok, String(answer["error"])).toBe(true);
    // Nothing failed: the binary landed and the row moves on the computer's next link, which the note says.
    expect(answer["to"]).toBe(DAEMON_VERSION - 1);
    expect(String(answer["note"])).toContain("had not dialled back on it within");
  });

  it("refuses a place already running this daemon before it picks up a byte, and one this host does not hold", async () => {
    const asked: { req: PlaceUpdateRequest }[] = [];
    const { hostKey } = await serving({ update: overTheLink(Buffer.from("a daemon"), asked) });
    const level = report("old-macbook", { daemonVersion: DAEMON_VERSION });
    const { client, placeId } = await join(hostKey, { code: await code(), report: level });
    sockets.push(client.ws);
    const answer = await update(placeId);
    expect(answer.ok).toBe(false);
    expect(answer["error"]).toBe(placeCurrentLine("old-macbook", DAEMON_VERSION));
    expect(asked).toEqual([]);
    const nowhere = await update("p_nothing");
    expect(nowhere.ok).toBe(false);
    expect(String(nowhere["error"])).toContain("p_nothing");
  });

  it("says so plainly on a host wired with no road to put a daemon on a computer", async () => {
    const { hostKey } = await serving();
    const behind = report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 });
    const { client, placeId } = await join(hostKey, { code: await code(), report: behind });
    sockets.push(client.ws);
    const answer = await update(placeId);
    expect(answer.ok).toBe(false);
    expect(answer["error"]).toBe(NO_PLACE_UPDATER);
  });
});

describe("taking a place back out", () => {
  it("asks the linked place to sweep itself, drops the workspace standing on it, and answers what came off", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    // The place answers place.leave with what its own sweep took; the host never guesses that list.
    client.ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as { id?: number; op?: string };
      if (frame.op === "place.leave") client.ws.send(JSON.stringify({ id: frame.id, ok: true, swept: ["the systemd user unit", "/home/maya/.wsp/place.json"] }));
    });
    const answer = await remove(placeId);
    expect(answer["removed"]).toBe(true);
    expect(answer["swept"]).toEqual(["the systemd user unit", "/home/maya/.wsp/place.json"]);
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

describe("dialling a computer that stopped answering", () => {
  /** The one road the app's Try now takes, over the person's own socket. */
  const dialled = async (placeId: string): Promise<Record<string, unknown>> => {
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    const answer = await c.request("places.dial", { placeId });
    c.close();
    expect(answer.ok, String(answer["error"])).toBe(true);
    return answer;
  };

  it("sends one frame over the link a computer is holding and answers how long it took", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      answers: c =>
        c.ws.on("message", raw => {
          const frame = JSON.parse(String(raw)) as { id?: number; op?: string };
          if (frame.op === "ping") c.ws.send(JSON.stringify({ id: frame.id, ok: true }));
        }),
    });
    sockets.push(client.ws);
    const answer = await dialled(placeId);
    expect(answer["dialled"]).toMatchObject({ answered: true });
    expect((answer["dialled"] as { roundTripMs: number }).roundTripMs).toBeGreaterThanOrEqual(0);
    expect(String(answer["line"])).toContain("old-macbook answered");
    // The answer is written on the row, so a window opened after the press reads what the press got.
    expect((answer["place"] as PlaceView).dialled).toMatchObject({ answered: true });
  });

  it("logs in over the road the computer was installed on when it is holding no link, and says the computer is on", async () => {
    const hostKey = newPlaceKeyPair();
    const logins: { ssh: string; keyPath?: string }[] = [];
    let box: WsClient | undefined;
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          box = (await join(hostKey, { code: readJoinToken(req.code).code, name: "vps" })).client;
          return { name: "vps", ssh: "root@65.21.4.12" };
        },
        dial: async login => {
          logins.push(login);
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const added = await runtime.places!.add({ address: "root@65.21.4.12", hostUrls: DOOR }, Date.now());
    // The login the install used is kept on the row: the join frame the record was made from says nothing about it.
    expect(added.place.road?.ssh).toBe("root@65.21.4.12");
    box?.close();
    await until(async () => (await placesOf()).find(p => p.id === added.place.id)!.present === false);
    const answer = await dialled(added.place.id);
    expect(logins).toEqual([{ ssh: "root@65.21.4.12" }]);
    expect(answer["dialled"]).toMatchObject({ answered: true });
    expect(String(answer["line"])).toContain("the agent on it is not dialling this host");
    // An ssh login that answered is the box speaking and not the agent, so it does not date the silence.
    expect((answer["place"] as PlaceView).present).toBe(false);
  });

  it("dials with the key file the add was given, since every ssh child runs with BatchMode on", async () => {
    const hostKey = newPlaceKeyPair();
    const logins: { ssh: string; keyPath?: string }[] = [];
    let box: WsClient | undefined;
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          box = (await join(hostKey, { code: readJoinToken(req.code).code, name: "vps" })).client;
          return { name: "vps", ssh: "root@65.21.4.12", ...(req.keyPath === undefined ? {} : { sshKeyPath: req.keyPath }) };
        },
        dial: async login => {
          logins.push(login);
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const added = await runtime.places!.add({ address: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner", hostUrls: DOOR }, Date.now());
    box?.close();
    await until(async () => (await placesOf()).find(p => p.id === added.place.id)!.present === false);
    await dialled(added.place.id);
    expect(logins).toEqual([{ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" }]);
    // A path on this computer is the host's business: the row a client reads carries the login and the address the
    // link came from, and never the key file.
    const road = (await placesOf()).find(p => p.id === added.place.id)!.road!;
    expect(road.ssh).toBe("root@65.21.4.12");
    expect(Object.keys(road).sort()).toEqual(["from", "ssh"]);
  });

  it("hands back ssh's own sentence when the login is refused, and keeps it on the row", async () => {
    const hostKey = newPlaceKeyPair();
    let box: WsClient | undefined;
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          box = (await join(hostKey, { code: readJoinToken(req.code).code, name: "vps" })).client;
          return { name: "vps", ssh: "root@65.21.4.12" };
        },
        dial: () => Promise.reject(new Error(said)),
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const added = await runtime.places!.add({ address: "root@65.21.4.12", hostUrls: DOOR }, Date.now());
    box?.close();
    await until(async () => (await placesOf()).find(p => p.id === added.place.id)!.present === false);
    const answer = await dialled(added.place.id);
    expect(answer["dialled"]).toMatchObject({ answered: false, said });
    expect(String(answer["line"])).toBe(said);
    // And it stands on the row after the press, which is what the sentence under the pane reads back.
    expect((await placesOf()).find(p => p.id === added.place.id)!.dialled).toMatchObject({ said });
  });

  it("drops what the last dial said when the computer dials in again, since a refusal from before it came back is not news", async () => {
    const { hostKey } = await serving();
    const { client, placeId, pair } = await join(hostKey, { code: await code() });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    await dialled(placeId);
    expect((await placesOf()).find(p => p.id === placeId)!.dialled).toBeDefined();
    const back = await relink(hostKey, placeId, pair);
    sockets.push(back.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    expect((await placesOf()).find(p => p.id === placeId)!.dialled).toBeUndefined();
  });

  it("bounds the dial itself, so a road that hangs rather than refusing still answers the hand that pressed", async () => {
    const hostKey = newPlaceKeyPair();
    let box: WsClient | undefined;
    runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeDialWaitMs: 60,
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          box = (await join(hostKey, { code: readJoinToken(req.code).code, name: "vps" })).client;
          return { name: "vps", ssh: "root@65.21.4.12" };
        },
        // A road that neither answers nor refuses: an ssh child on a network that swallows the packets.
        dial: () => new Promise<void>(() => {}),
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const added = await runtime.places!.add({ address: "root@65.21.4.12", hostUrls: DOOR }, Date.now());
    box?.close();
    await until(async () => (await placesOf()).find(p => p.id === added.place.id)!.present === false);
    const answer = await dialled(added.place.id);
    expect(answer["dialled"]).toMatchObject({ answered: false });
    expect(String((answer["dialled"] as { said: string }).said)).toContain("root@65.21.4.12");
    expect(String(answer["line"])).toContain("was not answered");
  });

  it("says there is no road at all on a computer that joined by typing a code and is holding no link", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const answer = await dialled(placeId);
    expect(answer["dialled"]).toMatchObject({ answered: false });
    expect(String(answer["line"])).toContain("joined by typing a code");
  });

  it("keeps the address a computer dialled in from on its row, which is the only one a code join gives", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.road?.from !== undefined);
    const row = (await placesOf()).find(p => p.id === placeId)!;
    expect(row.road?.from).toMatch(/\d+\.\d+\.\d+\.\d+|::1|127\.0\.0\.1/);
    // And what it last said about itself, for the slots that would otherwise stand at pending while it is away,
    // with the stamp of the report it said it in: the uptime grows while the computer is up, so a row dating it by
    // the last frame would read an old figure as a fresh one.
    expect(row.home).toBe("/home/maya");
    expect(Date.parse(row.reportedAt!)).toBeGreaterThan(0);
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
          await join(hostKey, { code: readJoinToken(req.code).code, name: "box" });
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
    // The token and every address this host answers on are the door's to hand the installer, not the installer's to
    // find: one word carrying the code the box spends and the fingerprint of the key this host will prove to it.
    expect(handed?.code).toBe(joinToken(readJoinToken(handed!.code).code, keyFingerprint(hostKey.publicKey)));
    expect(readJoinToken(handed!.code).code).toMatch(/^[A-Z0-9]+$/);
    // The door's reading, handed down: the install reads no addresses of its own.
    expect(handed?.hostUrls).toEqual(DOOR);
    expect(stages.map(s => `${s.step} ${s.state}`)).toEqual(["connect done", "join running", "join done"]);
    expect(added.addId).toBe("a_mine");
    expect(stages.every(s => s.addId === "a_mine")).toBe(true);
    // The one fact the box's own row does not already carry: a size here as well cuts the line the app draws.
    expect(stages.at(-1)?.note).toBe("engine none");
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
          const { client, placeId, pair } = await join(hostKey, { code: readJoinToken(req.code).code, name: "box" });
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
          minted = readJoinToken(req.code).code;
          stage("wsp", "running");
          throw new Error("ssh refused the login (publickey)");
        },
      },
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await expect(runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow("publickey");
    expect(stages.map(s => `${s.step} ${s.state}`)).toEqual(["wsp running", "wsp failed"]);
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
    await expect(runtime!.places!.road(placeId)).rejects.toThrow(absentComputer("box", null).sentence);
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
    const { hostKey } = await serving();
    const c = await WsClient.connect(srv!.port, { token: "host-token" });
    const none = await c.request("places.door");
    expect(none).toMatchObject({ ok: false, error: PLACE_DOOR_UNSERVED });
    c.close();
    await srv!.close();
    const view = { port: 4420, addresses: ["http://192.168.1.20:4420"] };
    srv = await serveRuntime(runtime!, { port: 0, authToken: "host-token", devices: runtime!.devices, door: { open: async () => view } });
    const opened = await WsClient.connect(srv.port, { token: "host-token" });
    const answer = await opened.request("places.door");
    // Where to dial is the host's answer; the key proved there is the place door's own, off the pair it signs with.
    expect(answer).toMatchObject({ ok: true, door: { ...view, hostKey: keyFingerprint(hostKey.publicKey) } });
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
  /** How long a snapshot job there reads running before it reads done; the layer takes time to write. */
  snapshotTakesMs: number;
  /** Ops this computer takes and never answers, so a test can close the socket with a frame in flight on it. */
  swallow: Set<string>;
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
    snapshotsAnyLife: false,
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
  /** What a command run on a machine there answers; nothing and exit 0 unless the test says. */
  exec: (cmd: string) => { exitCode: number; stdout: string; stderr: string } = () => ({ exitCode: 0, stdout: "", stderr: "" }),
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
    snapshotTakesMs: 0,
    swallow: new Set<string>(),
    holdResumes: () => {
      held = [];
      return () => {
        for (const release of held ?? []) release();
        held = undefined;
      };
    },
  };
  let made = 0;
  const jobs = new Map<string, { name: string; started: number }>();
  // The container's own word for itself, as a Docker daemon would answer it: a wake reads it before it resumes.
  let state: "running" | "paused" = "running";
  client.ws.on("message", raw => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    const op = typeof frame["op"] === "string" ? frame["op"] : undefined;
    if (op === undefined) return;
    const id = frame["id"];
    const say = (payload: Record<string, unknown>): void => client.ws.send(JSON.stringify({ id, ok: true, ...payload }));
    const machine = (machineId: string): Record<string, unknown> => ({ machine: { id: machineId, kind: "sandbox", daemonSupervisor: "entrypoint", roads: PLACE_ROADS } });
    // A machine the host killed is gone from that computer, as the daemon there answers: a get or a state read of
    // it is refused as missing, which is what the kill's own wait for gone reads.
    const gone = (machineId: string): boolean => seen.killed.includes(machineId);
    const missing = (machineId: string): void => void client.ws.send(JSON.stringify({ id, ok: false, error: `no such machine: ${machineId}`, kind: "missing", status: 404 }));
    if (op.startsWith("machine.") || op.startsWith("tunnel.")) seen.ops.push(op);
    seen.asked[op] = (seen.asked[op] ?? 0) + 1;
    if (seen.swallow.has(op)) return;
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
        return gone(String(frame["machineId"])) ? missing(String(frame["machineId"])) : say(machine(String(frame["machineId"])));
      case "machine.state":
        return gone(String(frame["machineId"])) ? missing(String(frame["machineId"])) : say({ state });
      case "machine.exec":
        return say({ result: exec(String(frame["cmd"])) });
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
      // A snapshot is a job there: named at once, asked after until the layer is written.
      case "machine.snapshot":
        seen.snapshots.push(String(frame["name"]));
        jobs.set(`job-${seen.snapshots.length}`, { name: String(frame["name"]), started: Date.now() });
        return say({ job: `job-${seen.snapshots.length}` });
      case "machine.snapshotJob": {
        const job = jobs.get(String(frame["job"]));
        if (job === undefined) return void client.ws.send(JSON.stringify({ id, ok: false, error: `no such snapshot job: ${String(frame["job"])}`, kind: "missing", status: 404 }));
        const elapsed = Date.now() - job.started;
        if (elapsed < seen.snapshotTakesMs) return say({ state: "running", bytes: Math.floor((elapsed / seen.snapshotTakesMs) * 5_000_000), total: 5_000_000 });
        return say({ state: "done", bytes: 5_000_000, total: 5_000_000, snapshotId: `sha256:${job.name}` });
      }
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

describe("a fork at a provider this host is not wired to", () => {
  /** Two providers over two backends, as the host's own table hands them down: the wired one and one more whose key
   * this computer holds. */
  const twoProviders = (wired: string, at: Record<string, MachineBackend>): PlaceBackends => ({
    get wired() {
      return wired;
    },
    backend: place => at[place],
    list: () => Object.keys(at),
  });

  it("lists every provider whose key this host holds and forks at the one the line names, through that provider's own backend", async () => {
    const solari = stubBackend();
    const box = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend: solari,
      store: memoryStore(),
      adapters: {},
      places: twoProviders("solari", { solari, box }),
      placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }),
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const rows = await placesOf();
    expect(rows.filter(p => p.kind === "provider").map(p => p.id)).toEqual(["solari", "box"]);
    for (const row of rows.filter(p => p.kind === "provider")) expect(row.takesForks, row.id).toBe(true);

    // Named on the line: the machine is minted by that provider and the record says where it stands.
    const there = await runtime.workspaces.create({ golden: "snap_g", name: "x", on: "box" });
    expect(box.machines).toHaveLength(1);
    expect(solari.machines).toHaveLength(0);
    expect(there.place).toBe("box");
    expect(await runtime.workspaces.get(there.id)).toMatchObject({ place: "box" });
    // The place the last fork landed on is where the next one lands when nobody says.
    expect((await placesOf()).find(p => p.default)!.id).toBe("box");
    const again = await runtime.workspaces.create({ golden: "snap_g", name: "y" });
    expect(box.machines).toHaveLength(2);
    expect(again.place).toBe("box");

    // The wired provider named on the line is the road a record with no place word already takes.
    await runtime.places!.markUsed(undefined);
    const here = await runtime.workspaces.create({ golden: "snap_g", name: "z", on: "solari" });
    expect(solari.machines).toHaveLength(1);
    expect(here.place).toBeUndefined();
  });

  it("carries each provider's own sizes at its own rates on its row, so a picker reads the row it is under", async () => {
    // One list of sizes for every row is what priced a workspace at another provider's rates to the cent: the
    // dialog quoted the wired provider's three sizes under a row that bills nothing. The list is per row on the
    // wire, off the backend this host holds for that row, or a client has nothing to read it from.
    const solari = stubBackend();
    const free = [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0 }, { cpu: 4, memMb: 8192, rateUsdPerHour: 0 }];
    const made = stubBackend();
    const box: MachineBackend = { ...made, capabilities: { ...made.capabilities, sizes: free } };
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend: solari,
      store: memoryStore(),
      adapters: {},
      places: twoProviders("solari", { solari, box }),
      placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }),
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const rows = await placesOf();
    // The wired row reads off the runtime's own backend, the other off the one the table hands back for it.
    expect(rows.find(p => p.id === "solari")!.sizes).toEqual(solari.capabilities.sizes);
    expect(rows.find(p => p.id === "box")!.sizes).toEqual(free);
    // A computer of the person's own offers no pick of its own, so it carries no list rather than an empty one.
    expect(rows.find(p => p.kind === "computer")!.sizes).toBeUndefined();
  });

  it("names every provider it holds when a word names none of them", async () => {
    const solari = stubBackend();
    const box = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({
      backend: solari,
      store: memoryStore(),
      adapters: {},
      places: twoProviders("solari", { solari, box }),
      placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }),
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    await expect(runtime.workspaces.create({ golden: "snap_g", name: "x", on: "nowhere" })).rejects.toThrow(/no place named nowhere; you have .*solari.*box/);
  });
});

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

  it("says every computer on the row forks and the computer the app runs on does not, off the list the verbs read", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const withDocker = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(withDocker.client.ws);
    const rows = await placesOf();
    // The computer the app runs on is its own local mode, never something the host forks into; a computer that
    // joined boots the image, since the join turns down every one whose kernel cannot.
    expect(rows.find(p => p.id === "here")!.takesForks).toBe(false);
    expect(rows.find(p => p.id === withDocker.placeId)!.takesForks).toBe(true);
    expect(rows.find(p => p.id === "solari")!.takesForks).toBe(true);
    // What the row promises is what the create does: the fork lands on that computer's own backend.
    const made = await runtime.workspaces.create({ golden: "snap_g", name: "x", on: "srv" });
    expect(place.created).toHaveLength(1);
    expect(backend.machines).toHaveLength(0);
    expect(made.place).toBe(withDocker.placeId);
    // What the sidebar and wsp workspaces list for that computer: its forks, and no row for the computer itself.
    expect((await runtime.workspaces.list()).map(w => [w.name, w.place])).toEqual([["x", withDocker.placeId]]);
  });

  it("refuses a word that names no place, and names what this host holds", async () => {
    const { hostKey } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 } });
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    await expect(runtime!.workspaces.create({ golden: "snap_g", name: "x", on: "nowhere" })).rejects.toThrow(/no place named nowhere; you have .*srv.*solari/);
  });

  it("never holds a computer that forks nowhere: the join turned it down, so no word names one", async () => {
    const { hostKey } = await serving();
    const { client } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { runsWorkspaces: false }), answers: c => forks(c) });
    sockets.push(client.ws);
    await expect(runtime!.workspaces.create({ golden: "snap_g", name: "x", on: "srv" })).rejects.toThrow(/no place named srv/);
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

  it("a snapshot there that outlasts the link's frame bound completes: the job is asked after a frame at a time, and every frame answers inside the bound", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    // A frame bound far under the job: the old road, one frame waiting on the whole layer, failed here.
    runtime = createRuntime({ backend, store, adapters: {}, placeLinks: wiring(hostKey), placeFrameWaitMs: 300 });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    place.snapshotTakesMs = 1_500;
    await store.put("project-goldens", "snap_p", {
      snapshotId: "snap_p",
      golden: "snap_g",
      projects: [{ name: "proj", dest: "/root/proj", importedAt: "2026-09-12T00:00:00.000Z", size: 20 }],
      workspaceId: "ws_older",
      workspaceName: "older",
      createdAt: "2026-09-12T00:00:00.000Z",
    });
    const made = await runtime.workspaces.create({ golden: "snap_p", name: "x", on: "srv" });
    const started = Date.now();
    const golden = await runtime.workspaces.snapshot(made.id);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
    expect(golden.snapshotId).toBe(`sha256:${place.snapshots[0]!}`);
    expect(place.asked["machine.snapshot"]).toBe(1);
    expect(place.asked["machine.snapshotJob"]).toBeGreaterThanOrEqual(2);
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
    expect(away.reason).toBe(absentComputer("srv", null).sentence);
    expect(away.machineState).toBe("running");
    const back = await relink(hostKey, placeId, key, report("srv"), c => forks(c));
    sockets.push(back.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    await until(async () => (await runtime!.status.list()).find(r => r.id === made.id)!.reach.state !== "unreachable");
  });

  it("refuses a keyed frame at a computer that is simply off at once, and waits only for one whose socket closed inside the wait", async () => {
    const store = memoryStore();
    const { hostKey } = await serving({ store, relinkWaitMs: 400 });
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    // One fork made while the computer is here, so the road is warm and what follows is the wait and nothing else.
    await runtime!.workspaces.create({ golden: "snap_g", name: "warm", on: "srv" });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);

    // A gap this host holds a closed socket for: a keyed frame waits, and the computer dialling back finishes it.
    const waiting = runtime!.workspaces.create({ golden: "snap_g", name: "held", on: "srv" });
    let back!: ForkingPlace;
    const linked = await relink(hostKey, placeId, key, report("srv"), c => (back = forks(c)));
    sockets.push(linked.client.ws);
    expect((await waiting).name).toBe("held");
    expect(back.created).toHaveLength(1);
    linked.client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    // Past the wait, the same frame is refused with the one sentence every road on an absent computer reads.
    await new Promise(r => setTimeout(r, 450));
    let asked = Date.now();
    await expect(runtime!.workspaces.create({ golden: "snap_g", name: "late", on: "srv" })).rejects.toThrow(absentComputer("srv", null).sentence);
    expect(Date.now() - asked).toBeLessThan(50);

    // And a host that has held no socket for that computer at all, which is every host at start, refuses at once
    // rather than waiting out a computer that is off.
    await srv!.close();
    await runtime!.close();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey), placeRelinkWaitMs: 50_000 });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    asked = Date.now();
    await expect(runtime.workspaces.create({ golden: "snap_g", name: "cold", on: "srv" })).rejects.toThrow(absentComputer("srv", null).sentence);
    expect(Date.now() - asked).toBeLessThan(50);
  });

  it("never asks a frame with no key of its own a second time: the gap fails it, and the socket that computer opens next is not sent it", async () => {
    const { hostKey } = await serving();
    let first!: ForkingPlace;
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => (first = forks(c)) });
    sockets.push(client.ws);
    const made = await runtime!.workspaces.create({ golden: "snap_g", name: "x", on: "srv" });
    // A pause is the machine moving, not a reading: the far side has taken it by the time the answer is lost, and
    // a second one would be a second move. So the frame names no key and the gap is its end.
    first.swallow.add("machine.pause");
    const napping = runtime!.workspaces.nap(made.id);
    await until(() => first.asked["machine.pause"] === 1);
    client.close();
    await expect(napping).rejects.toThrow("connection lost");
    let second!: ForkingPlace;
    const back = await relink(hostKey, placeId, key, report("srv"), c => (second = forks(c)));
    sockets.push(back.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    await new Promise(r => setTimeout(r, 60));
    expect(second.asked["machine.pause"]).toBeUndefined();
    expect(first.paused + second.paused).toBe(0);
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

describe("the image built through a computer you joined", () => {
  it("a copy build names the computer by its name or id, learns its backend from the computer itself, and is refused at the record rather than at the name", async () => {
    const { hostKey } = await serving();
    let place: ForkingPlace | undefined;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    await expect(runtime!.image.build({ place: "srv" })).rejects.toThrow(/owns no image named default/);
    await expect(runtime!.image.build({ place: placeId })).rejects.toThrow(/owns no image named default/);
    // One frame taught this host what srv forks with; nothing was made there.
    expect(place!.asked["machine.backend"]).toBe(1);
    expect(place!.created).toEqual([]);
    await expect(runtime!.image.build({ place: "nowhere" })).rejects.toThrow(/no place named nowhere; you have .*srv/);
  });

  it("the image is built on the joined computer when it is the default place, and when the provider this host forks on forks nothing", async () => {
    const { hostKey } = await serving();
    const marked = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(marked.client.ws);
    await runtime!.places!.markUsed(marked.placeId);
    const picked = await runtime!.golden.buildPlace();
    expect([picked.place, picked.name]).toEqual([marked.placeId, "srv"]);
    expect(picked.backend.capabilities.sizes.length).toBeGreaterThan(0);
    // The provider a keyless host wires forks nothing and is the default: the one joined computer that runs
    // workspaces is where the image goes, with nothing named.
    await srv?.close();
    await runtime?.close();
    const none = new NoProviderBackend();
    const keyless = newPlaceKeyPair();
    runtime = createRuntime({ backend: none, store: memoryStore(), adapters: {}, places: wiredPlace("none", none), placeLinks: wiring(keyless) });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    const joined = await join(keyless, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(joined.client.ws);
    const only = await runtime.golden.buildPlace();
    expect([only.place, only.name]).toEqual([joined.placeId, "srv"]);
  });
});

describe("the image build and the computer whose doctor said no, or that does not answer", () => {
  const BLOCKED = "this computer mounts cgroup v1 at /sys/fs/cgroup";
  const copyRecipe = (): GoldenRecipe => ({ setup: "true", smoke: "true" });

  it("a computer whose doctor said no never becomes a place: the join is refused in the doctor's own sentence and nothing is written", async () => {
    const { hostKey, store } = await serving();
    const { client, reply } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { runsWorkspaces: false, workspacesBlocked: BLOCKED }), answers: c => forks(c) });
    sockets.push(client.ws);
    expect(String(reply["error"])).toBe(placeCannotBootLine("srv", BLOCKED));
    expect(String(reply["error"])).toBe("srv cannot run wsp workspaces: it mounts cgroup v1 at /sys/fs/cgroup");
    // Nothing on the store, nothing on the list, and no road names it: the refusal is the whole of what happened.
    expect(await store.list("places")).toEqual([]);
    await expect(runtime!.golden.buildPlace("srv")).rejects.toThrow(/no place named srv/);
    await expect(runtime!.image.build({ place: "srv" })).rejects.toThrow(/no place named srv/);
    await expect(runtime!.golden.prepare({ place: "srv", recipe: copyRecipe() })).rejects.toThrow(/no place named srv/);
    await expect(runtime!.workspaces.landing({ on: "srv" })).rejects.toThrow(/no place named srv/);
  });

  it("a default place that is not answering is the refusal the person reads, with its name in it, never a build sent to another place", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv" });
    await runtime!.places!.markUsed(placeId);
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    await expect(runtime!.golden.buildPlace()).rejects.toThrow(absentComputer("srv", null).sentence);
  });

  it("this computer is never built into: naming it for a copy build or a build place is refused rather than read as the provider this host forks on", async () => {
    await serving();
    await expect(runtime!.image.build({ place: HERE.name })).rejects.toThrow(placeBuildsNoImageLine(HERE.name));
    await expect(runtime!.golden.buildPlace(HERE.name)).rejects.toThrow(placeBuildsNoImageLine(HERE.name));
  });
});

describe("a computer joining a host that holds a sealed image", () => {
  /** A host that forks at a provider stub and composes the recipe a copy builds from; with `sealed`, its image is
   * sealed at that provider before anything joins. The key and the store are handed in for a host that comes back. */
  async function imageHost(o: { sealed: boolean; store?: Store; hostKey?: PlaceKeyPair; relinkWaitMs?: number }): Promise<{ hostKey: PlaceKeyPair; store: Store }> {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const hostKey = o.hostKey ?? newPlaceKeyPair();
    const store = o.store ?? memoryStore();
    runtime = createRuntime({
      backend,
      store,
      adapters: {},
      goldenRecipe: recipeWith(),
      copyRecipe: () => COPY_RECIPE,
      hostId: "h1",
      places: wiredPlace("solari", backend),
      placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }),
      ...(o.relinkWaitMs !== undefined ? { placeRelinkWaitMs: o.relinkWaitMs } : {}),
    });
    srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
    if (o.sealed) {
      const b = await runtime.golden.prepare();
      await runtime.golden.seal(b.id);
    }
    return { hostKey, store };
  }

  const settled = (): Promise<void> => new Promise(r => setTimeout(r, 60));
  const rowOf = async (placeId: string): Promise<PlaceView> => (await placesOf()).find(p => p.id === placeId)!;
  /** A computer answering what a builder asks of it, as far as a fake goes: its exec answers the checks, and the
   * builder's own setup is where a build there stops. */
  const answering =
    (hold: (p: ForkingPlace) => void) =>
    (c: WsClient): void =>
      hold(forks(c, undefined, cmd => dfOk(undefined, cmd)));
  const framesOf = (): GoldenStageEvent[] => {
    const frames: GoldenStageEvent[] = [];
    runtime!.events.on("golden.stage", e => {
      if (e.type === "golden.stage") frames.push(e);
    });
    return frames;
  };

  it("builds that computer's copy on the agent's link, not on the join's own socket: the join socket closes behind its prove and the row says nothing, the link that dials in next starts the build, and where the build stops the row says so, the builder is killed by its id and no copy is filed", async () => {
    const { hostKey } = await imageHost({ sealed: true });
    const frames = framesOf();
    // The join command's road: join and prove on one socket that answers no machine frame and closes once the
    // prove is answered; the agent's link dials in after it.
    const joined = await join(hostKey, { code: await code(), name: "srv" });
    const { placeId, pair } = joined;
    await until(async () => (await rowOf(placeId)).present === true);
    joined.client.close();
    await until(async () => (await rowOf(placeId)).present === false);
    await settled();
    expect(frames.filter(f => f.place === placeId)).toEqual([]);
    expect((await rowOf(placeId)).build).toBeUndefined();
    let place!: ForkingPlace;
    const linked = await relink(hostKey, placeId, pair, report("srv"), answering(p => (place = p)));
    sockets.push(linked.client.ws);
    expect(linked.proved.ok, String(linked.proved["error"])).toBe(true);
    await until(() => place.asked["machine.create"] === 1, 5000);
    expect(frames.some(f => f.place === placeId && f.stage === "creating")).toBe(true);
    // The fake computer runs no builder's setup, so the build stops there: the row says so in the seal's own
    // words, and the stopped build starts no second one on its own.
    await until(async () => (await rowOf(placeId)).build?.startsWith(copyStoppedLine()) === true, 5000);
    expect(frames.filter(f => f.place === placeId).map(f => f.stage)).toContain("failed");
    expect(place.killed).toHaveLength(1);
    expect((await runtime!.image.get()).copies.map(c => c.place)).toEqual(["solari"]);
    expect(place.asked["machine.create"]).toBe(1);
  });

  it("a link that drops under a stage and dials back finishes the stage: the create is asked again on the socket that computer opens next, the build goes on to the stage after it, and the stage reads the wait while the gap lasts", async () => {
    const { hostKey } = await imageHost({ sealed: false });
    const frames = framesOf();
    let first!: ForkingPlace;
    const joined = await join(hostKey, { code: await code(), name: "srv", answers: answering(p => (first = p)) });
    await until(() => first.asked["machine.backend"] === 1);
    // The computer takes the builder's create and says nothing back; then its socket goes.
    first.swallow.add("machine.create");
    // The fake computer runs no builder's setup, so the prepare stops there in the end; what this reads is how far
    // it got, and its answer is taken here so nothing of it is loose while the test waits.
    const preparing = runtime!.golden.prepare({ place: joined.placeId, recipe: { setup: "true", smoke: "true" } }).catch(() => undefined);
    await until(() => first.asked["machine.create"] === 1, 5000);
    joined.client.close();
    await until(async () => (await rowOf(joined.placeId)).present === false);
    expect(frames.some(f => f.stage === "creating" && f.detail === placeDialBackLine("srv"))).toBe(true);

    let back!: ForkingPlace;
    const linked = await relink(hostKey, joined.placeId, joined.pair, report("srv"), answering(p => (back = p)));
    sockets.push(linked.client.ws);
    // The same prepare goes on over the new socket: its create is asked again there and the stage after creating
    // is reached, where with no wait at all the prepare was already over.
    await until(() => back.asked["machine.create"] === 1, 5000);
    await until(() => frames.some(f => f.stage === "deploying-daemon"), 5000);
    expect(back.created).toHaveLength(1);
    // And the wait's line is gone once the computer is back: the frame put back is the stage's own last frame,
    // field for field, so a step a reader clocks and the machines a stage left behind ride the gap with its line.
    const own = frames
      .filter(f => f.stage === "creating" && f.detail !== placeDialBackLine("srv"))
      .map(({ name, stage, detail, step, left, place }) => ({ name, stage, detail, step, left, place }));
    expect(own).toHaveLength(2);
    expect(own[1]).toEqual(own[0]);
    await preparing;
  });

  it("a computer that never dials back fails the stage after the wait, with the sentence the stage fails with when nothing waits at all", async () => {
    const { hostKey } = await imageHost({ sealed: false, relinkWaitMs: 300 });
    let place!: ForkingPlace;
    const joined = await join(hostKey, { code: await code(), name: "srv", answers: answering(p => (place = p)) });
    await until(() => place.asked["machine.backend"] === 1);
    place.swallow.add("machine.create");
    const preparing = runtime!.golden.prepare({ place: joined.placeId, recipe: { setup: "true", smoke: "true" } });
    await until(() => place.asked["machine.create"] === 1, 5000);
    const at = Date.now();
    joined.client.close();
    // The wait is a wait, not a second answer: past its bound the stage fails with the frame's own words, which is
    // what a person read on this stage before anything waited at all.
    await expect(preparing).rejects.toThrow("connection lost");
    expect(Date.now() - at).toBeGreaterThanOrEqual(300);
  });

  it("builds nothing for a computer whose doctor said no, since its join never stood, and nothing at all on a host that holds no image", async () => {
    const { hostKey } = await imageHost({ sealed: true });
    let blocked!: ForkingPlace;
    const laptop = await join(hostKey, { code: await code(), name: "laptop", report: report("laptop", { runsWorkspaces: false }), answers: c => (blocked = forks(c)) });
    sockets.push(laptop.client.ws);
    await settled();
    expect(blocked.asked["machine.create"]).toBeUndefined();
    expect((await placesOf()).some(p => p.name === "laptop")).toBe(false);

    await srv?.close();
    await runtime?.close();
    const { hostKey: bare } = await serving();
    let place!: ForkingPlace;
    const { client, placeId } = await join(bare, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    await until(async () => (await rowOf(placeId)).present === true);
    await settled();
    expect(place.asked["machine.create"]).toBeUndefined();
    expect((await rowOf(placeId)).build).toBeUndefined();
  });

  it("a computer not connected at the cut builds nothing then and its row says nothing; its next link builds the copy", async () => {
    const { hostKey } = await imageHost({ sealed: false });
    let place!: ForkingPlace;
    const joined = await join(hostKey, { code: await code(), name: "srv", answers: answering(p => (place = p)) });
    // The computer said what it forks with, then went away.
    await until(() => place.asked["machine.backend"] === 1);
    joined.client.close();
    await until(async () => (await rowOf(joined.placeId)).present === false);
    const frames = framesOf();
    const b = await runtime!.golden.prepare();
    await runtime!.golden.seal(b.id);
    await settled();
    expect(frames.filter(f => f.place === joined.placeId)).toEqual([]);
    expect((await rowOf(joined.placeId)).build).toBeUndefined();
    let back!: ForkingPlace;
    const linked = await relink(hostKey, joined.placeId, joined.pair, report("srv"), answering(p => (back = p)));
    sockets.push(linked.client.ws);
    await until(() => back.asked["machine.create"] === 1, 5000);
    expect(frames.some(f => f.place === joined.placeId && f.stage === "creating")).toBe(true);
  });

  it("a host restarted while a copy was building on a computer you joined reads the builder back through that computer once it dials in and the sweep stops it there; the wired provider is never asked about it and no copy is half filed", async () => {
    const { hostKey, store } = await imageHost({ sealed: false });
    let place!: ForkingPlace;
    const joined = await join(hostKey, { code: await code(), name: "srv", answers: answering(p => (place = p)) });
    await until(() => place.asked["machine.backend"] === 1);
    // What a host that died mid build leaves behind: the builder's record, marked building, naming the computer it
    // was made on.
    await store.put("builders", "k7", { id: "k7", name: "default", kind: "sandbox", baseTemplate: "ubuntu:24.04", setupSha: "x", createdAt: new Date().toISOString(), size: { cpu: 2, memMb: 4096 }, firstLife: true, building: true, place: joined.placeId });
    joined.client.close();
    await srv!.close();
    await runtime!.close();
    // The host comes back on the same state and the computer dials in again.
    await imageHost({ sealed: false, store, hostKey });
    let again!: ForkingPlace;
    const linked = await relink(hostKey, joined.placeId, joined.pair, report("srv"), answering(p => (again = p)));
    sockets.push(linked.client.ws);
    const swept = await runtime!.reap();
    expect(again.asked["machine.get"]).toBeGreaterThanOrEqual(1);
    expect(again.killed).toEqual(["k7"]);
    expect(swept.reaped.map(r => r.id)).toContain("k7");
    expect(await store.get("builders", "k7")).toBeUndefined();
    expect(await store.keys("goldens")).toEqual([]);
  });
});
