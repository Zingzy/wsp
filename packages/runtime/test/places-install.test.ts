// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { NO_PLACE_INSTALLER, PLACE_LOGIN_REFUSED_KIND, PLACE_HOST_KEY_KIND, DAEMON_VERSION, joinToken, readJoinToken, placeNoLinkLine, refusal, type PlaceStageEvent } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { keyFingerprint } from "@wsp/engine";
import { PlaceAddTakenBackError, PlaceLoginRefusedError, newPlaceKeyPair, type PlaceInstallRequest, type PlaceLogin, type PlaceUpdateRequest } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";
import { DOOR, report, wiring } from "./place-join.js";
import { ctx, sockets, serving, join, relink, placesOf } from "./places-fixture.js";

describe("putting the agent on a computer over ssh", () => {
  it("refuses on a host that wired no road onto a computer it has never met", async () => {
    const { hostKey } = await serving();
    // The wiring this host was served with names no installer, which is every host but the one with the ssh road.
    expect(hostKey).toBeDefined();
    await expect(ctx.runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow(NO_PLACE_INSTALLER);
  });

  it("mints a code the computer spends, says what each step is doing, and answers once that computer's link is up", async () => {
    const hostKey = newPlaceKeyPair();
    const store = memoryStore();
    const stages: PlaceStageEvent[] = [];
    let handed: PlaceInstallRequest | undefined;
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          handed = req;
          stage("connect", "done", "Ubuntu 24.04");
          // The computer's own join, with the code the install was handed: the door spends it and the link follows.
          await join(hostKey, { code: readJoinToken(req.code).code, name: "box", report: report("box", { dialed: DOOR[0]! }) });
          return { name: "box", hostKey: "ssh-ed25519 SHA256:abc" };
        },
      },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    ctx.runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    // The caller mints the stream, since the steps come back before the reply that would have named it.
    const added = await ctx.runtime.places!.add({ addId: "a_mine", address: "root@10.0.0.9", name: "box", hostUrls: DOOR }, Date.now());
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
    // The road its link came in on and the one fact the box's own row does not already carry: a size here as well
    // cuts the line the app draws.
    expect(stages.at(-1)?.note).toBe("at http://192.168.1.20:4400, engine none");
    // The computer is held by the time its join is done, so that step names the row a reader acts on.
    expect(stages.at(-1)?.placeId).toBe(added.place.id);
  });

  it("never says an address the box claims it dialled that this add did not hand it", async () => {
    const hostKey = newPlaceKeyPair();
    const stages: PlaceStageEvent[] = [];
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async req => {
          await join(hostKey, { code: readJoinToken(req.code).code, name: "box", report: report("box", { dialed: `https://whatever-it-likes.example/${"a".repeat(4000)}` }) });
          return { name: "box" };
        },
      },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    ctx.runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await ctx.runtime.places!.add({ address: "root@10.0.0.9", name: "box", hostUrls: DOOR }, Date.now());
    expect(stages.find(s => s.step === "join" && s.state === "done")?.note).toBe("engine none");
  });

  it("waits for the link the agent dials, not the socket the join itself opened and closed", async () => {
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({
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
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const added = await ctx.runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    expect(added.place.present).toBe(true);
  });

  it("names the step an install stopped on, and the code it minted opens nothing afterwards", async () => {
    const hostKey = newPlaceKeyPair();
    const stages: PlaceStageEvent[] = [];
    let minted = "";
    ctx.runtime = createRuntime({
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
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    ctx.runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await expect(ctx.runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow("publickey");
    expect(stages.map(s => `${s.step} ${s.state}`)).toEqual(["wsp running", "wsp failed"]);
    expect(stages.at(-1)?.note).toContain("publickey");
    // The code went to the box as a file, so the add that failed has spent it and nobody can join with it after.
    expect(await ctx.runtime.devices.spend(minted, Date.now())).toBe(false);
  });

  it("says a step the installer already marked failed once, not a second time as the add ends", async () => {
    const stages: PlaceStageEvent[] = [];
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(newPlaceKeyPair()),
        install: async (_req, stage) => {
          stage("check", "running");
          stage("root", "running");
          stage("root", "failed", "sudo on dev@spoo asks for dev's password");
          throw new Error("sudo on dev@spoo asks for dev's password");
        },
      },
    });
    ctx.runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await expect(ctx.runtime.places!.add({ address: "dev@spoo", hostUrls: DOOR }, Date.now())).rejects.toThrow("asks for");
    expect(stages.map(s => `${s.step} ${s.state}`)).toEqual(["check running", "root running", "root failed"]);
  });

  it("draws a failure on the step that was under way, not on a step that only said what it had done", async () => {
    const stages: PlaceStageEvent[] = [];
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(newPlaceKeyPair()),
        install: async (_req, stage) => {
          stage("connect", "running");
          stage("host-key", "done", "ssh-ed25519 SHA256:abc");
          throw new Error("root@spoo runs zsh as root's shell");
        },
      },
    });
    ctx.runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await expect(ctx.runtime.places!.add({ address: "root@spoo", hostUrls: DOOR }, Date.now())).rejects.toThrow("zsh");
    expect(stages.map(s => `${s.step} ${s.state}`)).toEqual(["connect running", "host-key done", "connect failed"]);
  });

  it("answers a refused login over the wire with the kind the app reads its login fix off, and any other refusal without it", async () => {
    let refuse: Error = new PlaceLoginRefusedError("maya@box: Permission denied (publickey).");
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(newPlaceKeyPair()), install: async () => Promise.reject(refuse) },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices, door: { open: async () => ({ port: 4420, addresses: DOOR }) } });
    const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    expect(await c.request("places.add", { address: "maya@box" })).toMatchObject({ ok: false, error: "maya@box: Permission denied (publickey).", kind: PLACE_LOGIN_REFUSED_KIND });
    refuse = new Error("root@spoo runs zsh as root's shell");
    expect(await c.request("places.add", { address: "root@spoo" })).not.toHaveProperty("kind");
    c.close();
  });

  it("gives up on a computer that took the agent and never dialled, in the sentence that says what to check", async () => {
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(hostKey), install: async () => ({ name: "box" }) },
      placeJoinWaitMs: 50,
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    await expect(ctx.runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow(placeNoLinkLine("box"));
  });

  it("puts the agent's own last lines under that sentence, read over the login the install used", async () => {
    const hostKey = newPlaceKeyPair();
    const asked: PlaceLogin[] = [];
    const said = ["https://h645d7f8a8d48cbd6.example could not be dialled: not an http address", "http://100.129.175.77:4420 did not answer in 10s"];
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async () => ({ name: "box", ssh: "root@10.0.0.9", sshKeyPath: "/Users/lena/.ssh/hetzner" }),
        log: async login => {
          asked.push(login);
          return said;
        },
      },
      placeJoinWaitMs: 50,
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const stages: PlaceStageEvent[] = [];
    ctx.runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    await expect(ctx.runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow([placeNoLinkLine("box"), ...said].join("\n"));
    expect(asked).toEqual([{ ssh: "root@10.0.0.9", keyPath: "/Users/lena/.ssh/hetzner" }]);
    // The step's note is one line by construction: a terminal prints it after the step's marker and the sheet puts
    // it in one span, so the box's own lines ride the throw, which both roads print whole.
    expect(stages.at(-1)?.note).toBe(placeNoLinkLine("box"));
  });

  it("says the wait's own sentence and nothing else when the box will not answer the read either", async () => {
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async () => ({ name: "box", ssh: "root@10.0.0.9" }),
        log: async () => {
          throw new Error("ssh: connect to host 10.0.0.9 port 22: Connection refused");
        },
      },
      placeJoinWaitMs: 50,
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const failed = await ctx.runtime.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now()).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(failed?.message).toBe(placeNoLinkLine("box"));
  });

  it("drops the record a join made when the install it landed in failed, since that install took the join back off the box", async () => {
    const hostKey = newPlaceKeyPair();
    const store = memoryStore();
    const removed: string[] = [];
    let joined = "";
    const said = "spoo connected back but its agent did not start: systemctl exited 1; nothing this add put on it is left there";
    let taken = true;
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async req => {
          // The join on the box landed and wrote the record; the unit it installed next did not start.
          const { client, placeId } = await join(hostKey, { code: readJoinToken(req.code).code, name: "spoo", report: report("spoo") });
          sockets.push(client.ws);
          joined = placeId;
          throw taken ? new PlaceAddTakenBackError(said) : new Error(said);
        },
      },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    ctx.runtime.events.on("place.removed", e => removed.push((e as { placeId: string }).placeId));
    await expect(ctx.runtime.places!.add({ address: "root@spoo", hostUrls: DOOR }, Date.now())).rejects.toThrow(said);
    expect(joined).not.toBe("");
    expect(await store.get("places", joined)).toBeUndefined();
    expect((await placesOf()).some(p => p.id === joined)).toBe(false);
    expect(removed).toEqual([joined]);
    // An install that could not take its join back keeps the record, which is the road a remove sweeps that box by.
    taken = false;
    await expect(ctx.runtime.places!.add({ address: "root@spoo", hostUrls: DOOR }, Date.now())).rejects.toThrow(said);
    expect(await store.get("places", joined)).toBeDefined();
    expect(removed).toHaveLength(1);
  });

  it("keeps the login the install used on the record when the computer never dials back, which is the box that needs it most", async () => {
    const hostKey = newPlaceKeyPair();
    const store = memoryStore();
    const asked: PlaceUpdateRequest[] = [];
    let joined = "";
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async req => {
          // The shape a box that never comes back has: its own join opens a socket and closes it while the install's
          // ssh command is still running, and the unit that join wrote never dials this host at all.
          const { client, placeId } = await join(hostKey, { code: readJoinToken(req.code).code, name: "vps", report: report("vps", { daemonVersion: DAEMON_VERSION - 1 }) });
          joined = placeId;
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === true));
          client.close();
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === false));
          return { name: "vps", ssh: "root@65.21.4.12", sshKeyPath: "/Users/lena/.ssh/hetzner" };
        },
        update: async req => {
          asked.push(req);
          return { road: "ssh", at: "/root/.wsp/daemon/wsp-daemon" };
        },
      },
      placeJoinWaitMs: 60,
      placeUpdateWaitMs: 60,
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    await expect(ctx.runtime.places!.add({ address: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner", hostUrls: DOOR }, Date.now())).rejects.toThrow(placeNoLinkLine("vps"));
    // The wait's outcome says nothing about what road this host was handed, so the record holds the login either way.
    const held = (await store.get("places", joined)) as { road?: { ssh?: string; keyPath?: string } };
    expect(held.road).toMatchObject({ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" });
    // And the road that puts a daemon on that computer takes it: the one box that needs the update road is the one
    // whose agent could not dial.
    const updated = await ctx.runtime.places!.update(joined);
    expect(updated.daemon?.road).toBe("ssh");
    expect(asked.map(r => r.ssh)).toEqual([{ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" }]);
  });

});

describe("the adds this host keeps", () => {
  const door = { open: async () => ({ port: 4420, addresses: DOOR }) };
  const addsOf = async (c: WsClient): Promise<unknown[]> => ((await c.request("places.list")) as { adds?: unknown[] }).adds ?? [];

  it("keeps an add that failed mid-way, its steps, what it said and the fix, for a second client to read off places.list", async () => {
    let go: () => void = () => {};
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(newPlaceKeyPair()),
        install: async (_req, stage) => {
          stage("connect", "running");
          stage("connect", "done", "Ubuntu 24.04");
          stage("wsp", "running");
          await new Promise<void>(ok => (go = ok));
          throw refusal("spoo has no curl or wget on its PATH", "Install one of them there, then add again.");
        },
      },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices, door });
    const mine = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    const other = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    sockets.push(mine.ws, other.ws);
    const answer = mine.request("places.add", { addId: "a_spoo", address: "root@spoo", sshPort: 2222 });
    await until(async () => (await addsOf(other)).length === 1);
    expect(await addsOf(other)).toEqual([
      expect.objectContaining({ addId: "a_spoo", address: "root@spoo", sshPort: 2222, state: "running", steps: [{ step: "connect", state: "done", note: "Ubuntu 24.04" }, { step: "wsp", state: "running" }] }),
    ]);
    go();
    expect(await answer).toMatchObject({ ok: false, fix: "Install one of them there, then add again." });
    const [job] = (await addsOf(other)) as Record<string, unknown>[];
    expect(job).toMatchObject({
      addId: "a_spoo",
      state: "failed",
      said: "spoo has no curl or wget on its PATH.",
      fix: "Install one of them there, then add again.",
      steps: [{ step: "connect", state: "done", note: "Ubuntu 24.04" }, { step: "wsp", state: "failed", note: "spoo has no curl or wget on its PATH. Install one of them there, then add again." }],
    });
    expect(job).not.toHaveProperty("kind");
    expect(Date.parse(String(job!["startedAt"]))).not.toBeNaN();
  });

  it("keeps the key a computer never met answered with, under its kind, so the app's Trust reads it off the record", async () => {
    const key = "ssh-ed25519 SHA256:tK3mX9Qf2bWq8vRz0YhN4cL7pJd1sE6gA5uF8oH2kIw";
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(newPlaceKeyPair()), install: async () => Promise.reject(Object.assign(new Error("maya@box has never been reached"), { kind: PLACE_HOST_KEY_KIND, hostKey: key })) },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices, door });
    const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    sockets.push(c.ws);
    expect(await c.request("places.add", { addId: "a_maya", address: "maya@box" })).toMatchObject({ ok: false, kind: PLACE_HOST_KEY_KIND });
    expect(await addsOf(c)).toEqual([expect.objectContaining({ addId: "a_maya", state: "failed", kind: PLACE_HOST_KEY_KIND, hostKey: key })]);
  });

  it("keeps the kind a refused login carries, so the app's login fix reads off the record", async () => {
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(newPlaceKeyPair()), install: async () => Promise.reject(new PlaceLoginRefusedError("maya@box: Permission denied (publickey).")) },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices, door });
    const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    sockets.push(c.ws);
    await c.request("places.add", { addId: "a_maya", address: "maya@box" });
    expect(await addsOf(c)).toEqual([expect.objectContaining({ addId: "a_maya", state: "failed", said: "maya@box: Permission denied (publickey).", kind: PLACE_LOGIN_REFUSED_KIND, steps: [expect.objectContaining({ step: "connect", state: "failed" })] })]);
  });

  it("marks an add done with the computer it made once that computer has joined", async () => {
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          await join(hostKey, { code: readJoinToken(req.code).code, name: "box" });
          return { name: "box" };
        },
      },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices, door });
    const added = await ctx.runtime.places!.add({ addId: "a_box", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    sockets.push(c.ws);
    expect(await addsOf(c)).toEqual([expect.objectContaining({ addId: "a_box", state: "done", placeId: added.place.id })]);
  });

  it("keeps no add whose join code was never issued, since nothing would ever end it", async () => {
    const store = memoryStore();
    const put = store.put.bind(store);
    store.put = async (collection, id, value) => (collection === "pairings" ? Promise.reject(new Error("the state file is read-only")) : put(collection, id, value));
    ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: { ...wiring(newPlaceKeyPair()), install: async () => ({ name: "box" }) } });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices, door });
    const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    sockets.push(c.ws);
    expect(await c.request("places.add", { addId: "a_ro", address: "root@10.0.0.9" })).toMatchObject({ ok: false, error: "the state file is read-only" });
    expect(await addsOf(c)).toEqual([]);
  });

  it("keeps the box's own lines under a failed add cut to the length a log line keeps, and says each cut", async () => {
    const long = `agent: ${"x".repeat(5_000)}`;
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(newPlaceKeyPair()), install: async () => ({ name: "box", ssh: "root@10.0.0.9" }), log: async () => [long, "agent: dial refused"] },
      placeJoinWaitMs: 50,
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices, door });
    await ctx.runtime.places!.add({ addId: "a_box", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now()).catch(() => undefined);
    const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    sockets.push(c.ws);
    const [job] = (await addsOf(c)) as { said: string }[];
    expect(job!.said.split("\n")).toEqual([placeNoLinkLine("box"), `${long.slice(0, 400)} (cut ${long.length - 400} characters)`, "agent: dial refused"]);
  });

  it("cuts the failed step's note to the length a log line keeps, and says the cut", async () => {
    const long = `root@10.0.0.9: ${"y".repeat(5_000)}`;
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(newPlaceKeyPair()),
        install: async (_req, stage) => {
          stage("connect", "running");
          throw new Error(`${long}\nsecond line`);
        },
      },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices, door });
    const stages: PlaceStageEvent[] = [];
    ctx.runtime.events.on("place.stage", e => stages.push(e as PlaceStageEvent));
    const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    sockets.push(c.ws);
    await c.request("places.add", { addId: "a_long", address: "root@10.0.0.9" });
    const cut = `${long.slice(0, 400)} (cut ${long.length - 400} characters)`;
    const [job] = (await addsOf(c)) as { steps: { note?: string }[] }[];
    expect(job!.steps.at(-1)).toMatchObject({ step: "connect", state: "failed", note: cut });
    expect(stages.at(-1)).toMatchObject({ step: "connect", state: "failed", note: cut });
  });

  it("refuses an add under the id of one still running, and leaves that one's job as it was", async () => {
    let go: () => void = () => {};
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(newPlaceKeyPair()),
        install: async (_req, stage) => {
          stage("connect", "running");
          await new Promise<void>(ok => (go = ok));
          throw new Error("root@10.0.0.9 did not answer on port 22");
        },
      },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices, door });
    const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    sockets.push(c.ws);
    const first = c.request("places.add", { addId: "a_one", address: "root@10.0.0.9" });
    await until(async () => (await addsOf(c)).length === 1);
    expect(await c.request("places.add", { addId: "a_one", address: "maya@elsewhere" })).toMatchObject({ ok: false, kind: "usage" });
    expect(await addsOf(c)).toEqual([expect.objectContaining({ addId: "a_one", address: "root@10.0.0.9", state: "running", steps: [{ step: "connect", state: "running" }] })]);
    go();
    await first;
  });

  it("keeps every add still running and the last twenty that finished", async () => {
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: { ...wiring(newPlaceKeyPair()), install: async () => Promise.reject(new Error("root@10.0.0.9 did not answer on port 22")) },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices, door });
    for (let n = 0; n < 22; n++) await ctx.runtime.places!.add({ addId: `a_${n}`, address: "root@10.0.0.9", hostUrls: DOOR }, Date.now()).catch(() => undefined);
    const c = await WsClient.connect(ctx.srv.port, { token: "host-token" });
    sockets.push(c.ws);
    expect(((await addsOf(c)) as { addId: string }[]).map(j => j.addId)).toEqual(Array.from({ length: 20 }, (_, n) => `a_${n + 2}`));
  });
});
