// SPDX-License-Identifier: AGPL-3.0-only
// wsp init: read this machine, let the person tick what comes along one rung
// at a time, confirm once, then build the golden's first machine through the
// runtime and hand off to the browser for the sign-ins and the save. Nothing
// leaves the disk before the confirm, and no question is ever asked on the
// remote machine.
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { RUNGS, type Manifest, type ManifestEntry, type Rung } from "@wsp/collect";
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
  recipePath,
  saveRecipe,
  type ChecklistItem,
} from "./init-recipe.js";
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

export function fmtSeconds(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

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
  for (const f of frames) {
    if (f.name !== GOLDEN_NAME) continue;
    if (f.stage === "failed") {
      failure = f.detail ?? "no detail given";
      if (at >= 0) steps[at]!.state = "failed";
      continue;
    }
    const i = steps.findIndex(s => s.stage === f.stage);
    if (i < 0) continue;
    for (let j = 0; j < i; j++) if (steps[j]!.state !== "done") steps[j]!.state = "done";
    at = i;
    steps[i]!.state = LAST_STAGE.has(f.stage) ? "done" : "current";
    if (f.detail !== undefined) steps[i]!.tail.push(f.detail);
  }
  return failure !== undefined ? { steps, failure } : { steps };
}

/** One line per step, redrawn as frames arrive: a spinner glyph on the current
 * step with its latest detail, the end label once it is done, the tail of
 * details kept under a failed step. Animation only on a terminal. */
class StageStream {
  private frames: StageFrame[] = [];
  private view: StageView;
  private startedAt = new Map<string, number>();
  private took = new Map<string, number>();
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
    const first = this.view.steps[0];
    if (first) this.startedAt.set(first.stage, Date.now());
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
    this.frames.push(frame);
    this.view = reduceStages(this.frames, this.words);
    this.clock(prev);
    if (this.animate) this.draw();
    else this.announce(prev);
  }

  /** A step's clock starts when it turns current and stops when it is done or failed; a
   * step never reported ends when the next one begins. */
  private clock(prev: StageView): void {
    const now = Date.now();
    for (let i = 0; i < this.view.steps.length; i++) {
      const s = this.view.steps[i]!;
      const was = prev.steps[i]!.state;
      if (s.state === was) continue;
      if (!this.startedAt.has(s.stage)) this.startedAt.set(s.stage, now);
      if (s.state === "done" || s.state === "failed") this.took.set(s.stage, now - this.startedAt.get(s.stage)!);
    }
  }

  private tail(s: StageStep): string {
    const last = s.tail.at(-1);
    const took = this.took.get(s.stage);
    const parts = [last, took !== undefined && s.state !== "current" ? fmtSeconds(took) : undefined].filter((p): p is string => p !== undefined);
    return parts.length > 0 ? `  ${dim(parts.join("  "))}` : "";
  }

  stop(): StageView {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.draw(true);
    return this.view;
  }

  private lines(final: boolean): string[] {
    const out: string[] = [];
    for (const s of this.view.steps) {
      switch (s.state) {
        case "pending":
          out.push(`${dim(S_BAR)}  ${dim(s.start)}`);
          break;
        case "current":
          out.push(`${styleText("cyan", StageStream.SPIN[this.tick % StageStream.SPIN.length]!)}  ${s.start}${this.tail(s)}`);
          break;
        case "done":
          out.push(`${styleText("green", S_STEP_SUBMIT)}  ${s.end}${this.tail(s)}`);
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
      if (s.state === "done" && was !== "done") this.output.write(`${styleText("green", S_STEP_SUBMIT)}  ${s.end}${this.tail(s)}\n`);
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
  const draw = (): void => {
    output.write(`\r${styleText("cyan", frames[tick++ % frames.length]!)}  ${label}${detail !== "" ? `  ${dim(detail)}` : ""}`);
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
const CLAUDE_LOGIN_WHY = "Anthropic's terms forbid a host to collect or pass along this credential, so the default is to sign in on the machine.";

function selectItem(e: ManifestEntry): SelectItem {
  const where = e.paths.length > 0 ? e.paths.join(", ") : "reinstalled on the machine";
  const size = e.bytes > 0 ? fmtBytes(e.bytes) : undefined;
  const install = e.rung === "agents" ? agentInstallsFor([{ ...e, bring: true }], { claude: CLAUDE_INSTALLER }).installs[0] : undefined;
  const detail =
    e.rung === "logins"
      ? [where, agentName(e) === "claude" ? CLAUDE_LOGIN_WHY : "copy puts this login in the golden; sign in on the machine does it in the browser, next"]
      : e.rung === "agents"
        ? [where, install !== undefined ? "installed on the machine, config brought along" : "config brought along; no installer for it yet, install it on the machine"]
        : [where, [size, e.default === "bring" ? "brought by default" : "left out by default"].filter((s): s is string => s !== undefined).join(", ")];
  const lock = e.required ? "on" : !isTickable(e) ? "off" : undefined;
  return {
    id: e.id,
    label: e.label,
    ...(size !== undefined && e.rung !== "logins" ? { hint: size } : {}),
    ...(e.group !== undefined ? { group: e.group } : {}),
    detail,
    ...(lock !== undefined ? { lock } : {}),
    ...(lock === "off" && e.reason !== undefined ? { lockReason: e.reason } : {}),
    ...(e.rung === "logins" ? { choices: LOGIN_CHOICES } : {}),
  };
}

function rungIntro(rung: Rung): string | undefined {
  return rung === "logins" ? "Per login: copy it from this computer into the golden, sign in on the machine yourself in the browser next, or skip it." : undefined;
}

function detectionNote(manifest: Manifest, source: string): string[] {
  if (manifest.entries.length === 0) {
    return ["Found nothing to bring from this computer.", "Pass --manifest <path> to list what should come along.", "", "Nothing has left this computer."];
  }
  const lines: string[] = [];
  for (const rung of RUNGS) {
    const entries = manifest.entries.filter(e => e.rung === rung);
    if (entries.length === 0) continue;
    const bytes = entries.reduce((n, e) => n + e.bytes, 0);
    const canCome = entries.filter(isTickable).length;
    const parts = [canCome < entries.length ? `${canCome} can come` : "", bytes > 0 ? fmtBytes(bytes) : ""].filter(p => p !== "");
    lines.push(`${RUNG_TITLE[rung].padEnd(12)} ${String(entries.length).padStart(3)}${parts.length > 0 ? `  ${parts.join(", ")}` : ""}`);
  }
  lines.push("", `${manifest.entries.length} things ${source}. Nothing has left this computer.`);
  return lines;
}

function summaryNote(manifest: Manifest, ticks: ReadonlySet<string>, choices: ReadonlyMap<string, string>): string[] {
  const lines: string[] = [];
  let upload = 0;
  for (const rung of RUNGS) {
    const entries = manifest.entries.filter(e => e.rung === rung);
    if (entries.length === 0) continue;
    const on = entries.filter(e => ticks.has(e.id));
    const bytes = on.reduce((n, e) => n + e.bytes, 0);
    upload += bytes;
    lines.push(`${RUNG_TITLE[rung]}  ${on.length} of ${entries.length}${bytes > 0 ? `, ${fmtBytes(bytes)}` : ""}`);
    if (on.length > 0) lines.push(...on.map(e => `  ${e.label}`));
  }
  const onMachine = manifest.entries.filter(e => e.rung === "logins" && choices.get(e.id) === "machine");
  if (onMachine.length > 0) lines.push(`Sign in on the machine: ${onMachine.map(e => e.label).join(", ")}`);
  const bring = manifest.entries.filter(e => ticks.has(e.id)).map(e => ({ ...e, bring: true }));
  const agents = agentInstallsFor(bring, { claude: CLAUDE_INSTALLER }).installs.map(a => a.name);
  const tools = toolInstallsFor(bring).installs.filter(t => t.id !== "tools/homebrew").length;
  lines.push("", `Upload: ${fmtBytes(upload)}. Nothing has left this computer yet.`);
  const what = [agents.join(", "), tools > 0 ? `${tools} tool${tools === 1 ? "" : "s"}` : ""].filter(w => w !== "");
  lines.push(what.length > 0 ? `The machine installs: ${what.join(" and ")}.` : "The machine installs nothing; it boots bare.");
  return lines;
}

interface Answers {
  ticks: Set<string>;
  choices: Map<string, string>;
}

function defaultAnswers(manifest: Manifest): Answers {
  return {
    ticks: new Set(manifest.entries.filter(e => (e.rung === "logins" ? initialChoice(e) === "copy" : initialTicks(e))).map(e => e.id)),
    choices: new Map(manifest.entries.filter(e => e.rung === "logins").map(e => [e.id, initialChoice(e)])),
  };
}

async function tickRungs(manifest: Manifest, io: InitIO): Promise<Answers | "cancel"> {
  const answers = new Map<Rung, Answers>();
  const rungsWithItems = RUNGS.filter(r => manifest.entries.some(e => e.rung === r));
  let i = 0;
  while (i < RUNGS.length) {
    const rung = RUNGS[i]!;
    const entries = manifest.entries.filter(e => e.rung === rung);
    const counter = `${i + 1}/${RUNGS.length}`;
    if (entries.length === 0) {
      log.message(`${styleText("bold", RUNG_TITLE[rung])}  ${dim(counter)}\n${dim("nothing found for this screen")}`, { output: io.output, symbol: styleText("green", S_STEP_SUBMIT) });
      i += 1;
      continue;
    }
    const prior = answers.get(rung);
    const fresh = defaultAnswers({ entries });
    const hint = rungIntro(rung);
    if (hint !== undefined && prior === undefined) log.message(dim(hint), { output: io.output, symbol: dim(S_BAR) });
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

  note(summaryNote(manifest, ticks, choices).join("\n"), "Summary", out);
  if (interactive) {
    const go = await confirm({ message: "Boot a machine on your Solari account and build this? It bills while it runs.", initialValue: false, input: io.input, output: io.output });
    if (isCancel(go) || !go) {
      cancel("Nothing was changed.", out);
      return { code: 1 };
    }
  } else {
    log.step(`Boot a machine on your Solari account and build this: taken as yes (${opts.yes ? "--yes" : "no terminal"}).`, out);
  }

  const path = recipePath(opts.statePath);
  saveRecipe(path, manifest, ticks, choices);
  log.info(`Recipe saved to ${path}. Rerun with wsp init --manifest ${path} --yes to build it again.`, out);

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
  const rt = opts.runtime(goldenRecipeFor(bring, opts.keys, { import: imp }));
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
        log.warn(`Your Solari account is at its machine cap; waiting ${Math.round(retry.waitMs / 1000)}s for a slot to free (${attempt + 1}/${retry.attempts}). Nothing is killed.`, out);
        await new Promise(r => setTimeout(r, retry.waitMs));
      }
    }
  } catch (e) {
    const view = stream.stop();
    off();
    if (view.failure === undefined) log.error(e instanceof Error ? e.message : String(e), out);
    outro("The machine from this attempt is gone. Run wsp init again to start over.", out);
    return { code: 1 };
  }
  stream.stop();
  off();
  if (installs !== undefined) log.info(`Tools and agents: ${installs}`, out);

  const checklist = checklistFor(manifest, choices);
  const handle = await opts.host(rt, builder, checklist);
  const url = `http://127.0.0.1:${handle.port}/`;
  await handoff(url, handle, io, interactive, out);
  outro(
    [
      "Finish on the machine's terminal in the browser: sign in where the checklist says, then save it as your golden image.",
      `${dim(S_BAR)}  Recipe: ${path}`,
      `${dim(S_BAR)}  This terminal keeps reporting until the save is done.`,
    ].join("\n"),
    out,
  );
  reportSeal(rt, io, path);
  return { code: 0, handle };
}

/** After the hand-off the browser drives the seal; the terminal shows it as it happens. */
function reportSeal(rt: Runtime, io: InitIO, recipe: string): void {
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
      log.error(`Seal failed and the builder is gone. Run wsp init again; the recipe at ${recipe} is kept.`, out);
    } else {
      log.success(`Golden v1 sealed. The app is forking your first workspace; wsp keeps serving it here.`, out);
    }
  });
}

async function handoff(url: string, handle: HostHandle, io: InitIO, interactive: boolean, out: { output: Writable }): Promise<void> {
  if (!io.isTTY || overSsh(io.env)) {
    const lines = [`Open ${url}`];
    if (overSsh(io.env)) {
      lines.push(`This address is on this machine's loopback. From your laptop, forward it first:`, `  ssh -L ${handle.port}:127.0.0.1:${handle.port} <this host>`);
    }
    note(lines.join("\n"), "Your machine is ready", out);
    return;
  }
  const opened = await io.open(url);
  log.step(`${opened ? "Opened" : "Open"} ${url}`, out);
  if (!interactive) return;
  io.output.write(`${dim(S_BAR)}  ${dim("c copies the address, enter continues")}\n`);
  for (;;) {
    const key = await readKey(io.input, io.output, ["c", "return"]);
    if (key === "c") {
      const ok = await io.copy(url);
      io.output.write(`${dim(S_BAR)}  ${dim(ok ? "copied" : "no clipboard tool found; copy it from the line above")}\n`);
      continue;
    }
    return;
  }
}
