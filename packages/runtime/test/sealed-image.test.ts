// SPDX-License-Identifier: AGPL-3.0-only
// The image the host owns and the copy each place holds of it: what a seal
// records, what a state file written before places boots as, and what a build
// at a second place does and refuses.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NoProviderBackend, imageHash } from "@wsp/engine";
import type { GoldenImport } from "@wsp/engine";
import { RUNTIME_OPS, THREAD_OPS, SealedImageView, placeBuildsNoImageLine, sealedCopyLine, type Recipe, type RecipeDigest, type SealedImage } from "@wsp/protocol";
import { copyKey, createRuntime, wiredPlace, type GoldenRecipe, type PlaceBackends, type Runtime } from "../src/runtime.js";
import { newPlaceKeyPair, type PlaceWiring } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { WsClient } from "./ws-client.js";

const dfOk = (m: unknown, cmd: string) =>
  cmd.startsWith("df -Pk")
    ? { exitCode: 0, stdout: `${3000 * 1024}\n`, stderr: "" }
    : cmd === "echo ok"
      ? { exitCode: 0, stdout: "ok\n", stderr: "" }
      : cmd.includes("echo WSP_CTX")
        ? { exitCode: 0, stdout: "WSP_CTX\nWSP_CTX_END\n", stderr: "" }
        : cmd.startsWith("for p in ")
          ? { exitCode: 0, stdout: "/root/.codex/auth.json\n", stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" };

const digestOf = (recipeHash: string): RecipeDigest => ({ ticks: [{ id: "agents/codex" }], files: [{ id: "agents/codex", dest: ".codexrc", path: "~/.codexrc", digest: `d-${recipeHash}` }] });
const importOf = (recipeHash = "h1"): GoldenImport => ({
  recipeHash,
  recipe: digestOf(recipeHash),
  files: { count: 1, rungs: { shell: 1 }, bytes: 10, skipped: [], pack: async () => ({ tar: Buffer.from("t"), bytes: 10, unpacked: 10, skipped: [], cut: [], silenced: [] }) },
  tools: [],
  agents: [],
});
const SMALL: Recipe = { version: 1, at: "2026-09-12T00:00:00.000Z", histories: [], rows: [{ id: "codex", kind: "agent", on: true, source: { kind: "used", sessions: 3, calls: 12 } }] };
const VAULT_PATHS = ["/root/.codex/auth.json", "/etc/profile.d/wsp-secrets.sh"];
const recipeWith = (o: { recipeHash?: string; vault?: boolean } = {}): GoldenRecipe => ({
  setup: "true",
  smoke: "true",
  import: importOf(o.recipeHash ?? "h1"),
  source: SMALL,
  ...(o.vault === false ? {} : { vaultPaths: VAULT_PATHS }),
});

/** What the stub's guest tar comes down as: the empty archive its download server serves for any path. */
const EMPTY_TGZ_SHA = createHash("sha256").update(require("node:zlib").gzipSync(Buffer.alloc(1024))).digest("hex");

/** What this computer says about itself, for the runs that name a place on the line: the place door reads it, and
 * nothing in this file joins a computer, so the rows come from the provider table alone. */
const HERE = { name: "zingzys-mac", os: "macOS 15.0", shape: { cpu: 8, memMb: 16384 }, docker: true };

function started(o: { places?: (wired: StubBackend) => PlaceBackends; store?: Store; copyRecipe?: (image: SealedImage) => GoldenRecipe; links?: boolean } = {}) {
  const backend = stubBackend();
  backend.execImpl = dfOk;
  const store = o.store ?? memoryStore();
  const places = o.places?.(backend);
  const placeLinks: PlaceWiring = { hostKey: newPlaceKeyPair(), provider: () => ({ id: "docker", rateUsdPerHour: 0.11 }), here: () => HERE, hostName: () => HERE.name };
  const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", ...(places !== undefined ? { places } : {}), ...(o.copyRecipe !== undefined ? { copyRecipe: o.copyRecipe } : {}), ...(o.links === true ? { placeLinks } : {}) });
  return { backend, store, rt };
}

/** Two places over one runtime: the wired stub and one more named `solari`. */
function twoPlaces() {
  const other = stubBackend("solari");
  other.execImpl = dfOk;
  const places = (wired: StubBackend): PlaceBackends => ({
    wired: "docker",
    backend: place => (place === "docker" ? wired : place === "solari" ? other : undefined),
    list: () => ["docker", "solari"],
  });
  return { other, places };
}

describe("the image record a seal writes", () => {
  it("a seal through a recipe with vault paths writes the record, its hash and the vault blob, and stamps the hash on the version", async () => {
    const { store, rt } = started();
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    const image = (await store.get("images", "default")) as { hash: string; recipeHash: string; recipe: Recipe; vault: { sha256: string; paths: number } };
    expect(image).toMatchObject({ name: "default", version: 1, recipeHash: "h1", recipe: SMALL, sealedFrom: "h1" });
    expect(image.vault).toMatchObject({ sha256: EMPTY_TGZ_SHA, paths: 1 });
    expect(image.hash).toBe(imageHash("h1", EMPTY_TGZ_SHA));
    expect(version.imageHash).toBe(image.hash);
    expect(await store.getBlob("image-vaults", "default@v1")).toBeDefined();
    const view = await rt.image.get();
    expect(view.image).toMatchObject({ hash: image.hash });
    expect(view.copies).toEqual([expect.objectContaining({ place: "default", version: 1, hash: image.hash, snapshotId: version.snapshotId })]);
    await rt.close();
  });

  it("a seal that names no vault paths records the image with none, and its hash differs from one that held a vault", async () => {
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith({ vault: false }), hostId: "h1" });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    const image = (await store.get("images", "default")) as { hash: string; vault?: unknown };
    expect(image.vault).toBeUndefined();
    expect(image.hash).toBe(imageHash("h1", undefined));
    expect(await store.getBlob("image-vaults", "default@v1")).toBeUndefined();
    await rt.close();
  });

  it("image.get on a store that has never sealed answers no image, no copy and no project", async () => {
    const { rt } = started();
    expect(await rt.image.get()).toEqual({ image: null, copies: [], projects: [] });
    await rt.close();
  });

  it("a host whose provider cannot fork files nothing: the bare key stays and the golden is still there when a key is saved", async () => {
    const store = memoryStore();
    const version = { version: 1, snapshotId: "snap_old", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } };
    await store.put("goldens", "default", { head: 1, versions: [version] });
    await store.put("golden-recipes", "default@v1", digestOf("old"));
    // A host started with no provider key: the module it is wired with forks nothing and names no place a copy
    // could belong to.
    const none = new NoProviderBackend();
    const noKey = createRuntime({ backend: none, store, adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", places: wiredPlace("none", none) });
    expect(await noKey.golden.get()).toMatchObject({ head: 1 });
    expect(await store.keys("goldens")).toEqual(["default"]);
    expect((await noKey.image.get()).copies.map(c => c.place)).toEqual(["none"]);
    await noKey.close();

    // The key is saved and the host restarts on a module that forks: only now is the copy filed under its place.
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const wired = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", places: wiredPlace("solari", backend) });
    expect(await wired.golden.get()).toMatchObject({ head: 1 });
    expect(await store.keys("goldens")).toEqual([copyKey("solari", "default")]);
    expect(await store.keys("golden-recipes")).toEqual([copyKey("solari", "default@v1")]);
    await wired.close();
  });

  it("the bare key is dropped only after the new one is written and read back, so a half-migrated store settles on one key", async () => {
    const store = memoryStore();
    const manifest = { head: 1, versions: [{ version: 1, snapshotId: "snap_old", baseTemplate: "base", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }] };
    // A boot that wrote the new key and died before the delete: both keys stand.
    await store.put("goldens", "default", manifest);
    await store.put("goldens", copyKey("default", "default"), manifest);
    const { rt, store: held } = started({ store });
    expect(await rt.golden.get()).toMatchObject({ head: 1 });
    expect(await held.keys("goldens")).toEqual([copyKey("default", "default")]);
    await rt.close();

    // A store whose put does not land keeps the bare key rather than losing the copy with it.
    const lossy = memoryStore();
    await lossy.put("goldens", "default", manifest);
    const dropping = { ...lossy, put: async (collection: string, id: string, value: unknown) => (collection === "goldens" && id.includes("/") ? undefined : lossy.put(collection, id, value)) };
    const over = createRuntime({ backend: stubBackend(), store: dropping, adapters: {}, goldenRecipe: recipeWith(), hostId: "h1" });
    expect(await over.golden.get()).toMatchObject({ head: 1 });
    expect(await lossy.keys("goldens")).toEqual(["default"]);
    await over.close();
  });

  it("a state file written before places boots with its manifest and recipe under the wired place, the bare keys gone, and reads as one copy of a record with no vault", async () => {
    const store = memoryStore();
    const version = { version: 1, snapshotId: "snap_old", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 }, logins: [{ name: "codex", state: "signed-in" as const }] };
    await store.put("goldens", "default", { head: 1, versions: [version] });
    await store.put("golden-recipes", "default@v1", digestOf("old"));
    const { rt } = started({ store });
    const view = await rt.image.get();
    expect(await store.keys("goldens")).toEqual([copyKey("default", "default")]);
    expect(await store.keys("golden-recipes")).toEqual([copyKey("default", "default@v1")]);
    expect(view.image).toMatchObject({ name: "default", version: 1, logins: [{ name: "codex", state: "signed-in" }] });
    expect(view.image!.vault).toBeUndefined();
    expect(view.image!.recipe).toBeUndefined();
    expect(view.copies).toEqual([expect.objectContaining({ place: "default", version: 1, snapshotId: "snap_old" })]);
    expect(view.copies[0]!.hash).toBeUndefined();
    expect(await rt.golden.get()).toMatchObject({ head: 1 });
    await rt.close();
  });
});

describe("building the image at a second place", () => {
  /** The recipe the host composes off the record; the runtime asks for it only once every refusal has passed, so a
   * test that expects a refusal proves the composition was never asked for. */
  const copyRecipeOf = (asked?: { count: number }) => (): GoldenRecipe => {
    if (asked !== undefined) asked.count += 1;
    return { setup: "true", smoke: "true", import: importOf("h1"), source: SMALL };
  };

  async function sealedAtWired(asked?: { count: number }) {
    const { other, places } = twoPlaces();
    const { backend, store, rt } = started({ places, copyRecipe: copyRecipeOf(asked) });
    const b = await rt.golden.prepare();
    const { version } = await rt.golden.seal(b.id);
    return { backend, other, store, rt, version };
  }

  it("prepares at the second place, lands the record's vault there, seals, and records that place's copy at the record's hash", async () => {
    const { backend, other, store, rt } = await sealedAtWired();
    const madeAtWired = backend.machines.length;
    const frames: { stage: string; place?: string }[] = [];
    rt.events.on("golden.stage", e => {
      if (e.type === "golden.stage") frames.push({ stage: e.stage, ...(e.place !== undefined ? { place: e.place } : {}) });
    });
    const { copy, built } = await rt.image.build({ place: "solari" });
    const record = (await store.get("images", "default")) as { hash: string };
    expect(built).toBe(true);
    expect(copy).toMatchObject({ place: "solari", version: 1, hash: record.hash });
    // The record's own vault bytes landed on the builder at the second place, and the wired provider never heard of the build.
    expect(other.puts.some(p => createHash("sha256").update(p.body).digest("hex") === EMPTY_TGZ_SHA)).toBe(true);
    expect(backend.machines.length).toBe(madeAtWired);
    // Every line the build reports names the place it runs at, and the build's own stages are all there: the
    // builder made, the vault landed, the snapshot taken, the copy sealed.
    expect(frames.every(f => f.place === "solari")).toBe(true);
    for (const stage of ["creating", "uploading-files", "ready", "snapshotting", "sealed"]) expect(frames.map(f => f.stage)).toContain(stage);
    // One image, two copies, one hash.
    const view = await rt.image.get();
    expect(view.copies.map(c => [c.place, c.version, c.hash])).toEqual([
      ["docker", 1, record.hash],
      ["solari", 1, record.hash],
    ]);
    await rt.close();
  });

  it("a copy build never runs a sign-in stage and takes no second vault off its own builder", async () => {
    const { other, store, rt } = await sealedAtWired();
    await rt.image.build({ place: "solari" });
    expect(other.machines.flatMap(m => m.execLog).some(c => c.startsWith("for p in "))).toBe(false);
    const image = (await store.get("images", "default")) as { version: number };
    expect(image.version).toBe(1);
    expect(await store.getBlob("image-vaults", "default@v1")).toBeDefined();
    expect(await store.getBlob("image-vaults", "default@v2")).toBeUndefined();
    await rt.close();
  });

  it("a place already holding a copy of this record is answered with that copy and builds nothing", async () => {
    const asked = { count: 0 };
    const { other, rt } = await sealedAtWired(asked);
    const first = await rt.image.build({ place: "solari" });
    const made = other.machines.length;
    const composed = asked.count;
    const again = await rt.image.build({ place: "solari" });
    expect(again).toEqual({ copy: first.copy, built: false });
    // Nothing was forked and this computer was never read for a recipe the build would not have used.
    expect(other.machines.length).toBe(made);
    expect(asked.count).toBe(composed);
    await rt.close();
  });

  it("the wired place and a place this host has never heard of are both refused before anything boots", async () => {
    const asked = { count: 0 };
    const { other, rt } = await sealedAtWired(asked);
    await expect(rt.image.build({ place: "docker" })).rejects.toMatchObject({ kind: "conflict" });
    await expect(rt.image.build({ place: "nowhere" })).rejects.toMatchObject({ kind: "missing" });
    expect(other.machines.length).toBe(0);
    expect(asked.count).toBe(0);
    await rt.close();
  });

  it("a place that forks nothing and copies no disk takes no copy of the image, and is refused before anything boots", async () => {
    const none = new NoProviderBackend();
    const places = (wired: StubBackend): PlaceBackends => ({
      wired: "docker",
      backend: place => (place === "docker" ? wired : place === "here" ? none : undefined),
      list: () => ["docker", "here"],
    });
    const asked = { count: 0 };
    const { rt } = started({ places, copyRecipe: copyRecipeOf(asked) });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    await expect(rt.image.build({ place: "here" })).rejects.toMatchObject({ kind: "conflict", message: placeBuildsNoImageLine("here") });
    expect(asked.count).toBe(0);
    expect((await rt.image.get()).copies.map(c => c.place)).toEqual(["docker"]);
    await rt.close();
  });

  it("a record with no vault is refused unless force, and with force the copy is recorded and holds no sign-ins", async () => {
    const { other, places } = twoPlaces();
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith({ vault: false }), copyRecipe: copyRecipeOf(), hostId: "h1", places: places(backend) });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    await expect(rt.image.build({ place: "solari" })).rejects.toMatchObject({ kind: "conflict" });
    expect(other.machines.length).toBe(0);
    const frames: string[] = [];
    rt.events.on("golden.stage", e => {
      if (e.type === "golden.stage") frames.push(`${e.stage}:${e.detail ?? ""}`);
    });
    const { copy } = await rt.image.build({ place: "solari", force: true });
    expect(copy.place).toBe("solari");
    expect((await rt.image.get()).image!.vault).toBeUndefined();
    expect(frames.some(f => f.includes("sign-ins"))).toBe(false);
    await rt.close();
  });

  it("a backfilled record judges no copy: it was read back off that copy and has nothing to judge it by", async () => {
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [{ version: 1, snapshotId: "snap_old", baseTemplate: "base", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 }, imageHash: "c".repeat(64) }] });
    const { rt } = started({ store });
    const view = await rt.image.get();
    expect(view.image!.vault).toBeUndefined();
    expect(sealedCopyLine(view.image!, view.copies[0]!)).not.toContain("stale");
    expect(sealedCopyLine(view.image!, view.copies[0]!)).not.toContain("current");
    await rt.close();
  });

  it("a state file the boot has not migrated is read as the wired place's copy and never as another place's", async () => {
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [{ version: 1, snapshotId: "snap_old", baseTemplate: "base", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }] });
    const { other, places } = twoPlaces();
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", places: places(backend) });
    const view = await rt.image.get();
    expect(view.copies.map(c => c.place)).toEqual(["docker"]);
    expect(other.machines.length).toBe(0);
    await rt.close();
  });

  it("a record with no small recipe cannot be built anywhere else", async () => {
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [{ version: 1, snapshotId: "snap_old", baseTemplate: "base", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }] });
    const { other, places } = twoPlaces();
    const backend = stubBackend();
    backend.execImpl = dfOk;
    const rt = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipeWith(), hostId: "h1", places: places(backend) });
    await expect(rt.image.build({ place: "solari" })).rejects.toMatchObject({ kind: "conflict" });
    expect(other.machines.length).toBe(0);
    await rt.close();
  });

  it("a copy built at an older record reads as stale beside the record, and building again refreshes it", async () => {
    const { store, rt } = await sealedAtWired();
    await rt.image.build({ place: "solari" });
    // The next version at the wired place moves the record's hash; the copy still names the old one.
    const b2 = await rt.golden.prepare({ recipe: recipeWith({ recipeHash: "h2" }) });
    await rt.golden.seal(b2.id);
    const record = (await store.get("images", "default")) as SealedImage;
    const view = await rt.image.get();
    expect(record.version).toBe(2);
    const solari = view.copies.find(c => c.place === "solari")!;
    expect(solari.hash).not.toBe(record.hash);
    // The copy is the place's own v1 against the record's v2, and it is the hash that says it is behind.
    expect(solari.version).toBe(1);
    expect(sealedCopyLine(record as SealedImage, solari)).toContain("stale");
    expect(view.copies.find(c => c.place === "docker")!.hash).toBe(record.hash);
    await rt.close();
  });
});

describe("a workspace created where the image has no copy yet", () => {
  /** The recipe a copy builds from, counted so a test can say the composition was never asked for. */
  const copyRecipeOf = (asked?: { count: number }) => (): GoldenRecipe => {
    if (asked !== undefined) asked.count += 1;
    return { setup: "true", smoke: "true", import: importOf("h1"), source: SMALL };
  };

  /** A host with the image sealed at the place it forks on and a second place holding nothing. */
  async function sealedAtWired(asked?: { count: number }) {
    const { other, places } = twoPlaces();
    const { backend, store, rt } = started({ places, copyRecipe: copyRecipeOf(asked), links: true });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    const wired = goldenHeadOf(await rt.golden.get());
    return { backend, other, store, rt, wired };
  }

  const goldenHeadOf = (manifest: { head: number; versions: { version: number; snapshotId: string }[] } | undefined): string =>
    manifest!.versions.find(v => v.version === manifest!.head)!.snapshotId;

  it("builds the copy there before the fork, names the place on every line, and forks that place's own snapshot", async () => {
    const { other, rt, wired } = await sealedAtWired();
    const lines: { stage: string; place?: string }[] = [];
    const made: string[] = [];
    rt.events.on("golden.stage", e => {
      if (e.type === "golden.stage") lines.push({ stage: e.stage, ...(e.place !== undefined ? { place: e.place } : {}) });
    });
    rt.events.on("workspace.creating", e => {
      if (e.type === "workspace.creating") made.push(e.stage);
    });
    const workspace = await rt.workspaces.create({ golden: wired, name: "spoo-fix", on: "solari" });
    // The place holds a copy it did not have, built there, and the fork stands on that copy's own snapshot, which
    // is that place's own id and not this computer's.
    const copy = (await rt.image.get()).copies.find(c => c.place === "solari")!;
    expect(copy.snapshotId).not.toBe(wired);
    expect((await rt.workspaces.get(workspace.id)).golden).toBe(copy.snapshotId);
    expect(workspace.place).toBe("solari");
    // Every line of the build names the place it ran at, and all of them came before the create said a word.
    for (const stage of ["creating", "uploading-files", "ready", "snapshotting", "sealed"]) expect(lines.map(l => l.stage)).toContain(stage);
    expect(lines.every(l => l.place === "solari")).toBe(true);
    expect(made[0]).toBe("fork-requested");
    await rt.close();
  });

  it("the next workspace there builds nothing: the copy standing on the record is what it forks", async () => {
    const asked = { count: 0 };
    const { other, rt, wired } = await sealedAtWired(asked);
    await rt.workspaces.create({ golden: wired, name: "one", on: "solari" });
    const builders = other.machines.length;
    const composed = asked.count;
    const second = await rt.workspaces.create({ golden: wired, name: "two", on: "solari" });
    // One more machine, the fork itself, and this computer was never read for a recipe nothing would build from.
    expect(other.machines.length).toBe(builders + 1);
    expect(asked.count).toBe(composed);
    expect((await rt.workspaces.get(second.id)).golden).toBe((await rt.image.get()).copies.find(c => c.place === "solari")!.snapshotId);
    await rt.close();
  });

  it("two workspaces asked for at once on a box that holds no copy build one copy between them", async () => {
    const asked = { count: 0 };
    const { other, rt, wired } = await sealedAtWired(asked);
    // Both land, which is the whole of it: before the join the second met a builder the first had already stopped
    // and came back gone, so an await of the pair threw here.
    const both = await Promise.all([rt.workspaces.create({ golden: wired, name: "one", on: "solari" }), rt.workspaces.create({ golden: wired, name: "two", on: "solari" })]);
    // One build between them: the recipe is composed once per build, so a second builder would read this computer again.
    expect(asked.count).toBe(1);
    const copies = (await rt.image.get()).copies.filter(c => c.place === "solari");
    expect(copies).toHaveLength(1);
    for (const workspace of both) expect((await rt.workspaces.get(workspace.id)).golden).toBe(copies[0]!.snapshotId);
    await rt.close();
  });

  it("a fork at the place this host forks on takes the snapshot it was asked for and builds no copy", async () => {
    const asked = { count: 0 };
    const { rt, wired } = await sealedAtWired(asked);
    const workspace = await rt.workspaces.create({ golden: wired, name: "here", on: "docker" });
    expect((await rt.workspaces.get(workspace.id)).golden).toBe(wired);
    expect(asked.count).toBe(0);
    expect((await rt.image.get()).copies.map(c => c.place)).toEqual(["docker"]);
    await rt.close();
  });

  it("a snapshot no record's head stands at is forked where it was asked for and builds no copy", async () => {
    const asked = { count: 0 };
    const { rt } = await sealedAtWired(asked);
    const workspace = await rt.workspaces.create({ golden: "snap_elsewhere", name: "x", on: "solari" });
    expect((await rt.workspaces.get(workspace.id)).golden).toBe("snap_elsewhere");
    expect(asked.count).toBe(0);
    expect((await rt.image.get()).copies.map(c => c.place)).toEqual(["docker"]);
    await rt.close();
  });
});

describe("the image over the protocol", () => {
  let srv: Awaited<ReturnType<typeof serveRuntime>> | undefined;
  let rt: Runtime | undefined;

  it("the three ops are the host's and no thread's, and image.get answers a view the protocol parses", async () => {
    for (const op of ["image.get", "image.build", "image.export"]) {
      expect(RUNTIME_OPS).toContain(op);
      expect(THREAD_OPS).not.toContain(op);
    }
    const started = stubBackend();
    started.execImpl = dfOk;
    rt = createRuntime({ backend: started, store: memoryStore(), adapters: {}, goldenRecipe: recipeWith(), hostId: "h1" });
    const b = await rt.golden.prepare();
    await rt.golden.seal(b.id);
    srv = await serveRuntime(rt, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const got = await c.request("image.get", {});
    expect(got.ok).toBe(true);
    const view = SealedImageView.parse(got["view"]);
    expect(view.image!.version).toBe(1);
    expect(view.copies).toHaveLength(1);

    // A passphrase under the minimum never reaches the runtime: the frame itself is refused.
    const short = await c.request("image.export", { dest: "/tmp/never-written", passphrase: "short" });
    expect(short.ok).toBe(false);
    c.close();
    await srv.close();
    srv = undefined;
    await rt.close();
    rt = undefined;
  });
});
