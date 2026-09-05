// SPDX-License-Identifier: AGPL-3.0-only
// wsp init: read this machine, let the person tick what comes along one rung
// at a time, confirm once, build the golden's first machine through the
// runtime, run the sign-ins chosen for the machine in this terminal, set the
// secrets the pack cut, seal on Enter, fork the first workspace and open the
// app on it. Nothing leaves the disk before the confirm, and no question is
// ever asked on the remote machine.
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters, styleText } from "node:util";
import { APP_DATA_GROUP, LARGE_GROUP, MCP_REMOTE_ID, RUNGS, type LoginChoice, type Manifest, type ManifestEntry, type Rung } from "@wsp/collect";
import { describeAge, type BackendPricing } from "@wsp/engine";
import { MCP_ID_PREFIX } from "@wsp/protocol";
import { PrepareStoppedError, type GoldenBuilderView, type GoldenRecipe, type GoldenStage, type Runtime } from "@wsp/runtime";
import { S_BAR, S_STEP_CANCEL, S_STEP_ERROR, S_STEP_SUBMIT, cancel, isCancel, log, outro } from "@clack/prompts";
import type { Keys } from "./cli.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BREW_TOOLCHAIN_BYTES, BUILDER_DISK_GB, MEASURED_ON, PACK_BUDGET_BYTES, TOOLS_DISK_FLOOR, agentInstallsFor, agentSize, assumedSize, brewfileFor, caskPinState, cliRoad, editorInstallsFor, estimateDisk, extensionsFile, linuxCaskFor, pinState, remoteEditorFor, remoteSettingsPath, toolInstallsFor, toolSize, type BrewTable, type DiskEstimate, type ImportResult, type ToolSize } from "@wsp/engine";
import { ALREADY_APPLIED } from "@wsp/protocol";
import { CLAUDE_INSTALLER, importFor, importResultPath, keychainLogins, readSecrets, statOf, type SecretReader } from "./init-import.js";
import {
  CONSENT_CHOICES,
  LOGIN_CHOICES,
  RUNG_TITLE,
  agentName,
  goldenRecipeFor,
  hasChoices,
  initialChoice,
  initialTicks,
  isLoginChoice,
  isTickable,
  linuxCaskRows,
  loadManifest,
  lockRefused,
  loginShown,
  loginTool,
  recipeChanges,
  recipePath,
  saveRecipe,
  tickLoginTools,
  withoutAgentTools,
} from "./init-recipe.js";
import { CARD_FRAME, GUTTER, card, confirmPrompt, ellipsize, fmtDuration, isTTY, plainLine, rowsOf, table, widthOf, wrap } from "./init-layout.js";
import { openRunLog, runLogPath } from "./init-log.js";
import { secretsStage, type SecretOutcome } from "./init-secrets.js";
import { keptBuilder, stopKeptBuilder, updateRoad } from "./init-upgrade.js";
import { retentionOffer } from "./storage.js";
import { rungSelect, type FooterLine, type RungSelectOptions, type SelectItem, type Tone } from "./init-select.js";
import { DISK_HOLD_SHARE, HEAVY_BYTES, diskTone, weighed, weightTone } from "./init-weight.js";
import { builderLink, flowHooks, noteOutcomes, signInStage, stageLogins, type BuilderLink, type HostHooks, type LoginOutcome, type SignInFlow } from "./init-signin.js";
import type { HostHandle } from "./server.js";

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
}

export interface InitOptions {
  /** Take every default and skip every prompt, the confirm included. */
  yes: boolean;
  /** A collector manifest or a saved recipe to tick from instead of reading this machine. */
  manifestPath?: string;
  /** Reads this computer, telling onRung how many rows each rung found as it finishes and onNote what could not be read. */
  collect(onRung: (rung: Rung, rows: number) => void, onNote: (note: string) => void): Promise<Manifest>;
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
  /** Builds the runtime around the recipe the ticks produced. */
  runtime(recipe: GoldenRecipe): Runtime;
  /** Starts the app server over that runtime once the builder is ready; its callback relay links to the builder
   * for the sign-ins, and the browser opens on it once the golden is sealed. The hooks wire the sign-in stage in. */
  host(rt: Runtime, builder: GoldenBuilderView, hooks: HostHooks): Promise<HostHandle>;
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
const FIRST_WORKSPACE = "first";
const DEFAULT_RETRY = { waitMs: 30_000, attempts: 20 };
/** What ends a builder this run could not: a record its dead holder left is stale to the next start, which stops it. */
const SWEEP = "the next wsp or wsp init on this computer stops it, or stop it from the Solari console.";
const dim = (s: string): string => styleText("dim", s);

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

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
  { stage: "deploying-daemon", start: "Installing the base (Node, the daemon)", end: "Base installed", fail: "Installing the base failed" },
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

/** Anthropic forbids a host to collect or pass along the OAuth credential, which is why that login is signed in on the machine unless the person opts in; an API key is the person's own to set. */
const CLAUDE_LOGIN_WHY = "Anthropic's terms forbid passing the OAuth credential along, so with it alone the default is to sign in on the machine.";
/** What the answers on a login row do, and on a credential-shaped row. */
const LOGIN_WHY = "copy brings it along; sign in does it in this terminal after the build";
const CONSENT_WHY = "copy brings it along; skip leaves it here";
const TICKED_FOR_LOGINS = "ticked under Tools for the sign-ins: ";
const EVERYTHING_FOOTER = ["large items are listed but never copied without a tick", "know what one of these is? add it to the catalog"];
/** Names as a list: "a", "a and b", "a, b and c". */
function listed(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What the Editors screen is for, under its title: one line for the terminal editors it holds, one for the remote
 * editors' rows; a line whose rows are not on the screen is left out. */
export function editorsIntro(entries: readonly ManifestEntry[]): string[] {
  const terminal = entries.filter(e => remoteEditorFor(e.id) === undefined && editorInstallsFor([{ ...e, bring: true }]).installs.length > 0);
  const names = terminal.map(e => editorInstallsFor([{ ...e, bring: true }]).installs[0]!.label);
  const remote = [...new Set(entries.map(e => remoteEditorFor(e.id)?.name).filter((n): n is string => n !== undefined))];
  const config = terminal.every(e => e.paths.length > 0) ? " with your config" : terminal.some(e => e.paths.length > 0) ? " with the config found here" : "";
  const one = names.length === 1;
  return [
    ...(names.length > 0 ? [`${listed(names)} ${one ? "is" : "are"} installed on the machine${config}; ${one ? "it runs" : "they run"} in the workspace's terminal.`] : []),
    ...(remote.length > 0 ? [`${listed(remote)} rows are settings and extension names, used only if you open this machine from your editor over SSH; nothing runs here.`] : []),
  ];
}

/** How a ticked editors row reaches the machine, for its detail line; nothing for a row the import has no step for. */
function editorWhy(e: ManifestEntry): string | undefined {
  const remote = remoteEditorFor(e.id);
  if (remote !== undefined) {
    if (e.paths.length > 0) return `lands at ~/${remoteSettingsPath(remote.dir)}, read only when ${remote.name} opens this machine over SSH; nothing runs here`;
    return `then, in ${remote.name}'s terminal on the machine: xargs -n1 ${remote.cli} --install-extension < ~/${extensionsFile(remote.dir)}`;
  }
  const step = editorInstallsFor([{ ...e, bring: true }]).installs[0];
  if (step === undefined) return undefined;
  const how = step.manager === "release" ? "from its pinned release" : "by apt";
  return `installed on the machine ${how}${e.paths.length > 0 ? "; your config comes along" : ""}`;
}

const isMcpRow = (e: ManifestEntry): boolean => e.rung === "agents" && e.id.startsWith(MCP_ID_PREFIX);
const roadWords = (size: ToolSize): string => (size.road === "measured" ? `measured on Linux ${MEASURED_ON}` : "from this Mac's Homebrew");
const depsWords = (size: ToolSize): string => (size.deps === 0 ? "" : ` with ${size.deps} dependenc${size.deps === 1 ? "y" : "ies"}`);

/** A row nothing measured counts at its kind's default, and the detail says so. */
function assumedWords(e: ManifestEntry): string {
  const assumed = assumedSize(e);
  return `not measured, ~${fmtBytes(assumed.bytes)} assumed for ${assumed.kind}`;
}

/** Where a tool's number came from, for the detail pane. */
function sizeWhy(e: ManifestEntry, brew: BrewTable): string {
  const size = toolSize(e, brew);
  return size === undefined ? assumedWords(e) : `about ${fmtBytes(size.bytes)}${depsWords(size)}, ${roadWords(size)}`;
}

/** A formula's second detail line: why it starts unticked when it does, then its size and where the number came from. */
function toolWhy(e: ManifestEntry, brew: BrewTable): string {
  const cask = linuxCaskFor(e.id);
  if (cask !== undefined) return cask.detail;
  const unknown = e.linux === "unknown" ? "Linux build unknown, tick to try; " : "";
  if (e.id.startsWith("tools/cli/")) {
    const go = e.paths.length > 1;
    return `${unknown}its Linux release binary${go ? ", else go install of the module" : ""}; ${assumedWords(e)}${go ? " since the fallback fills go's caches" : ""}; checksum recorded on first install; ${e.default === "bring" ? "brought by default" : "left out by default"}`;
  }
  if (e.linux === "unknown") return `${unknown}${sizeWhy(e, brew)}`;
  const size = toolSize(e, brew);
  if (size !== undefined && size.bytes >= HEAVY_BYTES) return `${fmtBytes(size.bytes)}${depsWords(size)}, tick to bring; ${roadWords(size)}`;
  return `${sizeWhy(e, brew)}; ${e.default === "bring" ? "brought by default" : "left out by default"}`;
}

/** The second detail line: why a row is locked, else what ticking it means. */
function detailWhy(e: ManifestEntry, lock: "on" | "off" | undefined, brew: BrewTable): string {
  if (lock === "off") return e.reason ?? "";
  if (lock === "on") return "always comes along";
  if (e.rung === "logins") {
    if (agentName(e) !== "claude") return LOGIN_WHY;
    // The OAuth credential is the row's one path that is not a helper; a row of API key sources has no such rule to explain.
    const oauth = e.paths.some(p => !/^helper:/i.test(p));
    return [e.detail, oauth ? CLAUDE_LOGIN_WHY : LOGIN_WHY].filter(x => x !== undefined).join("; ");
  }
  if (e.rung === "everything" || isMcpRow(e)) return e.detail ?? "";
  if (e.font !== undefined) return "the app's terminal draws with it when this computer has it installed; unticked, the app uses its own font";
  if (e.rung === "agents") {
    if (!hasInstaller(e)) return "its config comes along; no installer yet, install it there yourself";
    const size = agentSize(e);
    const config = e.bytes > 0 ? `its config (${fmtBytes(e.bytes)}) comes along` : "its config comes along";
    return `installs ${size === undefined ? `on the machine (${assumedWords(e)})` : `about ${fmtBytes(size)} on the machine (measured ${MEASURED_ON})`}; ${config}`;
  }
  const byDefault = e.default === "bring" ? "brought by default" : "left out by default";
  if (e.rung === "tools") return e.id.startsWith("tools/brew-tap/") ? `its formula list, a few MB; the formulae carry the size; ${byDefault}` : toolWhy(e, brew);
  const size = e.bytes > 0 ? `${fmtBytes(e.bytes)}, ` : "";
  const editor = e.rung === "editors" ? editorWhy(e) : undefined;
  return `${size}${editor ?? byDefault}`;
}

/** The first detail line of a row without a path: what stands in for the copy. */
function whereNothing(e: ManifestEntry): string {
  const remote = e.rung === "editors" ? remoteEditorFor(e.id) : undefined;
  if (remote !== undefined) return `listed in ~/${extensionsFile(remote.dir)} on the machine; nothing installs until you connect`;
  if (isMcpRow(e)) return "defined in the agent's config, which travels with the agent's row";
  if (e.font !== undefined) return "read from your terminal's config; nothing to copy";
  if (e.rung === "logins") return "nothing to copy; copy checks the login on the machine";
  return e.rung === "everything" || e.rung === "editors" ? "nothing to copy" : "reinstalled on the machine";
}

const hasInstaller = (e: ManifestEntry): boolean => agentInstallsFor([{ ...e, bring: true }], { claude: CLAUDE_INSTALLER }).installs.length > 0;

/** What a tools or agents row puts on the machine, when something measured it; an agent nothing installs weighs what travels. */
function installBytes(e: ManifestEntry, brew: BrewTable): number | undefined {
  if (e.rung === "agents") return hasInstaller(e) ? agentSize(e) : e.bytes > 0 ? e.bytes : undefined;
  return e.id.startsWith("tools/brew-tap/") ? undefined : toolSize(e, brew)?.bytes;
}

/** A row nothing measured counts at its kind's default; the tilde marks the number as assumed. */
const assumedHint = (e: ManifestEntry): string => `~${fmtBytes(assumedSize(e).bytes)}`;

/** The second column of a tools or agents row: its weight on the machine, marked when assumed; nothing for a tap or an agent that only travels. */
function installHint(e: ManifestEntry, brew: BrewTable): string | undefined {
  const cask = linuxCaskFor(e.id);
  if (cask !== undefined) return cask.from;
  const bytes = installBytes(e, brew);
  if (bytes !== undefined) return fmtBytes(bytes);
  return e.id.startsWith("tools/brew-tap/") || (e.rung === "agents" && !hasInstaller(e)) ? undefined : assumedHint(e);
}

export function selectItem(e: ManifestEntry, hintFor?: (width: number) => string, brew: BrewTable = new Map()): SelectItem {
  const minus = e.excludes !== undefined && e.excludes.length > 0 ? ` minus ${e.excludes.join(", ")}` : "";
  const where = e.paths.length > 0 ? `${e.paths.join(", ")}${minus}` : whereNothing(e);
  const lock = e.required ? "on" : !isTickable(e) ? "off" : undefined;
  const installs = e.rung === "tools" || e.rung === "agents";
  const hint = installs ? installHint(e, brew) : e.bytes > 0 && e.rung !== "logins" ? fmtBytes(e.bytes) : undefined;
  const tone = installs ? weightTone(installBytes(e, brew) ?? (hint === undefined ? 0 : assumedSize(e).bytes)) : undefined;
  // A path-shaped app data label is the row's ~/Library parent, a slash, then its name; the parent goes dim. A carve's worded label stays whole.
  const parent = e.group === APP_DATA_GROUP && e.paths[0] === `~/Library/${e.label}` ? e.label.slice(0, e.label.indexOf("/") + 1) : "";
  return {
    id: e.id,
    label: e.label,
    ...(hintFor !== undefined ? { hintFor } : hint !== undefined ? { hint } : {}),
    ...(tone !== undefined ? { tone } : {}),
    ...(e.group !== undefined ? { group: e.group } : {}),
    detail: [where, detailWhy(e, lock, brew), ...(e.consent === true && lock === undefined ? [CONSENT_WHY] : [])],
    ...(lock !== undefined ? { lock } : {}),
    ...(hasChoices(e) ? { choices: e.rung === "logins" ? LOGIN_CHOICES : CONSENT_CHOICES } : {}),
    ...(e.group === LARGE_GROUP || e.group === APP_DATA_GROUP ? { own: true } : {}),
    ...(parent !== "" ? { prefix: parent } : {}),
  };
}

const TOOLCHAIN_ROW = "tools/homebrew-toolchain";
const asBring = (entries: readonly ManifestEntry[]): ManifestEntry[] => entries.map(e => ({ ...e, bring: true }));

/** The Tools screen's rows: a size beside each, and Homebrew's own toolchain as one line at the top of the
 * Homebrew group, ticked whenever the ticks would put Homebrew on the machine. */
export function toolsItems(entries: readonly ManifestEntry[], brew: BrewTable): SelectItem[] {
  const items = entries.map(e => selectItem(e, undefined, brew));
  const canBrew = entries.some(e => e.id.startsWith("tools/brew/") || e.id.startsWith("tools/brew-tap/") || /^tools\/(pnpm|bun|cargo|go|pipx)\//.test(e.id));
  if (!canBrew) return items;
  const group = entries.find(e => e.id.startsWith("tools/brew/") && e.group !== undefined)?.group;
  const tone = weightTone(BREW_TOOLCHAIN_BYTES);
  const toolchain: SelectItem = {
    id: TOOLCHAIN_ROW,
    label: "Homebrew's toolchain (glibc, gcc)",
    hint: fmtBytes(BREW_TOOLCHAIN_BYTES),
    ...(group !== undefined ? { group } : {}),
    ...(tone !== undefined ? { tone } : {}),
    detail: ["pulled in by the first Homebrew formula; Linux bottles are built against Homebrew's own glibc", `about ${fmtBytes(BREW_TOOLCHAIN_BYTES)}, measured on Linux ${MEASURED_ON}`],
    follows: ticks => toolInstallsFor(asBring(entries.filter(e => ticks.has(e.id))), brew).installs.some(t => t.id === "tools/homebrew"),
  };
  const at = group === undefined ? 0 : items.findIndex(i => i.group === group);
  items.splice(at < 0 ? 0 : at, 0, toolchain);
  return items;
}

/** The Sign-ins screen's rows: a login whose command is not coming says so in its column, and its detail says why and what brings it. */
export function loginItems(entries: readonly ManifestEntry[], manifest: Manifest, coming: ReadonlySet<string>, brew: BrewTable): SelectItem[] {
  return entries.map(e => {
    const item = selectItem(e, undefined, brew);
    const tool = loginTool(e, manifest, coming);
    if (tool === undefined || tool.coming) return item;
    return { ...item, hint: `${tool.bin} not coming`, detail: [item.detail[0] ?? "", tool.why ?? ""] };
  });
}

/** The estimate's parts that are not zero, and how many rows have no size. */
function diskParts(est: DiskEstimate): string {
  const parts = ([["files", est.files], ["Homebrew's toolchain", est.toolchain], ["tools", est.tools], ["agents", est.agents]] as const).filter(([, n]) => n > 0).map(([label, n]) => `${label} ${fmtBytes(n)}`);
  const unknown = est.unknown.length > 0 ? `${est.unknown.length} unmeasured, ~${fmtBytes(est.assumed)}` : "";
  return [parts.join(", "), unknown].filter(p => p !== "").join("; ");
}

/** The total against the room the builder's disk leaves. */
function diskHead(est: DiskEstimate): string {
  return est.over > 0 ? `${fmtBytes(est.total)}, ${fmtBytes(est.over)} over the ${fmtBytes(est.room)} the ${BUILDER_DISK_GB} GB builder leaves` : `${fmtBytes(est.total)} of ${fmtBytes(est.room)} on the ${BUILDER_DISK_GB} GB builder`;
}

/** The summary's line: the total, then the parts in brackets. */
export function diskLine(est: DiskEstimate): string {
  const parts = diskParts(est);
  return parts === "" ? diskHead(est) : `${diskHead(est)} (${parts})`;
}

/** The running total under a screen: the rows ticked on earlier screens plus this one's ticks. */
function diskUnder(earlier: readonly ManifestEntry[], entries: readonly ManifestEntry[], brew: BrewTable): (ticks: ReadonlySet<string>) => DiskEstimate {
  return ticks => {
    const rows = asBring([...earlier, ...entries.filter(e => ticks.has(e.id))]);
    return estimateDisk(rows, rows.reduce((n, e) => n + e.bytes, 0), brew);
  };
}

/** In the red tier the screen holds Enter, and the footer says what to do instead of the parts. */
const heldDisk = (est: DiskEstimate): boolean => diskTone(est.total, est.room) === "red";
const tooFull = (rung: Rung): string => `Too full to build. Untick ${rung} you do not need on the machine until the estimate leaves the red; keep headroom for what the build installs.`;

/** Under a screen: the parts of the running total, dim, then the Disk line loud in its weight's colour, directly above the
 * keys. As many slots as the way out takes wrapped at this width, every frame, so the screen does not move under a tick:
 * the parts wrapped over them and empty lines after, or, in the red tier, the whole sentence. */
function diskFooter(estimate: (ticks: ReadonlySet<string>) => DiskEstimate, rung: Rung): (ticks: ReadonlySet<string>, width: number) => FooterLine[] {
  return (ticks, width) => {
    const est = estimate(ticks);
    const tone = diskTone(est.total, est.room);
    const slots = wrap(tooFull(rung), width, "");
    const parts = wrap(diskParts(est), width, "").slice(0, slots.length);
    const head: FooterLine[] = heldDisk(est) ? slots.map(text => ({ text })) : [...parts, ...slots.slice(parts.length).map(() => "")];
    return [...head, { text: `Disk: ${diskHead(est)}`, ...(tone !== undefined ? { tone } : {}) }];
  };
}

/** The Tools and Agents screens' footer and hold, over one estimate of the ticks. */
function diskScreen(earlier: readonly ManifestEntry[], entries: readonly ManifestEntry[], brew: BrewTable, rung: Rung): Pick<RungSelectOptions, "footer" | "hold"> {
  const estimate = diskUnder(earlier, entries, brew);
  return { footer: diskFooter(estimate, rung), hold: ticks => heldDisk(estimate(ticks)) };
}

/** The day a file last changed, in this computer's own calendar. */
function localDay(ms: number): string {
  if (ms <= 0) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The everything rows with size, file count, last change and role guess as one aligned second
 * column, read from the terminal width every frame: under 100 columns only size and role, so the
 * label keeps its room. A row with nothing to copy shows its lock instead and does not widen the columns. */
export function everythingItems(entries: readonly ManifestEntry[]): SelectItem[] {
  const files = (n: number | undefined): string => (n === undefined || n === 0 ? "" : `${n} file${n === 1 ? "" : "s"}`);
  const shown = entries.filter(e => e.paths.length > 0);
  // A row the walk never entered has neither bytes nor files; a measured empty row still has a file.
  const size = (e: ManifestEntry): string => (e.bytes > 0 || (e.files ?? 0) > 0 ? fmtBytes(e.bytes) : "not measured");
  const cells = (e: ManifestEntry, wide: boolean): string[] => (wide ? [size(e), files(e.files), localDay(e.mtime ?? 0), e.role ?? ""] : [size(e), e.role ?? ""]);
  // table() trims each row's tail; one width for every hint keeps the size column in line whatever the role word's length.
  const hintsFor = (wide: boolean): Map<string, string> => {
    const hints = table(shown.map(e => cells(e, wide)), wide ? ["right", "right", "left", "left"] : ["right", "left"]);
    const span = Math.max(0, ...hints.map(h => h.length));
    return new Map(shown.map((e, i) => [e.id, hints[i]!.padEnd(span)]));
  };
  const byLayout = new Map<boolean, Map<string, string>>();
  const hintAt = (id: string, width: number): string => {
    const wide = width >= 100;
    const hints = byLayout.get(wide) ?? hintsFor(wide);
    byLayout.set(wide, hints);
    return hints.get(id) ?? "";
  };
  return entries.map(e => (e.paths.length > 0 ? selectItem(e, width => hintAt(e.id, width)) : selectItem(e)));
}

/** The size alone: the screen's one count is the all row's, over the rows that can come, as the found table put it. */
export function everythingTitle(entries: readonly ManifestEntry[]): string {
  return `${RUNG_TITLE.everything} (${fmtBytes(entries.reduce((n, e) => n + e.bytes, 0))})`;
}

/** Each group's size beside its count, so a folded group still says what it weighs. */
function everythingGroupHint(entries: readonly ManifestEntry[]): (group: string, items: readonly SelectItem[]) => string | undefined {
  const bytes = new Map(entries.map(e => [e.id, e.bytes]));
  return (_group, items) => {
    const n = items.reduce((sum, i) => sum + (bytes.get(i.id) ?? 0), 0);
    return n > 0 ? fmtBytes(n) : undefined;
  };
}

function everythingFooter(entries: readonly ManifestEntry[]): (ticks: ReadonlySet<string>) => string[] {
  return ticks => {
    const on = entries.filter(e => ticks.has(e.id));
    return [`${on.length} ticked${on.length > 0 ? `, ${fmtBytes(on.reduce((n, e) => n + e.bytes, 0))}` : ""}`, ...EVERYTHING_FOOTER];
  };
}

const bytesOf = (entries: readonly ManifestEntry[]): string => {
  const n = entries.reduce((sum, e) => sum + e.bytes, 0);
  return n > 0 ? fmtBytes(n) : "";
};

/** One row per rung: name, how many rows, their size, and how many can come when some cannot. */
function detectionNote(manifest: Manifest, source: string): string[] {
  if (manifest.entries.length === 0) {
    return ["Nothing found to bring.", "--manifest <path> lists what should come along.", "", "Nothing has left this computer."];
  }
  const rows = RUNGS.map(rung => manifest.entries.filter(e => e.rung === rung))
    .filter(entries => entries.length > 0)
    .map(entries => {
      const canCome = entries.filter(isTickable).length;
      return [RUNG_TITLE[entries[0]!.rung], String(entries.length), bytesOf(entries), canCome < entries.length ? `${canCome} can come` : ""];
    });
  return [...table(rows, ["left", "right", "right"]), "", `${manifest.entries.length} ${source}. Nothing has left this computer.`];
}

/** One row per rung with its ticks and size, the sign-ins under theirs with the answer each
 * got, a credential-shaped row under Everything else when it got an answer other than skip,
 * then what uploads and what installs, wrapped under their own column. `upload` is the plan's own
 * count of the bytes that travel; without it the ticked rows' sizes stand in. */
export function summaryNote(
  manifest: Manifest,
  ticks: ReadonlySet<string>,
  choices: ReadonlyMap<string, string>,
  width: number,
  upload: number = manifest.entries.filter(e => ticks.has(e.id)).reduce((n, e) => n + e.bytes, 0),
  brew: BrewTable = new Map(),
): string[] {
  const perRung = RUNGS.map(rung => manifest.entries.filter(e => e.rung === rung)).filter(entries => entries.length > 0);
  const answer = (e: ManifestEntry): string => LOGIN_CHOICES.find(c => c.value === choices.get(e.id))?.label ?? "skip";
  // The sign-ins row counts the answers that bring something, as its screen's header does: a sign-in is chosen though nothing is ticked.
  const loginSpread = (entries: readonly ManifestEntry[]): string =>
    LOGIN_CHOICES.slice(0, -1)
      .map(c => ({ n: entries.filter(e => answer(e) === c.label).length, label: c.label }))
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
  const labelRoom = inner - 2 - GUTTER.length - Math.max(...LOGIN_CHOICES.map(c => c.label.length));
  const answered = new Map(table(listed.map(e => [`  ${ellipsize(e.label, labelRoom)}`, answer(e)])).map((line, i) => [listed[i]!.id, line]));
  const lines = perRung.flatMap((entries, i) => [rows[i]!, ...entries.flatMap(e => answered.get(e.id) ?? [])]);
  const bring = manifest.entries.filter(e => ticks.has(e.id)).map(e => ({ ...e, bring: true }));
  const agents = agentInstallsFor(bring, { claude: CLAUDE_INSTALLER }).installs.map(a => a.name);
  // The terminal editors by name; an extension list is a file, not an install.
  const editors = editorInstallsFor(bring).installs.filter(s => s.manager !== "list").map(s => s.label);
  // Only what the person ticked counts as their tools; Homebrew and its toolchain are named apart.
  const steps = toolInstallsFor(bring, brew).installs;
  const tools = steps.filter(t => ticks.has(t.id)).length;
  const toolchain = steps.some(t => t.id.startsWith("tools/brew-toolchain/")) ? " plus Homebrew's toolchain" : "";
  const servers = bring.filter(e => isMcpRow(e) && e.id !== MCP_REMOTE_ID).length;
  // A tool installed from its release is pinned per tag: recorded on the first install of a tag, checked while the tag stands.
  const roads = brewfileFor(bring, brew).roads;
  const PIN_WORDS = { none: "checksum recorded on first install", same: "checksum checked against the first install", moved: "new release, checksum recorded" } as const;
  const pinWords = [...new Set(roads.map(r => PIN_WORDS[pinState(r.pin, r.source)]))].join("; ");
  const fromReleases = roads.length === 0 ? "" : `, ${roads.length} from ${roads.length === 1 ? "its" : "their"} GitHub release${roads.length === 1 ? "" : "s"} (${pinWords})`;
  const fromCasks = bring.flatMap(e => {
    const cask = e.rung === "tools" && cliRoad(e) === undefined ? linuxCaskFor(e.id) : undefined;
    return cask === undefined ? [] : [`, ${e.label} from ${cask.from} (${PIN_WORDS[caskPinState(cask, e)]})`];
  });
  const installs = [...agents, ...editors, ...(tools > 0 ? [`${tools} tool${tools === 1 ? "" : "s"}${toolchain}${fromReleases}${fromCasks.join("")}`] : []), ...(servers > 0 ? [`${servers} MCP server${servers === 1 ? "" : "s"}`] : [])];
  const est = estimateDisk(bring, upload, brew);
  // The Disk line takes its weight's colour here too: the card is the last thing read before the confirm.
  const closing: [string, string, Tone | undefined][] = [
    ["Upload", upload > PACK_BUDGET_BYTES ? `${fmtBytes(upload)}, over the ${fmtBytes(PACK_BUDGET_BYTES)} the machine's disk allows` : `${fmtBytes(upload)}, nothing has left this computer yet`, undefined],
    ["Installs", installs.length > 0 ? installs.join(", ") : "nothing; the machine boots bare", undefined],
    ["Disk", diskLine(est), diskTone(est.total, est.room)],
  ];
  const column = Math.max(...closing.map(([label]) => label.length)) + GUTTER.length;
  return [...lines, "", ...closing.flatMap(([label, text, tone]) => wrap(`${label.padEnd(column)}${text}`, inner, " ".repeat(column)).map(l => (tone === undefined ? l : styleText(tone, l))))];
}

interface Answers {
  ticks: Set<string>;
  choices: Map<string, string>;
}

/** The answers a fresh screen starts with; `coming` is what earlier screens ticked, else every tools and agents row's default. */
function defaultAnswers(manifest: Manifest, coming?: ReadonlySet<string>): Answers {
  const earlier = coming ?? new Set(manifest.entries.filter(e => (e.rung === "agents" || e.rung === "tools") && initialTicks(e)).map(e => e.id));
  const shown = manifest.entries.filter(e => loginShown(e, manifest, earlier));
  // A login whose command is not coming starts at skip; a saved answer stands, and ticks the command's row instead (tickLoginTools).
  const choiceOf = (e: ManifestEntry): LoginChoice => (e.rung === "logins" && e.choice === undefined && e.bring === undefined && loginTool(e, manifest, earlier)?.coming === false ? "skip" : initialChoice(e));
  return {
    // A saved recipe keeps its ticks: a login it brought as a sign-in on the machine stays ticked, as the run that saved it had it;
    // a credential-shaped row is ticked only by its copy answer.
    ticks: new Set(shown.filter(e => (e.rung === "logins" ? e.bring ?? (choiceOf(e) === "copy") : hasChoices(e) ? initialChoice(e) === "copy" : initialTicks(e))).map(e => e.id)),
    choices: new Map(shown.filter(hasChoices).map(e => [e.id, choiceOf(e)])),
  };
}

/** Names the builder about to bill: its size and the backend's rate for it. */
function bootQuestion(recipe: GoldenRecipe, pricing: BackendPricing): string {
  const size = { cpu: recipe.cpu ?? pricing.defaultSize.cpu, memMb: recipe.memMb ?? pricing.defaultSize.memMb };
  const rate = pricing.rateUsdPerHour(size);
  return `Boot a ${size.cpu} vCPU, ${Math.round(size.memMb / 1024)} GB builder on Solari and build this? About $${rate.toFixed(2)}/hr while it runs.`;
}

async function tickRungs(manifest: Manifest, io: InitIO, brew: BrewTable): Promise<Answers | "cancel"> {
  const answers = new Map<Rung, Answers>();
  const rungsWithItems = RUNGS.filter(r => manifest.entries.some(e => e.rung === r));
  let i = 0;
  while (i < RUNGS.length) {
    const rung = RUNGS[i]!;
    const agents = answers.get("agents")?.ticks ?? new Set<string>();
    const entries = manifest.entries.filter(e => e.rung === rung && loginShown(e, manifest, agents));
    const counter = `${i + 1}/${RUNGS.length}`;
    if (entries.length === 0) {
      log.message(`${RUNG_TITLE[rung]}${GUTTER}${dim(counter)}\n${dim("nothing found")}`, { output: io.output, symbol: styleText("green", S_STEP_SUBMIT) });
      i += 1;
      continue;
    }
    const prior = answers.get(rung);
    const earlier = [...answers].filter(([r]) => r !== rung).flatMap(([, a]) => manifest.entries.filter(e => a.ticks.has(e.id)));
    const coming = new Set(earlier.map(e => e.id));
    const fresh = defaultAnswers(manifest, coming);
    const groups = new Map((manifest.groups ?? []).filter(g => g.rung === rung).map(g => [g.group, g]));
    const result = await rungSelect({
      title: rung === "everything" ? everythingTitle(entries) : RUNG_TITLE[rung],
      counter,
      items: rung === "everything" ? everythingItems(entries) : rung === "tools" ? toolsItems(entries, brew) : rung === "logins" ? loginItems(entries, manifest, coming, brew) : entries.map(e => selectItem(e, undefined, brew)),
      initial: prior?.ticks ?? fresh.ticks,
      initialChoices: prior?.choices ?? fresh.choices,
      groupHint: rung === "everything" ? everythingGroupHint(entries) : g => groups.get(g)?.hint,
      groupNote: g => groups.get(g)?.note,
      ...(rung === "everything" ? { footer: everythingFooter(entries), detailLines: 3, folded: [APP_DATA_GROUP] } : rung === "tools" || rung === "agents" ? diskScreen(earlier, entries, brew, rung) : {}),
      ...(rung === "editors" ? { intro: editorsIntro(entries) } : {}),
      input: io.input,
      output: io.output,
    });
    if (result.kind === "cancel") return "cancel";
    answers.set(rung, { ticks: result.ticks, choices: result.choices });
    // A sign-in chosen for a command that is not coming brings the command: its tools row is ticked here, and said so.
    const tools = answers.get("tools");
    if (rung === "logins" && result.kind === "next" && tools !== undefined) {
      const added = tickLoginTools(manifest, result.choices, tools.ticks);
      if (added.length > 0) log.message(dim(`${TICKED_FOR_LOGINS}${added.join(", ")}`), { output: io.output, symbol: dim(S_BAR) });
    }
    if (result.kind === "back") {
      const idx = rungsWithItems.indexOf(rung);
      i = idx > 0 ? RUNGS.indexOf(rungsWithItems[idx - 1]!) : i;
      continue;
    }
    i += 1;
  }
  const all: Answers = { ticks: new Set(), choices: new Map() };
  for (const a of answers.values()) {
    for (const id of a.ticks) all.ticks.add(id);
    for (const [id, c] of a.choices) all.choices.set(id, c);
  }
  return all;
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
  // Off a terminal there is nobody to ask: it runs as if --yes were given.
  const interactive = io.isTTY && !opts.yes;

  let manifest: Manifest;
  let source: string;
  const spinner = spin(io.output, "Reading this computer", io.isTTY);
  const counts: string[] = [];
  const notes: string[] = [];
  try {
    if (opts.manifestPath !== undefined) {
      manifest = loadManifest(opts.manifestPath);
      source = `listed in ${opts.manifestPath}`;
    } else {
      manifest = await opts.collect(
        (rung, rows) => {
          counts.push(`${RUNG_TITLE[rung]} ${rows}`);
          spinner.detail(counts.join(", "));
        },
        note => notes.push(note),
      );
      source = "found on this computer";
    }
  } catch (e) {
    spinner.stop();
    log.error(e instanceof Error ? e.message : String(e), out);
    return { code: 1 };
  }
  spinner.stop();
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
  // A heavy formula starts unticked, judged on the sizes just read.
  manifest = { ...manifest, entries: weighed(linuxCaskRows(withoutAgentTools(manifest.entries)), brew) };
  if (notes.length > 0) log.warn(notes.join("\n"), out);
  card("Found on this computer", detectionNote(manifest, source), io.output);

  let answers: Answers;
  if (interactive) {
    const picked = await tickRungs(manifest, io, brew);
    if (picked === "cancel") {
      cancel("Nothing was changed.", out);
      return { code: 1 };
    }
    answers = picked;
  } else {
    answers = defaultAnswers(manifest);
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

  const bringing = (): ManifestEntry[] =>
    manifest.entries.filter(e => ticks.has(e.id)).map(e => {
      const choice = choices.get(e.id);
      return isLoginChoice(choice) ? { ...e, choice } : e;
    });
  let bring = bringing();
  // Filled by the Keychain reads below, after the earlier-builder check; the pack reads it only at build time.
  const secrets = new Map<string, string>();
  const resultsPath = importResultPath(opts.statePath);
  const path = recipePath(opts.statePath);
  let landed: ImportResult | undefined;
  const importOf = (rows: readonly ManifestEntry[]) =>
    importFor(rows, {
      home: opts.home,
      secrets,
      platform: opts.platform,
      rows: manifest.entries.map(e => ({ ...e, bring: ticks.has(e.id) })),
      brew,
      onResult: r => {
        writeFileSync(resultsPath, `${JSON.stringify(r, null, 2)}\n`);
        landed = r;
        // The first install of a release tag pins its asset: the tag and the checksum the guest read go into the recipe for later installs of that tag.
        const pins = new Map(r.tools.filter(t => t.outcome === "installed" && t.road?.sha256 !== undefined && t.road.tag !== undefined).map(t => [t.id, { tag: t.road!.tag!, sha256: t.road!.sha256! }]));
        const stale = (e: ManifestEntry): boolean => pins.has(e.id) && e.pin?.tag !== pins.get(e.id)!.tag;
        if (manifest.entries.some(stale)) {
          manifest = { ...manifest, entries: manifest.entries.map(e => (stale(e) ? { ...e, pin: pins.get(e.id)! } : e)) };
          saveRecipe(path, manifest, ticks, choices);
        }
      },
    });
  let imp = importOf(bring);
  const uploadBytes = imp.files?.bytes ?? 0;
  card("Summary", summaryNote(offered, ticks, choices, widthOf(io.output), uploadBytes, brew), io.output);
  saveRecipe(path, manifest, ticks, choices);
  log.step(`Recipe saved to ${path}`, out);
  // The whole recipe against the disk, before the account is read or anything boots: the tools stage would
  // otherwise fill the disk after the machine billed.
  const disk = estimateDisk(asBring(bring), uploadBytes, brew);
  // A headless run stops where the screens hold: in the red tier, with the screens' own sentence.
  if (!interactive && heldDisk(disk)) {
    log.error(`${tooFull("tools")} This recipe needs about ${fmtBytes(disk.total)} on the machine, ${Math.round((disk.total / disk.room) * 100)} percent of the ${fmtBytes(disk.room)} the ${BUILDER_DISK_GB} GB builder leaves.`, out);
    cancel(`Nothing was booted. Set bring to false on rows in ${path} until the estimate is under ${fmtBytes(disk.room * DISK_HOLD_SHARE)}, then run wsp init --yes --manifest ${path}; the recipe is kept.`, out);
    return { code: 1 };
  }
  if (disk.over > 0) {
    log.error(`This recipe needs about ${fmtBytes(disk.total)} on the machine; the ${BUILDER_DISK_GB} GB disk leaves ${fmtBytes(disk.room)} after the base image and ${fmtBytes(TOOLS_DISK_FLOOR)} of headroom.`, out);
    cancel(`Nothing was booted. Untick about ${fmtBytes(disk.over)} of tools, agents or files (each screen shows sizes and the total) and run wsp init again; the recipe is kept.`, out);
    return { code: 1 };
  }
  // Judged on the recipe's own sizes, before the account is read or anything boots: the builder's disk
  // check would refuse the same files after the machine billed.
  if (uploadBytes > PACK_BUDGET_BYTES) {
    log.error(`Your files add up to ${fmtBytes(uploadBytes)}; the machine's disk leaves ${fmtBytes(PACK_BUDGET_BYTES)} for them beside the tools and agents.`, out);
    const fix = interactive ? "Untick the larger rows (each screen shows sizes) and run wsp init again" : `Set bring to false on the larger rows in ${path}, then run wsp init --yes --manifest ${path}`;
    cancel(`Nothing was booted. ${fix}; the recipe is kept.`, out);
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
    for (const r of read.refused) choices.set(r.id, "machine");
    log.warn(read.refused.map(r => `${label(r.id)}: ${r.command !== undefined ? `the ${r.service} helper failed` : "Keychain read failed"} (${r.reason}); changed to sign in on the machine.`).join("\n"), out);
    saveRecipe(path, manifest, ticks, choices);
    // The flipped rows change the recipe hash; the builder must carry the hash the saved recipe now has,
    // so wsp init --manifest on that file attaches to it later.
    bring = bringing();
    imp = importOf(bring);
    recipe = goldenRecipeFor(bring, opts.keys, { import: imp });
    await rt.close();
    rt = logged(opts.runtime({ ...recipe, onExec: runLog.exec }));
    earlier = await earlierBuilder();
    if (earlier === "blocked") return { code: 1 };
  }
  const question = bootQuestion(recipe, opts.pricing);
  const { attach, stop } = earlier;
  // A golden built from a recipe takes the delta instead of a rebuild, unless the person picks the rebuild; a
  // builder already carrying this recipe is attached to instead, since the update would bill beside it.
  const current = attach === undefined ? await rt.golden.recipe(GOLDEN_NAME) : undefined;
  if (current !== undefined) {
    const road = await updateRoad({ rt, current, imp, bring, rows: manifest.entries, importOf, interactive, yes: opts.yes, input: io.input, output: io.output, stream: (words, run) => streamStages(rt, io, words, run, runLog.note) });
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
      log.step(`${ask} Taken as yes (${opts.yes ? "--yes" : "no terminal"}).`, out);
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
    const go = await confirmPrompt({ message: question, hint: "No costs nothing and keeps the recipe for wsp init --manifest.", input: io.input, output: io.output });
    if (isCancel(go) || !go) {
      cancel("Nothing was booted. The recipe is kept.", out);
      return { code: 1 };
    }
  } else if (stop.length === 0) {
    log.step(`${question} Taken as yes (${opts.yes ? "--yes" : "no terminal"}).`, out);
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
          ? `Stopped ${where}. Your earlier builder ${attach?.name ?? GOLDEN_NAME} (${e.builderId}) was not stopped: it has a first life worth keeping and stays up at about $${opts.pricing.rateUsdPerHour(attach?.size ?? opts.pricing.defaultSize).toFixed(2)}/hr. wsp init --manifest ${path} attaches to it again; the sweep stops it once it is six hours old.`
          : e.left === undefined
            ? `Stopped ${where}. Builder ${e.builderId} is gone; nothing is billing.`
            : `Stopped ${where}. Builder ${e.builderId} did not stop (${e.left}); ${SWEEP}`
        : `Stopped ${where}. Nothing was booted; nothing is billing.`;
    finalLine = line;
    cancel(line, out);
    await rt.close().catch((e: unknown) => log.error(`runtime close failed: ${e instanceof Error ? e.message : String(e)}`, out));
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
  stream.stop();
  off();
  if (landed !== undefined) log.info(installsTally(landed, resultsPath).join("\n"), out);

  const flow: SignInFlow = { armed: false };
  const handle = await opts.host(rt, builder, flowHooks(flow, builder));
  const dial = (): Promise<BuilderLink> => (opts.daemon ?? builderLink)(rt, builder);
  // Secrets first: a key cut from an rc file is on the machine before any status check looks for it.
  const skipSecretsWhy = interactive ? undefined : io.isTTY ? "--yes asks nothing; set them from the app's terminal" : "no terminal to paste into; set them from the app's terminal";
  const secretOutcomes = await secretsStage({
    cut: landed?.files?.cut ?? [],
    dial,
    input: io.input,
    output: io.output,
    ...(skipSecretsWhy !== undefined ? { skipWhy: skipSecretsWhy } : {}),
    hide: value => runLog.hide(value),
  });
  const skipWhy = interactive ? undefined : io.isTTY ? "--yes asks nothing; sign in from the app's terminal" : "no terminal to sign in from; use the app's terminal";
  const staged = stageLogins(offered, choices, ticks);
  // The pack's notes on a copied login's Keychain and helper items join what its reads left behind, once each.
  for (const s of landed?.files?.skipped ?? []) {
    if (!/^(keychain|helper):/i.test(s.path) || !staged.some(e => e.id === s.id && e.choice === "copy")) continue;
    const have = left.get(s.id);
    if (have === undefined) left.set(s.id, s.note);
    else if (!have.includes(s.note)) left.set(s.id, `${have}; ${s.note}`);
  }
  const outcomes = await signInStage({
    logins: staged,
    left,
    secrets: new Map(secretOutcomes.filter(r => r.state === "set").map(r => [r.name, r.path])),
    dial,
    terminal: { input: io.input, output: io.output },
    ...(skipWhy !== undefined ? { skipWhy } : {}),
    open: url => io.open(url),
    flow,
  });
  if (noteOutcomes(resultsPath, { logins: outcomes, secrets: secretOutcomes }).replaced) log.warn(`${resultsPath} could not be read; it was rewritten with the logins and secrets alone.`, out);

  const next = ((await rt.golden.get())?.head ?? 0) + 1;
  card(`Ready to seal golden v${next}`, sealSummary(landed, outcomes, secretOutcomes, widthOf(io.output)), io.output);
  const result: InitResult = { code: 0, handle, logins: outcomes, secrets: secretOutcomes };
  const leave = async (code: number): Promise<InitResult> => {
    await handle.close().catch((e: unknown) => log.error(`host close failed: ${e instanceof Error ? e.message : String(e)}`, out));
    return { ...result, code, handle: undefined };
  };
  if (interactive) {
    const go = await confirmPrompt({ message: `Seal this machine as golden v${next}?`, hint: "Enter seals: a snapshot, then a fork to prove it. No leaves the machine up.", initialValue: true, input: io.input, output: io.output });
    if (isCancel(go) || !go) {
      cancel(`Nothing was sealed. Builder ${builder.id} stays up at about $${opts.pricing.rateUsdPerHour(builder.size).toFixed(2)}/hr; wsp init --manifest ${path} attaches to it again, and the sweep stops it once it is six hours old.`, out);
      return leave(1);
    }
  } else {
    log.step(`Sealing golden v${next}. Taken as yes (${opts.yes ? "--yes" : "no terminal"}).`, out);
  }
  let sealed: Awaited<ReturnType<Runtime["golden"]["seal"]>> | undefined;
  let error: unknown;
  const logins = outcomes.map(r => ({ name: r.label, state: r.state }));
  const view = await streamStages(rt, io, SEAL_STEPS, () => rt.golden.seal(builder.id, { logins }).then(r => (sealed = r), e => (error = e)), runLog.note);
  if (sealed === undefined) {
    const message = error instanceof Error ? error.message : String(error);
    runLog.note(`failed: ${message}`);
    if (view.failure === undefined) log.error(message, out);
    log.step(logLine(), out);
    outro("Seal failed and the builder is gone. Run wsp init again; the recipe is kept.", out);
    return leave(1);
  }
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

  // Only the first seal ever forks a workspace; a rebuild leaves the existing ones on the version they came from.
  const existing = await rt.workspaces.list();
  if (existing.length > 0) {
    log.step(`Your ${existing.length} workspace${existing.length === 1 ? " stays" : "s stay"} on the golden version ${existing.length === 1 ? "it was" : "they were"} forked from; upgrade ${existing.length === 1 ? "it" : "them"} from the app. New workspaces fork v${version}.`, out);
  } else {
    const forking = spin(io.output, `Forking your first workspace, ${FIRST_WORKSPACE}`, io.isTTY);
    try {
      const first = await handle.createWorkspace(FIRST_WORKSPACE);
      forking.stop();
      log.step(`Workspace ${first.name} (${first.id}) forked from golden v${version}.${first.notice !== undefined ? ` ${first.notice}` : ""}`, out);
    } catch (e) {
      forking.stop();
      log.warn(`The first workspace could not be forked: ${e instanceof Error ? e.message : String(e)}. Create one from the app.`, out);
    }
  }
  const url = `http://127.0.0.1:${handle.port}/`;
  runLog.note(`app ${url}`);
  await openApp(url, handle, io, interactive, logLine(), out);
  outro("wsp keeps serving the app from this terminal; Ctrl-C stops it.", out);
  return result;
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

/** The tally after the build: how the tools and agents came out, each failure named with its reason, and where the list is. */
function installsTally(landed: ImportResult, resultsPath: string): string[] {
  const all = [...landed.tools.map(t => ({ ...t, name: t.label })), ...landed.agents];
  const n = (o: string) => all.filter(x => x.outcome === o).length;
  // The header counts tools, editors and agents; an update's file removals are in the stream and the saved list.
  const removed = (landed.removed ?? []).filter(x => x.what !== "file");
  const notRemoved = removed.filter(x => x.outcome !== "removed");
  return [
    `Tools and agents: ${n("installed")} installed, ${landed.removed !== undefined ? `${removed.length - notRemoved.length} removed, ` : ""}${n("failed")} failed${notRemoved.length > 0 ? `, ${notRemoved.length} not removed` : ""}, ${n("skipped")} skipped; the list is in ${resultsPath}`,
    ...all.filter(x => x.outcome === "failed").map(x => dim(`${x.name} failed: ${x.note ?? "no reason given"}`)),
    ...all.filter(x => x.outcome === "skipped").map(x => dim(`${x.name} skipped: ${x.note ?? "no reason given"}`)),
    ...notRemoved.map(x => dim(`${x.label} not removed: ${x.note ?? "no reason given"}`)),
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
 * forward when the address is remote) under --yes, off a terminal or over ssh. */
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
