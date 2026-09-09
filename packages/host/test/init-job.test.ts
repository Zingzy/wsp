// SPDX-License-Identifier: AGPL-3.0-only
// The init job on a serving host, against the stub backend: the manual road
// reads this computer once and hands the screens over as data, the answers
// move the recipe, the build is wsp init's own non-interactive run on the
// host's one runtime with its sign-ins as rows, and the agent road opens a
// thread on this computer that writes the recipe the screens then show. Only
// this computer's readers, the Keychain and the builder's terminal link are
// faked, and the callback relay is a stub that opens nothing; the runtime and
// the run are the real ones.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SNAPSHOT_STORAGE, type BackendPricing } from "@wsp/engine";
import { InitJob, LOGIN_STATE_WORDS, Recipe, SIGN_IN_OPEN_STATE, initAgentPrompt, type InitJobEvent } from "@wsp/protocol";
import { createRuntime, goldenHead, memoryStore, smallestModel, harnessCatalog, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { localWiring, type Keys } from "../src/cli.js";
import { InitJobs, type InitJobDeps } from "../src/init-job.js";
import { smallRecipePath } from "../src/recipe-file.js";
import { workspaceRoads } from "../src/server.js";
import { FIXTURE, RECIPE } from "./init-fixture.js";
import { CLAUDE_URL, DEVICE_URL, scriptedLink } from "./init-link.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { scriptedAgent } from "./verbs-fixture.js";

const SOLARI = "slr_live_fake_solari_key";
const PRICING: BackendPricing = { rateUsdPerHour: s => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: SNAPSHOT_STORAGE };
/** What the agent's thread writes: RECIPE with Codex ticked on too. */
const AGENT_RECIPE: Recipe = { ...RECIPE, rows: RECIPE.rows.map(r => (r.id === "codex" ? { ...r, on: true } : r)) };

const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fake {
  jobs: InitJobs;
  rt: Runtime;
  backend: StubBackend;
  statePath: string;
  events: InitJobEvent[];
  saved: Record<string, string>[];
  swapped: Keys[];
  installed: string[][];
  prompts: { prompt: string; harness?: string; model?: string; title?: string }[];
  settled(): Promise<void>;
}

function fake(over: { keys?: Keys; configured?: boolean } = {}): Fake {
  const dir = mkdtempSync(join(tmpdir(), "wsp-init-job-"));
  dirs.push(dir);
  const home = mkdtempSync(join(tmpdir(), "wsp-init-job-home-"));
  dirs.push(home);
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Me\n");
  writeFileSync(join(home, ".zshrc"), "export A=1\n");
  mkdirSync(join(home, ".ssh"), { mode: 0o700 });
  writeFileSync(join(home, ".ssh", "config"), "Host work\n", { mode: 0o600 });
  const statePath = join(dir, "state", "state.json");
  mkdirSync(join(dir, "state"), { recursive: true });
  const backend = stubBackend();
  const store = memoryStore();
  const prompts: Fake["prompts"] = [];
  const claude = scriptedAgent(prompt => {
    // The agent's turn ends with the recipe written where the recipe tool writes it by default.
    writeFileSync(smallRecipePath(statePath), JSON.stringify(AGENT_RECIPE));
    return `written ${prompt.length}`;
  });
  const rt = createRuntime({ backend, store, adapters: { claude: claude.adapter }, local: localWiring(dir), hostId: "box:h1" });
  runtimes.push(rt);
  const link = scriptedLink({ signedIn: true, hold: false, missing: false });
  const saved: Record<string, string>[] = [];
  const swapped: Keys[] = [];
  const installed: string[][] = [];
  let keys: Keys = over.keys ?? { solari: SOLARI };
  const deps: InitJobDeps = {
    rt,
    statePath,
    home,
    platform: "darwin",
    keys: () => keys,
    saveKeys: set => {
      saved.push(set);
      keys = { ...keys, ...(set["SOLARI_API_KEY"] !== undefined ? { solari: set["SOLARI_API_KEY"] } : {}), ...(set["ANTHROPIC_API_KEY"] !== undefined ? { anthropic: set["ANTHROPIC_API_KEY"] } : {}) };
    },
    provider: k => void swapped.push(k),
    pricing: () => PRICING,
    agents: async () => [
      { id: "claude", name: "Claude Code", found: true, configured: over.configured ?? false },
      { id: "codex", name: "Codex", found: false, configured: false },
    ],
    installTools: ids => {
      installed.push([...ids].sort());
      return { server: { command: "wsp", args: ["mcp"] }, installed: [...ids].map(id => ({ id, agent: id, path: `~/.${id}.json`, skill: `~/.${id}/skills/wsp/SKILL.md` })), failures: [] };
    },
    read: {
      collect: async () => FIXTURE,
      recipe: async () => RECIPE,
      scanProject: async folder => ({ dir: folder, rows: [], candidates: [] }),
      scan: async () => [],
    },
    build: {
      secrets: { read: async () => "gho_fake", run: async () => "sk-ant-x-helper\n" },
      relay: async () => ({ close: async () => {} }),
      daemon: async () => ({ link: link.dial(), close: () => {} }),
      roads: () => workspaceRoads(rt, {}),
      recipe: recipe => ({ ...recipe, deployDaemon: async () => "node v22.12.0" }),
    },
    retry: { waitMs: 1, attempts: 3 },
  };
  const jobs = new InitJobs(deps);
  const events: InitJobEvent[] = [];
  jobs.on(e => {
    events.push(e);
    // Every view on the wire parses as the protocol's.
    InitJob.parse(e.job);
  });
  return { jobs, rt, backend, statePath, events, saved, swapped, installed, prompts, settled: () => jobs.settled() };
}

const phases = (f: Fake): string[] => f.events.map(e => e.job.phase).filter((p, i, all) => i === 0 || all[i - 1] !== p);

describe("the init job, manual road", () => {
  it("opens with the keys' presence, the agents here and the price, and no job", async () => {
    const f = fake();
    const setup = await f.jobs.get();
    expect(setup).toEqual({
      keys: { solari: true, anthropic: false },
      agents: [{ id: "claude", name: "Claude Code", configured: false }],
      pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: expect.closeTo(0.11, 5) as unknown as number },
      job: null,
    });
  });

  it("saving a key writes it to the wsp home's .env through the one writer and wires the provider; the view says held, never the key", async () => {
    const f = fake({ keys: {} });
    expect((await f.jobs.get()).keys).toEqual({ solari: false, anthropic: false });
    const setup = await f.jobs.keys({ solari: "slr_live_typed", anthropic: "sk-ant-x-typed" });
    expect(f.saved).toEqual([{ SOLARI_API_KEY: "slr_live_typed", ANTHROPIC_API_KEY: "sk-ant-x-typed" }]);
    expect(f.swapped).toEqual([{ solari: "slr_live_typed", anthropic: "sk-ant-x-typed" }]);
    expect(setup.keys).toEqual({ solari: true, anthropic: true });
    expect(JSON.stringify(setup)).not.toMatch(/slr_live_typed|sk-ant-x-typed/);
    // Nothing typed: nothing written, nothing swapped.
    await f.jobs.keys({});
    expect(f.saved).toHaveLength(1);
  });

  it("start reads this computer once and hands the five screens over; answers move the recipe; the build is wsp init's own run on the host's runtime, its sign-ins as rows, ending with the golden sealed and the first workspace forked", async () => {
    const f = fake();
    const started = await f.jobs.start({ road: "manual" });
    expect(started).toMatchObject({ road: "manual", phase: "reading", keys: { solari: true, anthropic: false } });
    await f.settled();
    const read = f.jobs.view()!;
    expect(read.phase).toBe("answering");
    expect(read.screens.map(s => s.id)).toEqual(["agents", "tools", "also", "logins", "wsp"]);
    expect(read.screens[0]!.ticks).toEqual(["claude"]);

    const answered = await f.jobs.answer({ screen: "agents", ticks: ["claude", "codex"] });
    expect(answered.screens[0]!.ticks.sort()).toEqual(["claude", "codex"]);
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "machine", "logins/claude": "machine", "logins/codex": "skip" } });
    await f.jobs.answer({ screen: "wsp", ticks: ["wsp-tools/claude"] });
    await expect(f.jobs.start({ road: "manual" })).rejects.toThrow(/already/);

    const building = await f.jobs.build({ firstWorkspace: "first" });
    expect(building.phase).toBe("building");
    // The rows are known up front, so the count means something from the first frame.
    expect(building.rows.filter(r => r.kind === "stage")).toHaveLength(12);
    expect(building.rows.find(r => r.kind === "workspace")).toMatchObject({ label: "first", state: "waiting" });
    expect(building.rows.find(r => r.kind === "agent")).toMatchObject({ id: "agent/claude", label: "Claude Code", state: "MCP added" });
    expect(f.installed).toEqual([["claude"]]);
    await f.settled();
    const done = f.jobs.view()!;
    expect(done.phase).toBe("done");
    expect(done.error).toBeUndefined();
    expect(done.golden).toEqual({ version: 1 });
    expect(done.workspace).toMatchObject({ name: "first" });
    expect(done.progress).toEqual({ done: done.progress.total, total: done.progress.total });
    // The recipe the screens answered is the one the run built from, written where wsp init --recipe reads it.
    const recipe = Recipe.parse(JSON.parse(readFileSync(smallRecipePath(f.statePath), "utf8")));
    expect(recipe.rows.filter(r => r.kind === "agent" && r.on).map(r => r.id).sort()).toEqual(["claude", "codex"]);
    expect(recipe.rows.find(r => r.id === "gh")?.signIn).toBe("machine");
    // Each sign-in was a row with its page while it waited, then its state word.
    const gh = done.rows.find(r => r.id === "sign-in/gh")!;
    expect(gh).toMatchObject({ kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: LOGIN_STATE_WORDS["signed-in"] });
    const waited = f.events.map(e => e.job.rows.find(r => r.id === "sign-in/gh")).find(r => r?.state === SIGN_IN_OPEN_STATE);
    expect(waited).toMatchObject({ page: DEVICE_URL });
    expect(f.events.some(e => e.job.rows.some(r => r.id === "sign-in/claude" && r.page === CLAUDE_URL))).toBe(true);
    expect(done.rows.filter(r => r.kind === "stage").every(r => r.state === "done")).toBe(true);
    expect(done.rows.find(r => r.kind === "workspace")).toMatchObject({ state: "forked" });
    expect(phases(f)).toEqual(["reading", "answering", "building", "signing-in", "sealing", "finishing", "done"]);
    // The host's one runtime holds the golden and the workspace; nothing else was built.
    expect(goldenHead(await f.rt.golden.get())?.version).toBe(1);
    expect((await f.rt.workspaces.list()).map(w => w.name)).toEqual(["first"]);
    expect(f.backend.machines.filter(m => !m.killed)).toHaveLength(1);
    expect(done.log.some(l => l.includes("Golden v1 sealed"))).toBe(true);
    // Done: the setup carries the job for a client opening late, and a new start is allowed again.
    expect((await f.jobs.get()).job?.phase).toBe("done");
  });

  it("cancel while the screens wait drops the job; a build cannot start without answers", async () => {
    const f = fake();
    await f.jobs.start({ road: "manual" });
    await f.settled();
    expect((await f.jobs.cancel()).phase).toBe("cancelled");
    await expect(f.jobs.build({})).rejects.toThrow(/no screens/);
    await expect(f.jobs.answer({ screen: "agents", ticks: [] })).rejects.toThrow(/no screens/);
  });

  it("a build with no provider key is refused before anything is read into the recipe", async () => {
    const f = fake({ keys: {} });
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await expect(f.jobs.build({})).rejects.toThrow(/Solari/);
  });
});

describe("the init job, agent road", () => {
  it("adds the wsp tools to the agent, opens a thread on this computer with the cheapest model and the one prompt, and shows the screens prefilled from the recipe the thread wrote", async () => {
    const f = fake();
    const local = await f.rt.workspaces.createLocal("this-mac");
    const started = await f.jobs.start({ road: "agent", harness: "claude" });
    expect(started.phase).toBe("agent");
    await f.settled();
    const view = f.jobs.view()!;
    expect(view.phase).toBe("answering");
    expect(view.thread?.workspaceId).toBe(local.id);
    expect(f.installed).toEqual([["claude"]]);
    expect(view.rows.find(r => r.kind === "agent")).toMatchObject({ label: "Claude Code", state: "MCP added" });
    const sessions = await f.rt.sessions.list(local.id);
    expect(sessions).toHaveLength(1);
    const transcript = await f.rt.sessions.history(local.id);
    const start = transcript.find(e => e.type === "session.start") as { prompt?: string; model?: string } | undefined;
    expect(start?.prompt).toBe(initAgentPrompt(smallRecipePath(f.statePath)));
    expect(smallestModel(harnessCatalog("claude"))).toBeDefined();
    // The screens open on what the agent wrote: Codex ticked on beside Claude Code.
    expect(view.screens[0]!.ticks.sort()).toEqual(["claude", "codex"]);
    expect(phases(f)).toEqual(["agent", "reading", "answering"]);
  });

  it("two agent-road starts in flight leave one job: the second is refused while the first's thread is still being opened", async () => {
    const f = fake();
    await f.rt.workspaces.createLocal("this-mac");
    const [first, second] = await Promise.allSettled([f.jobs.start({ road: "agent", harness: "claude" }), f.jobs.start({ road: "agent", harness: "claude" })]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect((second as PromiseRejectedResult).reason).toMatchObject({ message: expect.stringMatching(/already/) });
    await f.settled();
    expect((await f.rt.sessions.list()).length).toBe(1);
  });

  it("an agent already carrying the wsp tools gets no second install, and a harness with no local workspace is refused", async () => {
    const f = fake({ configured: true });
    await expect(f.jobs.start({ road: "agent", harness: "claude" })).rejects.toThrow(/this computer/);
    await f.rt.workspaces.createLocal("this-mac");
    await f.jobs.start({ road: "agent", harness: "claude" });
    await f.settled();
    expect(f.installed).toEqual([]);
    expect(f.jobs.view()!.phase).toBe("answering");
  });

  it("a harness the runtime cannot run refuses the start in one line, and the job is not left behind", async () => {
    const f = fake();
    await f.rt.workspaces.createLocal("this-mac");
    await expect(f.jobs.start({ road: "agent", harness: "codex" })).rejects.toThrow();
    expect(f.jobs.view()).toBeNull();
  });
});
