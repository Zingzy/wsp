// SPDX-License-Identifier: AGPL-3.0-only
// The commands a slate starts and the secrets a person types into one (07-runs, 08-secrets). slates.ts owns the
// record, the batch and the values; this file owns the processes, the approvals they wait on, the timers that start
// them, and the plaintext of every secret, which leaves this file only as a command's environment or stdin and
// comes back out of every output scrubbed. A run here is a cmd run on this computer: bash -c with the agent's text as
// one argument, values as environment, positional parameters or stdin, never spliced into the text.
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
}

/** What `$token` reads. The plaintext never leaves the store but as a run's environment or stdin. */
export interface SecretHandle {
  secret: true;
  set: boolean;
  len: number;
  at: number;
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
}

/** One value as it reaches a command, evaluated by the host at the moment the run starts. A secret is named, never
 * resolved by the caller: the plaintext is put in place here and nowhere else. */
export type RunInput = { value: SlateJson } | { secret: string };

export interface RunInputs {
  env?: Record<string, RunInput>;
  args?: RunInput[];
  stdin?: RunInput;
}

export type RunBy = "person" | "reaction" | "timer";

export interface RunStart {
  threadId: string;
  run: string;
  decl: CmdRunDecl;
  by: RunBy;
  /** The thread's folder; `cwd` is read against it. */
  folder: string;
  /** Read when the command actually starts, which for a held run is when the person approves it. */
  inputs: () => RunInputs;
  /** How many times this run has started in the slate's life, off the host's record, for a run this process has not
   * seen yet. */
  runs?: number;
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
}

export interface SlateRuns {
  /** The approval key: kind, text, env names and the expressions filling them, args and stdin expressions, on,
   * cwd, stream. A changed value is the same key; a changed declaration is a new one. */
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
  timers(threadId: string, timers: { run: string; every: number; always?: boolean }[]): void;
  /** Whether any window shows the slate. Shown-only timers tick only while it is; `always` ones regardless. */
  shown(threadId: string, shown: boolean): void;
  /** The person pressed, or the agent wrote: a run held by the start budget may start again. */
  release(threadId: string): void;
  secrets: SlateSecrets;
  /** The thread is gone: its runs, timers, approvals in memory and secrets with it. */
  drop(threadId: string): void;
  close(): void;
}

/** A record that read running when the host stopped: nothing is running now, and nothing restarts by itself. */
export function restartedRecord(record: RunRecord, now: number = Date.now()): RunRecord {
  return record.state === "running" ? { ...record, state: "failed", why: "the host restarted while it ran", exit: null, endedAt: now } : record;
}

/** A record a rewind restores that read running at that turn's end. */
export function rewoundRecord(record: RunRecord, now: number = Date.now()): RunRecord {
  return record.state === "running" ? { ...record, state: "cancelled", why: "the thread was rewound", exit: null, endedAt: now } : record;
}

export function createSlateRuns(_deps: SlateRunsDeps): SlateRuns {
  throw new Error("slate runs are not built yet");
}
