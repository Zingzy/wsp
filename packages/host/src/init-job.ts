// SPDX-License-Identifier: AGPL-3.0-only
// wsp init as a job on the serving host: the one run the terminal's screens,
// the app's modal and an agent over MCP all read. The manual road reads this
// computer once and hands the five screens over as data; the agent road opens
// a thread on this computer that writes the recipe with the recipe tools and
// then shows the same screens prefilled; the build is wsp init's own
// non-interactive run, on the host's one runtime with the answered recipe
// carried per call, its sign-ins handed over as rows the person finishes in
// their browser. Every change is one view on the events channel.
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { catalogEntry } from "@wsp/catalog";
import type { BackendPricing } from "@wsp/engine";
import { CLOUD_SETUP_WORDS, INIT_ROW_STATES, LOGIN_STATE_WORDS, SignInFinish, THIS_COMPUTER, initAgentPrompt, initJobOver, initRowOver, isLocalWorkspace, type GoldenStep, type InitJob, type InitJobEvent, type InitPhase, type InitRoad, type InitRow, type InitScreen, type InitScreenId, type InitSetup, type LoginState } from "@wsp/protocol";
import { harnessCatalog, smallestModel, type GoldenRecipe, type InitDoor, type Runtime, type SessionHandle } from "@wsp/runtime";
import type { AgentHere } from "./agents-here.js";
import type { Keys } from "./cli.js";
import { wspToolsAgent, wspToolsItems } from "./init-pick.js";
import { recipeWithAnswers } from "./init-recipe.js";
import { answerScreen, screensOf, type ScreenAnswers } from "./init-screens.js";
import { SignInCodes } from "./init-signin.js";
import { GOLDEN_NAME, PREPARE_STEPS, SEAL_STEPS, readThisComputer, reduceStages, runInit, type InitIO, type InitOptions, type Reading, type StageFrame, type StageWords } from "./init.js";
import type { InstallReport } from "./mcp-install.js";
import { saveSmallRecipe, smallRecipePath } from "./recipe-file.js";
import type { WorkspaceRoads } from "./server.js";

export interface InitJobDeps {
  /** The host's one runtime: the build lands on it, and the agent road's thread runs on its local workspace. */
  rt: Runtime;
  statePath: string;
  home: string;
  platform: "darwin" | "linux";
  /** The keys as read now, off the environment and the wsp home's .env. */
  keys(): Keys;
  /** Writes the keys given into the wsp home's .env, the one writer every road uses. */
  saveKeys(set: Record<string, string>): void;
  /** Wires the provider module the keys name into the runtime, so a host that started with none forks after the seal. */
  provider(keys: Keys): void;
  /** What the machine the build boots costs; the provider's own table, which needs no key to read. */
  pricing(): BackendPricing;
  agents(): Promise<AgentHere[]>;
  /** Writes the wsp tools into these agents' configs on this computer, the road wsp mcp install takes. */
  installTools(agents: ReadonlySet<string>): InstallReport;
  /** This computer's readers, the ones a terminal run takes. */
  read: Pick<InitOptions, "collect" | "recipe" | "scanProject" | "brew" | "scan">;
  /** The build's pieces a terminal run also takes, and the roads to a workspace on the serving host. */
  build: Pick<InitOptions, "secrets" | "relay" | "daemon"> & {
    roads(): WorkspaceRoads;
    /** The golden recipe with what the host adds to every build (the daemon deploy). */
    recipe(recipe: GoldenRecipe): GoldenRecipe;
  };
  retry?: InitOptions["retry"];
  now?(): number;
}

/** How many lines of the run's prose the view keeps. */
const LOG_TAIL = 60;
/** The stage rows in the order the build runs them: the prepare's, then the seal's. */
const STAGE_WORDS: readonly StageWords[] = [...PREPARE_STEPS, ...SEAL_STEPS];
const SEAL_STAGES = new Set<string>(SEAL_STEPS.map(w => w.stage));

/** The build rows' state words are the protocol's; the stage rows read the terminal's own start, end and fail words. */
const STATE = INIT_ROW_STATES;

interface State {
  id: string;
  road: InitRoad;
  phase: InitPhase;
  reading?: Reading;
  answers?: ScreenAnswers;
  screens: InitScreen[];
  /** The rows outside the stages, in the order they appeared: the agents given the tools, each sign-in, the first
   * workspace, its project. */
  rows: InitRow[];
  /** The golden's stage frames, folded into rows on every view. */
  frames: StageFrame[];
  building: boolean;
  log: string[];
  error?: string;
  thread?: { id: string; workspaceId: string };
  golden?: { version: number };
  workspace?: { id: string; name: string };
  /** Where a terminal's Ctrl-C would arrive for the run; cancel emits it. */
  signals: EventEmitter;
  handle?: SessionHandle;
  cancelled: boolean;
  /** Which keys the host held when the job started or a key was last saved; the view reads this, not the files. */
  keys: InitJob["keys"];
}

/** A writable that keeps the lines written to it, stripped of colour, for the view's log. */
class LineSink extends Writable {
  private partial = "";
  constructor(private readonly onLine: (line: string) => void) {
    super();
  }
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const text = this.partial + (typeof chunk === "string" ? chunk : chunk.toString());
    const lines = text.split(/\r?\n/);
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      const plain = stripVTControlCharacters(line).replace(/^[│◇◆▲■○●◒◐◓◑─]+\s*/u, "").trim();
      if (plain !== "") this.onLine(plain);
    }
    callback();
  }
}

/** The serving runtime with this build's recipe carried on every golden road, and a close that closes nothing: wsp
 * init closes the runtime it built, and here the runtime is the host's for as long as the host serves. */
function buildingOn(rt: Runtime, recipe: GoldenRecipe, offs: (() => void)[]): Runtime {
  return {
    ...rt,
    events: {
      on: (type, listener) => {
        const off = rt.events.on(type, listener);
        offs.push(off);
        return off;
      },
      since: (after, stream) => rt.events.since(after, stream),
    },
    golden: {
      ...rt.golden,
      prepare: o => rt.golden.prepare({ ...o, recipe }),
      upgrade: o => rt.golden.upgrade({ ...o, recipe }),
    },
    close: async () => {},
  };
}

export class InitJobs implements InitDoor {
  private state: State | undefined;
  private readonly listeners = new Set<(e: InitJobEvent) => void>();
  private running: Promise<void> = Promise.resolve();
  private count = 0;
  /** Set while a start is opening its thread, before the job stands: a second start meanwhile is refused too. */
  private starting = false;
  /** The sign-ins waiting for a code from the client, opened and closed by the hand-off as each login runs. */
  private readonly codes = new SignInCodes();

  constructor(private readonly deps: InitJobDeps) {}

  on(fn: (e: InitJobEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolves once the work the last call started is over; what a test waits on. */
  settled(): Promise<void> {
    return this.running;
  }

  /** Which keys the host holds, as two booleans; read off the files once per ask, never on a view. */
  private held(): InitJob["keys"] {
    const keys = this.deps.keys();
    return { solari: keys.solari !== undefined, anthropic: keys.anthropic !== undefined };
  }

  view(): InitJob | null {
    const s = this.state;
    if (s === undefined) return null;
    const rows = this.rowsOf(s);
    return {
      id: s.id,
      road: s.road,
      phase: s.phase,
      keys: s.keys,
      screens: s.screens,
      rows,
      progress: { done: rows.filter(r => initRowOver(r.state)).length, total: rows.length },
      log: s.log.slice(-LOG_TAIL),
      ...(s.thread !== undefined ? { thread: s.thread } : {}),
      ...(s.error !== undefined ? { error: s.error } : {}),
      ...(s.golden !== undefined ? { golden: s.golden } : {}),
      ...(s.workspace !== undefined ? { workspace: s.workspace } : {}),
    };
  }

  async get(): Promise<InitSetup> {
    const pricing = this.deps.pricing();
    const agents = (await this.deps.agents()).filter(a => a.found).map(a => ({ id: a.id, name: a.name, configured: a.configured }));
    return {
      keys: this.held(),
      agents,
      pricing: { size: pricing.defaultSize, rateUsdPerHour: pricing.rateUsdPerHour(pricing.defaultSize) },
      job: this.view(),
    };
  }

  async keys(k: { solari?: string; anthropic?: string }): Promise<InitSetup> {
    const set: Record<string, string> = {};
    const solari = k.solari?.trim();
    const anthropic = k.anthropic?.trim();
    if (solari !== undefined && solari !== "") set["SOLARI_API_KEY"] = solari;
    if (anthropic !== undefined && anthropic !== "") set["ANTHROPIC_API_KEY"] = anthropic;
    if (Object.keys(set).length > 0) {
      this.deps.saveKeys(set);
      this.deps.provider(this.deps.keys());
      if (this.state !== undefined) {
        this.state.keys = this.held();
        this.emit();
      }
    }
    return this.get();
  }

  async start(o: { road: InitRoad; harness?: string }): Promise<InitJob> {
    if (this.starting || (this.state !== undefined && !initJobOver(this.state.phase))) throw new Error("an init job is already running; cancel it or let it finish first");
    this.count += 1;
    const state: State = { id: `init_${this.count}`, road: o.road, phase: o.road === "agent" ? "agent" : "reading", screens: [], rows: [], frames: [], building: false, log: [], signals: new EventEmitter(), cancelled: false, keys: this.held() };
    if (o.road === "agent") {
      // The thread is started here, so a harness the runtime cannot run refuses the start rather than failing a job.
      this.starting = true;
      try {
        await this.openAgent(state, o.harness);
      } finally {
        this.starting = false;
      }
      this.state = state;
      this.emit();
      this.run(state, async () => {
        const result = await state.handle!.finished;
        if (state.cancelled) return;
        if (result.status !== "completed") throw new Error(`the agent's thread ended without writing the recipe: ${result.error ?? result.status}`);
        await this.read(state, smallRecipePath(this.deps.statePath));
      });
      return this.view()!;
    }
    this.state = state;
    this.emit();
    this.run(state, () => this.read(state, undefined));
    return this.view()!;
  }

  async answer(o: { screen: InitScreenId; ticks?: string[]; answers?: Record<string, string> }): Promise<InitJob> {
    const s = this.answering();
    s.answers = answerScreen(s.reading!, s.answers!, o.screen, o);
    s.screens = screensOf(s.reading!, s.answers, this.deps);
    this.emit();
    return this.view()!;
  }

  async build(o: { firstWorkspace?: string; importFolder?: string }): Promise<InitJob> {
    const s = this.answering();
    const keys = this.deps.keys();
    if (keys.solari === undefined) throw new Error("no Solari API key is saved; the key screen takes one before the build");
    const reading = s.reading!;
    const answers = s.answers!;
    const path = smallRecipePath(this.deps.statePath);
    // The recipe as the screens answered it, written where wsp init --recipe reads it: the build is that run.
    const recipe = recipeWithAnswers(answers.recipe, answers.logins);
    saveSmallRecipe(path, recipe);
    const wspTicks = answers.wspTicks ?? wspToolsItems(recipe, this.deps.home).initial;
    const agents = new Set([...wspTicks].flatMap(id => wspToolsAgent(id) ?? []));
    if (agents.size > 0) this.tools(s, this.deps.installTools(agents));
    s.building = true;
    s.phase = "building";
    if (o.firstWorkspace !== undefined) s.rows.push({ id: `workspace/${o.firstWorkspace}`, kind: "workspace", label: o.firstWorkspace, state: STATE.waiting });
    if (o.importFolder !== undefined) s.rows.push({ id: `project/${o.importFolder}`, kind: "project", label: basename(o.importFolder), state: STATE.waiting });
    this.emit();
    const offs: (() => void)[] = [];
    const io = this.io(s);
    const opts: InitOptions = {
      yes: false,
      nonInteractive: true,
      recipeFile: path,
      reading: { ...reading, catalogRecipe: recipe },
      noLocal: true,
      ...(o.firstWorkspace !== undefined ? { firstWorkspace: o.firstWorkspace } : {}),
      ...(o.importFolder !== undefined ? { importFolder: o.importFolder } : {}),
      ...this.deps.read,
      keys,
      pricing: this.deps.pricing(),
      statePath: this.deps.statePath,
      home: this.deps.home,
      secrets: this.deps.build.secrets,
      platform: this.deps.platform,
      runtime: r => buildingOn(this.deps.rt, this.deps.build.recipe(r), offs),
      ports: { port: 0, wsPort: 0, named: true },
      upCommand: "wsp up",
      forkCommand: `wsp new ${o.firstWorkspace ?? "first"}`,
      relay: this.deps.build.relay,
      codes: this.codes,
      roads: () => this.deps.build.roads(),
      host: () => Promise.reject(new Error("the init job serves nothing; the host it runs on already does")),
      ...(this.deps.build.daemon !== undefined ? { daemon: this.deps.build.daemon } : {}),
      ...(this.deps.retry !== undefined ? { retry: this.deps.retry } : {}),
    };
    this.run(s, async () => {
      try {
        const result = await runInit(opts, io);
        if (s.cancelled) s.phase = "cancelled";
        else if (!initJobOver(s.phase)) {
          s.phase = result.code === 0 ? "done" : "failed";
          if (result.code !== 0) s.error ??= reduceStages(s.frames, STAGE_WORDS).failure ?? s.log.at(-1) ?? "the run stopped before the seal";
        }
      } finally {
        for (const off of offs) off();
      }
    });
    return this.view()!;
  }

  /** The code a sign-in's page handed back, typed into the tool waiting for it on the machine. The code passes
   * straight to that pty: it is never kept here, logged, or carried on the view. */
  async signInCode(o: { tool: string; code: string }): Promise<InitJob> {
    const s = this.state;
    if (s === undefined || initJobOver(s.phase)) throw new Error("no init job is running");
    await this.codes.submit(o.tool, o.code);
    return this.view()!;
  }

  async cancel(): Promise<InitJob> {
    const s = this.state;
    if (s === undefined || initJobOver(s.phase)) throw new Error("no init job is running");
    s.cancelled = true;
    if (s.phase === "agent") {
      await s.handle?.interrupt();
      s.phase = "cancelled";
    } else if (!s.building) {
      s.phase = "cancelled";
    } else if (s.signals.listenerCount("SIGINT") > 0) {
      // The run's own stop: the builder is killed by its recorded id and the run answers with the stop's line.
      s.signals.emit("SIGINT");
    } else {
      s.cancelled = false;
      throw new Error("the build cannot be stopped once the machine is up; it seals and stops on its own");
    }
    this.emit();
    return this.view()!;
  }

  /** The job while its screens wait for the person; anything else has no screens to answer. */
  private answering(): State {
    const s = this.state;
    if (s === undefined || s.phase !== "answering") throw new Error("the init job has no screens to answer; start it first");
    return s;
  }

  private emit(): void {
    const job = this.view();
    if (job === null) return;
    for (const fn of this.listeners) fn({ type: "init.job", job });
  }

  /** Background work on the job: a failure lands on the view as the job failing, never as an unhandled rejection. */
  private run(s: State, work: () => Promise<void>): void {
    this.running = work()
      .catch((e: unknown) => {
        if (s.cancelled) {
          s.phase = "cancelled";
          return;
        }
        s.phase = "failed";
        s.error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => this.emit());
  }

  /** Opens the agent's thread on this computer with the cheapest model its harness offers, the wsp tools added to
   * its config first when they were not, so the recipe tools are there for it to call. */
  private async openAgent(s: State, harness: string | undefined): Promise<void> {
    if (harness === undefined) throw new Error("the agent road needs a harness: which agent on this computer writes the recipe");
    const local = (await this.deps.rt.workspaces.list()).find(isLocalWorkspace);
    if (local === undefined) throw new Error(`the agent road runs a thread on ${THIS_COMPUTER}, which is not a workspace yet`);
    const agent = (await this.deps.agents()).find(a => a.id === harness);
    if (agent === undefined || !agent.found) throw new Error(`${catalogEntry(harness)?.name ?? harness} is not on this computer`);
    if (!agent.configured) this.tools(s, this.deps.installTools(new Set([harness])));
    const model = smallestModel(harnessCatalog(harness));
    const handle = await this.deps.rt.sessions.start(local.id, {
      prompt: initAgentPrompt(smallRecipePath(this.deps.statePath)),
      harness,
      ...(model !== undefined ? { model } : {}),
      title: CLOUD_SETUP_WORDS.agent.title,
    });
    s.handle = handle;
    s.thread = { id: handle.id, workspaceId: local.id };
  }

  /** Reads this computer for the screens, from the recipe file when the agent wrote one. */
  private async read(s: State, recipeFile: string | undefined): Promise<void> {
    s.phase = "reading";
    this.emit();
    const io = this.io(s);
    const reading = await readThisComputer({ ...this.deps.read, statePath: this.deps.statePath, home: this.deps.home, ...(recipeFile !== undefined ? { recipeFile } : {}) }, io, true);
    if ("code" in reading) throw new Error(s.log.at(-1) ?? "this computer could not be read");
    if (s.cancelled) return;
    s.reading = reading;
    s.answers = { recipe: reading.catalogRecipe, logins: new Map(), wspTicks: undefined };
    s.screens = screensOf(reading, s.answers, this.deps);
    s.phase = "answering";
  }

  /** The agents given the wsp tools, as rows. */
  private tools(s: State, report: InstallReport): void {
    for (const i of report.installed) s.rows.push({ id: `agent/${i.id}`, kind: "agent", label: catalogEntry(i.id)?.name ?? i.id, state: STATE.mcpAdded });
    for (const f of report.failures) s.rows.push({ id: `agent/${f.id}`, kind: "agent", label: catalogEntry(f.id)?.name ?? f.id, state: STATE.failed, detail: f.error });
  }

  /** The run's terminal: nothing to type at, every line into the log, every object into the rows. */
  private io(s: State): InitIO {
    const sink = new LineSink(line => {
      s.log.push(line);
      if (s.log.length > LOG_TAIL * 2) s.log.splice(0, s.log.length - LOG_TAIL);
      this.emit();
    });
    return {
      input: new PassThrough(),
      output: sink,
      stderr: sink,
      isTTY: false,
      env: {},
      open: async () => false,
      signals: s.signals,
      exit: () => {},
      json: record => this.take(s, record),
    };
  }

  /** One of the run's objects lands on the view: a stage frame, a sign-in's page or its outcome, the first workspace
   * and its import, the seal's failure, the end. */
  private take(s: State, record: Record<string, unknown>): void {
    const at = this.deps.now?.() ?? Date.now();
    const text = (key: string): string | undefined => (typeof record[key] === "string" ? (record[key] as string) : undefined);
    const row = (id: string): InitRow | undefined => s.rows.find(r => r.id === id);
    switch (record["event"]) {
      case "stage": {
        const stage = text("stage");
        if (stage === undefined) return;
        const step = record["step"] as GoldenStep | undefined;
        s.frames.push({ type: "golden.stage", name: GOLDEN_NAME, stage, ...(text("detail") !== undefined ? { detail: text("detail")! } : {}), ...(step !== undefined ? { step: { label: step.label, command: step.command } } : {}), at });
        if (stage === "ready") s.phase = "signing-in";
        else if (stage === "sealed") s.phase = "finishing";
        else if (SEAL_STAGES.has(stage)) s.phase = "sealing";
        break;
      }
      case "sign-in": {
        const tool = text("tool") ?? "";
        const id = `sign-in/${tool}`;
        const finish = SignInFinish.safeParse(record["finish"]);
        const next: InitRow = {
          id,
          kind: "sign-in",
          tool,
          label: text("label") ?? tool,
          state: STATE.open,
          ...(text("browserUrl") !== undefined ? { page: text("browserUrl")! } : {}),
          ...(text("code") !== undefined ? { code: text("code")! } : {}),
          ...(finish.success ? { finish: finish.data } : {}),
        };
        const had = row(id);
        if (had === undefined) s.rows.push(next);
        else Object.assign(had, next);
        s.phase = "signing-in";
        break;
      }
      case "sign-in-result": {
        const tool = text("tool") ?? "";
        const id = `sign-in/${tool}`;
        const state = text("state") as LoginState | undefined;
        const word = state !== undefined && state in LOGIN_STATE_WORDS ? LOGIN_STATE_WORDS[state] : (state ?? STATE.done);
        const had = row(id);
        const next: InitRow = { id, kind: "sign-in", tool, label: text("label") ?? tool, state: word, ...(text("note") !== undefined ? { detail: text("note")! } : {}) };
        if (had === undefined) s.rows.push(next);
        else {
          delete had.page;
          delete had.code;
          delete had.finish;
          Object.assign(had, next);
        }
        break;
      }
      case "first-workspace": {
        const name = text("name") ?? "first";
        const had = row(`workspace/${name}`) ?? (s.rows[s.rows.push({ id: `workspace/${name}`, kind: "workspace", label: name, state: STATE.waiting }) - 1] as InitRow);
        had.state = text("state") === "forked" ? STATE.forked : text("state") === "failed" ? STATE.failed : STATE.forking;
        if (text("error") !== undefined) had.detail = text("error")!;
        const workspace = record["workspace"] as { id: string; name: string } | undefined;
        if (workspace !== undefined) s.workspace = workspace;
        s.phase = "finishing";
        break;
      }
      case "import": {
        const folder = text("folder") ?? "";
        const had = row(`project/${folder}`) ?? (s.rows[s.rows.push({ id: `project/${folder}`, kind: "project", label: basename(folder), state: STATE.waiting }) - 1] as InitRow);
        had.state = text("state") === "imported" ? STATE.imported : text("state") === "failed" ? STATE.failed : STATE.importing;
        if (text("error") !== undefined) had.detail = text("error")!;
        if (text("dest") !== undefined) had.detail = text("dest")!;
        break;
      }
      case "seal-failed":
        s.phase = "failed";
        s.error = text("message") ?? "the seal failed";
        break;
      case "done": {
        const version = record["version"];
        if (typeof version === "number") s.golden = { version };
        const workspace = record["workspace"] as { id: string; name: string } | undefined;
        if (workspace !== undefined) s.workspace = workspace;
        s.phase = "done";
        break;
      }
      default:
        return;
    }
    this.emit();
  }

  /** The rows as the view shows them: the agents given the tools, the stages in the build's order (every one from
   * the first frame while the build runs, so the count means something; a stage the provider never ran leaves once
   * the build is over), then the sign-ins, the first workspace and its project. */
  private rowsOf(s: State): InitRow[] {
    // Copies: a view on the events channel is a snapshot, and the rows here move on after it.
    const agents = s.rows.filter(r => r.kind === "agent").map(r => ({ ...r }));
    const rest = s.rows.filter(r => r.kind !== "agent").map(r => ({ ...r }));
    if (!s.building) return [...agents, ...rest];
    const view = reduceStages(s.frames, STAGE_WORDS);
    const over = initJobOver(s.phase);
    const stages = STAGE_WORDS.filter(w => !over || view.steps.some(x => x.stage === w.stage)).map((w): InitRow => {
      const step = view.steps.find(x => x.stage === w.stage);
      const state = step === undefined ? STATE.waiting : step.state === "current" ? STATE.running : step.state === "done" ? STATE.done : STATE.failed;
      const label = step?.state === "done" ? w.end : step?.state === "failed" ? w.fail : w.start;
      const detail = step?.running?.command ?? step?.tail.at(-1);
      return { id: `stage/${w.stage}`, kind: "stage", label, state, ...(detail !== undefined ? { detail } : {}), ...(step?.ms !== undefined ? { ms: step.ms } : {}) };
    });
    return [...agents, ...stages, ...rest];
  }
}
