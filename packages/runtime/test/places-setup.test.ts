// SPDX-License-Identifier: AGPL-3.0-only
// The setup job on a computer somebody owns, driven by a host over the link
// that computer holds: a pending add from the first field to its picks, the
// steps each weighed by their class, the word the row reads, and a host that
// stops in the middle of any of it. The engine's steps are a fake here; what
// is under test is the order, the state on the record and what resumes.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import {
  RecipeFile,
  absentComputer,
  floorFailedLine,
  GITHUB_SKIPPED_LINE,
  NEEDS_GITHUB_LINE,
  SETUP_LOG_TAIL_BYTES,
  SKIPPED_FOR_NOW,
  editedThereLine,
  noAgentLine,
  pendingHeldLine,
  noPendingRefusal,
  placeProvisionPaths,
  placeProvisioningLine,
  placeWord,
  probePath,
  DAEMON_VERSION,
  SIGN_IN_WAIT_MS,
  readJoinToken,
  type AgentsSignInEvent,
  type PlaceProvisionRow,
  type PlaceSetupEvent,
  type PlaceSetupStep,
  type PlaceSyncEvent,
  type PlaceView,
  type PlaceReport,
} from "@wsp/protocol";
import type { EngineStep, ProvisionPlan } from "@wsp/engine";
import type { AgentsActs, SignInRun } from "../src/agents-read.js";
import type { RecipeShelf } from "../src/runtime.js";
import { ADD_STOPPED_LINE, PlaceProvisioningError, type PlaceUndo, newPlaceKeyPair, type PlaceKeyPair, type PlaceProvisioner, type PlaceRecord, type PlaceUpdater, type PlaceUpdateRequest, type PlaceWiring } from "../src/places.js";
import { createRuntime, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { fakeCopier, LocalBackend } from "@wsp/engine";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { DOOR, joinAt, relinkAt, report, wiring } from "./place-join.js";
import { stubBackend, testPlatform } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";
import { until } from "./until.js";
import type { Clock } from "../src/clock.js";
import type { WsClient } from "./ws-client.js";

let srv: RuntimeServer | undefined;
let runtime: Runtime | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await srv?.close();
  srv = undefined;
  await runtime?.close();
  runtime = undefined;
});

/** What a computer that keeps no image answers about itself: enough for a fork's road to be asked once a setup ends. */
const FACTS = {
  offer: "docker",
  capabilities: { liveCloneForks: false, pauseMode: "memory", replacesMachine: true, previewUrls: false, signedUrls: false, callbackRelay: true, diskSnapshots: false, images: false, snapshotsAnyLife: false, snapshotListing: false, templates: false, kept: false, copies: true, ownNetwork: true, sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0 }] },
  pricing: { defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" } },
  lifecycle: { budgets: { wakeAttempts: 1, daemonAnswersMs: 30_000 } },
};

/** What the computer answers on its link: what it forks with, and every command as its daemon's exec would. */
function answersFor(cmds: string[], answer?: (cmd: string) => { exitCode: number; stdout?: string } | undefined) {
  return (c: WsClient): void => {
    c.onFrame(raw => {
      const frame = raw as unknown as Record<string, unknown>;
      if (frame["op"] === "machine.backend") return void c.say({ id: frame["id"], ok: true, ...FACTS });
      if (frame["op"] === "machine.capacity") return void c.say({ id: frame["id"], ok: true, cores: 2, memMb: 7600, memRoomMb: 6000, machineMemMb: 4096, diskFreeBytes: 19 * 1024 ** 3, images: [], machines: { running: 0, paused: 0 } });
      if (frame["op"] !== "exec") return;
      const cmd = String(frame["cmd"] ?? "");
      cmds.push(cmd);
      // gh's own status off the token the run read on its input, as gh prints it.
      const input = typeof frame["stdin"] === "string" ? Buffer.from(frame["stdin"], "base64").toString("utf8") : "";
      const said = answer?.(cmd);
      if (said !== undefined) return void c.say({ id: frame["id"], ok: true, exitCode: said.exitCode, stdout: said.stdout ?? "", stderr: "", truncated: false });
      const gh = cmd.includes("gh auth status") && input.includes("GH_TOKEN=") ? "github.com\n  - Logged in to github.com account dev (GH_TOKEN)\n  - Token scopes: 'gist', 'read:org', 'repo'\n" : "";
      c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: gh, stderr: "", truncated: false });
    });
  };
}

/** What a computer on this host's own daemon reports, so no row reads behind for the daemon. */
const CURRENT = report("spoo", { daemonVersion: DAEMON_VERSION });

const LAPTOP = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" }, codex: { signin: "machine" } }, clis: { gh: { via: "brew" } } });

/** The plan the fake planner answers: one agent install, then a CLI. */
const PLAN: ProvisionPlan = {
  recipeAt: "laptop",
  path: probePath("/root"),
  steps: [
    { id: "agents/claude", label: "Claude Code", manager: "script", cmd: "claude-step" },
    { id: "tools/brew/gh", label: "GitHub CLI", manager: "brew", cmd: "gh-step" },
  ],
  agents: 1,
  compiler: false,
  skipped: [],
};

const ROWS: Partial<Record<EngineStep, PlaceProvisionRow[]>> = {
  agents: [{ id: "agents/claude", label: "Claude Code", outcome: "installed" }],
  clis: [{ id: "tools/brew/gh", label: "GitHub CLI", outcome: "installed" }],
};

/** A planner and the engine's steps as the host wires them, each step's rows under this test's hand: which steps
 * ran, in order, and a step held until the test lets it go. */
function provisioner(o: { rows?: Partial<Record<EngineStep, PlaceProvisionRow[]>>; hold?: EngineStep; holds?: EngineStep[]; throws?: { step: EngineStep; error: Error }; undo?: (removed: readonly { kind: string; name: string }[]) => PlaceUndo[] } = {}) {
  let release = (): void => {};
  const held = new Promise<void>(resolve => (release = resolve));
  const each = new Map<EngineStep, { at: Promise<void>; let: () => void }>();
  const arm = (step: EngineStep): void => {
    let let_ = (): void => {};
    const at = new Promise<void>(resolve => (let_ = resolve));
    each.set(step, { at, let: let_ });
  };
  for (const step of o.holds ?? []) arm(step);
  const ran: EngineStep[] = [];
  const floors: string[] = [];
  const picked: RecipeFile[] = [];
  const rows = { ...ROWS, ...o.rows };
  const wired: PlaceProvisioner = {
    plan: async () => ({ noRecipe: "/nowhere/recipe.json" }),
    setup: async picks => {
      picked.push(picks);
      return PLAN;
    },
    floor: async (_machine, on) => {
      floors.push(on.home);
      return [];
    },
    step: async (_machine, _plan, step, _run, stage) => {
      ran.push(step);
      stage(`${step} under way`);
      if (o.hold === step) await held;
      await each.get(step)?.at;
      if (o.throws?.step === step) throw o.throws.error;
      return rows[step] ?? [];
    },
    estimate: async picks => ({ bytes: Object.keys(picks.agents).length * 1024 ** 3, unmeasured: Object.keys(picks.plugins).length }),
    undo: async (before, removed) => {
      undone.push({ before, removed: removed.map(r => `${r.kind}/${r.name}`) });
      return o.undo?.(removed) ?? [];
    },
  };
  const undone: { before: RecipeFile; removed: string[] }[] = [];
  return { wired, ran, floors, picked, undone, release: () => release(), let: (step: EngineStep) => each.get(step)?.let(), arm };
}

/** Sign-ins as the app's own road runs them, each waiting on the test: the page and the code, then the end. */
function signIns() {
  const started: string[] = [];
  const stopped: string[] = [];
  const ends = new Map<string, (e: Pick<AgentsSignInEvent, "state" | "said">) => void>();
  const acts: AgentsActs = {
    signInLine: async () => ({ command: "codex login" }),
    signIn: async (_on, ask) => async (run: SignInRun) => {
      started.push(ask.agent);
      void run.stop.then(() => stopped.push(ask.agent));
      run.emit({ state: "running" });
      run.emit({ state: "waiting", url: `https://auth.example/${ask.agent}/${started.length}`, code: `CODE-${started.length}` });
      const end = await new Promise<Pick<AgentsSignInEvent, "state" | "said">>(resolve => ends.set(ask.agent, resolve));
      run.emit(end);
    },
    key: async () => {},
    addTools: async () => ({ file: "" }),
  };
  return { acts, started, stopped, end: (agent: string, e: Pick<AgentsSignInEvent, "state" | "said">) => ends.get(agent)?.(e) };
}

/** A host with the setup wired, serving, and the road an add takes onto a computer that joins over the link. */
async function hosting(o: { provision: PlaceProvisioner; recipes?: RecipeShelf; store?: Store; cmds?: string[]; answer?: (cmd: string) => { exitCode: number; stdout?: string } | undefined; local?: boolean; acts?: AgentsActs; vault?: Record<string, string>; report?: PlaceReport; install?: PlaceWiring["install"]; undo?: PlaceWiring["undo"]; hostKey?: PlaceKeyPair; clock?: Clock; update?: PlaceUpdater }): Promise<{ hostKey: PlaceKeyPair; store: Store; frames: PlaceSetupEvent[]; joined: { placeId: string; pair: PlaceKeyPair }[] }> {
  const hostKey = o.hostKey ?? newPlaceKeyPair();
  const joined: { placeId: string; pair: PlaceKeyPair }[] = [];
  const store = o.store ?? memoryStore();
  const answers = answersFor(o.cmds ?? [], o.answer);
  runtime = createRuntime({
    backend: stubBackend(),
    store,
    adapters: {},
    ...(o.clock !== undefined ? { clock: o.clock } : {}),
    ...(o.acts !== undefined ? { agentsActs: o.acts } : {}),
    ...(o.local === true ? { local: localWiring() } : {}),
    ...(o.recipes !== undefined ? { recipes: o.recipes } : {}),
    vault: () => o.vault ?? { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" },
    placeLinks: {
      ...wiring(hostKey, undefined, o.update),
      provision: o.provision,
      ...(o.undo !== undefined ? { undo: o.undo } : {}),
      install:
        o.install ??
        (async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          stage("check", "running");
          stage("check", "done", "root, systemd, cgroup v2");
          await req.beforeDeploy?.("undo-script", "root@10.0.0.9");
          const { client, placeId, pair } = await joinAt(srv!.port, hostKey, { code: readJoinToken(req.code).code, name: "spoo", report: o.report ?? CURRENT, proveReport: o.report ?? CURRENT, answers });
          sockets.push(client.ws);
          joined.push({ placeId, pair });
          return { name: "spoo", ssh: "root@10.0.0.9" };
        }),
    },
  });
  const frames: PlaceSetupEvent[] = [];
  runtime.events.on("place.setup", e => void frames.push(e as PlaceSetupEvent));
  syncs.length = 0;
  runtime.events.on("place.sync", e => void syncs.push(e as PlaceSyncEvent));
  srv = await serveRuntime(runtime, { port: 0, authToken: "host-token", devices: runtime.devices });
  return { hostKey, store, frames, joined };
}

/** The computer's own daemon dialling this host again with the key it joined with, answering its link as before. */
async function dialsBack(hostKey: PlaceKeyPair, placeId: string, pair: PlaceKeyPair, cmds: string[] = []): Promise<void> {
  const { client, proved } = await relinkAt(srv!.port, hostKey, placeId, pair, CURRENT, answersFor(cmds));
  expect(proved.ok, String(proved["error"])).toBe(true);
  sockets.push(client.ws);
}

/** Stops this host as a process that ends would, its sockets with it. */
async function stopHost(): Promise<void> {
  for (const ws of sockets.splice(0)) ws.close();
  await srv!.close();
  await runtime!.close();
  srv = undefined;
  runtime = undefined;
}

/** This computer as a host reads it, so a folder's own remote is read off git here. */
function localWiring(): LocalWiring {
  const root = mkdtempSync(join(tmpdir(), "wsp-setup-local-"));
  repos.push(root);
  return {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    platform: testPlatform(),
    copier: fakeCopier(),
  };
}

/** A folder on this computer whose origin is a repository on GitHub. */
function privateRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-setup-repo-"));
  repos.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/private.git"]);
  return dir;
}
const repos: string[] = [];
afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every sync frame the host running now put on its stream. */
const syncs: PlaceSyncEvent[] = [];

/** One saved recipe as this computer resolves it, which the test moves between syncs. */
function shelf(file: RecipeFile, items: Record<string, string>) {
  let now = { file, items, hash: "h1" };
  let resolves = 0;
  const recipes: RecipeShelf = {
    list: async () => [{ slug: "laptop", file: now.file }],
    read: async () => ({ slug: "laptop", file: now.file }),
    get: async () => ({ slug: "laptop", file: now.file, hash: now.hash }),
    save: async () => ({ slug: "laptop", file: now.file }),
    remove: async () => ({ slug: "laptop", file: now.file }),
    options: async () => ({ agents: [], mcp: [], clis: [], skills: [], plugins: [], configs: [] }),
    resolve: async () => {
      resolves++;
      return now;
    },
  };
  return { recipes, move: (next: RecipeFile, nextItems: Record<string, string>, hash: string) => void (now = { file: next, items: nextItems, hash }), resolves: () => resolves };
}

const rowOf = async (placeId: string): Promise<PlaceView> => (await runtime!.places!.list(Date.now())).find(p => p.id === placeId)!;
const ended = (frames: readonly PlaceSetupEvent[]): PlaceSetupEvent[] => frames.filter(f => f.end !== undefined);

describe("an update of a computer already set up", () => {
  it("asks the updater every time, with a binary only where the computer is behind, and runs its setup again", async () => {
    const asked: PlaceUpdateRequest[] = [];
    const p = provisioner();
    await hosting({ provision: p.wired, update: async req => void asked.push(req) });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const answer = await runtime!.places!.update(place.id);
    expect(asked).toEqual([expect.objectContaining({ name: "spoo", daemon: false })]);
    // Nothing landed, so no dial-back was waited for and the answer carries no daemon, only the setup run again.
    expect(answer.daemon).toBeUndefined();
    expect(answer.setup?.state).toBe("running");
    await until(() => p.ran.filter(s => s === "floor").length === 2);
  });

  it("puts a binary only on a computer whose daemon is behind", async () => {
    const asked: PlaceUpdateRequest[] = [];
    const { hostKey, joined } = await hosting({ provision: provisioner().wired, report: { ...CURRENT, daemonVersion: DAEMON_VERSION - 1 }, update: async req => (asked.push(req), { road: "ssh", at: "/root/.wsp/daemon/wsp-daemon" }) });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const moving = runtime!.places!.update(place.id);
    await until(() => asked.length === 1);
    // The new daemon dials back on its own, which is what the update waits for.
    for (const ws of sockets.splice(0)) ws.close();
    await dialsBack(hostKey, place.id, joined[0]!.pair);
    const moved = await moving;
    expect(asked).toEqual([expect.objectContaining({ name: "spoo", daemon: true })]);
    expect(moved.daemon).toMatchObject({ from: DAEMON_VERSION - 1, road: "ssh" });
  });
});

describe("a computer added with its picks", () => {
  it("runs the floor and the agents first, starts the sign-ins, then the rest, and writes every step and its rows on the record", async () => {
    const p = provisioner();
    const s = signIns();
    const { frames } = await hosting({ provision: p.wired, acts: s.acts });
    const added = await runtime!.places!.add({ addId: "a_mine", address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP, recipe: "laptop" }, Date.now());
    const placeId = added.place.id;
    // The reply already says a setup is under way, so whoever asked knows there is one to follow, and no add is pending.
    expect(added.place.setup?.state).toBe("running");
    expect(added.pending).toBeUndefined();
    expect(await runtime!.places!.pending()).toEqual([]);
    await until(async () => (await rowOf(placeId)).setup?.waiting.some(w => w.url !== undefined) === true);
    expect(p.picked).toEqual([LAPTOP]);
    // The machine sign-in waits on the person with its page and its code; the vault's is a row already.
    const waiting = (await rowOf(placeId)).setup!.waiting;
    expect(waiting).toEqual([expect.objectContaining({ row: "signins/codex", label: "Codex", url: "https://auth.example/codex/1", code: "CODE-1", state: "waiting" })]);
    await until(async () => (await rowOf(placeId)).setup?.state === "done");
    // The skills beside the agents, since they share no lane; the CLIs after the agents on the installs lane.
    expect(p.ran).toEqual(["floor", "agents", "skills", "clis", "mcp", "configs", "plugins", "context"]);
    const row = await rowOf(placeId);
    expect(row.picks).toEqual(LAPTOP);
    expect(row.recipe).toBe("laptop");
    // Every step ended once, each after what it waits on.
    const lines = row.setup!.steps.map(l => l.step);
    expect([...lines].sort()).toEqual(["agents", "clis", "configs", "context", "floor", "folders", "github", "mcp", "plugins", "signins", "skills"]);
    expect(row.setup!.steps.every(l => l.state === "done")).toBe(true);
    const before = (a: PlaceSetupStep, b: PlaceSetupStep): boolean => lines.indexOf(a) < lines.indexOf(b);
    expect([before("floor", "agents"), before("agents", "clis"), before("clis", "mcp"), before("mcp", "plugins"), before("github", "folders"), before("folders", "context")]).toEqual([true, true, true, true, true, true]);
    expect(row.setup!.steps.every(l => typeof l.ms === "number")).toBe(true);
    expect(row.applied?.rows.map(r => [r.id, r.step, r.outcome])).toEqual([
      ["agents/claude", "agents", "installed"],
      ["signins/claude", "signins", "present"],
      ["tools/brew/gh", "clis", "installed"],
    ]);
    // A sign-in waits on the person, so the end says so and the word is theirs.
    expect(ended(frames).map(f => f.end)).toEqual(["needs-you"]);
    expect(placeWord(row, null).word).toBe("Needs you");
    // The person finishes it; the row lands, the wait goes, and the setup says it is ready.
    s.end("codex", { state: "signed-in" });
    await until(async () => (await rowOf(placeId)).setup?.waiting.length === 0);
    await until(() => ended(frames).length === 2);
    expect(ended(frames).map(f => f.end)).toEqual(["needs-you", "ready"]);
    expect((await rowOf(placeId)).applied?.rows.find(r => r.id === "signins/codex")).toMatchObject({ outcome: "installed", step: "signins" });
    expect(placeWord(await rowOf(placeId), null).word).toBe("Ready");
  });

  it("stops at a floor that failed, says why, and runs nothing after it", async () => {
    const p = provisioner({ rows: { floor: [{ id: "base/curl", label: "curl", outcome: "failed", note: "apt exited 100" }] } });
    const { frames } = await hosting({ provision: p.wired });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "failed");
    expect(p.ran).toEqual(["floor"]);
    const said = floorFailedLine([{ label: "curl" }]);
    expect((await rowOf(place.id)).setup?.said).toBe(said);
    expect(placeWord(await rowOf(place.id), null)).toEqual({ word: "Setup failed", sentence: said });
    expect(ended(frames)).toEqual([expect.objectContaining({ end: "failed", said })]);
  });

  it("stops when every agent failed, and goes on when one of them did", async () => {
    const none = provisioner({ rows: { agents: [{ id: "agents/claude", label: "Claude Code", outcome: "failed", note: "exit 1" }] } });
    await hosting({ provision: none.wired });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "failed");
    // The skills ran beside the agents; nothing that waits on the agents started.
    expect(none.ran).toEqual(["floor", "agents", "skills"]);
    expect((await rowOf(place.id)).setup?.said).toBe(noAgentLine([{ label: "Claude Code", note: "exit 1" }]));
  });

  it("finishes past a CLI that failed with the row standing for a retry, and reads Ready", async () => {
    const p = provisioner({ rows: { clis: [{ id: "tools/brew/gh", label: "GitHub CLI", outcome: "failed", note: "no bottle" }] } });
    const { frames } = await hosting({ provision: p.wired });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: { ...LAPTOP, agents: { claude: { signin: "vault" } } } }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const row = await rowOf(place.id);
    expect(row.applied?.rows.find(r => r.id === "tools/brew/gh")).toMatchObject({ outcome: "failed", step: "clis" });
    expect(row.setup?.steps.find(l => l.step === "clis")).toMatchObject({ state: "failed", note: "1 of 1 failed" });
    expect(placeWord(row, null).word).toBe("Ready");
    expect(ended(frames)).toEqual([expect.objectContaining({ end: "ready", said: "1 row did not install" })]);
  });

  it("signs GitHub in from the vault on the run's input alone, and names the token's scopes on its row", async () => {
    const cmds: string[] = [];
    await hosting({ provision: provisioner().wired, cmds, vault: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", GH_TOKEN: "ghp_vaulted" } });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, configs: { github: { signin: "vault" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "github")).toMatchObject({ outcome: "present", note: expect.stringContaining("token scopes: gist, read:org, repo") });
    expect(cmds.join("\n")).not.toContain("ghp_vaulted");
  });

  it("reads Needs you where a folder did not move, and the GitHub row where the vault holds no token", async () => {
    const p = provisioner();
    const { frames } = await hosting({ provision: p.wired });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { gone: { from: "/nowhere/at/all", keep: [] } }, configs: { github: { signin: "vault" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const row = await rowOf(place.id);
    expect(row.applied?.rows.filter(r => r.outcome === "failed").map(r => [r.id, r.step])).toEqual([
      ["github", "github"],
      ["folders/gone", "folders"],
    ]);
    expect(placeWord(row, null).word).toBe("Needs you");
    expect(ended(frames)[0]?.end).toBe("needs-you");
  });

  it("runs the steps after the base tools at once as wide as the box's memory allows, every line naming the steps running", async () => {
    const p = provisioner({ holds: ["agents", "skills"] });
    const { frames } = await hosting({ provision: p.wired });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(() => p.ran.includes("skills"));
    // A 4 GB box takes two at once: the agents on the installs lane, the skills on the files lane.
    expect(p.ran).toEqual(["floor", "agents", "skills"]);
    expect(frames.at(-1)?.running).toEqual(["agents", "skills"]);
    p.let("agents");
    p.let("skills");
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    // Every frame names no more than two heavy steps, the sign-ins aside, since they start and wait on the person.
    const widest = Math.max(...frames.flatMap(f => (f.running === undefined ? [] : [f.running.filter(r => r !== "signins").length])));
    expect(widest).toBe(2);
  });

  it("runs one step at a time on a box under 4 GB", async () => {
    const p = provisioner({ holds: ["agents"] });
    const { frames } = await hosting({ provision: p.wired, report: { ...CURRENT, shape: { cpu: 1, memMb: 2048 } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(() => p.ran.includes("agents"));
    await new Promise(r => setTimeout(r, 20));
    expect(p.ran).toEqual(["floor", "agents"]);
    p.let("agents");
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(Math.max(...frames.flatMap(f => (f.running === undefined ? [] : [f.running.filter(r => r !== "signins").length])))).toBe(1);
  });

  it("skips GitHub where the person said so, and a private folder reads as needing GitHub with nothing cloned", async () => {
    const cmds: string[] = [];
    const repo = privateRepo();
    await hosting({ local: true, provision: provisioner().wired, cmds, answer: cmd => (cmd.includes("ls-remote") ? { exitCode: 128 } : undefined) });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: repo, keep: [] } }, configs: { github: { signin: "skip" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const row = await rowOf(place.id);
    expect(row.applied?.rows.find(r => r.id === "github")).toMatchObject({ outcome: "skipped", note: GITHUB_SKIPPED_LINE });
    expect(row.applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "failed", note: NEEDS_GITHUB_LINE });
    // The anonymous read asked GitHub over https with no credential helper; nothing was cloned and no gh was put on.
    expect(cmds.find(c => c.includes("ls-remote"))).toContain("https://github.com/acme/private.git");
    expect(cmds.find(c => c.includes("ls-remote"))).toContain("credential.helper=");
    expect(cmds.some(c => c.includes("clone"))).toBe(false);
    expect(placeWord(row, null).word).toBe("Needs you");
  });

  it("signs GitHub in on the box through the relay, and a private folder waits for it and clones once the person is through", async () => {
    const s = signIns();
    const repo = privateRepo();
    const cmds: string[] = [];
    await hosting({ local: true, provision: provisioner().wired, acts: s.acts, cmds, answer: cmd => (cmd.includes("ls-remote") ? { exitCode: 128 } : undefined) });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: repo, keep: [] } }, configs: { github: { signin: "machine" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    // gh's own login, one page and one code, on the row the GitHub step stands on.
    expect(s.started).toEqual(["gh"]);
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code !== undefined) === true);
    expect((await rowOf(place.id)).setup?.waiting).toEqual([expect.objectContaining({ row: "github", label: "GitHub", url: "https://auth.example/gh/1", code: "CODE-1" })]);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")).toBeUndefined();
    expect(placeWord(await rowOf(place.id), null).word).toBe("Needs you");
    s.end("gh", { state: "signed-in" });
    await until(async () => (await rowOf(place.id)).applied?.rows.some(r => r.id === "folders/app") === true);
    const row = await rowOf(place.id);
    expect(row.applied?.rows.find(r => r.id === "github")).toMatchObject({ outcome: "installed", step: "github" });
    expect(row.applied?.rows.find(r => r.id === "folders/app")?.note).not.toBe(NEEDS_GITHUB_LINE);
    expect(row.setup?.waiting).toEqual([]);
  });

  it("reads a private folder as needing GitHub once the GitHub sign-in on the box failed", async () => {
    const s = signIns();
    const repo = privateRepo();
    await hosting({ local: true, provision: provisioner().wired, acts: s.acts, answer: cmd => (cmd.includes("ls-remote") ? { exitCode: 128 } : undefined) });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: repo, keep: [] } }, configs: { github: { signin: "machine" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code !== undefined) === true);
    s.end("gh", { state: "failed", said: "gh refused" });
    await until(async () => (await rowOf(place.id)).applied?.rows.some(r => r.id === "folders/app") === true);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "failed", note: NEEDS_GITHUB_LINE, step: "folders" });
  });

  it("refuses a fork there while it runs, naming the step, and takes one once it is done", async () => {
    const p = provisioner({ hold: "clis" });
    await hosting({ provision: p.wired });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(() => p.ran.includes("clis"));
    const refused = await runtime!.places!.forkingBackend(place.id).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(PlaceProvisioningError);
    expect(refused).toMatchObject({ kind: "conflict", message: placeProvisioningLine("spoo", "clis") });
    // Asked again with nothing new, it answers the run under way to follow; new picks are what it refuses.
    const followed = await runtime!.places!.setUp(place.id, {});
    expect([followed.setup?.state, followed.addId]).toEqual(["running", (await rowOf(place.id)).setup?.addId]);
    await expect(runtime!.places!.setUp(place.id, { choices: LAPTOP })).rejects.toThrow(placeProvisioningLine("spoo", "clis"));
    expect(p.ran.filter(s => s === "floor")).toHaveLength(1);
    p.release();
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(await runtime!.places!.forkingBackend(place.id)).toBeDefined();
  });

  it("tags each line of its log on that computer with its step, and reads a step's lines back off the end of that log", async () => {
    const cmds: string[] = [];
    const at = placeProvisionPaths("/home/maya");
    const tail = ["2026-10-04T10:00:00Z [floor] apt-get install curl", "2026-10-04T10:00:01Z [clis] brew install gh", "2026-10-04T10:00:02Z [clis] the CLIs: done"].join("\n");
    await hosting({ provision: provisioner().wired, cmds, answer: cmd => (cmd.startsWith("tail -c") ? { exitCode: 0, stdout: `${tail}\n` } : undefined) });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await until(() => cmds.some(c => c.includes(at.result)));
    const written = (cmd: string): string => Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(cmd)![1]!, "base64").toString("utf8");
    const lines = cmds.filter(c => c.includes(at.log) && c.includes("printf")).flatMap(c => written(c).split("\n")).filter(l => l !== "");
    expect(lines.some(l => / \[clis\] clis under way$/.test(l))).toBe(true);
    expect(lines.some(l => / \[clis\] the CLIs: done$/.test(l))).toBe(true);
    expect(await runtime!.places!.setupLog(place.id, "clis")).toEqual(["2026-10-04T10:00:01Z [clis] brew install gh", "2026-10-04T10:00:02Z [clis] the CLIs: done"]);
    expect(await runtime!.places!.setupLog(place.id)).toHaveLength(3);
    expect(cmds.find(c => c.startsWith("tail -c"))).toBe(`tail -c ${SETUP_LOG_TAIL_BYTES} '${at.log}' 2>/dev/null`);
  });

  it("keeps its own log on that computer, every line stamped, and the setup's outcome beside it", async () => {
    const cmds: string[] = [];
    const p = provisioner();
    await hosting({ provision: p.wired, cmds });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const at = placeProvisionPaths("/home/maya");
    await until(() => cmds.some(c => c.includes(at.result)));
    const written = (cmd: string): string => Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(cmd)![1]!, "base64").toString("utf8");
    const lines = cmds.filter(c => c.includes(at.log)).flatMap(c => written(c).split("\n")).filter(l => l !== "");
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z wsp zingzys-mac set up spoo from laptop at /);
    expect(lines.some(l => l.endsWith("clis under way"))).toBe(true);
    expect(lines.some(l => l.endsWith("the CLIs: done"))).toBe(true);
  });
});

describe("a computer added before anything is picked", () => {
  it("joins as a pending add, puts the floor on while the person chooses, and waits at choosing", async () => {
    const p = provisioner();
    const { store } = await hosting({ provision: p.wired });
    const added = await runtime!.places!.add({ addId: "a_wait", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    expect(added.pending).toMatchObject({ id: "a_wait", placeId: added.place.id, step: "floor" });
    await until(async () => (await runtime!.places!.pending())[0]?.step === "choosing");
    expect(p.floors).toEqual(["/home/maya"]);
    expect(p.ran).toEqual([]);
    // What a client reads names no key file and no undo: those stay in the store.
    const [pending] = await runtime!.places!.pending();
    expect(pending).not.toHaveProperty("undo");
    expect((await store.get("pending-computers", "a_wait")) as { undo?: string }).toMatchObject({ undo: "undo-script", login: "root@10.0.0.9" });
  });

  it("keeps the choices through a host restart, refuses a resume with nothing chosen, and sets up from them at the resume", async () => {
    const p = provisioner();
    const store = memoryStore();
    const first = await hosting({ provision: p.wired, store });
    const { place } = await runtime!.places!.add({ addId: "a_wait", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    await until(async () => (await runtime!.places!.pending())[0]?.step === "choosing");
    const held = (await store.get("pending-computers", "a_wait")) as Record<string, unknown>;
    await stopHost();
    const again = provisioner();
    await hosting({ provision: again.wired, store, hostKey: first.hostKey });
    await dialsBack(first.hostKey, place.id, first.joined[0]!.pair);
    expect((await runtime!.places!.pending()).map(x => [x.id, x.step, x.placeId])).toEqual([["a_wait", "choosing", place.id]]);
    // Nothing chosen and no recipe is the person's to finish: the resume says so and leaves the add standing.
    await expect(runtime!.places!.setUp(place.id, {})).rejects.toThrow("spoo has nothing picked to go on it");
    expect(await runtime!.places!.pending()).toHaveLength(1);
    // The person picked in the app before closing it: the choices stand on the pending add, and the resume reads them.
    await store.put("pending-computers", "a_wait", { ...held, choices: LAPTOP, recipe: "laptop" });
    const set = await runtime!.places!.setUp("root@10.0.0.9", {});
    expect(set.setup?.state).toBe("running");
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(again.picked).toEqual([LAPTOP]);
    expect((await rowOf(place.id)).recipe).toBe("laptop");
    expect(await runtime!.places!.pending()).toEqual([]);
  });

  it("keeps the picks the person made so far on the pending add, says so on its stream, and sets up from them", async () => {
    const p = provisioner();
    await hosting({ provision: p.wired });
    const pendings: unknown[] = [];
    runtime!.events.on("place.pending", e => void pendings.push(e));
    const { place } = await runtime!.places!.add({ addId: "a_wait", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    await until(async () => (await runtime!.places!.pending())[0]?.step === "choosing");
    const kept = await runtime!.places!.choose(place.id, LAPTOP, "laptop");
    expect(kept).toMatchObject({ id: "a_wait", step: "choosing", recipe: "laptop", choices: LAPTOP });
    expect(pendings.at(-1)).toMatchObject({ type: "place.pending", id: "a_wait", pending: { choices: LAPTOP } });
    // Picks kept with no recipe named drop the one they started from: the person moved off it.
    expect(await runtime!.places!.choose("root@10.0.0.9", LAPTOP)).not.toHaveProperty("recipe");
    await expect(runtime!.places!.choose("nowhere", LAPTOP)).rejects.toThrow(noPendingRefusal("nowhere"));
    const set = await runtime!.places!.setUp(place.id, {});
    expect(set.setup?.state).toBe("running");
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(p.picked).toEqual([LAPTOP]);
  });

  it("refuses a second add to an address while the first stands", async () => {
    const p = provisioner();
    await hosting({ provision: p.wired });
    await runtime!.places!.add({ addId: "a_wait", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    await until(async () => (await runtime!.places!.pending())[0]?.step === "choosing");
    await expect(runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow(pendingHeldLine("root@10.0.0.9", "choosing"));
  });

  it("keeps a refusal at the checks on the pending add, read as Setup failed, and a second add takes its place", async () => {
    const p = provisioner();
    await hosting({
      provision: p.wired,
      install: async (_req, stage) => {
        stage("connect", "done");
        stage("check", "running");
        throw new Error("root@10.0.0.9 runs no systemd, which is what keeps wsp's daemon up there");
      },
    });
    await expect(runtime!.places!.add({ addId: "a_one", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow("runs no systemd");
    expect(await runtime!.places!.pending()).toEqual([expect.objectContaining({ id: "a_one", step: "check", failed: { said: "root@10.0.0.9 runs no systemd, which is what keeps wsp's daemon up there" } })]);
    await expect(runtime!.places!.add({ addId: "a_two", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now())).rejects.toThrow("runs no systemd");
    expect((await runtime!.places!.pending()).map(x => x.id)).toEqual(["a_two"]);
  });
});

describe("a host that stops in the middle of a setup", () => {
  /** A record of a computer joined over ssh, as the store keeps one. */
  const record = (over: Partial<PlaceRecord> = {}): PlaceRecord => {
    const at = new Date().toISOString();
    return { id: "p_spoo", name: "spoo", publicKey: newPlaceKeyPair().publicKey, joinedAt: at, lastSeenAt: at, report: report("spoo"), road: { ssh: "root@10.0.0.9" }, ...over };
  };

  it("finishes an add it stopped while wsp went on into the join that landed, or takes the install back", async () => {
    const store = memoryStore();
    const pending = (id: string, login: string) => ({ id, address: login, step: "wsp", choices: LAPTOP, startedAt: new Date().toISOString(), undo: `undo ${id}`, login });
    await store.put("places", "p_spoo", record());
    await store.put("pending-computers", "a_joined", pending("a_joined", "root@10.0.0.9"));
    await store.put("pending-computers", "a_lost", pending("a_lost", "root@10.0.0.7"));
    const undone: [string, string][] = [];
    await hosting({ provision: provisioner().wired, store, undo: async (login, script) => void undone.push([login.ssh, script]) });
    // The one hydration every road waits on, which is what a host does before it serves anything.
    await runtime!.workspaces.list();
    await until(async () => (await runtime!.places!.pending()).some(p => p.id === "a_lost" && p.failed !== undefined));
    const now = await runtime!.places!.pending();
    expect(now.find(p => p.id === "a_joined")).toMatchObject({ placeId: "p_spoo", step: "floor" });
    expect(now.find(p => p.id === "a_lost")).toMatchObject({ failed: { said: ADD_STOPPED_LINE } });
    expect(undone).toEqual([["root@10.0.0.7", "undo a_lost"]]);
  });

  it("resumes at the computer's next link, redoing no step that ended and asking a waiting sign-in for a fresh code", async () => {
    const store = memoryStore();
    const s1 = signIns();
    const first = await hosting({ provision: provisioner().wired, store, acts: s1.acts });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code === "CODE-1") === true);
    // Written back as a host that stopped after the sign-ins started would have left it: the clis never ran.
    const held = (await store.get("places", place.id)) as PlaceRecord;
    const steps = held.setup!.steps.filter(l => ["floor", "agents", "signins"].includes(l.step));
    await store.put("places", place.id, { ...held, setup: { ...held.setup!, state: "running", steps, finishedAt: undefined } });
    await stopHost();
    const again = provisioner();
    const s2 = signIns();
    await hosting({ provision: again.wired, store, acts: s2.acts, hostKey: first.hostKey });
    // Nothing resumes before that computer can be reached: the row still reads the setup running, and a fork waits.
    expect((await rowOf(place.id)).setup?.state).toBe("running");
    expect(again.ran).toEqual([]);
    await expect(runtime!.places!.forkingBackend(place.id)).rejects.toThrow("is still being set up");
    await dialsBack(first.hostKey, place.id, first.joined[0]!.pair);
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(again.ran).toEqual(["skills", "clis", "mcp", "configs", "plugins", "context"]);
    // The sign-in that waited is run again for a fresh page, never waited on.
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.url !== undefined) === true);
    expect(s2.started).toEqual(["codex"]);
    expect((await rowOf(place.id)).setup?.waiting).toEqual([expect.objectContaining({ row: "signins/codex", url: "https://auth.example/codex/1", code: "CODE-1" })]);
  });

  it("hands a sign-in still waiting to the retry that takes it over, so the old run writes nothing once it lands", async () => {
    const s = signIns();
    const { frames } = await hosting({ provision: provisioner().wired, acts: s.acts });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.url !== undefined) === true);
    const first = (await rowOf(place.id)).setup!.addId;
    const retried = await runtime!.places!.setUp(place.id, {});
    await until(async () => (await rowOf(place.id)).setup?.state === "done" && (await rowOf(place.id)).setup?.addId === retried.addId);
    // The retry followed the relay still waiting: one login, its page and code as they were.
    expect(s.started).toEqual(["codex"]);
    expect((await rowOf(place.id)).setup?.waiting[0]?.code).toBe("CODE-1");
    const heard = frames.length;
    s.end("codex", { state: "signed-in" });
    await until(async () => (await rowOf(place.id)).setup?.waiting.length === 0);
    await until(() => frames.slice(heard).some(f => f.addId === retried.addId && f.end !== undefined));
    expect(frames.slice(heard).filter(f => f.addId === first)).toEqual([]);
  });

  it("reads a sign-in whose page ran out as expired, and a retry runs the login again for a fresh code", async () => {
    const fc = fakeClock();
    const s = signIns();
    const p = provisioner();
    await hosting({ provision: p.wired, acts: s.acts, clock: fc.clock });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.url !== undefined) === true);
    // The relay gives up when the page has run out, which is past the wait's own end.
    fc.advance(SIGN_IN_WAIT_MS);
    s.end("codex", { state: "failed", said: "the sign-in ran out" });
    await until(async () => (await rowOf(place.id)).setup?.waiting[0]?.state === "expired");
    expect(placeWord(await rowOf(place.id), null)).toEqual({ word: "Needs you", sentence: "Codex's sign-in ran out; a retry asks for a fresh code" });
    await runtime!.places!.setUp(place.id, {});
    await until(() => s.started.length === 2);
    await until(async () => (await rowOf(place.id)).setup?.waiting[0]?.code === "CODE-2");
    expect((await rowOf(place.id)).setup?.waiting[0]?.state).toBe("waiting");
  });
});

describe("what the picks weigh before Set up", () => {
  it("weighs the picks on this computer against the room the computer last said it has, by a pending add or the computer", async () => {
    await hosting({ provision: provisioner().wired });
    const added = await runtime!.places!.add({ addId: "a_wait", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    await until(async () => (await runtime!.places!.pending())[0]?.step === "choosing");
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: {}, codex: {} }, plugins: { "lint@acme": {} } });
    const free = CURRENT.diskFreeBytes;
    expect(await runtime!.places!.estimate("a_wait", picks)).toEqual({ neededBytes: 2 * 1024 ** 3, freeBytes: free, unmeasured: 1 });
    expect(await runtime!.places!.estimate(added.place.id, picks)).toEqual({ neededBytes: 2 * 1024 ** 3, freeBytes: free, unmeasured: 1 });
    // An add that never joined has said nothing of its room.
    expect(await runtime!.places!.estimate("root@10.0.0.77", picks)).toEqual({ neededBytes: 2 * 1024 ** 3, unmeasured: 1 });
  });
});

describe("a step the person skips for now", () => {
  it("takes a sign-in that waits off the person: its row reads skipped, its login stops, and the computer reads Ready", async () => {
    const s = signIns();
    const { frames } = await hosting({ provision: provisioner().wired, acts: s.acts });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code !== undefined) === true);
    const skipped = await runtime!.places!.skip(place.id, "signins/codex");
    expect(skipped.setup?.waiting).toEqual([]);
    expect(skipped.applied?.rows.find(r => r.id === "signins/codex")).toMatchObject({ outcome: "skipped", note: SKIPPED_FOR_NOW, step: "signins" });
    expect(placeWord(skipped, null).word).toBe("Ready");
    // The login there was stopped, and a late answer from it changes nothing.
    expect(s.stopped).toEqual(["codex"]);
    s.end("codex", { state: "signed-in" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/codex")?.outcome).toBe("skipped");
    expect(ended(frames).at(-1)?.end).toBe("ready");
  });

  it("skips a sign-in whose page ran out, after its login there ended", async () => {
    const fc = fakeClock();
    const s = signIns();
    await hosting({ provision: provisioner().wired, acts: s.acts, clock: fc.clock });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code !== undefined) === true);
    fc.advance(SIGN_IN_WAIT_MS);
    s.end("codex", { state: "failed", said: "the sign-in ran out" });
    await until(async () => (await rowOf(place.id)).setup?.waiting[0]?.state === "expired");
    const skipped = await runtime!.places!.skip(place.id, "signins/codex");
    expect(skipped.setup?.waiting).toEqual([]);
    expect(skipped.applied?.rows.find(r => r.id === "signins/codex")?.outcome).toBe("skipped");
  });

  it("sets a row that failed aside for later, and refuses a row with nothing to skip", async () => {
    const p = provisioner({ rows: { clis: [{ id: "tools/brew/gh", label: "GitHub CLI", outcome: "failed", note: "no bottle" }] } });
    await hosting({ provision: p.wired });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: { ...LAPTOP, agents: { claude: { signin: "vault" } } } }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const skipped = await runtime!.places!.skip(place.id, "tools/brew/gh");
    expect(skipped.applied?.rows.find(r => r.id === "tools/brew/gh")).toMatchObject({ outcome: "skipped", note: SKIPPED_FOR_NOW });
    await expect(runtime!.places!.skip(place.id, "agents/claude")).rejects.toThrow("nothing waits or failed under agents/claude on spoo");
  });

  it("skips the GitHub sign-in on the box, and a private folder that waited on it reads as needing GitHub", async () => {
    const s = signIns();
    const repo = privateRepo();
    await hosting({ local: true, provision: provisioner().wired, acts: s.acts, answer: cmd => (cmd.includes("ls-remote") ? { exitCode: 128 } : undefined) });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: repo, keep: [] } }, configs: { github: { signin: "machine" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code !== undefined) === true);
    await runtime!.places!.skip(place.id, "github");
    await until(async () => (await rowOf(place.id)).applied?.rows.some(r => r.id === "folders/app") === true);
    const row = await rowOf(place.id);
    expect(row.applied?.rows.find(r => r.id === "github")).toMatchObject({ outcome: "skipped", note: SKIPPED_FOR_NOW });
    expect(row.applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "failed", note: NEEDS_GITHUB_LINE });
  });
});

describe("a computer that follows a recipe", () => {
  const V1 = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, clis: { jq: { via: "brew" } }, skills: { unslop: { from: "~/.claude/skills" } } });
  const ITEMS = { "clis/jq": "1.7", "skills/unslop": "d1" };

  /** A computer set up from the saved recipe and in step with it. */
  async function following(o: { undo?: (removed: readonly { kind: string; name: string }[]) => PlaceUndo[]; answer?: (cmd: string) => { exitCode: number; stdout?: string } | undefined; cmds?: string[]; rows?: Partial<Record<EngineStep, PlaceProvisionRow[]>> } = {}) {
    const p = provisioner({ ...(o.undo !== undefined ? { undo: o.undo } : {}), ...(o.rows !== undefined ? { rows: o.rows } : {}) });
    const r = shelf(V1, ITEMS);
    const host = await hosting({ provision: p.wired, recipes: r.recipes, ...(o.answer !== undefined ? { answer: o.answer } : {}), ...(o.cmds !== undefined ? { cmds: o.cmds } : {}) });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: V1, recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    // The setup holds the computer against the recipe as resolved, so the sync its link starts finds nothing to do.
    expect((await rowOf(place.id)).applied).toMatchObject({ hash: "h1", items: ITEMS });
    await new Promise(resolve => setTimeout(resolve, 20));
    p.ran.length = 0;
    return { p, r, host, placeId: place.id };
  }

  it("takes a skill added to the recipe with no step from the person, by the skills step alone", async () => {
    const { p, r, placeId } = await following();
    const V2 = { ...V1, skills: { ...V1.skills, why: { from: "~/.claude/skills" } } };
    r.move(V2, { ...ITEMS, "skills/why": "d2" }, "h2");
    expect(await runtime!.places!.recipeChanged("laptop")).toEqual(["spoo"]);
    await until(async () => (await rowOf(placeId)).applied?.hash === "h2");
    expect(p.ran).toEqual(["skills"]);
    const row = await rowOf(placeId);
    expect(row.picks).toEqual(V2);
    expect(row.sync).toBeUndefined();
    expect(row.applied?.items).toEqual({ ...ITEMS, "skills/why": "d2" });
    // Behind with what moved, then the change under way, then in step with what it applied.
    expect(syncs.map(f => (f.line !== undefined ? `${f.line.step} ${f.line.state}` : (f.sync?.state ?? (f.applied !== undefined ? "applied" : "in step"))))).toEqual(["behind", "running", "skills running", "skills done", "applied"]);
    expect(syncs[0]?.sync?.changes).toEqual(["skills/why"]);
    // The setup stands as it ended: a sync is not a setup, and its word never read Setting up.
    expect(row.setup?.state).toBe("done");
    expect(placeWord(row, null).word).toBe("Ready");
  });

  it("takes a skill taken out of the recipe off by the ledger, keeps a file edited there and says so on its row", async () => {
    const cmds: string[] = [];
    const { p, r, placeId } = await following({
      cmds,
      undo: () => [{ key: "skills/unslop", label: "unslop", ids: ["skills/unslop", "files/.claude/skills/unslop"], dests: [".claude/skills/unslop"] }],
      answer: cmd => (cmd.includes("wsp-unland") ? { exitCode: 0, stdout: "wsp-unland\tgone\t.claude/skills/unslop/SKILL.md\nwsp-unland\tkept\t.claude/skills/unslop/notes.md\n" } : undefined),
    });
    r.move({ ...V1, skills: {} }, { "clis/jq": "1.7" }, "h3");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(placeId)).applied?.hash === "h3");
    expect(p.undone.map(u => u.removed)).toEqual([["skills/unslop"]]);
    expect(p.undone[0]?.before).toEqual(V1);
    expect(cmds.some(c => c.includes("wsp-unland") && c.includes("'.claude/skills/unslop'"))).toBe(true);
    // No step runs for a removal alone.
    expect(p.ran).toEqual([]);
    expect((await rowOf(placeId)).applied?.rows.find(r => r.id === "skills/unslop")).toMatchObject({ outcome: "skipped", note: editedThereLine("spoo", [".claude/skills/unslop/notes.md"]) });
  });

  it("never takes off a row the computer had before wsp, and takes off one wsp put there by its own road", async () => {
    const cmds: string[] = [];
    const { r, placeId } = await following({
      cmds,
      rows: { clis: [{ id: "tools/brew/jq", label: "jq", outcome: "present" }] },
      undo: removed => removed.map(c => ({ key: `${c.kind}/${c.name}`, label: c.name, ids: [c.kind === "clis" ? "tools/brew/jq" : "agents/claude"], cmd: `take-off-${c.name}` })),
    });
    // The setup read jq as already there and put claude on.
    expect((await rowOf(placeId)).applied?.rows.find(r => r.id === "tools/brew/jq")?.outcome).toBe("present");
    r.move({ ...V1, agents: {}, clis: {} }, { "skills/unslop": "d1" }, "h4");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(placeId)).applied?.hash === "h4");
    expect(cmds.filter(c => c.startsWith("take-off-"))).toEqual(["take-off-claude"]);
    const rows = (await rowOf(placeId)).applied?.rows.map(r => r.id);
    expect(rows).not.toContain("tools/brew/jq");
    expect(rows).not.toContain("agents/claude");
  });

  it("does nothing on a computer that follows no recipe, and nothing when the recipe did not move", async () => {
    const { p, r, placeId } = await following();
    const before = r.resolves();
    // Saved again with nothing changed: one read of the recipe, nothing run there.
    await runtime!.places!.recipeChanged("laptop");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(p.ran).toEqual([]);
    expect(r.resolves()).toBeGreaterThan(before);
    await runtime!.places!.follow(placeId, "none");
    r.move({ ...V1, skills: {} }, { "clis/jq": "1.7" }, "h5");
    expect(await runtime!.places!.recipeChanged("laptop")).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(p.ran).toEqual([]);
    expect((await rowOf(placeId)).applied?.hash).toBe("h1");
  });

  it("reads Behind while its computer is away, and catches up once when it dials back", async () => {
    const { p, r, host, placeId } = await following();
    for (const ws of sockets.splice(0)) ws.close();
    await until(async () => (await rowOf(placeId)).present === false);
    r.move({ ...V1, skills: { ...V1.skills, why: { from: "~/.claude/skills" } } }, { ...ITEMS, "skills/why": "d2" }, "h6");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(placeId)).sync?.state === "behind");
    expect(p.ran).toEqual([]);
    expect(placeWord({ ...(await rowOf(placeId)) }, null)).toEqual({ word: "Behind", sentence: "waiting to put on the recipe's 1 change: skills/why" });
    await dialsBack(host.hostKey, placeId, host.joined[0]!.pair);
    await until(async () => (await rowOf(placeId)).applied?.hash === "h6");
    expect(p.ran).toEqual(["skills"]);
    expect((await rowOf(placeId)).sync).toBeUndefined();
  });

  it("lands a folder a sync adds on a computer whose GitHub was signed in before, with no wait on a GitHub step it does not run", async () => {
    const p = provisioner();
    const withGitHub = { ...V1, configs: { github: { signin: "vault" as const } } };
    const r = shelf(withGitHub, ITEMS);
    const cmds: string[] = [];
    await hosting({ provision: p.wired, recipes: r.recipes, cmds, vault: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", GH_TOKEN: "ghp_vaulted" } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: withGitHub, recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect((await rowOf(place.id)).applied?.rows.find(row => row.id === "github")?.outcome).toBe("present");
    r.move({ ...withGitHub, folders: { app: { from: "/nowhere/app", keep: [] } } }, ITEMS, "h9");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(place.id)).applied?.hash === "h9");
    expect((await rowOf(place.id)).applied?.rows.find(row => row.id === "folders/app")?.note).not.toBe(NEEDS_GITHUB_LINE);
    expect(cmds.some(c => c.includes("ls-remote"))).toBe(false);
  });

  it("runs a change that landed mid-sync once more at its end", async () => {
    const { p, r, placeId } = await following();
    p.arm("skills");
    r.move({ ...V1, skills: { ...V1.skills, why: { from: "~/.claude/skills" } } }, { ...ITEMS, "skills/why": "d2" }, "h7");
    await runtime!.places!.recipeChanged("laptop");
    await until(() => p.ran.includes("skills"));
    r.move({ ...V1, skills: { ...V1.skills, why: { from: "~/.claude/skills" } } }, { ...ITEMS, "skills/why": "d3" }, "h8");
    await runtime!.places!.recipeChanged("laptop");
    p.let("skills");
    await until(async () => (await rowOf(placeId)).applied?.hash === "h8");
    expect(p.ran).toEqual(["skills", "skills"]);
  });
});
