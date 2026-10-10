// SPDX-License-Identifier: AGPL-3.0-only
// The setup job on a computer somebody owns, driven by a host over the link
// that computer holds: a pending add from the first field to its picks, the
// steps each weighed by their class, the word the row reads, and a host that
// stops in the middle of any of it. The engine's steps are a fake here; what
// is under test is the order, the state on the record and what resumes.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import {
  RecipeFile,
  absentComputer,
  floorFailedLine,
  GITHUB_SKIPPED_LINE,
  AT_ITS_TERMINAL,
  waitsForInstallLine,
  installingFirstLine,
  NEEDS_GITHUB_LINE,
  FOLDER_SERVERS_WAIT_LINE,
  WAITS_ON_GITHUB_LINE,
  SETUP_LOG_TAIL_BYTES,
  SKIPPED_FOR_NOW,
  editedThereLine,
  wasThereLine,
  noAgentLine,
  pendingHeldLine,
  noPendingRefusal,
  projectInUseRefusal,
  folderMoveHeldLine,
  folderMoveStandsLine,
  noRemoteLine,
  recipeFolderGoneLine,
  pluginsKeptLine,
  setupRowFix,
  signInThereFix,
  signInWithFix,
  noCopyLine,
  copiedFromLine,
  placeProvisionPaths,
  placeProvisioningLine,
  EXEC_DEADLINE_EXIT,
  placeSyncingLine,
  placeWord,
  probePath,
  DAEMON_VERSION,
  SIGN_IN_WAIT_MS,
  SIGNED_IN_THERE,
  setupLines,
  seedChoiceFrom,
  readJoinToken,
  type AgentsSignInEvent,
  type PlaceProvisionRow,
  type PlaceSetupEvent,
  type PlaceSetupStep,
  type PlaceSyncEvent,
  type PlaceView,
  type PlaceReport,
  type SeedChoice,
  type RecipeOptions,
  type SeedPlan,
  heldPlaceScript,
  placeFileText,
} from "@wsp/protocol";
import { loginSignIn } from "@wsp/catalog";
import type { EngineStep, ProvisionOn, ProvisionPlan, ProvisionStage } from "@wsp/engine";
import type { AgentsActs, SignInAsk, SignInRun } from "../src/agents-read.js";
import type { HarnessAdapterFactory, RecipeShelf, SeedWiring } from "../src/runtime.js";
import { ADD_STOPPED_LINE, PlaceProvisioningError, type PlaceUndo, newPlaceKeyPair, type PlaceKeyPair, type PlaceProvisioner, type PlaceRecord, type PlaceUpdater, type PlaceUpdateRequest, type PlaceWiring } from "../src/places.js";
import { createRuntime, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { fakeCopier, LocalBackend, ownedFloorBytes, PlaceAbsentError } from "@wsp/engine";
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

/** A computer that keeps the project checkouts it holds on a disk of its own, where an add clones in a short-lived
 * machine of its own; `created` waits before that machine is answered, for a test that holds the clone, and
 * `answers` says whether this ask of what it forks with is answered or refused. */
type Checkouts = { created?: Promise<void>; answers?: () => boolean };

/** What the computer answers on its link: what it forks with, the machine an add clones in, and every command as
 * its daemon's exec would. */
function answersFor(cmds: string[], answer?: (cmd: string, input: string) => { exitCode: number; stdout?: string } | undefined, checkouts?: Checkouts, logins?: string) {
  return (c: WsClient): void => {
    let killed = false;
    c.onFrame(async raw => {
      const frame = raw as unknown as Record<string, unknown>;
      const say = (payload: Record<string, unknown>): void => c.say({ id: frame["id"], ok: true, ...payload });
      if (frame["op"] === "machine.backend") {
        if (checkouts?.answers?.() === false) return void c.say({ id: frame["id"], ok: false, error: "not now" });
        return say({ ...FACTS, ...(checkouts === undefined ? {} : { projects: "/wsp/projects" }), ...(logins === undefined ? {} : { logins }) });
      }
      if (frame["op"] === "machine.capacity") return say({ cores: 2, memMb: 7600, memRoomMb: 6000, machineMemMb: 4096, diskFreeBytes: 19 * 1024 ** 3, images: [], machines: { running: 0, paused: 0 } });
      if (checkouts !== undefined) {
        const machine = { machine: { id: "k1", kind: "sandbox", daemonSupervisor: "entrypoint", roads: { previewUrl: true, daemonAnswers: true, putBytes: true, describe: true, facts: true, metrics: true } } };
        if (frame["op"] === "machine.create") {
          await checkouts.created;
          return say(machine);
        }
        // A machine the host killed reads missing, which is what a delete's wait for gone reads.
        if (frame["op"] === "machine.kill") killed = true;
        if (killed && (frame["op"] === "machine.get" || frame["op"] === "machine.state")) return void c.say({ id: frame["id"], ok: false, error: "no such machine: k1", kind: "missing", status: 404 });
        if (frame["op"] === "machine.get") return say(machine);
        if (frame["op"] === "machine.exec") return say({ result: { exitCode: 0, stdout: "", stderr: "" } });
        if (frame["op"] === "machine.state") return say({ state: "running" });
        if (frame["op"] === "machine.daemonAnswers") return say({ answers: true });
        if (typeof frame["op"] === "string" && frame["op"].startsWith("machine.")) return say({});
      }
      // A thread's checkpoints read no git here, so its turn end and its delete go on at once.
      if (typeof frame["op"] === "string" && frame["op"].startsWith("git.")) return void c.say({ id: frame["id"], ok: false, error: "no git here" });
      if (frame["op"] === "place.leave") {
        cmds.push("place.leave");
        return say({ swept: ["/root/.wsp"] });
      }
      if (frame["op"] !== "exec") return;
      const cmd = String(frame["cmd"] ?? "");
      cmds.push(cmd);
      // gh's own status off the token the run read on its input, as gh prints it.
      const input = typeof frame["stdin"] === "string" ? Buffer.from(frame["stdin"], "base64").toString("utf8") : "";
      const said = answer?.(cmd, input);
      if (said !== undefined) return void c.say({ id: frame["id"], ok: true, exitCode: said.exitCode, stdout: said.stdout ?? "", stderr: "", truncated: false });
      // An add's claim of a folder in the login's home takes the name it asks for, and its clone waits where the
      // test holds the checkout.
      const claim = /mkdir '([^']+)'"\$n"/.exec(cmd);
      if (claim !== null) return void c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: `${claim[1]}\n`, stderr: "", truncated: false });
      if (cmd.includes("git clone")) await checkouts?.created;
      // gh with no token on its input reads its own login there, and this computer has none.
      if (cmd.includes("gh auth status") && !input.includes("GH_TOKEN=")) return void c.say({ id: frame["id"], ok: true, exitCode: 1, stdout: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n", stderr: "", truncated: false });
      const gh = cmd.includes("gh auth status") ? "github.com\n  - Logged in to github.com account dev (GH_TOKEN)\n  - Token scopes: 'gist', 'read:org', 'repo'\n" : "";
      // A project folder's unsaved read, as a clean checkout answers it.
      const unsaved = cmd.includes("rev-list") ? "0 0 0\n" : "";
      c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: gh + unsaved, stderr: "", truncated: false });
    });
  };
}

/** A computer whose folder for the project a setup made is gone, as the person removed or renamed it there. */
const folderGone = (cmd: string): { exitCode: number } | undefined => (cmd.includes("test -e ") ? { exitCode: 1 } : undefined);

/** Codex's own status on a computer where it is signed in. */
const codexIn = (cmd: string): { exitCode: number; stdout: string } | undefined => (cmd.includes("codex login status") ? { exitCode: 0, stdout: "Logged in using ChatGPT\n" } : undefined);

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
function provisioner(
  o: {
    rows?: Partial<Record<EngineStep, PlaceProvisionRow[]>>;
    /** Rows a step says as it reaches them, before it is held. */
    said?: Partial<Record<EngineStep, PlaceProvisionRow[]>>;
    installs?: EngineStep[];
    plan?: ProvisionPlan;
    hold?: EngineStep;
    holds?: EngineStep[];
    throws?: { step: EngineStep; error: Error };
    undo?: (removed: readonly { kind: string; name: string }[]) => PlaceUndo[];
    /** A project's own servers are carried, one row each landed folder. */
    projectServers?: true;
  } = {},
) {
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
  /** Each folder whose servers were carried, with the steps that had ended by then. */
  const carried: { key: string; path: string; after: EngineStep[] }[] = [];
  const ended: EngineStep[] = [];
  /** The plan each step was handed. */
  const plans: Partial<Record<EngineStep, ProvisionPlan>> = {};
  const stages = new Map<EngineStep, ProvisionStage>();
  const ons = new Map<EngineStep, ProvisionOn>();
  const floors: string[] = [];
  const picked: RecipeFile[] = [];
  const rows = { ...ROWS, ...o.rows };
  const wired: PlaceProvisioner = {
    plan: async () => ({ noRecipe: "/nowhere/recipe.json" }),
    setup: async picks => {
      picked.push(picks);
      return o.plan ?? PLAN;
    },
    floor: async (_machine, on) => {
      floors.push(on.home);
      return [];
    },
    step: async (_machine, plan, step, _run, stage, on) => {
      ran.push(step);
      plans[step] = plan;
      stages.set(step, stage);
      ons.set(step, on);
      stage(`${step} under way`);
      for (const row of o.said?.[step] ?? []) stage(`${row.label}: ${row.outcome}`, undefined, { ...row, step });
      // A tool not there yet is said as the install loop says one it starts: its label and where it stands.
      if (o.installs?.includes(step) === true) for (const [i, row] of (rows[step] ?? []).entries()) stage(`${row.label} (${i + 1}/${rows[step]?.length ?? 0})`, { label: row.label, index: i + 1, of: rows[step]?.length ?? 0 });
      if (o.hold === step) await held;
      await each.get(step)?.at;
      if (o.throws?.step === step) throw o.throws.error;
      ended.push(step);
      return rows[step] ?? [];
    },
    ...(o.projectServers === true
      ? {
          projectServers: async (_machine, _picks, key, path) => {
            carried.push({ key, path, after: [...ended] });
            return [{ id: `agents/mcp/claude/@${encodeURIComponent(path)}/kept`, label: "Claude Code kept", outcome: "installed" }];
          },
        }
      : {}),
    estimate: async picks => ({ bytes: Object.keys(picks.agents).length * 1024 ** 3, unmeasured: Object.keys(picks.plugins).length }),
    undo: async (before, removed) => {
      undone.push({ before, removed: removed.map(r => `${r.kind}/${r.name}`) });
      return o.undo?.(removed) ?? [];
    },
  };
  const undone: { before: RecipeFile; removed: string[] }[] = [];
  /** A running step says a row has landed, as the tools loop does while the rest of its rows install. */
  const say = (step: EngineStep, row: PlaceProvisionRow): void => stages.get(step)?.(`${row.label}: ${row.outcome}`, undefined, { ...row, step });
  return { wired, ran, carried, plans, ons, floors, picked, undone, release: () => release(), let: (step: EngineStep) => each.get(step)?.let(), arm, say };
}

/** Sign-ins as the app's own road runs them, each waiting on the test: the page and the code, then the end. The
 * line carries the catalog's status command, as the host plans it, unless `status` is false. */
function signIns(o: { status?: boolean } = {}) {
  const started: string[] = [];
  const stopped: string[] = [];
  const ends = new Map<string, (e: Pick<AgentsSignInEvent, "state" | "said">) => void>();
  const acts: AgentsActs = {
    signInLine: async (_on, ask) => {
      const status = o.status === false ? undefined : loginSignIn(ask.agent)?.status?.command;
      return { command: `${ask.agent} login`, ...(status !== undefined ? { status } : {}) };
    },
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
async function hosting(o: { provision: PlaceProvisioner; checkouts?: Checkouts; seed?: SeedWiring; recipes?: RecipeShelf; store?: Store; cmds?: string[]; answer?: (cmd: string, input: string) => { exitCode: number; stdout?: string } | undefined; local?: boolean | LocalWiring; acts?: AgentsActs; vault?: Record<string, string>; report?: PlaceReport; install?: PlaceWiring["install"]; undo?: PlaceWiring["undo"]; leave?: PlaceWiring["leave"]; runOver?: PlaceWiring["runOver"]; hostKey?: PlaceKeyPair; clock?: Clock; update?: PlaceUpdater; adapters?: Record<string, HarnessAdapterFactory>; logins?: string }): Promise<{ hostKey: PlaceKeyPair; store: Store; frames: PlaceSetupEvent[]; joined: { placeId: string; pair: PlaceKeyPair }[] }> {
  const hostKey = o.hostKey ?? newPlaceKeyPair();
  const joined: { placeId: string; pair: PlaceKeyPair }[] = [];
  const store = o.store ?? memoryStore();
  const answers = answersFor(o.cmds ?? [], o.answer, o.checkouts, o.logins);
  runtime = createRuntime({
    backend: stubBackend(),
    store,
    adapters: o.adapters ?? {},
    ...(o.seed !== undefined ? { seed: o.seed } : {}),
    ...(o.clock !== undefined ? { clock: o.clock } : {}),
    ...(o.acts !== undefined ? { agentsActs: o.acts } : {}),
    ...(o.local === true ? { local: localWiring() } : typeof o.local === "object" ? { local: o.local } : {}),
    ...(o.recipes !== undefined ? { recipes: o.recipes } : {}),
    vault: () => o.vault ?? { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" },
    placeLinks: {
      ...wiring(hostKey, undefined, o.update),
      provision: o.provision,
      ...(o.undo !== undefined ? { undo: o.undo } : {}),
      ...(o.leave !== undefined ? { leave: o.leave } : {}),
      ...(o.runOver !== undefined ? { runOver: o.runOver } : {}),
      install:
        o.install ??
        (async (req, stage) => {
          stage("connect", "done", "Ubuntu 24.04");
          stage("check", "running");
          stage("check", "done", "root, systemd, cgroup v2");
          await req.beforeDeploy?.("undo-script", "root@10.0.0.9", "ssh-ed25519 SHA256:box");
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
async function dialsBack(hostKey: PlaceKeyPair, placeId: string, pair: PlaceKeyPair, cmds: string[] = [], answer?: (cmd: string) => { exitCode: number; stdout?: string } | undefined): Promise<void> {
  const { client, proved } = await relinkAt(srv!.port, hostKey, placeId, pair, CURRENT, answersFor(cmds, answer));
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
function localWiring(root = mkdtempSync(join(tmpdir(), "wsp-setup-local-")), home: (agentId: string) => string = () => join(root, ".claude")): LocalWiring {
  repos.push(root);
  return {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home,
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

/** A folder on this computer, and the host's reader of it answering what a seed of it would carry. */
function seededFolder(files: SeedPlan["files"] = []): { folder: string; seed: SeedWiring } {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-setup-folder-")));
  repos.push(folder);
  const plan: SeedPlan = { source: folder, remote: "https://github.com/acme/app", branch: "main", defaultBranch: "main", unpushed: null, uncommitted: 0, memory: null, files, remembered: false };
  return { folder, seed: { plan: async () => plan, pack: async () => ({ tar: Buffer.from("seed archive"), files: 0, bytes: 12, commits: 0, left: [] }) } };
}

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
    resolveFile: async picked => ({ file: picked, items: now.items, hash: "picks" }),
  };
  return { recipes, move: (next: RecipeFile, nextItems: Record<string, string>, hash: string) => void (now = { file: next, items: nextItems, hash }), resolves: () => resolves };
}

const rowOf = async (placeId: string): Promise<PlaceView> => (await runtime!.places!.list(Date.now())).find(p => p.id === placeId)!;
const ended = (frames: readonly PlaceSetupEvent[]): PlaceSetupEvent[] => frames.filter(f => f.end !== undefined);

describe("the add's own steps", () => {
  it("says how long the join took once that computer dialled in", async () => {
    await hosting({ provision: provisioner().wired });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    const job = runtime!.places!.adds().find(a => a.placeId === place.id);
    expect(job?.steps.find(s => s.step === "join")).toMatchObject({ state: "done", ms: expect.any(Number) });
  });
});

describe("the servers step of an add", () => {
  it("hands the engine the names the vault holds a server's value under, and no sign-in's, so a row can say where a value does not reach", async () => {
    const p = provisioner();
    await hosting({ provision: p.wired, vault: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", LINEAR_TOKEN: "lin_TESTONLY" } });
    await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(() => p.ons.has("mcp"));
    expect(p.ons.get("mcp")?.held).toEqual(new Set(["LINEAR_TOKEN"]));
  });

  /** The computer's answer to who its lines run as: a root daemon, and a home `owner` owns. */
  const linesAs = (owner: string, home: string) => (cmd: string) => (cmd.startsWith("uname -s;") ? { exitCode: 0, stdout: ["Linux", "0", "root", owner, "1", home, "/usr/bin", ""].join("\n") } : undefined);

  it("hands the engine the folder each agent's threads there read their servers from, Codex's being the box's logins folder its turns' CODEX_HOME names", async () => {
    const p = provisioner();
    await hosting({ provision: p.wired, logins: "/var/lib/wsp/logins", report: report("spoo", { daemonVersion: DAEMON_VERSION, login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }), answer: linesAs("root", "/root") });
    await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(() => p.ons.has("mcp"));
    expect(p.ons.get("mcp")?.stores).toMatchObject({ claude: "/root/.claude-cfg", codex: "/var/lib/wsp/logins/codex" });
  });

  it("hands a login that is not root no folder outside its home, which only root reaches, so its servers go where the catalog keeps them", async () => {
    const p = provisioner();
    await hosting({ provision: p.wired, logins: "/var/lib/wsp/logins", report: report("spoo", { daemonVersion: DAEMON_VERSION }), answer: linesAs("maya", "/home/maya") });
    await runtime!.places!.add({ address: "maya@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(() => p.ons.has("mcp"));
    expect(p.ons.get("mcp")?.stores).toEqual({ claude: "/home/maya/.claude-cfg" });
  });
});

describe("a remove of a computer set up with picks", () => {
  it("takes the plugins wsp put on off before the sweep, and the projects its folders made with it", async () => {
    const cmds: string[] = [];
    const p = provisioner({
      rows: { plugins: [{ id: "plugins/superpowers@market", label: "superpowers@market", outcome: "installed" }, { id: "plugins/had@market", label: "had@market", outcome: "present" }] },
      undo: removed => removed.map(c => ({ key: `${c.kind}/${c.name}`, label: c.name, ids: [`${c.kind}/${c.name}`], owner: `${c.kind}/${c.name}`, cmd: `take-off-${c.name}` })),
    });
    const { store } = await hosting({ provision: p.wired, cmds });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, plugins: { "superpowers@market": {}, "had@market": {} }, folders: { app: { from: "/Users/dev/app", keep: [] } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    // The project the folders step made there, as its row reads once it landed.
    const made = await runtime!.projects.add({ source: "https://github.com/acme/app.git", on: place.id, name: "app" });
    const record = (await store.get("places", place.id)) as PlaceRecord;
    const rows = record.applied!.rows.filter(r => r.id !== "folders/app");
    await store.put("places", place.id, { ...record, applied: { ...record.applied!, rows: [...rows, { id: "folders/app", label: "app", outcome: "installed", step: "folders", project: { id: made.id }, pick: picks.folders["app"]! }] } });
    cmds.length = 0;
    const removed = await runtime!.places!.remove(place.id);
    expect(removed.removed).toBe(true);
    // Only the plugin wsp put on, and before the sweep takes the folder its agent may run from.
    expect(p.undone.at(-1)?.removed).toEqual(["plugins/superpowers@market"]);
    expect(cmds.filter(c => c.startsWith("take-off-") || c === "place.leave")).toEqual(["take-off-superpowers@market", "place.leave"]);
    expect(await runtime!.projects.list()).toEqual([]);
    expect(removed.took).toEqual({ forks: [], projects: [{ name: "app", threads: 0 }] });
    expect(removed.swept).toEqual(["plugin superpowers@market", "/root/.wsp"]);
  });

  it("takes the plugins off over the login where the link is down, and names each one it could not take off", async () => {
    const p = provisioner({
      rows: { plugins: [{ id: "plugins/superpowers@market", label: "superpowers@market", outcome: "installed" }, { id: "plugins/stuck@market", label: "stuck@market", outcome: "installed" }, { id: "plugins/had@market", label: "had@market", outcome: "present" }] },
      undo: removed => removed.map(c => ({ key: `${c.kind}/${c.name}`, label: c.name, ids: [`${c.kind}/${c.name}`], owner: `${c.kind}/${c.name}`, cmd: `take-off-${c.name}` })),
    });
    const over: { login: string; script: string }[] = [];
    const order: string[] = [];
    const hostKey = newPlaceKeyPair();
    let joined = "";
    const held = heldPlaceScript(CURRENT.login["HOME"]!);
    const file = (): string => placeFileText({ placeId: joined, name: "spoo", hostName: "zingzys-mac", hostUrls: DOOR, hostPublicKey: hostKey.publicKey, keyPath: "/home/maya/.wsp/place.key", joinedAt: "2026-10-07T00:00:00.000Z" });
    await hosting({
      provision: p.wired,
      hostKey,
      runOver: async (login, script) => {
        // The place file names this computer, which is what the remove reads before anything else runs there.
        if (script === held) return { exitCode: 0, stdout: file(), stderr: "" };
        over.push({ login: login.ssh, script });
        order.push(script);
        return script.includes("stuck") ? { exitCode: 1, stdout: "", stderr: "Plugin is in use" } : { exitCode: 0, stdout: "", stderr: "" };
      },
      leave: async () => {
        order.push("leave");
        return ["/opt/wsp"];
      },
    });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, plugins: { "superpowers@market": {}, "stuck@market": {}, "had@market": {} } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    joined = place.id;
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    for (const ws of sockets.splice(0)) ws.close();
    await until(async () => (await rowOf(place.id)).present === false);
    const removed = await runtime!.places!.remove(place.id);
    // Over the login the install used, before the leave takes the folder the agent runs from; never the one it had.
    expect(over.map(o => [o.login, o.script])).toEqual([
      ["root@10.0.0.9", "take-off-superpowers@market"],
      ["root@10.0.0.9", "take-off-stuck@market"],
    ]);
    expect(order.at(-1)).toBe("leave");
    expect(removed.swept).toEqual(["plugin superpowers@market", "/opt/wsp"]);
    expect(removed.note).toContain(pluginsKeptLine("spoo", ["stuck@market"]));
  });

  it("names a plugin the link could not take off rather than saying nothing of it", async () => {
    const cmds: string[] = [];
    const p = provisioner({
      rows: { plugins: [{ id: "plugins/stuck@market", label: "stuck@market", outcome: "installed" }] },
      undo: removed => removed.map(c => ({ key: `${c.kind}/${c.name}`, label: c.name, ids: [`${c.kind}/${c.name}`], owner: `${c.kind}/${c.name}`, cmd: `take-off-${c.name}` })),
    });
    await hosting({ provision: p.wired, cmds, answer: cmd => (cmd.startsWith("take-off-") ? { exitCode: 1 } : undefined) });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, plugins: { "stuck@market": {} } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const removed = await runtime!.places!.remove(place.id);
    expect(removed.swept).toEqual(["/root/.wsp"]);
    expect(removed.note).toBe(pluginsKeptLine("spoo", ["stuck@market"]));
  });

  it("carries a folder's own servers into the project it became there once the servers step has ended, though the folder landed before it started", async () => {
    const { folder, seed } = seededFolder();
    // The skills hold the files lane, so the servers step cannot start while the folder lands.
    const p = provisioner({ projectServers: true, holds: ["skills"] });
    await hosting({ provision: p.wired, checkouts: {}, seed });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: folder, name: "app", keep: [] } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")?.outcome === "installed" && p.ran.includes("skills"));
    const path = (await runtime!.projects.list())[0]!.path;
    await new Promise(r => setTimeout(r, 20));
    expect(p.ran).not.toContain("mcp");
    expect(p.carried).toEqual([]);
    p.let("skills");
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(p.carried).toEqual([{ key: "app", path, after: expect.arrayContaining(["mcp", "plugins"]) }]);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === `agents/mcp/claude/@${encodeURIComponent(path)}/kept`)).toMatchObject({ outcome: "installed", step: "folderServers" });
  });

  it("carries nothing into the agents' files where the servers step did not land them, and says the servers wait", async () => {
    const { folder, seed } = seededFolder();
    const p = provisioner({ projectServers: true, rows: { mcp: [{ id: "files/.claude-cfg/.claude.json", label: "Claude Code", outcome: "failed", note: "the landing failed" }] } });
    await hosting({ provision: p.wired, checkouts: {}, seed });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: folder, name: "app", keep: [] } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => ["done", "failed"].includes((await rowOf(place.id)).setup?.state ?? ""));
    expect(p.carried).toEqual([]);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app/servers")).toMatchObject({ outcome: "skipped", note: FOLDER_SERVERS_WAIT_LINE, step: "folderServers" });
  });

  it("reads a folder a setup made as wsp's through a second setup, which ends ready, and the remove takes its project off", async () => {
    const { folder, seed } = seededFolder();
    const { frames } = await hosting({ provision: provisioner().wired, checkouts: {}, seed });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: folder, name: "app", keep: [] } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const again = await runtime!.places!.setUp(place.id, {});
    await until(async () => (await rowOf(place.id)).setup?.addId === again.addId && (await rowOf(place.id)).setup?.state === "done");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "installed", step: "folders" });
    expect(ended(frames).map(f => f.end)).toEqual(["ready", "ready"]);
    const removed = await runtime!.places!.remove(place.id);
    expect(removed.removed).toBe(true);
    expect(await runtime!.projects.list()).toEqual([]);
  });

  const appPicks = (folder: string, pick: Record<string, unknown> = {}): RecipeFile => RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: folder, name: "app", keep: [], ...pick } } });

  it("moves the project a setup made to the folder a second setup's picks name, one project on that computer", async () => {
    const { folder, seed } = seededFolder();
    const other = seededFolder().folder;
    const { frames } = await hosting({ provision: provisioner().wired, checkouts: {}, seed, answer: folderGone });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: appPicks(folder) }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const again = await runtime!.places!.setUp(place.id, { choices: appPicks(other) });
    await until(async () => (await rowOf(place.id)).setup?.addId === again.addId && (await rowOf(place.id)).setup?.state === "done");
    const projects = await runtime!.projects.list();
    expect(projects.map(p => p.source)).toEqual([{ kind: "folder", path: other }]);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "installed", project: { id: projects[0]!.id } });
    expect(ended(frames).map(f => f.end)).toEqual(["ready", "ready"]);
    expect((await runtime!.places!.remove(place.id)).removed).toBe(true);
    expect(await runtime!.projects.list()).toEqual([]);
  });

  /** The person takes the project a setup made off this host and records the same folder there by hand, under its
   * name: theirs, which no later setup takes as wsp's, and which a remove takes with the computer as it takes any. */
  const theirsInItsPlace = async (folder: string, seed: SeedWiring, placeId: string): Promise<string> => {
    await runtime!.projects.remove((await runtime!.projects.list()).find(p => p.name === "app")!.id);
    return (await runtime!.projects.add({ source: folder, on: placeId, name: "app", seed: seedChoiceFrom(await seed.plan(folder, {}), [], []) })).id;
  };

  it("leaves a project the person recorded by hand where a setup's stood through a second setup, and the remove takes it with the computer", async () => {
    const { folder, seed } = seededFolder();
    await hosting({ provision: provisioner().wired, checkouts: {}, seed });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: appPicks(folder) }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const theirs = await theirsInItsPlace(folder, seed, place.id);
    const again = await runtime!.places!.setUp(place.id, {});
    await until(async () => (await rowOf(place.id)).setup?.addId === again.addId && (await rowOf(place.id)).setup?.state === "done");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")?.outcome).toBe("failed");
    expect((await runtime!.projects.list()).map(p => p.id)).toEqual([theirs]);
    expect((await runtime!.places!.remove(place.id)).took).toEqual({ forks: [], projects: [{ name: "app", threads: 0 }] });
    expect(await runtime!.projects.list()).toEqual([]);
  });

  it("takes a project the person recorded by hand where a setup's stood when the remove comes straight after", async () => {
    const { folder, seed } = seededFolder();
    await hosting({ provision: provisioner().wired, checkouts: {}, seed });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: appPicks(folder) }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const theirs = await theirsInItsPlace(folder, seed, place.id);
    expect((await runtime!.projects.list()).map(p => p.id)).toEqual([theirs]);
    expect((await runtime!.places!.remove(place.id)).took).toEqual({ forks: [], projects: [{ name: "app", threads: 0 }] });
    expect(await runtime!.projects.list()).toEqual([]);
  });

  it("keeps a folder with no name of its own wsp's through a second setup cut at its floor, and the remove after a third takes it off", async () => {
    const { folder, seed } = seededFolder();
    const floor: PlaceProvisionRow[] = [];
    await hosting({ provision: provisioner({ rows: { floor } }).wired, checkouts: {}, seed });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: folder, keep: [] } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    floor.push({ id: "floor/apt", label: "apt", outcome: "failed", note: "apt lock held" });
    const second = await runtime!.places!.setUp(place.id, {});
    await until(async () => (await rowOf(place.id)).setup?.addId === second.addId && (await rowOf(place.id)).setup?.state === "failed");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "installed", earlier: true });
    floor.length = 0;
    const third = await runtime!.places!.setUp(place.id, {});
    await until(async () => (await rowOf(place.id)).setup?.addId === third.addId && (await rowOf(place.id)).setup?.state === "done");
    const row = await rowOf(place.id);
    expect(row.applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "installed", earlier: true, step: "folders" });
    expect(placeWord(row, null).word).toBe("Ready");
    expect((await runtime!.places!.remove(place.id)).removed).toBe(true);
    expect(await runtime!.projects.list()).toEqual([]);
  });

  it("counts a folder an earlier setup made as already there in the second setup's lines", async () => {
    const { folder, seed } = seededFolder();
    await hosting({ provision: provisioner().wired, checkouts: {}, seed });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: appPicks(folder) }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const again = await runtime!.places!.setUp(place.id, {});
    await until(async () => (await rowOf(place.id)).setup?.addId === again.addId && (await rowOf(place.id)).setup?.state === "done");
    const row = await rowOf(place.id);
    expect(setupLines("spoo", row.setup!, row.applied)[0]).toBe("spoo: 2 installed: Claude Code, GitHub CLI, 2 already there");
  });

  it("keeps the project a setup made where the folder a second setup names needs GitHub to clone and GitHub is not signed in there", async () => {
    const { folder, seed } = seededFolder();
    const repo = privateRepo();
    await hosting({ local: true, provision: provisioner().wired, checkouts: {}, seed, answer: cmd => (cmd.includes("ls-remote") ? { exitCode: 128 } : undefined) });
    const skip = { configs: { github: { signin: "skip" } } };
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: appPicks(folder, skip) }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const was = (await runtime!.projects.list())[0]!.id;
    const again = await runtime!.places!.setUp(place.id, { choices: RecipeFile.parse({ ...appPicks(repo), ...skip }) });
    await until(async () => (await rowOf(place.id)).setup?.addId === again.addId && (await rowOf(place.id)).setup?.state === "done");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "failed", note: NEEDS_GITHUB_LINE, project: { id: was } });
    expect((await runtime!.projects.list()).map(p => [p.id, p.source])).toEqual([[was, { kind: "folder", path: folder }]]);
    expect((await runtime!.places!.remove(place.id)).removed).toBe(true);
  });

  for (const [what, to, said] of [
    ["has no remote", "remote", noRemoteLine],
    ["is not there", "missing", recipeFolderGoneLine],
  ] as const) {
    it(`keeps the project a setup made where the folder a second setup names ${what}, and the row says why`, async () => {
      const { folder, seed } = seededFolder();
      const other = to === "remote" ? seededFolder().folder : join(folder, "gone");
      const plan = await seed.plan(folder, {});
      await hosting({ provision: provisioner().wired, checkouts: {}, seed: { ...seed, plan: async f => (f === folder ? plan : { ...plan, source: f, remote: null }) } });
      const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: appPicks(folder) }, Date.now());
      await until(async () => (await rowOf(place.id)).setup?.state === "done");
      const was = (await runtime!.projects.list())[0]!.id;
      const again = await runtime!.places!.setUp(place.id, { choices: appPicks(other) });
      await until(async () => (await rowOf(place.id)).setup?.addId === again.addId && (await rowOf(place.id)).setup?.state === "done");
      expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "failed", note: said(other), project: { id: was } });
      expect((await runtime!.projects.list()).map(p => [p.id, p.source])).toEqual([[was, { kind: "folder", path: folder }]]);
    });
  }

  it("takes a project the person recorded there by hand with it too, in the same remove", async () => {
    const cmds: string[] = [];
    const p = provisioner({ rows: { plugins: [{ id: "plugins/superpowers@market", label: "superpowers@market", outcome: "installed" }] }, undo: removed => removed.map(c => ({ key: `${c.kind}/${c.name}`, label: c.name, ids: [`${c.kind}/${c.name}`], owner: `${c.kind}/${c.name}`, cmd: `take-off-${c.name}` })) });
    await hosting({ provision: p.wired, cmds });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, plugins: { "superpowers@market": {} } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await runtime!.projects.add({ source: "https://github.com/acme/theirs.git", on: place.id, name: "theirs" });
    const removed = await runtime!.places!.remove(place.id);
    expect(removed.took).toEqual({ forks: [], projects: [{ name: "theirs", threads: 0 }] });
    expect(await runtime!.projects.list()).toEqual([]);
    expect(cmds).toContain("place.leave");
  });
});

describe("an update of a computer already set up", () => {
  it("asks the updater every time, with a binary only where the computer is behind, and never runs the setup again", async () => {
    const asked: PlaceUpdateRequest[] = [];
    const p = provisioner();
    await hosting({ provision: p.wired, update: async req => void asked.push(req) });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const ranBefore = [...p.ran];
    const answer = await runtime!.places!.update(place.id);
    expect(asked).toEqual([expect.objectContaining({ name: "spoo", daemon: false })]);
    // An update moves wsp itself; what the computer was set up with stays as it is, so no step runs again.
    expect(answer).toEqual({ name: "spoo" });
    await new Promise(r => setTimeout(r, 200));
    expect(p.ran).toEqual(ranBefore);
    expect((await rowOf(place.id)).setup?.state).toBe("done");
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
    expect([...lines].sort()).toEqual(["agents", "clis", "configs", "context", "floor", "folderServers", "folders", "github", "mcp", "plugins", "signins", "skills"]);
    expect(row.setup!.steps.every(l => l.state === "done")).toBe(true);
    const before = (a: PlaceSetupStep, b: PlaceSetupStep): boolean => lines.indexOf(a) < lines.indexOf(b);
    expect([before("floor", "agents"), before("agents", "clis"), before("clis", "mcp"), before("mcp", "plugins"), before("github", "folders"), before("folders", "context")]).toEqual([true, true, true, true, true, true]);
    expect(row.setup!.steps.every(l => typeof l.ms === "number")).toBe(true);
    // The steps after the agents run side by side, so their rows land in whatever order they end.
    expect(row.applied?.rows.map(r => [r.id, r.step, r.outcome]).sort()).toEqual([
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

  it("says a sign-in that lands after its step ended on the stream, naming its row, while the setup still runs", async () => {
    const p = provisioner({ holds: ["clis"] });
    const s = signIns();
    const { frames } = await hosting({ provision: p.wired, acts: s.acts });
    const { place } = await runtime!.places!.add({ addId: "a_late", address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => {
      const setup = (await rowOf(place.id)).setup;
      return setup?.steps.some(l => l.step === "signins" && l.state === "done") === true && setup.waiting.some(w => w.code !== undefined);
    });
    s.end("codex", { state: "signed-in" });
    await until(() => frames.some(f => f.landed !== undefined));
    expect(frames.filter(f => f.landed !== undefined).map(f => [f.addId, f.placeId, f.landed, f.end])).toEqual([["a_late", place.id, "signins/codex", undefined]]);
    expect((await rowOf(place.id)).setup?.state).toBe("running");
    p.let("clis");
    await until(() => ended(frames).length === 1);
    expect(ended(frames).map(f => f.end)).toEqual(["ready"]);
  });

  it("says a step's end and a late sign-in only once the record holds them, so a list read on the frame is never behind it", async () => {
    const p = provisioner({ holds: ["clis"] });
    const s = signIns();
    const { frames } = await hosting({ provision: p.wired, acts: s.acts });
    const reads: Promise<{ frame: PlaceSetupEvent; row: PlaceView | undefined }>[] = [];
    runtime!.events.on("place.setup", e => {
      const frame = e as PlaceSetupEvent;
      if (frame.landed !== undefined || (frame.line !== undefined && frame.line.state !== "running")) reads.push(runtime!.places!.list(Date.now()).then(rows => ({ frame, row: rows.find(r => r.id === frame.placeId) })));
    });
    const { place } = await runtime!.places!.add({ addId: "a_read", address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code !== undefined) === true);
    s.end("codex", { state: "signed-in" });
    p.let("clis");
    await until(() => ended(frames).length === 1);
    const read = await Promise.all(reads);
    expect(read.some(r => r.frame.landed === "signins/codex")).toBe(true);
    for (const { frame, row } of read) {
      if (frame.landed !== undefined) expect(row?.setup?.waiting.map(w => w.row)).not.toContain(frame.landed);
      if (frame.line !== undefined) expect(row?.setup?.steps.find(l => l.step === frame.line!.step)?.state).toBe(frame.line.state);
    }
  });

  it("stamps a running step with when it started, on the record and on its frame", async () => {
    const fc = fakeClock();
    const p = provisioner({ holds: ["clis"] });
    const { frames } = await hosting({ provision: p.wired, clock: fc.clock });
    const { place } = await runtime!.places!.add({ addId: "a_clock", address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(() => p.ran.includes("clis"));
    const began = new Date(fc.clock.now()).toISOString();
    fc.advance(300_000);
    await until(async () => (await rowOf(place.id)).setup?.steps.some(l => l.step === "clis") === true);
    expect((await rowOf(place.id)).setup?.steps.find(l => l.step === "clis")).toEqual({ step: "clis", state: "running", startedAt: began });
    expect(frames.find(f => f.line?.step === "clis")?.line).toEqual({ step: "clis", state: "running", startedAt: began });
    p.let("clis");
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
  });

  it("reads the computer's own sign-in as signed in once it lands in the setup, before that computer dials again", async () => {
    const s = signIns();
    await hosting({ provision: provisioner().wired, acts: s.acts, report: report("spoo", { daemonVersion: DAEMON_VERSION, agents: ["claude", "codex"], logins: [] }) });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.url !== undefined) === true);
    expect((await rowOf(place.id)).signIns).toEqual({ claude: "vault-key", codex: "none" });
    s.end("codex", { state: "signed-in" });
    await until(async () => (await rowOf(place.id)).setup?.waiting.length === 0);
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect((await rowOf(place.id)).signIns).toEqual({ claude: "vault-key", codex: "signed-in" });
    expect(runtime!.places!.signInsAt(place.id)).toEqual({ claude: "vault-key", codex: "signed-in" });
  });

  it("starts no sign-in for an agent whose own status there says signed in, though the daemon's last list names no login", async () => {
    const s = signIns();
    const cmds: string[] = [];
    const { frames } = await hosting({ provision: provisioner().wired, acts: s.acts, cmds, answer: codexIn, report: report("spoo", { daemonVersion: DAEMON_VERSION, agents: ["claude", "codex"], logins: [] }) });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(s.started).toEqual([]);
    expect(cmds.filter(c => c.includes("codex login status"))).toHaveLength(1);
    const row = await rowOf(place.id);
    expect(row.setup?.waiting).toEqual([]);
    expect(row.applied?.rows.find(r => r.id === "signins/codex")).toMatchObject({ outcome: "present", note: SIGNED_IN_THERE, step: "signins" });
    expect(row.signIns).toEqual({ claude: "vault-key", codex: "signed-in" });
    expect(ended(frames).map(f => f.end)).toEqual(["ready"]);
    // A sign-in the person asks for by hand is the one road that may replace that login.
    await runtime!.agents.signIn({ placeId: place.id }, { agent: "codex" }, () => {});
    expect(s.started).toEqual(["codex"]);
  });

  it("starts the sign-in where the agent's own status says signed out, though the daemon's last list still names its login", async () => {
    const s = signIns();
    await hosting({ provision: provisioner().wired, acts: s.acts, report: report("spoo", { daemonVersion: DAEMON_VERSION, agents: ["claude", "codex"], logins: ["codex/auth.json"] }) });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.url !== undefined) === true);
    expect(s.started).toEqual(["codex"]);
  });

  it("reads the daemon's logins list where the agent's status cannot be read there", async () => {
    const s = signIns({ status: false });
    await hosting({ provision: provisioner().wired, acts: s.acts, report: report("spoo", { daemonVersion: DAEMON_VERSION, agents: ["claude", "codex"], logins: ["codex/auth.json"] }) });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(s.started).toEqual([]);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/codex")).toMatchObject({ outcome: "present", note: SIGNED_IN_THERE });
  });

  it("reads a status cut at its deadline as unread, never as signed out, and starts no sign-in over the listed login", async () => {
    const s = signIns();
    await hosting({ provision: provisioner().wired, acts: s.acts, answer: cmd => (cmd.includes("codex login status") ? { exitCode: EXEC_DEADLINE_EXIT, stdout: "" } : undefined), report: report("spoo", { daemonVersion: DAEMON_VERSION, agents: ["claude", "codex"], logins: ["codex/auth.json"] }) });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(s.started).toEqual([]);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/codex")).toMatchObject({ outcome: "present", note: SIGNED_IN_THERE });
  });

  it("starts no sign-in for an agent whose login is no shared file, Gemini, where its status says signed in", async () => {
    const s = signIns();
    await hosting({ provision: provisioner().wired, acts: s.acts, answer: cmd => (cmd.includes("oauth_creds.json") ? { exitCode: 0, stdout: "oauth_creds.json\n" } : undefined), report: report("spoo", { daemonVersion: DAEMON_VERSION, agents: ["claude", "gemini"], logins: [] }) });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" }, gemini: { signin: "machine" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(s.started).toEqual([]);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/gemini")).toMatchObject({ outcome: "present", note: SIGNED_IN_THERE, step: "signins" });
  });

  it("starts no second sign-in when the setup runs again after the person signed in during the first", async () => {
    const s = signIns();
    let signedIn = false;
    await hosting({ provision: provisioner().wired, acts: s.acts, answer: cmd => (signedIn ? codexIn(cmd) : undefined), report: report("spoo", { daemonVersion: DAEMON_VERSION, agents: ["claude", "codex"], logins: [] }) });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.url !== undefined) === true);
    signedIn = true;
    s.end("codex", { state: "signed-in" });
    await until(async () => (await rowOf(place.id)).setup?.waiting.length === 0);
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const again = await runtime!.places!.setUp(place.id, {});
    await until(async () => (await rowOf(place.id)).setup?.addId === again.addId && (await rowOf(place.id)).setup?.state === "done");
    expect(s.started).toEqual(["codex"]);
    expect((await rowOf(place.id)).setup?.waiting).toEqual([]);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/codex")).toMatchObject({ outcome: "present", note: SIGNED_IN_THERE });
  });

  it("starts no GitHub sign-in where gh is signed in on that computer already, and a private folder clones", async () => {
    const s = signIns();
    const repo = privateRepo();
    const cmds: string[] = [];
    await hosting({ local: true, provision: provisioner().wired, acts: s.acts, cmds, answer: cmd => (cmd.includes("ls-remote") ? { exitCode: 128 } : cmd.includes("gh auth status") ? { exitCode: 0, stdout: "github.com\n  - Logged in to github.com account dev (keyring)\n" } : undefined) });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: repo, keep: [] } }, configs: { github: { signin: "machine" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(s.started).toEqual([]);
    const row = await rowOf(place.id);
    expect(row.setup?.waiting).toEqual([]);
    expect(row.applied?.rows.find(r => r.id === "github")).toMatchObject({ outcome: "present", note: SIGNED_IN_THERE, step: "github" });
    expect(row.applied?.rows.find(r => r.id === "folders/app")?.note).not.toBe(NEEDS_GITHUB_LINE);
    expect(row.applied?.rows.find(r => r.id === "folders/app")?.note).not.toBe(WAITS_ON_GITHUB_LINE);
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
    // Each says what to do beside what happened, in the words of the computer it is on: a GitHub sign-in with nothing
    // to copy signs in on that computer instead.
    expect(row.applied?.rows.filter(r => r.outcome === "failed").map(r => r.fix)).toEqual([signInThereFix("spoo"), setupRowFix({ step: "folders" }, "spoo")]);
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

  it("never starts a step before what it needs, and runs the rest beside the CLIs: GitHub once gh is on, the servers once theirs are", async () => {
    const plan: ProvisionPlan = {
      ...PLAN,
      steps: [
        PLAN.steps[0]!,
        { id: "tools/manager/npm", label: "npm", manager: "script", cmd: "npm-step" },
        { id: "tools/homebrew", label: "Homebrew", manager: "script", cmd: "brew-step" },
        { id: "tools/brew/jq", label: "jq", manager: "brew", cmd: "jq-step", after: "tools/homebrew" },
        { id: "tools/brew/gh", label: "GitHub CLI", manager: "brew", cmd: "gh-step", after: "tools/homebrew" },
      ],
      serverTools: ["tools/brew/jq"],
    };
    const p = provisioner({ plan, holds: ["clis"] });
    const { frames } = await hosting({ provision: p.wired, vault: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", GH_TOKEN: "ghp_vaulted" } });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, clis: { jq: { via: "brew" }, gh: { via: "brew" } }, configs: { github: { signin: "vault" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    /** Where in the frames each CLI row landed. */
    const landed: [number, string][] = [];
    const land = (row: PlaceProvisionRow): void => {
      landed.push([frames.length, `landed ${row.id}`]);
      p.say("clis", row);
    };
    const order = (): string[] =>
      frames.flatMap((f, i) => [...landed.filter(([at]) => at === i).map(([, mark]) => mark), ...(f.line === undefined ? [] : [`${f.line.state === "running" ? "start" : "end"} ${f.line.step}`])]);
    await until(() => ["skills", "configs", "signins"].every(s => order().includes(`end ${s}`)) && p.ran.includes("clis"));
    await new Promise(r => setTimeout(r, 20));
    expect(order()).not.toContain("start github");
    expect(p.ran).not.toContain("mcp");
    land({ id: "tools/brew/gh", label: "GitHub CLI", outcome: "installed" });
    await until(() => ["github", "folders"].every(s => order().includes(`end ${s}`)));
    expect(p.ran).not.toContain("mcp");
    land({ id: "tools/brew/jq", label: "jq", outcome: "installed" });
    // The servers, and the plugins behind them, land once the CLI the servers run is on, while the rest still install.
    await until(() => ["mcp", "plugins"].every(s => order().includes(`end ${s}`)));
    expect(order()).not.toContain("end clis");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "github")).toMatchObject({ outcome: "present", step: "github" });
    // gh goes first among the CLIs behind the Homebrew it needs, then the servers' own, since those are waited on.
    expect(p.plans.clis?.steps.slice(p.plans.clis.agents).map(s => s.id)).toEqual(["tools/homebrew", "tools/brew/gh", "tools/brew/jq", "tools/manager/npm"]);
    p.let("clis");
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    // What each step needs, written once here: none starts before every one of them ended or landed.
    const needs: Record<PlaceSetupStep, string[]> = {
      floor: [],
      agents: ["end floor"],
      signins: ["end agents"],
      skills: ["end floor"],
      configs: ["end floor"],
      clis: ["end agents"],
      github: ["end floor", "landed tools/brew/gh"],
      mcp: ["end agents", "landed tools/brew/jq"],
      plugins: ["end mcp"],
      folders: ["end github"],
      folderServers: ["end mcp", "end plugins", "end folders"],
      context: ["agents", "signins", "skills", "configs", "clis", "github", "mcp", "plugins", "folders", "folderServers"].map(s => `end ${s}`),
    };
    const at = order();
    for (const [step, before] of Object.entries(needs)) {
      expect(at).toContain(`start ${step}`);
      for (const need of before) expect([step, need, at.indexOf(need) >= 0 && at.indexOf(need) < at.indexOf(`start ${step}`)]).toEqual([step, need, true]);
    }
    // Two at once on a 4 GB box, the sign-ins aside, and never more.
    const widths = frames.flatMap(f => (f.running === undefined ? [] : [f.running.filter(r => r !== "signins").length]));
    expect(Math.max(...widths)).toBe(2);
  });

  it("holds GitHub while the CLIs step runs and gh has not landed", async () => {
    const p = provisioner({ holds: ["clis"] });
    const { frames } = await hosting({ provision: p.wired, vault: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", GH_TOKEN: "ghp_vaulted" } });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, clis: { gh: { via: "brew" } }, configs: { github: { signin: "vault" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(() => p.ran.includes("clis") && p.ran.includes("configs"));
    await new Promise(r => setTimeout(r, 20));
    const at = (): string[] => frames.flatMap(f => (f.line === undefined ? [] : [`${f.line.state === "running" ? "start" : "end"} ${f.line.step}`]));
    expect(at()).not.toContain("start github");
    expect(at()).not.toContain("start folders");
    p.let("clis");
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(at().indexOf("end clis")).toBeLessThan(at().indexOf("start github"));
  });

  it("holds the folders until git-lfs's row is said, its hook run, and not until the rest of the CLIs land", async () => {
    const plan: ProvisionPlan = { ...PLAN, steps: [...PLAN.steps, { id: "tools/brew/jq", label: "jq", manager: "brew", cmd: "jq-step" }, { id: "tools/apt/git-lfs", label: "Git LFS", manager: "apt", cmd: "lfs-step" }] };
    const p = provisioner({ plan, holds: ["clis"] });
    const { frames } = await hosting({ provision: p.wired, vault: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", GH_TOKEN: "ghp_vaulted" } });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, clis: { gh: { via: "brew" } }, configs: { github: { signin: "vault" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    const at = (): string[] => frames.flatMap(f => (f.line === undefined ? [] : [`${f.line.state === "running" ? "start" : "end"} ${f.line.step}`]));
    await until(() => p.ran.includes("clis"));
    // gh first, then the hooked CLI, then the rest.
    expect(p.plans.clis?.steps.slice(p.plans.clis.agents).map(s => s.id)).toEqual(["tools/brew/gh", "tools/apt/git-lfs", "tools/brew/jq"]);
    p.say("clis", { id: "tools/brew/gh", label: "GitHub CLI", outcome: "installed" });
    await until(() => at().includes("end github"));
    await new Promise(r => setTimeout(r, 20));
    expect(at()).not.toContain("start folders");
    // The engine says a hooked row once its hook ran.
    p.say("clis", { id: "tools/apt/git-lfs", label: "Git LFS", outcome: "installed" });
    await until(() => at().includes("end folders"));
    expect(at()).not.toContain("end clis");
    p.let("clis");
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
  });

  it("holds the servers and the plugins until the CLI the servers run is on", async () => {
    const plan: ProvisionPlan = { ...PLAN, steps: [...PLAN.steps, { id: "tools/brew/jq", label: "jq", manager: "brew", cmd: "jq-step" }], serverTools: ["tools/brew/jq"] };
    const p = provisioner({ plan, holds: ["clis"], said: { clis: [{ id: "tools/brew/gh", label: "GitHub CLI", outcome: "installed" }] } });
    const { frames } = await hosting({ provision: p.wired });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(() => p.ran.includes("configs"));
    await new Promise(r => setTimeout(r, 20));
    expect(p.ran).not.toContain("mcp");
    p.let("clis");
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const at = frames.flatMap(f => (f.line === undefined ? [] : [`${f.line.state === "running" ? "start" : "end"} ${f.line.step}`]));
    expect(at.indexOf("end clis")).toBeLessThan(at.indexOf("start mcp"));
    expect(at.indexOf("end mcp")).toBeLessThan(at.indexOf("start plugins"));
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
    const p = provisioner();
    const { frames } = await hosting({ local: true, provision: p.wired, acts: s.acts, cmds, answer: cmd => (cmd.includes("ls-remote") ? { exitCode: 128 } : undefined) });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: repo, keep: [] } }, configs: { github: { signin: "machine" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    // gh's own login, one page and one code, on the row the GitHub step stands on, which put gh on once.
    expect(s.started).toEqual(["gh"]);
    expect(p.ran.filter(step => step === "github")).toEqual(["github"]);
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code !== undefined) === true);
    expect((await rowOf(place.id)).setup?.waiting).toEqual([expect.objectContaining({ row: "github", label: "GitHub", url: "https://auth.example/gh/1", code: "CODE-1" })]);
    // The folder stands on its own row while it waits, which its clone replaces.
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "skipped", note: WAITS_ON_GITHUB_LINE, step: "folders" });
    expect(placeWord(await rowOf(place.id), null).word).toBe("Needs you");
    const heard = frames.length;
    s.end("gh", { state: "signed-in" });
    await until(async () => (await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")?.note !== WAITS_ON_GITHUB_LINE);
    await new Promise(resolve => setTimeout(resolve, 30));
    // One end once the folder is in, not a ready before its clone and a second word after it.
    const ends = ended(frames.slice(heard));
    expect(ends).toHaveLength(1);
    expect(ends[0]?.end).toBe(placeWord(await rowOf(place.id), null).word === "Ready" ? "ready" : "needs-you");
    const row = await rowOf(place.id);
    expect(row.applied?.rows.find(r => r.id === "github")).toMatchObject({ outcome: "installed", step: "github" });
    expect(row.applied?.rows.find(r => r.id === "folders/app")?.note).not.toBe(NEEDS_GITHUB_LINE);
    expect(row.setup?.waiting).toEqual([]);
  });

  it("carries a folder that waited on GitHub its own servers after every step has ended, and still says the end once", async () => {
    const s = signIns();
    const { folder: repo, seed } = seededFolder();
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/private.git"]);
    const p = provisioner({ projectServers: true });
    const { frames } = await hosting({ local: true, provision: p.wired, acts: s.acts, cmds: [], checkouts: {}, seed, answer: cmd => (cmd.includes("ls-remote") ? { exitCode: 128 } : undefined) });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: repo, keep: [] } }, configs: { github: { signin: "machine" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code !== undefined) === true);
    expect(p.carried).toEqual([]);
    const heard = frames.length;
    s.end("gh", { state: "signed-in" });
    await until(async () => (await rowOf(place.id)).applied?.rows.some(r => r.id.startsWith("agents/mcp/claude/@")) === true);
    await new Promise(resolve => setTimeout(resolve, 30));
    const path = (await runtime!.projects.list())[0]!.path;
    expect(p.carried).toEqual([{ key: "app", path, after: expect.arrayContaining(["mcp", "plugins", "context"]) }]);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === `agents/mcp/claude/@${encodeURIComponent(path)}/kept`)).toMatchObject({ outcome: "installed", step: "folderServers" });
    expect(ended(frames.slice(heard))).toHaveLength(1);
  });

  it("reads a private folder as needing GitHub once the GitHub sign-in on the box failed", async () => {
    const s = signIns();
    const repo = privateRepo();
    await hosting({ local: true, provision: provisioner().wired, acts: s.acts, answer: cmd => (cmd.includes("ls-remote") ? { exitCode: 128 } : undefined) });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: repo, keep: [] } }, configs: { github: { signin: "machine" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code !== undefined) === true);
    s.end("gh", { state: "failed", said: "gh refused" });
    await until(async () => (await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")?.outcome === "failed");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "failed", note: NEEDS_GITHUB_LINE, step: "folders" });
  });

  it("lands a recipe folder as a project on that computer, the setup's own clone let past the setup it runs in", async () => {
    const { folder, seed } = seededFolder();
    await hosting({ provision: provisioner().wired, checkouts: {}, seed });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: folder, keep: [] } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "installed", step: "folders" });
    expect((await runtime!.projects.list()).map(p => [p.computer, p.source])).toEqual([[place.id, { kind: "folder", path: folder }]]);
  });

  it("writes what a folder's clone and seed say to the folders step's own log as they go, while the step still runs", async () => {
    const { folder, seed } = seededFolder();
    let clone = (): void => {};
    const created = new Promise<void>(resolve => (clone = resolve));
    const cmds: string[] = [];
    await hosting({ provision: provisioner().wired, checkouts: { created }, seed, cmds });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: folder, keep: [] } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.steps.some(l => l.step === "folders" && l.state === "running") === true);
    const at = placeProvisionPaths("/home/maya");
    const written = (cmd: string): string => Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(cmd)![1]!, "base64").toString("utf8");
    const folderLines = (): string[] => cmds.filter(c => c.includes(at.log) && c.includes("printf")).flatMap(c => written(c).split("\n")).filter(l => / \[folders\] app: /.test(l));
    await until(() => folderLines().length > 0);
    expect((await rowOf(place.id)).setup?.steps.find(l => l.step === "folders")?.state).toBe("running");
    expect(folderLines()[0]?.endsWith(` from ${folder}.`)).toBe(true);
    clone();
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await until(() => folderLines().some(l => / \[folders\] app: Cloning /.test(l)));
  });

  it("refuses a fork there while its folders clone, the setup's own clone going on past it", async () => {
    const { folder, seed } = seededFolder();
    let clone = (): void => {};
    const created = new Promise<void>(resolve => (clone = resolve));
    await hosting({ provision: provisioner().wired, checkouts: { created }, seed });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: folder, keep: [] } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.steps.some(l => l.step === "folders" && l.state === "running") === true);
    await expect(runtime!.places!.forkingBackend(place.id)).rejects.toThrow(placeProvisioningLine("spoo", "folders"));
    clone();
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "installed" });
  });

  it("keeps what the computer forks with on its record when the folder add first reads it under a setup write in flight", async () => {
    const { folder, seed } = seededFolder();
    const store = memoryStore();
    let letWrite = (): void => {};
    const held = new Promise<void>(resolve => (letWrite = resolve));
    let holding = false;
    const put = store.put.bind(store);
    // The setup's write of its folders line has read the record and is held before it lands.
    store.put = async (collection, id, value) => {
      const steps = (value as PlaceRecord).setup?.steps ?? [];
      if (collection === "places" && !holding && steps.some(l => l.step === "folders" && l.state === "running")) {
        holding = true;
        await held;
      }
      return put(collection, id, value);
    };
    // The ask at the join goes unanswered, so the folder add is the first to read what the computer forks with.
    let asked = 0;
    await hosting({ provision: provisioner().wired, store, checkouts: { answers: () => ++asked > 1 }, seed });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: folder, keep: [] } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(() => holding && asked > 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    letWrite();
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "installed" });
    expect(((await store.get("places", place.id)) as PlaceRecord).backendFacts).toMatchObject({ projects: "/wsp/projects" });
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
    expect((await store.get("pending-computers", "a_wait")) as { undo?: string }).toMatchObject({ undo: "undo-script", login: "root@10.0.0.9", hostKey: "ssh-ed25519 SHA256:box" });
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
    const pending = (id: string, login: string) => ({ id, address: login, step: "wsp", choices: LAPTOP, startedAt: new Date().toISOString(), undo: `undo ${id}`, login, hostKey: `key of ${login}` });
    await store.put("places", "p_spoo", record());
    await store.put("pending-computers", "a_joined", pending("a_joined", "root@10.0.0.9"));
    await store.put("pending-computers", "a_lost", pending("a_lost", "root@10.0.0.7"));
    const undone: [string, string | undefined, string][] = [];
    // The key the add saw rides to the undo, which runs nothing on a box answering with another.
    await hosting({ provision: provisioner().wired, store, undo: async (login, script) => void undone.push([login.ssh, login.hostKey, script]) });
    // The one hydration every road waits on, which is what a host does before it serves anything.
    await runtime!.workspaces.list();
    await until(async () => (await runtime!.places!.pending()).some(p => p.id === "a_lost" && p.failed !== undefined));
    const now = await runtime!.places!.pending();
    expect(now.find(p => p.id === "a_joined")).toMatchObject({ placeId: "p_spoo", step: "floor" });
    expect(now.find(p => p.id === "a_lost")).toMatchObject({ failed: { said: ADD_STOPPED_LINE } });
    expect(undone).toEqual([["root@10.0.0.7", "key of root@10.0.0.7", "undo a_lost"]]);
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

  it("resumes a setup that stopped after its folders and servers steps by carrying the folders those steps landed", async () => {
    const store = memoryStore();
    const { folder, seed } = seededFolder();
    const first = await hosting({ provision: provisioner({ projectServers: true }).wired, store, checkouts: {}, seed });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { app: { from: folder, name: "app", keep: [] } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    // Written back as a host that stopped before the folders' servers were carried would have left it.
    const held = (await store.get("places", place.id)) as PlaceRecord;
    const steps = held.setup!.steps.filter(l => l.step !== "folderServers" && l.step !== "context");
    await store.put("places", place.id, { ...held, setup: { ...held.setup!, state: "running", steps, finishedAt: undefined }, applied: { ...held.applied!, rows: held.applied!.rows.filter(r => r.step !== "folderServers") } });
    await stopHost();
    const again = provisioner({ projectServers: true });
    await hosting({ provision: again.wired, store, hostKey: first.hostKey, checkouts: {}, seed });
    await dialsBack(first.hostKey, place.id, first.joined[0]!.pair);
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(again.ran).toEqual(["context"]);
    expect(again.carried.map(c => c.key)).toEqual(["app"]);
  });

  it("resumes a waiting sign-in the person finished by hand between runs as already there, with no second start", async () => {
    const store = memoryStore();
    const s1 = signIns();
    const first = await hosting({ provision: provisioner().wired, store, acts: s1.acts });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code === "CODE-1") === true);
    const held = (await store.get("places", place.id)) as PlaceRecord;
    const steps = held.setup!.steps.filter(l => ["floor", "agents", "signins"].includes(l.step));
    await store.put("places", place.id, { ...held, setup: { ...held.setup!, state: "running", steps, finishedAt: undefined } });
    await stopHost();
    const s2 = signIns();
    await hosting({ provision: provisioner().wired, store, acts: s2.acts, hostKey: first.hostKey });
    await dialsBack(first.hostKey, place.id, first.joined[0]!.pair, [], codexIn);
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(s2.started).toEqual([]);
    expect((await rowOf(place.id)).setup?.waiting).toEqual([]);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/codex")).toMatchObject({ outcome: "present", note: SIGNED_IN_THERE, step: "signins" });
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

  it("reads a sign-in a stopped host left waiting after the setup ended as expired, and a retry runs the login again", async () => {
    const store = memoryStore();
    const s1 = signIns();
    const first = await hosting({ provision: provisioner().wired, store, acts: s1.acts });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code === "CODE-1") === true);
    await stopHost();
    const s2 = signIns();
    await hosting({ provision: provisioner().wired, store, acts: s2.acts, hostKey: first.hostKey });
    await dialsBack(first.hostKey, place.id, first.joined[0]!.pair);
    await until(async () => (await rowOf(place.id)).setup?.waiting[0]?.state === "expired");
    expect(placeWord(await rowOf(place.id), null)).toEqual({ word: "Needs you", sentence: "Codex's sign-in ran out; a retry asks for a fresh code" });
    expect(s2.started).toEqual([]);
    await runtime!.places!.setUp(place.id, {});
    await until(() => s2.started.length === 1);
    await until(async () => (await rowOf(place.id)).setup?.waiting[0]?.state === "waiting");
    expect((await rowOf(place.id)).setup?.waiting).toEqual([expect.objectContaining({ row: "signins/codex", url: "https://auth.example/codex/1", code: "CODE-1" })]);
  });
});

describe("what a computer can be set up from", () => {
  it("offers an agent's sign-in from the vault only where the vault holds its token or key", async () => {
    const r = shelf(LAPTOP, {});
    // As the host's options give them: Claude Code's one way is the token minted here, Codex's the copy or its login.
    const options: RecipeOptions = { agents: [{ id: "claude", name: "Claude Code", signins: ["vault"] }, { id: "codex", name: "Codex", signins: ["vault", "machine"] }], mcp: [], clis: [], skills: [], plugins: [], configs: [] };
    await hosting({ provision: provisioner().wired, recipes: { ...r.recipes, options: async () => options }, vault: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" } });
    expect((await runtime!.recipes!.options()).agents.map(a => [a.id, a.signins])).toEqual([
      ["claude", ["vault"]],
      ["codex", ["machine"]],
    ]);
    await stopHost();
    await hosting({ provision: provisioner().wired, recipes: { ...r.recipes, options: async () => options }, vault: {} });
    // With nothing to copy Claude Code has no choice left here: the picks say its token road, pasted on its row.
    expect((await runtime!.recipes!.options()).agents.map(a => [a.id, a.signins])).toEqual([
      ["claude", []],
      ["codex", ["machine"]],
    ]);
  });

  it("offers Codex's sign-in to copy where this computer holds its login, with no key in the vault, and not where that file is empty", async () => {
    const r = shelf(LAPTOP, {});
    const options: RecipeOptions = { agents: [{ id: "codex", name: "Codex", signins: ["vault", "machine"] }], mcp: [], clis: [], skills: [], plugins: [], configs: [] };
    const { local, auth } = codexHere(CODEX_AUTH);
    await hosting({ provision: provisioner().wired, local, recipes: { ...r.recipes, options: async () => options }, vault: {} });
    expect((await runtime!.recipes!.options()).agents.map(a => [a.id, a.signins])).toEqual([["codex", ["vault", "machine"]]]);
    writeFileSync(auth, "");
    expect((await runtime!.recipes!.options()).agents.map(a => [a.id, a.signins])).toEqual([["codex", ["machine"]]]);
  });
});

/** Codex's login as this computer holds it, the way a ChatGPT sign-in writes it. */
const CODEX_AUTH = `{"auth_mode":"chatgpt","tokens":{"refresh_token":"rt_TESTONLY"}}\n`;

/** This computer with Codex's login in its own folder, each agent's home being its catalog folder under one root. */
function codexHere(text: string): { local: LocalWiring; auth: string } {
  const root = mkdtempSync(join(tmpdir(), "wsp-setup-codex-"));
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "auth.json"), text);
  return { local: localWiring(root, id => join(root, `.${id}`)), auth: join(root, ".codex", "auth.json") };
}

describe("an agent's sign-in copied from this computer", () => {
  it("puts Codex's login from this computer in the box's logins folder on the run's input alone, and reads it signed in with no code", async () => {
    const s = signIns();
    const cmds: string[] = [];
    let landed: string | undefined;
    const answer = (cmd: string, input: string): { exitCode: number; stdout?: string } | undefined => {
      if (cmd.startsWith("uname -s;")) return { exitCode: 0, stdout: ["Linux", "0", "root", "root", "1", "/root", "/usr/bin", ""].join("\n") };
      if (cmd.includes("codex login status")) return landed === undefined ? { exitCode: 1, stdout: "Not logged in\n" } : { exitCode: 0, stdout: "Logged in using ChatGPT\n" };
      if (cmd.includes("/var/lib/wsp/logins/codex/auth.json")) landed = input;
      return undefined;
    };
    const { frames } = await hosting({
      provision: provisioner().wired,
      acts: s.acts,
      cmds,
      answer,
      local: codexHere(CODEX_AUTH).local,
      logins: "/var/lib/wsp/logins",
      vault: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" },
      report: report("spoo", { daemonVersion: DAEMON_VERSION, agents: ["claude", "codex"], logins: [], login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }),
    });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" }, codex: { signin: "vault" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(s.started).toEqual([]);
    expect(landed).toBe(CODEX_AUTH);
    expect(cmds.some(c => c.includes("rt_TESTONLY"))).toBe(false);
    const row = await rowOf(place.id);
    expect(row.setup?.waiting).toEqual([]);
    expect(row.applied?.rows.find(r => r.id === "signins/codex")).toMatchObject({ outcome: "installed", note: expect.stringMatching(/^copied from /), step: "signins" });
    expect(row.signIns).toEqual({ claude: "vault-key", codex: "signed-in" });
    expect(ended(frames).map(f => f.end)).toEqual(["ready"]);
  });

  it("leaves a login Codex already has on the box as it is, and copies nothing over it", async () => {
    const cmds: string[] = [];
    await hosting({
      provision: provisioner().wired,
      acts: signIns().acts,
      cmds,
      answer: codexIn,
      local: codexHere(CODEX_AUTH).local,
      logins: "/var/lib/wsp/logins",
      report: report("spoo", { daemonVersion: DAEMON_VERSION, agents: ["claude", "codex"], logins: [], login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }),
    });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" }, codex: { signin: "vault" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(cmds.some(c => c.includes("auth.json"))).toBe(false);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/codex")).toMatchObject({ outcome: "present", note: SIGNED_IN_THERE });
  });

  it("copies nothing where Codex did not install there, since its status cannot read the login that computer may hold", async () => {
    const cmds: string[] = [];
    await hosting({
      provision: provisioner({ rows: { agents: [{ id: "agents/codex", label: "Codex", outcome: "failed", note: "npm ERR! 404" }] } }).wired,
      acts: signIns().acts,
      cmds,
      answer: cmd => (cmd.includes("codex login status") ? { exitCode: 127, stdout: "bash: line 2: codex: command not found\n" } : undefined),
      local: codexHere(CODEX_AUTH).local,
      logins: "/var/lib/wsp/logins",
      report: report("spoo", { daemonVersion: DAEMON_VERSION, agents: ["claude", "codex"], logins: [], login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }),
    });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" }, codex: { signin: "vault" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state !== "running");
    expect(cmds.filter(c => c.includes("auth.json"))).toEqual([]);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/codex")).toMatchObject({ outcome: "skipped", note: waitsForInstallLine("Codex") });
  });
});

describe("what the picks weigh before Set up", () => {
  it("weighs the picks on this computer against the room the computer last said it has, by a pending add or the computer", async () => {
    await hosting({ provision: provisioner().wired });
    const added = await runtime!.places!.add({ addId: "a_wait", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    await until(async () => (await runtime!.places!.pending())[0]?.step === "choosing");
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: {}, codex: {} }, plugins: { "lint@acme": {} } });
    const free = CURRENT.diskFreeBytes;
    // A computer that never said its disk's size keeps the 2 GB floor free.
    const weighed = { neededBytes: 2 * 1024 ** 3, keptBytes: ownedFloorBytes(undefined) };
    expect(await runtime!.places!.estimate("a_wait", picks)).toEqual({ ...weighed, freeBytes: free, unmeasured: 1 });
    expect(await runtime!.places!.estimate(added.place.id, picks)).toEqual({ ...weighed, freeBytes: free, unmeasured: 1 });
    // An add that never joined has said nothing of its room.
    expect(await runtime!.places!.estimate("root@10.0.0.77", picks)).toEqual({ ...weighed, unmeasured: 1 });
  });

  it("counts the room the install loop keeps free off the computer's disk size in what the picks need", async () => {
    const GB = 1024 ** 3;
    await hosting({ provision: provisioner().wired, report: report("spoo", { daemonVersion: DAEMON_VERSION, diskFreeBytes: 9 * GB, diskSizeBytes: 75 * GB }) });
    const added = await runtime!.places!.add({ addId: "a_wait", address: "root@10.0.0.9", hostUrls: DOOR }, Date.now());
    await until(async () => (await runtime!.places!.pending())[0]?.step === "choosing");
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: {}, codex: {} } });
    // A tenth of 75 GB is kept free, past the 2 GB floor: 9 GB free does not take 2 GB of picks.
    expect(await runtime!.places!.estimate(added.place.id, picks)).toEqual({ neededBytes: 2 * GB, keptBytes: ownedFloorBytes(75 * GB), freeBytes: 9 * GB, unmeasured: 0 });
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

  it("lands a skipped sign-in as signed in once the person signs it in on that computer afterwards, and says the row changed", async () => {
    const s = signIns();
    await hosting({ provision: provisioner().wired, acts: s.acts });
    const changed: PlaceView[] = [];
    runtime!.events.on("place.changed", e => void changed.push((e as { place: PlaceView }).place));
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code !== undefined) === true);
    await runtime!.places!.skip(place.id, "signins/codex");
    await runtime!.agents.signIn({ placeId: place.id }, { agent: "codex" }, () => {});
    await until(() => s.started.length === 2);
    s.end("codex", { state: "signed-in" });
    await until(async () => (await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/codex")?.outcome === "installed");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/codex")).toMatchObject({ outcome: "installed", note: SIGNED_IN_THERE, step: "signins" });
    expect(changed.at(-1)?.applied?.rows.find(r => r.id === "signins/codex")?.outcome).toBe("installed");
  });

  it("lands a skipped GitHub sign-in once gh signs in on that computer afterwards", async () => {
    const s = signIns();
    await hosting({ provision: provisioner().wired, acts: s.acts });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, configs: { github: { signin: "skip" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "github")?.outcome).toBe("skipped");
    await runtime!.agents.signIn({ placeId: place.id }, { agent: "gh" }, () => {});
    await until(() => s.started.includes("gh"));
    s.end("gh", { state: "signed-in" });
    await until(async () => (await rowOf(place.id)).applied?.rows.find(r => r.id === "github")?.outcome === "installed");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "github")).toMatchObject({ outcome: "installed", note: SIGNED_IN_THERE });
  });

  it("writes the setup through to its end though a listener of one of its frames throws", async () => {
    const { frames } = await hosting({ provision: provisioner().wired });
    runtime!.events.on("place.setup", e => {
      const line = (e as PlaceSetupEvent).line;
      if (line?.step === "context" && line.state === "done") throw new Error("a listener that throws");
    });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: LAPTOP }, Date.now());
    await until(() => ended(frames).length > 0);
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
  });

  it("puts no gh on for a GitHub row set aside, so a gh that would not install there leaves it skipped and the computer Ready", async () => {
    const p = provisioner({ rows: { github: [{ id: "github/gh", label: "GitHub CLI", outcome: "failed", note: "E: Unable to locate package gh" }] } });
    await hosting({ provision: p.wired });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, configs: { github: { signin: "skip" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(p.ran).not.toContain("github");
    const row = await rowOf(place.id);
    expect(row.applied?.rows.filter(r => r.step === "github").map(r => [r.id, r.outcome, r.note])).toEqual([["github", "skipped", GITHUB_SKIPPED_LINE]]);
    expect(placeWord(row, null).word).toBe("Ready");
  });

  it("puts gh on first when the GitHub row's Sign in starts on a computer with none, says so on that sign-in, then signs in", async () => {
    const s = signIns();
    const p = provisioner({ rows: { github: [{ id: "github/gh", label: "GitHub CLI", outcome: "installed" }] }, installs: ["github"] });
    await hosting({ provision: p.wired, acts: s.acts });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, configs: { github: { signin: "skip" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(p.ran).not.toContain("github");
    const steps: Record<string, unknown>[] = [];
    await runtime!.agents.signIn({ placeId: place.id }, { agent: "gh" }, e => void steps.push(e));
    await until(() => s.started.includes("gh"));
    expect(p.ran).toContain("github");
    // Planned for the GitHub step alone, from the computer's own picks with GitHub signed in there.
    expect(p.picked.at(-1)?.configs.github).toEqual({ signin: "machine" });
    expect(steps[0]).toMatchObject({ state: "running", said: installingFirstLine("GitHub CLI") });
    // On the record as the setup's own gh would be, so a recipe that drops GitHub later takes it off again.
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "github/gh")).toMatchObject({ outcome: "installed", step: "github" });
    s.end("gh", { state: "signed-in" });
    await until(async () => (await rowOf(place.id)).applied?.rows.find(r => r.id === "github")?.outcome === "installed");
    // The engine's rows carry no step: a later run, which keeps only the rows of the steps that ended, keeps it too.
    const again = await runtime!.places!.setUp(place.id, {});
    await until(async () => (await rowOf(place.id)).setup?.addId === again.addId && (await rowOf(place.id)).setup?.state === "done");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "github/gh")).toMatchObject({ outcome: "installed", step: "github" });
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "github")).toMatchObject({ outcome: "installed", note: SIGNED_IN_THERE });
    expect(p.ran.filter(s => s === "github")).toHaveLength(1);
  });

  it("says nothing of installing gh on the GitHub row's sign-in where gh is there already", async () => {
    const s = signIns();
    const p = provisioner({ rows: { github: [{ id: "github/gh", label: "GitHub CLI", outcome: "present" }] } });
    await hosting({ provision: p.wired, acts: s.acts });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, configs: { github: { signin: "skip" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const steps: Record<string, unknown>[] = [];
    await runtime!.agents.signIn({ placeId: place.id }, { agent: "gh" }, e => void steps.push(e));
    await until(() => s.started.includes("gh"));
    expect(steps.map(e => e["said"])).not.toContain(installingFirstLine("GitHub CLI"));
    // gh the person had there is theirs: no row says wsp put it on.
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "github/gh")).toBeUndefined();
  });

  it("puts gh on first where the command line asks for gh's line on a computer with none, so wsp add --sign-in gh runs where gh is", async () => {
    const p = provisioner({ rows: { github: [{ id: "github/gh", label: "GitHub CLI", outcome: "installed" }] }, installs: ["github"] });
    await hosting({ provision: p.wired, acts: signIns().acts });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, configs: { github: { signin: "skip" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect(p.ran).not.toContain("github");
    const line = await runtime!.agents.signInLine({ placeId: place.id }, { agent: "gh" });
    expect(line.command).toBe("gh login");
    expect(p.ran).toContain("github");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "github/gh")).toMatchObject({ outcome: "installed", step: "github" });
  });

  it("refuses the command line's gh line where gh would not install there, in gh's own words, and the computer still reads Ready", async () => {
    const p = provisioner({ rows: { github: [{ id: "github/gh", label: "GitHub CLI", outcome: "failed", note: "apt-get install gh\nE: Unable to locate package gh" }] } });
    await hosting({ provision: p.wired, acts: signIns().acts });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, configs: { github: { signin: "skip" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await expect(runtime!.agents.signInLine({ placeId: place.id }, { agent: "gh" })).rejects.toThrow("E: Unable to locate package gh");
    const row = await rowOf(place.id);
    expect(row.applied?.rows.filter(r => r.step === "github").map(r => [r.id, r.outcome])).toEqual([["github", "skipped"]]);
    expect(placeWord(row, null).word).toBe("Ready");
  });

  it("says a gh that would not install on the GitHub row's sign-in alone: no login runs, and the computer still reads Ready", async () => {
    const s = signIns();
    const p = provisioner({ rows: { github: [{ id: "github/gh", label: "GitHub CLI", outcome: "failed", note: "apt-get install gh\nE: Unable to locate package gh" }] } });
    await hosting({ provision: p.wired, acts: s.acts });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, configs: { github: { signin: "skip" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const steps: Record<string, unknown>[] = [];
    await runtime!.agents.signIn({ placeId: place.id }, { agent: "gh" }, e => void steps.push(e));
    await until(() => steps.some(e => e["state"] === "failed"));
    expect(steps.at(-1)).toMatchObject({ state: "failed", said: "E: Unable to locate package gh" });
    expect(s.started).not.toContain("gh");
    const row = await rowOf(place.id);
    expect(row.applied?.rows.filter(r => r.step === "github").map(r => [r.id, r.outcome])).toEqual([["github", "skipped"]]);
    expect(placeWord(row, null).word).toBe("Ready");
  });

  it("leaves OpenCode's sign-in, which asks the person to pick, for them at its own terminal there: no login runs and nothing fails", async () => {
    const s = signIns();
    await hosting({ provision: provisioner({ rows: { agents: [{ id: "agents/opencode", label: "OpenCode", outcome: "installed" }] } }).wired, acts: s.acts });
    const picks = RecipeFile.parse({ name: "laptop", agents: { opencode: { signin: "machine" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const row = await rowOf(place.id);
    expect(s.started).toEqual([]);
    expect(row.setup?.waiting).toEqual([]);
    expect(row.applied?.rows.find(r => r.id === "signins/opencode")).toMatchObject({ outcome: "skipped", note: AT_ITS_TERMINAL, step: "signins" });
    expect(placeWord(row, null).word).toBe("Ready");
  });

  it("lands OpenCode's row signed in once the sign-in run at its terminal there ends signed in", async () => {
    const s = signIns();
    const asks: SignInAsk[] = [];
    const acts: AgentsActs = { ...s.acts, signIn: async (on, ask) => (asks.push(ask), s.acts.signIn(on, ask)) };
    await hosting({ provision: provisioner({ rows: { agents: [{ id: "agents/opencode", label: "OpenCode", outcome: "installed" }] } }).wired, acts });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: RecipeFile.parse({ name: "laptop", agents: { opencode: { signin: "machine" } } }) }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await runtime!.agents.signIn({ placeId: place.id }, { agent: "opencode", terminal: true }, () => {});
    await until(() => s.started.includes("opencode"));
    expect(asks).toEqual([{ agent: "opencode", terminal: true }]);
    s.end("opencode", { state: "signed-in" });
    await until(async () => (await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/opencode")?.outcome === "installed");
  });

  it("leaves a sign-in there waiting on its agent where that agent did not install, with no login run where nothing can answer it", async () => {
    const s = signIns();
    await hosting({ provision: provisioner({ rows: { agents: [{ id: "agents/codex", label: "Codex", outcome: "failed", note: "npm ERR! 404" }] } }).wired, acts: s.acts });
    const picks = RecipeFile.parse({ name: "laptop", agents: { codex: { signin: "machine" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state !== "running");
    expect(s.started).toEqual([]);
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/codex")).toMatchObject({ outcome: "skipped", note: waitsForInstallLine("Codex") });
  });

  it("lands a sign-in the person set aside once its token is in this host's vault, as a run still going would", async () => {
    const vault: Record<string, string> = {};
    const s = signIns();
    const acts: AgentsActs = { ...s.acts, key: async (_agent, key) => void (vault["CLAUDE_CODE_OAUTH_TOKEN"] = key) };
    await hosting({ provision: provisioner().wired, acts, vault });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await runtime!.places!.skip(place.id, "signins/claude");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/claude")?.outcome).toBe("skipped");
    await runtime!.agents.key("claude", "sk-ant-oat01-x");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/claude")).toMatchObject({ outcome: "present", note: copiedFromLine("zingzys-mac") });
  });

  it("keeps a sign-in landed while the setup still runs: the run lands it among its own rows, so its next write keeps it", async () => {
    const changed: PlaceView[] = [];
    const p = provisioner({ holds: ["mcp"] });
    await hosting({ provision: p.wired });
    runtime!.events.on("place.changed", e => void changed.push((e as { place: PlaceView }).place));
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, clis: { jq: { via: "brew" } }, configs: { github: { signin: "skip" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).applied?.rows.find(r => r.id === "github")?.outcome === "skipped");
    expect((await rowOf(place.id)).setup?.state).toBe("running");
    await runtime!.places!.loginLanded(place.id, "gh");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "github")).toMatchObject({ outcome: "installed", note: SIGNED_IN_THERE, label: "GitHub", step: "github" });
    expect(changed.at(-1)?.applied?.rows.find(r => r.id === "github")?.outcome).toBe("installed");
    p.let("mcp");
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "github")?.outcome).toBe("installed");
  });

  it("lands a sign-in that had nothing to copy once its token is in this host's vault, which every turn there reads", async () => {
    const vault: Record<string, string> = {};
    const s = signIns();
    const acts: AgentsActs = { ...s.acts, key: async (_agent, key) => void (vault["CLAUDE_CODE_OAUTH_TOKEN"] = key) };
    await hosting({ provision: provisioner().wired, acts, vault });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    // Claude Code has no login to run on a computer, so its fix is the token, not a sign-in there.
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/claude")).toMatchObject({ outcome: "failed", note: noCopyLine("Claude Code", "zingzys-mac"), fix: signInWithFix("Claude Code", "token") });
    await runtime!.agents.key("claude", "sk-ant-oat01-x");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/claude")).toMatchObject({ outcome: "present", note: copiedFromLine("zingzys-mac"), label: "Claude Code", step: "signins" });
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
    await until(async () => (await rowOf(place.id)).applied?.rows.find(r => r.id === "folders/app")?.outcome === "failed");
    const row = await rowOf(place.id);
    expect(row.applied?.rows.find(r => r.id === "github")).toMatchObject({ outcome: "skipped", note: SKIPPED_FOR_NOW });
    expect(row.applied?.rows.find(r => r.id === "folders/app")).toMatchObject({ outcome: "failed", note: NEEDS_GITHUB_LINE });
  });
});

describe("a computer that follows a recipe", () => {
  const V1 = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, clis: { jq: { via: "brew" } }, skills: { unslop: { from: "~/.claude/skills" } } });
  const ITEMS = { "clis/jq": "1.7", "skills/unslop": "d1" };

  /** A computer set up from the saved recipe and in step with it. */
  async function following(o: { undo?: (removed: readonly { kind: string; name: string }[]) => PlaceUndo[]; answer?: (cmd: string) => { exitCode: number; stdout?: string } | undefined; cmds?: string[]; rows?: Partial<Record<EngineStep, PlaceProvisionRow[]>>; recipe?: RecipeFile; logins?: string; report?: PlaceReport } = {}) {
    const opts: Parameters<typeof provisioner>[0] = { ...(o.undo !== undefined ? { undo: o.undo } : {}), ...(o.rows !== undefined ? { rows: o.rows } : {}) };
    const p = provisioner(opts);
    const recipe = o.recipe ?? V1;
    const r = shelf(recipe, ITEMS);
    const host = await hosting({
      provision: p.wired,
      recipes: r.recipes,
      ...(o.answer !== undefined ? { answer: o.answer } : {}),
      ...(o.cmds !== undefined ? { cmds: o.cmds } : {}),
      ...(o.logins !== undefined ? { logins: o.logins } : {}),
      ...(o.report !== undefined ? { report: o.report } : {}),
    });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: recipe, recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    // The setup holds the computer against the recipe as resolved, so the sync its link starts finds nothing to do.
    expect((await rowOf(place.id)).applied).toMatchObject({ hash: "h1", items: ITEMS });
    await new Promise(resolve => setTimeout(resolve, 20));
    p.ran.length = 0;
    return { p, r, host, opts, placeId: place.id };
  }

  /** A computer set up once where wsp put jq on, which the engine reads as present from then on, as it does a tool
   * found there whoever put it on, and a recipe drop of jq that takes it off with its own command. */
  async function jqPutOn() {
    const cmds: string[] = [];
    const clis: PlaceProvisionRow[] = [{ id: "tools/brew/jq", label: "jq", outcome: "installed" }];
    const agents: PlaceProvisionRow[] = [{ id: "agents/claude", label: "Claude Code", outcome: "installed" }];
    const set = await following({
      cmds,
      rows: { clis, agents },
      undo: removed => removed.map(c => ({ key: `${c.kind}/${c.name}`, label: c.name, ids: ["tools/brew/jq"], owner: "tools/brew/jq", cmd: `take-off-${c.name}` })),
    });
    clis.splice(0, 1, { id: "tools/brew/jq", label: "jq", outcome: "present" });
    agents.splice(0, 1, { id: "agents/claude", label: "Claude Code", outcome: "present" });
    const setUpAgain = async (): Promise<void> => {
      const before = (await rowOf(set.placeId)).setup?.startedAt;
      await new Promise(resolve => setTimeout(resolve, 5));
      await runtime!.places!.setUp(set.placeId, {});
      await until(async () => (await rowOf(set.placeId)).setup?.startedAt !== before);
    };
    const settled = (): Promise<void> => until(async () => (await rowOf(set.placeId)).setup?.state === "done");
    const jq = async (): Promise<PlaceProvisionRow["outcome"] | undefined> => (await rowOf(set.placeId)).applied?.rows.find(row => row.id === "tools/brew/jq")?.outcome;
    const dropJq = async (): Promise<string[]> => {
      set.r.move({ ...V1, clis: {} }, { "skills/unslop": "d1" }, "h12");
      await runtime!.places!.recipeChanged("laptop");
      await until(async () => (await rowOf(set.placeId)).applied?.hash === "h12");
      return cmds.filter(c => c.startsWith("take-off-"));
    };
    return { ...set, cmds, clis, setUpAgain, settled, jq, dropJq };
  }

  it("never refuses a fork there as still being set up while a sync runs, and holds the daemon off it meanwhile", async () => {
    const { p, r, placeId } = await following();
    p.arm("skills");
    r.move({ ...V1, skills: { ...V1.skills, why: { from: "~/.claude/skills" } } }, { ...ITEMS, "skills/why": "d2" }, "h2");
    await runtime!.places!.recipeChanged("laptop");
    await until(() => p.ran.includes("skills"));
    // A sync adds what moved to a computer already set up; a thread starting there meanwhile is not a fork into a half set up one.
    await expect(runtime!.places!.forkingBackend(placeId)).resolves.toBeDefined();
    // The daemon is not moved under it: a restart there would cut the link the sync installs over.
    await expect(runtime!.places!.update(placeId)).rejects.toThrow(placeSyncingLine("spoo"));
    p.let("skills");
    await until(async () => (await rowOf(placeId)).applied?.hash === "h2");
  });

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
      undo: removed => removed.map(c => ({ key: `${c.kind}/${c.name}`, label: c.name, ids: [c.kind === "clis" ? "tools/brew/jq" : "agents/claude"], owner: c.kind === "clis" ? "tools/brew/jq" : "agents/claude", cmd: `take-off-${c.name}` })),
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

  it("keeps a tool wsp put on as wsp's through a setup run again, and takes it off once the recipe drops it", async () => {
    const set = await jqPutOn();
    await set.setUpAgain();
    await set.settled();
    expect(set.p.ran).toContain("clis");
    expect(await set.jq()).toBe("installed");
    // The line a terminal prints says what this run did, and this run found everything there.
    const row = await rowOf(set.placeId);
    expect(setupLines("spoo", row.setup!, row.applied)[0]).toBe("spoo: nothing installed, 3 already there");
    expect(await set.dropJq()).toEqual(["take-off-jq"]);
  });

  it("keeps a tool wsp put on as wsp's through a setup run again that the link cut and the dial-back resumed", async () => {
    const set = await jqPutOn();
    set.p.arm("agents");
    await set.setUpAgain();
    await until(() => set.p.ran.includes("agents"));
    // Whose jq is stands on the record while the second run has not reached its step yet.
    expect(await set.jq()).toBe("installed");
    for (const ws of sockets.splice(0)) ws.close();
    await until(async () => (await rowOf(set.placeId)).present === false);
    set.opts.throws = { step: "agents", error: new PlaceAbsentError("spoo is not connected") };
    set.p.let("agents");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await rowOf(set.placeId)).setup?.state).toBe("running");
    expect(await set.jq()).toBe("installed");
    delete set.opts.throws;
    await dialsBack(set.host.hostKey, set.placeId, set.host.joined[0]!.pair, set.cmds);
    await set.settled();
    expect(set.p.ran.filter(s => s === "clis")).toEqual(["clis"]);
    expect(await set.jq()).toBe("installed");
    expect(await set.dropJq()).toEqual(["take-off-jq"]);
  });

  it("keeps a tool wsp put on as wsp's through a setup whose CLIs step threw, and a setup after it", async () => {
    const set = await jqPutOn();
    set.opts.throws = { step: "clis", error: new Error("brew: could not resolve host") };
    await set.setUpAgain();
    await set.settled();
    const rows = (await rowOf(set.placeId)).applied?.rows ?? [];
    expect(rows.find(r => r.id === "clis/stopped")).toMatchObject({ outcome: "failed", note: "brew: could not resolve host" });
    expect(await set.jq()).toBe("installed");
    delete set.opts.throws;
    await set.setUpAgain();
    await set.settled();
    expect(await set.jq()).toBe("installed");
    expect(await set.dropJq()).toEqual(["take-off-jq"]);
  });

  it("keeps a tool wsp put on as wsp's through a sync that runs its step again for a CLI the recipe added", async () => {
    const set = await jqPutOn();
    set.clis.push({ id: "tools/brew/rg", label: "ripgrep", outcome: "installed" });
    set.r.move({ ...V1, clis: { ...V1.clis, rg: { via: "brew" } } }, { ...ITEMS, "clis/rg": "14" }, "h11");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(set.placeId)).applied?.hash === "h11");
    expect(set.p.ran).toEqual(["clis", "context"]);
    const rows = (await rowOf(set.placeId)).applied?.rows ?? [];
    expect(rows.filter(r => r.step === "clis").map(r => [r.id, r.outcome])).toEqual([
      ["tools/brew/jq", "installed"],
      ["tools/brew/rg", "installed"],
    ]);
    expect(await set.dropJq()).toEqual(["take-off-jq"]);
  });

  it("leaves a sign-in row as its own step reads it, though an earlier run signed it in there", async () => {
    const s = signIns();
    const there = RecipeFile.parse({ ...V1, agents: { ...V1.agents, codex: { signin: "machine" } } });
    const r = shelf(there, ITEMS);
    await hosting({ provision: provisioner().wired, recipes: r.recipes, acts: s.acts, vault: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x", OPENAI_API_KEY: "sk-x" } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: there, recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.url !== undefined) === true);
    s.end("codex", { state: "signed-in" });
    await until(async () => (await rowOf(place.id)).applied?.rows.find(row => row.id === "signins/codex")?.outcome === "installed");
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    r.move({ ...V1, agents: { ...V1.agents, codex: { signin: "vault" } } }, ITEMS, "h11");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(place.id)).applied?.hash === "h11");
    expect((await rowOf(place.id)).applied?.rows.find(row => row.id === "signins/codex")).toMatchObject({ outcome: "present", note: copiedFromLine("zingzys-mac") });
  });

  it("keeps an agent its setup installed as wsp's when a later sync's agents step finds it already there", async () => {
    const agents: PlaceProvisionRow[] = [{ id: "agents/claude", label: "Claude Code", outcome: "installed" }];
    const { p, r, placeId } = await following({ rows: { agents } });
    agents.splice(0, agents.length, { id: "agents/claude", label: "Claude Code", outcome: "present" }, { id: "agents/codex", label: "Codex", outcome: "installed" });
    r.move({ ...V1, agents: { ...V1.agents, codex: { signin: "vault" } } }, { ...ITEMS, "agents/codex": "c1" }, "h11");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(placeId)).applied?.hash === "h11");
    expect(p.ran).toContain("agents");
    const rows = (await rowOf(placeId)).applied?.rows ?? [];
    expect(rows.find(row => row.id === "agents/claude")).toMatchObject({ outcome: "installed" });
    expect(rows.find(row => row.id === "agents/codex")).toMatchObject({ outcome: "installed" });
  });

  it("never takes an agent the box had before wsp off, though wsp landed a file of its own for it, and says why on its row", async () => {
    const cmds: string[] = [];
    const { r, placeId } = await following({
      cmds,
      rows: { agents: [{ id: "agents/claude", label: "Claude Code", outcome: "present" }], mcp: [{ id: "files/.claude/settings.json", label: "settings", outcome: "installed", kind: "file" }] },
      answer: cmd => (cmd.includes("wsp-unland") ? { exitCode: 0, stdout: "wsp-unland\tgone\t.claude/settings.json\n" } : undefined),
      undo: () => [{ key: "agents/claude", label: "Claude Code", ids: ["agents/claude", "signins/claude", "files/.claude/settings.json"], owner: "agents/claude", cmd: "take-off-claude", dests: [".claude/settings.json"] }],
    });
    r.move({ ...V1, agents: {} }, { "clis/jq": "1.7", "skills/unslop": "d1" }, "h10");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(placeId)).applied?.hash === "h10");
    expect(cmds.filter(c => c.startsWith("take-off-"))).toEqual([]);
    // Its own file wsp landed comes off by the ledger all the same, and the row says the agent stays.
    expect(cmds.some(c => c.includes("wsp-unland"))).toBe(true);
    expect((await rowOf(placeId)).applied?.rows.find(row => row.id === "agents/claude")).toMatchObject({ outcome: "skipped", note: wasThereLine("spoo") });
  });

  it("takes a dropped Codex's files off under the box's logins folder, which its threads there read as CODEX_HOME", async () => {
    const cmds: string[] = [];
    const withCodex = RecipeFile.parse({ ...V1, agents: { ...V1.agents, codex: { signin: "vault" } } });
    const { r } = await following({
      cmds,
      recipe: withCodex,
      logins: "/var/lib/wsp/logins",
      report: report("spoo", { daemonVersion: DAEMON_VERSION, login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }),
      rows: { agents: [{ id: "agents/codex", label: "Codex", outcome: "installed" }] },
      answer: cmd =>
        cmd.startsWith("uname -s;")
          ? { exitCode: 0, stdout: ["Linux", "0", "root", "root", "1", "/root", "/usr/bin", ""].join("\n") }
          : cmd.includes("wsp-unland")
            ? { exitCode: 0, stdout: "wsp-unland\tgone\t.codex/AGENTS.md\n" }
            : undefined,
      undo: () => [{ key: "agents/codex", label: "Codex", ids: ["agents/codex", "files/.codex/AGENTS.md"], owner: "agents/codex", dests: [".codex/AGENTS.md"] }],
    });
    r.move(V1, ITEMS, "h10");
    await runtime!.places!.recipeChanged("laptop");
    await until(() => cmds.some(c => c.includes("wsp-unland")));
    expect(cmds.find(c => c.includes("wsp-unland"))).toContain("('.codex'/*) root='/var/lib/wsp/logins/codex'");
    // Claude Code's own files are named under its store by the plan itself, and its skills land under the home.
    expect(cmds.find(c => c.includes("wsp-unland"))).not.toContain("'.claude'/*");
  });

  it("never takes gh off for a GitHub row dropped where gh came as a CLI, though the GitHub sign-in there was wsp's", async () => {
    const cmds: string[] = [];
    const withGitHub = { ...V1, clis: { ...V1.clis, gh: { via: "brew" } }, configs: { github: { signin: "machine" as const } } };
    const p = provisioner({ undo: () => [{ key: "configs/github", label: "GitHub", ids: ["configs/github", "github", "github/gh"], owner: "github/gh", cmd: "take-off-gh" }] });
    const r = shelf(withGitHub, ITEMS);
    const s = signIns();
    await hosting({ provision: p.wired, recipes: r.recipes, cmds, acts: s.acts });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: withGitHub, recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.row === "github" && w.code !== undefined) === true);
    s.end("gh", { state: "signed-in" });
    await until(async () => (await rowOf(place.id)).applied?.rows.find(row => row.id === "github")?.outcome === "installed");
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    r.move({ ...withGitHub, configs: {} }, ITEMS, "h11");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(place.id)).applied?.hash === "h11");
    expect(cmds.filter(c => c.startsWith("take-off-"))).toEqual([]);
  });

  it("runs nothing when a computer set up from picks follows a recipe that holds those same picks", async () => {
    const p = provisioner();
    const r = shelf(V1, ITEMS);
    await hosting({ provision: p.wired, recipes: r.recipes });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: V1 }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const ranBefore = [...p.ran];
    // Saved as a recipe at the end of the dialog and followed: the computer already holds every row of it.
    await runtime!.places!.follow(place.id, "laptop");
    await until(async () => (await rowOf(place.id)).applied?.hash === "h1");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(p.ran).toEqual(ranBefore);
    expect((await rowOf(place.id)).sync).toBeUndefined();
  });

  it("says a follow, an unfollow and a changed recipe on the stream, whether or not any computer moves", async () => {
    const { placeId } = await following();
    const heard: string[] = [];
    runtime!.events.on("recipes.changed", e => void heard.push((e as { slug: string }).slug));
    await runtime!.places!.follow(placeId, "laptop");
    await runtime!.places!.recipeChanged("laptop");
    await runtime!.places!.unfollow("laptop");
    expect(heard).toEqual(["laptop", "laptop", "laptop"]);
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

  it("starts no sign-in for an agent a sync adds whose own status there says signed in, and lands its row as already there", async () => {
    const s = signIns();
    const p = provisioner();
    const r = shelf(V1, ITEMS);
    await hosting({ provision: p.wired, recipes: r.recipes, acts: s.acts, answer: codexIn, report: report("spoo", { daemonVersion: DAEMON_VERSION, agents: ["claude", "codex"], logins: [] }) });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: V1, recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    r.move({ ...V1, agents: { ...V1.agents, codex: { signin: "machine" } } }, ITEMS, "h11");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(place.id)).applied?.hash === "h11");
    expect(s.started).toEqual([]);
    expect((await rowOf(place.id)).applied?.rows.find(row => row.id === "signins/codex")).toMatchObject({ outcome: "present", note: SIGNED_IN_THERE, step: "signins" });
  });

  it("lands a folder a sync adds as a project on that computer", async () => {
    const { folder, seed } = seededFolder();
    const r = shelf(V1, ITEMS);
    await hosting({ provision: provisioner().wired, recipes: r.recipes, checkouts: {}, seed });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: V1, recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    r.move({ ...V1, folders: { app: { from: folder, keep: [] } } }, ITEMS, "h10");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(place.id)).applied?.hash === "h10");
    expect((await rowOf(place.id)).applied?.rows.find(row => row.id === "folders/app")).toMatchObject({ outcome: "installed", step: "folders" });
    expect((await runtime!.projects.list()).map(p => p.computer)).toEqual([place.id]);
  });

  it("puts a folder's hue the recipe moved on the project a setup made, and reads it installed", async () => {
    const { folder, seed } = seededFolder();
    const pick = (hue: string): RecipeFile => ({ ...V1, folders: { app: { from: folder, name: "app", keep: [], hue: hue as "red" } } });
    const r = shelf(pick("red"), ITEMS);
    await hosting({ provision: provisioner().wired, recipes: r.recipes, checkouts: {}, seed });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: pick("red"), recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const id = (await runtime!.projects.list()).find(p => p.name === "app")!.id;
    r.move(pick("blue"), ITEMS, "h15");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(place.id)).applied?.hash === "h15");
    expect((await runtime!.preferences.get()).projectLook[id]).toEqual({ hue: "blue" });
    expect((await rowOf(place.id)).applied?.rows.find(row => row.id === "folders/app")).toMatchObject({ outcome: "installed", step: "folders" });
    expect((await runtime!.projects.list()).map(p => p.id)).toEqual([id]);
  });

  it("answers a folder's row with the id of the project a setup made and none of the folder's pick", async () => {
    const { folder, seed } = seededFolder();
    await hosting({ provision: provisioner().wired, checkouts: {}, seed });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: { ...V1, folders: { app: { from: folder, name: "app", keep: [] } } } }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const id = (await runtime!.projects.list()).find(p => p.name === "app")!.id;
    const view = await rowOf(place.id);
    expect(view.applied?.rows.find(row => row.id === "folders/app")?.project).toEqual({ id });
    expect(JSON.stringify(view.applied)).not.toContain(folder);
  });

  it("answers one version of a folder whose moved hue could not be put on, in the picks alone", async () => {
    const { folder, seed } = seededFolder();
    const pick = (hue: string): RecipeFile => ({ ...V1, folders: { app: { from: folder, name: "app", keep: [], hue: hue as "red" } } });
    const r = shelf(pick("red"), ITEMS);
    await hosting({ provision: provisioner().wired, recipes: r.recipes, checkouts: {}, seed });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: pick("red"), recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const id = (await runtime!.projects.list()).find(p => p.name === "app")!.id;
    const set = runtime!.preferences.set;
    runtime!.preferences.set = () => Promise.reject(new Error("preferences locked"));
    r.move(pick("blue"), ITEMS, "h17");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(place.id)).applied?.hash === "h17");
    runtime!.preferences.set = set;
    const view = await rowOf(place.id);
    expect(view.applied?.rows.find(row => row.id === "folders/app")).toMatchObject({ outcome: "failed", note: "preferences locked", project: { id } });
    expect(view.picks?.folders["app"]?.hue).toBe("blue");
    expect(JSON.stringify(view.applied)).not.toContain(folder);
    expect(syncs.some(e => e.applied !== undefined)).toBe(true);
    expect(JSON.stringify(syncs.map(e => e.applied))).not.toContain(folder);
  });

  for (const [moved, to] of [["source", (other: string) => ({ from: other })], ["name", () => ({ name: "web" })]] as const) {
    it(`keeps the project a setup made where a recipe moved its folder's ${moved} and its folder still stands there, the row naming that folder, and moves it under its id once it is gone`, async () => {
      const { folder, seed } = seededFolder();
      const other = seededFolder().folder;
      const pick = (more: object): RecipeFile => ({ ...V1, folders: { app: { from: folder, name: "app", keep: [], ...more } } });
      const r = shelf(pick({}), ITEMS);
      const cmds: string[] = [];
      let gone = false;
      await hosting({ provision: provisioner().wired, recipes: r.recipes, checkouts: {}, seed, cmds, answer: cmd => (gone ? folderGone(cmd) : undefined) });
      const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: pick({}), recipe: "laptop" }, Date.now());
      await until(async () => (await rowOf(place.id)).setup?.state === "done");
      const { id: was, createdAt, path: old, source } = (await runtime!.projects.list())[0]!;
      const now = pick(to(other)).folders["app"]!;
      r.move(pick(to(other)), ITEMS, "h18");
      await runtime!.places!.recipeChanged("laptop");
      await until(async () => (await rowOf(place.id)).applied?.hash === "h18");
      expect((await rowOf(place.id)).applied?.rows.find(row => row.id === "folders/app")).toMatchObject({ outcome: "failed", note: folderMoveStandsLine(old, "spoo"), project: { id: was } });
      expect((await runtime!.projects.list()).map(p => [p.id, p.source])).toEqual([[was, source]]);
      gone = true;
      const again = await runtime!.places!.setUp(place.id, {});
      await until(async () => (await rowOf(place.id)).setup?.addId === again.addId && (await rowOf(place.id)).setup?.state === "done");
      const projects = await runtime!.projects.list();
      expect(projects.map(p => [p.name, p.source])).toEqual([[now.name, { kind: "folder", path: now.from }]]);
      expect(projects.map(p => [p.id, p.createdAt])).toEqual([[was, createdAt]]);
      expect(cmds.filter(c => c.includes("rm -rf") && c.includes(`'${old}'`))).toEqual([]);
      expect((await rowOf(place.id)).applied?.rows.find(row => row.id === "folders/app")).toMatchObject({ outcome: "installed", project: { id: was } });
      expect((await runtime!.places!.remove(place.id)).removed).toBe(true);
      expect(await runtime!.projects.list()).toEqual([]);
    });
  }

  it("copies the files a recipe newly keeps into the standing folder of the project a setup made, and moves nothing", async () => {
    const { folder, seed } = seededFolder([{ path: ".env", dir: false, bytes: 12, kind: "config", ticked: false }]);
    const packed: SeedChoice[] = [];
    const pack = seed.pack;
    seed.pack = async o => {
      packed.push(o.choice);
      return pack(o);
    };
    const pick = (keep: string[]): RecipeFile => ({ ...V1, folders: { app: { from: folder, name: "app", keep } } });
    const r = shelf(pick([]), ITEMS);
    const cmds: string[] = [];
    await hosting({ provision: provisioner().wired, recipes: r.recipes, checkouts: {}, seed, cmds });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: pick([]), recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const before = (await runtime!.projects.list())[0]!;
    packed.length = 0;
    cmds.length = 0;
    r.move(pick([".env"]), ITEMS, "h18");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(place.id)).applied?.hash === "h18");
    expect(await runtime!.projects.list()).toEqual([before]);
    expect(packed).toEqual([{ files: [".env"], memory: false, commits: false }]);
    expect(cmds.some(c => c.includes("tar -xzf") && c.includes(`-C '${before.path}'`))).toBe(true);
    expect(cmds.filter(c => c.includes("git clone") || (c.includes("rm -rf") && c.includes(`'${before.path}'`)))).toEqual([]);
    const view = await rowOf(place.id);
    expect(view.applied?.rows.find(row => row.id === "folders/app")).toMatchObject({ outcome: "installed", project: { id: before.id } });
    expect(view.picks?.folders["app"]?.keep).toEqual([".env"]);
    expect((await runtime!.places!.remove(place.id)).removed).toBe(true);
  });

  it("carries what the person set on a project through a move, the recipe's moved icon on top, and leaves its old folder on the box as it is", async () => {
    const { folder, seed } = seededFolder();
    const pick = (more: object): RecipeFile => ({ ...V1, folders: { app: { from: folder, name: "app", keep: [], icon: "code", ...more } } });
    const r = shelf(pick({}), ITEMS);
    const cmds: string[] = [];
    await hosting({ provision: provisioner().wired, recipes: r.recipes, checkouts: {}, seed, cmds, answer: folderGone });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: pick({}), recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const { id: was, path: old } = (await runtime!.projects.list())[0]!;
    await runtime!.preferences.set({ projectDefaults: { [was]: { effort: "low" } }, projectLook: { [was]: { icon: "code", hue: "blue" } }, projectOrder: ["pr_other", was] });
    cmds.length = 0;
    r.move(pick({ name: "web", icon: "rocket" }), ITEMS, "h20");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(place.id)).applied?.hash === "h20");
    const projects = await runtime!.projects.list();
    expect(projects.map(p => p.name)).toEqual(["web"]);
    const prefs = await runtime!.preferences.get();
    expect(prefs.projectDefaults[projects[0]!.id]).toEqual({ effort: "low" });
    expect(prefs.projectLook[projects[0]!.id]).toEqual({ icon: "rocket", hue: "blue" });
    expect(prefs.projectOrder).toEqual(["pr_other", projects[0]!.id]);
    expect(Object.keys(prefs.projectDefaults).filter(id => id !== projects[0]!.id)).toEqual([]);
    expect(Object.keys(prefs.projectLook).filter(id => id !== projects[0]!.id)).toEqual([]);
    expect(cmds.filter(c => c.includes("rm -rf") && c.includes(`'${old}'`))).toEqual([]);
  });

  it("carries the person's look and the project's age through a retry after a move whose landing failed, the recipe's icon on top", async () => {
    const { folder, seed } = seededFolder();
    const pick = (more: object): RecipeFile => ({ ...V1, folders: { app: { from: folder, name: "app", keep: [], icon: "code", ...more } } });
    const r = shelf(pick({}), ITEMS);
    const pack = seed.pack;
    let breaks = false;
    seed.pack = async o => {
      if (breaks) throw new Error("the seed pack broke");
      return pack(o);
    };
    await hosting({ provision: provisioner().wired, recipes: r.recipes, checkouts: {}, seed, answer: folderGone });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: pick({}), recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const was = (await runtime!.projects.list())[0]!;
    await runtime!.preferences.set({ projectLook: { [was.id]: { icon: "code", hue: "blue" } } });
    breaks = true;
    r.move(pick({ name: "web", icon: "rocket" }), ITEMS, "h21");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(place.id)).applied?.hash === "h21");
    expect((await rowOf(place.id)).applied?.rows.find(row => row.id === "folders/app")).toMatchObject({ outcome: "failed", note: "the seed pack broke", project: { id: was.id } });
    expect(await runtime!.projects.list()).toEqual([]);
    breaks = false;
    const again = await runtime!.places!.setUp(place.id, {});
    await until(async () => (await rowOf(place.id)).setup?.addId === again.addId && (await rowOf(place.id)).setup?.state === "done");
    expect((await runtime!.preferences.get()).projectLook[was.id]).toEqual({ icon: "rocket", hue: "blue" });
    expect((await runtime!.projects.list()).map(p => [p.id, p.name, p.createdAt])).toEqual([[was.id, "web", was.createdAt]]);
  });

  /** A harness whose turn answers at once, so a thread stands in the project's folder. */
  const answers: HarnessAdapterFactory = () => ({
    steers: false,
    start: o => {
      const result = { status: "completed" as const, text: "ok" };
      o.onEvent({ type: "session.start", sessionId: "s1" });
      o.onEvent({ type: "turn.done", sessionId: "s1", result });
      o.onEvent({ type: "session.end", sessionId: "s1", exitCode: 0, sawResult: true });
      return { localId: "s1", finished: Promise.resolve(result), interrupt: async () => {} };
    },
  });

  /** The login a thread there runs as, which wsp takes only as root. */
  const rootLogin = (cmd: string): { exitCode: number; stdout: string } | undefined => (cmd.includes("command -v runuser") ? { exitCode: 0, stdout: "Linux\n0\nroot\nroot\n1\n/root\n/usr/bin\n" } : undefined);

  it("keeps the project a setup made where a thread stands on it, the row saying how to move it, and moves it once that is gone", async () => {
    const { folder, seed } = seededFolder();
    const other = seededFolder().folder;
    const pick = (from: string): RecipeFile => ({ ...V1, folders: { app: { from, name: "app", keep: [] } } });
    const r = shelf(pick(folder), ITEMS);
    await hosting({ provision: provisioner().wired, recipes: r.recipes, checkouts: {}, seed, adapters: { claude: answers }, answer: cmd => rootLogin(cmd) ?? folderGone(cmd) });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: pick(folder), recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const was = (await runtime!.projects.list())[0]!.id;
    const ws = await runtime!.workspaces.create({ project: was, name: "work" });
    const run = await runtime!.sessions.start(ws.id, { prompt: "work", harness: "claude" });
    await run.finished;
    r.move(pick(other), ITEMS, "h19");
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(place.id)).applied?.hash === "h19");
    const held = (await rowOf(place.id)).applied?.rows.find(row => row.id === "folders/app");
    expect(held).toMatchObject({ outcome: "failed", note: folderMoveHeldLine(projectInUseRefusal("app", [ws.name])), project: { id: was } });
    expect(held?.fix).toBeUndefined();
    expect((await runtime!.projects.list()).map(p => p.id)).toEqual([was]);
    await runtime!.sessions.delete(run.view().threadId!);
    const again = await runtime!.places!.setUp(place.id, {});
    await until(async () => (await rowOf(place.id)).setup?.addId === again.addId && (await rowOf(place.id)).setup?.state === "done");
    const projects = await runtime!.projects.list();
    expect(projects.map(p => p.source)).toEqual([{ kind: "folder", path: other }]);
    expect((await runtime!.places!.remove(place.id)).removed).toBe(true);
  });

  it("keeps a sign-in that lands while a sync runs signed in once the sync writes its rows back", async () => {
    const s = signIns();
    const p = provisioner();
    const V = RecipeFile.parse({ ...V1, agents: { codex: { signin: "machine" } } });
    const r = shelf(V, ITEMS);
    await hosting({ provision: p.wired, recipes: r.recipes, acts: s.acts });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: V, recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.code !== undefined) === true);
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await runtime!.places!.skip(place.id, "signins/codex");
    await new Promise(resolve => setTimeout(resolve, 20));
    p.ran.length = 0;
    p.arm("skills");
    r.move({ ...V, skills: { ...V.skills, why: { from: "~/.claude/skills" } } }, { ...ITEMS, "skills/why": "d2" }, "h2");
    await runtime!.places!.recipeChanged("laptop");
    await until(() => p.ran.includes("skills"));
    expect((await rowOf(place.id)).sync?.state).toBe("running");
    // The sync copied the rows as it started and writes them all back as it ends.
    await runtime!.places!.loginLanded(place.id, "codex");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/codex")?.outcome).toBe("installed");
    p.let("skills");
    await until(async () => (await rowOf(place.id)).applied?.hash === "h2");
    expect((await rowOf(place.id)).applied?.rows.find(r => r.id === "signins/codex")).toMatchObject({ outcome: "installed", note: SIGNED_IN_THERE, label: "Codex" });
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

  it("holds a sync whose undo failed before any step ran behind on the old hash, and runs it at the next change", async () => {
    let failing = true;
    const { p, r, placeId } = await following({
      undo: () => {
        if (failing) throw new Error("the ledger would not read");
        return [];
      },
    });
    r.move({ ...V1, skills: {} }, { "clis/jq": "1.7" }, "h13");
    await runtime!.places!.recipeChanged("laptop");
    await until(() => syncs.some(f => f.sync?.state === "running") && syncs.some((f, i) => i > syncs.findIndex(g => g.sync?.state === "running") && (f.sync?.state === "behind" || f.applied !== undefined)));
    expect((await rowOf(placeId)).sync?.state).toBe("behind");
    expect((await rowOf(placeId)).applied).toMatchObject({ hash: "h1", items: ITEMS });
    expect(p.ran).toEqual([]);
    failing = false;
    await runtime!.places!.recipeChanged("laptop");
    await until(async () => (await rowOf(placeId)).applied?.hash === "h13" && (await rowOf(placeId)).sync === undefined);
  });

  it("reads a sync the stopped host left running as behind once the host starts again, and runs it at the dial-back", async () => {
    const store = memoryStore();
    const p = provisioner();
    const r = shelf(V1, ITEMS);
    const host = await hosting({ provision: p.wired, recipes: r.recipes, store });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: V1, recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await new Promise(resolve => setTimeout(resolve, 20));
    p.ran.length = 0;
    p.arm("skills");
    r.move({ ...V1, skills: { ...V1.skills, why: { from: "~/.claude/skills" } } }, { ...ITEMS, "skills/why": "d2" }, "h14");
    await runtime!.places!.recipeChanged("laptop");
    await until(() => p.ran.includes("skills"));
    expect((await rowOf(place.id)).sync?.state).toBe("running");
    await stopHost();
    const again = provisioner();
    await hosting({ provision: again.wired, recipes: r.recipes, store, hostKey: host.hostKey });
    await runtime!.projects.list();
    const row = await rowOf(place.id);
    expect(row.sync?.state).toBe("behind");
    expect(row.applied?.hash).toBe("h1");
    expect(placeWord(row, null)).toEqual({ word: "Behind", sentence: "waiting to put on the recipe's 1 change: skills/why" });
    await dialsBack(host.hostKey, place.id, host.joined[0]!.pair);
    await until(async () => (await rowOf(place.id)).applied?.hash === "h14" && (await rowOf(place.id)).sync === undefined);
    expect(again.ran).toEqual(["skills"]);
  });

  it("holds a sync cut partway behind, and runs the step it never finished again when the computer dials back", async () => {
    const o: Parameters<typeof provisioner>[0] = {};
    const p = provisioner(o);
    const r = shelf(V1, ITEMS);
    const host = await hosting({ provision: p.wired, recipes: r.recipes });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: V1, recipe: "laptop" }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    await new Promise(resolve => setTimeout(resolve, 20));
    p.ran.length = 0;
    p.arm("skills");
    r.move({ ...V1, skills: { ...V1.skills, why: { from: "~/.claude/skills" } } }, { ...ITEMS, "skills/why": "d2" }, "h12");
    await runtime!.places!.recipeChanged("laptop");
    await until(() => p.ran.includes("skills"));
    // The link drops under the skills step, which the step hears as the computer gone.
    for (const ws of sockets.splice(0)) ws.close();
    await until(async () => (await rowOf(place.id)).present === false);
    o.throws = { step: "skills", error: new PlaceAbsentError("spoo is not connected") };
    p.let("skills");
    await until(async () => (await rowOf(place.id)).sync?.state === "behind");
    expect((await rowOf(place.id)).applied).toMatchObject({ hash: "h1", items: ITEMS });
    delete o.throws;
    await dialsBack(host.hostKey, place.id, host.joined[0]!.pair);
    await until(async () => (await rowOf(place.id)).applied?.hash === "h12" && (await rowOf(place.id)).sync === undefined);
    expect(p.ran).toEqual(["skills", "skills"]);
  });
});
