// SPDX-License-Identifier: AGPL-3.0-only
// wsp init: read this machine, let the person tick the agents, what they need
// and the sign-ins on three screens, confirm once, build the golden's first
// machine through the runtime, run the sign-ins chosen for the machine in this
// terminal, set the secrets the pack cut, seal on Enter, and only then start
// the app, fork the first workspace and open the app on it. A run with nobody
// at a terminal ends with the golden recorded and says what starts the app.
// Nothing leaves the disk before the confirm, and no question is ever asked on
// the remote machine.
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters, styleText } from "node:util";
import { catalogEntry } from "@wsp/catalog";
import { LOGIN_CHOICES, MCP_REMOTE_ID, RUNGS, type Manifest, type ManifestEntry, type ProjectScan, type Rung } from "@wsp/collect";
import { describeAge, type BackendPricing } from "@wsp/engine";
import type { Recipe, RecipeCustomRow, RecipeHistory } from "@wsp/protocol";
import { PrepareStoppedError, type GoldenBuilderView, type GoldenRecipe, type GoldenStage, type Runtime } from "@wsp/runtime";
import { S_BAR, S_STEP_CANCEL, S_STEP_ERROR, S_STEP_SUBMIT, cancel, isCancel, log, outro } from "@clack/prompts";
import type { Keys } from "./cli.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILDER_DISK_GB, PACK_BUDGET_BYTES, TOOLS_DISK_FLOOR, agentInstallsFor, brewfileFor, estimateDisk, isMcpRow, pinState, plural, toolInstallsFor, type BrewTable, type ImportResult } from "@wsp/engine";
import { ALREADY_APPLIED, customRows, fmtBytes, fmtDuration, fmtMemGb } from "@wsp/protocol";
import { importFor, importResultPath, keychainLogins, readSecrets, statOf, type SecretReader } from "./init-import.js";
import {
  RUNG_TITLE,
  answeredRows,
  applyRecipe,
  goldenRecipeFor,
  type Answers,
  defaultAnswers,
  isLoginChoice,
  isTickable,
  loadRecipe,
  lockRefused,
  loginShown,
  recipeChanges,
  recipePath,
  recipeWithAnswers,
  saveRecipe,
  saveSmallRecipe,
  smallRecipePath,
  tickLoginTools,
  withCatalogAgents,
  withTicksOf,
  withoutAgentTools,
} from "./init-recipe.js";
import { ALSO_TITLE } from "./init-also.js";
import { TOOLS_TITLE, pickScreens, projectNote, signInItems, wspToolsAgent, wspToolsItems } from "./init-pick.js";
import { PROJECT_GROUP } from "./init-table.js";
import { SIGN_IN_WORDS } from "./signin-words.js";
import type { ScanRow } from "./scan.js";
import { installEach, installLines, mcpServerSpec } from "./mcp-install.js";
import { carriedOver, historyLine } from "./recipe-command.js";
import { CARD_FRAME, GUTTER, card, confirmPrompt, ellipsize, isTTY, plainLine, rowsOf, table, widthOf, wrap } from "./init-layout.js";
import { openRunLog, runLogPath } from "./init-log.js";
import { secretsStage, type SecretOutcome } from "./init-secrets.js";
import { buildTakes, buildTimes, readBuildTimes } from "./init-times.js";
import { keptBuilder, stopKeptBuilder, updateRoad } from "./init-upgrade.js";
import { retentionOffer } from "./storage.js";
import { DONE_LINE, appUrl, askFirst, checkImportFolder, runFirst, type FirstResult } from "./init-first.js";
import type { Tone } from "./init-select.js";
import { diskLine, diskTone } from "./init-weight.js";
import { builderLink, flowHooks, keyAsks, noteOutcomes, signInStage, stageLogins, type BuilderLink, type HostHooks, type LoginOutcome, type SignInFlow } from "./init-signin.js";
import { handoffStage } from "./init-handoff.js";
import { portClash } from "./ports.js";
import type { CallbackRelay } from "./relay.js";
import type { HostHandle, WorkspaceRoads } from "./server.js";

export interface InitIO {
  input: Readable;
  output: Writable;
  /** The other stream on the same screen; while the stages animate its lines settle above the block. */
  stderr: Writable;
  isTTY: boolean;
  env: Record<string, string | undefined>;
  /** Try to open the URL in a browser; false when nothing could be launched. */
  open(url: string): Promise<boolean>;
  /** Where Ctrl-C and a service stop arrive while the builder is prepared; the real one is process. */
  signals: { on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown; off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown };
  /** Ends the process; the real one is process.exit. */
  exit(code: number): void;
  /** One machine-readable object per line for whoever is driving the run, under --json; absent, nothing is
   * printed this way and every line is the prose above. */
  json?(record: Record<string, unknown>): void;
}

export interface InitOptions {
  /** Take every default and skip every prompt, the confirm included. */
  yes: boolean;
  /** Ask nothing here, but still run the sign-ins on the machine and hand each page to the person: the shape an
   * agent drives wsp init in. Off a terminal this is what a run without --yes does anyway. */
  nonInteractive?: boolean;
  /** The small recipe of catalog ids that ticks the agents and tools rows: the screens for them are skipped and the
   * run lands on the sign-ins. This machine is still read for the rows and files. */
  recipeFile?: string;
  /** A project folder named on the command line, already weighed into the recipe opts.recipe returns; absent, the
   * first screen asks for one. */
  project?: string;
  /** Reads one project folder's own manifests for what it needs, for the folder the first screen asks for; nothing
   * when there is no folder there. */
  scanProject(folder: string): Promise<ProjectScan | undefined>;
  /** --first-workspace: the name the first fork takes, and an answer of yes to the last question. */
  firstWorkspace?: string;
  /** --import: the folder whose project lands on that first workspace, and an answer of yes to the last question. */
  importFolder?: string;
  /** Reads this computer, telling onRung how many rows each rung found as it finishes. */
  collect(onRung: (rung: Rung, rows: number) => void): Promise<Manifest>;
  /** Reads this computer against the catalog and the agents' session histories for the recipe the screens start
   * from, telling onHistory each agent's counts as its history is read and onProject what a named project asked
   * for, so the flag path shows the same card the wizard's own question leaves. */
  recipe(onHistory: (h: RecipeHistory) => void, onProject: (scan: ProjectScan) => void): Promise<Recipe>;
  keys: Keys;
  /** Prices the builder the confirm names. */
  pricing: BackendPricing;
  statePath: string;
  /** This computer's home directory, where the ticked paths are read from at build time. */
  home: string;
  /** Reads Keychain-held logins chosen as copy; the real one raises macOS's consent dialog. */
  secrets: SecretReader;
  platform: "darwin" | "linux";
  /** What this computer's Homebrew knows about its installed formulae: sizes, dependencies, source repositories.
   * The real one runs brew; absent or failing, formula sizes come from the measured table alone. */
  brew?: () => Promise<BrewTable>;
  /** What the package managers here could install on the image, minus what the recipe already installs: the Also on
   * this Mac screen. The real one runs each manager's listing; absent or failing, that screen is not shown. */
  scan?: (recipe: readonly RecipeCustomRow[]) => Promise<readonly ScanRow[]>;
  /** Builds the runtime around the recipe the ticks produced. */
  runtime(recipe: GoldenRecipe): Runtime;
  /** The ports the app binds. A run on a terminal without --non-interactive ends by serving the app, so it probes them
   * before anything is read and a clash is found before a machine bills. */
  ports: { port: number; wsPort: number };
  /** The command that starts the app once the golden is recorded, with the flags this run was given. */
  upCommand: string;
  /** The command that forks the first workspace from it, for a run with nobody at a terminal that asked for none. */
  forkCommand: string;
  /** Links this computer to the builder for the sign-ins: the pages the machine asks to open and the callback ports
   * its flows listen on. It runs from Ready to the end of the sign-ins and binds no fixed port. The hooks wire the
   * sign-in stage in. */
  relay(rt: Runtime, builder: GoldenBuilderView, hooks: HostHooks): Promise<Pick<CallbackRelay, "close">>;
  /** The workspace and project roads the app's own routes take, for a run that forks its first workspace with no host
   * serving. */
  roads(rt: Runtime): WorkspaceRoads;
  /** Starts the app server over the runtime once the golden is sealed and recorded, on a run at a terminal without
   * --non-interactive: a person is there to use it. */
  host(rt: Runtime): Promise<HostHandle>;
  /** A pty link to the builder's daemon for the sign-in and secrets steps, dialled before each command; the real one dials its reach. */
  daemon?(rt: Runtime, builder: GoldenBuilderView): Promise<BuilderLink>;
  /** How long to wait when the account is at its machine cap, and how often. */
  retry?: { waitMs: number; attempts: number };
}

export type { HostHooks };

export interface InitResult {
  code: number;
  handle?: HostHandle;
  logins?: LoginOutcome[];
  secrets?: SecretOutcome[];
}

/** What an earlier run left on the account for this recipe. */
interface Earlier {
  /** The first-life builder of this setup carrying this recipe, when there is one. */
  attach?: GoldenBuilderView;
  /** This setup's builders that cannot be attached to; the boot question offers to stop them first. */
  stop: GoldenBuilderView[];
}

const GOLDEN_NAME = "default";
const DEFAULT_RETRY = { waitMs: 30_000, attempts: 20 };
/** What ends a builder this run could not: a record its dead holder left is stale to the next start, which stops it. */
const SWEEP = "the next wsp or wsp init on this computer stops it, or stop it from the Solari console.";
const dim = (s: string): string => styleText("dim", s);


// --- stage stream ----------------------------------------------------------

export interface StageWords {
  stage: GoldenStage;
  start: string;
  end: string;
  fail: string;
}

export interface StageStep {
  stage: GoldenStage;
  start: string;
  end: string;
  fail: string;
  state: "current" | "done" | "failed";
  tail: string[];
  /** How long the stage ran, known once a later frame ends it. */
  ms?: number;
}

export interface StageView {
  steps: StageStep[];
  failure?: string;
}

export interface StageFrame {
  type: "golden.stage";
  name: string;
  stage: string;
  detail?: string;
  /** When the frame arrived, epoch ms; stamped by the stream, absent on the wire. */
  at?: number;
}

/** The words the terminal shows for each prepare stage while it runs and once
 * it is over. The stage names are the protocol's; the harness stage installs
 * whatever agents were ticked, and names none of them. The engine decides the
 * order the stages run in; this list only settles which one a failure with no
 * stage running is charged to. */
export const PREPARE_STEPS: readonly StageWords[] = [
  { stage: "creating", start: "Creating the machine", end: "Machine created", fail: "Creating the machine failed" },
  { stage: "deploying-daemon", start: "Installing the base (tools and daemon)", end: "Base installed", fail: "Installing the base failed" },
  { stage: "applying-setup", start: "Applying your setup", end: "Setup applied", fail: "Applying your setup failed" },
  { stage: "uploading-files", start: "Uploading your files", end: "Files uploaded", fail: "Uploading your files failed" },
  { stage: "installing-harness", start: "Installing agents", end: "Agents installed", fail: "Installing agents failed" },
  { stage: "installing-tools", start: "Installing tools", end: "Tools installed", fail: "Installing tools failed" },
  { stage: "installing-mcp", start: "Installing MCP servers", end: "MCP servers installed", fail: "Installing MCP servers failed" },
  { stage: "ready", start: "Waiting for the machine", end: "Ready", fail: "The machine never became ready" },
];

/** The seal, run from this terminal once the person says so. */
export const SEAL_STEPS: readonly StageWords[] = [
  { stage: "snapshotting", start: "Taking the snapshot", end: "Snapshot taken", fail: "Snapshot failed" },
  { stage: "smoke-forking", start: "Booting a fork to prove it", end: "Fork booted and checked", fail: "The fork failed its check" },
  { stage: "sealed", start: "Sealing", end: "Sealed", fail: "Seal failed" },
];

const LAST_STAGE = new Set<string>(["ready", "sealed"]);

/** The steps as the frames built them: a step appears on its first frame, runs until a frame names another
 * stage, and is closed by nothing else. The engine runs one stage at a time, so one step is current at most. */
export function reduceStages(frames: readonly StageFrame[], words: readonly StageWords[] = PREPARE_STEPS): StageView {
  const steps: StageStep[] = [];
  let failure: string | undefined;
  let current: StageStep | undefined;
  let since: number | undefined;
  const close = (at: number | undefined): void => {
    if (current === undefined) return;
    if (since !== undefined && at !== undefined) current.ms = at - since;
    current.state = "done";
    current = undefined;
    since = undefined;
  };
  for (const f of frames) {
    if (f.name !== GOLDEN_NAME) continue;
    if (f.stage === "failed") {
      failure = f.detail ?? "no detail given";
      // With nothing running the failure lands on the stage about to run: the first the frames never named.
      let failing = current;
      if (failing === undefined) {
        const next = words.find(w => !steps.some(s => s.stage === w.stage));
        if (next !== undefined) {
          failing = { ...next, state: "failed", tail: [] };
          steps.push(failing);
        }
      }
      if (failing !== undefined) failing.state = "failed";
      current = undefined;
      continue;
    }
    const word = words.find(w => w.stage === f.stage);
    if (word === undefined) continue;
    let step = steps.find(s => s.stage === f.stage);
    if (step !== current) close(f.at);
    if (step === undefined) {
      step = { ...word, state: "current", tail: [] };
      steps.push(step);
    }
    if (f.detail !== undefined) step.tail.push(f.detail);
    // A stage the builder already holds is over the moment it is named, and the last stage has nothing after it to end it; neither gets a clock.
    if (f.detail === ALREADY_APPLIED || LAST_STAGE.has(f.stage)) {
      step.state = "done";
      current = undefined;
      since = undefined;
      continue;
    }
    // A stage reports again when it has a detail to add; its clock starts at the first frame.
    if (step !== current) {
      current = step;
      since = f.at;
    }
    step.state = "current";
  }
  return failure !== undefined ? { steps, failure } : { steps };
}

/** One stage as one line: the glyph, the label padded so details line up, the latest detail,
 * and once the stage is done its duration flush against the right edge. With no width (off a
 * terminal, where a log has no edge) nothing is cut and the duration follows the detail. */
export function stageLine(glyph: string, label: string, detail: string | undefined, ms: number | undefined, width: number | undefined, labelWidth: number): string {
  const duration = ms === undefined ? "" : fmtDuration(ms);
  const head = label.padEnd(labelWidth);
  const text = detail === undefined || detail === "" ? "" : width === undefined ? detail : ellipsize(detail, width - 3 - labelWidth - GUTTER.length - (duration === "" ? 0 : GUTTER.length + duration.length));
  const shown = head.length + (text === "" ? 0 : GUTTER.length + text.length);
  const gap = duration === "" ? "" : width === undefined ? GUTTER : " ".repeat(Math.max(GUTTER.length, width - 3 - shown - duration.length));
  return `${glyph}  ${head}${text === "" ? "" : `${GUTTER}${dim(text)}`}${gap}${dim(duration)}`.trimEnd();
}

/** The cells a drawn row takes on screen: its text without the colour codes. */
const cells = (row: string): number => stripVTControlCharacters(row).length;

/** One line per step, redrawn as frames arrive: a spinner glyph on the current
 * step with its latest detail, the end label once it is done, the tail of
 * details kept under a failed step. Animation only on a terminal, where the
 * block is the stream's alone: every redraw rewinds to its first row and no
 * line is ever wider than the terminal, so the rows it holds are the rows it
 * wrote, counted at the width the terminal has now. While it animates it owns
 * every write to the output and to the stream beside it, since a line written
 * under the block would push it down a row; those lines settle above the block
 * and go to the sink when there is one. */
export class StageStream {
  private frames: StageFrame[] = [];
  private view: StageView;
  /** The cell width of each row the block holds on screen, in order. */
  private drawn: number[] = [];
  private timer: NodeJS.Timeout | undefined;
  private tick = 0;
  private taken: { stream: Writable; write: Writable["write"] }[] = [];
  private static readonly SPIN = ["◒", "◐", "◓", "◑"];

  constructor(
    private readonly output: Writable,
    private readonly animate: boolean,
    private readonly words: readonly StageWords[] = PREPARE_STEPS,
    /** Where every line said while the stream ran also goes, the run log once there is one. */
    private readonly sink?: (line: string) => void,
    /** The other stream on the same screen, whose lines would land under the block: stderr when the block is on stdout. Off a terminal it cannot move the cursor and is left alone. */
    private readonly aside?: Writable,
  ) {
    this.view = reduceStages([], words);
  }

  get failed(): boolean {
    return this.view.failure !== undefined;
  }

  get finished(): boolean {
    return this.view.failure !== undefined || this.view.steps.some(s => LAST_STAGE.has(s.stage) && s.state === "done");
  }

  start(): void {
    if (this.animate) {
      this.take(this.output);
      if (this.aside !== undefined && isTTY(this.aside)) this.take(this.aside);
      this.timer = setInterval(() => {
        this.tick += 1;
        this.draw();
      }, 80);
    }
    this.draw();
  }

  /** The detail is flattened once, here, to the row it is drawn as; a failure is drawn one row per line, so it keeps its newlines. */
  push(frame: StageFrame): void {
    const prev = this.view;
    const detail = frame.detail === undefined ? undefined : frame.stage === "failed" ? frame.detail.split("\n").map(plainLine).join("\n") : plainLine(frame.detail);
    this.frames.push({ ...frame, ...(detail !== undefined ? { detail } : {}), at: frame.at ?? Date.now() });
    this.view = reduceStages(this.frames, this.words);
    if (this.animate) this.draw();
    else this.announce(prev);
  }

  /** A line said while the stream runs: it settles above the block, which is drawn again under it. */
  note(text: string): void {
    const lines = text.split("\n").map(plainLine);
    for (const line of lines) this.sink?.(line);
    const width = this.width;
    const said = lines.flatMap(l => (width === undefined ? [l] : wrap(l, width - 3, ""))).map(l => `${dim(S_BAR)}  ${dim(l)}`);
    if (!this.animate) {
      this.output.write(`${said.join("\n")}\n`);
      return;
    }
    const block = this.lines(false, false);
    this.emit(`${this.rewind()}${[...said, ...block].join("\n")}\n`);
    this.drawn = block.map(cells);
  }

  /** Draws the last frame and hands the streams back; `stopped` marks the stage in flight as cut off rather than spinning. */
  stop(stopped = false): StageView {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const t of [...this.taken].reverse()) t.stream.write = t.write;
    this.taken = [];
    this.draw(true, stopped);
    return this.view;
  }

  /** Every write to the stream while the block animates becomes a note; a write's own callback still runs. */
  private take(stream: Writable): void {
    if (this.taken.some(t => t.stream === stream)) return;
    const write = stream.write;
    this.taken.push({ stream, write });
    stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
      const text = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : String(chunk);
      this.note(text.replace(/\n$/, ""));
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") done();
      return true;
    }) as Writable["write"];
  }

  /** The stream's own bytes reach the terminal past the write it took over. */
  private emit(text: string): void {
    const own = this.taken.find(t => t.stream === this.output)?.write;
    if (own === undefined) this.output.write(text);
    else own.call(this.output, text, "utf8");
  }

  private get labelWidth(): number {
    return Math.max(...this.words.flatMap(w => [w.start.length, w.end.length]));
  }

  /** The edge lines are laid out to, one cell inside the terminal's so no line can reach the wrap; a log off a terminal has none. */
  private get width(): number | undefined {
    return this.animate ? widthOf(this.output) - 1 : undefined;
  }

  private cut(text: string): string {
    const width = this.width;
    return width === undefined ? text : ellipsize(text, width - 3);
  }

  private doneLine(s: StageStep): string {
    return stageLine(styleText("green", S_STEP_SUBMIT), s.end, s.tail.at(-1), s.ms, this.width, this.labelWidth);
  }

  private lines(final: boolean, stopped: boolean): string[] {
    const out: string[] = [];
    const width = this.width;
    const failure = final && this.view.failure !== undefined ? this.view.failure.split("\n") : [];
    // The block must fit the screen it redraws over, so a failed step's tail gives up its oldest lines first.
    const budget = this.animate ? Math.max(0, rowsOf(this.output) - 1 - this.view.steps.length - failure.length) : Infinity;
    for (const s of this.view.steps) {
      switch (s.state) {
        case "current":
          out.push(stageLine(stopped ? styleText("red", S_STEP_CANCEL) : styleText("cyan", StageStream.SPIN[this.tick % StageStream.SPIN.length]!), s.start, s.tail.at(-1), undefined, width, this.labelWidth));
          break;
        case "done":
          out.push(this.doneLine(s));
          break;
        case "failed":
          out.push(`${styleText("red", S_STEP_ERROR)}  ${this.cut(s.fail)}`);
          for (const t of budget === 0 ? [] : s.tail.slice(-budget)) out.push(`${dim(S_BAR)}  ${dim(this.cut(t))}`);
          break;
        default: {
          const _exhaustive: never = s.state;
          return _exhaustive;
        }
      }
    }
    for (const l of failure) out.push(`${dim(S_BAR)}  ${this.cut(l)}`);
    return out;
  }

  /** Back to the block's first row and column, with everything from there cleared. */
  private rewind(): string {
    // A terminal narrowed under the block reflows every row wider than it now is onto more rows.
    const columns = widthOf(this.output, Infinity);
    const rows = this.drawn.reduce((n, w) => n + Math.max(1, Math.ceil(w / columns)), 0);
    return rows > 0 ? `\x1b[${rows}A\x1b[G\x1b[J` : "";
  }

  private draw(final = false, stopped = false): void {
    if (this.animate) {
      const lines = this.lines(final, stopped);
      // Before the first frame there is no block: a bare newline here would be a row the rewind never counts.
      if (lines.length > 0) this.emit(`${this.rewind()}${lines.join("\n")}\n`);
      this.drawn = lines.map(cells);
      return;
    }
    // Off a terminal every step was announced as it happened; only a failure is left to print.
    if (final && this.view.failure !== undefined) {
      const failed = this.view.steps.find(s => s.state === "failed");
      if (failed) this.output.write(`${styleText("red", S_STEP_ERROR)}  ${failed.fail}\n`);
      for (const l of this.view.failure.split("\n")) this.output.write(`${dim(S_BAR)}  ${l}\n`);
    }
  }

  /** Off a terminal, one line per step as it starts and as it ends, so a log reads in order. */
  private announce(prev: StageView): void {
    for (const s of this.view.steps) {
      const was = prev.steps.find(p => p.stage === s.stage)?.state;
      if (s.state === "current" && was !== "current") this.output.write(`${dim(S_BAR)}  ${s.start}\n`);
      if (s.state === "done" && was !== "done") this.output.write(`${this.doneLine(s)}\n`);
    }
  }
}

interface Spinner {
  /** Text after the label, redrawn at once (a running tally). */
  detail(text: string): void;
  stop(): void;
}

/** One animated line while something short runs; off a terminal nothing is drawn. */
function spin(output: Writable, label: string, animate: boolean): Spinner {
  if (!animate) return { detail: () => {}, stop: () => {} };
  let tick = 0;
  let detail = "";
  const frames = ["◒", "◐", "◓", "◑"];
  const columns = (output as Writable & { columns?: number }).columns;
  // Glyph, two gaps, one spare cell: past the width the line wraps and the carriage return redraws over the wrapped tail.
  const room = columns === undefined ? Infinity : columns - label.length - 6;
  const draw = (): void => {
    const text = detail.length > room ? `${detail.slice(0, Math.max(0, room - 1))}…` : detail;
    output.write(`\r${styleText("cyan", frames[tick++ % frames.length]!)}  ${label}${text !== "" ? `  ${dim(text)}` : ""}`);
  };
  draw();
  const timer = setInterval(draw, 80);
  return {
    detail(text) {
      detail = text;
      draw();
    },
    stop() {
      clearInterval(timer);
      output.write("\r\x1b[2K");
    },
  };
}

// --- screens ---------------------------------------------------------------

const TICKED_FOR_LOGINS = "ticked under Tools for the sign-ins: ";
const asBring = (entries: readonly ManifestEntry[]): ManifestEntry[] => entries.map(e => ({ ...e, bring: true }));

const bytesOf = (entries: readonly ManifestEntry[]): string => {
  const n = entries.reduce((sum, e) => sum + e.bytes, 0);
  return n > 0 ? fmtBytes(n) : "";
};

/** One row per rung: name, how many rows, their size, and how many can come when some cannot. */
function detectionNote(manifest: Manifest, source: string): string[] {
  if (manifest.entries.length === 0) return ["Nothing found to bring.", "", "Nothing has left this computer."];
  const rows = RUNGS.map(rung => manifest.entries.filter(e => e.rung === rung))
    .filter(entries => entries.length > 0)
    .map(entries => {
      const canCome = entries.filter(isTickable).length;
      return [RUNG_TITLE[entries[0]!.rung], String(entries.length), bytesOf(entries), canCome < entries.length ? `${canCome} can come` : ""];
    });
  return [...table(rows, ["left", "right", "right"]), "", `${manifest.entries.length} ${source}. Nothing has left this computer.`];
}

/** The label on the first of the summary card's rows outside the catalog; the rest sit under it in the same column. */
export const ADDED_LABEL = "Added";

/** What the ticked rows install, counted once for the summary card and the build screen's own line: the agents by
 * name, the tools the person ticked and the rows outside the catalog (Homebrew's toolchain named apart), and the
 * MCP servers that travel. */
function buildCounts(
  manifest: Manifest,
  ticks: ReadonlySet<string>,
  brew: BrewTable,
  custom: readonly RecipeCustomRow[],
): { agents: string[]; tools: number; toolchain: string; servers: number } {
  const bring = manifest.entries.filter(e => ticks.has(e.id)).map(e => ({ ...e, bring: true }));
  const steps = toolInstallsFor(bring, brew, custom).installs;
  return {
    agents: agentInstallsFor(bring).installs.map(a => a.name),
    // The rows outside the catalog are the person's tools too, and no tick names them.
    tools: steps.filter(t => ticks.has(t.id)).length + custom.length,
    toolchain: steps.some(t => t.id.startsWith("tools/brew-toolchain/")) ? " plus Homebrew's toolchain" : "",
    servers: bring.filter(e => isMcpRow(e) && e.id !== MCP_REMOTE_ID).length,
  };
}

/** The build screen's own line: what the five screens before it settled on, how long the build takes, how big the
 * image lands, and that a machine left alone stops billing. What it costs an hour is the boot question's, under it. */
export function readyLine(
  manifest: Manifest,
  ticks: ReadonlySet<string>,
  choices: ReadonlyMap<string, string>,
  upload: number,
  brew: BrewTable,
  takes: string,
  custom: readonly RecipeCustomRow[] = [],
): string {
  const { agents, tools } = buildCounts(manifest, ticks, brew, custom);
  const est = estimateDisk(manifest.entries.filter(e => ticks.has(e.id)).map(e => ({ ...e, bring: true })), upload, brew, custom);
  const machine = manifest.entries.filter(e => e.rung === "logins" && choices.get(e.id) === "machine").length;
  return [
    `Ready to build. ${plural(agents.length, "agent")}, ${plural(tools, "tool")}, ${fmtBytes(est.total)} on the image.`,
    `${plural(machine, "sign-in")} on the machine after the build.`,
    `The build takes ${takes}; a workspace naps when it is idle and stops billing.`,
  ].join(" ");
}

/** One row per rung with its ticks and size, the sign-ins under theirs with the answer each
 * got, a credential-shaped row under its rung when it got an answer other than skip,
 * then what uploads and what installs, wrapped under their own column. `upload` is the plan's own
 * count of the bytes that travel; without it the ticked rows' sizes stand in. */
export function summaryNote(
  manifest: Manifest,
  ticks: ReadonlySet<string>,
  choices: ReadonlyMap<string, string>,
  width: number,
  upload: number = manifest.entries.filter(e => ticks.has(e.id)).reduce((n, e) => n + e.bytes, 0),
  brew: BrewTable = new Map(),
  custom: readonly RecipeCustomRow[] = [],
): string[] {
  const perRung = RUNGS.map(rung => manifest.entries.filter(e => e.rung === rung)).filter(entries => entries.length > 0);
  const answer = (e: ManifestEntry): string => { const c = choices.get(e.id); return isLoginChoice(c) ? SIGN_IN_WORDS[c].short : "skip"; };
  // The sign-ins row counts the answers that bring something, as its screen's header does: a sign-in is chosen though nothing is ticked.
  const loginSpread = (entries: readonly ManifestEntry[]): string =>
    LOGIN_CHOICES.filter(c => c !== "skip")
      .map(c => ({ n: entries.filter(e => answer(e) === SIGN_IN_WORDS[c].short).length, label: SIGN_IN_WORDS[c].short }))
      .filter(p => p.n > 0)
      .map(p => `${p.n} ${p.label}`)
      .join(", ");
  const rows = table(
    perRung.map(entries => {
      const on = entries.filter(e => ticks.has(e.id));
      const spread = entries[0]!.rung === "logins" ? loginSpread(entries) : "";
      return [RUNG_TITLE[entries[0]!.rung], spread !== "" ? spread : `${on.length} of ${entries.length}`, bytesOf(on)];
    }),
    ["left", "right", "right"],
  );
  const listed = manifest.entries.filter(e => e.rung === "logins" || (e.consent === true && answer(e) !== "skip"));
  // Lines are wrapped here to what the card leaves, so the card prints them as they are; the label keeps room for the widest answer.
  const inner = width - CARD_FRAME;
  const labelRoom = inner - 2 - GUTTER.length - Math.max(...Object.values(SIGN_IN_WORDS).map(w => w.short.length));
  const answered = new Map(table(listed.map(e => [`  ${ellipsize(e.label, labelRoom)}`, answer(e)])).map((line, i) => [listed[i]!.id, line]));
  const lines = perRung.flatMap((entries, i) => [rows[i]!, ...entries.flatMap(e => answered.get(e.id) ?? [])]);
  const bring = manifest.entries.filter(e => ticks.has(e.id)).map(e => ({ ...e, bring: true }));
  const { agents, tools, toolchain, servers } = buildCounts(manifest, ticks, brew, custom);
  // A tool installed from its release is pinned per tag: recorded on the first install of a tag, checked while the tag stands.
  const roads = brewfileFor(bring, brew).roads;
  const PIN_WORDS = { none: "checksum recorded on first install", same: "checksum checked against the first install", moved: "new release, checksum recorded" } as const;
  const pinWords = [...new Set(roads.map(r => PIN_WORDS[pinState(r.pin, r.source)]))].join("; ");
  const fromReleases = roads.length === 0 ? "" : `, ${roads.length} from ${roads.length === 1 ? "its" : "their"} GitHub release${roads.length === 1 ? "" : "s"} (${pinWords})`;
  const installs = [...agents, ...(tools > 0 ? [`${tools} tool${tools === 1 ? "" : "s"}${toolchain}${fromReleases}`] : []), ...(servers > 0 ? [`${servers} MCP server${servers === 1 ? "" : "s"}`] : [])];
  const est = estimateDisk(bring, upload, brew, custom);
  // The Disk line takes its weight's colour here too: the card is the last thing read before the confirm.
  const closing: [string, string, Tone | undefined][] = [
    ["Upload", upload > PACK_BUDGET_BYTES ? `${fmtBytes(upload)}, over the ${fmtBytes(PACK_BUDGET_BYTES)} the machine's disk allows` : `${fmtBytes(upload)}, nothing has left this computer yet`, undefined],
    ["Installs", installs.length > 0 ? installs.join(", ") : "nothing; the machine boots bare", undefined],
    // A row outside the catalog is a line the person's own agent wrote, run as root on the builder: the card is the
    // last thing read before the boot, so each one is named here with the command it runs, never only counted.
    ...custom.map((c, i): [string, string, Tone | undefined] => [i === 0 ? ADDED_LABEL : "", `${c.name} runs ${c.install.join("; ")}`, undefined]),
    ["Disk", diskLine(est), diskTone(est.total, est.room)],
  ];
  const column = Math.max(...closing.map(([label]) => label.length)) + GUTTER.length;
  return [...lines, "", ...closing.flatMap(([label, text, tone]) => wrap(`${label.padEnd(column)}${text}`, inner, " ".repeat(column)).map(l => (tone === undefined ? l : styleText(tone, l))))];
}

/** The machine the recipe asks for: what the recipe names, else the backend's own default. */
function builderSize(recipe: GoldenRecipe, pricing: BackendPricing): { cpu: number; memMb: number } {
  return { cpu: recipe.cpu ?? pricing.defaultSize.cpu, memMb: recipe.memMb ?? pricing.defaultSize.memMb };
}

/** Names the builder about to bill: its size and the backend's rate for it, the one place the rate is said. */
function bootQuestion(recipe: GoldenRecipe, pricing: BackendPricing): string {
  const size = builderSize(recipe, pricing);
  return `Boot a ${size.cpu} vCPU, ${fmtMemGb(size.memMb)} builder on Solari and build this? About $${pricing.rateUsdPerHour(size).toFixed(2)}/hr while it runs.`;
}

function isCapRefusal(e: unknown): boolean {
  return e instanceof Error && "kind" in e && e.kind === "concurrency";
}

function overSsh(env: Record<string, string | undefined>): boolean {
  return env["SSH_CONNECTION"] !== undefined || env["SSH_TTY"] !== undefined || env["SSH_CLIENT"] !== undefined;
}

/** The shell's own code for a death by that signal. */
function exitCodeOf(sig: "SIGINT" | "SIGTERM"): number {
  return sig === "SIGINT" ? 130 : 143;
}

/** Resolves after ms, or at once when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

// --- the command -------------------------------------------------------------

export async function runInit(opts: InitOptions, io: InitIO): Promise<InitResult> {
  const out = { output: io.output };
  // Off a terminal, and under --non-interactive on one, there is nobody to ask: it runs as if --yes were given.
  const interactive = io.isTTY && !opts.yes && opts.nonInteractive !== true;
  // Nobody to ask, but the sign-ins still run and each page is handed to the person; --yes is the one road that skips them.
  const handoff = !interactive && !opts.yes;
  // Which of the three reasons nothing is asked, in the words every taken-as-yes line uses.
  const takenAs = opts.yes ? "--yes" : io.isTTY ? "--non-interactive" : "no terminal";
  // A person at a terminal gets the app served at the end, --yes or not; --non-interactive says an agent is driving,
  // and off a terminal nobody is here, so neither serves anything. Only a run that serves needs the ports.
  const serves = io.isTTY && opts.nonInteractive !== true;
  if (serves) {
    const clash = await portClash([opts.ports.port, opts.ports.wsPort]);
    if (clash !== undefined) {
      log.error(clash, out);
      cancel("Nothing was booted. Stop that process, or run wsp init and wsp up with --port and --ws-port naming free ports.", out);
      return { code: 1 };
    }
  }

  let manifest: Manifest;
  // The catalog recipe the screens start from: the file given, else read off this computer once the rows are in.
  let given: Recipe | undefined;
  const spinner = spin(io.output, "Reading this computer", io.isTTY);
  const counts: string[] = [];
  const notes: string[] = [];
  try {
    if (opts.importFolder !== undefined) checkImportFolder(opts.importFolder);
    if (opts.recipeFile !== undefined) given = loadRecipe(opts.recipeFile);
    manifest = await opts.collect((rung, rows) => {
      counts.push(`${RUNG_TITLE[rung]} ${rows}`);
      spinner.detail(counts.join(", "));
    });
  } catch (e) {
    spinner.stop();
    log.error(e instanceof Error ? e.message : String(e), out);
    return { code: 1 };
  }
  spinner.stop();
  const source = given === undefined ? "found on this computer" : "found on this computer, ticked by the recipe";
  // This computer's own recipe is read even under a recipe file: the file's ticks and answers stand, the rows and
  // their sources are what is here, so a row about this Mac (an agent's config to write) never follows another's.
  let catalogRecipe: Recipe;
  const histories = spin(io.output, "Reading what your agents used", io.isTTY);
  let projectScan: ProjectScan | undefined;
  try {
    const here = await opts.recipe(h => histories.detail(historyLine(h)), scan => (projectScan = scan));
    // The rows outside the catalog are the file's, not this computer's: a plain run keeps what wsp recipe --add
    // wrote into the recipe beside the state, which is the same file this run ends by writing.
    catalogRecipe = given === undefined ? { ...here, ...carriedOver(smallRecipePath(opts.statePath), line => notes.push(line)) } : withTicksOf(here, given);
  } catch (e) {
    histories.stop();
    log.error(e instanceof Error ? e.message : String(e), out);
    return { code: 1 };
  }
  histories.stop();
  // A row the pack would refuse whole is locked here with the pack's own sentence, judged on the same disk the pack reads.
  manifest = lockRefused(manifest, rel => {
    const st = statOf(join(opts.home, rel));
    return st === undefined || st.kind === "dangling" ? undefined : st.kind === "dir";
  });
  // The Mac's Homebrew sizes the formulae on the Tools screen; a brew that fails leaves the measured table.
  let brew: BrewTable = new Map();
  if (opts.brew !== undefined && manifest.entries.some(e => e.id.startsWith("tools/brew/"))) {
    const sizes = spin(io.output, "Reading Homebrew for sizes", io.isTTY);
    try {
      brew = await opts.brew();
    } catch (e) {
      notes.push(`Homebrew could not be read for sizes (${e instanceof Error ? e.message : String(e)}); formula sizes come from the measured table alone.`);
    }
    sizes.stop();
  }
  // What else this Mac could put on the image; only its own screen uses it, so nothing runs when that screen is not shown.
  let scanned: readonly ScanRow[] = [];
  if (opts.scan !== undefined && interactive && opts.recipeFile === undefined) {
    const spinner = spin(io.output, "Reading what your package managers installed here", io.isTTY);
    try {
      // The recipe's own rows go in, so a tool it already installs is not drawn off for a tick to install twice.
      scanned = await opts.scan(customRows(catalogRecipe));
    } catch (e) {
      notes.push(`Your package managers could not be read (${e instanceof Error ? e.message : String(e)}); the ${ALSO_TITLE} screen is left out.`);
    }
    spinner.stop();
  }
  manifest = { ...manifest, entries: withoutAgentTools(manifest.entries) };
  // The card counts what the collector found; the catalog's bare rows join the manifest after it.
  const found = manifest;
  manifest = applyRecipe(withCatalogAgents(manifest), catalogRecipe);
  if (notes.length > 0) log.warn(notes.join("\n"), out);
  card("Found on this computer", detectionNote(found, source), io.output);
  // The folder named on the command line gets the card the wizard's own question leaves, so both paths say the same.
  if (projectScan !== undefined) card(PROJECT_GROUP, projectNote(projectScan), io.output);

  let answers: Answers;
  // The agents here whose config gets the wsp MCP server: a tick on screen five, never a default and never --yes,
  // since a run that asks nothing writes nothing on this computer.
  let wspTools = new Set<string>();
  if (interactive) {
    const picked = await pickScreens({
      manifest,
      recipe: catalogRecipe,
      brew,
      from: opts.recipeFile === undefined ? "agents" : "logins",
      home: opts.home,
      scan: scanned,
      ...(opts.project !== undefined ? { project: opts.project } : {}),
      scanProject: opts.scanProject,
      input: io.input,
      output: io.output,
    });
    if (picked === "cancel") {
      cancel("Nothing was changed.", out);
      return { code: 1 };
    }
    catalogRecipe = picked.recipe;
    wspTools = picked.wspTools;
    manifest = applyRecipe(manifest, catalogRecipe);
    answers = defaultAnswers(manifest);
    // The screens' own answers on the login rows: a ticked keys row is the copy, the listed sign-ins run on the machine.
    for (const [id, choice] of picked.logins) {
      answers.choices.set(id, choice);
      if (choice === "copy") answers.ticks.add(id);
      else answers.ticks.delete(id);
    }
  } else {
    // A run that asks nothing answers every screen with the word it would have opened on, read from the screens' own defaults.
    answers = defaultAnswers(manifest);
    for (const [id, choice] of signInItems(manifest).initial) {
      answers.choices.set(id, choice);
      if (choice === "copy") answers.ticks.add(id);
      else answers.ticks.delete(id);
    }
    // The screens' defaults answer the build; nothing here writes on this computer, since nobody was asked about it.
    for (const id of wspToolsItems(catalogRecipe, opts.home).initial) {
      const agent = wspToolsAgent(id);
      if (agent === undefined) continue;
      log.message(dim(`The wsp tools were not added to ${catalogEntry(agent)?.name ?? agent} here: a run taken as yes (${takenAs}) writes nothing on this computer. Run wsp mcp install --agent ${agent} to add them.`), { output: io.output, symbol: dim(S_BAR) });
    }
    // Nobody is here to click macOS's consent dialog: a login the Keychain holds signs in on the machine
    // unless a saved answer says copy, which is the person's own and keeps the recipe hash it was saved with.
    const defaulted = manifest.entries.filter(e => e.rung === "logins" && e.choice === undefined && answers.choices.get(e.id) === "copy").map(e => ({ ...e, choice: "copy" as const }));
    for (const s of keychainLogins(defaulted, opts.platform, opts.home)) {
      answers.choices.set(s.id, "machine");
      answers.ticks.delete(s.id);
    }
    const added = tickLoginTools(manifest, answers.choices, answers.ticks);
    if (added.length > 0) log.message(dim(`${TICKED_FOR_LOGINS}${added.join(", ")}`), { output: io.output, symbol: dim(S_BAR) });
  }
  const { ticks, choices } = answers;
  const offered: Manifest = { entries: manifest.entries.filter(e => loginShown(e, manifest, ticks)) };

  const bringing = (): ManifestEntry[] => answeredRows(manifest, ticks, choices).filter(e => e.bring);
  let bring = bringing();
  // Filled by the Keychain reads below, after the earlier-builder check; the pack reads it only at build time.
  const secrets = new Map<string, string>();
  const resultsPath = importResultPath(opts.statePath);
  // Read before the first write of the file; every result written this run carries it until a seal measures anew.
  const lastBuild = readBuildTimes(resultsPath);
  const path = recipePath(opts.statePath);
  let landed: ImportResult | undefined;
  const importOf = (rows: readonly ManifestEntry[]) =>
    importFor(rows, {
      home: opts.home,
      secrets,
      platform: opts.platform,
      rows: answeredRows(manifest, ticks, choices),
      brew,
      custom: customRows(catalogRecipe),
      onResult: r => {
        writeFileSync(resultsPath, `${JSON.stringify({ ...r, ...(lastBuild !== undefined ? { build: lastBuild } : {}) }, null, 2)}\n`);
        landed = r;
        // The first install of a release tag pins its asset: the tag and the checksum the guest read go into the recipe for later installs of that tag.
        const pins = new Map(r.tools.filter(t => t.outcome === "installed" && t.road?.sha256 !== undefined && t.road.tag !== undefined).map(t => [t.id, { tag: t.road!.tag!, sha256: t.road!.sha256! }]));
        const stale = (e: ManifestEntry): boolean => pins.has(e.id) && e.pin?.tag !== pins.get(e.id)!.tag;
        if (manifest.entries.some(stale)) {
          manifest = { ...manifest, entries: manifest.entries.map(e => (stale(e) ? { ...e, pin: pins.get(e.id)! } : e)) };
          saveRecipe(path, manifest, ticks, choices);
        }
      },
      // An attach reports no result, so the build's file stands; the retried write's outcome replaces the failure it recorded.
      onContext: o => {
        if (noteOutcomes(resultsPath, { context: o.context, contextFailure: o.contextFailure }).replaced) log.warn(`${resultsPath} could not be read; it was rewritten with the machine context alone.`, out);
      },
    });
  let imp = importOf(bring);
  const uploadBytes = imp.files?.bytes ?? 0;
  card("Summary", summaryNote(offered, ticks, choices, widthOf(io.output), uploadBytes, brew, customRows(catalogRecipe)), io.output);
  saveRecipe(path, manifest, ticks, choices);
  // The small recipe beside it: the catalog ids with the ticks and answers as the screens left them, the form wsp init --recipe reads.
  const small = { path: smallRecipePath(opts.statePath), recipe: catalogRecipe };
  saveSmallRecipe(small.path, recipeWithAnswers(small.recipe, choices));
  log.step(`Recipe saved to ${path} and ${small.path}`, out);
  const wspToolsPlaced = installEach(wspTools, mcpServerSpec(opts.statePath), opts.home);
  for (const placed of wspToolsPlaced.installed) log.step(installLines(placed).join("\n"), out);
  for (const failed of wspToolsPlaced.failures) {
    log.warn(`${catalogEntry(failed.id)?.name ?? failed.id} did not get the wsp tools: ${failed.error}. Fix the file and run wsp mcp install --agent ${failed.id}.`, out);
  }
  // The whole recipe against the disk, before the account is read or anything boots: the tools stage would
  // otherwise fill the disk after the machine billed.
  const disk = estimateDisk(asBring(bring), uploadBytes, brew, customRows(catalogRecipe));
  if (disk.over > 0) {
    log.error(`This recipe needs about ${fmtBytes(disk.total)} on the machine; the ${BUILDER_DISK_GB} GB disk leaves ${fmtBytes(disk.room)} after the base image and ${fmtBytes(TOOLS_DISK_FLOOR)} of headroom.`, out);
    // Where the person can take rows off: the screens whose ticks moved the number, or the file that answered them.
    const screens = customRows(catalogRecipe).length > 0 ? `${TOOLS_TITLE} or ${ALSO_TITLE}` : TOOLS_TITLE;
    const where = opts.recipeFile !== undefined ? `in ${opts.recipeFile}` : `under ${screens}`;
    cancel(`Nothing was booted. Untick about ${fmtBytes(disk.over)} of tools or agents ${where} and run wsp init again; the recipe is kept.`, out);
    return { code: 1 };
  }
  // Judged on the recipe's own sizes, before the account is read or anything boots: the builder's disk
  // check would refuse the same files after the machine billed.
  if (uploadBytes > PACK_BUDGET_BYTES) {
    log.error(`Your files add up to ${fmtBytes(uploadBytes)}; the machine's disk leaves ${fmtBytes(PACK_BUDGET_BYTES)} for them beside the tools and agents.`, out);
    cancel(`Nothing was booted. The rows and their sizes are listed in ${path}; shrink or remove the largest on this computer and run wsp init again. The recipe is kept.`, out);
    return { code: 1 };
  }
  let recipe = goldenRecipeFor(bring, opts.keys, { import: imp });
  const runLog = openRunLog(runLogPath(opts.statePath));
  runLog.note(`recipe ${imp.recipeHash} from ${path}`);
  // Every frame the golden reports, the build's and the seal's, lands in the log for the process's life.
  const logged = (rt: Runtime): Runtime => {
    rt.events.on("golden.stage", e => {
      if (e.type === "golden.stage" && e.name === GOLDEN_NAME) runLog.stage(e.stage, e.detail);
    });
    return rt;
  };
  let rt = logged(opts.runtime({ ...recipe, onExec: runLog.exec }));
  // A clean exit frees the builders this process holds at once; every road out that hands the runtime to no host takes it.
  const closeRuntime = (): Promise<void> => rt.close().catch((e: unknown) => log.error(`runtime close failed: ${e instanceof Error ? e.message : String(e)}`, out));
  const logLine = (): string => dim(runLog.failed === undefined ? `The run log is ${runLog.path}` : `The run log ${runLog.path} could not be written (${runLog.failed})`);
  const describeBuilder = (b: GoldenBuilderView): string => {
    const ageMs = Math.max(0, Date.now() - Date.parse(b.createdAt));
    return `${b.name} (${b.id}), ${describeAge(ageMs)}, about $${((ageMs / 3_600_000) * opts.pricing.rateUsdPerHour(b.size)).toFixed(2)} so far`;
  };
  const reasonOf = (b: GoldenBuilderView): string => {
    if (b.foreignOwner !== undefined) return "not this setup's builder";
    if (b.heldBy !== undefined) return `in use by another wsp process (pid ${b.heldBy.pid})`;
    if (b.building === true) return "its setup never finished";
    if (b.firstLife !== true) return "cannot be sealed after a restart";
    const changes = b.recipe !== undefined && imp.recipe !== undefined ? recipeChanges(b.recipe, imp.recipe, manifest) : [];
    if (changes.length === 0) return "built from a different recipe";
    const named = changes.slice(0, 4);
    if (changes.length > named.length) named.push(`${changes.length - named.length} more`);
    return `built from a different recipe: ${named.join(", ")}`;
  };
  const listEarlier = (blocking: GoldenBuilderView[], attach: GoldenBuilderView | undefined): void => {
    const lines = blocking.map(b => `${describeBuilder(b)}; ${reasonOf(b)}`);
    if (attach !== undefined) lines.push(`${describeBuilder(attach)}; reusable by this run once the others are stopped`);
    log.warn(["A builder from an earlier wsp init is still running on the account:", ...lines].join("\n"), out);
  };
  // An earlier run's builder is attached to when it is still first-life, this setup's, and carries this
  // recipe. Another of this setup's is stopped by its recorded id once the person says so; one another
  // live process holds or another setup owns is never touched from here.
  const earlierBuilder = async (): Promise<Earlier | "blocked"> => {
    const earlier = await rt.golden.builders();
    // A builder kept since a save is the golden's own machine: the update's, never an attach target or a blocker.
    const attach = earlier.find(b => b.name === GOLDEN_NAME && b.firstLife === true && b.foreignOwner === undefined && b.heldBy === undefined && b.building !== true && b.sealed === undefined && b.recipeHash === imp.recipeHash);
    const blocking = earlier.filter(b => b !== attach && b.sealed === undefined);
    const pids = blocking.flatMap(b => (b.heldBy !== undefined ? [b.heldBy.pid] : []));
    if (pids.length > 0 || blocking.some(b => b.foreignOwner !== undefined)) {
      listEarlier(blocking, attach);
      if (pids.length > 0) cancel(`Nothing was booted. Another wsp process (pid ${pids.join(", ")}) is using it; wait for it or stop that process, then run wsp init again.`, out);
      else cancel("Nothing was booted. It belongs to another wsp setup: stop it from there, or from the Solari console if it is yours and forgotten; then run wsp init again.", out);
      return "blocked";
    }
    return { ...(attach !== undefined ? { attach } : {}), stop: blocking };
  };
  let earlier = await earlierBuilder();
  if (earlier === "blocked") return { code: 1 };
  // A free exit, before any consent dialog: a recipe whose ticked agents none can install is refused here, not on the builder.
  if (imp.agents.length === 0 && (imp.skippedAgents?.length ?? 0) > 0) {
    log.error(["No ticked agent can be installed, so there would be nothing to seal:", ...imp.skippedAgents!.map(a => `${a.name}: ${a.note}`)].join("\n"), out);
    cancel("Nothing was booted. Untick those agents or add one with an installer, then run wsp init again.", out);
    return { code: 1 };
  }
  // Keychain consent is asked here, before anything boots and after every road that cancels the
  // run, so a refusal costs no machine: the row turns into a sign-in on the machine and the pack
  // finds no value for it.
  const wanted = keychainLogins(bring, opts.platform, opts.home);
  // Off a terminal the spinner draws nothing, and only a saved copy answer gets here; a scripted run would otherwise sit on macOS's dialog with no word why.
  const keychainItems = [...new Set(wanted.filter(s => s.command === undefined).map(s => s.service))];
  const helpers = [...new Set(wanted.filter(s => s.command !== undefined).map(s => s.service))];
  const helperWords = helpers.length > 0 ? [`running the ${helpers.join(", ")} helper`] : [];
  const sentence = (words: string[]): string => words.join(" and ").replace(/^./, c => c.toUpperCase());
  if (!io.isTTY && wanted.length > 0) log.step(`${sentence([...(keychainItems.length > 0 ? [`reading ${keychainItems.join(", ")} from your Keychain`] : []), ...helperWords])}, as the saved recipe answered copy; macOS may ask you to allow it.`, out);
  const reading = spin(io.output, sentence([...(keychainItems.length > 0 ? ["reading your Keychain logins"] : []), ...helperWords]), io.isTTY && wanted.length > 0);
  const read = await readSecrets(wanted, opts.secrets);
  reading.stop();
  for (const [key, value] of read.values) {
    secrets.set(key, value);
    runLog.hide(value);
  }
  const label = (id: string) => manifest.entries.find(e => e.id === id)?.label ?? id;
  if (read.dropped.length > 0) log.warn(read.dropped.map(d => `${label(d.id)}: ${d.left} (${d.reason}).`).join("\n"), out);
  const left = new Map(read.dropped.map(d => [d.id, read.dropped.filter(x => x.id === d.id).map(x => x.left).join("; ")]));
  if (read.refused.length > 0) {
    // A sign-in on the machine is an answer, not a tick: the row leaves the ticks as the screens would have left it.
    for (const r of read.refused) {
      choices.set(r.id, "machine");
      ticks.delete(r.id);
    }
    log.warn(read.refused.map(r => `${label(r.id)}: ${r.command !== undefined ? `the ${r.service} helper failed` : "Keychain read failed"} (${r.reason}); changed to sign in on the machine.`).join("\n"), out);
    saveRecipe(path, manifest, ticks, choices);
    saveSmallRecipe(small.path, recipeWithAnswers(small.recipe, choices));
    // The flipped rows change the recipe hash; the builder must carry the hash the saved recipe now has,
    // so the next wsp init on the same answers attaches to it.
    bring = bringing();
    imp = importOf(bring);
    recipe = goldenRecipeFor(bring, opts.keys, { import: imp });
    await rt.close();
    rt = logged(opts.runtime({ ...recipe, onExec: runLog.exec }));
    earlier = await earlierBuilder();
    if (earlier === "blocked") return { code: 1 };
  }
  const question = bootQuestion(recipe, opts.pricing);
  const ready = readyLine(manifest, ticks, choices, uploadBytes, brew, buildTakes(lastBuild), customRows(catalogRecipe));
  const { attach, stop } = earlier;
  // A golden built from a recipe takes the delta instead of a rebuild, unless the person picks the rebuild; a
  // builder already carrying this recipe is attached to instead, since the update would bill beside it.
  const current = attach === undefined ? await rt.golden.recipe(GOLDEN_NAME) : undefined;
  if (current !== undefined) {
    const road = await updateRoad({ rt, current, imp, bring, rows: manifest.entries, importOf, lastBuild, interactive, yes: opts.yes, input: io.input, output: io.output, stream: (words, run) => streamStages(rt, io, words, run, runLog.note) });
    if (road !== "rebuild") {
      if (road === 0 && landed !== undefined) log.info(installsTally(landed, resultsPath).join("\n"), out);
      if (road === 0) await retentionOffer({ rt, interactive, yes: opts.yes, input: io.input, output: io.output });
      return { code: road };
    }
  }
  if (stop.length > 0) {
    listEarlier(stop, attach);
    const then = attach !== undefined ? `attach to your earlier builder ${describeBuilder(attach)}?` : `${question.charAt(0).toLowerCase()}${question.slice(1)}`;
    const ask = `Stop ${stop.length === 1 ? "it" : "them"}, then ${then}`;
    if (interactive) {
      const go = await confirmPrompt({ message: ask, hint: "No costs nothing; nothing is stopped and the recipe is kept.", input: io.input, output: io.output });
      if (isCancel(go) || !go) {
        cancel("Nothing was booted or stopped. The recipe is kept.", out);
        return { code: 1 };
      }
    } else {
      log.step(`${ask} Taken as yes (${takenAs}).`, out);
    }
    for (const b of stop) {
      try {
        await rt.golden.kill(b.id);
      } catch (e) {
        log.error(`Stopping ${b.name} (${b.id}) failed: ${e instanceof Error ? e.message : String(e)}`, out);
        cancel(`Nothing was booted. ${b.name} (${b.id}) is still running; run wsp init again to retry.`, out);
        return { code: 1 };
      }
      log.step(`Stopped ${b.name} (${b.id}).`, out);
    }
  }
  if (attach !== undefined) {
    log.step(`Attaching to your earlier builder: ${describeBuilder(attach)}. Nothing new boots; stages already applied are skipped.`, out);
  } else if (stop.length === 0 && interactive) {
    // Enter takes the defaults the five screens showed, so a run that changes nothing is six keypresses.
    const go = await confirmPrompt({ message: `${ready}\n${question}`, hint: "No costs nothing and keeps the recipe for wsp init --recipe.", initialValue: true, input: io.input, output: io.output });
    if (isCancel(go) || !go) {
      cancel("Nothing was booted. The recipe is kept.", out);
      return { code: 1 };
    }
  } else if (stop.length === 0) {
    log.step(`${question} Taken as yes (${takenAs}).`, out);
  }
  if (attach === undefined) await stopKeptBuilder(rt, io.output);

  const stream = new StageStream(io.output, io.isTTY, PREPARE_STEPS, runLog.note, io.stderr);
  const off = rt.events.on("golden.stage", e => {
    if (e.type === "golden.stage") stream.push({ type: "golden.stage", name: e.name, stage: e.stage, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
  });
  const retry = opts.retry ?? DEFAULT_RETRY;
  stream.start();
  // From here a machine may be billing. The first signal ends the stage in flight and the builder with it; the
  // handler comes off with the builder, and once init returns the host's own handler has the signals.
  const halt = new AbortController();
  let signalled: "SIGINT" | "SIGTERM" | undefined;
  let frozen: StageView | undefined;
  let waiting = false;
  // The stop's own line, once it has one; a signal after that repeats the truth instead of guessing at the record.
  let finalLine: string | undefined;
  const cutShort = async (code: number): Promise<void> => {
    // Every other builder of this name was stopped or refused before the boot, so the one left is this run's.
    // The exit is the point here; a record that cannot be read gets the no-record line rather than no exit.
    const known = await rt.golden.builders().catch((): GoldenBuilderView[] => []);
    const id = known.find(b => b.name === GOLDEN_NAME && b.foreignOwner === undefined && b.heldBy === undefined)?.id;
    cancel(id !== undefined ? `Stopping was cut short. Builder ${id} may still be running; ${SWEEP}` : "Stopping was cut short. No machine is recorded yet; one the create still returns wears this setup's label, and the next wsp start sweeps it.", out);
    io.exit(code);
  };
  const onSignal = (sig: "SIGINT" | "SIGTERM"): void => {
    if (signalled !== undefined) {
      if (finalLine !== undefined) {
        cancel(finalLine, out);
        io.exit(exitCodeOf(sig));
        return;
      }
      // Out before the kill lands: the record keeps this pid, which the next start reads as dead and sweeps.
      void cutShort(exitCodeOf(sig));
      return;
    }
    signalled = sig;
    frozen = stream.stop(true);
    off();
    halt.abort();
  };
  const onInt = (): void => onSignal("SIGINT");
  const onTerm = (): void => onSignal("SIGTERM");
  const stopped = async (e: unknown, sig: "SIGINT" | "SIGTERM"): Promise<InitResult> => {
    const at = frozen?.steps.find(s => s.state === "current")?.start;
    // Once the signal is in, prepare answers with the stop; anything else here is a refusal from before a machine existed.
    const had = e instanceof PrepareStoppedError && e.builderId !== undefined;
    const where = waiting ? "while waiting for a machine slot" : at !== undefined ? `while ${at.charAt(0).toLowerCase()}${at.slice(1)}` : had ? "between stages" : "before anything booted";
    const line =
      e instanceof PrepareStoppedError && e.builderId !== undefined
        ? e.kept
          ? `Stopped ${where}. Your earlier builder ${attach?.name ?? GOLDEN_NAME} (${e.builderId}) was not stopped: it has a first life worth keeping and stays up at about $${opts.pricing.rateUsdPerHour(attach?.size ?? opts.pricing.defaultSize).toFixed(2)}/hr. wsp init --recipe ${small.path} attaches to it again; the sweep stops it once it is six hours old.`
          : e.left === undefined
            ? `Stopped ${where}. Builder ${e.builderId} is gone; nothing is billing.`
            : `Stopped ${where}. Builder ${e.builderId} did not stop (${e.left}); ${SWEEP}`
        : `Stopped ${where}. Nothing was booted; nothing is billing.`;
    finalLine = line;
    cancel(line, out);
    await closeRuntime();
    const code = exitCodeOf(sig);
    io.exit(code);
    return { code };
  };
  io.signals.on("SIGINT", onInt);
  io.signals.on("SIGTERM", onTerm);
  let builder: GoldenBuilderView;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        builder = await rt.golden.prepare({ name: GOLDEN_NAME, signal: halt.signal });
        break;
      } catch (e) {
        if (halt.signal.aborted || !isCapRefusal(e) || attempt + 1 >= retry.attempts) throw e;
        stream.note(`Solari account at its machine cap; waiting ${Math.round(retry.waitMs / 1000)}s for a slot (${attempt + 1}/${retry.attempts}). Nothing is killed.`);
        waiting = true;
        await sleep(retry.waitMs, halt.signal);
        if (halt.signal.aborted) throw e;
        waiting = false;
      }
    }
  } catch (e) {
    // Awaited so the listeners stay on through the line, the close and the exit: a second signal there still answers.
    if (signalled !== undefined) return await stopped(e, signalled);
    const view = stream.stop();
    off();
    const message = e instanceof Error ? e.message : String(e);
    runLog.note(`failed: ${message}`);
    if (view.failure === undefined) log.error(message, out);
    // A failed frame means a machine existed and prepare killed it; without one the create itself refused.
    log.step(logLine(), out);
    outro(`${view.failure !== undefined ? "That machine is gone." : "Nothing was booted."} Run wsp init again to start over; the recipe is kept.`, out);
    return { code: 1 };
  } finally {
    io.signals.off("SIGINT", onInt);
    io.signals.off("SIGTERM", onTerm);
  }
  const prepared = stream.stop();
  off();
  if (landed !== undefined) log.info(installsTally(landed, resultsPath).join("\n"), out);

  const flow: SignInFlow = { armed: false };
  const relay = await opts.relay(rt, builder, flowHooks(flow, builder));
  const dial = (): Promise<BuilderLink> => (opts.daemon ?? builderLink)(rt, builder);
  // Secrets first: a key cut from an rc file is on the machine before any status check looks for it.
  // Nobody is here to type: the flag that said so when there was a terminal, else the terminal that is missing.
  const nobodyAsks = !io.isTTY ? "no terminal to paste into" : opts.yes ? "--yes asks nothing" : "--non-interactive asks nothing";
  const skipSecretsWhy = interactive ? undefined : `${nobodyAsks}; set them from the app's terminal`;
  const secretOutcomes = await secretsStage({
    asks: [...(landed?.files?.cut ?? []).flatMap(c => c.names.map(name => ({ name, from: `cut from ${c.path}` }))), ...keyAsks(offered, choices)],
    dial,
    input: io.input,
    output: io.output,
    ...(skipSecretsWhy !== undefined ? { skipWhy: skipSecretsWhy } : {}),
    hide: value => runLog.hide(value),
  });
  // Only --yes gets here: every other run without a terminal hands its sign-ins over instead of skipping them.
  const skipWhy = interactive || handoff ? undefined : io.isTTY ? "--yes asks nothing; sign in from the app's terminal" : "no terminal to sign in from; use the app's terminal";
  const staged = stageLogins(offered, choices, ticks);
  // The pack's notes on a copied login's Keychain and helper items join what its reads left behind, once each.
  for (const s of landed?.files?.skipped ?? []) {
    if (!/^(keychain|helper):/i.test(s.path) || !staged.some(e => e.id === s.id && e.choice === "copy")) continue;
    const have = left.get(s.id);
    if (have === undefined) left.set(s.id, s.note);
    else if (!have.includes(s.note)) left.set(s.id, `${have}; ${s.note}`);
  }
  const outcomes = handoff
    ? await handoffStage({
        logins: staged,
        left,
        dial,
        output: io.output,
        platform: opts.platform,
        flow,
        ...(io.json !== undefined ? { json: io.json } : {}),
      })
    : await signInStage({
        logins: staged,
        left,
        dial,
        terminal: { input: io.input, output: io.output },
        ...(skipWhy !== undefined ? { skipWhy } : {}),
        open: url => io.open(url),
        flow,
      });
  if (noteOutcomes(resultsPath, { logins: outcomes, secrets: secretOutcomes }).replaced) log.warn(`${resultsPath} could not be read; it was rewritten with the logins and secrets alone.`, out);
  // The relay's work ends with the sign-ins; the host that serves the app after the seal links to the workspaces itself.
  await relay.close().catch((e: unknown) => log.error(`relay close failed: ${e instanceof Error ? e.message : String(e)}`, out));

  const next = ((await rt.golden.get())?.head ?? 0) + 1;
  card(`Ready to seal golden v${next}`, sealSummary(landed, outcomes, secretOutcomes, widthOf(io.output)), io.output);
  const result: InitResult = { code: 0, logins: outcomes, secrets: secretOutcomes };
  if (interactive) {
    const go = await confirmPrompt({ message: `Seal this machine as golden v${next}?`, hint: "Enter seals: a snapshot, then a fork to prove it. No leaves the machine up.", initialValue: true, input: io.input, output: io.output });
    if (isCancel(go) || !go) {
      cancel(`Nothing was sealed. Builder ${builder.id} stays up at about $${opts.pricing.rateUsdPerHour(builder.size).toFixed(2)}/hr; wsp init --recipe ${small.path} attaches to it again, and the sweep stops it once it is six hours old.`, out);
      await closeRuntime();
      return { ...result, code: 1 };
    }
  } else {
    log.step(`Sealing golden v${next}. Taken as yes (${takenAs}).`, out);
  }
  let sealed: Awaited<ReturnType<Runtime["golden"]["seal"]>> | undefined;
  let error: unknown;
  const logins = outcomes.map(r => ({ name: r.label, state: r.state }));
  // A kept builder needs a process to end its window: the host this run leaves serving. With none, the builder goes with the seal.
  const view = await streamStages(rt, io, SEAL_STEPS, () => rt.golden.seal(builder.id, { logins, keepBuilder: serves }).then(r => (sealed = r), e => (error = e)), runLog.note);
  if (sealed === undefined) {
    const message = error instanceof Error ? error.message : String(error);
    runLog.note(`failed: ${message}`);
    if (view.failure === undefined) log.error(message, out);
    log.step(logLine(), out);
    outro("Seal failed and the builder is gone. Run wsp init again; the recipe is kept.", out);
    await closeRuntime();
    return { ...result, code: 1 };
  }
  const measured = buildTimes([prepared, view], new Date());
  if (measured !== undefined) noteOutcomes(resultsPath, { build: measured });
  const version = sealed.version.version;
  const kept = keptBuilder(await rt.golden.builders(), version);
  log.success(
    [
      `Golden v${version} sealed.`,
      ...(kept !== undefined ? [dim(`The builder stays up ten minutes (about $${opts.pricing.rateUsdPerHour(kept.size).toFixed(2)}/h, one of the account's machine slots) for one more change: stop wsp, run wsp init, and the golden updates on it.`)] : []),
    ].join("\n"),
    out,
  );

  if (version > 1) await retentionOffer({ rt, interactive, yes: opts.yes, input: io.input, output: io.output });

  // The golden is on the account and in the state file by here: nothing under this line can lose it, and a run with
  // nobody at a terminal has no app to serve, so it ends with the golden recorded and says what starts the app.
  let handle: HostHandle | undefined;
  if (serves) {
    try {
      handle = await opts.host(rt);
    } catch (e) {
      log.error(e instanceof Error ? e.message : String(e), out);
      log.step(logLine(), out);
      outro(`Golden v${version} is sealed and recorded. The app did not start; fix that and run ${opts.upCommand}, with --port and --ws-port when a port is taken.`, out);
      await closeRuntime();
      return { ...result, code: 1 };
    }
  }
  const roads: WorkspaceRoads = handle ?? opts.roads(rt);
  // Only the first seal ever offers a workspace; a rebuild leaves the existing ones on the version they came from.
  const existing = await rt.workspaces.list();
  let first: FirstResult | undefined;
  if (existing.length > 0) {
    log.step(`Your ${existing.length} workspace${existing.length === 1 ? " stays" : "s stay"} on the golden version ${existing.length === 1 ? "it was" : "they were"} forked from; upgrade ${existing.length === 1 ? "it" : "them"} from the app. New workspaces fork v${version}.`, out);
  } else {
    const ask = await askFirst({
      interactive,
      unattended: !serves,
      ...(opts.firstWorkspace !== undefined ? { name: opts.firstWorkspace } : {}),
      ...(opts.importFolder !== undefined ? { folder: opts.importFolder } : {}),
      input: io.input,
      output: io.output,
    });
    // No and esc both end with nothing forked; neither unwinds the seal, which is already on the account by here.
    if (isCancel(ask) || ask === undefined) {
      if (handle !== undefined) log.step(DONE_LINE, out);
    } else {
      first = await runFirst({ first: ask, handle: roads, goldenVersion: version, output: io.output, spin: label => spin(io.output, label, io.isTTY) });
    }
  }
  if (handle === undefined) {
    io.json?.({
      event: "done",
      golden: GOLDEN_NAME,
      version,
      snapshotId: sealed.version.snapshotId,
      recipe: small.path,
      nextCommand: opts.upCommand,
      ...(first !== undefined ? { workspace: { id: first.workspace.id, name: first.workspace.name } } : { forkCommand: opts.forkCommand }),
    });
    log.step(logLine(), out);
    outro(`Done. Golden v${version} is sealed; ${opts.upCommand} starts the app${first === undefined ? `, and ${opts.forkCommand} forks a workspace from it` : ""}.`, out);
    await closeRuntime();
    return result;
  }
  const url = appUrl(handle.port, first?.workspace.id);
  runLog.note(`app ${url}`);
  await openApp(url, handle, io, interactive, logLine(), out);
  outro("wsp keeps serving the app from this terminal; Ctrl-C stops it.", out);
  return { ...result, handle };
}

/** One stage stream around one runtime call; the frames it draws are the golden's, whatever the call. */
export async function streamStages(rt: Pick<Runtime, "events">, io: Pick<InitIO, "output" | "stderr" | "isTTY">, words: readonly StageWords[], run: () => Promise<unknown>, sink: (line: string) => void): Promise<StageView> {
  const stream = new StageStream(io.output, io.isTTY, words, sink, io.stderr);
  const off = rt.events.on("golden.stage", e => {
    if (e.type === "golden.stage") stream.push({ type: "golden.stage", name: e.name, stage: e.stage, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
  });
  stream.start();
  let view!: StageView;
  // The stop sits in the finally so a run that rejects still hands the console back and settles the block.
  try {
    await run();
  } finally {
    off();
    view = stream.stop();
  }
  return view;
}

/** The tally after the build: how the tools, agents and the machine context came out, each failure named with its
 * reason, and where the list is. */
function installsTally(landed: ImportResult, resultsPath: string): string[] {
  const all = [...landed.tools.map(t => ({ ...t, name: t.label })), ...landed.agents];
  const n = (o: string) => all.filter(x => x.outcome === o).length;
  // The header counts tools, editors, agents, a machine context that was not written, and the rows this run took
  // out of the recipe, whatever their rung: a retired dotfile is counted here too.
  const retired = landed.retired ?? [];
  const failed = n("failed") + (landed.contextFailure === undefined ? 0 : 1);
  return [
    `Tools, agents and machine context: ${n("installed")} installed, ${retired.length > 0 ? `${retired.length} retired, ` : ""}${failed} failed, ${n("skipped")} skipped; the list is in ${resultsPath}`,
    ...all.filter(x => x.outcome === "failed").map(x => dim(`${x.name} failed: ${x.note ?? "no reason given"}`)),
    ...(landed.contextFailure === undefined ? [] : [dim(`machine context failed: ${landed.contextFailure}`)]),
    ...all.filter(x => x.outcome === "skipped").map(x => dim(`${x.name} skipped: ${x.note ?? "no reason given"}`)),
    ...retired.map(x => dim(`${x.name} retired: out of the recipe, left on the image`)),
  ];
}

/** What the machine holds before the seal: the tools and agents as the import counted them, each sign-in
 * with its state, each cut secret with its state. */
function sealSummary(landed: ImportResult | undefined, logins: readonly LoginOutcome[], secrets: readonly SecretOutcome[], width: number): string[] {
  const inner = width - CARD_FRAME;
  const tools = landed?.tools ?? [];
  const agents = landed?.agents ?? [];
  const count = (rows: readonly { outcome: string }[]): string => {
    const n = (o: string) => rows.filter(x => x.outcome === o).length;
    return rows.length === 0 ? "none" : [`${n("installed")} installed`, ...(n("failed") > 0 ? [`${n("failed")} failed`] : []), ...(n("skipped") > 0 ? [`${n("skipped")} skipped`] : [])].join(", ");
  };
  const states = (rows: readonly string[][]): string[] => (rows.length === 0 ? ["none"] : table(rows));
  const loginRows = logins.map(r => [r.label, r.state.replace(/-/g, " ")]);
  const secretRows = secrets.map(r => [r.name, r.state === "set" ? `set on the machine${r.note !== undefined ? ` (${r.note})` : ""}` : r.state === "failed" ? `not set${r.note !== undefined ? ` (${r.note})` : ""}` : `skipped${r.note !== undefined ? ` (${r.note})` : ""}`]);
  const section = (title: string, lines: readonly string[]): string[] => [title, ...lines.flatMap(l => wrap(`  ${l}`, inner, "    "))];
  const installed = agents.filter(a => a.outcome === "installed").map(a => a.name);
  return [
    ...section("Tools", [count(tools)]),
    ...section("Agents", [agents.length === 0 ? "none" : `${count(agents)}${installed.length > 0 ? `: ${installed.join(", ")}` : ""}`]),
    ...section("Sign-ins", states(loginRows)),
    ...section("Secrets", states(secretRows)),
  ];
}

/** The app's address once the golden is sealed: opened here on a terminal the person is at, printed (with the ssh
 * forward when the address is remote) under --yes or over ssh. */
async function openApp(url: string, handle: HostHandle, io: InitIO, interactive: boolean, logLine: string, out: { output: Writable }): Promise<void> {
  if (!interactive || overSsh(io.env)) {
    const lines = [`Open ${url}`];
    if (overSsh(io.env)) lines.push(dim(`loopback address; forward it first: ssh -L ${handle.port}:127.0.0.1:${handle.port} <this host>`));
    lines.push(logLine);
    log.step(lines.join("\n"), out);
    return;
  }
  const opened = await io.open(url);
  log.step([`${opened ? "Opened" : "Open"} ${url}`, logLine].join("\n"), out);
}
