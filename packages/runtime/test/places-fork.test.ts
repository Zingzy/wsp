// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { connect as netConnect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { DAEMON_VERSION, PLACE_WORKSPACE_PATH, placeWatchesItselfLine, forkProcsUnreadLine, forkOpRefusedLine, placeServesDaemonLine, noHostCliLine, absentComputer, workspaceStateOf, NO_IMAGES_HERE, type TurnResult } from "@wsp/protocol";
import { TOOL_PREFIX, installEnv, installHomes } from "@wsp/catalog";
import { copyKey, createRuntime, GUEST_LOGIN_ENV, wiredPlace, type HarnessAdapterFactory, type PlaceBackends } from "../src/runtime.js";
import type { MachineBackend } from "@wsp/engine";
import { newPlaceKeyPair } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, createOn, projectOn } from "./stub-backend.js";
import { until } from "./until.js";
import { report, wiring } from "./place-join.js";
import { ctx, sockets, serving, code, join, relink, placesOf, ForkingPlace, KEEPS_NO_IMAGE, SEALED, forks, daemonOps } from "./places-fixture.js";

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
  it("names no image where that computer keeps none: no template, no snapshot, and nothing of an image read or built there first", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend, store, adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c, undefined, undefined, KEEPS_NO_IMAGE)) });
    sockets.push(client.ws);
    // This host has sealed no image at all, and a computer that keeps none needs none: the create reads no image
    // head and builds no copy of one there before the fork, where the road behind it stopped for want of one.
    const bare = await createOn(ctx.runtime, { name: "x", on: "srv" });
    expect(place.created).toHaveLength(1);
    expect(place.created[0]).not.toHaveProperty("template");
    expect(place.created[0]).not.toHaveProperty("fromSnapshot");
    expect(bare.golden).toBe("");
    expect(await store.get("workspaces", bare.id)).toMatchObject({ golden: "" });
    // And where this host does hold an image, the word the verb hands every create down is dropped rather than
    // sent on to a computer that would refuse it.
    await store.put("goldens", copyKey("solari", "default"), SEALED);
    const named = await createOn(ctx.runtime, { golden: "snap_g", name: "y", on: "srv" });
    expect(place.created).toHaveLength(2);
    expect(place.created[1]).not.toHaveProperty("template");
    expect(place.created[1]).not.toHaveProperty("fromSnapshot");
    expect(named.golden).toBe("");
    // Nothing was forked at this host's own provider for either, which is where a copy would have been built.
    expect(backend.machines).toHaveLength(0);
  });

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
    const signedIn = report("srv", { agents: ["claude", "codex"], logins: ["codex/auth.json"] });
    const { client } = await join(hostKey, { code: await code(), report: signedIn, answers: c => forks(c, undefined, undefined, KEEPS_NO_IMAGE) });
    sockets.push(client.ws);
    const ws = await createOn(ctx.runtime, { name: "x", on: "srv" });
    await (await ctx.runtime.sessions.start(ws.id, { prompt: "one", harness: "claude" })).finished;
    // Codex signed in there wins over any key this host holds; Claude Code keeps no login on a machine, so the
    // vault is the whole of its sign-in and nothing stands against it.
    expect(asked.at(-1)).toEqual({ claude: false, codex: true });
  });

  it("carries the workspace order and the recipe's knobs into a workspace on that computer, its turns and its commands", async () => {
    const envs: Readonly<Record<string, string>>[] = [];
    const factory: HarnessAdapterFactory = ctx => {
      envs.push(ctx.env);
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
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({
      backend,
      store: memoryStore(),
      adapters: { claude: factory },
      places: wiredPlace("solari", backend),
      placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }),
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c, undefined, undefined, KEEPS_NO_IMAGE)) });
    sockets.push(client.ws);
    const ws = await createOn(ctx.runtime, { name: "x", on: "srv" });

    // The boot: the order that reads the folders no process inside can write before the home every workspace on
    // that computer shares, and every knob the recipe's job installs under, off the catalog's one table.
    const created = place.created[0]!["envs"] as Record<string, string>;
    expect(created["PATH"]).toBe(PLACE_WORKSPACE_PATH);
    expect(created).toMatchObject(installEnv(installHomes(TOOL_PREFIX)));
    expect(created).toMatchObject({ UV_TOOL_DIR: "/opt/wsp/uv/tools", CARGO_HOME: "/opt/wsp/cargo", RUSTUP_HOME: "/opt/wsp/rustup", GOBIN: "/usr/local/bin" });

    // And a turn on it: the adapter exports the same, so a thread there runs the copy under the prefix and the
    // rustup proxy finds its own home.
    await (await ctx.runtime.sessions.start(ws.id, { prompt: "one", harness: "claude" })).finished;
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) expect(env).toMatchObject({ PATH: PLACE_WORKSPACE_PATH, ...installEnv(installHomes(TOOL_PREFIX)) });

    // A fork at this host's own provider is a copy of an image sealed on the other order, with each manager's
    // own folders under a home that is root's alone: it takes neither the order nor a knob.
    await createOn(ctx.runtime, { golden: "snap_g", name: "y", on: "solari" });
    expect(backend.machines).toHaveLength(1);
    expect(backend.machines[0]!.spec.envs).toEqual(GUEST_LOGIN_ENV);
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

  it("lands on that computer's backend and not on this host's, and the record and the view say where", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend, store, adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const made = await createOn(ctx.runtime, { golden: "snap_g", name: "x", on: "srv" });
    expect(place.created).toHaveLength(1);
    expect(backend.machines).toHaveLength(0);
    expect(made.place).toBe(placeId);
    expect((await ctx.runtime.workspaces.get(made.id)).place).toBe(placeId);
    expect(await store.get("workspaces", made.id)).toMatchObject({ place: placeId });
    // The place a fork landed on is where the next one lands when nobody says.
    expect((await placesOf()).find(p => p.default)!.id).toBe(placeId);
  });

  it("sends no memory read to a fork there, whose container would count the whole computer, and keeps the size that computer applied", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend, store, adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const sent: string[] = [];
    const exec = (cmd: string) => {
      sent.push(cmd);
      return { exitCode: 0, stdout: cmd.includes("/proc/meminfo") ? "memkb 16384000\n" : "", stderr: "" };
    };
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c, undefined, exec) });
    sockets.push(client.ws);
    const made = await createOn(ctx.runtime, { golden: "snap_g", name: "x", on: "srv" });
    expect(sent.filter(c => c.includes("/proc/meminfo"))).toEqual([]);
    expect(made).not.toHaveProperty("notice");
    expect(await store.get("workspaces", made.id)).toMatchObject({ size: { cpu: 2, memMb: 4096 } });
  });

  it("is served by that computer's daemon: the create says nothing of a daemon inside, the bring back's frames go up its link with the workspace named, and nothing is dialled", async () => {
    // Found on spoo, 2026-09-18: a workspace on a computer somebody owns runs no daemon of its own, so the create
    // printed "Daemon did not answer.", the row read Unreachable while exec answered from inside, and every bring
    // back died at "is not answering yet" before a byte left the box.
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION }),
      answers: c => (place = forks(c)),
    });
    sockets.push(client.ws);
    const made = await ctx.runtime.workspaces.create({ project: (await projectOn(ctx.runtime, "srv")).id, golden: "snap_g", name: "work" });
    // Nothing was asked about a route or a daemon inside: a workspace here has neither.
    expect(place.asked["machine.previewUrl"]).toBeUndefined();
    // The two frames a bring back is made of go up this computer's link, each naming the workspace it is for, and
    // the checkout path is the one the workspace sees.
    const back = await ctx.runtime.workspaces.bringBack({ workspaceId: made.id, title: "bring back proof" });
    expect(place.frames.map(f => f["op"])).toEqual(["git.push", "git.pr"]);
    for (const frame of place.frames) expect(frame["machineId"]).toBe(made.machineId);
    // The checkout as the workspace sees it, which is the project's own path on that computer, and absolute: the
    // daemon answering for a workspace has no working directory inside it and refuses a relative path.
    const cwd = (await ctx.runtime.workspaces.get(made.id)).project.path;
    expect(cwd.startsWith("/")).toBe(true);
    expect(place.frames[0]).toMatchObject({ op: "git.push", cwd });
    expect(place.frames[1]).toMatchObject({ op: "git.pr", cwd });
    expect(back).toMatchObject({ branch: "work", ahead: 1, pr: { number: 7, url: "https://github.com/o/r/pull/7" } });
    // The road to a daemon inside is refused in one sentence rather than minting a route to a port nothing listens
    // on, and so is the update that would deploy one.
    const said = placeServesDaemonLine("work", "srv");
    await expect(ctx.runtime.workspaces.daemonReach(made.id)).rejects.toThrow(said);
    await expect(ctx.runtime.workspaces.updateDaemon(made.id)).rejects.toThrow(said);
    // And the row reads reachable while the workspace runs, off the computer's own answer for it, which is what
    // read Unreachable before.
    const status = (await ctx.runtime.status.list()).find(w => w.id === made.id)!;
    expect(status.reach.state).toBe("reachable");
    // And nothing was written or deployed inside it: no roots file, and no daemon put there by any road of this
    // host's, since the daemon answering for it is that computer's own.
    expect(place.asked["machine.putBytes"]).toBeUndefined();
    const wrote = place.asked["machine.exec"] ?? 0;
    await ctx.runtime.status.list();
    expect(place.asked["machine.exec"] ?? 0).toBe(wrote);
  });

  it("hands a road into it one channel: its own hello, every frame up the link with the workspace named, and this workspace's sessions alone", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION }),
      answers: c => (place = forks(c)),
    });
    sockets.push(client.ws);
    const made = await ctx.runtime.workspaces.create({ project: (await projectOn(ctx.runtime, "srv")).id, golden: "snap_g", name: "work" });
    const cwd = (await ctx.runtime.workspaces.get(made.id)).project.path;
    const heard: Record<string, unknown>[] = [];
    const channel = await ctx.runtime.workspaces.daemonChannel(made.id, e => heard.push(e));
    // The workspace's own hello, not the computer's: a client builds this workspace's paths off the root it reads
    // here, and the link's own named the computer's home.
    expect(heard).toEqual([{ type: "daemon.hello", root: cwd, version: DAEMON_VERSION }]);
    // Every frame goes up that computer's link with the workspace named on it, and nothing is dialled.
    expect(await channel.send({ op: "git.status", cwd })).toMatchObject({ ok: true });
    expect(place.frames.at(-1)).toMatchObject({ op: "git.status", cwd, machineId: made.machineId });
    expect(place.asked["machine.previewUrl"]).toBeUndefined();
    // A computer answers for every workspace on it, so the one it stamps on a session's frames is what says whose
    // that session is; another workspace's never reaches this channel.
    const session = { type: "guest.opened", session: "g0", life: "l1", kind: "cli", token: "dev-1.tok", argv: ["threads"], cwd };
    place.push({ ...session, machineId: "another-workspace" });
    place.push({ ...session, machineId: made.machineId });
    await until(() => heard.length > 1);
    expect(heard.slice(1)).toEqual([{ ...session, machineId: made.machineId }]);
    channel.close();
  });

  it("opens a pane's shell in the workspace's own folder, keeps that computer's readings off it, and lets its ptys go when it closes", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION }),
      answers: c => (place = forks(c)),
    });
    sockets.push(client.ws);
    const made = await ctx.runtime.workspaces.create({ project: (await projectOn(ctx.runtime, "srv")).id, golden: "snap_g", name: "work" });
    const cwd = (await ctx.runtime.workspaces.get(made.id)).project.path;
    const heard: Record<string, unknown>[] = [];
    const channel = await ctx.runtime.workspaces.daemonChannel(made.id, e => heard.push(e));

    // The pane's first tab names no folder, and the daemon answering for a workspace has no working directory
    // inside one; a tab that names its own keeps it.
    const created = await channel.send({ op: "pty.create", cols: 80, rows: 24 });
    expect(place.frames.at(-1)).toMatchObject({ op: "pty.create", cwd, cols: 80, machineId: made.machineId });
    const own = await channel.send({ op: "pty.create", cols: 80, rows: 24, cwd: `${cwd}/docs` });
    expect(place.frames.at(-1)).toMatchObject({ op: "pty.create", cwd: `${cwd}/docs` });
    const killed = await channel.send({ op: "pty.create", cols: 80, rows: 24 });

    // The two a pane opens every link with: the ports and the load that computer's daemon reads are the whole
    // computer's, so they are answered here and nothing goes up the link.
    for (const op of ["ports.watch", "sys.watch"]) {
      const before = place.asked[op] ?? 0;
      expect(await channel.send({ op })).toMatchObject({ ok: false, code: "unsupported", error: placeWatchesItselfLine("srv") });
      expect(place.asked[op] ?? 0).toBe(before);
    }

    // A pty of another pane on that computer is not this channel's to read.
    const ptyId = String((created as Record<string, unknown>)["ptyId"]);
    await channel.send({ op: "pty.attach", ptyId });
    place.push({ type: "pty.data", ptyId: "p99", data: "another pane's" });
    place.push({ type: "pty.data", ptyId, data: "hello" });
    await until(() => heard.length > 1);
    expect(heard.slice(1)).toEqual([{ type: "pty.data", ptyId, data: "hello" }]);

    // A shell that ended and one this pane killed hold no listener worth taking off; the shell that stands does.
    const exited = String((own as Record<string, unknown>)["ptyId"]);
    const gone = String((killed as Record<string, unknown>)["ptyId"]);
    await channel.send({ op: "pty.attach", ptyId: exited });
    await channel.send({ op: "pty.attach", ptyId: gone });
    await channel.send({ op: "pty.kill", ptyId: gone });
    place.push({ type: "pty.exit", ptyId: exited, exitCode: 0 });
    await until(() => heard.some(e => e["type"] === "pty.exit"));

    // Every pane on that computer rides the one link, so a pane that closes takes its own listeners off rather
    // than leaving its bytes riding it.
    channel.close();
    await until(() => place.frames.some(f => f["op"] === "pty.detach"));
    expect(place.frames.filter(f => f["op"] === "pty.detach")).toEqual([expect.objectContaining({ ptyId, machineId: made.machineId })]);
  });

  /** A workspace forked on a computer this host holds a link to, whose daemon answers that workspace's frames. */
  const servedFork = async (daemonVersion = DAEMON_VERSION): Promise<{ place: ForkingPlace; placeId: string; machineId: string; id: string }> => {
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion }),
      answers: c => (place = forks(c)),
    });
    sockets.push(client.ws);
    const made = await ctx.runtime.workspaces.create({ project: (await projectOn(ctx.runtime, "srv")).id, golden: "snap_g", name: "work" });
    return { place, placeId, machineId: made.machineId, id: made.id };
  };

  it("refuses a command on a fork's channel before anything reaches its computer, and that computer's own channel still runs it", async () => {
    const { place, placeId, id } = await servedFork();
    const channel = await ctx.runtime!.workspaces.daemonChannel(id, () => {});
    // The daemon runs exec on the computer itself, as its own user, whatever workspace the frame names.
    expect(await channel.send({ op: "exec", cmd: "kill -9 1" })).toMatchObject({ ok: false, code: "unsupported", error: forkOpRefusedLine("exec", "work", "srv") });
    expect(place.asked["exec"] ?? 0).toBe(0);
    channel.close();
    const own = ctx.runtime!.places!.channel(placeId, () => {})!;
    expect(await own.send({ op: "exec", cmd: "uptime" })).toMatchObject({ ok: true });
    expect(place.asked["exec"]).toBe(1);
    own.close();
  });

  it("sends a page's frame up a fork's computer's link under the link's own id, so it cannot answer another request there", async () => {
    const { place, id } = await servedFork();
    const channel = await ctx.runtime!.workspaces.daemonChannel(id, () => {});
    const cwd = (await ctx.runtime!.workspaces.get(id)).project.path;
    const asking = channel.send({ op: "git.status", cwd, id: 4242 });
    await until(() => place.frames.some(f => f["op"] === "git.status"));
    expect(place.frames.find(f => f["op"] === "git.status")!["id"]).not.toBe(4242);
    expect(await asking).toMatchObject({ ok: true, branch: "work" });
    channel.close();
  });

  it("refuses a fork's process watch, reads and kills before anything reaches its computer, and that computer's own channel still carries them", async () => {
    const { place, placeId, id } = await servedFork();
    const channel = await ctx.runtime!.workspaces.daemonChannel(id, () => {});
    // The daemon there acts on any pid it is handed, so a pid of the computer's own or of another workspace's is
    // refused here with nothing sent up the link.
    const frames = [
      { op: "proc.kill", pid: 1, signal: "KILL" },
      { op: "proc.inspect", pid: 1 },
      { op: "proc.watch" },
      { op: "proc.unwatch" },
    ];
    for (const frame of frames) {
      expect(await channel.send(frame)).toMatchObject({ ok: false, code: "unsupported", error: forkProcsUnreadLine("work", "srv") });
      expect(place.asked[frame.op] ?? 0).toBe(0);
    }
    channel.close();

    // The computer's own page reads and signals its own processes over the same link, as it did.
    const own = ctx.runtime!.places!.channel(placeId, () => {})!;
    for (const frame of frames) expect(await own.send(frame)).toMatchObject({ ok: true });
    expect(frames.map(f => place.asked[f.op])).toEqual([1, 1, 1, 1]);
    own.close();
  });

  it("keeps the readings the computer's own page watches over the shared link off a fork's channel", async () => {
    const { place, id } = await servedFork();
    const heard: Record<string, unknown>[] = [];
    const channel = await ctx.runtime!.workspaces.daemonChannel(id, e => heard.push(e));
    const ptyId = String(((await channel.send({ op: "pty.create", cols: 80, rows: 24 })) as Record<string, unknown>)["ptyId"]);
    await channel.send({ op: "pty.attach", ptyId });
    place.push({ type: "proc.snapshot", at: 1, procs: [{ pid: 1, ppid: 0, comm: "init" }] });
    place.push({ type: "sys.sample", at: 1 });
    place.push({ type: "ports.changed", ports: [22] });
    place.push({ type: "pty.data", ptyId, data: "after" });
    await until(() => heard.some(e => e["type"] === "pty.data"));
    expect(heard.map(e => e["type"])).toEqual(["daemon.hello", "pty.data"]);
    channel.close();
  });

  const PTY = ["pty.create", "pty.attach", "pty.detach", "pty.write", "pty.resize", "pty.kill", "pty.tab", "pty.list"];
  const FILES_AND_GIT = ["fs.list", "fs.files", "fs.read", "fs.write", "fs.search", "git.status", "git.diff", "git.snapshot", "git.range", "git.turn", "git.push", "git.pr", "git.prList"];
  const HOST_GUESTS = ["guest.watch", "guest.reply", "guest.close"];
  /** The host's own road to an editor's ssh server inside the fork: its start and the tunnel that carries to it. */
  const HOST_TUNNELS = ["ssh.start", "tunnel.open", "tunnel.write", "tunnel.close"];
  const REFUSED = [
    "ports.watch",
    "sys.watch",
    "sys.history",
    "proc.watch",
    "proc.unwatch",
    "proc.inspect",
    "proc.kill",
    "manifest.get",
    "manifest.record",
    "manifest.restartScript",
    "inbox.watch",
    "inbox.rescan",
    "fs.folders",
    "git.discard",
    "git.commit",
    "git.checkpoint",
    "git.restore",
    "git.checkpointDrop",
    // A thread's start and its branch work on the computer the host runs on: the host sends these itself, so a
    // client's channel into a fork carries none of them.
    "git.worktrees",
    "git.branches",
    "git.switchNew",
    "git.fetchBranch",
    // The host sends these itself, with the remote off the project's record; a client's channel carries none of them.
    "git.prRead",
    "git.prView",
    "git.runLog",
    "git.prMerge",
    "git.repoRead",
    "git.update",
    "git.startOn",
    "git.branchCompare",
    "git.mergeIn",
    "git.issueRead",
    "git.prCheckout",
    "git.prDiff",
    "git.prReview",
    "git.prReply",
    "git.prResolve",
    "git.prReact",
    "exec",
    "place.leave",
    "place.update",
    "guest.open",
    "guest.send",
  ];

  it.each([
    { road: "a client's", open: (id: string) => ctx.runtime!.workspaces.daemonChannel(id, () => {}), carried: [...PTY, ...FILES_AND_GIT, "ping"] },
    { road: "the host's guest road's", open: (id: string) => ctx.runtime!.workspaces.guestChannel(id, () => {}), carried: [...PTY, ...FILES_AND_GIT, "ping", ...HOST_GUESTS, ...HOST_TUNNELS] },
  ])("places every op the computer's daemon serves on $road channel into a fork: carried naming that fork, or refused before it leaves", async ({ open, carried }) => {
    const ops = daemonOps();
    const machineOps = ops.filter(o => o.op.startsWith("machine.")).map(o => o.op);
    expect(ops.map(o => o.op).sort()).toEqual([...PTY, ...FILES_AND_GIT, "ping", ...HOST_GUESTS, ...HOST_TUNNELS, ...REFUSED, ...machineOps].sort());
    const { place, machineId, id } = await servedFork();
    const channel = await open(id);
    for (const { op, scoped } of ops) {
      const before = place.asked[op] ?? 0;
      const reply = await channel.send({ op, ptyId: "p1", path: "/root/work", cwd: "/root/work", session: "g1", message: {} });
      if (carried.includes(op)) {
        // ping reads nothing of any workspace's; the guest road's three answer a session by the id the computer gave it.
        expect(scoped || op === "ping" || HOST_GUESTS.includes(op) || HOST_TUNNELS.includes(op), op).toBe(true);
        expect(reply, op).toMatchObject({ ok: true });
        expect(place.frames.filter(f => f["op"] === op).at(-1), op).toMatchObject({ machineId });
      } else {
        expect(reply, op).toMatchObject({ ok: false, code: "unsupported" });
        expect(place.asked[op] ?? 0, op).toBe(before);
      }
    }
    channel.close();
  });

  it("carries an editor's ssh into a fork on the host's own road with the fork named, and hands that road the fork's tunnel frames alone", async () => {
    const { place, machineId, id } = await servedFork();
    const heard: Record<string, unknown>[] = [];
    const road = await ctx.runtime!.workspaces.guestChannel(id, e => heard.push(e));
    expect(await road.send({ op: "ssh.start", authorizedKey: "ssh-ed25519 AAAAC3Nz the-mac" })).toMatchObject({ ok: true });
    expect(place.frames.at(-1)).toMatchObject({ op: "ssh.start", machineId });
    expect(await road.send({ op: "tunnel.open", tunnelId: "t1", port: 40022 })).toMatchObject({ ok: true });
    expect(place.frames.at(-1)).toMatchObject({ op: "tunnel.open", tunnelId: "t1", port: 40022, machineId });
    // Every fork on that computer rides the one link, and its tunnel ids are nobody's but this road's.
    place.push({ type: "tunnel.data", tunnelId: "t1", data: "b3RoZXI=", machineId: "another-workspace" });
    place.push({ type: "tunnel.data", tunnelId: "t1", data: "U1NILTIuMA==", machineId });
    place.push({ type: "tunnel.end", tunnelId: "t1", machineId });
    await until(() => heard.some(e => e["type"] === "tunnel.end"));
    expect(heard.filter(e => String(e["type"]).startsWith("tunnel."))).toEqual([
      { type: "tunnel.data", tunnelId: "t1", data: "U1NILTIuMA==", machineId },
      { type: "tunnel.end", tunnelId: "t1", machineId },
    ]);
    road.close();
  });

  it.each([
    { road: "a client's", open: (id: string) => ctx.runtime!.workspaces.daemonChannel(id, () => {}) },
    { road: "the host's guest road's", open: (id: string) => ctx.runtime!.workspaces.guestChannel(id, () => {}) },
  ])("opens $road channel into a fork on a computer one daemon behind this wsp's, with the fork named on every frame", async ({ open }) => {
    // A daemon too old to name the fork on a frame cannot seal the link this channel rides, so a computer that is
    // only behind is one whose terminal, files and guests all still answer.
    const { place, machineId, id } = await servedFork(DAEMON_VERSION - 1);
    const channel = await open(id);
    expect(await channel.send({ op: "ping" })).toMatchObject({ ok: true });
    expect(await channel.send({ op: "pty.create", cols: 80, rows: 24 })).toMatchObject({ ok: true });
    expect(place.frames.at(-1)).toMatchObject({ op: "pty.create", machineId });
    channel.close();
  });

  it("takes the bring back on a computer one daemon behind this wsp's, and carries a pull request refusal as the note beside the landed push", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION - 1 }),
      answers: c => (place = forks(c)),
    });
    sockets.push(client.ws);
    const made = await ctx.runtime.workspaces.create({ project: (await projectOn(ctx.runtime, "srv")).id, golden: "snap_g", name: "work" });
    place.refuseGitPr = { error: noHostCliLine("github.com"), code: "no-host-cli" };
    const back = await ctx.runtime.workspaces.bringBack({ workspaceId: made.id });
    expect(back.note).toBe(noHostCliLine("github.com"));
    expect(back.pr).toBeUndefined();
    expect(back).toMatchObject({ branch: "work", ahead: 1 });
    expect(place.frames.map(f => f["op"])).toEqual(["git.push", "git.pr"]);
  });

  it("says the computer it was forked on where a record names one, and this host's own provider otherwise", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, places: wiredPlace("solari", backend), placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    const there = await createOn(ctx.runtime, { golden: "snap_g", name: "x", on: "srv" });
    // The fork stands on a computer that offers Docker, and this host forks at Solari: the row says Docker, which
    // is what made it, and place says which computer it is on.
    expect(there.provider).toBe("docker");
    expect(there.place).toBeDefined();
    const here = await createOn(ctx.runtime, { golden: "snap_g", name: "y", on: "solari" });
    expect(here.provider).toBe("solari");
    expect(here.place).toBeUndefined();
  });

  it("lands where the project's computer is, whatever the default mark says: a workspace is that computer's copy", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    await createOn(ctx.runtime, { golden: "snap_g", name: "x", on: "srv" });
    expect(place.created).toHaveLength(1);
    expect(backend.machines).toHaveLength(0);
    // A project on the provider this host forks at: the host's own backend takes it and the record carries no place,
    // and the mark on the places table says nothing about either.
    await ctx.runtime.places!.markUsed(undefined);
    const second = await createOn(ctx.runtime, { golden: "snap_g", name: "y", on: "solari" });
    expect(backend.machines).toHaveLength(1);
    expect(second.place).toBeUndefined();
    expect(place.created).toHaveLength(1);
  });

  it("says every computer on the row forks and the computer the app runs on does not, off the list the verbs read", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
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
    const made = await createOn(ctx.runtime, { golden: "snap_g", name: "x", on: "srv" });
    expect(place.created).toHaveLength(1);
    expect(backend.machines).toHaveLength(0);
    expect(made.place).toBe(withDocker.placeId);
    // What the sidebar and wsp workspaces list for that computer: its forks, and no row for the computer itself.
    expect((await ctx.runtime.workspaces.list()).map(w => [w.name, w.place])).toEqual([["x", withDocker.placeId]]);
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

  it("names the wall when that computer holds no copy of the image, and records nothing", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    place.refuseCreate = { error: "no such image: snap_g", kind: "missing", status: 404 };
    await expect(createOn(ctx.runtime!, { golden: "snap_g", name: "x", on: "srv" })).rejects.toThrow(/srv holds no copy of snap_g/);
    expect((await ctx.runtime!.workspaces.list()).filter(w => w.name === "x")).toEqual([]);
  });

  it("gives the daemon on a machine that was stopped the whole budget to answer, rather than one ask at the start", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const made = await createOn(ctx.runtime, { golden: "snap_g", name: "x", on: "srv" });
    await ctx.runtime.workspaces.nap(made.id);
    // The daemon says no to the wake's first ask and yes to its second, which is a container still coming up off
    // its own layers; the machine that comes back is the one that napped and not a fresh fork of the image.
    const asked = place.asked["machine.daemonAnswers"] ?? 0;
    place.daemonAnswersAfter = asked + 2;
    expect((await ctx.runtime.workspaces.wake(made.id)).machineId).toBe(made.machineId);
    expect(place.asked["machine.daemonAnswers"]).toBeGreaterThan(asked + 1);
  });

  it("naps and wakes on that computer and never on this host's provider", async () => {
    const backend = stubBackend();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const made = await createOn(ctx.runtime, { golden: "snap_g", name: "x", on: "srv" });
    await ctx.runtime.workspaces.nap(made.id);
    expect(place.paused).toBe(1);
    await ctx.runtime.workspaces.wake(made.id);
    expect(place.resumed).toBe(1);
    expect(backend.machines).toHaveLength(0);
  });

  it("refuses a snapshot of a fork on that computer in one sentence, and asks that computer and this host's provider for none", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend, store, adapters: {}, placeLinks: wiring(hostKey) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    // A fork of a project golden carries that project from birth, so the verb gets past its own project wall and
    // what it meets is the computer's.
    await store.put("project-goldens", "snap_p", {
      snapshotId: "snap_p",
      golden: "snap_g",
      projects: [{ name: "proj", dest: "/root/proj", importedAt: "2026-09-12T00:00:00.000Z", size: 20 }],
      workspaceId: "ws_older",
      workspaceName: "older",
      createdAt: "2026-09-12T00:00:00.000Z",
    });
    const made = await createOn(ctx.runtime, { golden: "snap_p", name: "x", on: "srv" });
    // A computer somebody joined keeps no image, so there is nothing for a copy of this fork's disk to become:
    // the sentence is the far side's own and no frame is sent for it.
    await expect(ctx.runtime.workspaces.snapshot(made.id)).rejects.toThrow(NO_IMAGES_HERE);
    expect(place.ops.filter(op => op.startsWith("machine.snapshot"))).toEqual([]);
    expect(backend.snapshots).toEqual([]);
  });

  it("says the computer is not connected rather than asking the provider anything, and reads it again when it is back", async () => {
    const { hostKey } = await serving();
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    const made = await createOn(ctx.runtime!, { golden: "snap_g", name: "x", on: "srv" });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const away = (await ctx.runtime!.status.list()).find(r => r.id === made.id)!;
    expect(away.reach.state).toBe("unreachable");
    expect(away.reason).toBe(absentComputer("srv", null).sentence);
    expect(away.machineState).toBe("running");
    const back = await relink(hostKey, placeId, key, report("srv"), c => forks(c));
    sockets.push(back.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    await until(async () => (await ctx.runtime!.status.list()).find(r => r.id === made.id)!.reach.state !== "unreachable");
  });

  it("refuses a keyed frame at a computer that is simply off at once, and waits only for one whose socket closed inside the wait", async () => {
    const store = memoryStore();
    const { hostKey } = await serving({ store, relinkWaitMs: 400 });
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(client.ws);
    // One fork made while the computer is here, so the road is warm and what follows is the wait and nothing else.
    await createOn(ctx.runtime!, { golden: "snap_g", name: "warm", on: "srv" });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);

    // A gap this host holds a closed socket for: a keyed frame waits, and the computer dialling back finishes it.
    const waiting = createOn(ctx.runtime!, { golden: "snap_g", name: "held", on: "srv" });
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
    await expect(createOn(ctx.runtime!, { golden: "snap_g", name: "late", on: "srv" })).rejects.toThrow(absentComputer("srv", null).sentence);
    expect(Date.now() - asked).toBeLessThan(50);

    // And a host that has held no socket for that computer at all, which is every host at start, refuses at once
    // rather than waiting out a computer that is off.
    await ctx.srv!.close();
    await ctx.runtime!.close();
    ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey), placeRelinkWaitMs: 50_000 });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    asked = Date.now();
    await expect(createOn(ctx.runtime, { golden: "snap_g", name: "cold", on: "srv" })).rejects.toThrow(absentComputer("srv", null).sentence);
    expect(Date.now() - asked).toBeLessThan(50);
  });

  it("never asks a frame with no key of its own a second time: the gap fails it, and the socket that computer opens next is not sent it", async () => {
    const { hostKey } = await serving();
    let first!: ForkingPlace;
    const { client, placeId, pair: key } = await join(hostKey, { code: await code(), name: "srv", answers: c => (first = forks(c)) });
    sockets.push(client.ws);
    const made = await createOn(ctx.runtime!, { golden: "snap_g", name: "x", on: "srv" });
    // A pause is the machine moving, not a reading: the far side has taken it by the time the answer is lost, and
    // a second one would be a second move. So the frame names no key and the gap is its end.
    first.swallow.add("machine.pause");
    const napping = ctx.runtime!.workspaces.nap(made.id);
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
    const made = await createOn(ctx.runtime!, { golden: "snap_g", name: "x", on: "srv" });
    await ctx.runtime!.workspaces.nap(made.id);
    // A wake in flight across the relink: the machine resumes and its daemon says no, so the wake is still asking
    // when the computer's new socket lands.
    first.daemonAnswersAfter = Number.MAX_SAFE_INTEGER;
    const waking = ctx.runtime!.workspaces.wake(made.id);
    await until(async () => first.resumed === 1);
    let second!: ForkingPlace;
    const back = await relink(hostKey, placeId, key, report("srv"), c => (second = forks(c)));
    sockets.push(back.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    // The second caller joins the wake in flight rather than finding a record the presence beat replaced.
    const joined = ctx.runtime!.workspaces.wake(made.id);
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
    ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const first = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(first.client.ws);
    const made = await createOn(ctx.runtime, { golden: "snap_g", name: "x", on: "srv" });
    await ctx.runtime.workspaces.nap(made.id);
    first.client.close();
    await ctx.srv.close();
    await ctx.runtime.close();
    // A second host over the same store, with that computer away: the record keeps the word it was left with.
    ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    expect((await ctx.runtime.workspaces.get(made.id)).phase).toBe("napping");
    let place!: ForkingPlace;
    const back = await relink(hostKey, first.placeId, first.pair, report("srv"), c => (place = forks(c)));
    sockets.push(back.client.ws);
    await until(async () => place.ops.includes("machine.get"));
  });

  it("reads a running fork's machine again when its computer dials back in, and its daemon sync runs off that reading", async () => {
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const first = await join(hostKey, { code: await code(), name: "srv", answers: c => forks(c) });
    sockets.push(first.client.ws);
    const made = await createOn(ctx.runtime, { golden: "snap_g", name: "x", on: "srv" });
    first.client.close();
    await ctx.srv.close();
    await ctx.runtime.close();
    // A second host over the same store with that computer away: the fork is held by a stand-in, so nothing about
    // its machine is read and no sync is started for it.
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(line => warned.push(String(line)));
    try {
      ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
      ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
      expect((await ctx.runtime.workspaces.get(made.id)).phase).toBe("running");
      let place!: ForkingPlace;
      const back = await relink(hostKey, first.placeId, first.pair, report("srv"), c => (place = forks(c)));
      sockets.push(back.client.ws);
      await until(async () => place.ops.includes("machine.get") && place.ops.includes("machine.state"));
      await new Promise(r => setTimeout(r, 100));
      // The record was read again and the sync the reading handed back ran on it: a workspace this computer serves
      // the daemon for is asked for no version and given no deploy, and nothing is left saying otherwise.
      expect((await ctx.runtime.workspaces.get(made.id)).phase).toBe("running");
      expect(warned.filter(l => l.includes("were not read again") || l.startsWith("daemon on"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
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

  it("refuses to take a computer out from under the forks standing on it, and sweeps nothing", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const swept: string[] = [];
    client.onFrame(raw => {
      const frame = raw as unknown as { op?: string };
      if (frame.op === "place.leave") swept.push("asked");
    });
    await createOn(ctx.runtime!, { golden: "snap_g", name: "x", on: "srv" });
    await expect(ctx.runtime!.places!.remove(placeId)).rejects.toThrow(/srv still holds a fork \(x\); delete them first/);
    expect(swept).toEqual([]);
    expect(place.killed).toEqual([]);
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
