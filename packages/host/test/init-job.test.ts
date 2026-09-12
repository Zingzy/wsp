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
import { basename, join, relative } from "node:path";
import { BUILDER_DISK_GB, NoProviderBackend, SMOKE_LABEL, SNAPSHOT_STORAGE, checkProviderKey, type BackendPricing, type MachineBackend } from "@wsp/engine";
import { CLOUD_SETUP_WORDS, GOLDEN_STAGE_WORDS, INIT_BUILD_STEP, INIT_ROW_STATES, initSignInOutcome, InitJob, InitNeedsYouEvent, KEY_REFUSED, KEY_UNCHECKED, MACHINE_SWEEP_LINE, NETWORK_LOST_LINE, NEVER_REACHED, NO_FIRST_WORKSPACE, Recipe, SAVED_KEY_STOPPED_LINE, SIGN_IN_NEVER_REACHED, SIGN_IN_OPEN_STATE, SIGN_IN_STAGE_ID, initAgentNoRecipeLine, initAgentPrompt, initAgentStep, initBuildRows, MACHINE_ROW_LABEL, initProgressLine, initRowOver, initStageCount, keyRefusedLine, keyUncheckedLine, noMcpServersLine, savedKeyRefusedLine, type InitJobEvent } from "@wsp/protocol";
import { runLogPath } from "../src/init-log.js";
import { createRuntime, goldenHead, memoryStore, smallestModel, harnessCatalog, type HarnessAdapterFactory, type HarnessStartOptions, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localWiring } from "../src/cli.js";
import { InitJobs, type InitJobDeps } from "../src/init-job.js";
import { loadRecipe, saveSmallRecipe, smallRecipePath } from "../src/recipe-file.js";
import { workspaceRoads } from "../src/server.js";
import type { AgentHere } from "../src/agents-here.js";
import type { FakePtyLink } from "./fake-pty-link.js";
import { FIXTURE, RECIPE } from "./init-fixture.js";
import { CLAUDE_URL, DEVICE_URL, scriptedLink } from "./init-link.js";
import type { HostHooks } from "../src/init-signin.js";
import { stubBackend, type StubBackend, type StubMachine } from "./stub-backend.js";
import { holdingAgent, scriptedAgent } from "./verbs-fixture.js";

const SOLARI = "slr_live_fake_solari_key";
const PRICING: BackendPricing = { rateUsdPerHour: s => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: SNAPSHOT_STORAGE, builderDiskGb: BUILDER_DISK_GB };
/** What the agent's thread writes: RECIPE with Codex ticked on too. */
const AGENT_RECIPE: Recipe = { ...RECIPE, rows: RECIPE.rows.map(r => (r.id === "codex" ? { ...r, on: true } : r)) };
/** The wsp server as this host's install would write it: one spec, read by the install road and by the launch. */
/** The rows the host leaves when the saved key is refused, in the order a client draws them. The app's fixture and
 * its dialog test stand in for this job (apps/web/test/cloud-setup/keyRefusedJob.ts), so a change here is a change
 * there; the words themselves are the protocol's, which both sides read. */
const waitingStage = (id: keyof typeof GOLDEN_STAGE_WORDS): unknown[] => [`stage/${id}`, INIT_ROW_STATES.waiting, undefined];
const KEY_REFUSED_ROWS = [
  ["stage/creating", INIT_ROW_STATES.failed, savedKeyRefusedLine("401 Unauthorized")],
  ...(["deploying-daemon", "applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp", "ready"] as const).map(waitingStage),
  ["sign-in/claude", INIT_ROW_STATES.skipped, SIGN_IN_NEVER_REACHED],
  ["sign-in/gh", INIT_ROW_STATES.skipped, SIGN_IN_NEVER_REACHED],
  ...(["snapshotting", "promoting", "smoke-forking", "sealed"] as const).map(waitingStage),
  ["workspace/first", INIT_ROW_STATES.notMade, NEVER_REACHED],
];
const WSP_SERVER = { command: "/usr/local/bin/node", args: ["/opt/wsp/bin.js", "mcp", "--state", "/tmp/state.json"] };

/** The network gone for the next `times` kills of the machines `pick` names, then back: what an outage looked like
 * from the host on 2026-09-10, where every DELETE answered ENOTFOUND and the machine went on billing. */
function downFor(backend: StubBackend, times: number, pick: (m: StubMachine) => boolean = () => true): { first(): StubMachine } {
  const made = backend.create.bind(backend);
  const hit: StubMachine[] = [];
  let left = times;
  backend.create = async spec => {
    const m = (await made(spec)) as StubMachine;
    if (!pick(m)) return m;
    hit.push(m);
    const real = m.kill.bind(m);
    m.kill = async () => {
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error("getaddrinfo ENOTFOUND api.getsolari.com"), { code: "ENOTFOUND" });
      }
      await real();
    };
    return m;
  };
  return { first: () => hit[0]! };
}

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
  /** Every arrival of a wait on the person, in order: one per need. */
  needs: InitNeedsYouEvent[];
  /** Subscribes to the views alone, for a test that watches the job move; the need's own event is not a view. */
  onJob(fn: (job: InitJob) => void): () => void;
  saved: Record<string, string>[];
  swapped: Readonly<Record<string, string>>[];
  installed: string[][];
  prompts: { prompt: string; harness?: string; model?: string; title?: string }[];
  /** Every launch the harness took, as the runtime handed it over: what the agent road's options are read off. */
  starts: HarnessStartOptions[];
  home: string;
  /** The builder's terminal link the build dials; swapped under a running build to script the next sign-in. */
  setLink(link: FakePtyLink): void;
  /** The callback relay's hooks as the run wired them, and how often the relay was closed. */
  relay: { hooks: HostHooks[]; closed: number };
  settled(): Promise<void>;
}

function fake(over: { platform?: "darwin" | "linux"; env?: Record<string, string>; provider?: MachineBackend; configured?: boolean; read?: Partial<InitJobDeps["read"]>; now?: () => number; agent?: { adapter: HarnessAdapterFactory; starts: HarnessStartOptions[] }; writesRecipe?: boolean; agents?: AgentHere[]; adapters?: Record<string, HarnessAdapterFactory>; deployDaemon?: () => Promise<string> } = {}): Fake {
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
  const claude =
    over.agent ??
    scriptedAgent(prompt => {
      // The agent's turn ends with the recipe written where the recipe tool writes it by default.
      if (over.writesRecipe !== false) writeFileSync(smallRecipePath(statePath), JSON.stringify(AGENT_RECIPE));
      return `written ${prompt.length}`;
    });
  // The provider the runtime forks on: the stub, or one a case hands over to stand for a host set up for none.
  const rt = createRuntime({ backend: over.provider ?? backend, store, adapters: { claude: claude.adapter, ...over.adapters }, local: localWiring(dir), hostId: "box:h1" });
  runtimes.push(rt);
  let link = scriptedLink({ signedIn: true, hold: false, missing: false });
  const relay: Fake["relay"] = { hooks: [], closed: 0 };
  const saved: Record<string, string>[] = [];
  const swapped: Readonly<Record<string, string>>[] = [];
  const installed: string[][] = [];
  let env: Record<string, string> = over.env ?? { SOLARI_API_KEY: SOLARI };
  const deps: InitJobDeps = {
    rt,
    statePath,
    home,
    platform: over.platform ?? "darwin",
    saved: () => env,
    saveKeys: set => {
      saved.push(set);
      env = { ...env, ...set };
    },
    provider: k => void swapped.push(k),
    // The provider module the typed key would name is this test's stub, so the check the keys step runs is its own.
    keyEnv: () => "SOLARI_API_KEY",
    checkKey: () => checkProviderKey(backend),
    pricing: () => PRICING,
    agents: async () =>
      over.agents ?? [
        { id: "claude", name: "Claude Code", found: true, configured: over.configured ?? false },
        { id: "codex", name: "Codex", found: false, configured: false },
      ],
    installTools: ids => {
      installed.push([...ids].sort());
      return { server: WSP_SERVER, installed: [...ids].map(id => ({ id, agent: id, path: `~/.${id}.json`, skill: `~/.${id}/skills/wsp/SKILL.md` })), failures: [] };
    },
    mcpServer: () => WSP_SERVER,
    read: {
      collect: async () => FIXTURE,
      recipe: async () => RECIPE,
      scanProject: async folder => ({ dir: folder, rows: [], candidates: [] }),
      scan: async () => [],
      ...over.read,
    },
    build: {
      secrets: { read: async () => "gho_fake", run: async () => "sk-ant-x-helper\n" },
      relay: async (_rt, _builder, hooks) => {
        relay.hooks.push(hooks);
        return {
          close: async () => {
            relay.closed += 1;
          },
        };
      },
      daemon: async () => ({ link: link.dial(), close: () => {} }),
      roads: () => workspaceRoads(rt, {}),
      recipe: recipe => ({ ...recipe, deployDaemon: over.deployDaemon ?? (async () => "node v22.12.0") }),
    },
    retry: { waitMs: 1, attempts: 3 },
    pollMs: 5,
    ...(over.now !== undefined ? { now: over.now } : {}),
  };
  const jobs = new InitJobs(deps);
  const events: InitJobEvent[] = [];
  const needs: InitNeedsYouEvent[] = [];
  jobs.on(e => {
    if (e.type === "job.needs-you") {
      needs.push(InitNeedsYouEvent.parse(e));
      return;
    }
    events.push(e);
    // Every view on the wire parses as the protocol's.
    InitJob.parse(e.job);
  });
  return {
    jobs,
    rt,
    backend,
    statePath,
    events,
    needs,
    onJob: fn => jobs.on(e => (e.type === "init.job" ? fn(e.job) : undefined)),
    saved,
    swapped,
    installed,
    prompts,
    starts: claude.starts,
    home,
    relay,
    setLink: next => {
      link = next;
    },
    settled: () => jobs.settled(),
  };
}

const phases = (f: Fake): string[] => f.events.map(e => e.job.phase).filter((p, i, all) => i === 0 || all[i - 1] !== p);

/** One formula a manager here could put on the image, so a run that wants the Also screen shown has a row for it. */
const JQ = { id: "brew/jq", name: "jq", manager: "brew" as const, group: "Homebrew formulae", install: "brew install jq", check: "command -v jq", size: 2 * 1024 * 1024 };

describe("the init job, manual road", () => {
  it("opens with the provider key's presence, the agents here and the price, and no job", async () => {
    const f = fake();
    const setup = await f.jobs.get();
    expect(setup).toEqual({
      keys: { solari: true },
      home: f.home,
      agents: [{ id: "claude", name: "Claude Code", configured: false, takesTools: true }],
      pricing: { size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: expect.closeTo(0.11, 5) as unknown as number, builderDiskGb: BUILDER_DISK_GB },
      job: null,
    });
  });

  it("saving the provider key writes it to the wsp home's .env through the one writer and wires the provider; the view says held, never the key", async () => {
    const f = fake({ env: {} });
    expect((await f.jobs.get()).keys).toEqual({ solari: false });
    const setup = await f.jobs.keys({ solari: "slr_live_typed" });
    expect(f.saved).toEqual([{ SOLARI_API_KEY: "slr_live_typed" }]);
    expect(f.swapped).toEqual([{ SOLARI_API_KEY: "slr_live_typed" }]);
    expect(setup.keys).toEqual({ solari: true });
    expect(JSON.stringify(setup)).not.toMatch(/slr_live_typed/);
    // Nothing typed: nothing written, nothing swapped.
    await f.jobs.keys({});
    expect(f.saved).toHaveLength(1);
  });

  it("the keys the view reads are the home's alone: a key in the process environment is not saved, and an agent's key lands under the variable its sign-in row declares", async () => {
    const f = fake({ env: { SOLARI_API_KEY: SOLARI } });
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-x-from-shell";
    try {
      await f.jobs.start({ road: "manual" });
      await f.settled();
      const logins = f.jobs.view()!.screens.find(s => s.id === "logins")!;
      expect(logins.items.find(i => i.id === "logins/claude")!.key).toEqual({ name: "ANTHROPIC_API_KEY", saved: false });
      // A row that takes no key is refused, so nothing a client names reaches the file.
      await expect(f.jobs.keys({ rows: { "logins/gh": "ghp_fake" } })).rejects.toThrow(/takes no API key/);
      expect(f.saved).toEqual([]);
      const setup = await f.jobs.keys({ rows: { "logins/claude": "sk-ant-x-typed" } });
      expect(f.saved).toEqual([{ ANTHROPIC_API_KEY: "sk-ant-x-typed" }]);
      expect(setup.job!.screens.find(s => s.id === "logins")!.items.find(i => i.id === "logins/claude")!.key).toEqual({ name: "ANTHROPIC_API_KEY", saved: true });
      expect(JSON.stringify(setup)).not.toMatch(/sk-ant-x/);
    } finally {
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  it("the read shows its work as rows: each rung of the collector as it lands, each agent's history with its counts, the scan; the next one runs while the last is done", async () => {
    const seen: string[][] = [];
    const f = fake({
      read: {
        collect: async onRung => {
          onRung("identity", 3);
          onRung("shell", 2);
          onRung("toolchains", 1);
          onRung("tools", 4);
          onRung("agents", 2);
          onRung("logins", 3);
          return FIXTURE;
        },
        recipe: async (onHistory, _onProject, onProgress) => {
          onProgress({ agent: "claude", read: 1, files: 2 });
          onProgress({ agent: "claude", read: 2, files: 2 });
          onHistory({ agent: "claude", state: "read", sessions: 2, calls: 9 });
          onHistory({ agent: "codex", state: "empty", sessions: 0, calls: 0 });
          return RECIPE;
        },
      },
    });
    f.onJob(job => {
      if (job.phase === "reading") seen.push(job.rows.map(r => `${r.label}: ${r.state}${r.detail !== undefined ? ` (${r.detail})` : ""}`));
    });
    await f.jobs.start({ road: "manual" });
    await f.settled();
    const all = seen.flat();
    expect(seen[0]).toEqual([]);
    expect(all).toContain("Identity: running");
    expect(all).toContain("Identity: 3 found");
    expect(all).toContain("Shell: running");
    expect(all).toContain("Sign-ins: 3 found");
    expect(all).toContain("Claude Code: running (1 session of 2)");
    expect(all).toContain("Claude Code: 2 sessions, 9 tool calls");
    expect(all).toContain("Codex: no history here");
    expect(all).toContain("Package managers: 0 found");
    expect(seen.at(-1)!.every(line => !line.endsWith("running"))).toBe(true);
    // Once the screens stand, the facts leave the rows: the build's rows take their place.
    const read = f.jobs.view()!;
    expect(read.phase).toBe("answering");
    expect(read.rows).toEqual([]);
    expect(read.step).toBe(0);
    expect(read.disk).toMatchObject({ total: 20 * 1024 * 1024 * 1024 });
    expect(read.disk!.fixed).toBeGreaterThan(0);
    expect(read.disk!.fixed).toBeLessThan(read.disk!.total);
  });

  it("the step follows the answers and a step back, so a setup shut mid-way reopens where it was; a step off the screens is refused", async () => {
    const f = fake({ read: { scan: async () => [JQ] } });
    await f.jobs.start({ road: "manual" });
    await f.settled();
    expect(f.jobs.view()!.step).toBe(0);
    expect((await f.jobs.answer({ screen: "agents", ticks: ["claude"] })).step).toBe(1);
    expect((await f.jobs.answer({ screen: "tools", ticks: [] })).step).toBe(2);
    expect((await f.jobs.step({ at: 1 })).step).toBe(1);
    expect((await f.jobs.answer({ screen: "logins", answers: {} })).step).toBe(4);
    expect((await f.jobs.answer({ screen: "wsp", ticks: [] })).step).toBe(5);
    await expect(f.jobs.step({ at: 6 })).rejects.toThrow(/no step 6/);
    await expect(f.jobs.step({ at: -1 })).rejects.toThrow(/no step/);
    expect((await f.jobs.get()).job!.step).toBe(5);
  });

  it("what a step ticked and typed and did not send is kept beside the step, so a sheet shut mid-answer reopens on it; Continue spends it and a step the job has not got is refused", async () => {
    const f = fake({ read: { scan: async () => [JQ] } });
    await f.jobs.start({ road: "manual" });
    await f.settled();
    // Everything ticked since the last Continue rides the job, not the client: a view taken now carries it.
    const drafted = await f.jobs.draft({ at: "also", ticks: ["brew/jq", "brew/ripgrep"] });
    expect(drafted.drafts).toEqual([{ at: "also", ticks: ["brew/jq", "brew/ripgrep"], answers: {} }]);
    expect((await f.jobs.get()).job!.drafts).toEqual([{ at: "also", ticks: ["brew/jq", "brew/ripgrep"], answers: {} }]);
    // An empty draft is an answer too: a screen whose every tick came off comes back with none on, not with the host's.
    expect((await f.jobs.draft({ at: "agents", ticks: [] })).drafts).toContainEqual({ at: "agents", ticks: [], answers: {} });
    // The build's own question is a step with no screen; the name typed there is kept the same way.
    await f.jobs.draft({ at: INIT_BUILD_STEP, answers: { name: "e2e", folder: "" } });
    // A step back and forward leaves it where it was.
    await f.jobs.step({ at: 3 });
    expect(f.jobs.view()!.drafts).toContainEqual({ at: INIT_BUILD_STEP, ticks: [], answers: { name: "e2e", folder: "" } });
    // Continue is what sends a screen's ticks, and it spends that screen's draft; the others stand.
    await f.jobs.answer({ screen: "also", ticks: ["brew/jq"] });
    expect(f.jobs.view()!.drafts!.map(d => d.at)).toEqual(["agents", INIT_BUILD_STEP]);
    await expect(f.jobs.draft({ at: "nowhere", ticks: [] })).rejects.toThrow(/no step nowhere/);
  });

  it("start reads this computer once and hands the screens over; answers move the recipe; the build is wsp init's own run on the host's runtime, its sign-ins as rows, ending with the golden sealed and the first workspace forked", async () => {
    const f = fake({ read: { scan: async () => [JQ] } });
    const started = await f.jobs.start({ road: "manual" });
    expect(started).toMatchObject({ road: "manual", phase: "reading", keys: { solari: true }, step: 0 });
    await f.settled();
    const read = f.jobs.view()!;
    expect(read.phase).toBe("answering");
    expect(read.screens.map(s => s.id)).toEqual(["agents", "tools", "also", "logins", "wsp"]);
    // With no manager row the Also screen is not among them, by the protocol's rule the terminal reads too.
    const bare = fake();
    await bare.jobs.start({ road: "manual" });
    await bare.settled();
    expect(bare.jobs.view()!.screens.map(s => s.id)).toEqual(["agents", "tools", "logins", "wsp"]);
    expect(read.screens[0]!.ticks).toEqual(["claude"]);

    const answered = await f.jobs.answer({ screen: "agents", ticks: ["claude", "codex"] });
    expect(answered.screens[0]!.ticks.sort()).toEqual(["claude", "codex"]);
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "machine", "logins/claude": "machine", "logins/codex": "copy" } });
    await f.jobs.answer({ screen: "wsp", ticks: ["wsp-tools/claude"] });
    await expect(f.jobs.start({ road: "manual" })).rejects.toThrow(/already/);

    const building = await f.jobs.build({ firstWorkspace: "first" });
    expect(building.phase).toBe("building");
    // The rows are known up front, so the count means something from the first frame: every stage, and every sign-in
    // the screens chose, waiting for its turn after the machine answers.
    expect(building.rows.filter(r => r.kind === "stage")).toHaveLength(12);
    expect(building.rows.filter(r => r.kind === "sign-in").map(r => [r.id, r.state])).toEqual([
      ["sign-in/claude", "waiting"],
      ["sign-in/codex", "waiting"],
      ["sign-in/gh", "waiting"],
    ]);
    const first = building.rows.map(r => r.id);
    expect(first.indexOf("sign-in/gh")).toBeGreaterThan(first.indexOf("stage/ready"));
    expect(first.indexOf("sign-in/gh")).toBeLessThan(first.indexOf("stage/snapshotting"));
    expect(building.rows.find(r => r.kind === "workspace")).toMatchObject({ label: "first", state: "waiting" });
    expect(building.rows.find(r => r.kind === "agent")).toMatchObject({ id: "agent/claude", label: "Claude Code", state: "MCP added" });
    // Stage rows read the protocol's plain names, whatever their state, with the machine's lines under the running one.
    expect(building.rows.filter(r => r.kind === "stage").map(r => r.label)).toEqual(Object.values(GOLDEN_STAGE_WORDS));
    expect(f.installed).toEqual([["claude"]]);
    await f.settled();
    const done = f.jobs.view()!;
    expect(done.phase).toBe("done");
    expect(done.rows.filter(r => r.kind === "stage").every(r => r.label === GOLDEN_STAGE_WORDS[r.id.slice("stage/".length) as keyof typeof GOLDEN_STAGE_WORDS])).toBe(true);
    expect(f.events.some(e => e.job.rows.some(r => r.kind === "stage" && r.state === "running" && (r.lines?.length ?? 0) > 0))).toBe(true);
    // The sign-ins sit where they happen: after the machine answers, before the snapshot.
    const ids = done.rows.map(r => r.id);
    expect(ids.indexOf("sign-in/gh")).toBeGreaterThan(ids.indexOf("stage/ready"));
    expect(ids.indexOf("sign-in/gh")).toBeLessThan(ids.indexOf("stage/snapshotting"));
    // A copied credential is a row that needs nothing, and while the phase says signing in a sign-in row is on the list.
    expect(done.rows.find(r => r.id === "sign-in/codex")).toMatchObject({ kind: "sign-in", ...initSignInOutcome("copied", "darwin") });
    const signing = f.events.filter(e => e.job.phase === "signing-in");
    expect(signing.length).toBeGreaterThan(0);
    expect(signing.every(e => e.job.rows.some(r => r.kind === "sign-in"))).toBe(true);
    // The gh row stood as its command started, before its page, then carried the page while it waited.
    const ghStates = f.events.map(e => e.job.rows.find(r => r.id === "sign-in/gh")).filter(r => r !== undefined).map(r => `${r.state}${r.page !== undefined ? " +page" : ""}`);
    expect(ghStates[0]).toBe("waiting");
    expect(ghStates).toContain("running");
    expect(ghStates).toContain(`${SIGN_IN_OPEN_STATE} +page`);
    expect(ghStates.indexOf("running")).toBeLessThan(ghStates.indexOf(`${SIGN_IN_OPEN_STATE} +page`));
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
    expect(gh).toMatchObject({ kind: "sign-in", tool: "gh", label: "GitHub CLI login", ...initSignInOutcome("signed-in", "darwin") });
    expect(gh.state).toBe("done");
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

  it("the sign-in rows are worded for the computer the run reads, and their outcome travels as its own name: a copy on a Linux computer says copied from this computer, on a Mac copied from this Mac, and both read as over", async () => {
    for (const [platform, word] of [
      ["linux", "copied from this computer"],
      ["darwin", "copied from this Mac"],
    ] as const) {
      const f = fake({ platform });
      await f.jobs.start({ road: "manual" });
      await f.settled();
      await f.jobs.answer({ screen: "agents", ticks: ["claude", "codex"] });
      await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "machine", "logins/claude": "machine", "logins/codex": "copy" } });
      await f.jobs.build({ firstWorkspace: "first" });
      await f.settled();
      const done = f.jobs.view()!;
      expect(done.phase).toBe("done");
      const copied = done.rows.find(r => r.id === "sign-in/codex")!;
      expect(copied, platform).toMatchObject({ kind: "sign-in", state: word, login: "copied" });
      // The name is what a client reads, so a row a Linux host worded ends, folds and counts where a Mac's does.
      expect(initRowOver(copied)).toBe(true);
      expect(initBuildRows(done.rows).rows.find(r => r.id === SIGN_IN_STAGE_ID)).toMatchObject({ state: INIT_ROW_STATES.done });
      expect(done.progress).toEqual({ done: done.progress.total, total: done.progress.total });
    }
  });

  it("nothing a build on a Linux computer draws names a Mac: not a row, not a screen, not a line of the log", async () => {
    const f = fake({ platform: "linux", read: { scan: async () => [JQ] } });
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "machine", "logins/claude": "copy", "logins/codex": "copy" } });
    await f.jobs.build({ firstWorkspace: "first" });
    await f.settled();
    expect(f.jobs.view()!.phase).toBe("done");
    // The word, not the letters: "Machine created" is a line of every build.
    expect(JSON.stringify(f.events)).not.toMatch(/\bMac\b/);
  });

  it("a name forks the first workspace whatever the list already holds: this computer is a workspace and the build still ends with the cloud one on the golden it just sealed", async () => {
    const f = fake();
    // The app's list is never empty: this computer is a workspace of its own from the first launch.
    await f.rt.workspaces.createLocal("this-mac");
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "skip", "logins/claude": "skip", "logins/codex": "skip" } });
    const building = await f.jobs.build({ firstWorkspace: "e2e" });
    expect(building.rows.at(-1)).toMatchObject({ id: "workspace/e2e", kind: "workspace", label: "e2e", state: "waiting" });
    await f.settled();
    const done = f.jobs.view()!;
    expect(done.phase).toBe("done");
    expect(done.workspace).toMatchObject({ name: "e2e" });
    expect(done.rows.at(-1)).toMatchObject({ kind: "workspace", label: "e2e", state: "forked" });
    expect((await f.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["e2e", "this-mac"]);
    expect((await f.rt.workspaces.list()).find(w => w.name === "e2e")!.golden).toBe(goldenHead(await f.rt.golden.get())!.snapshotId);
  });

  it("a build with an empty name forks nothing and says so on the row it still draws, so the list never ends on a step nobody can read", async () => {
    const f = fake();
    await f.rt.workspaces.createLocal("this-mac");
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "skip", "logins/claude": "skip", "logins/codex": "skip" } });
    const building = await f.jobs.build({ firstWorkspace: "   ", importFolder: f.home });
    expect(building.rows.at(-1)).toMatchObject({ kind: "workspace", state: "skipped", detail: NO_FIRST_WORKSPACE });
    expect(building.rows.some(r => r.kind === "project")).toBe(false);
    await f.settled();
    const done = f.jobs.view()!;
    expect(done.phase).toBe("done");
    expect(done.workspace).toBeUndefined();
    expect(done.rows.at(-1)).toMatchObject({ kind: "workspace", state: "skipped" });
    expect((await f.rt.workspaces.list()).map(w => w.name)).toEqual(["this-mac"]);
  });

  it("an empty name forks nothing and imports nothing on an empty list too, so the answer decides it and never the count of workspaces", async () => {
    const f = fake();
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "skip", "logins/claude": "skip", "logins/codex": "skip" } });
    // Nothing is seeded: with no workspace in the list the old rule would have asked, and a folder alone answered yes.
    expect(await f.rt.workspaces.list()).toEqual([]);
    const building = await f.jobs.build({ firstWorkspace: "", importFolder: f.home });
    expect(building.rows.at(-1)).toMatchObject({ kind: "workspace", state: "skipped", detail: NO_FIRST_WORKSPACE });
    await f.settled();
    const done = f.jobs.view()!;
    expect(done.phase).toBe("done");
    expect(done.workspace).toBeUndefined();
    expect(done.rows.filter(r => r.kind === "workspace" || r.kind === "project")).toHaveLength(1);
    expect(await f.rt.workspaces.list()).toEqual([]);
  });

  it("one project row per import, whatever the folder was spelled as: the row the build draws is the row the import lands on", async () => {
    const f = fake();
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "skip", "logins/claude": "skip", "logins/codex": "skip" } });
    // A relative folder is resolved before the run reads it, so the row's id cannot drift from the import's own.
    await f.jobs.build({ firstWorkspace: "e2e", importFolder: relative(process.cwd(), f.home) });
    await f.settled();
    const done = f.jobs.view()!;
    const projects = done.rows.filter(r => r.kind === "project");
    expect(projects.map(r => r.id)).toEqual([`project/${f.home}`]);
    expect(projects[0]).toMatchObject({ label: basename(f.home), state: "imported" });
  });

  it("the job carries what it waits on the person for and the event says it arrived, once per need: each sign-in's open page and nothing else, cleared when the row moves on, and never the screens the person just opened", async () => {
    let clock = 1_760_000_000_000;
    const f = fake({ now: () => (clock += 1_000) });
    await f.jobs.start({ road: "manual" });
    await f.settled();
    // The screens wait on the person, but they are what the person is looking at: no need, no event, and the phase
    // word is what the sidebar's keycap carries there.
    const answering = f.jobs.view()!;
    expect(answering.phase).toBe("answering");
    expect(answering.needsYou).toBeUndefined();
    expect(f.needs).toEqual([]);
    await f.jobs.answer({ screen: "agents", ticks: ["claude", "codex"] });
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "machine", "logins/claude": "machine", "logins/codex": "copy" } });
    expect(f.jobs.view()!.needsYou).toBeUndefined();
    expect(f.needs).toEqual([]);

    await f.jobs.build({ firstWorkspace: "first" });
    // The build waits on the machine, so nothing is waited on until a sign-in's page is up.
    expect(f.jobs.view()!.needsYou).toBeUndefined();
    await f.settled();
    const waited = f.events.map(e => e.job.needsYou?.what).filter(w => w !== undefined);
    expect(waited).toContain("sign in to GitHub CLI login");
    // Every sign-in whose page opened is one need, and each carries the clock of its own arrival.
    expect(f.needs.map(e => e.needsYou.what)).toEqual(["sign in to GitHub CLI login", "sign in to Claude Code login"]);
    expect(f.needs.map(e => e.needsYou.since)).toEqual([...f.needs].map(e => e.needsYou.since).sort((a, b) => a - b));
    expect(new Set(f.needs.map(e => e.needsYou.since)).size).toBe(2);
    // The same need over many views is one need: while a page stands open the clock does not move and nothing fires again.
    const standing = f.events.filter(e => e.job.needsYou?.what === "sign in to GitHub CLI login");
    expect(standing.length).toBeGreaterThan(1);
    expect(new Set(standing.map(e => e.job.needsYou!.since)).size).toBe(1);
    // A view carrying a need is a view whose row is open, in every phase without exception, and the need goes with the row.
    for (const e of f.events) {
      const open = e.job.rows.some(r => r.kind === "sign-in" && r.state === SIGN_IN_OPEN_STATE);
      expect(e.job.needsYou !== undefined, `${e.job.phase} ${String(e.job.needsYou?.what)}`).toBe(open);
    }
    // The build ended, so the last word on the wire is a view with no need for the app to clear its toast on.
    expect(f.jobs.view()!.needsYou).toBeUndefined();
    expect(f.events.at(-1)!.job.needsYou).toBeUndefined();
    // Every need event parses on the wire and names the job it belongs to.
    expect(f.needs.every(e => InitNeedsYouEvent.safeParse(e).success && e.jobId === answering.id)).toBe(true);
  });

  it("cancel during the sign-ins stops the job: the sign-in in flight ends not signed in, the machine goes, nothing is sealed; a cancel during the seal is refused and the view says the job cannot be stopped", async () => {
    const f = fake();
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "machine", "logins/claude": "machine", "logins/codex": "skip" } });
    expect((await f.jobs.get()).job!.stoppable).toBe(true);
    f.setLink(scriptedLink({ signedIn: false, hold: true, missing: false }));
    await f.jobs.build({ firstWorkspace: "alpha" });
    // The first sign-in's page is up and the person is waited on; the job says it can still be stopped.
    await new Promise<void>(resolve => {
      const off = f.onJob(job => {
        if (job.rows.some(r => r.kind === "sign-in" && r.page !== undefined)) {
          off();
          resolve();
        }
      });
    });
    expect(f.jobs.view()!.stoppable).toBe(true);
    const cancelled = await f.jobs.cancel();
    expect(cancelled.phase).not.toBe("failed");
    await f.settled();
    const view = f.jobs.view()!;
    expect(view.phase).toBe("cancelled");
    expect(view.stoppable).toBe(false);
    expect(view.rows.find(r => r.id === "sign-in/gh")).toMatchObject({ state: "not signed in" });
    // A run stopped before the fork still ends the workspace row, so no row is left waiting on a build that is over;
    // it reads not made, since skipped would read as a step the build chose to pass on.
    expect(view.rows.at(-1)).toMatchObject({ id: "workspace/alpha", state: INIT_ROW_STATES.notMade, detail: NEVER_REACHED });
    expect(view.golden).toBeUndefined();
    expect(goldenHead(await f.rt.golden.get()) ?? null).toBeNull();
    expect(f.backend.machines.filter(m => !m.killed)).toHaveLength(0);
    expect(view.log.some(l => l.includes("Stopped while signing in."))).toBe(true);
  });

  it("a sign-in that ran out reads not signed in and can be retried while the build runs, through the run's own relay so a callback page still returns; the build waits on none of it and the relay closes with the job", async () => {
    const f = fake();
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "machine", "logins/claude": "skip", "logins/codex": "skip" } });
    f.setLink(scriptedLink({ signedIn: false, hold: false, missing: false }));
    await f.jobs.build({});
    // The build goes on past the failed sign-in and seals; the row says not signed in.
    await new Promise<void>(resolve => {
      const off = f.onJob(job => {
        if (job.rows.some(r => r.id === "sign-in/gh" && r.state === "not signed in") && job.phase === "sealing") {
          off();
          resolve();
        }
      });
    });
    // The relay is still up during the seal, its hooks the ones the run wired.
    expect(f.relay.closed).toBe(0);
    expect(f.relay.hooks).toHaveLength(1);
    // The retried tool prints no page; the machine asks the host to open its callback page, which the relay's hook
    // hands to the retry through the run's own flow, and the status then says signed in.
    // The held login waits on the person; once the callback page is handed over, the tool's own status says signed in.
    const held = scriptedLink({ signedIn: true, hold: true, missing: false });
    const script = held.script;
    held.script = (pty, line) => {
      if (line.includes("gh auth status")) {
        held.data(pty, "Logged in to github.com account me\r\nWSP_STATUS 0\r\n");
        held.exit(pty, 0);
        return;
      }
      script?.(pty, line);
    };
    f.setLink(held);
    const retried = await f.jobs.retry({ tool: "gh" });
    expect(retried.rows.find(r => r.id === "sign-in/gh")).toMatchObject({ state: "running" });
    // A retry during the seal leaves the seal's phase word alone; its command is on the machine once its pty is open.
    expect(retried.phase).toBe("sealing");
    await vi.waitFor(() => expect(held.ptys.length).toBe(1));
    const builderId = (await f.rt.golden.builders()).find(b => b.name === "default")!.id;
    expect(f.relay.hooks[0]!.autoOpen(builderId, "https://dash.cloudflare.com/oauth2?state=x", 8976)).toBe(false);
    await new Promise<void>(resolve => {
      const off = f.onJob(job => {
        if (job.rows.some(r => r.id === "sign-in/gh" && r.page === "https://dash.cloudflare.com/oauth2?state=x")) {
          off();
          resolve();
        }
      });
    });
    await new Promise<void>(resolve => {
      const off = f.onJob(job => {
        if (job.rows.some(r => r.id === "sign-in/gh" && r.state === "done")) {
          off();
          resolve();
        }
      });
    });
    await f.settled();
    expect(f.jobs.view()!.phase).toBe("done");
    expect(f.relay.closed).toBe(1);
    await expect(f.jobs.retry({ tool: "gh" })).rejects.toThrow(/no build is running|no failed sign-in/);
  }, 20_000);

  it("a sign-in whose page hands a code back takes it from the app: the code reaches that login's own pty on the machine, the row signs in, and nothing of the code is kept", async () => {
    const PASTED = "4/0AfakeCodeFromThePage";
    const f = fake();
    await f.jobs.start({ road: "manual" });
    await f.settled();
    // Claude Code's login alone: the page it prints hands a code back, which is the road with no terminal to paste into.
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "skip", "logins/claude": "machine", "logins/codex": "skip" } });
    await expect(f.jobs.signInCode({ tool: "claude", code: PASTED })).rejects.toThrow(/no init job is running|waiting for a code/);
    const held = scriptedLink({ signedIn: true, hold: true, missing: false });
    f.setLink(held);
    await f.jobs.build({});
    const waiting = async () => {
      for (let i = 0; i < 600; i++) {
        const row = f.jobs.view()?.rows.find(r => r.id === "sign-in/claude");
        if (row?.state === SIGN_IN_OPEN_STATE && row.finish === "code") return row;
        await new Promise(r => setTimeout(r, 10));
      }
      throw new Error("the sign-in row never opened on the code road");
    };
    expect(await waiting()).toMatchObject({ page: CLAUDE_URL, finish: "code" });
    // A login on the callback road runs with a browser to find, so its page can return to the machine instead.
    expect(held.ptys.some(p => (p.created["env"] as Record<string, string> | undefined)?.["DISPLAY"] !== undefined)).toBe(true);
    await f.jobs.signInCode({ tool: "claude", code: PASTED });
    const login = held.ptys.find(p => p.writes[0]?.includes("exec claude auth login"))!;
    expect(login.writes.slice(1)).toContain(`${PASTED}\r`);
    await f.settled();
    const done = f.jobs.view()!;
    expect(done.phase).toBe("done");
    expect(done.rows.find(r => r.id === "sign-in/claude")).toMatchObject({ ...initSignInOutcome("signed-in", "darwin") });
    // The row is over: no page left to open and no code left to take.
    expect(done.rows.find(r => r.id === "sign-in/claude")).not.toHaveProperty("finish");
    // The code went to the machine and nowhere else: not a row, not the log, not an event.
    expect(JSON.stringify(f.events)).not.toContain(PASTED);
    await expect(f.jobs.signInCode({ tool: "claude", code: PASTED })).rejects.toThrow(/no init job is running/);
  });

  it("a build the network stopped says what happened in this computer's own words, keeps every stage row in its order, and closes the failed stage's block with that sentence, never the raw error", async () => {
    const f = fake({ deployDaemon: async () => Promise.reject(new Error("fetch failed; fetch failed")) });
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "machine", "logins/claude": "skip", "logins/codex": "skip" } });
    await f.jobs.build({ firstWorkspace: "e2e" });
    await f.settled();
    const view = f.jobs.view()!;
    expect(view.phase).toBe("failed");
    // The raw error, doubled by the two fetches that failed, is not the sentence a person reads.
    expect(view.error).toBe(NETWORK_LOST_LINE);
    // Every stage stays, in the build's order, with the sign-ins where they happen and the first workspace last.
    const stages = view.rows.filter(r => r.kind === "stage").map(r => r.label);
    expect(stages).toEqual(Object.values(GOLDEN_STAGE_WORDS));
    const ids = view.rows.map(r => r.id);
    expect(ids.indexOf("sign-in/gh")).toBeGreaterThan(ids.indexOf("stage/ready"));
    expect(ids.indexOf("sign-in/gh")).toBeLessThan(ids.indexOf("stage/snapshotting"));
    expect(ids.at(-1)).toBe("workspace/e2e");
    // The bar reads the stages done over all of them, so two of twelve never reads as nearly there.
    expect(initStageCount(view.rows.filter(r => r.kind === "stage"))).toEqual({ done: 1, total: 12 });
    // The stage that failed ends its block on the sentence the head shows, and the raw error reaches no row; the ones after it wait.
    const failed = view.rows.find(r => r.state === INIT_ROW_STATES.failed)!;
    expect(failed.label).toBe(GOLDEN_STAGE_WORDS["deploying-daemon"]);
    expect(failed.lines!.at(-1)).toBe(NETWORK_LOST_LINE);
    expect(JSON.stringify(view.rows)).not.toContain("fetch failed");
    expect(view.rows.find(r => r.id === "stage/snapshotting")!.state).toBe(INIT_ROW_STATES.waiting);
  });

  it("a build waiting on the account's machine cap says so on the stage's own row and carries the wait in its block", async () => {
    const f = fake();
    const made = f.backend.create.bind(f.backend);
    let refusals = 0;
    f.backend.create = async spec => {
      if (refusals < 1) {
        refusals += 1;
        throw Object.assign(new Error("Sandbox limit reached"), { kind: "concurrency", status: 429 });
      }
      return made(spec);
    };
    const waits: { state: string; lines: string[]; since: number | undefined }[] = [];
    f.onJob(job => {
      const row = job.rows.find(r => r.id === "stage/creating");
      if (row !== undefined && row.state === INIT_ROW_STATES.slot) waits.push({ state: row.state, lines: row.lines ?? [], since: row.since });
    });
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "skip", "logins/claude": "skip", "logins/codex": "skip" } });
    await f.jobs.build({});
    await f.settled();
    expect(refusals).toBe(1);
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.at(-1)!.lines.some(l => l.includes("at its machine cap"))).toBe(true);
    // The stage's clock rides the row while it runs, and leaves it once it is over.
    expect(typeof waits.at(-1)!.since).toBe("number");
    // The wait is over once the slot came free: the row is the running stage again, then done.
    expect(f.jobs.view()!.rows.find(r => r.id === "stage/creating")!.state).toBe(INIT_ROW_STATES.done);
    expect(f.jobs.view()!.rows.find(r => r.id === "stage/creating")!.since).toBeUndefined();
  });

  it("a build the person stopped says it was them, with the stage it stopped at, and the first workspace reads not made", async () => {
    const f = fake();
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "machine", "logins/claude": "skip", "logins/codex": "skip" } });
    f.setLink(scriptedLink({ signedIn: false, hold: true, missing: false }));
    await f.jobs.build({ firstWorkspace: "e2e-cancel" });
    await new Promise<void>(resolve => {
      const off = f.onJob(job => {
        if (job.rows.some(r => r.kind === "sign-in" && r.page !== undefined)) {
          off();
          resolve();
        }
      });
    });
    await f.jobs.cancel();
    await f.settled();
    const view = f.jobs.view()!;
    expect(view.phase).toBe("cancelled");
    // The run's own line for the stop, which names the stage and what became of the machine: the screen invents none.
    expect(view.error).toMatch(/^Stopped while signing in\./);
    expect(view.error).toContain("nothing is billing");
    expect(view.rows.find(r => r.id === "workspace/e2e-cancel")).toMatchObject({ state: INIT_ROW_STATES.notMade });
  });

  it("a stop that lands while a stage is running leaves that stage reading stopped, not failed, so the list agrees with the headline", async () => {
    let reached: (() => void) | undefined;
    const atStage = new Promise<void>(r => (reached = r));
    const f = fake({
      deployDaemon: async () => {
        reached!();
        // Held open so the stop lands with this stage running, which is the case the word is for.
        await new Promise(() => {});
        return "";
      },
    });
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "skip", "logins/claude": "skip", "logins/codex": "skip" } });
    await f.jobs.build({});
    await atStage;
    await f.jobs.cancel();
    await f.settled();
    const view = f.jobs.view()!;
    expect(view.phase).toBe("cancelled");
    const daemon = view.rows.find(r => r.id === "stage/deploying-daemon")!;
    expect(daemon.state).toBe(INIT_ROW_STATES.stopped);
    expect(view.rows.some(r => r.state === INIT_ROW_STATES.failed)).toBe(false);
  });

  it("a stop the provider would not take the kill for leaves a row saying the machine is still running, and the kill is tried again until it lands", async () => {
    const f = fake();
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "machine", "logins/claude": "skip", "logins/codex": "skip" } });
    f.setLink(scriptedLink({ signedIn: false, hold: true, missing: false }));
    await f.jobs.build({});
    await new Promise<void>(resolve => {
      const off = f.onJob(job => {
        if (job.rows.some(r => r.kind === "sign-in" && r.page !== undefined)) {
          off();
          resolve();
        }
      });
    });
    // The network is gone for the stop's own delete, and comes back a moment later.
    const builder = f.backend.machines.find(m => !m.killed)!;
    const real = builder.kill.bind(builder);
    let outage = 2;
    builder.kill = async () => {
      if (outage > 0) {
        outage -= 1;
        throw Object.assign(new Error("getaddrinfo ENOTFOUND api.getsolari.com"), { code: "ENOTFOUND" });
      }
      await real();
    };
    await f.jobs.cancel();
    await f.settled();
    const said = f.events.map(e => e.job.rows.find(r => r.kind === "machine")).filter(r => r !== undefined).map(r => r.state);
    expect(said).toContain(INIT_ROW_STATES.retrying);
    // The row is words, not a bare provider id in a column of sentences.
    expect(f.jobs.view()!.rows.find(r => r.kind === "machine")!.label).toBe(MACHINE_ROW_LABEL);
    // The kill landed once the network was back, so the row says the machine is gone and nothing bills on.
    expect(f.jobs.view()!.rows.find(r => r.kind === "machine")).toMatchObject({ state: INIT_ROW_STATES.gone });
    expect(f.backend.machines.filter(m => !m.killed)).toHaveLength(0);
    // The stop was the person's, so the stage it ended reads stopped and wears no failure.
    expect(f.jobs.view()!.rows.find(r => r.state === INIT_ROW_STATES.failed)).toBeUndefined();
    // Nothing is left to remove, so the sidebar's keycap is back on the job.
    expect(initProgressLine(f.jobs.view()!)).not.toBe(MACHINE_SWEEP_LINE);
  });

  it("the sweep belongs to the host, not to the job that died: Start over leaves the machine's row on the new job and on the sidebar's line until the provider takes it", async () => {
    const f = fake();
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "machine", "logins/claude": "skip", "logins/codex": "skip" } });
    f.setLink(scriptedLink({ signedIn: false, hold: true, missing: false }));
    await f.jobs.build({});
    await new Promise<void>(resolve => {
      const off = f.onJob(job => {
        if (job.rows.some(r => r.kind === "sign-in" && r.page !== undefined)) {
          off();
          resolve();
        }
      });
    });
    // The stop's own delete cannot reach the provider; the sweep's next try is held open, so the machine is still
    // running while the person starts over, which is the whole of what this has to survive.
    const builder = f.backend.machines.find(m => !m.killed)!;
    const real = builder.kill.bind(builder);
    let network: (() => void) | undefined;
    const back = new Promise<void>(r => (network = r));
    let tried = 0;
    builder.kill = async () => {
      tried += 1;
      if (tried === 1) throw Object.assign(new Error("getaddrinfo ENOTFOUND api.getsolari.com"), { code: "ENOTFOUND" });
      await back;
      await real();
    };
    await f.jobs.cancel();
    // Waited on by hand, not through settled(): the sweep is held open on purpose, so the run's own promise is too.
    await new Promise<void>(resolve => {
      const off = f.onJob(job => {
        if (job.phase === "cancelled" && job.rows.some(r => r.kind === "machine" && r.state === INIT_ROW_STATES.retrying)) {
          off();
          resolve();
        }
      });
    });
    expect(f.jobs.view()!.rows.find(r => r.kind === "machine")).toMatchObject({ state: INIT_ROW_STATES.retrying });
    // Start over: a different job, and the machine that is still billing rides onto it rather than going quiet.
    const next = await f.jobs.start({ road: "manual" });
    expect(next.id).not.toBe("init_1");
    expect(next.rows.find(r => r.kind === "machine")).toMatchObject({ id: `machine/${builder.id}`, state: INIT_ROW_STATES.retrying });
    // And the sidebar's keycap says so rather than the new job's own phase.
    expect(initProgressLine(next)).toBe(MACHINE_SWEEP_LINE);
    network!();
    await f.settled();
    expect(f.jobs.view()!.rows.find(r => r.kind === "machine")).toMatchObject({ state: INIT_ROW_STATES.gone });
    expect(f.backend.machines.filter(m => !m.killed)).toHaveLength(0);
    // A sweep that ended belongs to the job it ended on and no further: the next job starts with a clean list.
    await f.jobs.cancel();
    const third = await f.jobs.start({ road: "manual" });
    expect(third.rows.find(r => r.kind === "machine")).toBeUndefined();
  });

  it("a build the network stopped leaves the builder retrying, not a stage that says the machine is gone", async () => {
    // The outage of 2026-09-10: the daemon deploy failed, and the build's own kill of the builder could not reach
    // the provider either. Live it was never retried and the machine billed until the reap loop caught it.
    const f = fake({ deployDaemon: async () => Promise.reject(new Error("fetch failed; fetch failed")) });
    const outage = downFor(f.backend, 2);
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "skip", "logins/claude": "skip", "logins/codex": "skip" } });
    await f.jobs.build({ firstWorkspace: "e2e" });
    await f.settled();
    const view = f.jobs.view()!;
    expect(view.phase).toBe("failed");
    // The stop was not the person's, so the sweep has to come off the failure itself.
    const said = f.events.map(e => e.job.rows.find(r => r.kind === "machine")).filter(r => r !== undefined).map(r => r.state);
    expect(said).toContain(INIT_ROW_STATES.retrying);
    expect(view.rows.find(r => r.kind === "machine")).toMatchObject({ id: `machine/${outage.first().id}`, state: INIT_ROW_STATES.gone });
    expect(f.backend.machines.filter(m => !m.killed)).toHaveLength(0);
  });

  it("a seal whose rollback the provider refused leaves the smoke fork retrying, and the kill lands when the network returns", async () => {
    // The second outage of the same day: the fork failed its check after the golden was promoted, and the
    // rollback's delete of the fork got ENOTFOUND three times with nothing after it.
    const f = fake();
    // Only the fork answers the smoke badly, so the seal fails exactly where it did live.
    const guest = f.backend.execImpl;
    f.backend.execImpl = (m, cmd) => (m.spec.labels?.[SMOKE_LABEL] === "1" ? { exitCode: 1, stdout: "", stderr: "the fork did not boot" } : guest(m, cmd));
    const outage = downFor(f.backend, 2, m => m.spec.labels?.[SMOKE_LABEL] === "1");
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "skip", "logins/claude": "skip", "logins/codex": "skip" } });
    await f.jobs.build({ firstWorkspace: "e2e" });
    await f.settled();
    const view = f.jobs.view()!;
    expect(view.phase).toBe("failed");
    const smoke = view.rows.find(r => r.id === "stage/smoke-forking")!;
    expect(smoke.state).toBe(INIT_ROW_STATES.failed);
    // The headline is the smoke's own sentence; the rollback's refusal is a line on the stage's block, in the provider's words, and never in the headline.
    expect(view.error).toMatch(/^golden smoke failed .*the fork did not boot$/);
    expect(view.error).not.toContain("ENOTFOUND");
    expect(smoke.lines!.at(-1)).toBe(view.error);
    expect(smoke.lines!.some(l => l.includes("could not be removed") && l.includes("getaddrinfo ENOTFOUND api.getsolari.com"))).toBe(true);
    // And in the host's run log, where every stage frame lands, in the provider's own words.
    const runLog = readFileSync(runLogPath(f.statePath), "utf8");
    expect(runLog).toContain("the machine could not be removed and bills on: getaddrinfo ENOTFOUND api.getsolari.com");
    const fork = outage.first();
    // No builder record claims a smoke fork, so the sweep reaches it as a machine of this setup and not as a builder.
    const said = f.events.map(e => e.job.rows.find(r => r.kind === "machine")).filter(r => r !== undefined).map(r => r.state);
    expect(said).toContain(INIT_ROW_STATES.retrying);
    expect(view.rows.find(r => r.kind === "machine")).toMatchObject({ id: `machine/${fork.id}`, state: INIT_ROW_STATES.gone });
    expect(f.backend.machines.filter(m => !m.killed)).toHaveLength(0);
  });

  it("one count for one build: the host's progress is the sheet's own bar, over the same rows", async () => {
    const f = fake({ deployDaemon: async () => Promise.reject(new Error("the daemon would not deploy")) });
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.answer({ screen: "logins", answers: { "logins/gh": "machine", "logins/claude": "machine", "logins/codex": "copy" } });
    await f.jobs.build({ firstWorkspace: "e2e" });
    await f.settled();
    const view = f.jobs.view()!;
    // Sign-ins, a workspace row and a failed stage all on one job: the sheet folds the sign-ins into a stage and
    // counts what is left, and the host's field is that same count, so the keycap and the bar cannot disagree.
    expect(view.rows.some(r => r.kind === "sign-in")).toBe(true);
    expect(view.rows.some(r => r.kind === "workspace")).toBe(true);
    expect(view.rows.some(r => r.state === INIT_ROW_STATES.failed)).toBe(true);
    expect(view.progress).toEqual(initStageCount(initBuildRows(view.rows).rows));
    expect(view.progress.total).toBe(13);
    // Not the row count: sixteen rows, thirteen stages, and the keycap can no longer say one while the bar says the other.
    expect(view.rows.length).toBeGreaterThan(view.progress.total);
    expect(initProgressLine(view)).not.toContain(`/${view.rows.length}`);
    // Every view the job pushed said the same, not only the last.
    for (const e of f.events) expect(e.job.progress).toEqual(initStageCount(initBuildRows(e.job.rows).rows));
  });

  it("cancel while the screens wait drops the job; a build cannot start without answers", async () => {
    const f = fake();
    await f.jobs.start({ road: "manual" });
    await f.settled();
    expect((await f.jobs.cancel()).phase).toBe("cancelled");
    await expect(f.jobs.build({})).rejects.toThrow(/no screens/);
    await expect(f.jobs.answer({ screen: "agents", ticks: [] })).rejects.toThrow(/no screens/);
  });

  it("a build on a host whose provider forks nothing is refused before anything is read into the recipe", async () => {
    // No key saved and no provider wired is what the keys step is for; the reading is the runtime's provider, so a
    // host forking containers with no key is not caught by it.
    const f = fake({ env: {}, provider: new NoProviderBackend() });
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await expect(f.jobs.build({})).rejects.toThrow(/forks no machines/);
  });

  it("Save puts the key to the provider first: a refused key is not written, nothing is wired, and the refusal carries the provider's own word", async () => {
    const f = fake({ env: {} });
    f.backend.keyRefusal = Object.assign(new Error("Unauthorized"), { kind: "auth", status: 401 });
    await expect(f.jobs.keys({ solari: "slr_live_wrong" })).rejects.toThrow(keyRefusedLine("401 Unauthorized"));
    expect(f.backend.keyChecks).toBe(1);
    // Nothing was written and no provider module was swapped in, so the setup cannot move on with a refused key.
    expect(f.saved).toEqual([]);
    expect(f.swapped).toEqual([]);
    expect((await f.jobs.get()).keys).toEqual({ solari: false });
    // The refusal's kind says the key is the person's to change, not something to press again.
    await expect(f.jobs.keys({ solari: "slr_live_wrong" })).rejects.toMatchObject({ kind: KEY_REFUSED });
    // A key the provider takes goes through the one writer as before.
    f.backend.keyRefusal = undefined;
    expect((await f.jobs.keys({ solari: "slr_live_right" })).keys).toEqual({ solari: true });
    expect(f.saved).toEqual([{ SOLARI_API_KEY: "slr_live_right" }]);
    expect(f.backend.keyChecks).toBe(3);
  });

  it("a check nothing answered says so instead of blaming the key, and its kind marks it worth pressing again", async () => {
    const f = fake({ env: {} });
    f.backend.keyRefusal = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    await expect(f.jobs.keys({ solari: "slr_live_maybe" })).rejects.toMatchObject({ message: keyUncheckedLine("fetch failed"), kind: KEY_UNCHECKED });
    expect(f.saved).toEqual([]);
    expect((await f.jobs.get()).keys).toEqual({ solari: false });
  });

  it("a saved key the provider refuses stops the build before its first stage, in the provider's words, with the keys step as the way on", async () => {
    const f = fake();
    await f.jobs.start({ road: "manual" });
    await f.settled();
    f.backend.keyRefusal = Object.assign(new Error("Unauthorized"), { kind: "auth", status: 401 });
    const building = await f.jobs.build({ firstWorkspace: "first" });
    expect(building.phase).toBe("building");
    await f.settled();
    const stopped = f.jobs.view()!;
    expect(stopped.phase).toBe("failed");
    expect(stopped.error).toBe(savedKeyRefusedLine("401 Unauthorized"));
    expect(stopped.keyRefused).toBe(true);
    // The run says the refusal and then the one way on; never the generic sentence, and never a machine, since the
    // refusal was read before anything could boot.
    const said = stopped.log.join("\n");
    expect(said).toContain(savedKeyRefusedLine("401 Unauthorized"));
    expect(said).toContain(SAVED_KEY_STOPPED_LINE);
    expect(said).not.toContain("Nothing was booted");
    expect(f.backend.machines).toEqual([]);
    expect(f.backend.keyChecks).toBe(1);
    // The rows the host leaves, which are what every client draws and what the app's fixture stands in for: the first
    // stage failed with the refusal as its line, and every row after it reads as one the build never reached.
    expect(stopped.rows.map(r => [r.id, r.state, r.detail])).toEqual(KEY_REFUSED_ROWS);
    expect(stopped.rows.find(r => r.id === "stage/creating")!.lines).toEqual([savedKeyRefusedLine("401 Unauthorized")]);
    // Nothing on it reads as work done: the count is none of them, so the bar cannot read as progress.
    const { rows } = initBuildRows(stopped.rows);
    expect(initStageCount(rows).done).toBe(0);
    expect(stopped.progress).toEqual(initStageCount(rows));
    expect(rows.find(r => r.id === SIGN_IN_STAGE_ID)!.state).toBe(INIT_ROW_STATES.skipped);
    expect(rows.map(r => r.state)).not.toContain(INIT_ROW_STATES.done);
  });

  it("a build the provider could not be asked about fails on that, and offers no key step: the saved key may be fine", async () => {
    const f = fake();
    await f.jobs.start({ road: "manual" });
    await f.settled();
    f.backend.keyRefusal = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    await f.jobs.build({});
    await f.settled();
    const stopped = f.jobs.view()!;
    expect(stopped.phase).toBe("failed");
    expect(stopped.error).toBe(keyUncheckedLine("fetch failed"));
    expect(stopped.keyRefused).toBeUndefined();
    expect(f.backend.machines).toEqual([]);
  });

  it("a key the provider takes leaves the build as it was: one check, then the first stage", async () => {
    const f = fake();
    await f.jobs.start({ road: "manual" });
    await f.settled();
    await f.jobs.build({ firstWorkspace: "first" });
    await f.settled();
    expect(f.jobs.view()!.phase).toBe("done");
    expect(f.backend.keyChecks).toBe(1);
    expect(CLOUD_SETUP_WORDS.keys.refusedSaved).toBe("Solari refused the saved key");
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

  it("an agent whose thread cannot be handed the wsp tools is refused before any thread opens, and the setup says which agents can", async () => {
    // Codex's own adapter is registered here, so the road's refusal is about the tools and not about a missing adapter.
    const f = fake({
      agents: [{ id: "claude", name: "Claude Code", found: true, configured: true }, { id: "codex", name: "Codex", found: true, configured: false }],
      adapters: { codex: () => ({ steers: false, start: () => ({ localId: "s_codex", finished: Promise.resolve({ status: "completed" as const }), interrupt: async () => {} }) }) },
    });
    await f.rt.workspaces.createLocal("this-mac");
    // Codex's adapter renders no MCP server for its CLI, so its thread would write no recipe: the road says so and
    // the picker reads the same fact off the setup.
    await expect(f.jobs.start({ road: "agent", harness: "codex" })).rejects.toThrow(noMcpServersLine("Codex"));
    expect(f.jobs.view()).toBeNull();
    expect((await f.rt.sessions.list())).toEqual([]);
    expect((await f.jobs.get()).agents).toEqual([
      { id: "claude", name: "Claude Code", configured: true, takesTools: true },
      { id: "codex", name: "Codex", configured: false, takesTools: false },
    ]);
  });

  it("a harness the runtime cannot run refuses the start in one line, and the job is not left behind", async () => {
    const f = fake();
    await f.rt.workspaces.createLocal("this-mac");
    await expect(f.jobs.start({ road: "agent", harness: "codex" })).rejects.toThrow();
    expect(f.jobs.view()).toBeNull();
  });

  it("launches the thread with the wsp server on it and the harness's bypass access, and carries the thread, its turn and its agent on the view", async () => {
    const f = fake();
    const local = await f.rt.workspaces.createLocal("this-mac");
    const started = await f.jobs.start({ road: "agent", harness: "claude" });
    const launch = f.starts[0]!;
    expect(launch.mcpServers).toEqual({ wsp: WSP_SERVER });
    expect(launch.permissionMode).toBe(harnessCatalog("claude")!.bypassMode);
    // The thread the link focuses, the turn a prompt would be answered on, and the agent a retry starts again.
    const rows = await f.rt.sessions.list(local.id);
    expect(started.thread).toEqual({ id: rows[0]!.threadId, workspaceId: local.id, session: rows[0]!.id, harness: "claude" });
    await f.settled();
  });

  it("shows the thread's own latest line: the tool it is running, and the prompt it is blocked on", async () => {
    const asks = holdingAgent();
    const f = fake({ agent: asks });
    await f.rt.workspaces.createLocal("this-mac");
    await f.jobs.start({ road: "agent", harness: "claude" });
    asks.say({ type: "turn.delta", kind: "tool_use", text: JSON.stringify({ command: "wsp recipe scan --json" }), toolName: "Bash", toolUseId: "toolu_1" });
    expect(f.jobs.view()!.line).toBe("$ wsp recipe scan --json");
    const scan = JSON.stringify({ command: "wsp recipe scan --json", description: "Read what the agents here use" });
    asks.say({ type: "permission.ask", ask: { askId: "ask_1", toolName: "Bash", input: scan, detail: "Read what the agents here use", options: [{ id: "allow", label: "Allow", effect: "allow" }] } });
    expect(f.jobs.view()!.line).toBe("Run: wsp recipe scan --json");
    asks.finish({ status: "completed", text: "done" });
    await expect(f.settled()).resolves.toBeUndefined();
  });

  it("a recipe already beside the state is not the thread's: a turn that ends without writing one fails the job and shows no screens", async () => {
    const f = fake({ writesRecipe: false });
    await f.rt.workspaces.createLocal("this-mac");
    // The first launch's own recipe, sitting where the brief tells the agent to write.
    saveSmallRecipe(smallRecipePath(f.statePath), RECIPE);
    await f.jobs.start({ road: "agent", harness: "claude" });
    await f.settled();
    const view = f.jobs.view()!;
    expect(view.phase).toBe("failed");
    expect(view.error).toBe(initAgentNoRecipeLine(smallRecipePath(f.statePath)));
    expect(view.screens).toEqual([]);
    expect(initAgentStep(view)).toBe(true);
  });

  it("the recipe file's arrival moves the setup on, with the thread's turn still running", async () => {
    const writes = holdingAgent();
    const f = fake({ agent: writes });
    await f.rt.workspaces.createLocal("this-mac");
    await f.jobs.start({ road: "agent", harness: "claude" });
    saveSmallRecipe(smallRecipePath(f.statePath), AGENT_RECIPE);
    await f.settled();
    expect(f.jobs.view()!.phase).toBe("answering");
    expect(f.jobs.view()!.screens[0]!.ticks.sort()).toEqual(["claude", "codex"]);
    expect((await f.rt.sessions.list())[0]!.status).toBe("running");
    writes.finish({ status: "completed", text: "done" });
  });

  it("the road runs twice in one job: Start over on the first pass leaves the second reading the recipe its own thread wrote, through the same phases", async () => {
    const f = fake();
    await f.rt.workspaces.createLocal("this-mac");
    await f.jobs.start({ road: "agent", harness: "claude" });
    await f.settled();
    expect(f.jobs.view()!.phase).toBe("answering");
    await f.jobs.cancel();
    const second = await f.jobs.start({ road: "agent", harness: "claude" });
    expect(second.phase).toBe("agent");
    await f.settled();
    const view = f.jobs.view()!;
    expect(view.phase).toBe("answering");
    // The second pass read its own thread's recipe: two threads ran, and the second's file arrived after its launch.
    expect(f.starts).toHaveLength(2);
    expect(view.thread!.id).not.toBe(f.events[0]!.job.thread!.id);
    expect(phases(f)).toEqual(["agent", "reading", "answering", "cancelled", "agent", "reading", "answering"]);
  });
});

describe("the init job, terminal road", () => {
  it("builds the recipe wsp init wrote beside the state on the host's own runtime, writes no wsp tools, and refuses with no recipe there", async () => {
    const f = fake();
    const path = smallRecipePath(f.statePath);
    await expect(f.jobs.start({ road: "terminal" })).rejects.toThrow(path);
    expect(f.jobs.view()).toBeNull();

    // What the terminal's own screens answered: the recipe file wsp init saves before it hands the build over.
    saveSmallRecipe(path, AGENT_RECIPE);
    const started = await f.jobs.start({ road: "terminal" });
    expect(started.road).toBe("terminal");
    await f.settled();
    const read = f.jobs.view()!;
    expect(read.phase).toBe("answering");
    // The file's ticks stand: Codex is on because that recipe says so, not because this computer's rule ticked it.
    expect(read.screens.find(s => s.id === "agents")!.ticks.sort()).toEqual(["claude", "codex"]);

    await f.jobs.build({ firstWorkspace: "beside" });
    await f.settled();
    const done = f.jobs.view()!;
    expect(done.phase).toBe("done");
    // The golden and its first workspace are on the runtime this host serves, which is the whole point of the road.
    expect(goldenHead(await f.rt.golden.get())?.version).toBe(1);
    expect((await f.rt.workspaces.list()).map(w => w.name)).toEqual(["beside"]);
    expect(done.golden).toEqual({ version: 1 });
    // wsp init wrote the tools into the agents its own screen asked about; the build writes into none.
    expect(f.installed).toEqual([]);
    expect(phases(f)).toEqual(["reading", "answering", "building", "signing-in", "sealing", "finishing", "done"]);
  });

  it("keeps the sign-in answers the terminal's own screens wrote into the recipe, and a run taken as yes signs nothing in", async () => {
    const f = fake();
    const path = smallRecipePath(f.statePath);
    // What wsp recipe --signin claude=skip wrote and wsp init --recipe read: an answer no screen here asks again.
    saveSmallRecipe(path, { ...RECIPE, rows: RECIPE.rows.map(r => (r.id === "claude" ? { ...r, signIn: "skip" as const } : r)) });
    await f.jobs.start({ road: "terminal" });
    await f.settled();
    const building = await f.jobs.build({});
    expect(building.rows.filter(r => r.kind === "sign-in").map(r => r.tool)).not.toContain("claude");
    await f.settled();
    expect(f.jobs.view()!.phase).toBe("done");
    // The file still says what the person answered: the build wrote it back as it read it.
    expect(loadRecipe(path).rows.find(r => r.id === "claude")!.signIn).toBe("skip");

    // --yes at the terminal skips the sign-ins on the machine there; through the door it means the same.
    const yes = fake();
    saveSmallRecipe(smallRecipePath(yes.statePath), RECIPE);
    await yes.jobs.start({ road: "terminal" });
    await yes.settled();
    await yes.jobs.build({ yes: true });
    await yes.settled();
    const done = yes.jobs.view()!;
    expect(done.phase).toBe("done");
    expect(done.rows.filter(r => r.kind === "sign-in").every(r => r.state === INIT_ROW_STATES.skipped)).toBe(true);
  });

  it("the provider the host wired is what may build, not a key: a host forking containers with no key builds, one with no provider prices nothing and refuses", async () => {
    // A box whose host forks Docker containers: no provider key anywhere, and the build is still its to run.
    const keyless = fake({ env: {} });
    saveSmallRecipe(smallRecipePath(keyless.statePath), RECIPE);
    expect((await keyless.jobs.get()).keys).toEqual({ solari: false });
    await keyless.jobs.start({ road: "terminal" });
    await keyless.settled();
    await keyless.jobs.build({});
    await keyless.settled();
    expect(keyless.jobs.view()!.phase).toBe("done");
    expect(goldenHead(await keyless.rt.golden.get())?.version).toBe(1);

    const none = fake({ env: {}, provider: new NoProviderBackend() });
    saveSmallRecipe(smallRecipePath(none.statePath), RECIPE);
    expect((await none.jobs.get()).pricing).toBeNull();
    await none.jobs.start({ road: "terminal" });
    await none.settled();
    await expect(none.jobs.build({})).rejects.toThrow(/forks no machines/);
    expect(none.backend.machines).toEqual([]);
  });
});
