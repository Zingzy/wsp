// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projectNeedsReaddLine } from "@wsp/protocol";
import type { EventUnion, TurnResult } from "@wsp/protocol";
import { copyKey, createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { droppingPort } from "./held-port.js";
import { until } from "./until.js";
import { stubBackend, type StubMachine, createOn, projectOn } from "./stub-backend.js";

describe("gone machines", () => {
  /** A turn that announces itself and never settles on its own: only the runtime ending it ends it. */
  const held: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      const sessionId = randomUUID();
      o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5", cwd: "/root/work" });
      return { localId: sessionId, finished: new Promise<TurnResult>(() => {}), interrupt: async () => {} };
    },
  });
  /** Two workspaces, one napping, both machines deleted at the provider while no host ran; the same store hydrated again. */
  const hydratedGone = async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt1 = createRuntime({ backend, store, adapters: {} });
    const a = await createOn(rt1, { golden: "snap_g", name: "a" });
    const b = await createOn(rt1, { golden: "snap_g", name: "b" });
    await rt1.workspaces.nap(b.id);
    await rt1.close();
    for (const m of backend.machines) m.killed = true;
    const rt = createRuntime({ backend, store, adapters: {} });
    // The load holds each record on its one 404 and confirms it once the host serves.
    await until(async () => (await rt.workspaces.list()).every(w => w.phase === "gone"));
    return { backend, store, rt, a, b };
  };

  it("a stored workspace whose machine the provider no longer knows hydrates as gone with the provider's words, whatever phase it was left at", async () => {
    const { store, rt, a, b } = await hydratedGone();
    const listed = await rt.workspaces.list();
    // The words name the load that met the 404 and quote the provider's answer to it.
    const loadSaw = (id: string) => new RegExp(`^machine ${id} is gone at the provider: the record load found it gone at \\S+Z \\(404 gone\\)$`);
    expect(listed.map(w => [w.name, w.phase, w.gone])).toEqual([
      ["a", "gone", expect.stringMatching(loadSaw("m1"))],
      ["b", "gone", expect.stringMatching(loadSaw("m2"))],
    ]);
    // Written back once confirmed: a second host over the store reads gone without asking the provider.
    expect(await store.get("workspaces", a.id)).toMatchObject({ phase: "gone", gone: expect.stringMatching(loadSaw("m1")) });
    expect(await store.get("workspaces", b.id)).toMatchObject({ phase: "gone" });
    const statuses = await rt.status.list();
    const sa = statuses.find(s => s.id === a.id)!;
    expect(sa).toMatchObject({ phase: "gone", machineState: "gone", reach: { state: "gone" }, reason: expect.stringMatching(loadSaw("m1")) });
    expect(sa.idleAt).toBeUndefined();
    await rt.close();
  });

  it("a gone workspace refuses wake and sends with the provider's words; nap is a no-op; rebuild is the road out", async () => {
    const { backend, store, rt, a } = await hydratedGone();
    const words = (await rt.workspaces.get(a.id)).gone!;
    expect(words).toMatch(/^machine m1 is gone at the provider: the record load found it gone at /);
    await expect(rt.workspaces.wake(a.id)).rejects.toThrow(`a's machine is gone with its disk, so work that was not pushed is lost; rebuild it to wake, which brings back its home folder from the last saved nap (${words})`);
    await expect(rt.sessions.start(a.id, { prompt: "hi" })).rejects.toThrow(`a's machine is gone with its disk, so work that was not pushed is lost; rebuild it to send, which brings back its home folder from the last saved nap (${words})`);
    expect(await rt.workspaces.nap(a.id)).toMatchObject({ phase: "gone" });
    expect(backend.machines).toHaveLength(2);

    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const rebuilt = await rt.workspaces.rebuild(a.id);
    expect(rebuilt).toMatchObject({ phase: "running", machineId: "m3" });
    expect(rebuilt.gone).toBeUndefined();
    expect(backend.machines[2]!.spec.fromSnapshot).toBe("snap_g");
    expect(events.find(e => e.type === "workspace.upgraded")).toMatchObject({ workspaceId: a.id, machineId: "m3" });
    expect((await rt.status.list()).find(s => s.id === a.id)).toMatchObject({ phase: "running", machineState: "running", machineId: "m3" });
    expect(await store.get("workspaces", a.id)).toMatchObject({ phase: "running", machineId: "m3" });
    expect((await store.get("workspaces", a.id) as { gone?: string }).gone).toBeUndefined();
    expect(await rt.workspaces.wake(a.id)).toMatchObject({ phase: "running" });
    await rt.close();
  });

  it("the reach poll finds a running machine gone: the workspace moves to gone, its turn ends, the idle window drops and the bill stops", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: held }, status: { pollIntervalMs: 5, costIntervalMs: 5, reconcileMinMs: 0 }, goneConfirmMs: 5 });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const { port, close: closePort } = await droppingPort();
    onTestFinished(closePort);
    backend.machines[0]!.previewUrl = async p => ({ url: `http://127.0.0.1:${port}/?port=${p}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    await rt.sessions.start(ws.id, { prompt: "work" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const stop = rt.status.watch();
    try {
      // Unreachable alone is weather: the provider still says running, so the workspace does.
      await until(() => events.some(e => e.type === "workspace.status" && e.status.reach.state === "unreachable"));
      expect(await rt.workspaces.get(ws.id)).toMatchObject({ phase: "running" });
      expect(events.some(e => e.type === "workspace.gone")).toBe(false);

      backend.machines[0]!.killed = true; // deleted through the provider's API under a running host
      await until(() => events.some(e => e.type === "workspace.gone"));
      const pollSaw = /^machine m1 is gone at the provider: the status poll found it gone at \S+Z$/;
      expect(events.find(e => e.type === "workspace.gone")).toMatchObject({ workspaceId: ws.id, machineId: "m1", reason: expect.stringMatching(pollSaw) });
      expect(await rt.workspaces.get(ws.id)).toMatchObject({ phase: "gone", gone: expect.stringMatching(pollSaw) });
      expect(await store.get("workspaces", ws.id)).toMatchObject({ phase: "gone", gone: expect.stringMatching(pollSaw) });
      expect(events.find(e => e.type === "session.end")).toMatchObject({ workspaceId: ws.id, reason: "machine gone at the provider while the agent was working" });
      expect((await rt.sessions.list(ws.id)).map(s => s.status)).toEqual(["failed"]);

      // The bill stops where the machine did: rate 0 and the awake time frozen from one tick to the next.
      await until(() => events.filter(e => e.type === "workspace.cost" && e.phase === "gone").length >= 2);
      const ticks = events.filter((e): e is EventUnion & { type: "workspace.cost" } => e.type === "workspace.cost" && e.phase === "gone");
      expect(ticks[0]).toMatchObject({ rateUsdPerHour: 0 });
      expect(ticks[1]!.awakeMs).toBe(ticks[0]!.awakeMs);
      const last = events.filter((e): e is EventUnion & { type: "workspace.status" } => e.type === "workspace.status").at(-1)!;
      expect(last.status).toMatchObject({ phase: "gone", machineState: "gone", reach: { state: "gone" }, reason: expect.stringMatching(pollSaw) });
      expect(last.status.idleAt).toBeUndefined();
    } finally {
      stop();
      await rt.close();
    }
  });

  it("the host's metrics answer 404 while the state read says running: the workspace stays running and its turn works on", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: held }, status: { pollIntervalMs: 5, costIntervalMs: 5, reconcileMinMs: 0 }, goneConfirmMs: 5 });
    const ws = await createOn(rt, { golden: "snap_g", name: "a" });
    const m = backend.machines[0]!;
    const { port, close: closePort } = await droppingPort();
    onTestFinished(closePort);
    m.previewUrl = async p => ({ url: `http://127.0.0.1:${port}/?port=${p}`, token: "t", expiresAt: Date.now() + 3_600_000 });
    await rt.sessions.start(ws.id, { prompt: "work" });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const asks = { metrics: 0 };
    const metrics = m.metrics.bind(m);
    m.metrics = async () => {
      asks.metrics++;
      return metrics();
    };
    const stop = rt.status.watch();
    try {
      // The guest misses the probe and the host has lost the VM; the state read by id is the only word on gone.
      m.hostLost = true;
      // Several passes read the metrics 404 with the guest still missing; none of them is a verdict.
      await until(() => asks.metrics >= 3);

      expect(m.killed).toBe(false);
      expect(await rt.workspaces.get(ws.id)).toMatchObject({ phase: "running" });
      expect(events.some(e => e.type === "workspace.gone")).toBe(false);
      expect(events.some(e => e.type === "session.end")).toBe(false);
      expect((await rt.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
      const rows = events.filter((e): e is EventUnion & { type: "workspace.status" } => e.type === "workspace.status");
      expect(rows.filter(r => r.status.machineState === "gone")).toEqual([]);
      expect(rows.at(-1)!.status).toMatchObject({ phase: "running", machineState: "running", reach: { state: "unreachable" } });
      // The gap is one line per spell, however many passes read it.
      expect(warn.mock.calls.map(c => String(c[0])).filter(l => /^host metrics for/.test(l))).toHaveLength(1);
    } finally {
      stop();
      warn.mockRestore();
      await rt.close();
    }
  });
});

describe("a workspace behind the golden's head", () => {
  const version = (n: number) => ({ version: n, snapshotId: `snap_golden-v${n}`, baseTemplate: "base", setupSha: `s${n}`, createdAt: `2026-09-0${n}T00:00:00.000Z`, smoke: { cmd: "true", exitCode: 0 } });
  const seeded = async () => {
    const backend = stubBackend();
    const store = memoryStore();
    await store.put("goldens", copyKey("default", "default"), { head: 2, versions: [version(1), version(2)] });
    return { backend, store, rt: createRuntime({ backend, store, adapters: {} }) };
  };

  it("moves onto the head: a fork of the newer image replaces the machine, the record names it, and the status says which version it came from", async () => {
    const { backend, store, rt } = await seeded();
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    const moved = await rt.workspaces.updateImage(ws.id);
    expect(moved.workspace.golden).toBe("snap_golden-v2");
    expect(moved.workspace.machineId).toBe("m2");
    expect(backend.machines.map(m => [m.spec.fromSnapshot, m.killed])).toEqual([["snap_golden-v1", true], ["snap_golden-v2", false]]);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ golden: "snap_golden-v2", machineId: "m2" });
    expect(events.filter(e => e.type === "workspace.upgraded")).toMatchObject([{ workspaceId: ws.id, machineId: "m2" }]);
    const last = events.filter((e): e is EventUnion & { type: "workspace.status" } => e.type === "workspace.status").at(-1)!;
    expect(last.status.reason).toBe("moved from image v1 to v2");
  });

  it("one already on the head is handed back untouched: no machine is replaced", async () => {
    const { backend, rt } = await seeded();
    const ws = await createOn(rt, { golden: "snap_golden-v2", name: "api" });
    // The one place that knows no machine was replaced says so, rather than leaving every client to work it out.
    expect(await rt.workspaces.updateImage(ws.id)).toMatchObject({ workspace: { golden: "snap_golden-v2", machineId: "m1" }, moved: false, kept: [] });
    expect(backend.machines).toHaveLength(1);
    expect(backend.machines[0]!.killed).toBe(false);
  });

  it.each([
    // The sentence reads the state word with no pause mode behind it, which is the stopping word.
    ["napping" as const, "api is stopped; wake it to move it to a newer image"],
    ["gone" as const, "api's machine is gone; rebuild it to move it to a newer image"],
  ])("a %s workspace is refused with the sentence the app shows: the move replaces the machine, so only a running one takes it", async (phase, why) => {
    const { backend, store, rt } = await seeded();
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    const record = (await store.get("workspaces", ws.id)) as { phase: string };
    await store.put("workspaces", ws.id, { ...record, phase });
    // The store's word has to be the provider's too: a record over a machine that runs hydrates running, whichever
    // phase it was left at.
    if (phase === "napping") backend.machines[0]!.paused = true;
    else backend.machines[0]!.killed = true;
    await rt.close();
    const later = createRuntime({ backend, store, adapters: {} });
    try {
      await expect(later.workspaces.updateImage(ws.id)).rejects.toMatchObject({ kind: "conflict", message: why });
      // Nothing was replaced: the refusal lands before any fork.
      expect(backend.machines).toHaveLength(1);
      expect((await later.workspaces.get(ws.id)).machineId).toBe("m1");
    } finally {
      await later.close();
    }
  });

  it("one forked from a project image is refused, since the move would throw its project disk away", async () => {
    const { backend, store, rt } = await seeded();
    await store.put("project-goldens", "snap_project", {
      snapshotId: "snap_project",
      project: { name: "spoo", path: "/root/spoo", importedAt: "2026-09-02T00:00:00.000Z" },
      golden: "snap_golden-v1",
      workspaceId: "ws_old",
      workspaceName: "old",
      createdAt: "2026-09-02T00:00:00.000Z",
    });
    const ws = await createOn(rt, { golden: "snap_project", name: "api" });
    await expect(rt.workspaces.updateImage(ws.id)).rejects.toMatchObject({ kind: "conflict" });
    expect(backend.machines).toHaveLength(1);
    expect(backend.machines[0]!.killed).toBe(false);
  });

  // The move replaces the machine, and that kills before it forks: a create the provider
  // refuses leaves the workspace machineless whichever road asked for it. What the move owes is the record:
  // the image it names must be the one the workspace is on, so the rebuild that follows restores that version.
  it("a move that fails leaves the record on the image the workspace came from, so the rebuild after it forks that one", async () => {
    const { backend, store, rt } = await seeded();
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    const create = backend.create.bind(backend);
    let refused = true;
    backend.create = async spec => {
      if (refused && spec.fromSnapshot === "snap_golden-v2") {
        refused = false;
        throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency" });
      }
      return create(spec);
    };
    await expect(rt.workspaces.updateImage(ws.id)).rejects.toThrow("Too many concurrent sessions");
    expect((await rt.workspaces.get(ws.id)).golden).toBe("snap_golden-v1");
    expect(await store.get("workspaces", ws.id)).toMatchObject({ golden: "snap_golden-v1" });
    await rt.workspaces.rebuild(ws.id);
    expect(backend.machines.map(m => m.spec.fromSnapshot)).toEqual(["snap_golden-v1", "snap_golden-v1"]);
  });

  it("one forked from a snapshot no golden of this host knows is refused by name", async () => {
    const { rt } = await seeded();
    const ws = await createOn(rt, { golden: "snap_elsewhere", name: "api" });
    await expect(rt.workspaces.updateImage(ws.id)).rejects.toThrow("api's image is not one of the versions this host knows");
  });
});

describe("what a move onto a newer image does with the files the image itself wrote", () => {
  const sha = (c: string): string => c.repeat(64);
  /** What the fork's home holds at the top level, as the vault enumerates it. */
  const HOME = [".zshrc", ".gitconfig", ".claude", "proj"];
  const V1 = [
    { path: ".zshrc", sha256: sha("1") },
    { path: ".gitconfig", sha256: sha("2") },
    { path: ".claude/settings.json", sha256: sha("3") },
    // Rewritten by the tool as it runs, so its bytes on the fork say nothing about a person.
    { path: ".claude.json", sha256: sha("4"), volatile: true },
  ];
  const V2 = [
    { path: ".zshrc", sha256: sha("9") },
    { path: ".gitconfig", sha256: sha("2") },
    { path: ".claude/settings.json", sha256: sha("8") },
    { path: ".config/gh/hosts.yml", sha256: sha("7") },
  ];
  /** The fork left .zshrc and the agent's settings as v1 wrote them and rewrote its gitconfig. */
  const ON_FORK: Record<string, string> = { ".zshrc": sha("1"), ".gitconfig": sha("f"), ".claude/settings.json": sha("3") };

  const version = (n: number, owned?: { path: string; sha256: string; volatile?: boolean }[]): Record<string, unknown> => ({
    version: n,
    snapshotId: `snap_golden-v${n}`,
    baseTemplate: "base",
    setupSha: `s${n}`,
    createdAt: `2026-09-0${n}T00:00:00.000Z`,
    smoke: { cmd: "true", exitCode: 0 },
    ...(owned !== undefined ? { owned } : {}),
  });

  const seeded = async (versions: Record<string, unknown>[], on: { home?: string[]; fork?: Record<string, string> } = {}) => {
    const backend = stubBackend();
    const store = memoryStore();
    const home = on.home ?? HOME;
    const fork = on.fork ?? ON_FORK;
    await store.put("goldens", copyKey("default", "default"), { head: 2, versions });
    backend.execImpl = (_m, cmd) => {
      if (cmd.startsWith("ls -A /root")) return { exitCode: 0, stdout: `${home.join("\n")}\n`, stderr: "" };
      // The guest hashes what it was asked for and nothing else, so a path the read never names cannot reach the
      // comparison however much the fork holds.
      if (cmd.includes("sha256sum")) {
        const asked = Object.entries(fork).filter(([p]) => cmd.includes(`'${p}'`));
        return { exitCode: 0, stdout: asked.length === 0 ? "" : `${asked.map(([p, h]) => `${h}  ${p}`).join("\n")}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: cmd.includes("echo WSP_CTX") ? "WSP_CTX\nWSP_CTX_END\n" : "", stderr: "" };
    };
    return { backend, store, rt: createRuntime({ backend, store, adapters: {} }) };
  };
  const tarScript = (m: StubMachine): string => m.runLog.find(r => r.includes("tar czf"))!;
  /** The read of the fork's own copies, told from the hash the vault upload checks itself with. */
  const READ = "xargs -0 -r sha256sum";

  it("the files it never touched are left to the new image, its own edits travel and are named, and a directory holding one of them travels as its contents", async () => {
    const { backend, rt } = await seeded([version(1, V1), version(2, V2)]);
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    const moved = await rt.workspaces.updateImage(ws.id);
    expect(moved.kept).toEqual([".gitconfig"]);
    expect(moved.moved).toBe(true);
    expect(moved.fallback).toBeUndefined();
    expect(moved.workspace.golden).toBe("snap_golden-v2");
    const script = tarScript(backend.machines[0]!);
    // Dropped: the two the fork left as v1 wrote them, and the path only v2 writes.
    expect(script).toContain("-path 'root/.zshrc'");
    expect(script).toContain("-path 'root/.claude/settings.json'");
    expect(script).toContain("-path 'root/.config/gh/hosts.yml'");
    expect(script).not.toContain("-path 'root/.gitconfig'");
    // .claude holds a dropped path, so its own entry stays out of the archive and its contents travel. It is a
    // starting point, so it leaves by not being on the list tar is handed and not by a predicate find never tests.
    expect(script).toContain("printf '%s\\0' 'root/.gitconfig' 'root/proj' >");
    expect(script).not.toContain("-path 'root/.claude'");
  });

  it("a version sealed before the manifest existed falls back: nothing is read off the fork, nothing is dropped, and the result says so", async () => {
    const { backend, rt } = await seeded([version(1), version(2, V2)]);
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    const moved = await rt.workspaces.updateImage(ws.id);
    expect(moved).toMatchObject({ kept: [], fallback: true });
    expect(backend.machines[0]!.execLog.some(c => c.includes(READ))).toBe(false);
    expect(tarScript(backend.machines[0]!)).toContain("-C '/' 'root/.zshrc' 'root/.gitconfig' 'root/.claude' 'root/proj'");
  });

  it("a fork that changed nothing of the image's keeps nothing and every one of those files comes from the new image", async () => {
    const { backend, rt } = await seeded([version(1, V1.map(f => ({ ...f, sha256: ON_FORK[f.path] ?? f.sha256 }))), version(2, V2)]);
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    expect((await rt.workspaces.updateImage(ws.id)).kept).toEqual([]);
    const script = tarScript(backend.machines[0]!);
    for (const path of [".zshrc", ".gitconfig", ".claude/settings.json"]) expect(script).toContain(`-path 'root/${path}'`);
    expect(script).toContain("printf '%s\\0' 'root/proj' >");
  });

  it("a volatile file is never read off the fork and never named: its bytes move on their own, so the line stays the person's own edits", async () => {
    const { backend, rt } = await seeded([version(1, V1), version(2, V2)]);
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    expect((await rt.workspaces.updateImage(ws.id)).kept).toEqual([".gitconfig"]);
    const read = backend.machines[0]!.execLog.find(c => c.includes(READ))!;
    expect(read).not.toContain(".claude.json");
    // It is not dropped either: the fork's own copy is the one that travels.
    expect(tarScript(backend.machines[0]!)).not.toContain("-path 'root/.claude.json'");
  });

  it("a volatile row the new image adds is asked of the fork, so the live copy the fork keeps is the one that travels", async () => {
    // v1 never wrote .claude.json; v2 starts owning it as a volatile row, and the fork has been running with its own.
    const v1 = version(1, [{ path: ".zshrc", sha256: sha("1") }]);
    const v2 = version(2, [
      { path: ".zshrc", sha256: sha("9") },
      { path: ".claude.json", sha256: sha("7"), volatile: true },
    ]);
    const { backend, rt } = await seeded([v1, v2], {
      home: [".zshrc", ".claude.json", "proj"],
      fork: { ".zshrc": sha("1"), ".claude.json": sha("b") },
    });
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    const moved = await rt.workspaces.updateImage(ws.id);
    const read = backend.machines[0]!.execLog.find(c => c.includes(READ))!;
    expect(read).toContain("'.claude.json'");
    const script = tarScript(backend.machines[0]!);
    // The fork's own copy travels: the archive neither prunes the path nor holds it off the list tar is handed.
    expect(script).not.toContain("-path 'root/.claude.json'");
    expect(script).toContain("'root/.claude.json'");
    // It is live state, not a person's edit, so it is never named.
    expect(moved.kept).toEqual([]);
    // The untouched one still goes the other way, so the new image's .zshrc stands.
    expect(script).toContain("-path 'root/.zshrc'");
  });

  it("the comparison is read off the machine before it is killed, so the fork's own copies are what the archive judges", async () => {
    const { backend, rt } = await seeded([version(1, V1), version(2, V2)]);
    const ws = await createOn(rt, { golden: "snap_golden-v1", name: "api" });
    await rt.workspaces.updateImage(ws.id);
    const log = backend.machines[0]!.execLog;
    expect(log.findIndex(c => c.includes(READ))).toBeGreaterThan(-1);
    expect(log.findIndex(c => c.includes(READ))).toBeLessThan(log.findIndex(c => c.includes("tar czf")));
    expect(backend.machines[0]!.killed).toBe(true);
  });
});

describe("a create on a computer that names its own machines", () => {
  it("runs no hostname command inside the workspace, and a provider's fork is still named", async () => {
    const named = stubBackend();
    (named as { namesWorkspace?: boolean }).namesWorkspace = true;
    const rt = createRuntime({ backend: named, store: memoryStore(), adapters: {} });
    await createOn(rt, { golden: "snap_g", name: "on-a-box" });
    expect(named.machines[0]!.execLog.filter(cmd => cmd.startsWith("hostname "))).toEqual([]);

    // The provider's own fork boots as localhost, so that road still names it: the flag is the backend's, not a
    // rule about creates.
    const provider = stubBackend();
    const forking = createRuntime({ backend: provider, store: memoryStore(), adapters: {} });
    await createOn(forking, { golden: "snap_g", name: "at-a-provider" });
    expect(provider.machines[0]!.execLog.filter(cmd => cmd.startsWith("hostname "))).toEqual(["hostname at-a-provider && echo at-a-provider > /etc/hostname"]);
  });
});

describe("a project on a computer that clones at the add, recorded before it did", () => {
  it("is refused at the create in the doctor's own sentence, before any machine is asked for", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    // A project recorded when its computer kept no checkout of its own, which is every project added before the
    // add cloned once on the computer.
    const project = await projectOn(rt);
    expect(project.checkout).toBeUndefined();
    // The computer keeps project checkouts now, which is what puts this create on the road that reads one.
    (backend as { projects?: string }).projects = "/wsp/projects";
    const computer = (await rt.projects.computers()).find(row => row.id === project.computer)!.name;
    const forked = backend.machines.length;
    await expect(rt.workspaces.create({ project: project.id, name: "probe" })).rejects.toThrow(projectNeedsReaddLine(project.name, computer, project.source));
    expect(backend.machines).toHaveLength(forked);
    expect(await rt.workspaces.list()).toEqual([]);
  });
});
