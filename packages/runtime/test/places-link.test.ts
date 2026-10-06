// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { readJoinToken, placeNoLinkLine, type PlaceBack, type PlaceStageEvent, type PlaceView } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { type PlaceBackHolder, type PlaceRecord, newPlaceKeyPair, type PlaceInstallRequest, type PlaceKeyPair, type PlaceLogin } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";
import { DOOR, report, wiring } from "./place-join.js";
import { ctx, sockets, serving, code, join, relink, placesOf, answersLeave } from "./places-fixture.js";

describe("dialling a computer that stopped answering", () => {
  /** The one road the app's Try now takes, over the person's own socket. */
  const dialled = async (placeId: string): Promise<Record<string, unknown>> => {
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
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
        c.onFrame(raw => {
          const frame = raw as unknown as { id?: number; op?: string };
          if (frame.op === "ping") c.say({ id: frame.id, ok: true });
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
    const logins: PlaceLogin[] = [];
    let box: WsClient | undefined;
    ctx.runtime = createRuntime({
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
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const added = await ctx.runtime.places!.add({ address: "root@65.21.4.12", hostUrls: DOOR }, Date.now());
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

  it("keeps a login that landed on that computer while the dial was out", async () => {
    const hostKey = newPlaceKeyPair();
    let box: WsClient | undefined;
    let answer: (() => void) | undefined;
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          box = (await join(hostKey, { code: readJoinToken(req.code).code, name: "vps", report: report("vps", { agents: ["codex"], logins: [] }) })).client;
          return { name: "vps", ssh: "root@65.21.4.12" };
        },
        dial: () => new Promise<void>(done => (answer = done)),
      },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const added = await ctx.runtime.places!.add({ address: "root@65.21.4.12", hostUrls: DOOR }, Date.now());
    box?.close();
    await until(async () => (await placesOf()).find(p => p.id === added.place.id)!.present === false);
    const dialling = dialled(added.place.id);
    await until(() => answer !== undefined);
    await ctx.runtime.places!.loginLanded(added.place.id, "codex");
    expect(ctx.runtime.places!.signInsAt(added.place.id)).toEqual({ codex: "signed-in" });
    answer!();
    expect(((await dialling)["place"] as PlaceView).signIns).toEqual({ codex: "signed-in" });
    expect(ctx.runtime.places!.signInsAt(added.place.id)).toEqual({ codex: "signed-in" });
  });

  it("dials with the key file the add was given, since every ssh child runs with BatchMode on", async () => {
    const hostKey = newPlaceKeyPair();
    const logins: PlaceLogin[] = [];
    let box: WsClient | undefined;
    ctx.runtime = createRuntime({
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
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const added = await ctx.runtime.places!.add({ address: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner", hostUrls: DOOR }, Date.now());
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

  it("marks the step an install stopped in with the installer's one sentence and hands back that sentence alone", async () => {
    const hostKey = newPlaceKeyPair();
    const sentence = "spoo took wsp but could not connect back: the host at http://100.129.166.28:4640 did not answer in 20s";
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (_req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          stage("wsp", "done", "x86_64");
          stage("service", "running");
          throw new Error(sentence);
        },
      },
    });
    const stages: PlaceStageEvent[] = [];
    ctx.runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await expect(ctx.runtime.places!.add({ address: "root@178.156.161.168", hostUrls: DOOR }, Date.now())).rejects.toThrow(new Error(sentence));
    expect(stages.filter(s => s.state === "failed").map(s => [s.step, s.note])).toEqual([["service", sentence]]);
  });

  it("hands back ssh's own sentence when the login is refused, and keeps it on the row", async () => {
    const hostKey = newPlaceKeyPair();
    let box: WsClient | undefined;
    const said = "ssh: connect to host 65.21.4.12 port 22: Connection refused";
    ctx.runtime = createRuntime({
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
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const added = await ctx.runtime.places!.add({ address: "root@65.21.4.12", hostUrls: DOOR }, Date.now());
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
    ctx.runtime = createRuntime({
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
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const added = await ctx.runtime.places!.add({ address: "root@65.21.4.12", hostUrls: DOOR }, Date.now());
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

describe("the forward a computer dials back through", () => {
  /** A holder that records every ask, standing each forward where it was asked. */
  function backHolder(): { holder: PlaceBackHolder; holds: { login: PlaceLogin; back: PlaceBack; home: string; moved?: (back: PlaceBack) => void }[]; calls: string[] } {
    const holds: { login: PlaceLogin; back: PlaceBack; home: string; moved?: (back: PlaceBack) => void }[] = [];
    const calls: string[] = [];
    return {
      holds,
      calls,
      holder: {
        hold: async (login, back, on, moved) => {
          holds.push({ login, back, home: on.home, ...(moved !== undefined ? { moved } : {}) });
          calls.push(`hold ${login.ssh} ${back.boxPort}`);
          return back;
        },
        release: login => void calls.push(`release ${login.ssh}`),
        door: () => {},
        close: () => void calls.push("close"),
      },
    };
  }

  const AT_DOOR: PlaceBack = { boxPort: 4640 };

  /** One add of a box that reached this host only through the forward the install stood. */
  async function addedOverTheForward(store: Store, back: PlaceBackHolder, stages: PlaceStageEvent[] = []): Promise<{ hostKey: PlaceKeyPair; placeId: string }> {
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        back,
        install: async req => {
          const { client } = await join(hostKey, { code: readJoinToken(req.code).code, name: "spoo", report: report("spoo", { dialed: "http://127.0.0.1:4640" }) });
          sockets.push(client.ws);
          answersLeave(client, [], []);
          return { name: "spoo", ssh: "root@spoo", back: AT_DOOR };
        },
      },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    ctx.runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    const added = await ctx.runtime.places!.add({ address: "spoo", hostUrls: DOOR, doorPort: 4640 }, Date.now());
    return { hostKey, placeId: added.place.id };
  }

  it("says the link came in over ssh where the box dialled the forward on its own loopback", async () => {
    const stages: PlaceStageEvent[] = [];
    await addedOverTheForward(memoryStore(), backHolder().holder, stages);
    const joined = stages.find(s => s.step === "join" && s.state === "done");
    expect(joined?.note).toBe("over ssh, engine none");
    expect(joined?.note).not.toContain("127.0.0.1");
  });

  it("keeps the forward an install stood held for the record it made, and writes a port it moved to onto that record", async () => {
    const store = memoryStore();
    const back = backHolder();
    const { placeId } = await addedOverTheForward(store, back.holder);
    expect(back.holds).toHaveLength(1);
    expect(back.holds[0]).toMatchObject({ login: { ssh: "root@spoo" }, back: AT_DOOR, home: "/home/maya" });
    expect((await placesOf()).find(p => p.id === placeId)?.road).toEqual({ ssh: "root@spoo", from: "127.0.0.1", back: AT_DOOR });
    back.holds[0]!.moved!({ boxPort: 23456 });
    await until(async () => (await placesOf()).find(p => p.id === placeId)?.road?.back?.boxPort === 23456);
    expect(((await store.get("places", placeId)) as PlaceRecord).road?.back).toEqual({ boxPort: 23456 });
  });

  it("holds it again for every record that dials back through one when the host starts, and lets every one go when it stops", async () => {
    const store = memoryStore();
    const first = backHolder();
    const { hostKey } = await addedOverTheForward(store, first.holder);
    await ctx.srv!.close();
    ctx.srv = undefined;
    await ctx.runtime!.close();
    expect(first.calls.at(-1)).toBe("close");
    const again = backHolder();
    ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: { ...wiring(hostKey), back: again.holder } });
    await ctx.runtime.places!.load();
    expect(again.holds).toHaveLength(1);
    expect(again.holds[0]).toMatchObject({ login: { ssh: "root@spoo" }, back: AT_DOOR, home: "/home/maya" });
    expect(again.holds[0]!.moved).toBeDefined();
  });

  it("lets the forward go when the computer is removed, after the sweep that may ride it", async () => {
    const back = backHolder();
    const { placeId } = await addedOverTheForward(memoryStore(), back.holder);
    await ctx.runtime!.places!.remove(placeId);
    expect(back.calls.at(-1)).toBe("release root@spoo");
  });

  it("a move heard while the computer is being removed never writes the removed record back", async () => {
    const inner = memoryStore();
    let gate: Promise<void> | undefined;
    const store: Store = {
      ...inner,
      get: async (collection, id) => {
        const found = await inner.get(collection, id);
        if (collection === "places" && gate !== undefined) await gate;
        return found;
      },
    };
    const back = backHolder();
    const { placeId } = await addedOverTheForward(store, back.holder);
    let open!: () => void;
    gate = new Promise<void>(r => (open = r));
    back.holds[0]!.moved!({ boxPort: 23456 });
    await new Promise(r => setTimeout(r, 10));
    gate = undefined;
    const removing = ctx.runtime!.places!.remove(placeId);
    await new Promise(r => setTimeout(r, 10));
    open();
    await removing;
    await new Promise(r => setTimeout(r, 30));
    expect(await inner.get("places", placeId)).toBeUndefined();
  });

  it("lets the forward go when the add that stood it left no record", async () => {
    const back = backHolder();
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(newPlaceKeyPair()), back: back.holder, install: async () => ({ name: "spoo", ssh: "root@spoo", back: AT_DOOR }) },
      placeJoinWaitMs: 30,
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    await expect(ctx.runtime.places!.add({ address: "spoo", hostUrls: DOOR, doorPort: 4640 }, Date.now())).rejects.toThrow(placeNoLinkLine("spoo"));
    expect(back.calls).toEqual(["release root@spoo"]);
  });

  it("hands the install the door's own port and the relay's address off the host's door", async () => {
    let handed: PlaceInstallRequest | undefined;
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(newPlaceKeyPair()),
        install: async req => {
          handed = req;
          throw new Error("stop here");
        },
      },
    });
    const relay = "https://h645d7f8a8d48cbd6.example";
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices, door: { open: async () => ({ port: 4640, addresses: DOOR, relay, backPort: 4640 }) } });
    const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    await c.request("places.add", { address: "root@spoo" });
    c.close();
    expect(handed).toMatchObject({ hostUrls: [...DOOR, relay], doorPort: 4640, relay });
  });
});
