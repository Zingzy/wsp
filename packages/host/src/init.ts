// SPDX-License-Identifier: AGPL-3.0-only
// wsp init: read this machine, let the person tick what comes along one rung
// at a time, confirm once, then build the golden's first machine through the
// runtime and hand off to the browser for the sign-ins and the save. Nothing
// leaves the disk before the confirm, and no question is ever asked on the
// remote machine.
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import type { GoldenBuilderView, GoldenRecipe, GoldenStage, Runtime } from "@wsp/runtime";
import { S_BAR, S_STEP_ERROR, S_STEP_SUBMIT, cancel, confirm, intro, isCancel, log, note, outro } from "@clack/prompts";
import type { Keys } from "./cli.js";
import {
  RUNGS,
  RUNG_TITLE,
  goldenRecipeFor,
  initialTicks,
  installFor,
  isTickable,
  loadManifest,
  recipePath,
  saveRecipe,
  type Manifest,
  type ManifestEntry,
  type Rung,
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
  collect(): Promise<Manifest>;
  keys: Keys;
  statePath: string;
  /** Builds the runtime around the recipe the ticks produced. */
  runtime(recipe: GoldenRecipe): Runtime;
  /** Starts the app server over that runtime once the builder is ready; the page lands on that builder. */
  host(rt: Runtime, builder: GoldenBuilderView): Promise<HostHandle>;
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
 * stage runs whatever setup the ticks produced, so its words name no agent. */
const PREPARE_STEPS: readonly { stage: GoldenStage; start: string; end: string; fail: string }[] = [
  { stage: "creating", start: "Booting a fresh machine", end: "Machine booted", fail: "Boot failed" },
  { stage: "deploying-daemon", start: "Starting the workspace daemon", end: "Workspace daemon running", fail: "Workspace daemon failed to start" },
  { stage: "installing-harness", start: "Running the setup", end: "Setup finished", fail: "Setup failed" },
  { stage: "ready", start: "Waiting for the machine", end: "Machine ready", fail: "Machine never became ready" },
];

export function reduceStages(frames: readonly StageFrame[]): StageView {
  const steps: StageStep[] = PREPARE_STEPS.map(s => ({ ...s, state: "pending", tail: [] }));
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
    steps[i]!.state = f.stage === "ready" ? "done" : "current";
    if (f.detail !== undefined) steps[i]!.tail.push(f.detail);
  }
  return failure !== undefined ? { steps, failure } : { steps };
}

/** One line per step, redrawn as frames arrive: a spinner glyph on the current
 * step with its latest detail, the end label once it is done, the tail of
 * details kept under a failed step. Animation only on a terminal. */
class StageStream {
  private frames: StageFrame[] = [];
  private view = reduceStages([]);
  private printed = 0;
  private timer: NodeJS.Timeout | undefined;
  private tick = 0;
  private static readonly SPIN = ["◒", "◐", "◓", "◑"];

  constructor(
    private readonly output: Writable,
    private readonly animate: boolean,
  ) {}

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
    this.frames.push(frame);
    this.view = reduceStages(this.frames);
    if (this.animate) this.draw();
    else this.announce(prev);
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
      const last = s.tail.at(-1);
      switch (s.state) {
        case "pending":
          out.push(`${dim(S_BAR)}  ${dim(s.start)}`);
          break;
        case "current":
          out.push(`${styleText("cyan", StageStream.SPIN[this.tick % StageStream.SPIN.length]!)}  ${s.start}${last !== undefined ? `  ${dim(last)}` : ""}`);
          break;
        case "done":
          out.push(`${styleText("green", S_STEP_SUBMIT)}  ${s.end}${last !== undefined ? `  ${dim(last)}` : ""}`);
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
      if (s.state === "done" && was !== "done") {
        const last = s.tail.at(-1);
        this.output.write(`${styleText("green", S_STEP_SUBMIT)}  ${s.end}${last !== undefined ? `  ${dim(last)}` : ""}\n`);
      }
    }
  }

}

// --- screens ---------------------------------------------------------------

function selectItem(e: ManifestEntry): SelectItem {
  const where = e.paths.length > 0 ? e.paths.join(", ") : "reinstalled on the machine";
  const size = e.bytes > 0 ? fmtBytes(e.bytes) : undefined;
  const install = installFor(e);
  const detail =
    e.rung === "logins"
      ? [where, "ticked: copied into the golden from this machine. unticked: sign in on the machine"]
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
  };
}

function rungIntro(rung: Rung): string | undefined {
  return rung === "logins" ? "Each tick copies that login into the golden from this machine. Leave one unticked to sign in on the machine yourself, in the browser, next." : undefined;
}

function detectionNote(manifest: Manifest, source: string): string[] {
  if (manifest.entries.length === 0) {
    return ["Found nothing to bring from this machine.", "Pass --manifest <path> to list what should come along."];
  }
  const lines: string[] = [];
  for (const rung of RUNGS) {
    const entries = manifest.entries.filter(e => e.rung === rung);
    if (entries.length === 0) continue;
    const bytes = entries.reduce((n, e) => n + e.bytes, 0);
    lines.push(`${RUNG_TITLE[rung].padEnd(12)} ${String(entries.length).padStart(3)}${bytes > 0 ? `  ${fmtBytes(bytes)}` : ""}`);
  }
  lines.push("", `${manifest.entries.length} things ${source}`);
  return lines;
}

function summaryNote(manifest: Manifest, ticks: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  for (const rung of RUNGS) {
    const entries = manifest.entries.filter(e => e.rung === rung);
    if (entries.length === 0) continue;
    const on = entries.filter(e => ticks.has(e.id));
    const bytes = on.reduce((n, e) => n + e.bytes, 0);
    lines.push(`${RUNG_TITLE[rung]}  ${on.length} of ${entries.length}${bytes > 0 ? `, ${fmtBytes(bytes)}` : ""}`);
    if (on.length > 0) lines.push(...on.map(e => `  ${e.label}`));
  }
  const installs = manifest.entries.filter(e => ticks.has(e.id) && installFor(e) !== undefined);
  lines.push("", installs.length > 0 ? `The machine installs: ${installs.map(e => e.label).join(", ")}.` : "The machine installs nothing; it boots bare.");
  lines.push("Ticked files are recorded in the recipe; copying them onto the machine lands with golden import.");
  return lines;
}

async function tickRungs(manifest: Manifest, io: InitIO): Promise<Set<string> | "cancel"> {
  const answers = new Map<Rung, Set<string>>();
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
    const initial = prior ?? new Set(entries.filter(initialTicks).map(e => e.id));
    const hint = rungIntro(rung);
    if (hint !== undefined && prior === undefined) log.message(dim(hint), { output: io.output, symbol: dim(S_BAR) });
    const result = await rungSelect({ title: RUNG_TITLE[rung], counter, items: entries.map(selectItem), initial, input: io.input, output: io.output });
    if (result.kind === "cancel") return "cancel";
    answers.set(rung, result.ticks);
    if (result.kind === "back") {
      const idx = rungsWithItems.indexOf(rung);
      i = idx > 0 ? RUNGS.indexOf(rungsWithItems[idx - 1]!) : i;
      continue;
    }
    i += 1;
  }
  const all = new Set<string>();
  for (const s of answers.values()) for (const id of s) all.add(id);
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
  const interactive = io.isTTY && !opts.yes;
  intro("wsp init", out);

  if (!io.isTTY && !opts.yes) {
    log.error("stdin is not a terminal. Rerun with --yes to take the defaults, and --manifest <path> to say what comes along.", out);
    outro("Nothing was changed.", out);
    return { code: 1 };
  }

  let manifest: Manifest;
  let source: string;
  try {
    if (opts.manifestPath !== undefined) {
      manifest = loadManifest(opts.manifestPath);
      source = `listed in ${opts.manifestPath}`;
    } else {
      manifest = await opts.collect();
      source = "found on this machine";
    }
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e), out);
    return { code: 1 };
  }
  note(detectionNote(manifest, source).join("\n"), "What this machine has", out);

  let ticks: Set<string>;
  if (interactive) {
    const picked = await tickRungs(manifest, io);
    if (picked === "cancel") {
      cancel("Nothing was changed.", out);
      return { code: 1 };
    }
    ticks = picked;
  } else {
    ticks = new Set(manifest.entries.filter(initialTicks).map(e => e.id));
  }

  note(summaryNote(manifest, ticks).join("\n"), "Summary", out);
  if (interactive) {
    const go = await confirm({ message: "Boot a machine on your Solari account and build this? It bills while it runs.", initialValue: false, input: io.input, output: io.output });
    if (isCancel(go) || !go) {
      cancel("Nothing was changed.", out);
      return { code: 1 };
    }
  } else {
    log.step("Boot a machine on your Solari account and build this: taken as yes (--yes).", out);
  }

  const path = recipePath(opts.statePath);
  saveRecipe(path, manifest, ticks);
  log.info(`Recipe saved to ${path}. Rerun with wsp init --manifest ${path} --yes to build it again.`, out);

  const bring = manifest.entries.filter(e => ticks.has(e.id));
  const rt = opts.runtime(goldenRecipeFor(bring, opts.keys));
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

  const handle = await opts.host(rt, builder);
  const url = `http://127.0.0.1:${handle.port}/`;
  await handoff(url, handle, io, interactive, out);
  outro(`Finish on the machine's terminal in the browser: sign in to what you left unticked, then save it as your golden image.\n${dim(S_BAR)}  Recipe: ${path}`, out);
  return { code: 0, handle };
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
