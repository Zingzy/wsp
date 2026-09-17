// SPDX-License-Identifier: AGPL-3.0-only
// Projects as records of their own: what wsp add records and what it refuses,
// the two roads a workspace of one takes, and what a thread on it starts in.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { folderOnCopyRefusal, gitOnThisMacRefusal, HERE_PLACE_ID, NOT_A_REPO_LINE, projectInUseRefusal, sameSourceRefusal, type AdapterEvent, type EventUnion, type TurnResult } from "@wsp/protocol";
import { createRuntime, oneWorkspacePerProject, type HarnessAdapterFactory, type HarnessStartOptions, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn, fakeLocal, projectOn, stubBackend, tempRepo, type StubBackend } from "./stub-backend.js";

const REPO = "https://github.com/spoo-me/frontend.git";

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

const roots: string[] = [];
const here = (): string => {
  const root = mkdtempSync(join(tmpdir(), "wsp-projects-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function withLocal(backend: StubBackend = stubBackend()): { rt: Runtime; backend: StubBackend; starts: HarnessStartOptions[] } {
  const { adapter, starts } = recording();
  const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: adapter }, local: fakeLocal(here()) });
  return { rt, backend, starts };
}

describe("recording a project", () => {
  it("a folder that is a git repo is a project on this computer, in place, and it goes out as an event", async () => {
    const { rt } = withLocal();
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const folder = tempRepo();
    const project = await rt.projects.add({ source: folder });
    expect(project).toMatchObject({ id: expect.stringMatching(/^pr_[0-9a-f]{8}$/), name: folder.split("/").at(-1), computer: HERE_PLACE_ID, path: folder, source: { kind: "folder", path: folder } });
    expect(events.filter(e => e.type === "project.added")).toEqual([{ type: "project.added", project, seq: expect.any(Number) }]);
    expect(await rt.projects.list()).toEqual([project]);
    rmSync(folder, { recursive: true, force: true });
  });

  it("a folder that is no git repo is no project: a workspace of one starts on a branch", async () => {
    const { rt } = withLocal();
    const plain = mkdtempSync(join(tmpdir(), "wsp-plain-"));
    await expect(rt.projects.add({ source: plain })).rejects.toThrow(NOT_A_REPO_LINE);
    expect(await rt.projects.list()).toEqual([]);
    rmSync(plain, { recursive: true, force: true });
  });

  it("a folder under a repo is no project either: the folder itself has to be the top of it", async () => {
    const { rt } = withLocal();
    const repo = tempRepo();
    execFileSync("mkdir", ["-p", join(repo, "packages", "host")]);
    await expect(rt.projects.add({ source: join(repo, "packages", "host") })).rejects.toThrow(NOT_A_REPO_LINE);
    rmSync(repo, { recursive: true, force: true });
  });

  it("a repo's url with no computer names the ones that clone, since this computer takes a folder of yours", async () => {
    const { rt } = withLocal();
    await expect(rt.projects.add({ source: REPO })).rejects.toThrow("name the computer that clones it with --on default");
    expect(await rt.projects.list()).toEqual([]);
  });

  it("a repo's url on a computer that clones records the clone's own path inside a copy of it", async () => {
    const { rt } = withLocal();
    const project = await rt.projects.add({ source: REPO, on: "default", name: "spoo-landing" });
    expect(project).toMatchObject({ computer: "default", name: "spoo-landing", path: "/root/spoo-landing", source: { kind: "git", url: REPO } });
    // The same source on that computer again is the same project, so a second record of it is refused by name.
    await expect(rt.projects.add({ source: REPO, on: "default" })).rejects.toMatchObject({ message: sameSourceRefusal("spoo-landing", "default"), kind: "conflict" });
  });

  it("each computer takes the source its kind takes and refuses the other in one sentence", async () => {
    const { rt } = withLocal();
    const folder = tempRepo();
    await expect(rt.projects.add({ source: folder, on: "default" })).rejects.toThrow(folderOnCopyRefusal("default"));
    await expect(rt.projects.add({ source: REPO, on: HERE_PLACE_ID })).rejects.toThrow(gitOnThisMacRefusal);
    rmSync(folder, { recursive: true, force: true });
  });

  it("a project is dropped once no workspace stands on it, and the drop goes out as an event", async () => {
    const { rt } = withLocal();
    const events: EventUnion[] = [];
    const project = await projectOn(rt);
    const ws = await rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" });
    rt.events.on("*", e => events.push(e));
    await expect(rt.projects.remove(project.id)).rejects.toMatchObject({ message: projectInUseRefusal(project.name, ["work"]), kind: "conflict" });
    await rt.workspaces.delete(ws.id);
    await rt.projects.remove(project.id);
    expect(await rt.projects.list()).toEqual([]);
    expect(events.filter(e => e.type === "project.removed")).toEqual([{ type: "project.removed", projectId: project.id, seq: expect.any(Number) }]);
  });

  it("a project is named by id or by name, and a word that names none is refused with the ones there are", async () => {
    const { rt } = withLocal();
    const project = await projectOn(rt, "default", REPO, { name: "spoo-landing" });
    expect(await rt.projects.resolve(project.id)).toEqual(project);
    expect(await rt.projects.resolve("spoo-landing")).toEqual(project);
    await expect(rt.projects.resolve("nothing")).rejects.toThrow("no project \"nothing\"; this host holds spoo-landing");
  });
});

describe("a workspace of a project", () => {
  it("on a computer that clones, it forks that computer's image and clones the repo into it before it is ready", async () => {
    const { rt, backend } = withLocal();
    const stages: string[] = [];
    rt.events.on("*", e => {
      if (e.type === "workspace.creating") stages.push(e.stage);
    });
    const project = await rt.projects.add({ source: REPO, on: "default", name: "spoo-landing", base: "main" });
    const ws = await rt.workspaces.create({ project: project.id, golden: "snap_g", name: "pricing page" });
    expect(ws.project).toEqual({ id: project.id, name: "spoo-landing", path: "/root/spoo-landing", computer: "default" });
    expect(backend.machines[0]!.execLog).toContain(`git clone --branch main ${REPO} /root/spoo-landing`);
    expect(stages).toContain("project-cloned");
    expect(stages.indexOf("project-cloned")).toBeLessThan(stages.indexOf("ready"));
  });

  it("with no base recorded the clone takes the remote's own default branch", async () => {
    const { rt, backend } = withLocal();
    const project = await rt.projects.add({ source: REPO, on: "default", name: "spoo-landing" });
    await rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" });
    expect(backend.machines[0]!.execLog).toContain(`git clone ${REPO} /root/spoo-landing`);
  });

  it("a clone that fails ends the create with git's own last line and the machine goes with it", async () => {
    const backend = stubBackend();
    const plain = backend.execImpl;
    backend.execImpl = (m, cmd) => (cmd.startsWith("git clone") ? { exitCode: 128, stdout: "", stderr: "Cloning into '/root/x'...\nfatal: could not read Username for 'https://github.com'" } : plain(m, cmd));
    const { rt } = withLocal(backend);
    const project = await rt.projects.add({ source: REPO, on: "default", name: "x" });
    await expect(rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" })).rejects.toThrow("fatal: could not read Username for 'https://github.com'");
    expect(backend.machines.every(m => m.killed)).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("on this computer the workspace is the folder itself, and a second one on that project names the one standing", async () => {
    const { rt } = withLocal();
    const folder = tempRepo();
    const project = await rt.projects.add({ source: folder });
    const ws = await rt.workspaces.create({ project: project.id, name: "plan check" });
    expect(ws).toMatchObject({ kind: "local", golden: "", project: { name: project.name, path: folder, computer: HERE_PLACE_ID } });
    await expect(rt.workspaces.create({ project: project.id, name: "second" })).rejects.toMatchObject({ message: oneWorkspacePerProject(project.name, "plan check"), kind: "conflict" });
    rmSync(folder, { recursive: true, force: true });
  });
});

describe("the folder a thread starts in", () => {
  it("is the workspace's project, and the cwd a caller names wins over it", async () => {
    const { rt, starts } = withLocal();
    const project = await rt.projects.add({ source: REPO, on: "default", name: "spoo-landing" });
    const ws = await rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" });
    await rt.sessions.start(ws.id, { prompt: "hi" });
    expect(starts.at(-1)!.cwd).toBe("/root/spoo-landing");
    await rt.sessions.start(ws.id, { prompt: "hi", cwd: "/root/elsewhere" });
    expect(starts.at(-1)!.cwd).toBe("/root/elsewhere");
  });

  it("the agent a thread ran under is remembered on the project and taken by the next thread that names none", async () => {
    const { rt } = withLocal();
    const project = await projectOn(rt);
    const ws = await rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" });
    expect((await rt.projects.resolve(project.id)).lastAgent).toBeUndefined();
    await rt.sessions.start(ws.id, { prompt: "hi", harness: "claude" });
    expect((await rt.projects.resolve(project.id)).lastAgent).toBe("claude");
    // A start that names none runs it, which is what the composer and the command line both show as the default.
    const handle = await rt.sessions.start(ws.id, { prompt: "again" });
    expect(handle.view().harness).toBe("claude");
  });

  it("the last target is the workspace alone, since a workspace holds one project", async () => {
    const { rt } = withLocal();
    const project = await projectOn(rt);
    const ws = await rt.workspaces.create({ project: project.id, golden: "snap_g", name: "work" });
    await rt.sessions.start(ws.id, { prompt: "hi" });
    expect((await rt.preferences.get()).target).toEqual({ workspace: ws.id });
  });
});

describe("a state file from before projects were records", () => {
  it("is not read: the host refuses in one sentence naming the file and does not serve", async () => {
    const store = memoryStore();
    await store.put("workspaces", "ws_old", { id: "ws_old", name: "old", kind: "cloud", machineId: "m1", phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00.000Z", spec: {}, size: { cpu: 2, memMb: 4096 }, firstLife: true, projects: [{ name: "spoo", dest: "/root/spoo", importedAt: "2026-09-01T00:00:00.000Z" }] });
    const rt = createRuntime({ backend: stubBackend(), store, adapters: {}, statePath: "/tmp/wsp-905/state.json" });
    await expect(rt.workspaces.list()).rejects.toThrow("move /tmp/wsp-905/state.json aside and start again");
  });
});
