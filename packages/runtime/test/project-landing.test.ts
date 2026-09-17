// SPDX-License-Identifier: AGPL-3.0-only
// What an add does on the computer holding the project: the clone, the files
// the person ticked, the install the lockfile picks, and on a provider the
// image every workspace of the project forks. Over the stub backend, so every
// command the machine was asked to run is read back here.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AdapterEvent, type EventUnion, type MachineSpec, type ProjectAddEvent, type SeedChoice, type SeedPlan, type TurnResult } from "@wsp/protocol";
import { copyKey, createRuntime, type HarnessAdapterFactory, type Runtime, type SeedWiring } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeLocal, stubBackend, type StubBackend } from "./stub-backend.js";

const version = { version: 1, snapshotId: "snap_golden-v1", baseTemplate: "base", setupSha: "s1", createdAt: "2026-09-17T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } };
const REMOTE = "https://github.com/spoo-me/frontend.git";

/** What every adapter this file wires was handed at its launch: the harness, the environment and the folder its
 * agent keys this project's sessions and memory to. */
const launches: { harness: string; env: Record<string, string>; projectKey?: string }[] = [];

/** An adapter that records the environment it was built with and answers a turn at once, one per harness. */
function recordingAdapter(harness: string): HarnessAdapterFactory {
  return ctx => {
    launches.push({ harness, env: { ...ctx.env }, ...(ctx.projectKey !== undefined ? { projectKey: ctx.projectKey } : {}) });
    return {
      steers: false,
      start: o => {
        const sessionId = `00000000-0000-4000-8000-${String(launches.length).padStart(12, "0")}`;
        const result: TurnResult = { status: "completed", text: "ok" };
        const finished = (async () => {
          for (const e of [
            { type: "session.start", sessionId, model: "m" },
            { type: "turn.done", sessionId, result },
            { type: "session.end", sessionId, exitCode: 0, sawResult: true },
          ] as AdapterEvent[]) {
            o.onEvent(e);
          }
          return result;
        })();
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    };
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A git repo in a folder of its own on this computer: the source a seed reads. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-seed-add-"));
  roots.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

function plan(folder: string, over: Partial<SeedPlan> = {}): SeedPlan {
  return {
    source: folder,
    remote: REMOTE,
    branch: "refactor/dashboard-polish",
    defaultBranch: "main",
    unpushed: null,
    uncommitted: 2,
    memory: { key: "-Users-dev-spoo-landing", files: 3, bytes: 20_000 },
    files: [
      { path: ".env.local", dir: false, bytes: 4096, kind: "config", row: { id: "next", name: "Next" }, ticked: true },
      { path: "node_modules", dir: true, bytes: 2_600_000_000, kind: "rebuilt", row: { id: "node", name: "Node" }, ticked: false },
    ],
    remembered: false,
    ...over,
  };
}

const TICKED: SeedChoice = { files: [".env.local"], memory: true, commits: false };

/** A host with an image sealed on the computer named, the stub provider as its backend and a folder reader that
 * answers the plan handed in: what an add of a folder on this computer onto a computer that clones needs. */
async function withImage(o: { at?: string; plan: SeedPlan; projects?: string; packed?: Buffer; keepsImages?: boolean; left?: string[] } = { plan: plan("/x") }): Promise<{ rt: Runtime; backend: StubBackend; store: Store; seed: SeedWiring; packs: { plan: SeedPlan; choice: SeedChoice }[] }> {
  const backend = stubBackend();
  // What the computer says about itself: a box keeps project checkouts on a disk of its own and no image at all,
  // a provider keeps images and no checkout.
  if (o.projects !== undefined) (backend as { projects?: string }).projects = o.projects;
  if (o.keepsImages === false) backend.capabilities.images = false;
  const store = memoryStore();
  await store.put("goldens", copyKey(o.at ?? "default", "default"), { head: 1, versions: [version] });
  const packs: { plan: SeedPlan; choice: SeedChoice }[] = [];
  const seed: SeedWiring = {
    plan: async () => o.plan,
    pack: async ({ plan: p, choice }) => {
      packs.push({ plan: p, choice });
      return { tar: o.packed ?? Buffer.from("seed archive"), files: choice.files.length, bytes: 12, commits: 0, left: o.left ?? [] };
    },
  };
  const root = mkdtempSync(join(tmpdir(), "wsp-add-local-"));
  roots.push(root);
  const adapters = { claude: recordingAdapter("claude"), codex: recordingAdapter("codex") };
  return { rt: createRuntime({ backend, store, adapters, local: fakeLocal(root), seed }), backend, store, seed, packs };
}

const stages = (events: readonly EventUnion[]): ProjectAddEvent[] => events.filter((e): e is ProjectAddEvent & { seq: number } => e.type === "project.add");

/** Every command every machine of this backend was asked to run, oldest first. */
const commands = (backend: StubBackend): string => backend.machines.flatMap(m => m.execLog).join("\n");
/** The spec of every machine it was asked for, in order. */
const specs = (backend: StubBackend): MachineSpec[] => backend.machines.map(m => m.spec);
const stopped = (backend: StubBackend): number => backend.machines.filter(m => m.killed).length;
/** What the machine answers one command with, over the probe the stub answers by default. */
function answering(backend: StubBackend, reply: (cmd: string) => { exitCode: number; stdout: string; stderr: string } | undefined): void {
  const own = backend.execImpl;
  backend.execImpl = (m, cmd) => reply(cmd) ?? own(m, cmd);
}

describe("a folder seeding a project on a computer that clones", () => {
  it("clones, lands the seed, installs and says each step as it happens", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    // What the machine answers the listing of the checkout's root with: an npm lockfile, so the node row's install runs.
    answering(backend, cmd => (cmd.startsWith("ls -A") ? { exitCode: 0, stdout: "package.json\npackage-lock.json\n.env.local\n", stderr: "" } : undefined));
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(stages(events).map(e => e.stage)).toEqual(["planned", "cloning", "seeding", "installing", "done"]);
    // The folder as this host resolved it, which on a Mac is the real path under /private.
    expect(project.path).toMatch(/spoo-landing|wsp-seed-add-/);
    const ran = commands(backend);
    // The clone carries the remote the folder's own origin gave, and it lands at the path the project has inside
    // every workspace of it, which is where the install then runs: an install that writes an absolute path names
    // what the workspaces read rather than the folder the computer keeps the checkout in.
    expect(ran).toContain(`git clone ${REMOTE} ${project.path}`);
    expect(ran).toContain(`cd '${project.path}' && npm ci`);
    expect(specs(backend)[0]?.binds).toEqual([
      { source: `/wsp/projects/${project.id}`, target: `/wsp/projects/${project.id}` },
      { source: `/wsp/projects/${project.id}/checkout`, target: project.path },
    ]);
    // The seed is landed and unpacked before the install runs, and wsp's own folder inside the checkout is removed.
    const order = [ran.indexOf("tar -xzf"), ran.indexOf("npm ci")];
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[1]).toBeGreaterThan(order[0]!);
    expect(ran).toContain(".wsp-seed");
    expect(project.seeded).toMatchObject({ files: 1, memory: true, commits: 0 });
    expect(project.installed).toMatchObject({ row: "node", command: "npm ci" });
    expect(project.remote).toBe(REMOTE);
  });

  it("runs every ecosystem the checkout's own root names a lockfile for, in catalogue order", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    answering(backend, cmd => (cmd.startsWith("ls -A") ? { exitCode: 0, stdout: "package-lock.json\nCargo.lock\n", stderr: "" } : undefined));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    const ran = commands(backend);
    expect(ran.indexOf("npm ci")).toBeGreaterThanOrEqual(0);
    expect(ran.indexOf("cargo fetch --locked")).toBeGreaterThan(ran.indexOf("npm ci"));
    expect(project.installed).toMatchObject({ row: "node, rust", command: "npm ci; cargo fetch --locked" });
  });

  it("packs only what the person ticked, and nothing runs an install where no lockfile picks one", async () => {
    const folder = repo();
    const { rt, backend, packs } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    answering(backend, cmd => (cmd.startsWith("ls -A") ? { exitCode: 0, stdout: "package.json\nREADME.md\n", stderr: "" } : undefined));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(packs).toEqual([{ plan: plan(folder), choice: TICKED }]);
    expect(project.installed).toBeUndefined();
    expect(commands(backend)).not.toContain("npm ci");
  });

  it("names the logins a ticked folder held that never travel, so nothing they ticked is dropped in silence", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects", left: ["config/.netrc"] });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: folder, on: "default", seed: { files: ["config"], memory: false, commits: false } });
    expect(project.notice).toBe("1 login inside the folders you ticked stayed on this computer: config/.netrc");
  });

  it("says nothing of the kind where every ticked path travelled", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    expect((await rt.projects.add({ source: folder, on: "default", seed: TICKED })).notice).toBeUndefined();
  });

  it("keeps the project's memory on the computer, and every workspace of it binds that folder read-write", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(project.memoryDir).toBe(`/wsp/projects/${project.id}/memory`);
    // The key is the folder's own here, so the memory the agent already kept for it is the memory it keeps.
    expect(project.memoryKey).toBe("-Users-dev-spoo-landing");
    const before = backend.machines.length;
    await rt.workspaces.create({ project: project.id, name: "work" });
    expect(specs(backend)[before]?.binds).toEqual([{ source: project.memoryDir, target: `/root/.claude-cfg/projects/${project.memoryKey}/memory` }]);
  });

  it("leaves the checkout on the computer, and every workspace of the project takes its own copy of it", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects", keepsImages: false });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(project.checkout).toBe(`/wsp/projects/${project.id}/checkout`);
    const before = backend.machines.length;
    await rt.workspaces.create({ project: project.id, name: "work" });
    // The copy is mounted at the path the project has inside, which for a folder seeded from this computer is the
    // folder's own path, and nothing clones over it.
    expect(specs(backend)[before]?.copy).toEqual({ from: project.checkout, at: project.path });
    expect(backend.machines[before]?.execLog.join("\n")).not.toContain("git clone");
  });

  it("the machine that did the work is stopped whatever happened, and a failed install is the add's own failure", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    answering(backend, cmd => {
      if (cmd.startsWith("ls -A")) return { exitCode: 0, stdout: "package-lock.json\n", stderr: "" };
      if (cmd.includes("npm ci")) return { exitCode: 1, stdout: "", stderr: "npm error code ENOSPC\nnpm error nospc ENOSPC: no space left on device\n" };
      return undefined;
    });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    await expect(rt.projects.add({ source: folder, on: "default", seed: TICKED })).rejects.toThrow(/no space left on device/);
    expect(stages(events).at(-1)?.stage).toBe("failed");
    // Nothing is left running at the provider, and no project was recorded.
    expect(stopped(backend)).toBe(1);
    expect(await rt.projects.list()).toEqual([]);
  });
});

describe("a computer that keeps no image of its own", () => {
  it("is worked in a copy of its own directories: nothing is forked from an image and the clone still lands", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects", keepsImages: false });
    answering(backend, cmd => (cmd.startsWith("ls -A") ? { exitCode: 0, stdout: "package-lock.json\n", stderr: "" } : undefined));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(specs(backend)[0]?.fromSnapshot).toBeUndefined();
    expect(commands(backend)).toContain(`git clone ${REMOTE}`);
    expect(project.installed).toMatchObject({ command: "npm ci" });
    // The machine the work ran in is stopped, and the project keeps its memory on that computer.
    expect(stopped(backend)).toBe(1);
    expect(project.memoryDir).toBe(`/wsp/projects/${project.id}/memory`);
  });
});

describe("a project on a provider", () => {
  it("becomes the image every workspace of it forks, sealed once from the machine that cloned and installed", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder) });
    answering(backend, cmd => (cmd.startsWith("ls -A") ? { exitCode: 0, stdout: "package-lock.json\n", stderr: "" } : undefined));
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(stages(events).map(e => e.stage)).toEqual(["planned", "cloning", "seeding", "installing", "imaging", "done"]);
    expect(project.image?.snapshotId).toMatch(/^snap_/);
    expect(backend.snapshots.length).toBe(1);
    // The project's memory rides that image, so there is nothing of the computer's to bind into a workspace.
    expect(project.memoryDir).toBe(`/root/.claude-cfg/projects/${project.memoryKey}/memory`);
    const before = backend.machines.length;
    await rt.workspaces.create({ project: project.id, name: "work" });
    expect(specs(backend)[before]?.binds).toBeUndefined();
    // And that workspace forks the project's own image rather than the head of this host's.
    expect(specs(backend)[before]?.fromSnapshot).toBe(project.image?.snapshotId);
    // A copy forked from the project image holds the checkout already: nothing clones into it again.
    expect(backend.machines.flatMap(m => m.execLog).filter(cmd => cmd.includes("git clone")).length).toBe(1);
  });

  it("the machine it was built from is stopped, and the person's own folder stays on this computer", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder) });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(stopped(backend)).toBe(1);
    // The seed archive is what travelled, and it went to the machine as one file under wsp's own folder there.
    expect(backend.puts.map(p => p.path).every(path => path.startsWith("/tmp/"))).toBe(true);
    expect(backend.puts.length).toBe(1);
  });
});

describe("an ssh remote a box could not open", () => {
  it("is recorded as its host's https url, since no computer wsp forks carries a key of the person's", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder, { remote: "git@github.com:spoo-me/frontend.git" }) });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(project.remote).toBe("https://github.com/spoo-me/frontend.git");
    expect(commands(backend)).toContain("git clone https://github.com/spoo-me/frontend.git");
  });

  it("a remote on a host the catalog carries no command line for is cloned as it stands", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder, { remote: "git@git.example.com:dev/thing.git" }) });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    expect(project.remote).toBe("git@git.example.com:dev/thing.git");
  });
});

describe("a repo named by owner and repo", () => {
  it("is cloned through the host's own command line, which the computer's image is checked for first", async () => {
    const { rt, backend } = await withImage({ plan: plan("/x") });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: "spoo-me/frontend", on: "default" });
    expect(project.source).toEqual({ kind: "github", repo: "spoo-me/frontend" });
    expect(project.remote).toBe("https://github.com/spoo-me/frontend.git");
    // Nothing runs at the add for a repo the computer clones by itself; the workspace's own create does that.
    expect(commands(backend)).not.toContain("gh repo clone");
    const before = backend.machines.length;
    await rt.workspaces.create({ project: project.id, name: "work" });
    const ran = commands(backend);
    expect(ran).toContain("command -v gh");
    expect(ran).toContain("gh auth setup-git");
    expect(ran).toContain("gh repo clone spoo-me/frontend /root/frontend");
    expect(specs(backend)[before]?.binds).toBeUndefined();
  });

  it("a gitlab repo is named with its host and cloned through glab", async () => {
    const { rt, backend } = await withImage({ plan: plan("/x") });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: "gitlab.com/dev/thing", on: "default" });
    expect(project.source).toEqual({ kind: "gitlab", repo: "dev/thing" });
    await rt.workspaces.create({ project: project.id, name: "work" });
    expect(commands(backend)).toContain("glab repo clone dev/thing /root/thing");
  });
});

describe("the key an agent's launch carries", () => {
  it("is the project's own for an agent whose catalog row names the variable, and nothing for one that names none", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder) });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const project = await rt.projects.add({ source: folder, on: "default", seed: TICKED });
    const ws = await rt.workspaces.create({ project: project.id, name: "work" });
    // The agent whose row names the variable is told the project's own key, which is the folder's key on the
    // computer it was seeded from and not the path the checkout took there.
    expect(await launchKey(rt, ws.id, "claude")).toBe(project.memoryKey);
    // An agent whose row names none is told nothing and keys off the folder its turn runs in.
    expect(await launchKey(rt, ws.id, "codex")).toBeUndefined();
    // Nothing of it rides the launch environment: the adapter sets it after its own strip.
    expect(Object.keys(launches.at(-1)?.env ?? {}).some(key => key.endsWith("PROJECT_DIR_NAME"))).toBe(false);
  });
});

/** The key one harness's launch on a workspace was handed, read off the adapter the runtime built for it. */
async function launchKey(rt: Runtime, workspaceId: string, harness: string): Promise<string | undefined> {
  const session = await rt.sessions.start(workspaceId, { prompt: "hi", harness });
  await session.finished;
  return launches.filter(l => l.harness === harness).at(-1)?.projectKey;
}

describe("the menu a folder's add reads", () => {
  it("is the reader's own plan, with the ticks a choice remembered for that folder leaves on it", async () => {
    const folder = repo();
    const { rt, backend } = await withImage({ plan: plan(folder), projects: "/wsp/projects" });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    // Nothing is remembered yet: the catalogue's own ticks stand and the plan says so.
    const first = await rt.projects.seedPlan(folder);
    expect(first.remembered).toBe(false);
    expect(first.files.filter(f => f.ticked).map(f => f.path)).toEqual([".env.local"]);
    // A choice kept for this folder ticks exactly what it named, whatever the catalogue would have.
    await rt.projects.add({ source: folder, on: "default", seed: { files: ["node_modules"], memory: false, commits: false, remember: true } });
    const again = await rt.projects.seedPlan(folder);
    expect(again.remembered).toBe(true);
    expect(again.files.filter(f => f.ticked).map(f => f.path)).toEqual(["node_modules"]);
  });

  it("never ticks a path that never travels, whatever was remembered for the folder", async () => {
    const folder = repo();
    const login = { path: ".git-credentials", dir: false, bytes: 300, kind: "never" as const, row: { id: "logins", name: "logins" }, ticked: false };
    const { rt, backend } = await withImage({ plan: plan(folder, { files: [login] }), projects: "/wsp/projects" });
    answering(backend, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    await rt.projects.add({ source: folder, on: "default", seed: { files: [".git-credentials"], memory: false, commits: false, remember: true } });
    const again = await rt.projects.seedPlan(folder);
    expect(again.files.every(f => !f.ticked)).toBe(true);
  });
});
