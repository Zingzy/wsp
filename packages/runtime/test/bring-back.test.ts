// SPDX-License-Identifier: AGPL-3.0-only
// Bringing work back: the two frames the runtime sends down a workspace's own
// daemon channel, which base each carries, and what a machine with no
// signed-in command line for the git host answers with.
import { describe, expect, it, afterEach } from "vitest";
import { branchUnreadRefusal, noGitCredentialLine, noHostCliLine, noParentWorkspaceLine, onBaseRefusal, type DaemonFrame, type DaemonResponse } from "@wsp/protocol";
import { createRuntime, type Runtime } from "../src/runtime.js";
import type { DaemonChannel, DaemonChannelOptions } from "../src/daemon-channel.js";
import { daemonTokenFor } from "../src/daemon-token.js";
import { memoryStore } from "../src/store.js";
import { createOn, projectOn, stubBackend, tokenGuest, withDaemonRoads, type StubBackend } from "./stub-backend.js";

/** Every fact of a pull request a read answers but its number, link, state and host, which each case names. */
const PR_REST: Omit<import("@wsp/protocol").PullRequest, "number" | "url" | "state" | "host"> = { draft: false, base: "main", branch: "work", headOid: "abc1234", headSubject: "Do the work", mergeable: "unknown", mergeState: "unknown", review: "none", checks: [], additions: 1, deletions: 0, changedFiles: 1, commits: 1 };

const DAEMON_TOKEN = "cafef00d".repeat(3);

/** A daemon that records every frame and answers each op the way one on a machine would. */
function fakeDaemon(answers: Partial<Record<string, (frame: Record<string, unknown>) => DaemonResponse>> = {}): {
  open: (o: DaemonChannelOptions) => Promise<DaemonChannel>;
  frames: Record<string, unknown>[];
  tokens: string[];
  dials: DaemonChannelOptions[];
  closed: number;
} {
  const frames: Record<string, unknown>[] = [];
  /** The machine token each frame's dial carried, which says which workspace's daemon it went to. */
  const tokens: string[] = [];
  const dials: DaemonChannelOptions[] = [];
  const state = { closed: 0 };
  const push = (frame: Record<string, unknown>): DaemonResponse => ({
    id: 1,
    ok: true,
    branch: "pricing-page",
    base: String(frame["base"] ?? ""),
    remote: "origin",
    ahead: 2,
    uncommitted: 1,
    stat: [" src/page.tsx | 4 ++--"],
  });
  const pr = (): DaemonResponse => ({ id: 1, ok: true, pr: { number: 12, url: "https://github.com/o/r/pull/12", state: "open", host: "github.com", ...PR_REST }, created: true });
  return {
    frames,
    tokens,
    dials,
    get closed() {
      return state.closed;
    },
    open: async o => {
      dials.push(o);
      return {
        send: async (frame: DaemonFrame) => {
          const held = frame as unknown as Record<string, unknown>;
          frames.push(held);
          tokens.push(o.token);
          const own = answers[String(held["op"])];
          if (own !== undefined) return own(held);
          return String(held["op"]) === "git.push" ? push(held) : pr();
        },
        close: () => {
          state.closed += 1;
        },
        // Nothing here ends of its own: the runtime's own road closes the channel when the work it opened it for is over.
        closed: new Promise(() => {}),
      };
    },
  };
}

let rt: Runtime | undefined;
afterEach(async () => {
  await rt?.close();
  rt = undefined;
});

/** A runtime whose one workspace has a daemon answering, as a fork on a box does. */
async function withWorkspace(daemon: ReturnType<typeof fakeDaemon>, base?: string): Promise<{ backend: StubBackend; id: string; projectId: string }> {
  const backend = stubBackend();
  backend.execImpl = tokenGuest;
  withDaemonRoads(backend);
  rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: DAEMON_TOKEN, daemonChannel: daemon.open });
  const project = await projectOn(rt, undefined, undefined, base === undefined ? undefined : { base });
  const ws = await createOn(rt, { project: project.id, golden: "snap_g", name: "pricing page" });
  return { backend, id: ws.id, projectId: project.id };
}

describe("workspaces.bringBack", () => {
  it("a workspace with no parent pushes and opens the pull request against the project's own base, on one dial that is closed after", async () => {
    const daemon = fakeDaemon();
    const { id } = await withWorkspace(daemon, "main");
    const back = await rt!.workspaces.bringBack({ workspaceId: id, title: "the pricing page", body: "what it does" });
    expect(daemon.frames).toEqual([
      { op: "git.push", cwd: "/root/stub-1", base: "main" },
      { op: "git.pr", cwd: "/root/stub-1", base: "main", title: "the pricing page", body: "what it does" },
    ]);
    expect(back).toEqual({
      branch: "pricing-page",
      base: "main",
      ahead: 2,
      uncommitted: 1,
      stat: [" src/page.tsx | 4 ++--"],
      pr: { number: 12, url: "https://github.com/o/r/pull/12", state: "open", host: "github.com", ...PR_REST },
    });
    expect(daemon.dials.map(({ url, token }) => ({ url, token }))).toEqual([{ url: "http://127.0.0.1:9", token: daemonTokenFor(DAEMON_TOKEN, "m1") }]);
    expect(daemon.closed).toBe(1);
  });

  it("a project that named no base leaves it to the checkout, which reads its own", async () => {
    const daemon = fakeDaemon();
    const { id } = await withWorkspace(daemon);
    await rt!.workspaces.bringBack({ workspaceId: id });
    expect(daemon.frames.map(f => f["base"])).toEqual([undefined, undefined]);
  });

  it("a branch only the parent's own copy holds is pushed first, and the child starts and lands on it", async () => {
    const daemon = fakeDaemon({
      "git.status": () => ({ id: 1, ok: true, branch: { oid: "abc", head: "only-here", ahead: 2, behind: 0 }, entries: [], root: "/root/stub-1" }) as DaemonResponse,
      "git.startOn": f => ({ id: 1, ok: true, branch: String(f["branch"]), oid: "c0ffee" }) as DaemonResponse,
    });
    const { id, projectId } = await withWorkspace(daemon, "main");
    const child = await rt!.workspaces.create({ project: projectId, golden: "snap_g", name: "second look", parent: id });
    expect(child.parentWorkspaceId).toBe(id);
    expect(daemon.frames[0]?.["op"]).toBe("git.status");
    expect(daemon.frames.filter(f => f["op"] !== "git.status").map(f => [f["op"], f["base"] ?? f["branch"]])).toEqual([
      ["git.push", "main"],
      ["git.startOn", "pricing-page"],
    ]);
    daemon.frames.length = 0;
    await rt!.workspaces.bringBack({ workspaceId: child.id });
    expect(daemon.frames.filter(f => f["op"] !== "git.status").map(f => f["base"])).toEqual(["pricing-page", "pricing-page"]);
  });

  it("a parent that did not say which branch it is on stops the fork, and no child is made", async () => {
    // The daemon is there and the read is not: what a stopped machine, a shell that failed and the read's own bound
    // all come back as. A child started at the project's base here would land its work at the project's base.
    const daemon = fakeDaemon({ "git.status": () => ({ id: 1, ok: false, error: "machine is paused" }) as DaemonResponse });
    const { id, projectId } = await withWorkspace(daemon, "main");
    const refused = await rt!.workspaces.create({ project: projectId, golden: "snap_g", name: "second look", parent: id }).catch((e: unknown) => e);
    expect((refused as Error).message).toBe(branchUnreadRefusal("pricing page", "machine is paused"));
    expect((await rt!.workspaces.list()).map(w => w.name)).toEqual(["pricing page"]);
  });

  it("a child whose parent went to sleep after the fork brings back against the branch it was forked from", async () => {
    let parentAnswers = true;
    const daemon = fakeDaemon({
      "git.status": () =>
        (parentAnswers
          ? { id: 1, ok: true, branch: { oid: "abc", head: "pricing-page", upstream: "origin/pricing-page", ahead: 0, behind: 0 }, entries: [], root: "/root/stub-1" }
          : { id: 1, ok: false, error: "machine is paused" }) as DaemonResponse,
      "git.startOn": f => ({ id: 1, ok: true, branch: String(f["branch"]), oid: "c0ffee" }) as DaemonResponse,
    });
    const { id, projectId } = await withWorkspace(daemon, "main");
    const child = await rt!.workspaces.create({ project: projectId, golden: "snap_g", name: "second look", parent: id });
    // The parent naps, and its daemon would now answer with what a stopped machine answers. The child's work still
    // goes back into the branch it was cut from, and nothing asks the parent anything.
    await rt!.workspaces.nap(id);
    parentAnswers = false;
    const asked = daemon.frames.length;
    const back = await rt!.workspaces.bringBack({ workspaceId: child.id });
    expect(back.base).toBe("pricing-page");
    expect(daemon.frames.slice(asked).filter(f => f["op"] !== "git.status").map(f => f["base"])).toEqual(["pricing-page", "pricing-page"]);
    expect(daemon.tokens.slice(asked).filter(t => t === daemonTokenFor(DAEMON_TOKEN, "m1"))).toEqual([]);
  });

  it("a create naming a parent this host does not hold is refused, not landed as a root", async () => {
    const daemon = fakeDaemon();
    const { projectId } = await withWorkspace(daemon, "main");
    const refused = await rt!.workspaces.create({ project: projectId, golden: "snap_g", name: "orphan", parent: "ws_nobody" }).catch((e: unknown) => e);
    expect((refused as Error).message).toBe(noParentWorkspaceLine("ws_nobody"));
    expect((await rt!.workspaces.list()).map(w => w.name)).toEqual(["pricing page"]);
  });

  it("a child workspace measures against the branch its parent was on at the fork, whatever the parent does after", async () => {
    let head = "pricing-page";
    const daemon = fakeDaemon({
      "git.status": () => ({ id: 1, ok: true, branch: { oid: "abc", head, upstream: `origin/${head}`, ahead: 0, behind: 0 }, entries: [], root: "/root/stub-1" }) as DaemonResponse,
      "git.startOn": f => ({ id: 1, ok: true, branch: String(f["branch"]), oid: "c0ffee" }) as DaemonResponse,
    });
    const { id, projectId } = await withWorkspace(daemon, "main");
    const child = await rt!.workspaces.create({ project: projectId, golden: "snap_g", name: "pricing page copy", parent: id });
    expect(child.parentWorkspaceId).toBe(id);
    expect(child.project.id).toBe(projectId);
    // The child starts where its parent stands, not where the project does: its copy is put on that branch.
    expect(daemon.frames.filter(f => f["op"] === "git.startOn").map(f => f["branch"])).toEqual(["pricing-page"]);
    // The parent switches branches after the fork; the child's work still belongs on the branch it was cut from.
    head = "somewhere-else";
    daemon.frames.length = 0;
    await rt!.workspaces.bringBack({ workspaceId: child.id });
    expect(daemon.frames.filter(f => f["op"] !== "git.status").map(f => f["base"])).toEqual(["pricing-page", "pricing-page"]);
  });

  it("a refusal from the push is the caller's error, and nothing is asked about a pull request after it", async () => {
    const daemon = fakeDaemon({ "git.push": () => ({ id: 1, ok: false, error: onBaseRefusal("main") }) });
    const { id } = await withWorkspace(daemon, "main");
    await expect(rt!.workspaces.bringBack({ workspaceId: id })).rejects.toThrow(onBaseRefusal("main"));
    expect(daemon.frames.map(f => f["op"])).toEqual(["git.push"]);
    // The dial is closed however the work ends, so a refusal leaves no socket on the machine.
    expect(daemon.closed).toBe(1);
  });

  it("a machine with no command line for the git host still pushes, and the sentence comes back as the note", async () => {
    const note = noHostCliLine("github.com");
    const daemon = fakeDaemon({ "git.pr": () => ({ id: 1, ok: false, error: note, code: "no-host-cli" }) });
    const { id } = await withWorkspace(daemon, "main");
    const back = await rt!.workspaces.bringBack({ workspaceId: id });
    expect(back.note).toBe(note);
    expect(back.pr).toBeUndefined();
    expect(back.branch).toBe("pricing-page");
    expect(back.ahead).toBe(2);
  });

  it("any other refusal of the pull request comes back beside the push, since the branch has landed by then", async () => {
    const said = "gh said: could not create pull request";
    const daemon = fakeDaemon({ "git.pr": () => ({ id: 1, ok: false, error: said }) });
    const { id } = await withWorkspace(daemon, "main");
    const back = await rt!.workspaces.bringBack({ workspaceId: id });
    expect(back.refused).toBe(said);
    expect(back.note).toBeUndefined();
    expect(back.pr).toBeUndefined();
    // The push's own fields are the answer's first half, whatever the pull request half then said.
    expect({ branch: back.branch, base: back.base, ahead: back.ahead, uncommitted: back.uncommitted, stat: back.stat }).toEqual({
      branch: "pricing-page",
      base: "main",
      ahead: 2,
      uncommitted: 1,
      stat: [" src/page.tsx | 4 ++--"],
    });
  });

  it("a push refused for want of a credential is the whole verb's refusal, since nothing landed", async () => {
    const said = noGitCredentialLine("github.com", "sign gh in on it with gh auth login, then gh auth setup-git");
    const daemon = fakeDaemon({ "git.push": () => ({ id: 1, ok: false, error: said }) });
    const { id } = await withWorkspace(daemon, "main");
    await expect(rt!.workspaces.bringBack({ workspaceId: id })).rejects.toThrow(said);
    expect(daemon.frames.map(f => f["op"])).toEqual(["git.push"]);
  });
});
