// SPDX-License-Identifier: AGPL-3.0-only
// The setup job on a computer somebody owns, driven by a host over the link
// that computer holds: a pending add from the first field to its picks, the
// steps each weighed by their class, the word the row reads, and a host that
// stops in the middle of any of it. The engine's steps are a fake here; what
// is under test is the order, the state on the record and what resumes.
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import {
  RecipeFile,
  absentComputer,
  floorFailedLine,
  noAgentLine,
  pendingHeldLine,
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
  type PlaceView,
  type PlaceReport,
} from "@wsp/protocol";
import type { EngineStep, ProvisionPlan } from "@wsp/engine";
import type { AgentsActs, SignInRun } from "../src/agents-read.js";
import { ADD_STOPPED_LINE, PlaceProvisioningError, newPlaceKeyPair, type PlaceKeyPair, type PlaceProvisioner, type PlaceRecord, type PlaceWiring } from "../src/places.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { DOOR, joinAt, relinkAt, report, wiring } from "./place-join.js";
import { stubBackend } from "./stub-backend.js";
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
function answersFor(cmds: string[]) {
  return (c: WsClient): void => {
    c.onFrame(raw => {
      const frame = raw as unknown as Record<string, unknown>;
      if (frame["op"] === "machine.backend") return void c.say({ id: frame["id"], ok: true, ...FACTS });
      if (frame["op"] === "machine.capacity") return void c.say({ id: frame["id"], ok: true, cores: 2, memMb: 7600, memRoomMb: 6000, machineMemMb: 4096, diskFreeBytes: 19 * 1024 ** 3, images: [], machines: { running: 0, paused: 0 } });
      if (frame["op"] !== "exec") return;
      cmds.push(String(frame["cmd"] ?? ""));
      c.say({ id: frame["id"], ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false });
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
function provisioner(o: { rows?: Partial<Record<EngineStep, PlaceProvisionRow[]>>; hold?: EngineStep; throws?: { step: EngineStep; error: Error } } = {}) {
  let release = (): void => {};
  const held = new Promise<void>(resolve => (release = resolve));
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
      if (o.throws?.step === step) throw o.throws.error;
      return rows[step] ?? [];
    },
  };
  return { wired, ran, floors, picked, release: () => release() };
}

/** Sign-ins as the app's own road runs them, each waiting on the test: the page and the code, then the end. */
function signIns() {
  const started: string[] = [];
  const ends = new Map<string, (e: Pick<AgentsSignInEvent, "state" | "said">) => void>();
  const acts: AgentsActs = {
    signInLine: async () => ({ command: "codex login" }),
    signIn: async (_on, ask) => async (run: SignInRun) => {
      started.push(ask.agent);
      run.emit({ state: "running" });
      run.emit({ state: "waiting", url: `https://auth.example/${ask.agent}/${started.length}`, code: `CODE-${started.length}` });
      const end = await new Promise<Pick<AgentsSignInEvent, "state" | "said">>(resolve => ends.set(ask.agent, resolve));
      run.emit(end);
    },
    key: async () => {},
    addTools: async () => ({ file: "" }),
  };
  return { acts, started, end: (agent: string, e: Pick<AgentsSignInEvent, "state" | "said">) => ends.get(agent)?.(e) };
}

/** A host with the setup wired, serving, and the road an add takes onto a computer that joins over the link. */
async function hosting(o: { provision: PlaceProvisioner; store?: Store; cmds?: string[]; acts?: AgentsActs; vault?: Record<string, string>; report?: PlaceReport; install?: PlaceWiring["install"]; undo?: PlaceWiring["undo"]; hostKey?: PlaceKeyPair; clock?: Clock }): Promise<{ hostKey: PlaceKeyPair; store: Store; frames: PlaceSetupEvent[]; joined: { placeId: string; pair: PlaceKeyPair }[] }> {
  const hostKey = o.hostKey ?? newPlaceKeyPair();
  const joined: { placeId: string; pair: PlaceKeyPair }[] = [];
  const store = o.store ?? memoryStore();
  const answers = answersFor(o.cmds ?? []);
  runtime = createRuntime({
    backend: stubBackend(),
    store,
    adapters: {},
    ...(o.clock !== undefined ? { clock: o.clock } : {}),
    ...(o.acts !== undefined ? { agentsActs: o.acts } : {}),
    vault: () => o.vault ?? { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" },
    placeLinks: {
      ...wiring(hostKey),
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

const rowOf = async (placeId: string): Promise<PlaceView> => (await runtime!.places!.list(Date.now())).find(p => p.id === placeId)!;
const ended = (frames: readonly PlaceSetupEvent[]): PlaceSetupEvent[] => frames.filter(f => f.end !== undefined);

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
    expect(p.ran).toEqual(["floor", "agents", "clis", "mcp", "skills", "plugins", "configs", "context"]);
    const row = await rowOf(placeId);
    expect(row.picks).toEqual(LAPTOP);
    expect(row.recipe).toBe("laptop");
    expect(row.setup!.steps.map(l => [l.step, l.state])).toEqual([
      ["floor", "done"],
      ["agents", "done"],
      ["signins", "done"],
      ["folders", "done"],
      ["clis", "done"],
      ["mcp", "done"],
      ["skills", "done"],
      ["plugins", "done"],
      ["configs", "done"],
      ["github", "done"],
      ["context", "done"],
    ]);
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
    expect(none.ran).toEqual(["floor", "agents"]);
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

  it("reads Needs you where a folder did not move, and the GitHub row where the vault holds no token", async () => {
    const p = provisioner();
    const { frames } = await hosting({ provision: p.wired });
    const picks = RecipeFile.parse({ name: "laptop", agents: { claude: { signin: "vault" } }, folders: { gone: { from: "/nowhere/at/all", keep: [] } }, configs: { github: { signin: "vault" } } });
    const { place } = await runtime!.places!.add({ address: "root@10.0.0.9", hostUrls: DOOR, choices: picks }, Date.now());
    await until(async () => (await rowOf(place.id)).setup?.state === "done");
    const row = await rowOf(place.id);
    expect(row.applied?.rows.filter(r => r.outcome === "failed").map(r => [r.id, r.step])).toEqual([
      ["folders/gone", "folders"],
      ["github", "github"],
    ]);
    expect(placeWord(row, null).word).toBe("Needs you");
    expect(ended(frames)[0]?.end).toBe("needs-you");
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
    expect(again.ran).toEqual(["clis", "mcp", "skills", "plugins", "configs", "context"]);
    // The sign-in that waited is run again for a fresh page, never waited on.
    await until(async () => (await rowOf(place.id)).setup?.waiting.some(w => w.url !== undefined) === true);
    expect(s2.started).toEqual(["codex"]);
    expect((await rowOf(place.id)).setup?.waiting).toEqual([expect.objectContaining({ row: "signins/codex", url: "https://auth.example/codex/1", code: "CODE-1" })]);
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
