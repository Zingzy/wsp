// SPDX-License-Identifier: AGPL-3.0-only
// The projects on a workspace record and the default folder rule: a record
// from before projects were a list loads as a list of one, a second import
// keeps the first, every start and every command reads the one rule in the
// runtime, the rule remembers where a thread landed, and a snapshot and a fork
// carry the project along.
import { tarOf } from "@wsp/engine";
import { DEFAULT_PREFERENCES, noProjectLine, type AdapterEvent, type ProjectPlan, type TurnResult, type WorkspaceProject } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { writeDaemonRootsScript } from "../src/daemon-roots.js";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions, type PackedProject, type ProjectBundler, type Runtime } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend, type StubBackend, type StubMachine } from "./stub-backend.js";
import type { ExecResult } from "@wsp/engine";

/** The guest side of the exec stream: the launch lands and the command exits 0 with no output, so a command's folder
 * can be read off the stream without a machine. */
function execGuest(backend: StubBackend): void {
  const base = backend.execImpl;
  backend.execImpl = (m: StubMachine, cmd: string): Promise<ExecResult> | ExecResult => {
    if (cmd.includes("base64 -d")) return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
    if (cmd.includes("kill -TERM") || cmd.includes("kill -KILL")) return { exitCode: 0, stdout: "", stderr: "" };
    const sentinel = /(__WSP_EOF_[a-z0-9]+__)/.exec(cmd)?.[1];
    if (sentinel !== undefined) return { exitCode: 0, stdout: `\n${sentinel} 0 down\n`, stderr: "" };
    return base(m, cmd);
  };
}

/** A folder of one file, nothing secret-shaped, no agents, weighing `bytes`. */
function bundler(source: string, bytes = 20): ProjectBundler {
  const plan: ProjectPlan = { source, repo: true, files: 1, bytes, secrets: [], excluded: [], skipped: [], agents: [] };
  return {
    plan: async () => plan,
    pack: async (): Promise<PackedProject> => ({ tar: tarOf([{ path: "src/index.ts", mode: 0o644, content: "export const a = 1;\n" }]), files: 1, bytes, cut: [], rewritten: [] }),
    packState: async () => {
      throw new Error("no agent state in this test");
    },
  };
}

/** A harness that records what it was started with and replies at once. */
function recording(): { adapter: HarnessAdapterFactory; starts: HarnessStartOptions[] } {
  const starts: HarnessStartOptions[] = [];
  let n = 0;
  const adapter: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      starts.push(o);
      const sessionId = o.resume ?? `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = (async () => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId, model: "claude-sonnet-4-5" },
          { type: "turn.done", sessionId, result },
          { type: "session.end", sessionId, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) o.onEvent(e);
        return result;
      })();
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { adapter, starts };
}

const SPOO = { source: "/Users/dev/spoo", dest: "/root/spoo" };
const WSP = { source: "/Users/dev/wsp", dest: "/root/wsp" };

async function setup(store: Store = memoryStore()): Promise<{ rt: Runtime; backend: StubBackend; store: Store; starts: HarnessStartOptions[] }> {
  const backend = stubBackend();
  const { adapter, starts } = recording();
  const rt = createRuntime({ backend, store, adapters: { claude: adapter } });
  execGuest(backend);
  return { rt, backend, store, starts };
}

const importOf = (rt: Runtime, workspaceId: string, folder: { source: string; dest: string }, bytes?: number) =>
  rt.projects.import({ workspaceId, source: folder.source, dest: folder.dest, bundler: bundler(folder.source, bytes) });

describe("the projects on a workspace record", () => {
  it("a record from before projects were a list loads as a list of one and is kept that way", async () => {
    const store = memoryStore();
    const first = await setup(store);
    const ws = await first.rt.workspaces.create({ golden: "snap_g", name: "b2" });
    await first.rt.close();
    const stored = (await store.get("workspaces", ws.id)) as Record<string, unknown>;
    const project: WorkspaceProject = { name: "spoo", dest: "/root/spoo", importedAt: "2026-09-01T00:00:00Z" };
    await store.put("workspaces", ws.id, { ...stored, project });

    const { rt } = await setup(store);
    const loaded = await rt.workspaces.get(ws.id);
    expect(loaded.projects).toEqual([project]);
    expect("project" in loaded).toBe(false);
    await rt.workspaces.rename(ws.id, "b3");
    const kept = (await store.get("workspaces", ws.id)) as Record<string, unknown>;
    expect(kept["projects"]).toEqual([project]);
    expect("project" in kept).toBe(false);
    await rt.close();
  });

  it("a second import keeps the first, in import order, each with its size; one landing at a folder already held replaces that entry alone", async () => {
    const { rt, backend } = await setup();
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b2" });
    await importOf(rt, ws.id, SPOO, 2048);
    await importOf(rt, ws.id, WSP, 4096);
    const both = (await rt.workspaces.get(ws.id)).projects!;
    expect(both.map(p => [p.name, p.dest, p.size])).toEqual([["spoo", "/root/spoo", 2048], ["wsp", "/root/wsp", 4096]]);
    // The daemon browses every project, so the roots file names both.
    const machine = backend.machines[0]!;
    expect(machine.execLog.at(-1)).toBe(writeDaemonRootsScript(["/root/spoo", "/root/wsp"]));

    await rt.projects.import({ workspaceId: ws.id, source: SPOO.source, dest: SPOO.dest, replace: true, bundler: bundler(SPOO.source, 3000) });
    const again = (await rt.workspaces.get(ws.id)).projects!;
    expect(again.map(p => [p.name, p.size])).toEqual([["wsp", 4096], ["spoo", 3000]]);
    expect(again[1]!.importedAt > both[0]!.importedAt || again[1]!.importedAt === both[0]!.importedAt).toBe(true);
    await rt.close();
  });
});

describe("the default folder rule, in the runtime", () => {
  it("a named folder wins; else the project named; else the last project used there; else the only project; else the kind's own folder", async () => {
    const { rt, starts } = await setup();
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b2" });
    // No project and a cloud kind: the kind names no folder, so the harness starts in its own home, and the view says so.
    expect(ws).not.toHaveProperty("folder");
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    expect(starts.at(-1)!.cwd).toBeUndefined();

    await importOf(rt, ws.id, SPOO);
    // The only project.
    await (await rt.sessions.start(ws.id, { prompt: "two" })).finished;
    expect(starts.at(-1)!.cwd).toBe("/root/spoo");

    await importOf(rt, ws.id, WSP);
    // Two projects and the last used was spoo (the start above landed there).
    await (await rt.sessions.start(ws.id, { prompt: "three" })).finished;
    expect(starts.at(-1)!.cwd).toBe("/root/spoo");
    // The project named wins over the last used.
    await (await rt.sessions.start(ws.id, { prompt: "four", project: "wsp" })).finished;
    expect(starts.at(-1)!.cwd).toBe("/root/wsp");
    // A folder named outright wins over both.
    await (await rt.sessions.start(ws.id, { prompt: "five", project: "spoo", cwd: "/root/elsewhere" })).finished;
    expect(starts.at(-1)!.cwd).toBe("/root/elsewhere");
    await rt.close();
  });

  it("two projects with none used yet fall to the kind's own folder, and a name the workspace lacks is refused before anything starts", async () => {
    const { rt, starts } = await setup();
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b2" });
    await importOf(rt, ws.id, SPOO);
    await importOf(rt, ws.id, WSP);
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    expect(starts.at(-1)!.cwd).toBeUndefined();
    const projects = (await rt.workspaces.get(ws.id)).projects!;
    await expect(rt.sessions.start(ws.id, { prompt: "two", project: "nope" })).rejects.toThrow(noProjectLine("nope", projects));
    expect(starts).toHaveLength(1);
    await rt.close();
  });

  it("a start remembers the project it landed in and the last target on the preferences record, once per change, so a second start on the same project pushes no record", async () => {
    const { rt, store } = await setup();
    const changed: number[] = [];
    rt.events.on("*", e => {
      if (e.type === "preferences.changed") changed.push(changed.length + 1);
    });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b2" });
    expect((await rt.preferences.get()).project).toEqual({});
    // No project on the workspace: nothing to remember of a project, but the workspace is now the target an import
    // or a thread asked for from nowhere goes to.
    await (await rt.sessions.start(ws.id, { prompt: "zero" })).finished;
    expect((await rt.preferences.get()).target).toEqual({ workspace: ws.id });
    expect(changed).toHaveLength(1);
    await importOf(rt, ws.id, SPOO);
    await importOf(rt, ws.id, WSP);
    await (await rt.sessions.start(ws.id, { prompt: "one", project: "wsp" })).finished;
    let preferences = await rt.preferences.get();
    expect(preferences.project).toEqual({ [ws.id]: "wsp" });
    expect(preferences.target).toEqual({ workspace: ws.id, project: "wsp" });
    expect(changed).toHaveLength(2);
    // The same project again moves nothing, so no socket hears a record that did not move.
    await (await rt.sessions.start(ws.id, { prompt: "again", project: "wsp" })).finished;
    expect(changed).toHaveLength(2);
    // A folder deep inside a project counts as that project's.
    await (await rt.sessions.start(ws.id, { prompt: "two", cwd: "/root/spoo/packages/api" })).finished;
    preferences = await rt.preferences.get();
    expect(preferences.project).toEqual({ [ws.id]: "spoo" });
    expect(preferences.target).toEqual({ workspace: ws.id, project: "spoo" });
    expect(changed).toHaveLength(3);
    // Outside every project: the last project stands, the target is the workspace alone.
    await (await rt.sessions.start(ws.id, { prompt: "three", cwd: "/root/elsewhere" })).finished;
    preferences = await rt.preferences.get();
    expect(preferences.project).toEqual({ [ws.id]: "spoo" });
    expect(preferences.target).toEqual({ workspace: ws.id });
    expect(changed).toHaveLength(4);
    // What the record holds is what a fresh runtime reads.
    expect(((await store.get("preferences", "default")) as { project: unknown }).project).toEqual({ [ws.id]: "spoo" });
    await rt.close();
  });

  it("the preference the composer writes is the second branch: the last project stands until a start or a pick moves it, and a stale name drops through", async () => {
    const { rt, starts } = await setup();
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b2" });
    await importOf(rt, ws.id, SPOO);
    await importOf(rt, ws.id, WSP);
    await rt.preferences.set({ project: { [ws.id]: "wsp" } });
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    expect(starts.at(-1)!.cwd).toBe("/root/wsp");
    await rt.preferences.set({ project: { [ws.id]: "gone" } });
    await (await rt.sessions.start(ws.id, { prompt: "two" })).finished;
    expect(starts.at(-1)!.cwd).toBeUndefined();
    await rt.close();
  });

  it("a command, the road wsp exec takes, starts in the folder the same rule names", async () => {
    const { rt } = await setup();
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b2" });
    const home = await rt.workspaces.execStream(ws.id, ["pwd"]);
    expect(home.ranIn).toBeUndefined();
    await importOf(rt, ws.id, SPOO);
    const only = await rt.workspaces.execStream(ws.id, ["pwd"]);
    expect(only.ranIn).toBe("/root/spoo");
    await importOf(rt, ws.id, WSP);
    await rt.preferences.set({ project: { [ws.id]: "wsp" } });
    const last = await rt.workspaces.execStream(ws.id, ["pwd"]);
    expect(last.ranIn).toBe("/root/wsp");
    const named = await rt.workspaces.execStream(ws.id, ["pwd"], "/root/elsewhere");
    expect(named.ranIn).toBe("/root/elsewhere");
    await rt.close();
  });

  it("a snapshot is named after the project the rule picks and carries every project on the disk, and a fork of it starts with all of them", async () => {
    const { rt, backend } = await setup();
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "b2" });
    // A fork's home is the guest's, published so a client shortens folders under it to ~.
    expect(ws.home).toBe("/root");
    await importOf(rt, ws.id, SPOO);
    await importOf(rt, ws.id, WSP);
    await rt.preferences.set({ project: { [ws.id]: "wsp" } });
    const golden = await rt.workspaces.snapshot(ws.id);
    expect(golden.projects.map(p => p.name)).toEqual(["spoo", "wsp"]);
    expect(backend.snapshots.at(-1)!.name).toContain("-project-wsp-");
    const fork = await rt.workspaces.create({ golden: golden.snapshotId, name: "task" });
    expect(fork.projects).toEqual(golden.projects);
    expect((await rt.preferences.get()).project).toEqual({ [ws.id]: "wsp" });
    expect(DEFAULT_PREFERENCES.project).toEqual({});
    await rt.close();
  });

  it("a project golden stored with the one project of before lists and forks as a golden of that one project", async () => {
    const store = memoryStore();
    const { rt } = await setup(store);
    const spoo: WorkspaceProject = { name: "spoo", dest: "/root/spoo", importedAt: "2026-09-01T00:00:00Z" };
    await store.put("project-goldens", "snap_old", { snapshotId: "snap_old", project: spoo, golden: "snap_g", workspaceId: "ws_gone", workspaceName: "b1", createdAt: "2026-09-01T01:00:00Z" });
    const [listed] = await rt.golden.projects();
    expect(listed).toEqual({ snapshotId: "snap_old", projects: [spoo], golden: "snap_g", workspaceId: "ws_gone", workspaceName: "b1", createdAt: "2026-09-01T01:00:00Z" });
    expect(listed).not.toHaveProperty("project");
    const fork = await rt.workspaces.create({ golden: "snap_old", name: "task" });
    expect(fork.projects).toEqual([spoo]);
    await rt.close();
  });
});
