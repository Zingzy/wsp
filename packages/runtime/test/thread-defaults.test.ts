// SPDX-License-Identifier: AGPL-3.0-only
// What a new thread starts on when its start names nothing, read by the runtime
// on a fake backend: the agent, model and access off the project, then the
// person's defaults, then the catalog; the lists harnesses.list hands the
// composer, marked the same way; and each agent's setup on a computer, which
// reaches the launch whole and every reader as names alone.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { HERE_PLACE_ID, PLACES_TICKET_REFUSAL, markedDefault, type AgentLaunch, type TurnResult } from "@wsp/protocol";
import { createRuntime, serveRuntime, type AgentsReader, type HarnessAdapterFactory, type LocalWiring, type Runtime, type RuntimeServer } from "../src/index.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore, type Store } from "../src/store.js";
import { realFolderScript } from "../src/agent-setup.js";
import { copyingFake, createOn, stubBackend, testPlatform } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";

const SESSION = "44444444-4444-4444-8444-444444444444";

interface Launched {
  harness: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  env: Readonly<Record<string, string>>;
  home: string;
  launch?: AgentLaunch;
}

/** An adapter per harness that records what each launch was handed and ends its turn at once. */
const recorder = (harness: string, launched: Launched[]): HarnessAdapterFactory => ctx => ({
  steers: false,
  env: ctx.env,
  start: ({ onEvent, model, effort, permissionMode }) => {
    launched.push({ harness, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(permissionMode !== undefined ? { permissionMode } : {}), env: ctx.env, home: ctx.home(harness), ...(ctx.launch !== undefined ? { launch: ctx.launch } : {}) });
    const result: TurnResult = { status: "completed", text: "ok" };
    const finished = (async () => {
      onEvent({ type: "session.start", sessionId: SESSION });
      onEvent({ type: "turn.done", sessionId: SESSION, result });
      onEvent({ type: "session.end", sessionId: SESSION, exitCode: 0, sawResult: true });
      return result;
    })();
    return { localId: SESSION, finished, interrupt: async () => {} };
  },
});

const READ = { home: "/Users/ada", user: "ada", skills: [], servers: [], refused: [] };
const row = (id: string, name: string) => ({ id, name, installed: true, version: "1.0.0", road: "own" as const, signIn: "signed-in" as const, signInRoad: "device" as const, wspTools: false });
const reader: AgentsReader = { read: async () => ({ ...READ, agents: [row("claude", "Claude Code"), row("codex", "Codex")] }), tools: async () => ({ auth: "open", readAt: "2026-10-01T12:00:00.000Z" }) };

describe("what a new thread starts on", () => {
  let root: string;
  let localWiring: LocalWiring;
  let launched: Launched[];
  let store: Store;
  let rt: Runtime;
  let srv: RuntimeServer | undefined;
  const clients: WsClient[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-defaults-"));
    launched = [];
    store = memoryStore();
    localWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: id => join(root, `.${id}`),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier: copyingFake(),
    };
    rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: recorder("claude", launched), codex: recorder("codex", launched) }, local: localWiring, agentsReader: reader });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await srv?.close();
    srv = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  const run = async (workspaceId: string, o: Parameters<Runtime["sessions"]["start"]>[1]): Promise<Launched> => {
    await (await rt.sessions.start(workspaceId, o)).finished;
    return launched.at(-1)!;
  };

  it("runs the project's agent, then the default agent, then the catalog's first, and a named agent over all three", async () => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    expect((await run(ws.id, { prompt: "one" })).harness).toBe("claude");
    await rt.preferences.set({ defaultAgent: "codex" });
    expect((await run(ws.id, { prompt: "two" })).harness).toBe("codex");
    await rt.preferences.set({ projectDefaults: { [ws.project.id]: { agent: "claude" } } });
    expect((await run(ws.id, { prompt: "three" })).harness).toBe("claude");
    expect((await run(ws.id, { prompt: "four", harness: "codex" })).harness).toBe("codex");
    // The composer's lists mark the same agent, so its picker opens where a start would.
    expect((await rt.harnesses.list(ws.id)).find(c => c.isDefault === true)?.harness).toBe("claude");
  });

  it("a project whose default agent is Codex runs Codex for a start that names none, with the default agent left on Claude", async () => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await rt.preferences.set({ defaultAgent: "claude", projectDefaults: { [ws.project.id]: { agent: "codex" } } });
    expect((await run(ws.id, { prompt: "one" })).harness).toBe("codex");
    expect((await rt.projects.defaults())[ws.project.id]?.agent).toEqual({ value: "codex", from: "project" });
  });

  it("runs the project's model and access over the agent's, the agent's over the catalog's, and a named pick over all", async () => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    expect(await run(ws.id, { prompt: "one" })).toMatchObject({ model: "claude-opus-5-5", effort: "high", permissionMode: "bypassPermissions" });
    await rt.preferences.set({ agentDefaults: { claude: { model: "claude-sonnet-5", effort: "low", access: "ask" } } });
    expect(await run(ws.id, { prompt: "two" })).toMatchObject({ model: "claude-sonnet-5", effort: "low", permissionMode: "default" });
    await rt.preferences.set({ projectDefaults: { [ws.project.id]: { model: "claude-fable-5-1", access: "auto-edit" } } });
    expect(await run(ws.id, { prompt: "three" })).toMatchObject({ model: "claude-fable-5-1", effort: "low", permissionMode: "acceptEdits" });
    expect(await run(ws.id, { prompt: "four", model: "claude-haiku-4-5-20251001", access: "full" })).toMatchObject({ model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" });
    // A project's model kept for its own agent drops through on another agent rather than refusing the start.
    expect(await run(ws.id, { prompt: "five", harness: "codex" })).toMatchObject({ harness: "codex", model: "gpt-5.6-sol", permissionMode: "danger-full-access" });
  });

  it("an agent whose CLI takes any model starts on the one set for it, and a start naming another runs that one", async () => {
    const open = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: recorder("claude", launched), opencode: recorder("opencode", launched) }, local: localWiring, agentsReader: reader });
    const ws = await createOn(open, { on: HERE_PLACE_ID, name: "mac" });
    await open.preferences.set({ agentDefaults: { opencode: { model: "anthropic/claude-sonnet-5" } } });
    await (await open.sessions.start(ws.id, { prompt: "one", harness: "opencode" })).finished;
    expect(launched.at(-1)).toMatchObject({ harness: "opencode", model: "anthropic/claude-sonnet-5", permissionMode: "auto" });
    await (await open.sessions.start(ws.id, { prompt: "two", harness: "opencode", model: "openai/gpt-x" })).finished;
    expect(launched.at(-1)!.model).toBe("openai/gpt-x");
  });

  it("a hidden model leaves the picker, its mark goes to the first shown, and a start still takes it by name; a custom id passes", async () => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await rt.preferences.set({ agentDefaults: { claude: { models: { hide: ["claude-opus-5-5"], custom: ["claude-opus-6-preview"] } } } });
    const claude = (await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")!;
    expect(claude.models.map(m => m.value)).not.toContain("claude-opus-5-5");
    expect(claude.models.map(m => m.value)).toContain("claude-opus-6-preview");
    expect(markedDefault(claude.models)?.value).toBe("claude-fable-5-1");
    expect((await run(ws.id, { prompt: "one", model: "claude-opus-5-5" })).model).toBe("claude-opus-5-5");
    expect((await run(ws.id, { prompt: "two", model: "claude-opus-6-preview" })).model).toBe("claude-opus-6-preview");
    await expect(rt.sessions.start(ws.id, { prompt: "three", model: "claude-nope" })).rejects.toThrow(/is not one claude takes/);
  });

  it("an agent turned off on this computer leaves the lists, a start naming it is refused naming the computer, and the default moves on", async () => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await rt.agents.setup(HERE_PLACE_ID, "claude", { on: false });
    expect((await rt.harnesses.list(ws.id)).map(c => c.harness)).toEqual(["codex"]);
    expect((await rt.harnesses.list(ws.id))[0]!.isDefault).toBe(true);
    await expect(rt.sessions.start(ws.id, { prompt: "one", harness: "claude" })).rejects.toMatchObject({ message: expect.stringMatching(/^Claude Code is off on /), kind: "usage" });
    expect((await run(ws.id, { prompt: "two" })).harness).toBe("codex");
    await rt.agents.setup(HERE_PLACE_ID, "claude", { on: true });
    expect((await run(ws.id, { prompt: "three", harness: "claude" })).harness).toBe("claude");
  });
});

/** This computer as the runtime is wired with it, its home a folder of the case's own. */
const localWiringOf = (root: string): LocalWiring => ({
  backend: new LocalBackend({ root }),
  execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
  home: id => join(root, `.${id}`),
  homeDir: root,
  rootsPath: join(root, "roots"),
  env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
  platform: testPlatform(),
  copier: copyingFake(),
});

describe("an agent's setup on a computer", () => {
  let root: string;
  let launched: Launched[];
  let store: Store;
  let rt: Runtime;
  let srv: RuntimeServer | undefined;
  const clients: WsClient[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-setup-"));
    launched = [];
    store = memoryStore();
    rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: recorder("claude", launched), codex: recorder("codex", launched) }, local: localWiringOf(root), agentsReader: reader });
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await srv?.close();
    srv = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("reaches the launch whole: the program, the words, the variables and the config folder as the agent's own home and variable", async () => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const configDir = join(root, "claude-wsp");
    await rt.agents.setup(HERE_PLACE_ID, "claude", { program: "/opt/claude", args: ["--debug"], configDir, env: { FOO: "bar" } });
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    const kept = join(realpathSync(root), "claude-wsp");
    expect(launched.at(-1)).toMatchObject({ harness: "claude", home: kept, launch: { program: "/opt/claude", args: ["--debug"] }, env: { FOO: "bar", CLAUDE_CONFIG_DIR: kept } });
    // Another agent on the same computer keeps its own.
    await (await rt.sessions.start(ws.id, { prompt: "two", harness: "codex" })).finished;
    expect(launched.at(-1)!.env).not.toHaveProperty("FOO");
    expect(launched.at(-1)!.launch).toBeUndefined();
  });

  it("no read and no event carries a value: the row names the variables, the record is the store's alone", async () => {
    const events: unknown[] = [];
    rt.events.on("*", e => events.push(e));
    const answered = await rt.agents.setup(HERE_PLACE_ID, "claude", { env: { SECRET_ONE: "s3cr3t-value" } });
    expect(answered.setup).toEqual({ on: true, envNames: ["SECRET_ONE"] });
    const report = await rt.agents.read({ placeId: HERE_PLACE_ID });
    expect(report.agents.find(a => a.id === "claude")!.setup).toEqual({ on: true, envNames: ["SECRET_ONE"] });
    await rt.preferences.set({ defaultAgent: "codex" });
    await until(() => events.some(e => (e as { type?: string }).type === "preferences.changed"));
    for (const said of [answered, report, await rt.preferences.get(), events]) expect(JSON.stringify(said)).not.toContain("s3cr3t-value");
    expect(JSON.stringify(await store.list("agentSetups"))).toContain("s3cr3t-value");
  });

  it("refuses a config folder that is the home, one for an agent with no variable for it, and a variable its launch drops", async () => {
    await expect(rt.agents.setup(HERE_PLACE_ID, "claude", { configDir: root })).rejects.toMatchObject({ message: "Claude Code's config folder cannot be the home folder itself; name a folder under it", kind: "usage" });
    await expect(rt.agents.setup(HERE_PLACE_ID, "claude", { env: { CLAUDE_CODE_USE_BEDROCK: "1" } })).rejects.toMatchObject({ message: "CLAUDE_CODE_USE_BEDROCK never reaches Claude Code: its launch drops every variable of that kind", kind: "usage" });
    await expect(rt.agents.setup(HERE_PLACE_ID, "gemini", { on: false })).rejects.toMatchObject({ kind: "usage" });
    await expect(rt.agents.setup("p_nowhere", "claude", { on: false })).rejects.toThrow();
    expect(await store.list("agentSetups")).toEqual([]);
  });

  it("refuses a variable that decides how the process starts or what it loads before anything is kept, and skips one kept before", async () => {
    for (const name of ["PATH", "ld_preload", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "WSP_HOST_TOKEN"]) {
      await expect(rt.agents.setup(HERE_PLACE_ID, "codex", { env: { [name]: "/evil" } }), name).rejects.toMatchObject({ kind: "usage" });
    }
    expect(await store.list("agentSetups")).toEqual([]);
    // Taking one away stays open, so a name kept before this rule can still be cleared.
    await rt.agents.setup(HERE_PLACE_ID, "codex", { env: { PATH: null, FOO: "bar" } });
    await store.put("agentSetups", "here:codex", { env: { PATH: "/evil", NODE_OPTIONS: "--require /evil.js", FOO: "bar" } });
    const kept = createRuntime({ backend: stubBackend(), store, adapters: { claude: recorder("claude", launched), codex: recorder("codex", launched) }, local: localWiringOf(root), agentsReader: reader });
    const ws = await createOn(kept, { on: HERE_PLACE_ID, name: "mac" });
    await (await kept.sessions.start(ws.id, { prompt: "one", harness: "codex" })).finished;
    expect(launched.at(-1)!.env).toMatchObject({ FOO: "bar" });
    expect(launched.at(-1)!.env["PATH"]).not.toBe("/evil");
    expect(launched.at(-1)!.env).not.toHaveProperty("NODE_OPTIONS");
  });

  it("keeps a config folder under this computer's home after the path is normalised and its links followed, and out of wsp's own", async () => {
    mkdirSync(join(root, "real"));
    symlinkSync(tmpdir(), join(root, "out"));
    symlinkSync(join(root, "real"), join(root, "in"));
    symlinkSync("/etc/wsp-not-made", join(root, "later"));
    symlinkSync("loop", join(root, "loop"));
    for (const dir of ["/tmp/x", "/etc/x", `${root}/../x`, join(root, "out", "x"), join(root, "later"), join(root, "later", "x"), join(root, "loop", "x"), join(root, ".wsp", "claude"), root]) {
      await expect(rt.agents.setup(HERE_PLACE_ID, "claude", { configDir: dir }), dir).rejects.toMatchObject({ kind: "usage" });
    }
    expect(await store.list("agentSetups")).toEqual([]);
    expect((await rt.agents.setup(HERE_PLACE_ID, "claude", { configDir: join(root, "in", "claude-wsp") })).setup?.configDir).toBe(join(realpathSync(root), "real", "claude-wsp"));
  });

  it("keeps the folder its links lead to, and refuses the next launch once that folder leads out of the home", async () => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const outside = mkdtempSync(join(tmpdir(), "wsp-outside-"));
    try {
      mkdirSync(join(root, "real"));
      symlinkSync(join(root, "real"), join(root, "in"));
      const kept = join(realpathSync(root), "real", "claude-wsp");
      expect((await rt.agents.setup(HERE_PLACE_ID, "claude", { configDir: join(root, "in", "claude-wsp") })).setup?.configDir).toBe(kept);
      await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
      expect(launched.at(-1)).toMatchObject({ home: kept, env: { CLAUDE_CONFIG_DIR: kept } });
      // Moving the link named at setup moves nothing: the launch reads the folder kept.
      rmSync(join(root, "in"));
      symlinkSync(outside, join(root, "in"));
      await (await rt.sessions.start(ws.id, { prompt: "two" })).finished;
      expect(launched.at(-1)).toMatchObject({ home: kept });
      const before = launched.length;
      rmSync(join(root, "real"), { recursive: true });
      symlinkSync(outside, join(root, "real"));
      await expect(rt.sessions.start(ws.id, { prompt: "three" })).rejects.toMatchObject({
        kind: "usage",
        message: `Claude Code does not start with its config folder ${kept}: Claude Code's config folder has to be under the home folder ${realpathSync(root)}, and ${kept} is not. Set another with wsp agents setup claude --config, or put its own back with --reset config.`,
      });
      expect(launched).toHaveLength(before);
      // Reading or writing under that folder is refused in the same words, and no read falls back to the agent's own.
      const words = `Claude Code does not start with its config folder ${kept}: Claude Code's config folder has to be under the home folder ${realpathSync(root)}, and ${kept} is not. Set another with wsp agents setup claude --config, or put its own back with --reset config.`;
      const row = (await rt.sessions.list(ws.id)).find(r => r.harness === "claude")!;
      await expect(rt.sessions.rename(row.id, "named")).rejects.toMatchObject({ kind: "usage", message: words });
      expect((await rt.harnesses.list(ws.id)).find(c => c.harness === "claude")?.refusal).toBe(words);
      expect((await rt.harnesses.list(ws.id)).find(c => c.harness === "codex")?.refusal).toBeUndefined();
      expect((await rt.sessions.list(ws.id)).find(r => r.harness === "claude")?.setupRefusal).toBe(words);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reads a folder on another computer the same way, on that computer: links followed, the part not made yet kept", () => {
    mkdirSync(join(root, "a"));
    symlinkSync(join(root, "a"), join(root, "b"));
    symlinkSync("/etc/wsp-not-made", join(root, "a", "later"));
    symlinkSync("../a/later", join(root, "a", "near"));
    const read = (path: string): string[] => execFileSync("/bin/bash", ["-c", realFolderScript(path)], { env: { HOME: root, PATH: "/usr/bin:/bin" }, encoding: "utf8" }).trim().split("\n");
    const real = execFileSync("/bin/bash", ["-c", "pwd -P"], { cwd: root, encoding: "utf8" }).trim();
    expect(read(join(root, "b", "not", "yet"))).toEqual([join(real, "a", "not", "yet"), real]);
    expect(read(join(root, "b", "later", "x"))).toEqual([join(realpathSync("/etc"), "wsp-not-made", "x"), real]);
    expect(read(join(root, "b", "near"))).toEqual([join(realpathSync("/etc"), "wsp-not-made"), real]);
    symlinkSync("loop", join(root, "loop"));
    const looped = spawnSync("/bin/bash", ["-c", realFolderScript(join(root, "loop", "x"))], { env: { HOME: root, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect([looped.status, looped.stderr.trim()]).toEqual([3, `${join(root, "loop", "x")} goes round a loop of links`]);
  });

  it("is the host's own road over the wire, and a value crosses only on a socket holding the host's own token", async () => {
    srv = await serveRuntime(rt, { port: 0, authToken: "host-token", devices: rt.devices });
    const host = await WsClient.connect(srv.port, { token: "host-token" });
    clients.push(host);
    expect(await host.request("agents.setup", { placeId: HERE_PLACE_ID, agent: "claude", env: { FOO: "bar" } })).toMatchObject({ ok: true, agent: { id: "claude", setup: { on: true, envNames: ["FOO"] } } });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    const relayed = await WsClient.connect(srv.port, { ticket });
    clients.push(relayed);
    expect(await relayed.request("agents.setup", { placeId: HERE_PLACE_ID, agent: "claude", on: false })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
    const phone = await WsClient.connect(srv.port, { token: (await rt.devices.admit("phone", Date.now())).deviceToken });
    clients.push(phone);
    expect(await phone.request("agents.setup", { placeId: HERE_PLACE_ID, agent: "claude", env: { FOO: "baz" } })).toMatchObject({ ok: false });
    expect(JSON.stringify(await store.list("agentSetups"))).not.toContain("baz");
  });
});
