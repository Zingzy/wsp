// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";
import { describe, expect, it } from "vitest";
import { workspaceStateOf, type TurnResult } from "@wsp/protocol";
import { copyKey, createRuntime, wiredPlace, type HarnessAdapterFactory, type PlaceBackends } from "../src/runtime.js";
import type { MachineBackend } from "@wsp/engine";
import { newPlaceKeyPair } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, createOn, projectOn } from "./stub-backend.js";
import { until } from "./until.js";
import { report, wiring } from "./place-join.js";
import { ctx, sockets, serving, code, join, relink, placesOf, ForkingPlace, KEEPS_NO_IMAGE, SEALED, forks, asRoot, ROOT_LOGIN } from "./places-fixture.js";

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
    ctx.runtime = createRuntime({
      backend: solari,
      store: memoryStore(),
      adapters: {},
      places: twoProviders("solari", { solari, box }),
      placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }),
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const rows = await placesOf();
    expect(rows.filter(p => p.kind === "provider").map(p => p.id)).toEqual(["solari", "box"]);
    for (const row of rows.filter(p => p.kind === "provider")) expect(row.takesForks, row.id).toBe(true);

    // Named on the line: the machine is minted by that provider and the record says where it stands.
    const there = await createOn(ctx.runtime, { golden: "snap_g", name: "x", on: "box" });
    expect(box.machines).toHaveLength(1);
    expect(solari.machines).toHaveLength(0);
    expect(there.place).toBe("box");
    expect(await ctx.runtime.workspaces.get(there.id)).toMatchObject({ place: "box" });
    // A second workspace of a project on that computer lands there too: the project says where, not a default.
    const again = await createOn(ctx.runtime, { golden: "snap_g", name: "y", on: "box" });
    expect(box.machines).toHaveLength(2);
    expect(again.place).toBe("box");

    // A project on the wired provider is the road a record with no place word already takes.
    const here = await createOn(ctx.runtime, { golden: "snap_g", name: "z", on: "solari" });
    expect(solari.machines).toHaveLength(1);
    expect(here.place).toBeUndefined();
  });

  it("a fork there reads the provider's word on its machine, never the silence of a computer with no link", async () => {
    const solari = stubBackend();
    const box = stubBackend();
    ctx.runtime = createRuntime({
      backend: solari,
      store: memoryStore(),
      adapters: {},
      places: twoProviders("solari", { solari, box }),
      placeLinks: wiring(newPlaceKeyPair(), { id: "solari", rateUsdPerHour: 0.11 }),
    });
    const there = await createOn(ctx.runtime, { golden: "snap_g", name: "x", on: "box" });
    const row = (await ctx.runtime.status.list()).find(s => s.id === there.id)!;
    expect(row.reason).toBeUndefined();
    expect(workspaceStateOf(row, row)).toBe("running");
    await ctx.runtime.workspaces.nap(there.id);
    const napped = (await ctx.runtime.status.list()).find(s => s.id === there.id)!;
    expect(workspaceStateOf(napped, napped)).toBe("paused");
  });

  it("a project image taken at that provider records the place and is removed there, never at the wired one", async () => {
    const solari = stubBackend();
    const box = stubBackend();
    ctx.runtime = createRuntime({
      backend: solari,
      store: memoryStore(),
      adapters: {},
      places: twoProviders("solari", { solari, box }),
      placeLinks: wiring(newPlaceKeyPair(), { id: "solari", rateUsdPerHour: 0.11 }),
      killConfirm: { graceMs: 40, pollMs: 1 },
    });
    const there = await createOn(ctx.runtime, { golden: "snap_g", name: "x", on: "box" });
    const golden = await ctx.runtime.workspaces.snapshot(there.id);
    expect(golden.place).toBe("box");
    expect((await ctx.runtime.image.get()).projects).toEqual([{ ...golden, sizeBytes: box.snapshotBytes }]);
    // The wired provider answers a delete of an id it never held as a success, which is how a wrong door would pass.
    const wiredDeletes: string[] = [];
    solari.deleteSnapshot = async id => void wiredDeletes.push(id);
    await ctx.runtime.golden.removeProject(golden.snapshotId);
    expect(wiredDeletes).toEqual([]);
    expect(box.snapshots).toEqual([]);
    expect(await ctx.runtime.golden.projects()).toEqual([]);
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
    ctx.runtime = createRuntime({
      backend: solari,
      store: memoryStore(),
      adapters: {},
      places: twoProviders("solari", { solari, box }),
      placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }),
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
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
    ctx.runtime = createRuntime({
      backend: solari,
      store: memoryStore(),
      adapters: {},
      places: twoProviders("solari", { solari, box }),
      placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }),
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    await expect(createOn(ctx.runtime, { golden: "snap_g", name: "x", on: "nowhere" })).rejects.toThrow(/no place named nowhere; you have .*solari.*box/);
  });
});

describe("a fork on a computer you joined", () => {
  it("tells a turn there which agents already hold a login on that computer, so the vault's key goes only where none does", async () => {
    const asked: Record<string, boolean>[] = [];
    const factory: HarnessAdapterFactory = ctx => {
      asked.push({ claude: ctx.loginStands("claude"), codex: ctx.loginStands("codex") });
      return {
        steers: false,
        start: ({ onEvent }) => {
          const sessionId = randomUUID();
          const result: TurnResult = { status: "completed", text: "ok" };
          onEvent({ type: "session.start", sessionId });
          onEvent({ type: "turn.done", sessionId, result });
          onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
        },
      };
    };
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: factory }, placeLinks: wiring(hostKey) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    // Joined as root, the one login a thread on a joined computer runs as.
    const signedIn = report("srv", { agents: ["claude", "codex"], logins: ["codex/auth.json"], login: ROOT_LOGIN });
    const { client } = await join(hostKey, { code: await code(), report: signedIn, answers: c => forks(c, undefined, asRoot, KEEPS_NO_IMAGE) });
    sockets.push(client.ws);
    const ws = await createOn(ctx.runtime, { name: "x", on: "srv" });
    await (await ctx.runtime.sessions.start(ws.id, { prompt: "one", harness: "claude" })).finished;
    // Codex signed in there wins over any key this host holds; Claude Code keeps no login on a machine, so the
    // vault is the whole of its sign-in and nothing stands against it.
    expect(asked.at(-1)).toEqual({ claude: false, codex: true });
  });

  it("still names the image where the computer keeps them: a fork at this host's own provider carries the template its version was promoted to", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    backend.capabilities.templates = true;
    backend.templates.set("tpl_g", { id: "tpl_g", name: "wsp-default-v1", status: "ready", snapshotId: "snap_g" });
    ctx.runtime = createRuntime({ backend, store, adapters: {}, places: wiredPlace("solari", backend), placeLinks: wiring(newPlaceKeyPair(), { id: "solari", rateUsdPerHour: 0.11 }) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    await store.put("goldens", copyKey("solari", "default"), SEALED);
    const made = await createOn(ctx.runtime, { golden: "snap_g", name: "y", on: "solari" });
    expect(backend.machines).toHaveLength(1);
    expect(backend.machines[0]!.spec).toMatchObject({ template: "tpl_g" });
    expect(made.golden).toBe("snap_g");
  });

  it("refuses a word that names no place, and names what this host holds", async () => {
    const { hostKey } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 } });
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    await expect(createOn(ctx.runtime!, { golden: "snap_g", name: "x", on: "nowhere" })).rejects.toThrow(/no place named nowhere; you have .*srv.*solari/);
  });

  it("never holds a computer that forks nowhere: the join turned it down, so no word names one", async () => {
    const { hostKey } = await serving();
    const { client } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { runsWorkspaces: false }), answers: c => forks(c), expectProved: false });
    sockets.push(client.ws);
    await expect(projectOn(ctx.runtime!, "srv")).rejects.toThrow(/no place named srv/);
    expect((await ctx.runtime!.workspaces.list()).filter(w => w.name === "x")).toEqual([]);
  });

  it("carries one port on this computer to one port on that one, for as long as the host runs", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const first = await ctx.runtime!.places!.forward(placeId, 32768);
    const again = await ctx.runtime!.places!.forward(placeId, 32768);
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
    expect((await ctx.runtime!.places!.forward(placeId, 32768)).localPort).toBe(first.localPort);
    await dialLocal(first.localPort);
    await until(async () => second.tunnels.some(t => t.port === 32768));
  });

  it("hands a channel on that computer's link the tunnel frames of a road it opened, and keeps its own forward's to itself", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const { localPort } = await ctx.runtime!.places!.forward(placeId, 32768);
    const pane = netConnect({ host: "127.0.0.1", port: localPort });
    await until(async () => place.tunnels.length === 1);
    const own = place.tunnels[0]!.tunnelId;
    const heard: Record<string, unknown>[] = [];
    const channel = ctx.runtime!.places!.channel(placeId, e => void heard.push(e))!;
    place.push({ type: "tunnel.data", tunnelId: own, data: "aGk=" });
    place.push({ type: "tunnel.data", tunnelId: "t9", data: "aGk=" });
    place.push({ type: "tunnel.end", tunnelId: "t9" });
    await until(async () => heard.length === 2);
    expect(heard).toEqual([
      { type: "tunnel.data", tunnelId: "t9", data: "aGk=" },
      { type: "tunnel.end", tunnelId: "t9" },
    ]);
    channel.close();
    pane.destroy();
  });

  it("a napping fork is not counted as one that runs, and the room is what a create can take now", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      // One running and one napping machine on that computer, as its own backend counts them under a stopping nap:
      // the napping one holds the disk its copy takes and no cpu or memory, so it takes no slot from a create.
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
    expect((await placesOf()).find(p => p.id === placeId)!.forks).toEqual({ running: 1, room: 2 });
  });

  it("shows how many forks a place holds of how many it takes", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.forks !== undefined);
    // Nine thousand megabytes of room at four thousand a fork is two; ten gigabytes of disk at four an image is two.
    expect((await placesOf()).find(p => p.id === placeId)!.forks).toEqual({ running: 1, room: 2 });
  });

  it("refuses to take a computer out from under the projects recorded on it, naming them, and sweeps nothing", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const swept: string[] = [];
    client.onFrame(raw => {
      const frame = raw as unknown as { op?: string };
      if (frame.op === "place.leave") swept.push("asked");
    });
    // A project with no workspace of it: the forks refusal cannot be what answers here, so the projects one is.
    await projectOn(ctx.runtime!, "srv", "https://github.com/wsp/spoo-landing.git", { name: "spoo-landing" });
    await expect(ctx.runtime!.places!.remove(placeId)).rejects.toThrow(/srv still holds a project \(spoo-landing\); wsp projects remove each of them first/);
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
