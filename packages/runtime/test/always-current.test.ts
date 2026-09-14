// SPDX-License-Identifier: AGPL-3.0-only
// A place is always current: the cut that moves the record builds every other
// place's copy behind the seal, a workspace created there while it builds joins
// that build and forks the copy it seals, the row says where the build is, a
// build that stopped leaves its reason on the row for the next build there to
// take over, and a host with no image builds nothing anywhere.
import { describe, expect, it } from "vitest";
import { NoProviderBackend, type MachineSpec } from "@wsp/engine";
import { copyStoppedLine, type PlaceView } from "@wsp/protocol";
import { copyKey, createRuntime, type PlaceBackends } from "../src/runtime.js";
import { goldenHead } from "../src/index.js";
import { newPlaceKeyPair, type PlaceWiring } from "../src/places.js";
import { memoryStore } from "../src/store.js";
import { COPY_RECIPE, dfOk, recipeWith } from "./image-fixtures.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { until } from "./until.js";

/** Three providers over three stubs, as the host's table hands them down: the stand-in this host forks on and
 * seals at, and two more it holds a key for, each marking its snapshot ids so which place's copy a fork names is
 * read off the id; beside them a provider that forks nothing. The door is wired so a create names its place and
 * the rows are read the way wsp places and the app read them. */
function providers() {
  const fake = stubBackend("fake");
  const solari = stubBackend("solari");
  const box = stubBackend("box");
  for (const b of [fake, solari, box]) b.execImpl = dfOk;
  const none = new NoProviderBackend();
  const at: Record<string, StubBackend | NoProviderBackend> = { fake, solari, box, none };
  const places: PlaceBackends = { wired: "fake", backend: p => at[p], list: () => Object.keys(at) };
  const wiring: PlaceWiring = { hostKey: newPlaceKeyPair(), provider: () => ({ id: "fake", rateUsdPerHour: 0 }), here: () => ({ name: "this-mac" }), hostName: () => "this-mac" };
  // How often this computer was read for a copy's recipe: once per build that ran, never for one that did not.
  const composed = { count: 0 };
  const store = memoryStore();
  const rt = createRuntime({
    backend: fake,
    store,
    adapters: {},
    goldenRecipe: recipeWith(),
    copyRecipe: () => {
      composed.count += 1;
      return COPY_RECIPE;
    },
    hostId: "h1",
    places,
    placeLinks: wiring,
  });
  const frames: { stage: string; place?: string }[] = [];
  rt.events.on("golden.stage", e => {
    if (e.type === "golden.stage") frames.push({ stage: e.stage, ...(e.place !== undefined ? { place: e.place } : {}) });
  });
  const rows = async (): Promise<PlaceView[]> => rt.places!.list(Date.now());
  const row = async (id: string): Promise<PlaceView> => (await rows()).find(p => p.id === id)!;
  const current = async (place: string): Promise<boolean> => {
    const view = await rt.image.get();
    return view.copies.some(c => c.place === place && c.hash === view.image!.hash);
  };
  const seal = async (recipeHash?: string) => {
    const b = await rt.golden.prepare(recipeHash === undefined ? undefined : { recipe: recipeWith({ recipeHash }) });
    return rt.golden.seal(b.id);
  };
  const head = async (): Promise<string> => goldenHead(await rt.golden.get())!.snapshotId;
  return { fake, solari, box, rt, store, composed, frames, row, current, seal, head };
}

/** Holds a stub's creates until released: a build blocked on its first machine, so what happens beside it is read
 * at a moment of the test's choosing. */
function held(stub: StubBackend): () => void {
  let release: () => void = () => {};
  const gate = new Promise<void>(r => (release = r));
  const create = stub.create.bind(stub);
  stub.create = async (spec: MachineSpec) => {
    await gate;
    return create(spec);
  };
  return release;
}

describe("a place is always current", () => {
  it("a cut moves the record's hash and every other place that runs workspaces builds its copy behind the seal, one build each; a seal that moves nothing builds nothing; a live fork keeps what it booted", async () => {
    const { fake, solari, box, rt, current, seal, head } = providers();
    await seal();
    await until(async () => (await current("solari")) && (await current("box")), 5000);
    expect([fake.snapshots.length, solari.snapshots.length, box.snapshots.length]).toEqual([1, 1, 1]);
    // A fork at solari takes solari's own copy, which its snapshot id says.
    const made = await rt.workspaces.create({ golden: await head(), name: "x", on: "solari" });
    expect(made.golden).toContain("solari-");
    expect(solari.machines.at(-1)!.spec.fromSnapshot).toBe(made.golden);
    // The same recipe sealed again moves no hash, so no copy is owed anywhere.
    await seal();
    expect((await rt.image.get()).image!.version).toBe(2);
    // The next recipe moves it: every other place follows, one build each, and the fork stays on what it booted.
    await seal("h2");
    await until(async () => (await current("solari")) && (await current("box")), 5000);
    expect([fake.snapshots.length, solari.snapshots.length, box.snapshots.length]).toEqual([3, 2, 2]);
    const kept = await rt.workspaces.get(made.id);
    expect([kept.golden, kept.machineId]).toEqual([made.golden, made.machineId]);
    await rt.close();
  });

  it("a workspace created on a place whose copy is building joins the build, forks the copy it seals and starts no second one; the row reads the build's stage while it runs and nothing after", async () => {
    const { solari, rt, frames, row, seal, head, composed, current } = providers();
    const release = held(solari);
    await seal();
    await until(() => frames.some(f => f.place === "solari"));
    expect((await row("solari")).build).toBe("building your image · creating the machine");
    // The create and a second keep both arrive while the builder is still being made.
    const creating = rt.workspaces.create({ golden: await head(), name: "x", on: "solari" });
    void rt.image.keepCurrent("solari");
    release();
    const made = await creating;
    const copy = (await rt.image.get()).copies.find(c => c.place === "solari")!;
    expect(made.golden).toBe(copy.snapshotId);
    expect(solari.machines.at(-1)!.spec.fromSnapshot).toBe(copy.snapshotId);
    expect(solari.snapshots).toHaveLength(1);
    expect((await row("solari")).build).toBeUndefined();
    await until(async () => current("box"), 5000);
    // One read of this computer per place that built.
    expect(composed.count).toBe(2);
    await rt.close();
  });

  it("a build that stopped leaves its reason on the place's row and no copy there; the next build there, which a create or wsp image build asks for, takes the row over", async () => {
    const { solari, rt, row, seal, current } = providers();
    const create = solari.create.bind(solari);
    solari.create = async () => {
      throw Object.assign(new Error("no room at solari today"), { kind: "conflict" });
    };
    await seal();
    await until(async () => (await row("solari")).build?.startsWith(copyStoppedLine()) === true, 5000);
    expect((await row("solari")).build).toContain("no room at solari today");
    await until(async () => current("box"), 5000);
    expect((await rt.image.get()).copies.map(c => c.place).sort()).toEqual(["box", "fake"]);
    solari.create = create;
    const { built } = await rt.image.build({ place: "solari" });
    expect(built).toBe(true);
    expect(await current("solari")).toBe(true);
    expect((await row("solari")).build).toBeUndefined();
    await rt.close();
  });

  it("a copy whose build began on one record and sealed after the cut to the next is stamped with the record it was built from, reads stale, and is built again; the next fork there takes the new copy", async () => {
    const { solari, box, rt, store, frames, current, seal, head } = providers();
    const releaseSolari = held(solari);
    const releaseBox = held(box);
    await seal();
    const v1 = (await rt.image.get()).image!.hash;
    await until(() => frames.some(f => f.place === "solari") && frames.some(f => f.place === "box"));
    // The cut lands while both copies are still being built from v1.
    await seal("h2");
    const v2 = (await rt.image.get()).image!.hash;
    expect(v2).not.toBe(v1);
    releaseSolari();
    releaseBox();
    await until(async () => (await current("solari")) && (await current("box")), 5000);
    // Each place's first copy carries the hash it was built from, its second the record's now: two builds, not one
    // relabelled.
    for (const place of ["solari", "box"]) {
      const manifest = (await store.get("goldens", copyKey(place, "default"))) as { versions: { imageHash?: string }[] };
      expect(manifest.versions.map(v => v.imageHash)).toEqual([v1, v2]);
    }
    expect([solari.snapshots.length, box.snapshots.length]).toEqual([2, 2]);
    const made = await rt.workspaces.create({ golden: await head(), name: "x", on: "solari" });
    const copy = (await rt.image.get()).copies.find(c => c.place === "solari")!;
    expect(copy.hash).toBe(v2);
    expect(made.golden).toBe(copy.snapshotId);
    await rt.close();
  });

  it("a host with no sealed image keeps nothing current, and a place that forks nothing owes no copy: nothing composed, nothing built, nothing on the row", async () => {
    const { solari, rt, row, composed, seal, current } = providers();
    await rt.image.keepCurrent("solari");
    expect([solari.machines.length, composed.count]).toEqual([0, 0]);
    expect((await row("solari")).build).toBeUndefined();
    await seal();
    await rt.image.keepCurrent("none");
    expect((await row("none")).build).toBeUndefined();
    await until(async () => (await current("solari")) && (await current("box")), 5000);
    expect(composed.count).toBe(2);
    await rt.close();
  });
});
