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
import { keyCheckLine, type BackendPricing, type KeyCheck } from "@wsp/engine";
import { RUNGS } from "@wsp/collect";
import { CLOUD_SETUP_WORDS, FIRST_WORKSPACE, GOLDEN_STAGE_WORDS, INIT_BUILD_STEP, INIT_ROW_STATES, INIT_SIGN_IN_WORDS, KEY_REFUSED, KEY_UNCHECKED, NEVER_REACHED, NO_FIRST_WORKSPACE, STOP_LEFT_MACHINE_LINE, shellQuote, SIGN_IN_NEVER_REACHED, SignInFinish, THIS_COMPUTER, initAgentNoRecipeLine, initAgentPrompt, initBuildRows, initJobOver, initMachineRowLabel, initNeedWhat, initRowOver, initStageCount, initStoppedAt, initStoppedLine, isLocalWorkspace, isSessionEvent, noMcpServersLine, plural, takesMcpServers, threadWorkingLine, type GoldenStep, type InitJob, type InitJobEvent, type InitNeedsYouEvent, type InitPhase, type InitRoad, type InitRow, type InitScreen, type InitScreenId, type InitSetup, type LoginState, type McpServerSpec, type TurnResult } from "@wsp/protocol";
import { harnessCatalog, smallestModel, type GoldenRecipe, type InitDoor, type Runtime, type SessionHandle } from "@wsp/runtime";
import type { AgentHere } from "./agents-here.js";
import { SOLARI_KEY, agentKeysIn, keysOf, type Keys } from "./env-keys.js";
import { firstWorkspaceName, folderOf } from "./init-first.js";
import { wspToolsAgent, wspToolsItems } from "./init-pick.js";
import { RUNG_TITLE, agentName, recipeWithAnswers } from "./init-recipe.js";
import { answerScreen, diskOf, keyNameFor, screensOf, type ScreenAnswers } from "./init-screens.js";
import { SignInCodes } from "./init-signin.js";
import { handoffStage } from "./init-handoff.js";
import { historyWord } from "./recipe-command.js";
import { GOLDEN_NAME, PREPARE_STEPS, SEAL_STEPS, readThisComputer, reduceStages, runInit, type InitIO, type InitOptions, type Reading, type SignInContext, type StageFrame, type StageWords } from "./init.js";
import { MCP_SERVER_NAME, type InstallReport } from "./mcp-install.js";
import { loadRecipe, recipeStamp, saveSmallRecipe, smallRecipePath } from "./recipe-file.js";
import type { WorkspaceRoads } from "./server.js";

export interface InitJobDeps {
  /** The host's one runtime: the build lands on it, and the agent road's thread runs on its local workspace. */
  rt: Runtime;
  statePath: string;
  home: string;
  platform: "darwin" | "linux";
  /** The wsp home's .env as it stands, read at each ask: the one place the setup reads a key from, so a key in the
   * process environment or a checkout's .env never reads as saved on a screen. */
  saved(): Readonly<Record<string, string>>;
  /** Writes the keys given into the wsp home's .env, the one writer every road uses. */
  saveKeys(set: Record<string, string>): void;
  /** Wires the provider module the keys name into the runtime, so a host that started with none forks after the seal. */
  provider(keys: Keys): void;
  /** Whether the provider takes these keys, asked before they are saved: the provider module the keys name makes one
   * cheap authenticated call, and a refusal is the person's to fix on the step that typed the key. */
  checkKey(keys: Keys): Promise<KeyCheck>;
  /** What the machine the build boots costs; the provider's own table, which needs no key to read. */
  pricing(): BackendPricing;
  agents(): Promise<AgentHere[]>;
  /** Writes the wsp tools into these agents' configs on this computer, the road wsp mcp install takes. */
  installTools(agents: ReadonlySet<string>): InstallReport;
  /** The wsp MCP server pointed at this host, the same spec wsp mcp install writes: what the agent road's thread is
   * launched with, so its recipe tools are there whatever the person's own config says. */
  mcpServer(): McpServerSpec;
  /** This computer's readers, the ones a terminal run takes. */
  read: Pick<InitOptions, "collect" | "recipe" | "scanProject" | "brew" | "scan">;
  /** The build's pieces a terminal run also takes, and the roads to a workspace on the serving host. */
  build: Pick<InitOptions, "secrets" | "relay" | "daemon"> & {
    roads(): WorkspaceRoads;
    /** The golden recipe with what the host adds to every build (the daemon deploy). */
    recipe(recipe: GoldenRecipe): GoldenRecipe;
  };
  retry?: InitOptions["retry"];
  pollMs?: InitOptions["pollMs"];
  now?(): number;
}

/** How many lines of the run's prose the view keeps. */
const LOG_TAIL = 60;
/** How many of a stage's lines ride under its row. */
const STAGE_LINES = 12;
/** How often the agent road looks for the recipe its thread is writing, between the thread's own events. */
const RECIPE_POLL_MS = 250;
/** Whether the agent road can run on this agent at all: its thread is handed the wsp server on the launch, so an
 * agent whose adapter renders none would write no recipe. The harness table is the one place that says which do. */
const takesTools = (harness: string): boolean => takesMcpServers(harnessCatalog(harness));
/** How often, and how many times, a stop that could not reach the provider tries the kill again. Twenty minutes of
 * trying outlasts the network outages this has been seen with; past that the row says the machine is still there.
 * A caller that sets its own retry (only a test does) is taken at its word, so a run of this takes milliseconds. */
const SWEEP_RETRY = { attempts: 40, waitMs: 30_000 };
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
  /** The screen the person is on; one past the last is the build's own question. */
  step: number;
  /** What each step has ticked, picked or typed and not sent yet, by the step's own name. */
  drafts: Map<string, { ticks: string[]; answers: Record<string, string> }>;
  /** What the image's disk holds before any tick and the disk the build asks for, once this computer is read. */
  disk?: { fixed: number; total: number };
  /** What the read of this computer found so far, one row per fact, drawn while it reads. */
  facts: InitRow[];
  /** The rows outside the stages, in the order they appeared: the agents given the tools, each sign-in, the first
   * workspace, its project. */
  rows: InitRow[];
  /** The golden's stage frames, folded into rows on every view. */
  frames: StageFrame[];
  building: boolean;
  log: string[];
  error?: string;
  /** Set when the build's own read of the saved key came back refused: the way on is the keys step. */
  keyRefused?: boolean;
  thread?: { id: string; workspaceId: string; session: string; harness: string };
  /** The one line the agent's thread is on, from its own events; the block on the agent step shows it. */
  line?: string;
  /** What the agent road listens to on the runtime while its thread runs, dropped when the thread is done with. */
  watching: (() => void)[];
  golden?: { version: number };
  workspace?: { id: string; name: string };
  /** Where a terminal's Ctrl-C would arrive for the run; cancel emits it. */
  signals: EventEmitter;
  handle?: SessionHandle;
  cancelled: boolean;
  /** Which keys the host held when the job started or a key was last saved; the view reads this, not the files. */
  keys: InitJob["keys"];
  /** What the job waits on the person for, kept here so its clock starts once and the surfaces that speak once per
   * need see one need for as long as it stands. */
  needsYou?: InitJob["needsYou"];
  /** What the run's sign-in stage runs with, once it has started: a retry runs the same way, through the same relay. */
  signIns?: SignInContext;
  /** The stage the provider has no room for yet, while the account sits at its machine cap. */
  slotWait?: string;
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
  private readonly listeners = new Set<(e: InitJobEvent | InitNeedsYouEvent) => void>();
  private running: Promise<void> = Promise.resolve();
  private count = 0;
  /** Set while a start is opening its thread, before the job stands: a second start meanwhile is refused too. */
  private starting = false;
  /** Every machine a stop could not reach the provider to kill, by builder id, with the row that says so. These
   * belong to the host and not to the job that booted them: a machine bills whether or not the job that made it
   * still stands, so the row rides whatever job is current until the provider takes it. */
  private readonly sweeps = new Map<string, InitRow>();
  /** The sweeps still trying, so settled() waits on them: they outlive the job that started them, so no job's own
   * promise reaches them. */
  private readonly sweeping = new Set<Promise<void>>();
  /** The sign-ins waiting for a code from the client, opened and closed by the hand-off as each login runs. */
  private readonly codes = new SignInCodes();

  constructor(private readonly deps: InitJobDeps) {}

  on(fn: (e: InitJobEvent | InitNeedsYouEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolves once the work the last call started is over, and anything queued behind it, and every sweep of a
   * machine the provider would not take: those belong to the host and outlive the job that started them, so one
   * await of a job's own promise would come back before them. */
  async settled(): Promise<void> {
    for (;;) {
      const waited = this.running;
      await Promise.allSettled([waited, ...this.sweeping]);
      if (waited === this.running && this.sweeping.size === 0) return;
    }
  }

  /** Whether the host holds the provider key; read off the home's file once per ask, never on a view. */
  private held(): InitJob["keys"] {
    return { solari: keysOf(this.deps.saved()).solari !== undefined };
  }

  view(): InitJob | null {
    const s = this.state;
    if (s === undefined) return null;
    const rows = [...(s.phase === "reading" || s.phase === "agent" ? s.facts.map(r => ({ ...r })) : this.rowsOf(s)), ...[...this.sweeps.values()].map(r => ({ ...r }))];
    return {
      id: s.id,
      road: s.road,
      phase: s.phase,
      keys: s.keys,
      step: s.step,
      stoppable: !initJobOver(s.phase) && (s.phase === "agent" || !s.building || s.signals.listenerCount("SIGINT") > 0),
      ...(s.disk !== undefined ? { disk: s.disk } : {}),
      screens: s.screens,
      rows,
      // One count for one build: the sidebar's keycap and the sheet's bar read the same function over the same rows.
      progress: initStageCount(initBuildRows(rows).rows),
      ...(s.needsYou !== undefined ? { needsYou: s.needsYou } : {}),
      ...(s.drafts.size > 0 ? { drafts: [...s.drafts].map(([at, d]) => ({ at, ticks: [...d.ticks], answers: { ...d.answers } })) } : {}),
      log: s.log.slice(-LOG_TAIL),
      ...(s.thread !== undefined ? { thread: s.thread } : {}),
      ...(s.line !== undefined ? { line: s.line } : {}),
      ...(s.error !== undefined ? { error: s.error } : {}),
      ...(s.keyRefused === true ? { keyRefused: true } : {}),
      ...(s.golden !== undefined ? { golden: s.golden } : {}),
      ...(s.workspace !== undefined ? { workspace: s.workspace } : {}),
    };
  }

  async get(): Promise<InitSetup> {
    const pricing = this.deps.pricing();
    const agents = (await this.deps.agents()).filter(a => a.found).map(a => ({ id: a.id, name: a.name, configured: a.configured, takesTools: takesTools(a.id) }));
    return {
      keys: this.held(),
      home: this.deps.home,
      agents,
      pricing: { size: pricing.defaultSize, rateUsdPerHour: pricing.rateUsdPerHour(pricing.defaultSize) },
      job: this.view(),
    };
  }

  /** Saves the provider key, and an agent's API key by the sign-in row that took it, under the variable the agent's
   * sign-in declares; a row that takes no key is refused, so nothing a client names lands in the file. The provider
   * key is put to the provider before anything is written, so a key it refuses is never saved and the setup cannot
   * move on with one; the refusal carries its kind, since a road that never answered is worth pressing again and a
   * refused key is not. */
  async keys(k: { solari?: string; rows?: Record<string, string> }): Promise<InitSetup> {
    const set: Record<string, string> = {};
    const solari = k.solari?.trim();
    if (solari !== undefined && solari !== "") {
      const check = await this.deps.checkKey({ solari });
      const line = keyCheckLine(check);
      if (line !== undefined) throw Object.assign(new Error(line), { kind: check.state === "refused" ? KEY_REFUSED : KEY_UNCHECKED });
      set[SOLARI_KEY] = solari;
    }
    for (const [row, value] of Object.entries(k.rows ?? {})) {
      const typed = value.trim();
      if (typed === "") continue;
      const name = keyNameFor(this.answering().reading!.manifest, row);
      if (name === undefined) throw new Error(`the sign-in row ${row} takes no API key`);
      set[name] = typed;
    }
    if (Object.keys(set).length > 0) {
      this.deps.saveKeys(set);
      this.deps.provider(keysOf(this.deps.saved()));
      const s = this.state;
      if (s !== undefined) {
        s.keys = this.held();
        if (s.phase === "answering") s.screens = screensOf(s.reading!, s.answers!, this.deps);
        this.emit();
      }
    }
    return this.get();
  }

  async start(o: { road: InitRoad; harness?: string }): Promise<InitJob> {
    if (this.starting || (this.state !== undefined && !initJobOver(this.state.phase))) throw new Error("an init job is already running; cancel it or let it finish first");
    this.count += 1;
    // A sweep that ended stays on the job it belonged to and no further; one still trying rides on.
    for (const [id, row] of this.sweeps) if (row.state !== STATE.retrying) this.sweeps.delete(id);
    const state: State = { id: `init_${this.count}`, road: o.road, phase: o.road === "agent" ? "agent" : "reading", screens: [], step: 0, drafts: new Map(), facts: [], rows: [], frames: [], building: false, log: [], signals: new EventEmitter(), cancelled: false, keys: this.held(), watching: [] };
    if (o.road === "agent") {
      const path = smallRecipePath(this.deps.statePath);
      // Read before the thread is launched: whatever recipe is beside the state now is not this thread's.
      const before = recipeStamp(path);
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
        try {
          await this.recipeArrived(state, path, before);
        } finally {
          this.unwatch(state);
        }
        if (state.cancelled) return;
        await this.read(state, path);
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
    s.disk = diskOf(s.reading!, s.answers.recipe, this.deps.statePath);
    s.step = Math.min(s.screens.findIndex(x => x.id === o.screen) + 1, s.screens.length);
    // The screen's answer is what its draft was for: what stands is on the recipe now, and a stale draft would
    // come back over it on the next reopen.
    s.drafts.delete(o.screen);
    this.emit();
    return this.view()!;
  }

  /** What a step has ticked, picked or typed and not sent yet, kept beside the step it belongs to so shutting the
   * sheet loses none of it. Nothing here moves the recipe: the step's own Continue does that. */
  async draft(o: { at: string; ticks?: string[]; answers?: Record<string, string> }): Promise<InitJob> {
    const s = this.answering();
    if (o.at !== INIT_BUILD_STEP && !s.screens.some(x => x.id === o.at)) throw new Error(`the init job has no step ${o.at} to draft on`);
    // An empty draft is an answer of its own: a step whose every tick was taken off comes back with none on.
    s.drafts.set(o.at, { ticks: [...(o.ticks ?? [])], answers: { ...(o.answers ?? {}) } });
    this.emit();
    return this.view()!;
  }

  /** A sign-in that ran out or failed, run again on the builder while the build goes on: the row turns back to
   * running, the page and the outcome land as the first time did, and the build waits on none of it. */
  async retry(o: { tool: string }): Promise<InitJob> {
    const s = this.state;
    if (s === undefined || !s.building || initJobOver(s.phase)) throw new Error("no build is running to sign in on");
    const row = s.rows.find(r => r.kind === "sign-in" && r.tool === o.tool);
    if (row === undefined || !initRowOver(row.state) || row.state === INIT_SIGN_IN_WORDS["signed-in"]) throw new Error(`no failed sign-in for ${o.tool} to retry`);
    const entry = s.reading?.manifest.entries.find(e => e.rung === "logins" && agentName(e) === o.tool);
    if (entry === undefined) throw new Error(`no sign-in row for ${o.tool}`);
    const ctx = s.signIns;
    if (ctx === undefined) throw new Error("the machine is not up to sign in on");
    row.state = STATE.running;
    delete row.detail;
    this.emit();
    const io = this.io(s);
    void handoffStage({
      logins: [{ ...entry, choice: "machine" }],
      left: new Map(),
      dial: ctx.dial,
      flow: ctx.flow,
      signal: ctx.signal,
      ...(ctx.pollMs !== undefined ? { pollMs: ctx.pollMs } : {}),
      output: io.output,
      platform: this.deps.platform,
      codes: this.codes,
      json: record => this.take(s, record),
    }).catch((e: unknown) => {
      row.state = INIT_SIGN_IN_WORDS["not-signed-in"];
      row.detail = e instanceof Error ? e.message : String(e);
      this.emit();
    });
    return this.view()!;
  }

  /** Where the person went back to, kept on the job so a setup shut there reopens there. */
  async step(o: { at: number }): Promise<InitJob> {
    const s = this.answering();
    if (!Number.isInteger(o.at) || o.at < 0 || o.at > s.screens.length) throw new Error(`the init job has no step ${o.at}`);
    s.step = o.at;
    this.emit();
    return this.view()!;
  }

  async build(o: { firstWorkspace?: string; importFolder?: string }): Promise<InitJob> {
    const s = this.answering();
    const saved = this.deps.saved();
    const keys = keysOf(saved);
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
    // Every sign-in the screens chose is a row from the first frame, waiting for its turn: the handoff's own events
    // fill in the page and the outcome when they reach it, and a row the run never reaches ends as skipped, said so.
    for (const row of this.chosenSignIns(s)) s.rows.push(row);
    const first = firstWorkspaceName(o.firstWorkspace);
    // The import rides the fork, so with no name the folder goes with it and the row below says why for both.
    const folder = first === undefined ? undefined : folderOf(o.importFolder);
    // The workspace row is drawn either way, so the list never ends on a step whose answer nobody can read.
    s.rows.push(first === undefined ? { id: "workspace", kind: "workspace", label: CLOUD_SETUP_WORDS.ask.headline, state: STATE.skipped, detail: NO_FIRST_WORKSPACE } : { id: `workspace/${first}`, kind: "workspace", label: first, state: STATE.waiting });
    if (folder !== undefined) s.rows.push({ id: `project/${folder}`, kind: "project", label: basename(folder), state: STATE.waiting });
    this.emit();
    const offs: (() => void)[] = [];
    const io = this.io(s);
    const opts: InitOptions = {
      yes: false,
      nonInteractive: true,
      recipeFile: path,
      reading: { ...reading, catalogRecipe: recipe },
      noLocal: true,
      ...(first !== undefined ? { firstWorkspace: first } : {}),
      ...(folder !== undefined ? { importFolder: folder } : {}),
      ...this.deps.read,
      agentKeys: agentKeysIn(saved),
      signIns: ctx => {
        s.signIns = ctx;
      },
      pricing: this.deps.pricing(),
      statePath: this.deps.statePath,
      home: this.deps.home,
      secrets: this.deps.build.secrets,
      platform: this.deps.platform,
      runtime: r => buildingOn(this.deps.rt, this.deps.build.recipe(r), offs),
      ports: { port: 0, wsPort: 0, named: true },
      upCommand: "wsp up",
      forkCommand: `wsp new ${shellQuote(first ?? FIRST_WORKSPACE)}`,
      relay: this.deps.build.relay,
      codes: this.codes,
      roads: () => this.deps.build.roads(),
      host: () => Promise.reject(new Error("the init job serves nothing; the host it runs on already does")),
      ...(this.deps.build.daemon !== undefined ? { daemon: this.deps.build.daemon } : {}),
      ...(this.deps.retry !== undefined ? { retry: this.deps.retry } : {}),
      ...(this.deps.pollMs !== undefined ? { pollMs: this.deps.pollMs } : {}),
    };
    this.run(s, async () => {
      try {
        const result = await runInit(opts, io);
        if (s.cancelled) s.phase = "cancelled";
        else if (!initJobOver(s.phase)) {
          s.phase = result.code === 0 ? "done" : "failed";
          if (result.code !== 0) this.fail(s, reduceStages(s.frames, STAGE_WORDS).failure ?? s.log.at(-1) ?? "the run stopped before the seal");
        }
      } finally {
        for (const off of offs) off();
        delete s.slotWait;
        // Every row the run left unfinished, not only the ones it never started: forking and importing hang too.
        // A first workspace or its project reads not made, since skipped would read as a step the build passed on.
        for (const row of s.rows) {
          if (initRowOver(row.state)) continue;
          row.state = row.kind === "workspace" || row.kind === "project" ? STATE.notMade : STATE.skipped;
          row.detail = row.kind === "sign-in" ? SIGN_IN_NEVER_REACHED : NEVER_REACHED;
        }
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
      throw new Error(CLOUD_SETUP_WORDS.build.cannotStop);
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
    const s = this.state;
    if (s === undefined) return;
    const arrived = this.settleNeed(s);
    const job = this.view();
    if (job === null) return;
    for (const fn of this.listeners) fn({ type: "init.job", job });
    if (arrived) for (const fn of this.listeners) fn({ type: "job.needs-you", jobId: job.id, needsYou: s.needsYou! });
  }

  /** What the job waits on the person for, settled against the rows before every view: the clock is taken when a
   * need arrives and left alone while the same need stands, and a need gone is a need cleared. True where this
   * settle is the arrival, which is what the one event per need rides. The rows here are the state's own, not the
   * view's: only their sign-ins carry a wait, and the view reorders nothing that matters to it. */
  private settleNeed(s: State): boolean {
    const what = initJobOver(s.phase) ? undefined : initNeedWhat({ rows: s.rows });
    if (what === undefined) {
      delete s.needsYou;
      return false;
    }
    if (s.needsYou?.what === what) return false;
    s.needsYou = { what, since: this.deps.now?.() ?? Date.now() };
    return true;
  }

  /** Why the job is not running, in the words a person reads: every reason goes through here, so the raw error a
   * client shows is this computer's own sentence when there is one and is never said twice. The first reason in
   * stands: a run that failed and then stopped reports what failed it. */
  private fail(s: State, message: string): void {
    s.error ??= initStoppedLine(message);
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
        this.fail(s, e instanceof Error ? e.message : String(e));
      })
      .finally(() => this.emit());
  }

  /** Opens the agent's thread on this computer with the cheapest model its harness offers. The server rides the
   * launch because the config the harness reads here is the person's own, and the access is the harness's bypass
   * mode because the person is at the setup screen, not at the thread. */
  private async openAgent(s: State, harness: string | undefined): Promise<void> {
    if (harness === undefined) throw new Error("the agent road needs a harness: which agent on this computer writes the recipe");
    const local = (await this.deps.rt.workspaces.list()).find(isLocalWorkspace);
    if (local === undefined) throw new Error(`the agent road runs a thread on ${THIS_COMPUTER}, which is not a workspace yet`);
    const agent = (await this.deps.agents()).find(a => a.id === harness);
    if (agent === undefined || !agent.found) throw new Error(`${catalogEntry(harness)?.name ?? harness} is not on this computer`);
    const name = catalogEntry(harness)?.name ?? harness;
    if (!takesTools(harness)) throw new Error(noMcpServersLine(name));
    if (!agent.configured) this.tools(s, this.deps.installTools(new Set([harness])));
    const table = harnessCatalog(harness);
    const model = smallestModel(table);
    const handle = await this.deps.rt.sessions.start(local.id, {
      prompt: initAgentPrompt(smallRecipePath(this.deps.statePath)),
      harness,
      ...(model !== undefined ? { model } : {}),
      ...(table?.bypassMode !== undefined ? { permissionMode: table.bypassMode } : {}),
      mcpServers: { [MCP_SERVER_NAME]: this.deps.mcpServer() },
      title: CLOUD_SETUP_WORDS.agent.title,
    });
    s.handle = handle;
    const threadId = handle.view().threadId ?? handle.id;
    s.thread = { id: threadId, workspaceId: local.id, session: handle.id, harness };
    this.watch(s, threadId);
  }

  /** The thread's own events folded to the one line the agent step shows. Nothing else of the thread is kept: the
   * chat is where its transcript lives, and the step's link goes there. */
  private watch(s: State, threadId: string): void {
    s.watching.push(
      this.deps.rt.events.on("*", e => {
        if (!isSessionEvent(e) || e.threadId !== threadId) return;
        const line = threadWorkingLine(e);
        if (line === undefined || line === s.line) return;
        s.line = line;
        this.emit();
      }),
    );
  }

  private unwatch(s: State): void {
    for (const off of s.watching.splice(0)) off();
  }

  /** Waits for the recipe the thread was asked to write to land at the path the brief named. The file's own arrival
   * is what moves the setup on, so a recipe that was already beside the state is never read as this thread's, and a
   * turn that ends without writing one fails the job with a line rather than showing the screens off a stale file.
   * The turn ending is the other wake-up, so the poll only bounds how long a written file waits to be noticed. */
  private async recipeArrived(s: State, path: string, before: string | undefined): Promise<void> {
    let ended: TurnResult | undefined;
    const finished = s.handle!.finished.then(
      r => {
        ended = r;
      },
      (e: unknown) => {
        ended = { status: "failed", error: e instanceof Error ? e.message : String(e) };
      },
    );
    // Why a read and not the stamp alone: the recipe tool writes the file from its own process, so a poll can land
    // inside that write. A file that does not parse yet has not arrived; if the turn ends on one, its reason is why.
    let unreadable: string | undefined;
    for (;;) {
      if (recipeStamp(path) !== before) {
        try {
          loadRecipe(path);
          return;
        } catch (e) {
          unreadable = e instanceof Error ? e.message : String(e);
        }
      }
      if (s.cancelled) return;
      if (ended !== undefined) throw new Error(initAgentNoRecipeLine(path, unreadable ?? ended.error ?? (ended.status === "completed" ? undefined : ended.status)));
      await Promise.race([finished, new Promise(r => setTimeout(r, RECIPE_POLL_MS))]);
    }
  }

  /** Reads this computer for the screens, from the recipe file when the agent wrote one. Each reader is wrapped so
   * the facts land on the view as rows while it runs: a rung of the collector as it finishes (they run in ladder
   * order, so the next is the one running), Homebrew's sizes, each agent's history as it is read, the package
   * managers' scan. */
  private async read(s: State, recipeFile: string | undefined): Promise<void> {
    s.phase = "reading";
    this.emit();
    const io = this.io(s);
    const fact = (id: string, label: string): InitRow => {
      const had = s.facts.find(r => r.id === `fact/${id}`);
      if (had !== undefined) return had;
      const row: InitRow = { id: `fact/${id}`, kind: "fact", label, state: STATE.running };
      s.facts.push(row);
      this.emit();
      return row;
    };
    const settle = (row: InitRow, word: string): void => {
      row.state = word;
      delete row.detail;
      this.emit();
    };
    const read = this.deps.read;
    const wrapped: typeof read = {
      collect: onRung => {
        fact(RUNGS[0], RUNG_TITLE[RUNGS[0]]);
        return read.collect((rung, rows) => {
          settle(fact(rung, RUNG_TITLE[rung]), `${rows} found`);
          const next = RUNGS[RUNGS.indexOf(rung) + 1];
          if (next !== undefined) fact(next, RUNG_TITLE[next]);
          onRung(rung, rows);
        });
      },
      recipe: (onHistory, onProject, onProgress) =>
        read.recipe(
          h => {
            settle(fact(`history/${h.agent}`, catalogEntry(h.agent)?.name ?? h.agent), historyWord(h));
            onHistory(h);
          },
          onProject,
          p => {
            const row = fact(`history/${p.agent}`, catalogEntry(p.agent)?.name ?? p.agent);
            row.detail = `${plural(p.read, "session")} of ${p.files}`;
            this.emit();
            onProgress(p);
          },
        ),
      scanProject: read.scanProject,
      ...(read.brew !== undefined
        ? {
            brew: async () => {
              const row = fact("brew", "Homebrew");
              const table = await read.brew!();
              settle(row, "sizes read");
              return table;
            },
          }
        : {}),
      ...(read.scan !== undefined
        ? {
            scan: async recipe => {
              const row = fact("scan", "Package managers");
              const rows = await read.scan!(recipe);
              settle(row, `${rows.length} found`);
              return rows;
            },
          }
        : {}),
    };
    const reading = await readThisComputer({ ...wrapped, statePath: this.deps.statePath, home: this.deps.home, ...(recipeFile !== undefined ? { recipeFile } : {}) }, io, true);
    if ("code" in reading) throw new Error(s.log.at(-1) ?? "this computer could not be read");
    if (s.cancelled) return;
    s.reading = reading;
    s.answers = { recipe: reading.catalogRecipe, logins: new Map(), wspTicks: undefined };
    s.screens = screensOf(reading, s.answers, this.deps);
    s.disk = diskOf(reading, s.answers.recipe, this.deps.statePath);
    s.step = 0;
    s.phase = "answering";
  }

  /** The sign-ins the screens answered with a copy, a sign-in on the machine or a key, as waiting rows, in the order
   * the sign-ins screen lists them; a row fixed on skip is not one. */
  private chosenSignIns(s: State): InitRow[] {
    const logins = s.screens.find(x => x.id === "logins");
    if (logins === undefined) return [];
    return logins.items.flatMap((item): InitRow[] => {
      const choice = logins.answers[item.id];
      if (choice === undefined || choice === "skip" || item.mark === undefined || !(item.choices ?? []).some(c => c.value === choice)) return [];
      return [{ id: `sign-in/${item.mark}`, kind: "sign-in", tool: item.mark, label: item.label, state: STATE.waiting }];
    });
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
        // The provider having no room is not the stage working: the next frame off it, cap or not, says so again.
        s.slotWait = record["waiting"] === true ? stage : undefined;
        // The phase turns to signing in on the first sign-in row, not when the machine answers: the checks and the
        // secrets between the two are the build's, and a status that says signing in with no row to sign in is a lie.
        if (stage === "sealed") s.phase = "finishing";
        else if (SEAL_STAGES.has(stage)) s.phase = "sealing";
        break;
      }
      case "sign-in": {
        const tool = text("tool") ?? "";
        const id = `sign-in/${tool}`;
        // Without a page the command is still starting on the machine; with one, the person is waited on.
        const page = text("browserUrl");
        const finish = SignInFinish.safeParse(record["finish"]);
        const next: InitRow = { id, kind: "sign-in", tool, label: text("label") ?? tool, state: page === undefined ? STATE.running : STATE.open, ...(page !== undefined ? { page } : {}), ...(text("code") !== undefined ? { code: text("code")! } : {}), ...(finish.success ? { finish: finish.data } : {}) };
        const had = row(id);
        if (had === undefined) s.rows.push(next);
        else Object.assign(had, next);
        if (s.phase === "building") s.phase = "signing-in";
        break;
      }
      case "sign-in-result": {
        if (s.phase === "building") s.phase = "signing-in";
        const tool = text("tool") ?? "";
        const id = `sign-in/${tool}`;
        const state = text("state") as LoginState | undefined;
        const word = state !== undefined && state in INIT_SIGN_IN_WORDS ? INIT_SIGN_IN_WORDS[state] : (state ?? STATE.done);
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
      case "key-set": {
        if (s.phase === "building") s.phase = "signing-in";
        const tool = text("tool") ?? "";
        const id = `sign-in/${tool}`;
        const next: InitRow = { id, kind: "sign-in", tool, label: text("label") ?? tool, state: STATE.keySet };
        const had = row(id);
        if (had === undefined) s.rows.push(next);
        else Object.assign(had, next);
        break;
      }
      case "first-workspace": {
        const name = text("name") ?? FIRST_WORKSPACE;
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
      case "key-check-failed":
        // The build's own read of the saved key, before its first stage: the provider's word is the failure, and a
        // refusal names the step that fixes it rather than offering another build.
        s.phase = "failed";
        s.error = text("message") ?? CLOUD_SETUP_WORDS.keys.refusedSaved;
        if (record["refused"] === true) s.keyRefused = true;
        break;
      case "seal-failed":
        s.phase = "failed";
        this.fail(s, text("message") ?? "the seal failed");
        break;
      case "stopped": {
        // The run's own word for a stop the person asked for: it names the stage it was at and what became of the
        // machine, which is the one thing the screen must not invent a second version of. Where the provider would
        // not take the kill the run tells its reader to finish the machine themselves; here the host is already
        // trying again, so that clause goes and the machine's own row carries the rest.
        const left = text("left");
        const where = text("where");
        this.fail(s, left !== undefined && where !== undefined ? `${initStoppedAt(where)} ${STOP_LEFT_MACHINE_LINE}` : (text("line") ?? "the build was stopped"));
        if (left !== undefined) this.sweep(left);
        break;
      }
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

  /** The rows as the view shows them: the agents given the tools, every stage in the build's order with the
   * sign-ins where they happen, after the machine answers and before the snapshot, then the first workspace and
   * its project. A stopped build keeps the list it had, order and all: the stages it never reached stay in it as
   * waiting, so nothing moves under the person reading why it stopped. A stage's label is its plain name; its
   * state says where it is, and the failure's own line closes the failed stage's block. */
  private rowsOf(s: State): InitRow[] {
    // Copies: a view on the events channel is a snapshot, and the rows here move on after it.
    const agents = s.rows.filter(r => r.kind === "agent").map(r => ({ ...r }));
    const signIns = s.rows.filter(r => r.kind === "sign-in").map(r => ({ ...r }));
    const rest = s.rows.filter(r => r.kind !== "agent" && r.kind !== "sign-in").map(r => ({ ...r }));
    if (!s.building) return [...agents, ...signIns, ...rest];
    const view = reduceStages(s.frames, STAGE_WORDS);
    // A build that reached its end had the stages it ran and no others; one that stopped was going to run the rest,
    // so they stay in the list as waiting rather than vanishing under the person reading why it stopped.
    const stages = STAGE_WORDS.filter(w => s.phase !== "done" || view.steps.some(x => x.stage === w.stage)).map((w): InitRow => {
      const step = view.steps.find(x => x.stage === w.stage);
      // A stage a person's stop ended did not fail: on a cancelled job it reads stopped, so the row never wears a
      // failure's cross under a headline that says the stop was theirs. A stage still current when the build ended
      // is not running either: nothing closed its frame, and a spinner on a build that is over is a lie.
      const ended = s.phase === "cancelled" ? STATE.stopped : STATE.failed;
      const halted = s.phase === "failed" || s.phase === "cancelled";
      const running = halted ? ended : s.slotWait === w.stage ? STATE.slot : STATE.running;
      const state = step === undefined ? STATE.waiting : step.state === "current" ? running : step.state === "done" ? STATE.done : ended;
      // A failed stage ends with the reason, so a row read on its own says why and a build that stopped before any
      // stage ran still has one line saying what stopped it. The terminal's block draws the failure itself.
      const failure = step?.state === "failed" && view.failure !== undefined ? view.failure.split("\n").filter(l => l !== "") : [];
      const tail = step === undefined ? [] : [...step.tail, ...failure.filter(l => l !== step.tail.at(-1))];
      const detail = step?.running?.command ?? tail.at(-1);
      const lines = [...tail.slice(-STAGE_LINES), ...(step?.running !== undefined ? [step.running.command] : [])];
      const since = !halted && step?.state === "current" ? step.since : undefined;
      return { id: `stage/${w.stage}`, kind: "stage", label: w.start, state, ...(detail !== undefined ? { detail } : {}), ...(step?.ms !== undefined ? { ms: step.ms } : {}), ...(since !== undefined ? { since } : {}), ...(lines.length > 0 ? { lines } : {}) };
    });
    // The sign-ins sit after the machine answers. A build that ended before that stage has no row for it, and the
    // sign-ins belong after every stage it did reach rather than ahead of all of them.
    const ready = stages.findIndex(r => r.id === "stage/ready");
    const answered = ready >= 0 ? ready + 1 : stages.length;
    return [...agents, ...stages.slice(0, answered), ...signIns, ...stages.slice(answered), ...rest];
  }

  /** A builder the stop could not reach the provider to kill, killed again until the provider takes it. The sweep
   * is the host's, not the ended job's: Start over replaces the job, the machine goes on billing, so the row rides
   * whatever job is current and the sidebar's keycap says so until the provider takes it. */
  private sweep(builderId: string): void {
    if (this.sweeps.has(builderId)) return;
    const row: InitRow = { id: `machine/${builderId}`, kind: "machine", label: initMachineRowLabel(builderId), state: STATE.retrying };
    this.sweeps.set(builderId, row);
    const retry = this.deps.retry ?? SWEEP_RETRY;
    const work = async (): Promise<void> => {
      for (let attempt = 0; attempt < retry.attempts; attempt++) {
        await new Promise(r => setTimeout(r, retry.waitMs));
        try {
          await this.deps.rt.golden.kill(builderId);
          row.state = STATE.gone;
          delete row.detail;
          this.emit();
          return;
        } catch (e) {
          row.detail = e instanceof Error ? e.message : String(e);
          this.emit();
        }
      }
      row.state = STATE.failed;
      this.emit();
    };
    const trying = work();
    this.sweeping.add(trying);
    void trying.finally(() => this.sweeping.delete(trying));
  }
}
