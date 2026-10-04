// SPDX-License-Identifier: AGPL-3.0-only
// The commands a slate starts and the secrets a person types into one (07-runs, 08-secrets). slates.ts owns the
// record, the batch and the values; this file owns the processes, the approvals they wait on, the timers that start
// them, and the plaintext of every secret, which leaves this file only as a command's environment or stdin and
// comes back out of every output scrubbed. A run here is a cmd run on this computer: bash -c with the agent's text as
// one argument, values as environment, positional parameters or stdin, never spliced into the text.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { writeOwn } from "@wsp/own-file";
import { EXEC_DEADLINE_EXIT, EXEC_OUTPUT_MAX, EXEC_TIMEOUT_MAX_MS, runOutputTail } from "@wsp/protocol";
import type { SlateJson } from "@wsp/protocol";

export type RunState = "idle" | "held" | "running" | "done" | "failed" | "cancelled";

/** What `$name` reads while and after the run (02, "Runs"). Written whole at every change; scrubbed and capped. */
export interface RunRecord {
  state: RunState;
  why?: string;
  exit?: number | null;
  out?: string;
  err?: string;
  json?: SlateJson;
  lines?: string[];
  startedAt?: number;
  endedAt?: number;
  ms?: number;
  runs: number;
  cut?: true;
  /** Running again with the last result kept beside it until the new one replaces it. */
  refreshing?: true;
  /** A tool answered with text alone, no structured result. */
  text?: true;
}

/** What a run that ran left for `$name` to read, kept on its record while it runs again. */
export type RunResult = Pick<RunRecord, "exit" | "out" | "err" | "json" | "lines" | "endedAt" | "ms" | "cut">;

/** What `$token` reads. The plaintext never leaves the store but as a run's environment or stdin. */
export interface SecretHandle {
  secret: true;
  set: boolean;
  len: number;
  at: number | null;
}

/** A cmd run as the agent declared it. `env`, `args` and `stdin` are the declaration's own expressions, read only
 * for the approval key: which expression fills a name is part of what the person approves. */
export interface CmdRunDecl {
  kind: "cmd";
  cmd: string;
  env?: Record<string, unknown>;
  args?: unknown[];
  stdin?: unknown;
  on?: "thread" | "host";
  cwd?: string;
  timeout?: number;
  stream?: boolean;
  confirm?: string;
  every?: number;
  always?: boolean;
  once?: boolean;
  /** A literal command that reads the raw result on stdin and prints the JSON the record's json becomes. */
  then?: string;
}

/** One value as it reaches a command, evaluated by the host at the moment the run starts. A secret is named, never
 * resolved by the caller: the plaintext is put in place here and nowhere else. */
export type RunInput = { value: SlateJson } | { secret: string };

export interface RunInputs {
  env?: Record<string, RunInput>;
  args?: RunInput[];
  stdin?: RunInput;
}

export type RunBy = "person" | "agent" | "reaction" | "timer";

export interface RunStart {
  threadId: string;
  run: string;
  decl: CmdRunDecl;
  by: RunBy;
  /** The thread's folder; `cwd` is read against it. */
  folder: string;
  /** Read when the command actually starts, which for a held run is when the person approves it. */
  inputs: () => RunInputs;
  /** The host's record of the run, for a run this process has not seen yet: how many times it started and the last
   * result a start keeps. */
  last?: RunRecord;
}

/** What the approval sheet shows. A secret's value is dots. */
export interface RunAsk {
  run: string;
  key: string;
  cmd: string;
  env: Record<string, string>;
  args: string[];
  stdin?: string;
  folder: string;
  on: "thread" | "host";
  timeout: number;
  confirm?: string;
  then?: string;
}

/** A reshape's answer: the JSON it printed, or why it failed with what it said on stderr. */
export type ReshapeAnswer = { json: SlateJson } | { why: string; exit: number | null; err: string };

export interface Reshape {
  done: Promise<ReshapeAnswer>;
  kill(): void;
}

export type RunStartAnswer =
  | { outcome: "running"; record: RunRecord }
  | { outcome: "held"; record: RunRecord; ask?: RunAsk }
  | { outcome: "noop"; record: RunRecord }
  | { outcome: "failed"; record: RunRecord };

/** Where "Always in this thread" is kept. The host backs it with the slate record's consents; the default is memory. */
export interface RunApprovals {
  has(threadId: string, key: string): boolean;
  allow(threadId: string, key: string): void;
  revoke(threadId: string, key: string): void;
  list(threadId: string): string[];
}

export interface SlateRunsDeps {
  /** The person's login environment on this computer. Every WSP_ variable is dropped from it before a run sees it. */
  env: () => Readonly<Record<string, string>>;
  /** Every change of a run's record, scrubbed: the host writes it as the run's value in one batch. */
  onRecord: (threadId: string, run: string, record: RunRecord) => void;
  /** Each line a `stream` run prints, scrubbed, as it is printed. */
  onLine?: (threadId: string, run: string, line: string, stream: "out" | "err") => void;
  /** A timer wants its run started; the host starts it with `by: "timer"` through its batch. */
  onTimer?: (threadId: string, run: string) => void;
  approvals?: RunApprovals;
  /** `slates.secrets.json` beside the state file, for secrets declared `keep`. Unset keeps nothing on disk. */
  secretsFile?: string;
  now?: () => number;
}

export interface SlateSecrets {
  /** The person typed it. An empty text clears it. */
  set(threadId: string, name: string, plaintext: string, opts?: { keep?: boolean }): SecretHandle;
  clear(threadId: string, name: string): SecretHandle;
  handle(threadId: string, name: string): SecretHandle;
  /** One secret, or every secret of the thread: a dropped declaration, "Forget secrets", a deleted thread. */
  forget(threadId: string, name?: string): void;
  /** Every filled secret of the thread replaced by `[secret:name]`, exact, base64 and URL-encoded. */
  scrub(threadId: string, text: string): string;
  /** The plaintext, for a tool run's arguments at the moment of the call and nowhere else. */
  plaintext(threadId: string, name: string): string | undefined;
}

export interface SlateRuns {
  /** The approval key: kind, text, env names and the expressions filling them, args and stdin expressions, on,
   * cwd, stream, every and always. A changed value is the same key; a changed declaration is a new one. */
  key(decl: CmdRunDecl): string;
  start(req: RunStart): RunStartAnswer;
  /** The person's answer to a held run: "Run once" or "Always in this thread" starts it now. */
  approve(threadId: string, run: string, scope: "once" | "always"): RunStartAnswer | undefined;
  /** "Don't": the held run ends cancelled, so its `done` reactions fire. */
  deny(threadId: string, run: string): void;
  revoke(threadId: string, key: string): void;
  allowed(threadId: string): string[];
  /** The held runs of a thread with what their sheets show, for a tab that opens on them. */
  held(threadId: string): RunAsk[];
  cancel(threadId: string, run: string): void;
  /** Every run of the thread killed. `quiet` drops their completions and writes nothing, for a rewind, whose
   * restored values say what the runs were. */
  stopAll(threadId: string, opts?: { quiet?: boolean; why?: string }): void;
  /** The declared timers of a slate; replaces what it had. */
  /** The declared timers of a slate; replaces what it had. A timer whose key, every and always are unchanged keeps
   * its period; a new or changed one fires at once. */
  timers(threadId: string, timers: { run: string; every: number; key: string; always?: boolean }[]): void;
  /** Whether any window shows the slate. Shown-only timers tick only while it is; `always` ones regardless. */
  shown(threadId: string, shown: boolean): void;
  /** The person pressed, or the agent wrote: a run held by the start budget may start again. */
  release(threadId: string): void;
  /** A run's `then`: the literal command on this computer with the raw result, already scrubbed, on its stdin. */
  reshape(threadId: string, cmd: string, input: string, folder: string, timeoutS?: number): Reshape;
  secrets: SlateSecrets;
  /** The thread is gone: its runs, timers, approvals in memory and secrets with it. */
  drop(threadId: string): void;
  close(): void;
}

/** Runs `then` under bash -c in `cwd` with `input` on stdin; its stdout must parse as JSON. Output is capped as a
 * run's, scrubbed, and the whole group dies at the deadline or on kill. */
export function reshapeResult(o: { cmd: string; input: string; cwd: string; env: Record<string, string>; timeoutS: number; scrub: (text: string) => string }): Reshape {
  const child = spawn("bash", ["-c", o.cmd], { cwd: o.cwd, env: o.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
  let total = 0;
  const take = (stream: "out" | "err") => (chunk: Buffer): void => {
    const room = Math.max(0, EXEC_OUTPUT_MAX - total);
    total += Math.min(room, chunk.length);
    if (room > 0) chunks[stream].push(chunk.subarray(0, room));
  };
  child.stdout?.on("data", take("out"));
  child.stderr?.on("data", take("err"));
  child.stdin?.on("error", () => {});
  child.stdin?.end(o.input);
  let timedOut = false;
  const kill = (): void => {
    if (child.pid !== undefined) killGroup(child.pid);
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    kill();
  }, o.timeoutS * 1_000);
  const done = new Promise<ReshapeAnswer>(settle => {
    let ended = false;
    const end = (code: number | null, error?: Error): void => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      kill();
      const err = runOutputTail(o.scrub(Buffer.concat(chunks.err).toString("utf8")));
      if (error !== undefined) return settle({ why: `then could not start: ${o.scrub(error.message)}`, exit: null, err });
      if (timedOut) return settle({ why: `then timed out after ${o.timeoutS} s`, exit: EXEC_DEADLINE_EXIT, err });
      if (code !== 0) return settle({ why: `then exited with ${code ?? "a signal"}`, exit: code, err });
      const out = o.scrub(Buffer.concat(chunks.out).toString("utf8"));
      try {
        settle({ json: JSON.parse(out) as SlateJson });
      } catch {
        settle({ why: `then printed no JSON${out.trim() === "" ? "" : `: ${out.trim().split("\n")[0]!.slice(0, 120)}`}`, exit: 0, err });
      }
    };
    child.on("error", e => end(null, e));
    child.on("close", code => end(code));
  });
  return { done, kill };
}

const RESULT_FIELDS = ["exit", "out", "err", "json", "lines", "endedAt", "ms", "cut"] as const;

/** The result a record holds, where it is one a command left by running. */
export function lastResult(record: RunRecord): RunResult | undefined {
  const ran = record.state === "running" ? record.refreshing === true : record.startedAt !== undefined && (record.state === "done" || record.state === "failed" || record.state === "cancelled");
  return ran ? (Object.fromEntries(RESULT_FIELDS.filter(f => record[f] !== undefined).map(f => [f, record[f]])) as RunResult) : undefined;
}

/** The record of a start: running, with the last result kept until this one ends. */
export function runningRecord(last: RunResult | undefined, runs: number, startedAt: number): RunRecord {
  return last === undefined ? { state: "running", runs, startedAt } : { ...last, state: "running", runs, startedAt, refreshing: true };
}

/** A running record ended from outside, its kept result gone with the start that kept it. */
function endedRecord(record: RunRecord, state: "failed" | "cancelled", why: string, now: number): RunRecord {
  return { state, why, exit: null, runs: record.runs, ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}), endedAt: now };
}

/** A record that read running when the host stopped: nothing is running now, and nothing restarts by itself. */
export function restartedRecord(record: RunRecord, now: number = Date.now()): RunRecord {
  return record.state === "running" ? endedRecord(record, "failed", "the host restarted while it ran", now) : record;
}

/** A record a rewind restores that read running at that turn's end. */
export function rewoundRecord(record: RunRecord, now: number = Date.now()): RunRecord {
  return record.state === "running" ? endedRecord(record, "cancelled", "the thread was rewound", now) : record;
}

const DEFAULT_TIMEOUT_S = 60;
const LINES_KEPT = 500;
const RUNNING_MAX = 4;
const STARTS_PER_MINUTE = 12;
const TIMER_FLOOR_S = 10;
/** After the leader exits and its group is killed, how long the pipes get to close before the run ends anyway: a
 * process that left the group with setsid can hold them open for as long as it lives. */
const CLOSE_GRACE_MS = 1_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOTS = "••••";

const HELD_APPROVAL = "needs your approval";
const HELD_BUSY = `${RUNNING_MAX} runs are already running`;
const HELD_BUDGET = `started ${STARTS_PER_MINUTE} times in a minute; press to run it again`;
const SECRET_IN_ARGS = "a secret reaches a command through env or stdin, never as an argument, which ps can read";

type HeldFor = "approval" | "busy" | "budget";

interface Live {
  record: RunRecord;
  /** Bumped by every start and cancel, so a completion of an instance nobody is waiting for any more is dropped. */
  gen: number;
  /** The last result, kept through holds so the next start carries it. */
  result?: RunResult;
  pid?: number;
  /** The run's `then`, while it reshapes the result. */
  reshaping?: Reshape;
  held?: { req: RunStart; for: HeldFor };
  /** When reactions and timers started it, for the start budget. */
  starts: number[];
}

interface ThreadRuns {
  runs: Map<string, Live>;
  /** Runs held because four were running, in the order they asked. */
  queue: string[];
  timers: Map<string, { every: number; key: string; always: boolean; handle?: ReturnType<typeof setInterval> }>;
  shown: boolean;
}

interface Kept {
  text: string;
  at: number;
  keep: boolean;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function asText(value: SlateJson): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return;
  }
}

/** Every text a command could print a secret as: itself, base64 (standard and URL-safe, padded or not, and the
 * stable middle of the secret inside a longer base64 run such as a Basic header), and URL-encoded. */
function secretForms(text: string): string[] {
  const forms = new Set<string>([text]);
  const bytes = Buffer.from(text, "utf8");
  const b64 = (b: Buffer): string[] => {
    const std = b.toString("base64");
    const url = std.replace(/\+/g, "-").replace(/\//g, "_");
    return [std, std.replace(/=+$/, ""), url, url.replace(/=+$/, "")];
  };
  for (const f of b64(bytes)) forms.add(f);
  for (const shift of [0, 1, 2]) {
    const all = Buffer.concat([Buffer.alloc(shift), bytes]).toString("base64");
    const from = shift === 0 ? 0 : 4;
    const to = Math.floor((shift + bytes.length) / 3) * 4;
    const middle = all.slice(from, to);
    if (middle.length < 8) continue;
    forms.add(middle);
    forms.add(middle.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  const url = encodeURIComponent(text);
  forms.add(url);
  forms.add(url.replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()));
  forms.add(url.replace(/%20/g, "+"));
  forms.delete("");
  return [...forms];
}

class DefaultApprovals implements RunApprovals {
  private readonly allowed = new Map<string, Set<string>>();
  has(threadId: string, key: string): boolean {
    return this.allowed.get(threadId)?.has(key) ?? false;
  }
  allow(threadId: string, key: string): void {
    const keys = this.allowed.get(threadId) ?? new Set<string>();
    keys.add(key);
    this.allowed.set(threadId, keys);
  }
  revoke(threadId: string, key: string): void {
    this.allowed.get(threadId)?.delete(key);
  }
  list(threadId: string): string[] {
    return [...(this.allowed.get(threadId) ?? [])];
  }
}

function createSecrets(file: string | undefined, now: () => number): SlateSecrets {
  const held = new Map<string, Map<string, Kept>>();
  if (file !== undefined && existsSync(file)) {
    try {
      const read = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, { text: string; at: number }>>;
      for (const [threadId, names] of Object.entries(read)) {
        held.set(threadId, new Map(Object.entries(names).map(([name, k]) => [name, { text: k.text, at: k.at, keep: true }])));
      }
    } catch {
      // An unreadable file holds nothing this host can use; the slates ask for their secrets again.
    }
  }
  const save = (): void => {
    if (file === undefined) return;
    const out: Record<string, Record<string, { text: string; at: number }>> = {};
    for (const [threadId, names] of held) {
      for (const [name, k] of names) if (k.keep) (out[threadId] ??= {})[name] = { text: k.text, at: k.at };
    }
    writeOwn(dirname(file), basename(file), JSON.stringify(out));
  };
  const handle = (threadId: string, name: string): SecretHandle => {
    const k = held.get(threadId)?.get(name);
    return k === undefined ? { secret: true, set: false, len: 0, at: null } : { secret: true, set: true, len: k.text.length, at: k.at };
  };
  const forget = (threadId: string, name?: string): void => {
    const names = held.get(threadId);
    if (names === undefined) return;
    const kept = name === undefined ? [...names.values()].some(k => k.keep) : names.get(name)?.keep === true;
    if (name === undefined) held.delete(threadId);
    else names.delete(name);
    if (kept) save();
  };
  return {
    set(threadId, name, plaintext, opts) {
      if (plaintext === "") {
        forget(threadId, name);
        return handle(threadId, name);
      }
      const names = held.get(threadId) ?? new Map<string, Kept>();
      const was = names.get(name)?.keep === true;
      const keep = opts?.keep === true;
      names.set(name, { text: plaintext, at: now(), keep });
      held.set(threadId, names);
      if (keep || was) save();
      return handle(threadId, name);
    },
    clear(threadId, name) {
      forget(threadId, name);
      return handle(threadId, name);
    },
    handle,
    forget,
    scrub(threadId, text) {
      const names = held.get(threadId);
      if (names === undefined || text === "") return text;
      const forms: [string, string][] = [];
      for (const [name, k] of names) for (const f of secretForms(k.text)) forms.push([f, `[secret:${name}]`]);
      forms.sort((a, b) => b[0].length - a[0].length);
      let out = text;
      for (const [form, mark] of forms) if (out.includes(form)) out = out.split(form).join(mark);
      return out;
    },
    plaintext(threadId, name) {
      return held.get(threadId)?.get(name)?.text;
    },
  };
}

export function createSlateRuns(deps: SlateRunsDeps): SlateRuns {
  const now = deps.now ?? Date.now;
  const approvals = deps.approvals ?? new DefaultApprovals();
  const secrets = createSecrets(deps.secretsFile, now);
  const threads = new Map<string, ThreadRuns>();

  const thread = (threadId: string): ThreadRuns => {
    let t = threads.get(threadId);
    if (t === undefined) {
      t = { runs: new Map(), queue: [], timers: new Map(), shown: false };
      threads.set(threadId, t);
    }
    return t;
  };
  const live = (threadId: string, run: string, last?: RunRecord): Live => {
    const t = thread(threadId);
    let l = t.runs.get(run);
    if (l === undefined) {
      const result = last === undefined ? undefined : lastResult(last);
      l = { record: { state: "idle", runs: last?.runs ?? 0 }, gen: 0, starts: [], ...(result !== undefined ? { result } : {}) };
      t.runs.set(run, l);
    }
    return l;
  };
  const write = (threadId: string, run: string, l: Live, record: RunRecord): RunRecord => {
    l.record = record;
    const result = record.state === "running" ? undefined : lastResult(record);
    if (result !== undefined) l.result = result;
    deps.onRecord(threadId, run, record);
    return record;
  };
  const loginEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(deps.env())) if (!name.startsWith("WSP_")) env[name] = value;
    return env;
  };
  const reshape = (threadId: string, cmd: string, input: string, folder: string, timeoutS = DEFAULT_TIMEOUT_S): Reshape =>
    reshapeResult({ cmd, input, cwd: existsSync(folder) ? folder : process.cwd(), env: loginEnv(), timeoutS, scrub: text => secrets.scrub(threadId, text) });
  const running = (t: ThreadRuns): number => [...t.runs.values()].filter(l => l.record.state === "running").length;

  const key = (decl: CmdRunDecl): string => {
    const env = Object.entries(decl.env ?? {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, expr]) => [name, stableJson(expr)]);
    const what = [decl.kind, decl.cmd, env, (decl.args ?? []).map(stableJson), decl.stdin === undefined ? null : stableJson(decl.stdin), decl.on ?? "thread", decl.cwd ?? "", decl.stream === true, decl.every ?? null, decl.always === true, ...(decl.then !== undefined ? [decl.then] : [])];
    return createHash("sha256").update(JSON.stringify(what)).digest("hex").slice(0, 32);
  };

  const shown = (threadId: string, input: RunInput): string =>
    "secret" in input ? (secrets.handle(threadId, input.secret).set ? DOTS : `${DOTS} (not filled)`) : input.value === null ? "(unset)" : asText(input.value);

  const ask = (req: RunStart): RunAsk => {
    const inputs = req.inputs();
    const stdin = inputs.stdin === undefined ? undefined : shown(req.threadId, inputs.stdin).split("\n")[0];
    return {
      run: req.run,
      key: key(req.decl),
      cmd: req.decl.cmd,
      env: Object.fromEntries(Object.entries(inputs.env ?? {}).map(([name, input]) => [name, shown(req.threadId, input)])),
      args: (inputs.args ?? []).map(input => shown(req.threadId, input)),
      ...(stdin !== undefined ? { stdin } : {}),
      folder: req.decl.cwd === undefined ? req.folder : resolve(req.folder, req.decl.cwd),
      on: req.decl.on ?? "thread",
      timeout: timeoutOf(req.decl),
      ...(req.decl.confirm !== undefined ? { confirm: req.decl.confirm } : {}),
      ...(req.decl.then !== undefined ? { then: req.decl.then } : {}),
    };
  };

  const hold = (req: RunStart, l: Live, why: HeldFor): RunStartAnswer => {
    l.held = { req, for: why };
    const t = thread(req.threadId);
    if (why === "busy" && !t.queue.includes(req.run)) t.queue.push(req.run);
    const record = write(req.threadId, req.run, l, { state: "held", why: why === "approval" ? HELD_APPROVAL : why === "busy" ? HELD_BUSY : HELD_BUDGET, runs: l.record.runs });
    return why === "approval" ? { outcome: "held", record, ask: ask(req) } : { outcome: "held", record };
  };

  const fail = (req: RunStart, l: Live, why: string): RunStartAnswer => {
    const at = now();
    const record = write(req.threadId, req.run, l, { state: "failed", why, exit: null, runs: l.record.runs, endedAt: at });
    return { outcome: "failed", record };
  };

  const next = (threadId: string): void => {
    const t = thread(threadId);
    while (t.queue.length > 0 && running(t) < RUNNING_MAX) {
      const run = t.queue.shift()!;
      const l = t.runs.get(run);
      if (l?.held?.for !== "busy") continue;
      const req = l.held.req;
      delete l.held;
      launch(req, l);
    }
  };

  const launch = (req: RunStart, l: Live): RunStartAnswer => {
    const { threadId, run, decl } = req;
    const t = thread(threadId);
    if (running(t) >= RUNNING_MAX) return hold(req, l, "busy");
    const inputs = req.inputs();
    if ((inputs.args ?? []).some(input => "secret" in input)) return fail(req, l, SECRET_IN_ARGS);
    const env = loginEnv();
    for (const [name, input] of Object.entries(inputs.env ?? {})) {
      if (!ENV_NAME.test(name)) return fail(req, l, `${name} is not a name an environment variable can have`);
      const text = "secret" in input ? secrets.plaintext(threadId, input.secret) : input.value === null ? undefined : asText(input.value);
      if (text === undefined) delete env[name];
      else env[name] = text;
    }
    const args = (inputs.args ?? []).map(input => ("secret" in input ? "" : asText(input.value)));
    const stdin = inputs.stdin === undefined ? undefined : "secret" in inputs.stdin ? (secrets.plaintext(threadId, inputs.stdin.secret) ?? "") : asText(inputs.stdin.value);
    const cwd = decl.cwd === undefined ? req.folder : resolve(req.folder, decl.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return fail(req, l, `the folder ${cwd} does not exist`);
    const timeout = timeoutOf(decl);

    const gen = ++l.gen;
    const startedAt = now();
    const runs = l.record.runs + 1;
    const record = write(threadId, run, l, runningRecord(l.result, runs, startedAt));

    const child = spawn("bash", ["-c", decl.cmd, "bash", ...args], { cwd, env, detached: true, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    l.pid = child.pid;
    const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
    let total = 0;
    let cut = false;
    const lines: string[] = [];
    const partial = { out: "", err: "" };
    const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
    const line = (stream: "out" | "err", text: string): void => {
      const clean = secrets.scrub(threadId, text);
      lines.push(clean);
      if (lines.length > LINES_KEPT) lines.shift();
      if (l.gen === gen) deps.onLine?.(threadId, run, clean, stream);
    };
    const take = (stream: "out" | "err") => (chunk: Buffer): void => {
      if (total + chunk.length > EXEC_OUTPUT_MAX) {
        cut = true;
        chunk = chunk.subarray(0, Math.max(0, EXEC_OUTPUT_MAX - total));
      }
      total += chunk.length;
      if (chunk.length === 0) return;
      chunks[stream].push(chunk);
      if (decl.stream !== true) return;
      const parts = (partial[stream] + decoders[stream].write(chunk)).split("\n");
      partial[stream] = parts.pop() ?? "";
      for (const p of parts) line(stream, p);
    };
    child.stdout?.on("data", take("out"));
    child.stderr?.on("data", take("err"));
    if (child.stdin !== null) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }

    let timedOut = false;
    let ended = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killGroup(child.pid);
    }, timeout * 1_000);

    const end = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      if (grace !== undefined) clearTimeout(grace);
      if (child.pid !== undefined) killGroup(child.pid);
      if (l.gen !== gen) return;
      delete l.pid;
      if (decl.stream === true) {
        for (const stream of ["out", "err"] as const) {
          const rest = partial[stream] + decoders[stream].end();
          if (rest !== "") line(stream, rest);
        }
      }
      const raw = secrets.scrub(threadId, Buffer.concat(chunks.out).toString("utf8"));
      const out = runOutputTail(raw);
      const err = runOutputTail(secrets.scrub(threadId, Buffer.concat(chunks.err).toString("utf8")));
      let json: SlateJson | undefined;
      if (out.trim() !== "") {
        try {
          json = JSON.parse(out) as SlateJson;
        } catch {
          json = undefined;
        }
      }
      const exit = timedOut ? EXEC_DEADLINE_EXIT : code;
      const why = error !== undefined ? secrets.scrub(threadId, error.message) : timedOut ? `timed out after ${timeout} s` : exit === 0 ? undefined : exit === null ? `ended by ${signal ?? "a signal"}` : `exited with ${exit}`;
      const finish = (fields: Pick<RunRecord, "state" | "why" | "exit" | "err" | "json">): void => {
        const endedAt = now();
        write(threadId, run, l, {
          ...fields,
          out,
          ...(decl.stream === true ? { lines: [...lines] } : {}),
          startedAt,
          endedAt,
          ms: endedAt - startedAt,
          runs,
          ...(cut ? { cut: true as const } : {}),
        });
        next(threadId);
      };
      const ok = exit === 0 && error === undefined;
      if (!ok || decl.then === undefined) {
        finish({ state: ok ? "done" : "failed", ...(why !== undefined ? { why } : {}), exit, err, ...(json !== undefined ? { json } : {}) });
        return;
      }
      const shaping = reshape(threadId, decl.then, raw, cwd, timeout);
      l.reshaping = shaping;
      void shaping.done.then(answer => {
        if (l.gen !== gen) return;
        delete l.reshaping;
        finish("json" in answer ? { state: "done", exit, err, json: answer.json } : { state: "failed", why: answer.why, exit: answer.exit, err: answer.err });
      });
    };
    child.on("error", e => end(null, null, e));
    child.on("exit", (code, signal) => {
      // What the leader left running in its group goes with it, and the pipes close once it has.
      if (child.pid !== undefined) killGroup(child.pid);
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        end(code, signal);
      }, CLOSE_GRACE_MS);
    });
    child.on("close", (code, signal) => end(code, signal));
    return { outcome: "running", record };
  };

  const stop = (threadId: string, run: string, l: Live, why: string | undefined): void => {
    const was = l.record.state;
    l.gen += 1;
    if (l.pid !== undefined) killGroup(l.pid);
    delete l.pid;
    l.reshaping?.kill();
    delete l.reshaping;
    delete l.held;
    const t = thread(threadId);
    t.queue = t.queue.filter(r => r !== run);
    if (why === undefined || (was !== "running" && was !== "held")) return;
    const endedAt = now();
    write(threadId, run, l, {
      state: "cancelled",
      why,
      exit: null,
      runs: l.record.runs,
      ...(l.record.startedAt !== undefined && was === "running" ? { startedAt: l.record.startedAt, ms: endedAt - l.record.startedAt } : {}),
      endedAt,
    });
  };

  const tick = (threadId: string): void => {
    const t = thread(threadId);
    for (const [run, timer] of t.timers) {
      const on = timer.always || t.shown;
      if (on && timer.handle === undefined) {
        deps.onTimer?.(threadId, run);
        timer.handle = setInterval(() => deps.onTimer?.(threadId, run), Math.max(timer.every, TIMER_FLOOR_S) * 1_000);
        timer.handle.unref();
      } else if (!on && timer.handle !== undefined) {
        clearInterval(timer.handle);
        delete timer.handle;
      }
    }
  };
  const clearTimers = (t: ThreadRuns): void => {
    for (const timer of t.timers.values()) if (timer.handle !== undefined) clearInterval(timer.handle);
    t.timers.clear();
  };

  return {
    key,
    start(req) {
      const l = live(req.threadId, req.run, req.last);
      if (l.record.state === "running") {
        if (req.decl.once === true) return { outcome: "noop", record: l.record };
        stop(req.threadId, req.run, l, undefined);
      }
      delete l.held;
      if (req.by !== "person") {
        const at = now();
        l.starts = l.starts.filter(s => at - s < 60_000);
        if (l.starts.length >= STARTS_PER_MINUTE) return hold(req, l, "budget");
        l.starts.push(at);
      }
      if (req.decl.confirm !== undefined || !approvals.has(req.threadId, key(req.decl))) return hold(req, l, "approval");
      return launch(req, l);
    },
    approve(threadId, run, scope) {
      const l = threads.get(threadId)?.runs.get(run);
      if (l?.held?.for !== "approval") return undefined;
      const req = l.held.req;
      delete l.held;
      if (scope === "always") approvals.allow(threadId, key(req.decl));
      return launch(req, l);
    },
    deny(threadId, run) {
      const l = threads.get(threadId)?.runs.get(run);
      if (l?.held === undefined) return;
      stop(threadId, run, l, "you said not to run it");
    },
    revoke: (threadId, k) => approvals.revoke(threadId, k),
    allowed: threadId => approvals.list(threadId),
    held(threadId) {
      return [...(threads.get(threadId)?.runs.values() ?? [])].flatMap(l => (l.held?.for === "approval" ? [ask(l.held.req)] : []));
    },
    cancel(threadId, run) {
      const l = threads.get(threadId)?.runs.get(run);
      if (l === undefined) return;
      stop(threadId, run, l, "cancelled");
      next(threadId);
    },
    stopAll(threadId, opts) {
      const t = threads.get(threadId);
      if (t === undefined) return;
      for (const [run, l] of t.runs) stop(threadId, run, l, opts?.quiet === true ? undefined : (opts?.why ?? "cancelled"));
    },
    timers(threadId, list) {
      const t = thread(threadId);
      const kept = new Map([...t.timers].filter(([run, was]) => list.some(n => n.run === run && n.key === was.key && n.every === was.every && (n.always === true) === was.always)));
      for (const [run, timer] of t.timers) if (!kept.has(run) && timer.handle !== undefined) clearInterval(timer.handle);
      t.timers = kept;
      for (const timer of list) if (!kept.has(timer.run)) t.timers.set(timer.run, { every: timer.every, key: timer.key, always: timer.always === true });
      tick(threadId);
    },
    shown(threadId, on) {
      const t = thread(threadId);
      t.shown = on;
      tick(threadId);
    },
    reshape,
    release(threadId) {
      for (const l of threads.get(threadId)?.runs.values() ?? []) l.starts = [];
    },
    secrets: {
      set: secrets.set,
      clear: secrets.clear,
      handle: secrets.handle,
      forget: secrets.forget,
      scrub: secrets.scrub,
      plaintext: secrets.plaintext,
    },
    drop(threadId) {
      const t = threads.get(threadId);
      if (t !== undefined) {
        for (const [run, l] of t.runs) stop(threadId, run, l, undefined);
        clearTimers(t);
        threads.delete(threadId);
      }
      for (const k of approvals.list(threadId)) approvals.revoke(threadId, k);
      secrets.forget(threadId);
    },
    close() {
      for (const [threadId, t] of threads) {
        for (const [run, l] of t.runs) stop(threadId, run, l, undefined);
        clearTimers(t);
      }
      threads.clear();
    },
  };
}

function timeoutOf(decl: CmdRunDecl): number {
  return Math.min(Math.max(decl.timeout ?? DEFAULT_TIMEOUT_S, 1), EXEC_TIMEOUT_MAX_MS / 1_000);
}
