// SPDX-License-Identifier: AGPL-3.0-only
// A thread on a computer the person joined runs in the project's folder there,
// as a thread on the computer they sit at does: nothing is made for it, the add
// clones into the home of the login the computer was joined with, and a turn
// runs on the computer itself as that login. The computer is a fake on the
// link, answering the frames the host sends it and keeping every one.
import { describe, expect, it } from "vitest";
import { childOnAnotherComputerLine, claudeMemoryDir, claudeProjectKey, HERE_PLACE_ID, placeLoginNotRootLine, rootsPathIn, type ThreadScope, type TurnResult } from "@wsp/protocol";
import type { HarnessAdapterFactory } from "../src/runtime.js";
import { freeFolderScript, projectLanding } from "../src/project-landing.js";
import { placeHomeRefusal } from "../src/places.js";
import { memoryStore } from "../src/store.js";
import { ctx, sockets, relink, serving } from "./places-fixture.js";
import { until } from "./until.js";
import { report } from "./place-join.js";
import { answering, asThread, box, handedLine, HETZNER, joined, type Started } from "./box-fixture.js";

/** A harness whose turn is a real launch on the computer, read until it is stopped. */
function launching(launched: string[]): HarnessAdapterFactory {
  return hctx => ({
    steers: false,
    start: o => {
      const stream = hctx.execStream("claude -p hi", { env: { ...hctx.env } });
      launched.push(stream.run ?? "");
      const finished = stream.exited.then((): TurnResult => ({ status: "interrupted" }));
      void (async () => {
        for await (const _ of stream.lines);
      })();
      o.onEvent({ type: "session.start", sessionId: "s1" });
      return { localId: "s1", finished, interrupt: async () => stream.teardown() };
    },
  });
}

/** The variables a launch's input carries, by name. */
const envOf = (stdin: string): Record<string, string> =>
  Object.fromEntries(stdin.split("\0").filter(kv => kv.includes("=")).map(kv => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));

describe("a thread on a project of a computer the person joined", () => {
  it("runs in the project's folder there: two starts that both say hello open in that folder, and nothing is made", async () => {
    const starts: Started[] = [];
    const { rt, project, seen } = await joined({ adapters: { claude: answering(starts) } });
    expect(project.path).toBe("/root/spoo-ts");
    // The app's road: a create named off the message, then a start on what it answered, twice with the same words.
    const first = await rt.workspaces.create({ project: project.id, name: "hello" });
    const second = await rt.workspaces.create({ project: project.id, name: "hello" });
    expect(second.id).toBe(first.id);
    expect(first.kind).toBe("place");
    for (const ws of [first, second]) await (await rt.sessions.start(ws.id, { prompt: "hello", harness: "claude" })).finished;
    expect(starts.map(s => s.o.cwd)).toEqual(["/root/spoo-ts", "/root/spoo-ts"]);
    expect(seen.ops).not.toContain("machine.create");
  });

  it("never reaches the container create on a start by project, as the command line sends one", async () => {
    const starts: Started[] = [];
    const { rt, project, seen } = await joined({ adapters: { claude: answering(starts) } });
    const at = await rt.workspaces.folderFor({ project: project.id });
    expect(at.workspace.folder ?? at.workspace.project.path).toBe("/root/spoo-ts");
    await (await rt.sessions.start(at.workspace.id, { prompt: "hello", harness: "claude" })).finished;
    expect(seen.ops.filter(op => op.startsWith("machine.") && op !== "machine.backend" && op !== "machine.capacity")).toEqual([]);
  });

  it("is added into the home of the login the computer was joined with, -2 on a clash, its memory keyed to that folder and the folder in the daemon's roots", async () => {
    const { rt, project, seen } = await joined({ taken: ["/root/spoo-ts"] });
    expect(project.path).toBe("/root/spoo-ts-2");
    expect(project.memoryKey).toBe(claudeProjectKey("/root/spoo-ts-2"));
    expect(project.memoryDir).toBe(claudeMemoryDir("/root/.claude-cfg", claudeProjectKey("/root/spoo-ts-2")));
    expect(project.git).toEqual({ top: "/root/spoo-ts-2" });
    // The clone ran as the login, in its home, onto the folder the claim took.
    const clone = seen.execs.find(e => e.cmd.includes("git clone"))!;
    expect(clone.cmd).toContain("export HOME='/root'");
    expect(clone.cmd).toContain("/root/spoo-ts-2");
    expect(seen.ops).not.toContain("machine.create");
    // The first thread's folder is written into the file that computer's daemon reads, by the daemon itself.
    await rt.workspaces.folderFor({ project: project.id });
    const roots = seen.execs.filter(e => e.cmd.includes(rootsPathIn("/root")));
    expect(roots.at(-1)?.cmd).toContain("'/root/spoo-ts-2'");
    expect(roots.at(-1)?.cmd).not.toContain("runuser");
  });

  it("runs a turn on the computer itself with the login's home, through the link's exec, in a scope of its own outside the daemon's unit, and Stop ends its whole process group", async () => {
    const launched: string[] = [];
    const { rt, project, seen } = await joined({ adapters: { claude: launching(launched) } });
    const at = await rt.workspaces.folderFor({ project: project.id });
    const run = await rt.sessions.start(at.workspace.id, { prompt: "hi", harness: "claude" });
    await expect.poll(() => seen.execs.some(e => e.cmd.includes("WSP_LAUNCHED"))).toBe(true);
    const launch = seen.execs.find(e => e.cmd.includes("WSP_LAUNCHED"))!;
    // The launch is the daemon's own exec frame, under wsp's folder in the login's home, with that home in the
    // environment the run starts under.
    expect(launched[0]).toMatch(/^\/root\/\.wsp\/run\/[0-9a-f]+$/);
    expect(envOf(launch.stdin)["HOME"]).toBe("/root");
    // A restart of that computer's daemon takes every process in its unit's cgroup, setsid or not, so the run's
    // setsid starts in a scope named for the run under wsp.slice.
    const unit = `wsp-run-${launched[0]!.slice(launched[0]!.lastIndexOf("/") + 1)}.scope`;
    expect(launch.cmd).toContain(`systemd-run --scope --quiet --collect --slice=wsp.slice --unit='${unit}' -- setsid bash '${launched[0]}'.sh`);
    await rt.sessions.interrupt(run.view().id);
    await expect.poll(() => seen.kills.length).toBeGreaterThan(0);
    expect(seen.kills[0]).toContain("kill -TERM -- -$P");
    await run.finished;
    expect(seen.ops).not.toContain("machine.create");
    expect(seen.ops).not.toContain("machine.exec");
  });

  it("runs a turn on the PATH the login's own login shell gives it, the PATH the add cloned under, and no fixed list of root's folders", async () => {
    const launched: string[] = [];
    const shellPath = "/root/.opencode/bin:/snap/bin:/usr/local/bin:/usr/bin:/bin";
    const { rt, project, seen } = await joined({ login: { ...HETZNER, shellPath }, adapters: { claude: launching(launched) } });
    const clone = seen.execs.find(e => e.cmd.includes("git clone"))!;
    expect(clone.cmd).toContain(`PATH='${shellPath}'`);
    const at = await rt.workspaces.folderFor({ project: project.id });
    const run = await rt.sessions.start(at.workspace.id, { prompt: "hi", harness: "claude" });
    await expect.poll(() => seen.execs.some(e => e.cmd.includes("WSP_LAUNCHED"))).toBe(true);
    const launch = seen.execs.find(e => e.cmd.includes("WSP_LAUNCHED"))!;
    expect(launch.cmd).toContain(`PATH='${shellPath}'`);
    // Nothing in the run's own environment sets the PATH again over the login's.
    expect(envOf(launch.stdin)["PATH"]).toBeUndefined();
    // Claude Code takes --dangerously-skip-permissions as root only with it, and a box thread runs as root.
    expect(envOf(launch.stdin)["IS_SANDBOX"]).toBe("1");
    // The login shell is read once for the computer, not once a command.
    expect(seen.execs.filter(e => handedLine(e.cmd).includes("-ilc"))).toHaveLength(1);
    await rt.sessions.interrupt(run.view().id);
    await run.finished;
  });

  it("refuses a thread on a computer joined with a login that is not root, in one sentence with its fix, before its git or its roots file is touched", async () => {
    const starts: Started[] = [];
    const { rt, project, seen } = await joined({ login: { home: "/home/maya", owner: "maya" }, adapters: { claude: answering(starts) } });
    expect(project.path).toBe("/home/maya/spoo-ts");
    const refusal = placeLoginNotRootLine("hetzner", "maya");
    await expect(rt.workspaces.create({ project: project.id, name: "hello" })).rejects.toThrow(refusal);
    await expect(rt.workspaces.folderFor({ project: project.id })).rejects.toThrow(refusal);
    expect(await rt.workspaces.list()).toEqual([]);
    expect(seen.execs.filter(e => e.cmd.includes(rootsPathIn("/home/maya")))).toEqual([]);
    expect(seen.frames.filter(f => String(f["op"]).startsWith("git."))).toEqual([]);
    expect(starts).toEqual([]);
  });

  it("starts a run that names no project beside the thread asking, in the same folder on the same computer", async () => {
    const starts: Started[] = [];
    const { rt, project } = await joined({ adapters: { claude: answering(starts) } });
    const home = await rt.workspaces.folderFor({ project: project.id });
    const lead = await rt.sessions.start(home.workspace.id, { prompt: "lead", harness: "claude" });
    await lead.finished;
    const threadId = lead.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId, workspaceId: home.workspace.id, rootThreadId: threadId };
    const beside = await rt.workspaces.folderFor({}, asThread(scope));
    expect(beside.workspace.id).toBe(home.workspace.id);
    await (await rt.sessions.start(beside.workspace.id, { prompt: "child", harness: "claude" }, asThread(scope))).finished;
    expect(starts.at(-1)?.o.cwd).toBe("/root/spoo-ts");
  });

  it("refuses a thread there naming a project on the computer the app runs on, in one sentence with its fix", async () => {
    const starts: Started[] = [];
    const store = memoryStore();
    // The same repo added on the computer the app runs on, as a folder there.
    await store.put("projects", "pr_mac", { id: "pr_mac", name: "spoo-mac", computer: HERE_PLACE_ID, source: { kind: "folder", path: "/Users/dev/spoo-ts" }, path: "/Users/dev/spoo-ts", remote: "https://github.com/spoo-me/spoo-ts", defaultBranch: "main", memoryKey: "-Users-dev-spoo-ts", memoryDir: "/Users/dev/.claude/projects/-Users-dev-spoo-ts/memory", createdAt: "2026-10-07T00:00:00.000Z" });
    const { rt, project } = await joined({ adapters: { claude: answering(starts) }, store });
    const home = await rt.workspaces.folderFor({ project: project.id });
    const lead = await rt.sessions.start(home.workspace.id, { prompt: "lead", harness: "claude" });
    await lead.finished;
    const threadId = lead.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId, workspaceId: home.workspace.id, rootThreadId: threadId };
    await expect(rt.workspaces.folderFor({ project: "spoo-mac" }, asThread(scope))).rejects.toThrow(childOnAnotherComputerLine("hetzner", "zingzys-mac"));
    expect(starts).toHaveLength(1);
  });

  it("runs a thread there naming its own project by a name a project on another computer shares, whichever was added first", async () => {
    const starts: Started[] = [];
    const store = memoryStore();
    // The same name on the computer the app runs on, added before the one on hetzner.
    await store.put("projects", "pr_mac", { id: "pr_mac", name: "spoo-ts", computer: HERE_PLACE_ID, source: { kind: "folder", path: "/Users/dev/spoo-ts" }, path: "/Users/dev/spoo-ts", remote: "https://github.com/spoo-me/spoo-ts", defaultBranch: "main", memoryKey: "-Users-dev-spoo-ts", memoryDir: "/Users/dev/.claude/projects/-Users-dev-spoo-ts/memory", createdAt: "2026-10-01T00:00:00.000Z" });
    const { rt, project } = await joined({ adapters: { claude: answering(starts) }, store });
    const home = await rt.workspaces.folderFor({ project: project.id });
    const lead = await rt.sessions.start(home.workspace.id, { prompt: "lead", harness: "claude" });
    await lead.finished;
    const threadId = lead.view().threadId!;
    const scope: ThreadScope = { kind: "thread", threadId, workspaceId: home.workspace.id, rootThreadId: threadId };
    expect((await rt.projects.resolve("spoo-ts", asThread(scope))).id).toBe(project.id);
    const named = await rt.workspaces.folderFor({ project: "spoo-ts" }, asThread(scope));
    expect(named.workspace.id).toBe(home.workspace.id);
    await (await rt.sessions.start(named.workspace.id, { prompt: "child", harness: "claude" }, asThread(scope))).finished;
    expect(starts.at(-1)?.o.cwd).toBe("/root/spoo-ts");
  });

  it("reads a computer the person joined as one whose projects are folders there, whatever its stored report carries", async () => {
    const store = memoryStore();
    const { project, placeId } = await joined({ store });
    // A host started again on a record whose report holds no HOME: the computer is still the one the person joined.
    await ctx.srv!.close();
    await ctx.runtime!.close();
    const held = (await store.get("places", placeId)) as { report: { login: Record<string, string> } };
    const { HOME: _home, ...login } = held.report.login;
    await store.put("places", placeId, { ...held, report: { ...held.report, login } });
    await serving({ store });
    // Refused for the home it lacks, as the host refuses such a report at the door, and never a machine made there.
    await expect(ctx.runtime!.workspaces.create({ project: project.id, name: "hello" })).rejects.toThrow(placeHomeRefusal(undefined));
  });
});

describe("what a computer you joined holds back of a thread in a folder on it", () => {
  it("clones a private repo with the vault's GitHub token on the clone's own input and nowhere in its command", async () => {
    const { seen } = await joined({ vault: { GH_TOKEN: "ghp_private_fake", OPENAI_API_KEY: "sk-other-fake" } });
    const clone = seen.execs.find(e => e.cmd.includes("git clone"))!;
    expect(clone.stdin).toContain("GH_TOKEN=ghp_private_fake\0");
    expect(clone.stdin).not.toContain("sk-other-fake");
    expect(seen.execs.map(e => e.cmd).join("\n")).not.toContain("ghp_private_fake");
    expect(clone.cmd).not.toContain("setup-git");
  });

  it("runs a thread there although its doctor came to say it boots no container: nothing of one is in the way", async () => {
    const starts: Started[] = [];
    const { rt, project, placeId, pair, hostKey } = await joined({ adapters: { claude: answering(starts) } });
    const blocked = report("hetzner", { login: { HOME: "/root", USER: "root", PATH: "/usr/bin" }, runsWorkspaces: false, workspacesBlocked: "this computer mounts cgroup v1 at /sys/fs/cgroup" });
    const again = await relink(hostKey, placeId, pair, blocked, c => void box(c, HETZNER));
    sockets.push(again.client.ws);
    await until(async () => (await rt.places!.list(0)).find(p => p.id === placeId)?.blocked !== undefined);
    const at = await rt.workspaces.folderFor({ project: project.id });
    await (await rt.sessions.start(at.workspace.id, { prompt: "hello", harness: "claude" })).finished;
    expect(starts.map(s => s.o.cwd)).toEqual(["/root/spoo-ts"]);
  });
});

describe("the road a project on a joined computer lands by", () => {
  it("keeps a folder already on that computer where it stands, and clones nothing into it", async () => {
    const ran: string[] = [];
    const machine = { id: "p", exec: async (cmd: string) => (ran.push(cmd), { exitCode: 0, stdout: "", stderr: "" }) } as unknown as import("@wsp/engine").Machine;
    const road = projectLanding("box");
    const deps = { computer: { machine, home: "/root" }, computerName: "hetzner", now: () => 0 } as unknown as import("../src/project-landing.js").LandingDeps;
    const source = { kind: "folder" as const, path: "/srv/legacy" };
    expect(road.path({ name: "legacy", source, deps })).toBe("/srv/legacy");
    const landed = await road.land({ project: { id: "pr_1", name: "legacy", computer: "p", source, path: "/srv/legacy", remote: "", defaultBranch: "", memoryKey: "-srv-legacy", memoryDir: "/root/.claude-cfg/projects/-srv-legacy/memory", createdAt: "" }, source: {} as never, report: () => {} }, deps);
    expect(landed).toEqual({ git: { top: "/srv/legacy" } });
    expect(ran).toEqual([]);
  });

  it("claims the first free name in the home in one command", () => {
    const script = freeFolderScript("/root", "spoo-ts");
    expect(script).toContain(`mkdir '/root/spoo-ts'"$n"`);
    expect(script).toContain("-2");
  });
});
