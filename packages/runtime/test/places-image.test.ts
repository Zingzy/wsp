// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { absentComputer, placeBuildsNoImageLine, placeCannotBootLine, placeDialBackLine, placeWentAwayLine, copyStoppedLine, type GoldenStageEvent, type PlaceView } from "@wsp/protocol";
import { createRuntime, wiredPlace, type GoldenRecipe } from "../src/runtime.js";
import { COPY_RECIPE, dfOk, recipeWith } from "./image-fixtures.js";
import { NoProviderBackend } from "@wsp/engine";
import { newPlaceKeyPair, type PlaceKeyPair } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend, createOn, projectOn } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";
import { HERE, report, wiring } from "./place-join.js";
import { ctx, sockets, serving, code, join, relink, placesOf, ForkingPlace, forks } from "./places-fixture.js";

describe("the image built through a computer you joined", () => {
  it("a copy build names the computer by its name or id, learns its backend from the computer itself, and is refused at the record rather than at the name", async () => {
    const { hostKey } = await serving();
    let place: ForkingPlace | undefined;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    await expect(ctx.runtime!.image.build({ place: "srv" })).rejects.toThrow(/owns no image named default/);
    await expect(ctx.runtime!.image.build({ place: placeId })).rejects.toThrow(/owns no image named default/);
    // One frame taught this host what srv forks with; nothing was made there.
    expect(place!.asked["machine.backend"]).toBe(1);
    expect(place!.created).toEqual([]);
    await expect(ctx.runtime!.image.build({ place: "nowhere" })).rejects.toThrow(/no place named nowhere; you have .*srv/);
  });

  it("the image is built on the joined computer when it is the default place, and when the provider this host forks on forks nothing", async () => {
    const { hostKey } = await serving();
    const marked = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(marked.client.ws);
    await ctx.runtime!.places!.markUsed(marked.placeId);
    const picked = await ctx.runtime!.golden.buildPlace();
    expect([picked.place, picked.name]).toEqual([marked.placeId, "srv"]);
    expect(picked.backend.capabilities.sizes.length).toBeGreaterThan(0);
    // The provider a keyless host wires forks nothing and is the default: the one joined computer that runs
    // workspaces is where the image goes, with nothing named.
    await ctx.srv?.close();
    await ctx.runtime?.close();
    const none = new NoProviderBackend();
    const keyless = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend: none, store: memoryStore(), adapters: {}, places: wiredPlace("none", none), placeLinks: wiring(keyless) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const joined = await join(keyless, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(joined.client.ws);
    const only = await ctx.runtime.golden.buildPlace();
    expect([only.place, only.name]).toEqual([joined.placeId, "srv"]);
  });
});

describe("the image build and the computer whose doctor said no, or that does not answer", () => {
  const BLOCKED = "this computer mounts cgroup v1 at /sys/fs/cgroup";
  const copyRecipe = (): GoldenRecipe => ({ setup: "true", smoke: "true" });

  it("a computer whose doctor said no never becomes a place: the join is refused in the doctor's own sentence and nothing is written", async () => {
    const { hostKey, store } = await serving();
    const { client, proved } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { runsWorkspaces: false, workspacesBlocked: BLOCKED }), answers: c => forks(c), expectProved: false });
    sockets.push(client.ws);
    expect(String(proved["error"])).toBe(placeCannotBootLine("srv", BLOCKED));
    expect(String(proved["error"])).toBe("srv cannot run wsp workspaces: it mounts cgroup v1 at /sys/fs/cgroup");
    // Nothing on the store, nothing on the list, and no road names it: the refusal is the whole of what happened.
    expect(await store.list("places")).toEqual([]);
    await expect(ctx.runtime!.golden.buildPlace("srv")).rejects.toThrow(/no place named srv/);
    await expect(ctx.runtime!.image.build({ place: "srv" })).rejects.toThrow(/no place named srv/);
    await expect(ctx.runtime!.golden.prepare({ place: "srv", recipe: copyRecipe() })).rejects.toThrow(/no place named srv/);
    await expect(projectOn(ctx.runtime!, "srv")).rejects.toThrow(/no place named srv/);
  });

  it("a default place that is not answering is the refusal the person reads, with its name in it, never a build sent to another place", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv" });
    await ctx.runtime!.places!.markUsed(placeId);
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    await expect(ctx.runtime!.golden.buildPlace()).rejects.toThrow(absentComputer("srv", null).sentence);
  });

  it("this computer is never built into: naming it for a copy build or a build place is refused rather than read as the provider this host forks on", async () => {
    await serving();
    await expect(ctx.runtime!.image.build({ place: HERE.name })).rejects.toThrow(placeBuildsNoImageLine(HERE.name));
    await expect(ctx.runtime!.golden.buildPlace(HERE.name)).rejects.toThrow(placeBuildsNoImageLine(HERE.name));
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
    ctx.runtime = createRuntime({
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
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    if (o.sealed) {
      const b = await ctx.runtime.golden.prepare();
      await ctx.runtime.golden.seal(b.id);
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
    ctx.runtime!.events.on("golden.stage", e => {
      if (e.type === "golden.stage") frames.push(e);
    });
    return frames;
  };

  it("builds that computer's copy only when asked, never on a link: the join socket and the agent's link start nothing, a press starts the build, and where the build stops the row says so, the builder is killed by its id and no copy is filed", async () => {
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
    await settled();
    expect(place.asked["machine.create"]).toBeUndefined();
    void ctx.runtime!.image.build({ place: placeId }).catch(() => undefined);
    await until(() => place.asked["machine.create"] === 1, 5000);
    expect(frames.some(f => f.place === placeId && f.stage === "creating")).toBe(true);
    // The fake computer runs no builder's setup, so the build stops there: the row says so in the seal's own
    // words, and the stopped build starts no second one on its own.
    await until(async () => (await rowOf(placeId)).build?.startsWith(copyStoppedLine()) === true, 5000);
    expect((await rowOf(placeId)).buildStopped).toBe(true);
    expect((await rowOf(placeId)).buildsImages).toBe(true);
    expect(frames.filter(f => f.place === placeId).map(f => f.stage)).toContain("failed");
    expect(place.killed).toHaveLength(1);
    expect((await ctx.runtime!.image.get()).copies.map(c => c.place)).toEqual(["solari"]);
    expect(place.asked["machine.create"]).toBe(1);
  });

  it("a fork there builds that computer's copy first, saying so with no rate since the computer charges nothing, and never forks the image it holds no copy of", async () => {
    const { hostKey } = await imageHost({ sealed: true });
    let place!: ForkingPlace;
    const { placeId } = await join(hostKey, { code: await code(), name: "srv", answers: answering(p => (place = p)) });
    await until(async () => (await rowOf(placeId)).present === true);
    const lines: string[] = [];
    ctx.runtime!.events.on("workspace.creating", e => {
      if (e.type === "workspace.creating" && e.name === "x") lines.push(e.message);
    });
    const head = (await ctx.runtime!.image.get()).copies.find(c => c.place === "solari")!.snapshotId;
    // The fake computer runs no builder's tool install, so the copy's build stops there and the fork with it; a
    // fork that forked the image anyway would have asked this computer for a second machine.
    await expect(createOn(ctx.runtime!, { golden: head, name: "x", on: "srv" })).rejects.toThrow(/launch failed/);
    expect(lines[0]).toBe("building your image on srv first, about ten minutes, then x forks from it");
    expect(place.created).toHaveLength(1);
    expect((place.created[0]!["labels"] as Record<string, string>)["wsp-builder"]).toBe("1");
    expect(place.killed).toHaveLength(1);
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
    const preparing = ctx.runtime!.golden.prepare({ place: joined.placeId, recipe: { setup: "true", smoke: "true" } }).catch(() => undefined);
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
    const preparing = ctx.runtime!.golden.prepare({ place: joined.placeId, recipe: { setup: "true", smoke: "true" } });
    await until(() => place.asked["machine.create"] === 1, 5000);
    const at = Date.now();
    joined.client.close();
    // The wait is a wait, not a second answer: past its bound the stage fails with the frame's own words, which is
    // what a person read on this stage before anything waited at all.
    await expect(preparing).rejects.toThrow("connection lost");
    // Node wakes a timer against its own clock, which can read short of the wall clock the elapsed here is
    // measured on (a runner read 299 ms of this 300 ms wait). Ten milliseconds of slack, rather than one, because
    // the gap is the two clocks drifting and not a fixed cost, and a wait that never happened is off by 300.
    expect(Date.now() - at).toBeGreaterThanOrEqual(300 - 10);
  });

  it("a copy build whose computer went and never dialled back ends stopped, saying it went away, and its next link puts no building frame back", async () => {
    const { hostKey } = await imageHost({ sealed: true, relinkWaitMs: 300 });
    const frames = framesOf();
    let place!: ForkingPlace;
    const joined = await join(hostKey, { code: await code(), name: "srv", answers: answering(p => (place = p)) });
    await until(() => place.asked["machine.backend"] === 1);
    place.swallow.add("machine.create");
    const building = ctx.runtime!.image.build({ place: joined.placeId });
    await until(() => place.asked["machine.create"] === 1, 5000);
    joined.client.close();
    await expect(building).rejects.toThrow();
    const ours = (): GoldenStageEvent[] => frames.filter(f => f.place === joined.placeId);
    expect(ours().at(-1)).toMatchObject({ stage: "failed", detail: placeWentAwayLine("srv") });
    expect((await rowOf(joined.placeId)).build).toBe(copyStoppedLine(placeWentAwayLine("srv")));
    expect((await rowOf(joined.placeId)).buildStopped).toBe(true);
    const said = ours().length;
    const linked = await relink(hostKey, joined.placeId, joined.pair, report("srv"), answering(() => undefined));
    sockets.push(linked.client.ws);
    await until(async () => (await rowOf(joined.placeId)).present === true);
    await settled();
    expect(ours().slice(said)).toEqual([]);
    expect((await rowOf(joined.placeId)).buildStopped).toBe(true);
  });

  it("builds nothing for a computer whose doctor said no, since its join never stood, and nothing at all on a host that holds no image", async () => {
    const { hostKey } = await imageHost({ sealed: true });
    let blocked!: ForkingPlace;
    const laptop = await join(hostKey, { code: await code(), name: "laptop", report: report("laptop", { runsWorkspaces: false }), answers: c => (blocked = forks(c)), expectProved: false });
    sockets.push(laptop.client.ws);
    await settled();
    expect(blocked.asked["machine.create"]).toBeUndefined();
    expect((await placesOf()).some(p => p.name === "laptop")).toBe(false);

    await ctx.srv?.close();
    await ctx.runtime?.close();
    const { hostKey: bare } = await serving();
    let place!: ForkingPlace;
    const { client, placeId } = await join(bare, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    await until(async () => (await rowOf(placeId)).present === true);
    await settled();
    expect(place.asked["machine.create"]).toBeUndefined();
    expect((await rowOf(placeId)).build).toBeUndefined();
  });

  it("a computer not connected at the cut builds nothing then and its row says nothing, and its next link builds nothing either", async () => {
    const { hostKey } = await imageHost({ sealed: false });
    let place!: ForkingPlace;
    const joined = await join(hostKey, { code: await code(), name: "srv", answers: answering(p => (place = p)) });
    // The computer said what it forks with, then went away.
    await until(() => place.asked["machine.backend"] === 1);
    joined.client.close();
    await until(async () => (await rowOf(joined.placeId)).present === false);
    const frames = framesOf();
    const b = await ctx.runtime!.golden.prepare();
    await ctx.runtime!.golden.seal(b.id);
    await settled();
    expect(frames.filter(f => f.place === joined.placeId)).toEqual([]);
    expect((await rowOf(joined.placeId)).build).toBeUndefined();
    let back!: ForkingPlace;
    const linked = await relink(hostKey, joined.placeId, joined.pair, report("srv"), answering(p => (back = p)));
    sockets.push(linked.client.ws);
    await until(async () => (await rowOf(joined.placeId)).present === true);
    await settled();
    expect(back.asked["machine.create"]).toBeUndefined();
    expect(frames.filter(f => f.place === joined.placeId)).toEqual([]);
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
    await ctx.srv!.close();
    await ctx.runtime!.close();
    // The host comes back on the same state and the computer dials in again.
    await imageHost({ sealed: false, store, hostKey });
    let again!: ForkingPlace;
    const linked = await relink(hostKey, joined.placeId, joined.pair, report("srv"), answering(p => (again = p)));
    sockets.push(linked.client.ws);
    const swept = await ctx.runtime!.reap();
    expect(again.asked["machine.get"]).toBeGreaterThanOrEqual(1);
    expect(again.killed).toEqual(["k7"]);
    expect(swept.reaped.map(r => r.id)).toContain("k7");
    expect(await store.get("builders", "k7")).toBeUndefined();
    expect(await store.keys("goldens")).toEqual([]);
  });
});
