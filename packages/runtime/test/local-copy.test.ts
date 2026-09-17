// SPDX-License-Identifier: AGPL-3.0-only
// The computer the app runs on as a computer that makes workspaces: the first
// piece of work on a project here is the folder itself, worked in place, and
// every one after is a copy of that folder at a sibling path. The copy itself
// is the daemon binary's, and its rules are proved in the daemon's own tests;
// what is proved here is what the runtime asks for, what it records, what a
// turn on a copy is told, and what a delete takes away.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeCopier, LocalBackend, projectStateKey } from "@wsp/engine";
import { PATH_BOUND_DIR_NAMES } from "@wsp/catalog";
import { copyPathFor, HERE_PLACE_ID, PORT_BASE_FIRST, PORT_BASE_STEP, type AdapterEvent, type TurnResult } from "@wsp/protocol";
import { COPY_SIZE_LINE_BYTES, createRuntime, oneWorkspacePerProject, type HarnessAdapterContext, type HarnessAdapterFactory, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, tempRepo, testPlatform } from "./stub-backend.js";

const roots: string[] = [];
const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "wsp-local-copy-"));
  roots.push(root);
  return root;
};
const repos: string[] = [];
const repo = (): string => {
  const at = tempRepo();
  repos.push(at);
  execFileSync("git", ["-C", at, "commit", "-q", "--allow-empty", "-m", "first"], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  return at;
};
afterEach(() => {
  for (const at of roots.splice(0)) rmSync(at, { recursive: true, force: true });
  for (const at of repos.splice(0)) rmSync(at, { recursive: true, force: true });
});

/** What every turn in this file was told, so the environment and the memory key a copy hands its agent can be read
 * back without a real CLI. */
interface Told {
  env: Readonly<Record<string, string>>;
  projectKey: string | undefined;
}

function telling(): { adapter: HarnessAdapterFactory; told: Told[] } {
  const told: Told[] = [];
  const adapter: HarnessAdapterFactory = (ctx: HarnessAdapterContext) => ({
    steers: false,
    start: o => {
      told.push({ env: ctx.env, projectKey: ctx.projectKey });
      const sessionId = "22222222-2222-4222-8222-222222222222";
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = (async () => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId },
          { type: "turn.done", sessionId, result },
          { type: "session.end", sessionId, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) o.onEvent(e);
        return result;
      })();
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { adapter, told };
}

/** This computer wired the way a host wires it, with the copy road handed in as the stand-in. */
function withCopier(): { rt: Runtime; copier: ReturnType<typeof fakeCopier>; told: Told[] } {
  const root = scratch();
  const copier = fakeCopier();
  const { adapter, told } = telling();
  const local: LocalWiring = {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    platform: testPlatform(),
    copier,
  };
  return { rt: createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: adapter }, local }), copier, told };
}

/** This computer with the copy road turned off at the backend, which is what a computer that makes no copy of a
 * folder says about itself: the one workspace per project is that computer's rule and not this Mac's. */
function withoutCopies(): Runtime {
  const root = scratch();
  const backend = new LocalBackend({ root });
  Object.defineProperty(backend, "capabilities", { value: { ...backend.capabilities, copies: false } });
  const { adapter } = telling();
  const local: LocalWiring = {
    backend,
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    platform: testPlatform(),
    copier: fakeCopier(),
  };
  return createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: adapter }, local });
}

describe("a computer that makes no copy of a folder", () => {
  it("has one workspace per project and names the one standing, whatever copy road the host holds", async () => {
    const rt = withoutCopies();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    await rt.workspaces.create({ project: project.id, name: "one" });
    await expect(rt.workspaces.create({ project: project.id, name: "two" })).rejects.toMatchObject({
      message: oneWorkspacePerProject(project.name, "one"),
      kind: "conflict",
    });
  });
});

describe("a second piece of work on a project here", () => {
  it("is a copy of the folder at a sibling path, asked for with the catalog's path-bound directories and the size line", async () => {
    const { rt, copier } = withCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const first = await rt.workspaces.create({ project: project.id, name: "pricing page" });
    expect(first.copy?.road).toBe("in-place");
    expect(copier.asks).toEqual([]);

    const second = await rt.workspaces.create({ project: project.id, name: "QR codes" });
    expect(copier.asks).toEqual([
      { from: folder, to: copyPathFor(folder, "qr-codes"), exclude: [...PATH_BOUND_DIR_NAMES], sizeLineBytes: COPY_SIZE_LINE_BYTES },
    ]);
    expect(second.copy).toEqual({
      road: "clonefile",
      path: copyPathFor(folder, "qr-codes"),
      base: "0".repeat(40),
      branch: "main",
      carried: "deps-and-config",
      source: folder,
    });
    // The workspace's folder is the copy, so a thread on it starts there and not in the person's own checkout.
    expect(second.folder).toBe(copyPathFor(folder, "qr-codes"));
    expect(first.folder).toBe(folder);
  });

  it("carries the branch the project records where it names one", async () => {
    const { rt, copier } = withCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder, base: "release" });
    await rt.workspaces.create({ project: project.id, name: "one" });
    await rt.workspaces.create({ project: project.id, name: "two" });
    expect(copier.asks[0]!.base).toBe("release");
  });

  it("gets a port base of its own, and the folder in place gets none", async () => {
    const { rt } = withCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const inPlace = await rt.workspaces.create({ project: project.id, name: "one" });
    const copyA = await rt.workspaces.create({ project: project.id, name: "two" });
    const copyB = await rt.workspaces.create({ project: project.id, name: "three" });
    expect(inPlace.portBase).toBeUndefined();
    expect(copyA.portBase).toBe(PORT_BASE_FIRST);
    expect(copyB.portBase).toBe(PORT_BASE_FIRST + PORT_BASE_STEP);
  });

  it("is where a thread and a command on it start, never the person's own checkout", async () => {
    const { rt } = withCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const inPlace = await rt.workspaces.create({ project: project.id, name: "one" });
    const copy = await rt.workspaces.create({ project: project.id, name: "two" });
    const ran = await rt.workspaces.execStream(copy.id, ["pwd"]);
    expect(ran.ranIn).toBe(copyPathFor(folder, "two"));
    await ran.exited;
    const here = await rt.workspaces.execStream(inPlace.id, ["pwd"]);
    expect(here.ranIn).toBe(folder);
    await here.exited;
  });

  it("tells a turn on it the port to bind and the folder's own memory key, and tells the folder in place only the key", async () => {
    const { rt, told } = withCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const inPlace = await rt.workspaces.create({ project: project.id, name: "one" });
    const copy = await rt.workspaces.create({ project: project.id, name: "two" });
    await (await rt.sessions.start(copy.id, { prompt: "work" })).finished;
    await (await rt.sessions.start(inPlace.id, { prompt: "work" })).finished;
    expect(told[0]!.env["PORT"]).toBe(String(PORT_BASE_FIRST));
    expect(told[1]!.env["PORT"]).toBeUndefined();
    // One memory and one sessions list for the folder and every copy of it: the key is the original folder's.
    expect(told[0]!.projectKey).toBe(projectStateKey("claude", folder));
    expect(told[1]!.projectKey).toBe(projectStateKey("claude", folder));
  });

  it("goes with its record when the workspace is deleted, and the folder in place is left alone", async () => {
    const { rt, copier } = withCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    const inPlace = await rt.workspaces.create({ project: project.id, name: "one" });
    const copy = await rt.workspaces.create({ project: project.id, name: "two" });
    await rt.workspaces.delete(copy.id);
    expect(copier.removed).toEqual([{ from: folder, to: copyPathFor(folder, "two"), road: "clonefile" }]);
    await rt.workspaces.delete(inPlace.id);
    expect(copier.removed).toHaveLength(1);
    // The base a delete freed is the next copy's, so the numbers stay small.
    const again = await rt.workspaces.create({ project: project.id, name: "three" });
    expect(again.copy?.road).toBe("in-place");
  });

  it("is refused before the copy runs where a fork's words were named, since the folder is not forked", async () => {
    const { rt, copier } = withCopier();
    const folder = repo();
    const project = await rt.projects.add({ source: folder });
    await rt.workspaces.create({ project: project.id, name: "one" });
    await expect(rt.workspaces.create({ project: project.id, name: "two", cpu: 4 })).rejects.toThrow(/takes no --size/);
    expect(copier.asks).toEqual([]);
  });

  it("leaves no copy behind when the record could not be written", async () => {
    const root = scratch();
    const copier = fakeCopier();
    const { adapter } = telling();
    const folder = repo();
    const local: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier,
    };
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter }, local });
    const project = await rt.projects.add({ source: folder });
    await rt.workspaces.create({ project: project.id, name: "one" });
    // The folder goes out from under the create between the copy and the record, which is what landProject reads.
    const broken = store.put;
    store.put = async () => {
      throw new Error("the store is full");
    };
    await expect(rt.workspaces.create({ project: project.id, name: "two" })).rejects.toThrow("the store is full");
    store.put = broken;
    expect(copier.removed).toEqual([{ from: folder, to: copyPathFor(folder, "two"), road: "clonefile" }]);
    // And the name is free again: nothing of the create that failed is held.
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["one"]);
  });
});
