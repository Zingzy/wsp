// SPDX-License-Identifier: AGPL-3.0-only
// wsp init: read this machine, let the person tick what comes along one rung
// at a time, confirm once, then build the golden's first machine through the
// runtime and hand off to the browser for the sign-ins and the save. Nothing
// leaves the disk before the confirm, and no question is ever asked on the
// remote machine.
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { RUNGS, type Manifest, type ManifestEntry, type Rung } from "@wsp/collect";
import type { BackendPricing } from "@wsp/engine";
import type { GoldenBuilderView, GoldenRecipe, GoldenStage, Runtime } from "@wsp/runtime";
import { S_BAR, S_STEP_ERROR, S_STEP_SUBMIT, cancel, confirm, intro, isCancel, log, note, outro } from "@clack/prompts";
import type { Keys } from "./cli.js";
import { writeFileSync } from "node:fs";
import { agentInstallsFor, toolInstallsFor } from "@wsp/engine";
import { CLAUDE_INSTALLER, importFor, importResultPath, type SecretReader } from "./init-import.js";
import {
  LOGIN_CHOICES,
  RUNG_TITLE,
  agentName,
  checklistFor,
  goldenRecipeFor,
  initialChoice,
  initialTicks,
  isLoginChoice,
  isTickable,
  loadManifest,
  loginShown,
  recipePath,
  saveRecipe,
  type ChecklistItem,
} from "./init-recipe.js";
import { GUTTER, ellipsize, fmtDuration, table, widthOf } from "./init-layout.js";
import { readKey, rungSelect, type SelectItem } from "./init-select.js";
import type { HostHandle } from "./server.js";

export interface InitIO {
  input: Readable;
  output: Writable;
  isTTY: boolean;
  env: Record<string, string | undefined>;
  /** Try to open the URL in a browser; false when nothing could be launched. */
  open(url: string): Promise<boolean>;
  /** Put text on the clipboard; false when no clipboard tool exists. */
  copy(text: string): Promise<boolean>;
}

export interface InitOptions {
  /** Take every default and skip every prompt, the confirm included. */
  yes: boolean;
  /** A collector manifest or a saved recipe to tick from instead of reading this machine. */
  manifestPath?: string;
  /** Reads this computer, telling onRung how many rows each rung found as it finishes. */
  collect(onRung: (rung: Rung, rows: number) => void): Promise<Manifest>;
  keys: Keys;
  /** Prices the builder the confirm names. */
  pricing: BackendPricing;
  statePath: string;
  /** This computer's home directory, where the ticked paths are read from at build time. */
  home: string;
  /** Reads Keychain-held logins chosen as copy; the real one raises macOS's consent dialog. */
  secrets: SecretReader;
  platform: "darwin" | "linux";
  /** Builds the runtime around the recipe the ticks produced. */
  runtime(recipe: GoldenRecipe): Runtime;
  /** Starts the app server over that runtime once the builder is ready; the page lands on that
   * builder with the sign-ins the person chose to do there. */
  host(rt: Runtime, builder: GoldenBuilderView, checklist: ChecklistItem[]): Promise<HostHandle>;
  /** How long to wait when the account is at its machine cap, and how often. */
  retry?: { waitMs: number; attempts: number };
}

export interface InitResult {
  code: number;
  handle?: HostHandle;
}

const GOLDEN_NAME = "default";
const DEFAULT_RETRY = { waitMs: 30_000, attempts: 20 };
const dim = (s: string): string => styleText("dim", s);

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
  state: "pending" | "current" | "done" | "failed";
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

/** The prepare stages in order, with the words the terminal shows while each
 * runs and once it is over. The stage names are the protocol's; the harness
 * stage installs whatever agents were ticked, and names none of them. */
export const PREPARE_STEPS: readonly StageWords[] = [
  { stage: "creating", start: "Creating the machine", end: "Machine created", fail: "Creating the machine failed" },
  { stage: "deploying-daemon", start: "Installing the base (Node, the daemon)", end: "Base installed", fail: "Installing the base failed" },
  { stage: "applying-setup", start: "Applying your setup", end: "Setup applied", fail: "Applying your setup failed" },
  { stage: "uploading-files", start: "Uploading your files", end: "Files uploaded", fail: "Uploading your files failed" },
  { stage: "installing-tools", start: "Installing tools", end: "Tools installed", fail: "Installing tools failed" },
  { stage: "installing-harness", start: "Installing agents", end: "Agents installed", fail: "Installing agents failed" },
  { stage: "ready", start: "Waiting for the machine", end: "Ready", fail: "The machine never became ready" },
];

/** The seal, driven from the browser; the terminal only reports it. */
export const SEAL_STEPS: readonly StageWords[] = [
  { stage: "snapshotting", start: "Taking the snapshot", end: "Snapshot taken", fail: "Snapshot failed" },
  { stage: "smoke-forking", start: "Booting a fork to prove it", end: "Fork booted and checked", fail: "The fork failed its check" },
  { stage: "sealed", start: "Sealing", end: "Sealed", fail: "Seal failed" },
];

const LAST_STAGE = new Set<string>(["ready", "sealed"]);

export function reduceStages(frames: readonly StageFrame[], words: readonly StageWords[] = PREPARE_STEPS): StageView {
  const steps: StageStep[] = words.map(s => ({ ...s, state: "pending", tail: [] }));
  let failure: string | undefined;
  let at = -1;
  let since: number | undefined;
  for (const f of frames) {
    if (f.name !== GOLDEN_NAME) continue;
    if (f.stage === "failed") {
      failure = f.detail ?? "no detail given";
      if (at >= 0) steps[at]!.state = "failed";
      continue;
    }
    const i = steps.findIndex(s => s.stage === f.stage);
    if (i < 0) continue;
    for (let j = 0; j < i; j++) {
      if (steps[j]!.state === "done") continue;
      if (steps[j]!.state === "current" && since !== undefined && f.at !== undefined) steps[j]!.ms = f.at - since;
      steps[j]!.state = "done";
    }
    // A stage reports twice when it ends with a detail; its clock starts at the first frame.
    if (at !== i) since = f.at;
    at = i;
    steps[i]!.state = LAST_STAGE.has(f.stage) ? "done" : "current";
    if (f.detail !== undefined) steps[i]!.tail.push(f.detail);
  }
  return failure !== undefined ? { steps, failure } : { steps };
}

/** One stage as one line: the glyph, the label padded so details line up, the latest detail,
 * and once the stage is done its duration flush against the right edge. */
export function stageLine(glyph: string, label: string, detail: string | undefined, ms: number | undefined, width: number, labelWidth: number): string {
  const duration = ms === undefined ? "" : fmtDuration(ms);
  const room = width - 3 - labelWidth - GUTTER.length - (duration === "" ? 0 : GUTTER.length + duration.length);
  const cut = detail === undefined || detail === "" ? "" : ellipsize(detail, room);
  const head = label.padEnd(labelWidth);
  const shown = head.length + (cut === "" ? 0 : GUTTER.length + cut.length);
  const gap = duration === "" ? "" : " ".repeat(Math.max(GUTTER.length, width - 3 - shown - duration.length));
  return `${glyph}  ${head}${cut === "" ? "" : `${GUTTER}${dim(cut)}`}${gap}${dim(duration)}`.trimEnd();
}

/** One line per step, redrawn as frames arrive: a spinner glyph on the current
 * step with its latest detail, the end label once it is done, the tail of
 * details kept under a failed step. Animation only on a terminal. */
class StageStream {
  private frames: StageFrame[] = [];
  private view: StageView;
  private printed = 0;
  private timer: NodeJS.Timeout | undefined;
  private tick = 0;
  private static readonly SPIN = ["◒", "◐", "◓", "◑"];

  constructor(
    private readonly output: Writable,
    private readonly animate: boolean,
    private readonly words: readonly StageWords[] = PREPARE_STEPS,
  ) {
    this.view = reduceStages([], words);
  }

  get failed(): boolean {
    return this.view.failure !== undefined;
  }

  get finished(): boolean {
    return this.view.failure !== undefined || this.view.steps.every(s => s.state === "done");
  }

  start(): void {
    if (this.animate) {
      this.timer = setInterval(() => {
        this.tick += 1;
        this.draw();
      }, 80);
    }
    this.draw();
  }

  push(frame: StageFrame): void {
    const prev = this.view;
    this.frames.push({ ...frame, at: frame.at ?? Date.now() });
    this.view = reduceStages(this.frames, this.words);
    if (this.animate) this.draw();
    else this.announce(prev);
  }

  stop(): StageView {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.draw(true);
    return this.view;
  }

  private get labelWidth(): number {
    return Math.max(...this.words.flatMap(w => [w.start.length, w.end.length]));
  }

  private doneLine(s: StageStep): string {
    return stageLine(styleText("green", S_STEP_SUBMIT), s.end, s.tail.at(-1), s.ms, widthOf(this.output), this.labelWidth);
  }

  private lines(final: boolean): string[] {
    const out: string[] = [];
    const width = widthOf(this.output);
    for (const s of this.view.steps) {
      switch (s.state) {
        case "pending":
          out.push(`${dim(S_BAR)}  ${dim(s.start)}`);
          break;
        case "current":
          out.push(stageLine(styleText("cyan", StageStream.SPIN[this.tick % StageStream.SPIN.length]!), s.start, s.tail.at(-1), undefined, width, this.labelWidth));
          break;
        case "done":
          out.push(this.doneLine(s));
          break;
        case "failed":
          out.push(`${styleText("red", S_STEP_ERROR)}  ${s.fail}`);
          for (const t of s.tail) out.push(`${dim(S_BAR)}  ${dim(t)}`);
          break;
        default: {
          const _exhaustive: never = s.state;
          return _exhaustive;
        }
      }
    }
    if (final && this.view.failure !== undefined) out.push(`${dim(S_BAR)}  ${this.view.failure}`);
    return out;
  }

  private draw(final = false): void {
    if (this.animate) {
      const lines = this.lines(final);
      const up = this.printed > 0 ? `\x1b[${this.printed}A\x1b[J` : "";
      this.output.write(`${up}${lines.join("\n")}\n`);
      this.printed = lines.length;
      return;
    }
    // Off a terminal every step was announced as it happened; only a failure is left to print.
    if (final && this.view.failure !== undefined) {
      const failed = this.view.steps.find(s => s.state === "failed");
      if (failed) this.output.write(`${styleText("red", S_STEP_ERROR)}  ${failed.fail}\n`);
      this.output.write(`${dim(S_BAR)}  ${this.view.failure}\n`);
    }
  }

  /** Off a terminal, one line per step as it starts and as it ends, so a log reads in order. */
  private announce(prev: StageView): void {
    for (let i = 0; i < this.view.steps.length; i++) {
      const s = this.view.steps[i]!;
      const was = prev.steps[i]!.state;
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

/** Anthropic forbids a host to collect or pass along this credential, which is why its login is signed in on the machine unless the person opts in. */
const CLAUDE_LOGIN_WHY = "Anthropic's terms forbid passing this credential along, so the default is to sign in on the machine.";

/** The second detail line: why a row is locked, else what ticking it means. */
function detailWhy(e: ManifestEntry, lock: "on" | "off" | undefined): string {
  if (lock === "off" && e.reason !== undefined) return e.reason;
  if (lock === "on") return "always comes along";
  if (e.rung === "logins") return agentName(e) === "claude" ? CLAUDE_LOGIN_WHY : "copy brings it along; sign in does it in the browser after the build";
  if (e.rung === "agents") return agentInstallsFor([{ ...e, bring: true }], { claude: CLAUDE_INSTALLER }).installs.length > 0 ? "installed on the machine; its config comes along" : "its config comes along; no installer yet, install it there yourself";
  const size = e.bytes > 0 ? `${fmtBytes(e.bytes)}, ` : "";
  return `${size}${e.default === "bring" ? "brought by default" : "left out by default"}`;
}

function selectItem(e: ManifestEntry): SelectItem {
  const where = e.paths.length > 0 ? e.paths.join(", ") : "reinstalled on the machine";
  const lock = e.required ? "on" : !isTickable(e) ? "off" : undefined;
  return {
    id: e.id,
    label: e.label,
    ...(e.bytes > 0 && e.rung !== "logins" ? { hint: fmtBytes(e.bytes) } : {}),
    ...(e.group !== undefined ? { group: e.group } : {}),
    detail: [where, detailWhy(e, lock)],
    ...(lock !== undefined ? { lock } : {}),
    ...(e.rung === "logins" ? { choices: LOGIN_CHOICES } : {}),
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

/** One row per rung with its ticks and size, the sign-ins under theirs with the answer each got,
 * then what uploads and what installs. */
function summaryNote(manifest: Manifest, ticks: ReadonlySet<string>, choices: ReadonlyMap<string, string>, width: number): string[] {
  const rows = RUNGS.map(rung => manifest.entries.filter(e => e.rung === rung))
    .filter(entries => entries.length > 0)
    .map(entries => {
      const on = entries.filter(e => ticks.has(e.id));
      return [RUNG_TITLE[entries[0]!.rung], `${on.length} of ${entries.length}`, bytesOf(on)];
    });
  const logins = manifest.entries.filter(e => e.rung === "logins");
  const answer = (e: ManifestEntry): string => LOGIN_CHOICES.find(c => c.value === choices.get(e.id))?.label ?? "skip";
  // The note frame takes 6 columns; the label keeps room for the widest answer.
  const labelRoom = width - 6 - 2 - GUTTER.length - Math.max(...LOGIN_CHOICES.map(c => c.label.length));
  const upload = fmtBytes(manifest.entries.filter(e => ticks.has(e.id)).reduce((n, e) => n + e.bytes, 0));
  const bring = manifest.entries.filter(e => ticks.has(e.id)).map(e => ({ ...e, bring: true }));
  const agents = agentInstallsFor(bring, { claude: CLAUDE_INSTALLER }).installs.map(a => a.name);
  const tools = toolInstallsFor(bring).installs.filter(t => t.id !== "tools/homebrew").length;
  const installs = [...agents, ...(tools > 0 ? [`${tools} tool${tools === 1 ? "" : "s"}`] : [])];
  return [
    ...table(rows, ["left", "right", "right"]),
    ...table(logins.map(e => [`  ${ellipsize(e.label, labelRoom)}`, answer(e)])),
    "",
    ...table([
      ["Upload", `${upload}, nothing has left this computer yet`],
      ["Installs", installs.length > 0 ? installs.join(", ") : "nothing; the machine boots bare"],
    ]),
  ];
}

interface Answers {
  ticks: Set<string>;
  choices: Map<string, string>;
}

function defaultAnswers(manifest: Manifest): Answers {
  const agents = new Set(manifest.entries.filter(e => e.rung === "agents" && initialTicks(e)).map(e => e.id));
  const shown = manifest.entries.filter(e => loginShown(e, manifest, agents));
  return {
    ticks: new Set(shown.filter(e => (e.rung === "logins" ? initialChoice(e) === "copy" : initialTicks(e))).map(e => e.id)),
    choices: new Map(shown.filter(e => e.rung === "logins").map(e => [e.id, initialChoice(e)])),
  };
}

/** Names the builder about to bill: its size and the backend's rate for it. */
function bootQuestion(recipe: GoldenRecipe, pricing: BackendPricing): string {
  const size = { cpu: recipe.cpu ?? pricing.defaultSize.cpu, memMb: recipe.memMb ?? pricing.defaultSize.memMb };
  const rate = pricing.rateUsdPerHour(size);
  return `Boot a ${size.cpu} vCPU, ${Math.round(size.memMb / 1024)} GB builder on Solari and build this? About $${rate.toFixed(2)}/hr while it runs.`;
}

async function tickRungs(manifest: Manifest, io: InitIO): Promise<Answers | "cancel"> {
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
    const fresh = defaultAnswers({ entries });
    const result = await rungSelect({
      title: RUNG_TITLE[rung],
      counter,
      items: entries.map(selectItem),
      initial: prior?.ticks ?? fresh.ticks,
      initialChoices: prior?.choices ?? fresh.choices,
      input: io.input,
      output: io.output,
    });
    if (result.kind === "cancel") return "cancel";
    answers.set(rung, { ticks: result.ticks, choices: result.choices });
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

// --- the command -------------------------------------------------------------

export async function runInit(opts: InitOptions, io: InitIO): Promise<InitResult> {
  const out = { output: io.output };
  // Off a terminal there is nobody to ask: it runs as if --yes were given.
  const interactive = io.isTTY && !opts.yes;
  intro("wsp init", out);

  let manifest: Manifest;
  let source: string;
  const spinner = spin(io.output, "Reading this computer", io.isTTY);
  const counts: string[] = [];
  try {
    if (opts.manifestPath !== undefined) {
      manifest = loadManifest(opts.manifestPath);
      source = `listed in ${opts.manifestPath}`;
    } else {
      manifest = await opts.collect((rung, rows) => {
        counts.push(`${RUNG_TITLE[rung]} ${rows}`);
        spinner.detail(counts.join(", "));
      });
      source = "found on this computer";
    }
  } catch (e) {
    spinner.stop();
    log.error(e instanceof Error ? e.message : String(e), out);
    return { code: 1 };
  }
  spinner.stop();
  note(detectionNote(manifest, source).join("\n"), "Found on this computer", out);

  let answers: Answers;
  if (interactive) {
    const picked = await tickRungs(manifest, io);
    if (picked === "cancel") {
      cancel("Nothing was changed.", out);
      return { code: 1 };
    }
    answers = picked;
  } else {
    answers = defaultAnswers(manifest);
  }
  const { ticks, choices } = answers;
  const offered: Manifest = { entries: manifest.entries.filter(e => loginShown(e, manifest, ticks)) };

  note(summaryNote(offered, ticks, choices, widthOf(io.output)).join("\n"), "Summary", out);
  const path = recipePath(opts.statePath);
  saveRecipe(path, manifest, ticks, choices);
  log.step(`Recipe saved to ${path}`, out);

  const bring = manifest.entries.filter(e => ticks.has(e.id)).map(e => {
    const choice = choices.get(e.id);
    return isLoginChoice(choice) ? { ...e, choice } : e;
  });
  const resultsPath = importResultPath(opts.statePath);
  let installs: string | undefined;
  const imp = importFor(bring, {
    home: opts.home,
    secrets: opts.secrets,
    platform: opts.platform,
    onResult: r => {
      writeFileSync(resultsPath, `${JSON.stringify(r, null, 2)}\n`);
      const all = [...r.tools, ...r.agents];
      const n = (o: string) => all.filter(x => x.outcome === o).length;
      installs = `${n("installed")} installed, ${n("failed")} failed, ${n("skipped")} skipped; the list is in ${resultsPath}`;
    },
  });
  const recipe = goldenRecipeFor(bring, opts.keys, { import: imp });
  const question = bootQuestion(recipe, opts.pricing);
  if (interactive) {
    const go = await confirm({ message: `${question}\nNo costs nothing and keeps the recipe for wsp init --manifest.`, initialValue: false, input: io.input, output: io.output });
    if (isCancel(go) || !go) {
      cancel("Nothing was booted. The recipe is kept.", out);
      return { code: 1 };
    }
  } else {
    log.step(`${question} Taken as yes (${opts.yes ? "--yes" : "no terminal"}).`, out);
  }

  const rt = opts.runtime(recipe);
  const stream = new StageStream(io.output, io.isTTY);
  const off = rt.events.on("golden.stage", e => {
    if (e.type === "golden.stage") stream.push({ type: "golden.stage", name: e.name, stage: e.stage, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
  });
  const retry = opts.retry ?? DEFAULT_RETRY;
  stream.start();
  let builder: GoldenBuilderView;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        builder = await rt.golden.prepare({ name: GOLDEN_NAME });
        break;
      } catch (e) {
        if (!isCapRefusal(e) || attempt + 1 >= retry.attempts) throw e;
        log.warn(`Solari account at its machine cap; waiting ${Math.round(retry.waitMs / 1000)}s for a slot (${attempt + 1}/${retry.attempts}). Nothing is killed.`, out);
        await new Promise(r => setTimeout(r, retry.waitMs));
      }
    }
  } catch (e) {
    const view = stream.stop();
    off();
    if (view.failure === undefined) log.error(e instanceof Error ? e.message : String(e), out);
    outro("That machine is gone. Run wsp init again.", out);
    return { code: 1 };
  }
  stream.stop();
  off();
  if (installs !== undefined) log.info(`Tools and agents: ${installs}`, out);

  const checklist = checklistFor(manifest, choices);
  const handle = await opts.host(rt, builder, checklist);
  const url = `http://127.0.0.1:${handle.port}/`;
  await handoff(url, handle, io, interactive, out);
  outro("This terminal reports the save.", out);
  reportSeal(rt, io);
  return { code: 0, handle };
}

/** After the hand-off the browser drives the seal; the terminal shows it as it happens. */
function reportSeal(rt: Runtime, io: InitIO): void {
  let stream: StageStream | undefined;
  const off = rt.events.on("golden.stage", e => {
    if (e.type !== "golden.stage" || e.name !== GOLDEN_NAME) return;
    if (!stream) {
      stream = new StageStream(io.output, io.isTTY, SEAL_STEPS);
      stream.start();
    }
    stream.push({ type: "golden.stage", name: e.name, stage: e.stage, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
    if (!stream.finished) return;
    stream.stop();
    off();
    const out = { output: io.output };
    if (stream.failed) {
      log.error("Seal failed and the builder is gone. Run wsp init again; the recipe is kept.", out);
    } else {
      log.success("Golden v1 sealed. The app forks your first workspace; wsp keeps serving it here.", out);
    }
  });
}

/** Three lines: the address, what to do there, and the keys (or the ssh forward when the address is remote). */
async function handoff(url: string, handle: HostHandle, io: InitIO, interactive: boolean, out: { output: Writable }): Promise<void> {
  const finish = "Sign in where the checklist says, then save the golden.";
  if (!io.isTTY || overSsh(io.env)) {
    const lines = [`Open ${url}`, finish];
    if (overSsh(io.env)) lines.push(dim(`loopback address; forward it first: ssh -L ${handle.port}:127.0.0.1:${handle.port} <this host>`));
    log.step(lines.join("\n"), out);
    return;
  }
  const opened = await io.open(url);
  log.step([`${opened ? "Opened" : "Open"} ${url}`, finish, ...(interactive ? [dim("c copy the address   enter continue")] : [])].join("\n"), out);
  if (!interactive) return;
  for (;;) {
    const key = await readKey(io.input, io.output, ["c", "return"]);
    if (key === "c") {
      const ok = await io.copy(url);
      io.output.write(`${dim(S_BAR)}  ${dim(ok ? "copied" : "no clipboard tool; copy it from the line above")}\n`);
      continue;
    }
    return;
  }
}
