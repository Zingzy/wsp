// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { FAKE_AS_ENV } from "@wsp/protocol";
import { BoxBackend, DockerBackend, FakeBackend, LocalBackend, NoProviderBackend, SolariBackend, SshBackend, landsBytes, type MachineBackend } from "@wsp/engine";
import { goldenRecipe, makeRuntime, optsFor, providerSlotOf, swapProvider } from "../src/cli.js";
import { keysOf } from "../src/env-keys.js";
import { BOX_KEY_ENV, PROVIDER_MODULES, SOLARI_KEY_ENV, placeProviders, providerBackendFor, providerEnvNames, providerEnvWith, providerEnvWithKey, providerKeyEnvs, providerKeyRow, providerKeyRows, providerKeySet, providerModule, providerPlaces, wiredProviderId, type ProviderModule } from "../src/providers.js";

/** A computer's environment as the rows read it: the provider key rides in it under the row's own variable, which
 * is where every layer a key is read through puts it. */
const pick = (keys: Record<string, string> = {}, env: Record<string, string | undefined> = {}) => ({
  ...env,
  ...(keys["solari"] !== undefined ? { [SOLARI_KEY_ENV]: keys["solari"] } : {}),
});

describe("provider modules", () => {
  it("takes the module the keys name and nothing else when nothing is said", () => {
    expect(providerModule(pick()).id).toBe("none");
    expect(providerBackendFor(pick())).toBeInstanceOf(NoProviderBackend);
    expect(providerModule(pick({ solari: "sk-ant-x" })).id).toBe("solari");
    expect(providerBackendFor(pick({ solari: "sk-x" }))).toBeInstanceOf(SolariBackend);
  });

  it("takes Docker when a person names it or asks for it by the shorthand, key or no key", () => {
    expect(providerModule(pick({}, { WSP_PROVIDER: "docker" })).id).toBe("docker");
    expect(providerModule(pick({}, { WSP_DOCKER: "1" })).id).toBe("docker");
    expect(providerModule(pick({ solari: "sk-x" }, { WSP_DOCKER: "1" })).id).toBe("docker");
    expect(providerBackendFor(pick({}, { WSP_DOCKER: "1" }))).toBeInstanceOf(DockerBackend);
    // A shorthand that is off is off: a shell that exports WSP_DOCKER=0 asked for nothing.
    expect(providerModule(pick({}, { WSP_DOCKER: "0" })).id).toBe("none");
    expect(providerModule(pick({}, { WSP_DOCKER: "" })).id).toBe("none");
  });

  it("a word on the command line stands in front of the environment the host started with", () => {
    expect(providerEnvWith({ provider: "docker", dockerHost: "ssh://maya@box" }, { DOCKER_HOST: "unix:///var/run/docker.sock" })).toMatchObject({
      WSP_PROVIDER: "docker",
      DOCKER_HOST: "ssh://maya@box",
    });
    expect(providerEnvWith({}, { WSP_DOCKER: "1" })).toMatchObject({ WSP_DOCKER: "1" });
  });

  it("takes Box when a person names it, key or no key, and hands the backend the key the environment holds", () => {
    expect(providerModule(pick({}, { WSP_PROVIDER: "box" })).id).toBe("box");
    expect(providerModule(pick({ solari: "sk-x" }, { WSP_PROVIDER: "box", BOX_API_KEY: "box_x" })).id).toBe("box");
    expect(providerBackendFor(pick({}, { WSP_PROVIDER: "box", BOX_API_KEY: "box_x" }))).toBeInstanceOf(BoxBackend);
    expect(providerBackendFor(pick({}, { WSP_PROVIDER: "box", BOX_API_KEY: "box_x" })).capabilities).toMatchObject({ pauseMode: "disk", previewUrls: true, containers: true });
  });

  it("takes the module that answers out of memory when a harness names it, and never otherwise", async () => {
    // Named alone, whatever this computer holds: a fixture is served under it on a computer with a real key saved.
    expect(providerModule(pick({ solari: "sk-ant-x" }, { WSP_PROVIDER: "fake" })).id).toBe("fake");
    expect(providerModule(pick({}, { WSP_PROVIDER: "" })).id).toBe("none");
    const backend = providerBackendFor(pick({}, { WSP_PROVIDER: "fake" }));
    expect(backend).toBeInstanceOf(FakeBackend);
    // A fixture names its machines before any process has held them, so a machine this backend never minted is
    // answered for rather than refused, and the id is where a fixture says one is asleep.
    const [awake, asleep] = [await backend.get("fk_c0ffee"), await backend.get("fk_c0ffee.paused")];
    expect([awake.id, await awake.state()]).toEqual(["fk_c0ffee", "running"]);
    expect(await asleep.state()).toBe("paused");
    // Nothing lands on it, which is what keeps the daemon deploy off a machine that has no guest behind it.
    expect(landsBytes(backend.capabilities, awake)).toBe(false);
  });

  it("every row is reachable and the last one answers for any computer", () => {
    expect(PROVIDER_MODULES.map(m => m.id)).toEqual(["docker", "box", "fake", "solari", "none"]);
    expect(PROVIDER_MODULES.at(-1)!.selects(pick())).toBe(true);
  });

  it("every registered backend, and the two kinds outside the registry, declares a pause mode and a lifecycle together or neither, and says on its own whether it copies a disk, replaces a machine and resizes one", () => {
    // Built the way the host builds them, with fake picks: a key that looks fake, a daemon nothing dials.
    const built = PROVIDER_MODULES.map(m => [m.id, m.build(pick({ solari: "sk-ant-x" }, { DOCKER_HOST: "unix:///nonexistent/docker.sock", BOX_API_KEY: "box_x" }))] as const);
    const all: readonly (readonly [string, MachineBackend])[] = [...built, ["local", new LocalBackend({ root: "/tmp/wsp-providers" })], ["ssh", new SshBackend()]];
    const modes = Object.fromEntries(all.map(([id, b]) => [id, b.capabilities.pauseMode]));
    expect(modes).toEqual({ docker: "memory", box: "disk", solari: "memory", fake: "memory", none: undefined, local: undefined, ssh: undefined });
    for (const [, b] of all) expect(b.capabilities.pauseMode === undefined || ["memory", "disk"].includes(b.capabilities.pauseMode)).toBe(true);
    // The runtime reads the budgets only where a pause exists, so the two are declared together or not at all.
    for (const [id, b] of all) expect([id, b.lifecycle !== undefined]).toEqual([id, b.capabilities.pauseMode !== undefined]);
    // Which providers copy a machine's disk into an image, the one fact the snapshot verb reads: a fork that boots
    // cold is still snapshotted, so this row is its own and never liveCloneForks.
    expect(Object.fromEntries(all.map(([id, b]) => [id, b.capabilities.diskSnapshots]))).toEqual({ docker: true, box: true, solari: true, fake: true, none: false, local: false, ssh: false });
    // Which providers stand a fresh machine in for one a workspace is on, the fact the rebuild and the image move
    // read, and which give a machine a new size, the fact the resize reads. Each verb has its own row here, so a
    // provider added tomorrow answers for every road rather than being read off a neighbour's flag.
    expect(Object.fromEntries(all.map(([id, b]) => [id, b.capabilities.replacesMachine]))).toEqual({ docker: true, box: true, solari: true, fake: true, none: false, local: false, ssh: false });
    expect(Object.fromEntries(all.map(([id, b]) => [id, b.capabilities.resize]))).toEqual({ docker: false, box: false, solari: false, fake: false, none: false, local: false, ssh: false });
    for (const [, b] of all) if (b.lifecycle !== undefined) {
      expect(b.lifecycle.budgets.wakeAttempts).toBeGreaterThanOrEqual(1);
      expect(b.lifecycle.budgets.daemonAnswersMs).toBeGreaterThan(0);
    }
  });

  it("the words wsp up and wsp init take land in what the run picks its provider out of", () => {
    expect(optsFor({ state: "/tmp/wsp-providers/state.json", provider: "docker", "docker-host": "ssh://maya@127.0.0.1:2222" }).providerEnv).toMatchObject({
      WSP_PROVIDER: "docker",
      DOCKER_HOST: "ssh://maya@127.0.0.1:2222",
    });
  });

  it("a host told to fork containers holds the Docker module, and a key saved later swaps inside the same words", async () => {
    const rt = makeRuntime({}, "/tmp/wsp-providers/state.json", goldenRecipe({}), { WSP_DOCKER: "1" });
    try {
      const held = providerSlotOf(rt)!.current();
      // Containers: a nap that keeps RAM, no public port routes, a commit that copies the disk though a fork of it
      // boots cold, a fresh container that stands in for one a workspace is on, no new size for a container that
      // exists, and sizes to offer, so the fork roads are open.
      expect(held.capabilities).toMatchObject({ previewUrls: false, pauseMode: "memory", liveCloneForks: false, diskSnapshots: true, replacesMachine: true, resize: false });
      expect(held.capabilities.sizes.length).toBeGreaterThan(0);
      swapProvider(rt, { [SOLARI_KEY_ENV]: "slr_live_fake" });
      expect(providerSlotOf(rt)!.current().capabilities.previewUrls).toBe(false);
    } finally {
      await rt.close();
    }
  });

  it("a key is checked against its own provider, whatever this computer forks on", () => {
    // The words a run picks a provider out of are not the words a typed key is checked under: a person typing a
    // cloud key on a computer that forks containers is asking about the key.
    expect(providerModule(pick({ solari: "slr_live_fake" })).id).toBe("solari");
    expect(providerModule(providerEnvWithKey({}, "slr_live_fake")).id).toBe("solari");
    // A run wired to another provider puts the key it is typed to that provider, not to the row a key alone wires.
    expect(providerModule(providerEnvWithKey({ WSP_PROVIDER: "box" }, "box_fake")).id).toBe("box");
  });

  it("a key saved for a provider by name goes under that row's variable and leaves the wired provider alone", () => {
    // The app's Connect a provider names which provider the key is for, so a person connecting one provider on a
    // computer set up for another is not silently saving their key under the other one's variable.
    expect(providerKeySet({}, "ascii_live_fake", "box")).toEqual({ [BOX_KEY_ENV]: "ascii_live_fake" });
    expect(providerKeySet({ [SOLARI_KEY_ENV]: "slr_live_held" }, "ascii_live_fake", "box")).toEqual({ [BOX_KEY_ENV]: "ascii_live_fake" });
    // The key opens that provider as a place and moves nothing: what this computer forks on is where it was, so a
    // second key does not carry every workspace made after it to another provider.
    const after = { [SOLARI_KEY_ENV]: "slr_live_held", ...providerKeySet({ [SOLARI_KEY_ENV]: "slr_live_held" }, "ascii_live_fake", "box")! };
    expect(providerModule(after).id).toBe("solari");
    expect(placeProviders(after).map(m => m.id)).toEqual(["docker", "box", "solari"]);
    expect(providerModule(providerEnvWithKey({}, "ascii_live_fake", "box")).id).toBe("box");
    expect(providerBackendFor(providerEnvWithKey({}, "ascii_live_fake", "box"))).toBeInstanceOf(BoxBackend);
    // With no provider named the key is the wired row's, and the word for it is left as it stands.
    expect(providerKeySet({}, "slr_live_fake")).toEqual({ [SOLARI_KEY_ENV]: "slr_live_fake" });
    // A row that takes no key, and a word no row answers to, take nothing.
    expect(providerKeySet({}, "x", "docker")).toBeUndefined();
    expect(providerKeySet({}, "x", "nowhere")).toBeUndefined();
  });

  it("every provider a key can be saved for is read off the table, each under the variable its own row names", () => {
    expect(providerKeyRows()).toEqual({ box: BOX_KEY_ENV, solari: SOLARI_KEY_ENV });
  });

  it("the variables a service carries are the rows' own, so a provider added brings its variable with it", () => {
    expect(providerEnvNames()).toEqual(["WSP_PROVIDER", "WSP_DOCKER", "DOCKER_HOST", FAKE_AS_ENV]);
    // The row a provider is added as: the list follows it, and nothing else has to be remembered for the unit its
    // host is installed as to be given the variable that selects it. Keys are not among them: a unit file carries
    // no key, and the host reads its own off the same files at every start.
    const fly: ProviderModule = { id: "fly", envNames: ["WSP_PROVIDER", "FLY_REGION"], keyEnv: "FLY_API_TOKEN", selects: env => env["FLY_API_TOKEN"] !== undefined, build: () => new NoProviderBackend() };
    expect(providerEnvNames([...PROVIDER_MODULES, fly])).toEqual(["WSP_PROVIDER", "WSP_DOCKER", "DOCKER_HOST", FAKE_AS_ENV, "FLY_REGION"]);
    expect(providerEnvNames()).not.toContain(BOX_KEY_ENV);
    // What a row selects on is what it names: a row reading a variable it never listed would be carried by neither.
    for (const m of PROVIDER_MODULES) for (const name of m.envNames) expect(providerEnvNames()).toContain(name);
  });

  it("the environment a provider is picked out of carries every registered row's key, taken from the first layer that holds it", () => {
    const layers: Record<string, string>[] = [{ WSP_PROVIDER: "box" }, { [BOX_KEY_ENV]: "from-cwd", [SOLARI_KEY_ENV]: "" }, { [BOX_KEY_ENV]: "from-home", [SOLARI_KEY_ENV]: "solari-from-home" }];
    const env = providerEnvWith({}, layers[0]!, layers);
    // Every variable a row declares, and each from the first layer with something in it: an empty line is no key.
    expect(providerKeyEnvs().every(name => name in env || layers.every(l => (l[name] ?? "") === ""))).toBe(true);
    expect([env[BOX_KEY_ENV], env[SOLARI_KEY_ENV]]).toEqual(["from-cwd", "solari-from-home"]);
    // A row added tomorrow is filled by the same three layers with nothing else edited.
    expect(providerKeyEnvs([...PROVIDER_MODULES, { id: "fly", envNames: [], keyEnv: "FLY_API_TOKEN", selects: () => false, build: () => new NoProviderBackend() }])).toContain("FLY_API_TOKEN");
    // Nothing provider-shaped is left on the keys a record answers with: those are the agents' keys alone.
    expect(keysOf({ [SOLARI_KEY_ENV]: "slr_live_fake", [BOX_KEY_ENV]: "box_fake", ANTHROPIC_API_KEY: "sk-ant-x-fake" })).toEqual({ anthropic: "sk-ant-x-fake" });
  });

  it("a row that reads a key declares the words its screen is titled with, and a row that reads none declares neither", () => {
    // What the key screen is titled and what it says to set are the row's own, declared together: a row with a
    // variable and no words for it would open a screen titled with a shell variable.
    expect(PROVIDER_MODULES.map(m => [m.id, m.keyEnv, m.keyName])).toEqual([
      ["docker", undefined, undefined],
      ["box", BOX_KEY_ENV, "Box API key"],
      ["fake", undefined, undefined],
      ["solari", SOLARI_KEY_ENV, "Solari API key"],
      ["none", undefined, undefined],
    ]);
    for (const m of PROVIDER_MODULES) expect([m.id, m.keyEnv === undefined]).toEqual([m.id, m.keyName === undefined]);
  });

  it("the places a copy of the image can be built at are the providers this computer is set up for, each once", () => {
    // Added by its own word and needing no key: always a place, whatever this computer holds.
    expect(placeProviders({ WSP_PROVIDER: "docker" }).map(m => m.id)).toContain("docker");
    // A row that is no place at all, and the one that stands for no provider: neither is offered.
    expect(placeProviders({}).map(m => m.id)).not.toContain("fake");
    expect(placeProviders({}).map(m => m.id)).not.toContain("none");
    // A row that reads a key is a place once that key is here, and not before: a row nobody could reach is not one.
    expect(placeProviders({}).map(m => m.id)).not.toContain("solari");
    expect(placeProviders({ [SOLARI_KEY_ENV]: "slr_live_fake" }).map(m => m.id)).toContain("solari");
    expect(placeProviders({}).map(m => m.id)).not.toContain("box");
    expect(placeProviders({ [BOX_KEY_ENV]: "box_fake" }).map(m => m.id)).toContain("box");
    // Each row once, in the table's own order.
    const ids = placeProviders({ [SOLARI_KEY_ENV]: "slr_live_fake", [BOX_KEY_ENV]: "box_fake" }).map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(PROVIDER_MODULES.filter(m => ids.includes(m.id)).map(m => m.id));
  });

  it("the table a host builds copies through answers the wired place with the runtime's own backend and every other with its module's", () => {
    const wired = { id: "docker" };
    const env: Record<string, string> = { WSP_PROVIDER: "docker", [SOLARI_KEY_ENV]: "slr_live_fake" };
    const own = new DockerBackend({});
    const places = providerPlaces(
      () => wired.id,
      own,
      () => env,
    );
    expect(places.wired).toBe("docker");
    expect(places.backend("docker")).toBe(own);
    expect(places.backend("solari")).toBeInstanceOf(SolariBackend);
    // One backend per place for the host's life: a module holding machines in memory must not be made afresh.
    expect(places.backend("solari")).toBe(places.backend("solari"));
    expect(places.backend("box")).toBeUndefined();
    expect(places.list()).toEqual(["docker", "solari"]);

    // A key rotated while the host serves is read by the row that holds it: the backend built on the old one is not
    // handed out again, which is what the swap promises for the wired place and has to promise for the others.
    const onOldKey = places.backend("solari");
    env[SOLARI_KEY_ENV] = "slr_live_fake_rotated";
    const onNewKey = places.backend("solari");
    expect(onNewKey).not.toBe(onOldKey);
    expect(onNewKey).toBe(places.backend("solari"));

    // A key saved while the host serves moves the wired place; the runtime's own backend follows it there.
    wired.id = "solari";
    expect(places.wired).toBe("solari");
    expect(places.backend("solari")).toBe(own);
    expect(places.backend("docker")).toBeInstanceOf(DockerBackend);
    expect(places.list()).toEqual(["solari", "docker"]);
  });

  it("lists only the places a person can name, and still answers for a host whose own module is none of them", () => {
    // The module a host with no key starts on is no place: naming it in a refusal would offer a place to build at
    // that nobody can add. Its own roads still resolve, since the wired row is answered before the list is read.
    const own = new NoProviderBackend();
    const places = providerPlaces(
      () => "none",
      own,
      () => ({}),
    );
    expect(places.list()).toEqual(["docker"]);
    expect(places.backend("none")).toBe(own);
    expect(places.backend("solari")).toBeUndefined();
  });

  it("the row a key typed here is put to is the picked one, or the one a key alone would wire", () => {
    // Wired to a provider that reads a key: that row's variable, whatever else this computer holds.
    expect(providerKeyRow({ WSP_PROVIDER: "box" })?.keyEnv).toBe(BOX_KEY_ENV);
    expect(providerKeyRow({ WSP_PROVIDER: "box", [SOLARI_KEY_ENV]: "slr_live_fake" })?.keyEnv).toBe(BOX_KEY_ENV);
    // Wired to nothing: the cloud a key alone wires, which is what wsp init offers on a computer set up for none.
    expect(providerKeyRow({})?.keyEnv).toBe(SOLARI_KEY_ENV);
    // Wired to a provider that reads no key: nothing to ask for.
    expect(providerKeyRow({ WSP_PROVIDER: "docker" })).toBeUndefined();
    expect(providerKeyRow({ WSP_DOCKER: "1" })).toBeUndefined();
  });

  it("stamps a stand-in's machines with the provider it stands in for, so no row reads the stand-in's own word", () => {
    // A harness serving a fixture of one cloud's machines says which cloud, and every row about those machines
    // reads it: a tester met "fake" where a person reads which provider they are paying.
    expect(wiredProviderId({ WSP_PROVIDER: "fake", [FAKE_AS_ENV]: "solari" })).toBe("solari");
    expect(wiredProviderId({ WSP_PROVIDER: "fake", [FAKE_AS_ENV]: "box" })).toBe("box");
    // The row is still the stand-in: nothing dials that cloud, and the word alone would have.
    expect(providerModule({ WSP_PROVIDER: "fake", [FAKE_AS_ENV]: "solari" }).id).toBe("fake");
    expect(providerBackendFor({ WSP_PROVIDER: "fake", [FAKE_AS_ENV]: "solari" })).toBeInstanceOf(FakeBackend);
    // Every other row is the word it says it is, and a stand-in that stands in for nobody is its own word too.
    expect(wiredProviderId({ WSP_PROVIDER: "fake" })).toBe("fake");
    expect(wiredProviderId({ WSP_PROVIDER: "box" })).toBe("box");
    expect(wiredProviderId({})).toBe("none");
    // It travels with the row, so a host a service starts carries it the way it carries the provider's own word.
    expect(providerEnvNames()).toContain(FAKE_AS_ENV);
  });
});