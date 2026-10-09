// SPDX-License-Identifier: AGPL-3.0-only
// A thread on a computer the person joined runs in the project's folder there,
// as a thread on the computer they sit at does: nothing is made for it, the add
// clones into the home of the login the computer was joined with, and a turn
// runs on the computer itself as that login. The computer is a fake on the
// link, answering the frames the host sends it and keeping every one.
import { describe, expect, it } from "vitest";
import { cgroupJoinLine, childOnAnotherComputerLine, claudeMemoryDir, claudeProjectKey, HERE_PLACE_ID, placeLoginNotRootLine, placeOwnedPaths, rootsPathIn, threadCgroup, type AsideQuestion, type ThreadScope, type TurnResult } from "@wsp/protocol";
import type { HarnessAdapterFactory, HarnessStartOptions } from "../src/runtime.js";
import type { ServersActs } from "../src/agents-read.js";
import { freeFolderScript, projectLanding } from "../src/project-landing.js";
import { placeHomeRefusal } from "../src/places.js";
import { memoryStore, type Store } from "../src/store.js";
import { ctx, sockets, relink, serving } from "./places-fixture.js";
import { until } from "./until.js";
import { report } from "./place-join.js";
import { answering, asThread, box, handedLine, HETZNER, joined, pickGitHub, type Box, type Started } from "./box-fixture.js";

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

  it("goes with its computer in one remove, the threads in its folder with it and the folder left as it is", async () => {
    const starts: Started[] = [];
    const { rt, placeId, project, seen } = await joined({ adapters: { claude: answering(starts) } });
    const at = await rt.workspaces.folderFor({ project: project.id });
    await (await rt.sessions.start(at.workspace.id, { prompt: "hello", harness: "claude" })).finished;
    // A folder there is the project's, so its thread counts on the project's row and nothing reads as a fork.
    const holds = { forks: [], projects: [{ name: "spoo-ts", threads: 1 }] };
    expect(await rt.places!.holds(placeId)).toEqual({ ...holds, unsaved: [] });
    expect(await rt.places!.remove(placeId)).toMatchObject({ removed: true, took: holds });
    expect(seen.ops).toContain("place.leave");
    expect((await rt.workspaces.list()).map(w => w.id)).not.toContain(at.workspace.id);
    expect(await rt.projects.list()).toEqual([]);
    expect(seen.execs.filter(e => handedLine(e.cmd).includes("rm -rf") && e.cmd.includes("/root/spoo-ts"))).toEqual([]);
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

  it("runs a turn on the computer itself with the login's home, through the link's exec, in its thread's cgroup outside the daemon's unit, and Stop ends its whole process group", async () => {
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
    // A restart of that computer's daemon takes every process in its unit's cgroup, setsid or not, so the launch
    // stands itself in the thread's own cgroup, outside that unit, before the run's setsid.
    expect(launch.cmd.startsWith(`${cgroupJoinLine(threadCgroup(run.view().threadId!))}\n`)).toBe(true);
    expect(launch.cmd).not.toContain("systemd-run");
    // The wsp that computer's daemon writes for its threads goes in front of the login's own PATH for the turn,
    // before the run starts.
    const pathAt = launch.cmd.indexOf(`export PATH='/root/.wsp/place-bin':"$PATH"; `);
    expect(pathAt).toBeGreaterThan(0);
    expect(launch.cmd.indexOf(`setsid bash '${launched[0]}'.sh`)).toBeGreaterThan(pathAt);
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

/** The GitHub pick that computer was set up with, and the row its setup left, as a setup writes them. */
/** A turn there run to its end, and a terminal opened in the same thread: the environment each started under. */
async function turnAndTerminal(rt: Awaited<ReturnType<typeof joined>>["rt"], project: { id: string }, seen: Box, starts: { env: Readonly<Record<string, string>> }[]) {
  const at = await rt.workspaces.folderFor({ project: project.id });
  await (await rt.sessions.start(at.workspace.id, { prompt: "hello", harness: "claude" })).finished;
  const channel = await rt.workspaces.daemonChannel(at.workspace.id, () => {});
  await channel.send({ op: "pty.create", cols: 80, rows: 24 } as never);
  channel.close();
  const pty = seen.frames.filter(f => f["op"] === "pty.create").at(-1)!;
  return { agent: starts.at(-1)!.env, terminal: pty["env"] as Record<string, string>, cwd: pty["cwd"] };
}

describe("the sign-ins a thread on a computer you joined reads", () => {
  const vault = (): Record<string, string> => ({ GH_TOKEN: "ghp_vault_TESTONLY", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake", OPENAI_API_KEY: "sk-openai-fake", LINEAR_TOKEN: "lin_TESTONLY" });

  it("are one set: GitHub picked from the vault signs in gh in the agent's turn and in the terminal alike, with what the person set for the agent there", async () => {
    const starts: { o: HarnessStartOptions; env: Readonly<Record<string, string>> }[] = [];
    const store = memoryStore();
    const { rt, project, seen, placeId } = await joined({ adapters: { claude: answering(starts) }, vault: vault(), store });
    await pickGitHub(store, placeId, "vault");
    // Written before the agent's row is read back, which this host, with no agents reader, refuses.
    await rt.agents.setup(placeId, "claude", { env: { ANTHROPIC_BASE_URL: "https://proxy.example" } }).catch(() => undefined);
    const { agent, terminal, cwd } = await turnAndTerminal(rt, project, seen, starts);
    expect(cwd).toBe("/root/spoo-ts");
    expect(terminal["HOME"]).toBe("/root");
    for (const [name, value] of Object.entries(terminal)) expect([name, agent[name]]).toEqual([name, value]);
    // What the turn carries beyond the terminal is only wsp's own, for that one turn.
    expect(Object.keys(agent).filter(name => !(name in terminal) && !name.startsWith("WSP_"))).toEqual([]);
    expect(terminal["GH_TOKEN"]).toBe("ghp_vault_TESTONLY");
    expect(terminal["ANTHROPIC_BASE_URL"]).toBe("https://proxy.example");
    expect(terminal["CLAUDE_CONFIG_DIR"]).toBe(agent["CLAUDE_CONFIG_DIR"]);
    expect(terminal["CODEX_HOME"]).toBeDefined();
    expect(terminal["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-ant-oat-fake");
    // A server's value rides neither: the launch hands it to the server alone.
    expect(agent["LINEAR_TOKEN"]).toBeUndefined();
    expect(terminal["LINEAR_TOKEN"]).toBeUndefined();
  });

  for (const signin of ["skip", "machine"] as const) {
    it(`leave the vault's GitHub token out of both where GitHub was picked as ${signin} there`, async () => {
      const starts: { o: HarnessStartOptions; env: Readonly<Record<string, string>> }[] = [];
      const store = memoryStore();
      const { rt, project, seen, placeId } = await joined({ adapters: { claude: answering(starts) }, vault: vault(), store });
      await pickGitHub(store, placeId, signin);
      const { agent, terminal } = await turnAndTerminal(rt, project, seen, starts);
      expect(agent["GH_TOKEN"]).toBeUndefined();
      expect(terminal["GH_TOKEN"]).toBeUndefined();
    });
  }
});

/** Every text the commands carried, base64 pieces read back, so a value that rode one is found however it went. */
const commandsCarry = (seen: Box, value: string): boolean =>
  seen.execs.some(e => e.cmd.includes(value) || [...e.cmd.matchAll(/[A-Za-z0-9+/=]{24,}/g)].some(([b]) => Buffer.from(b, "base64").toString("utf8").includes(value)));

/** The NUL-ended NAME=value pairs a launch's input carried. */
const inputOf = (stdin: string): Record<string, string> => Object.fromEntries(stdin.split("\0").filter(Boolean).map(kv => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));

describe("the MCP servers a thread on a computer you joined starts", () => {
  /** The agent's real adapter, its launch held running until the test stops it. */
  async function launchOn(agent: "claude" | "codex", configs: Record<string, string>, vault: Record<string, string>) {
    const { HARNESS_ADAPTERS } = await import("../src/adapters.js");
    const { rt, project, seen } = await joined({ adapters: { [agent]: HARNESS_ADAPTERS[agent] }, vault });
    for (const [path, text] of Object.entries(configs)) seen.configs.set(path, text);
    const at = await rt.workspaces.folderFor({ project: project.id });
    const run = await rt.sessions.start(at.workspace.id, { prompt: "hello", harness: agent });
    await expect.poll(() => seen.execs.some(e => e.cmd.includes("WSP_LAUNCHED")), { timeout: 10_000 }).toBe(true);
    const launch = seen.execs.find(e => e.cmd.includes("WSP_LAUNCHED"))!;
    await rt.sessions.interrupt(run.view().id);
    await run.finished.catch(() => undefined);
    return { launch, seen, rt, at };
  }

  it("hands Claude Code each server's value in a file of the run's, landed off the launch's input, never on a command line or in the agent's environment", async () => {
    const user = JSON.stringify({
      mcpServers: { tracker: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_TOKEN:-}" }, oauth: { clientId: "abc", callbackPort: 8080 } }, mine: { command: "mine-mcp", env: { X: "${NOT_HELD}" } } },
    });
    const { launch, seen } = await launchOn("claude", { "/root/.claude-cfg/.claude.json": user }, { LINEAR_TOKEN: "lin_TESTONLY", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake" });
    const input = inputOf(launch.stdin);
    const held = Object.entries(input).filter(([, value]) => value.includes("lin_TESTONLY"));
    expect(held.map(([name]) => name)).toEqual(["WSP_LAND_0"]);
    expect(JSON.parse(input["WSP_LAND_0"]!)).toEqual({ mcpServers: { tracker: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_TESTONLY" }, oauth: { clientId: "abc", callbackPort: 8080 } } } });
    // The file is written under the run's own mask, the variable dropped before the run starts, and the CLI handed its path.
    const after = launch.cmd.slice(launch.cmd.indexOf("while IFS="));
    expect(after.indexOf("unset WSP_LAND_0")).toBeGreaterThan(after.indexOf("WSP_LAND_0\" > "));
    expect(after.indexOf("unset WSP_LAND_0")).toBeLessThan(after.indexOf("setsid"));
    expect(launch.cmd.indexOf("umask 077")).toBeLessThan(launch.cmd.indexOf("WSP_LAND_0"));
    expect(after).toMatch(/export WSP_MCP_VALUES=\S+\.f0/);
    expect(commandsCarry(seen, "--mcp-config \"$WSP_MCP_VALUES\"")).toBe(true);
    expect(commandsCarry(seen, "lin_TESTONLY")).toBe(false);
    expect(Object.keys(input).filter(name => name !== "WSP_LAND_0" && input[name]!.includes("lin_TESTONLY"))).toEqual([]);
    // The reap takes every file of the run, the servers' with them.
    expect(seen.execs.some(e => e.cmd.includes(".*") && e.cmd.includes("rm -rf"))).toBe(true);
  });

  it("hands Codex each server's value in its thread's start, the seed landed off the launch's input, every key of the entry its own", async () => {
    const user = ['[mcp_servers.notion]', 'command = "npx"', 'env_vars = ["NOTION_TOKEN"]', 'disabled_tools = ["delete_page"]', ""].join("\n");
    const { launch, seen } = await launchOn("codex", { "/root/.codex/config.toml": user }, { NOTION_TOKEN: "ntn_TESTONLY", OPENAI_API_KEY: "sk-openai-fake" });
    const input = inputOf(launch.stdin);
    const start = input["WSP_LAND_IN"]!.split("\n").map(l => (l === "" ? undefined : (JSON.parse(l) as { method?: string; params?: { config?: unknown } }))).find(m => m?.method === "thread/start");
    expect(start?.params?.config).toEqual({ "mcp_servers.notion.env.NOTION_TOKEN": "ntn_TESTONLY" });
    expect(commandsCarry(seen, "ntn_TESTONLY")).toBe(false);
    expect(Object.keys(input).filter(name => name !== "WSP_LAND_IN" && input[name]!.includes("ntn_TESTONLY"))).toEqual([]);
    expect(launch.cmd).toContain("unset WSP_LAND_IN");
  });

  const TRACKER = JSON.stringify({
    primaryApiKey: "sk-ant-api03-PERSONS-OWN-TESTONLY",
    mcpServers: { tracker: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_TOKEN}" } } },
  });
  const VALUED = { LINEAR_TOKEN: "lin_TESTONLY", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake" };

  /** The words a turn ended on, whether its start refused or its run failed. */
  async function failureOf(started: Promise<{ finished: Promise<TurnResult> }>): Promise<string> {
    try {
      const result = await (await started).finished;
      return result.status === "failed" ? (result.error ?? "it failed with no words") : `it ${result.status}`;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /** Every piece of the text, as written and base64 read back, so a config that travelled encoded is found. */
  const readsAs = (text: string): string => [text, ...[...text.matchAll(/[A-Za-z0-9+/=]{16,}/g)].map(([b]) => Buffer.from(b, "base64").toString("utf8"))].join("\n");

  it("fails a turn whose servers' config read exits non-zero in a sentence holding no line of that config", async () => {
    const { HARNESS_ADAPTERS } = await import("../src/adapters.js");
    const { rt, project, seen } = await joined({ adapters: { claude: HARNESS_ADAPTERS.claude }, vault: VALUED });
    seen.configs.set("/root/.claude-cfg/.claude.json", TRACKER);
    seen.readAs = stdout => ({ stdout, exitCode: 124 });
    const at = await rt.workspaces.folderFor({ project: project.id });
    const said = await failureOf(rt.sessions.start(at.workspace.id, { prompt: "hello", harness: "claude" }));
    expect(said).toMatch(/^Claude Code's MCP servers on that computer could not be read/);
    expect(readsAs(said)).not.toContain("PERSONS-OWN");
    expect(readsAs(said)).not.toContain("mcp.linear.app");
    expect(seen.execs.some(e => e.cmd.includes("WSP_LAUNCHED"))).toBe(false);
  });

  it("fails a turn whose servers' config read came back cut, rather than starting it as if that config held no servers", async () => {
    const { HARNESS_ADAPTERS } = await import("../src/adapters.js");
    const { rt, project, seen } = await joined({ adapters: { claude: HARNESS_ADAPTERS.claude }, vault: VALUED });
    seen.configs.set("/root/.claude-cfg/.claude.json", TRACKER);
    // What the computer's exec cap leaves of a read past it: the start of the first file's line and nothing after.
    seen.readAs = stdout => ({ stdout: stdout.slice(0, 60), exitCode: 0 });
    const at = await rt.workspaces.folderFor({ project: project.id });
    const said = await failureOf(rt.sessions.start(at.workspace.id, { prompt: "hello", harness: "claude" }));
    expect(said).toMatch(/^Claude Code's MCP servers on that computer could not be read whole/);
    expect(readsAs(said)).not.toContain("PERSONS-OWN");
    expect(seen.execs.some(e => e.cmd.includes("WSP_LAUNCHED"))).toBe(false);
  });

  it("hands Claude Code's side question there the values a turn of its thread is handed", async () => {
    const SESSION = "44444444-4444-4444-8444-444444444444";
    const starts: HarnessStartOptions[] = [];
    const asked: AsideQuestion[] = [];
    const claude: HarnessAdapterFactory = () => ({
      steers: false,
      mcpServers: true,
      asideServers: true,
      start: o => {
        starts.push(o);
        const result: TurnResult = { status: "completed", text: "ok" };
        o.onEvent({ type: "session.start", sessionId: SESSION, cwd: "/root/spoo-ts" });
        o.onEvent({ type: "turn.done", sessionId: SESSION, result });
        o.onEvent({ type: "session.end", sessionId: SESSION, exitCode: 0, sawResult: true });
        return { localId: SESSION, finished: Promise.resolve(result), interrupt: async () => {} };
      },
      aside: async q => {
        asked.push(q);
        return { text: "you asked hello" };
      },
    });
    const { rt, project, seen } = await joined({ adapters: { claude }, vault: VALUED });
    seen.configs.set("/root/.claude-cfg/.claude.json", TRACKER);
    const at = await rt.workspaces.folderFor({ project: project.id });
    const run = await rt.sessions.start(at.workspace.id, { prompt: "hello", harness: "claude" });
    await run.finished;
    expect(starts[0]!.serverValues).toEqual({ entries: { tracker: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_TESTONLY" } } } });
    expect(await rt.sessions.aside(run.view().id, "what did I ask?")).toEqual({ text: "you asked hello" });
    expect(asked[0]!.serverValues).toEqual(starts[0]!.serverValues);
  });

  for (const from of ["thread", "page"] as const) {
    it(`hands a server added from the computer's ${from} to the next turn's Claude Code, from the config under the store that turn reads`, async () => {
      const vault: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake" };
      let box: Box | undefined;
      const handed: (string | undefined)[] = [];
      // The host's acts as they run there: the server by name into the agent's own file under the store it is handed,
      // the catalog's ~/.claude.json without one, and its value into the vault.
      const serversActs: ServersActs = {
        add: async (on, ask) => {
          if (on.kind === "here") throw new Error("not this computer");
          expect((await on.machine.exec("echo reached", {})).exitCode).toBe(0);
          handed.push(on.stores?.["claude"]);
          const file = `${on.stores?.["claude"] ?? "/root"}/.claude.json`;
          box!.configs.set(file, JSON.stringify({ mcpServers: { [ask.name]: { command: ask.command, args: [], env: { ACME_TOKEN: "${ACME_TOKEN}" } } } }));
          Object.assign(vault, ask.env);
          return { file };
        },
        remove: async () => ({ file: "" }),
        toggle: async () => ({ file: "" }),
      };
      const { HARNESS_ADAPTERS } = await import("../src/adapters.js");
      const { rt, project, seen, placeId } = await joined({ adapters: { claude: HARNESS_ADAPTERS.claude }, vault, serversActs });
      box = seen;
      const at = await rt.workspaces.folderFor({ project: project.id });
      await rt.agents.serversAdd(from === "thread" ? { workspaceId: at.workspace.id } : { placeId }, { agent: "claude", name: "acme", command: "acme-mcp", env: { ACME_TOKEN: "sk_acme_TESTONLY" } });
      const run = await rt.sessions.start(at.workspace.id, { prompt: "hello", harness: "claude" });
      await expect.poll(() => seen.execs.some(e => e.cmd.includes("WSP_LAUNCHED")), { timeout: 10_000 }).toBe(true);
      const launch = seen.execs.find(e => e.cmd.includes("WSP_LAUNCHED"))!;
      await rt.sessions.interrupt(run.view().id);
      await run.finished.catch(() => undefined);
      expect(handed).toEqual([inputOf(launch.stdin)["CLAUDE_CONFIG_DIR"]]);
      expect(JSON.parse(inputOf(launch.stdin)["WSP_LAND_0"]!)).toEqual({ mcpServers: { acme: { command: "acme-mcp", args: [], env: { ACME_TOKEN: "sk_acme_TESTONLY" } } } });
      expect(commandsCarry(seen, "sk_acme_TESTONLY")).toBe(false);
    });

    it(`hands a server added from the computer's ${from} to the next turn's Codex, from config.toml under the box's logins folder that turn's CODEX_HOME names`, async () => {
      const vault: Record<string, string> = { OPENAI_API_KEY: "sk-openai-fake" };
      let box: Box | undefined;
      const handed: (string | undefined)[] = [];
      // The host's acts as they run there: the server by name into config.toml under the store it is handed, and its
      // value into the vault.
      const serversActs: ServersActs = {
        add: async (on, ask) => {
          if (on.kind === "here") throw new Error("not this computer");
          handed.push(on.stores?.["codex"]);
          const file = `${on.stores?.["codex"] ?? "/root/.codex"}/config.toml`;
          box!.configs.set(file, [`[mcp_servers.${ask.name}]`, `command = "${ask.command}"`, 'env_vars = ["ACME_TOKEN"]', ""].join("\n"));
          Object.assign(vault, ask.env);
          return { file };
        },
        remove: async () => ({ file: "" }),
        toggle: async () => ({ file: "" }),
      };
      const { HARNESS_ADAPTERS } = await import("../src/adapters.js");
      const { rt, project, seen, placeId } = await joined({ adapters: { codex: HARNESS_ADAPTERS.codex }, vault, serversActs, logins: "/var/lib/wsp/logins" });
      box = seen;
      const at = await rt.workspaces.folderFor({ project: project.id });
      await rt.agents.serversAdd(from === "thread" ? { workspaceId: at.workspace.id } : { placeId }, { agent: "codex", name: "acme", command: "acme-mcp", env: { ACME_TOKEN: "sk_acme_TESTONLY" } });
      const run = await rt.sessions.start(at.workspace.id, { prompt: "hello", harness: "codex" });
      await expect.poll(() => seen.execs.some(e => e.cmd.includes("WSP_LAUNCHED")), { timeout: 10_000 }).toBe(true);
      const launch = seen.execs.find(e => e.cmd.includes("WSP_LAUNCHED"))!;
      await rt.sessions.interrupt(run.view().id);
      await run.finished.catch(() => undefined);
      const input = inputOf(launch.stdin);
      expect(handed).toEqual(["/var/lib/wsp/logins/codex"]);
      expect(input["CODEX_HOME"]).toBe("/var/lib/wsp/logins/codex");
      const start = input["WSP_LAND_IN"]!.split("\n").map(l => (l === "" ? undefined : (JSON.parse(l) as { method?: string; params?: { config?: unknown } }))).find(m => m?.method === "thread/start");
      expect(start?.params?.config).toEqual({ "mcp_servers.acme.env.ACME_TOKEN": "sk_acme_TESTONLY" });
      expect(commandsCarry(seen, "sk_acme_TESTONLY")).toBe(false);
    });
  }
});

describe("what a computer you joined holds back of a thread in a folder on it", () => {
  it("clones a private repo with the vault's GitHub token on the clone's own input and nowhere in its command, where GitHub was set up from the vault", async () => {
    const { seen } = await joined({ vault: { GH_TOKEN: "ghp_private_fake", OPENAI_API_KEY: "sk-other-fake" }, github: "vault" });
    const clone = seen.execs.find(e => e.cmd.includes("git clone"))!;
    expect(clone.stdin).toContain("GH_TOKEN=ghp_private_fake\0");
    expect(clone.stdin).not.toContain("sk-other-fake");
    expect(seen.execs.map(e => e.cmd).join("\n")).not.toContain("ghp_private_fake");
    expect(clone.cmd).not.toContain("setup-git");
  });

  for (const github of ["skip", "machine", undefined] as const) {
    it(`clones with none of the vault's GitHub token where GitHub was ${github === undefined ? "never set up" : `set up as ${github}`} there, as its turns get none`, async () => {
      const { seen } = await joined({ vault: { GH_TOKEN: "ghp_private_fake" }, ...(github !== undefined ? { github } : {}) });
      const clone = seen.execs.find(e => e.cmd.includes("git clone"))!;
      expect(`${clone.stdin ?? ""}\n${seen.execs.map(e => e.cmd).join("\n")}`).not.toContain("ghp_private_fake");
    });
  }

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

  it("writes the install's log under a path a leave takes, so a leave leaves nothing of the landing's in wsp's folder", async () => {
    const ran: string[] = [];
    const answer = (cmd: string): string => (cmd.includes("mkdir '/root/spoo-ts'") ? "/root/spoo-ts\n" : cmd.startsWith("ls -A") ? "package-lock.json\n" : "");
    const machine = { id: "p", exec: async (cmd: string) => (ran.push(cmd), { exitCode: 0, stdout: answer(cmd), stderr: "" }) } as unknown as import("@wsp/engine").Machine;
    const deps = { computer: { machine, home: "/root" }, computerName: "hetzner", now: () => 0 } as unknown as import("../src/project-landing.js").LandingDeps;
    const source = { kind: "git" as const, url: "https://github.com/acme/lab.git" };
    const project = { id: "pr_1", name: "spoo-ts", computer: "p", source, path: "", remote: "https://github.com/acme/lab.git", defaultBranch: "main", memoryKey: "", memoryDir: "", createdAt: "" };
    await projectLanding("box").land({ project, source: { cloneCommand: () => "git clone" } as never, report: () => {} }, deps);
    const log = /npm ci >> '([^']+)' 2>&1/.exec(ran.join("\n"))?.[1];
    expect(log, ran.join("\n")).toBeDefined();
    expect(placeOwnedPaths("/root").some(row => log!.startsWith(`${row}/`)), log).toBe(true);
  });

  it("claims the first free name in the home in one command", () => {
    const script = freeFolderScript("/root", "spoo-ts");
    expect(script).toContain(`mkdir '/root/spoo-ts'"$n"`);
    expect(script).toContain("-2");
  });
});
