// SPDX-License-Identifier: AGPL-3.0-only
// A thread's slate on the host, schema 2: one record per thread in the `slates` collection (the document, the live
// values with run records and secret handles, the version, the one-step undo, turn snapshots, approvals), the batch
// every arrival goes through (a window's write, the agent's write, a run's end, a timer, a press), the runs it starts
// through slate-runs.ts, the message a send puts into the thread, and what a restart and a rewind do to a chain in
// flight (01-architecture, 02-model, 09-events). The slate module in @wsp/protocol parses, validates, runs the
// batch's pure core and sketches; this file decides who may write, keeps the record, spawns and tells the windows.
import {
  applySlatePatch,
  evaluateSlateExpression,
  getSlateValue,
  isSlateBinding,
  notFoundRefusal,
  parseSlate,
  parseSlateOwnPath,
  parseSlatePatch,
  printSlate,
  resolveSlateProp,
  runSlateBatch,
  scopeOf,
  sketchSlate,
  slateCatalog,
  slateDependencies,
  slateEqual,
  slateNearest,
  slateStep,
  threadWord,
  usageRefusal,
  validateSlate,
  SLATE_RUN_IDLE,
  type Caller,
  type SessionSlateEvent,
  type SlateAsk,
  type SlateBatchResult,
  type SlateBy,
  type SlateCause,
  type SlateDoc,
  type SlateEmpty,
  type SlateEvalContext,
  type SlateEventAnswer,
  type SlateJson,
  type SlateProblem,
  type SlatePropValue,
  type SlateReadAnswer,
  type SlateRunDecl,
  type SlateRunEvent,
  type SlateRunRecord,
  type SlateStateAnswer,
  type SlateValues,
  type SlateValuesEvent,
  type SlateView,
  type SlateWriteAnswer,
} from "@wsp/protocol";
import type { Store } from "./store.js";
import { createSlateRuns, restartedRecord, rewoundRecord, type CmdRunDecl, type RunAsk, type RunBy, type RunInput, type RunRecord, type SlateRuns, type SlateRunsDeps } from "./slate-runs.js";
import { HOST_SLATE_SOURCES, resolveIn, viewSources, type SlateSourceContext } from "./slate-sources/index.js";

export const SLATES = "slates";

/** The slate's content at one version: what a snapshot, the undo and a rewind keep. */
interface SlateSnap {
  document: SlateDoc | null;
  values: SlateValues;
  empty?: SlateEmpty;
}

/** One approval the person gave, by the run declaration's key; a refusal is kept the same way. */
interface Approval {
  state: "allowed" | "refused";
  at: number;
  run?: string;
  cmd?: string;
}

/** One thread's slate as the store keeps it. Snapshots are kept by version and turns point at them, so a turn in
 * which nothing about the slate changed adds a pointer and no copy. Secrets are handles here, never plaintext. */
export interface SlateRecord extends SlateSnap {
  threadId: string;
  workspaceId: string;
  rootThreadId: string;
  schema: 2;
  /** Moves only when the document does. */
  version: number;
  /** Rises with every batch that moved a value and with every version; orders the pushes, checked by nothing. */
  revision: number;
  previous?: SlateSnap & { version: number };
  /** By turn id, in the order the turns ended; kept is by revision, since values move without the version. */
  turns: Record<string, { at: number; version: number; revision: number }>;
  kept: Record<string, SlateSnap>;
  rewound?: SlateSnap & { version: number; at: number };
  comments: Record<string, SlateJson>[];
  /** By approval key; "Always in this thread" and "Don't" stay, "Run once" is never kept. */
  approvals: Record<string, Approval>;
  /** When the person let this slate message the agent from a reaction (07, "A slate that messages the agent"). */
  sendsAllowed?: number;
  /** Runtime problems the batch and the runs left standing, newest last. */
  problems: SlateProblem[];
  shownOnce: boolean;
  updatedAt: number;
}

/** What the runtime knows of a thread that the slate needs: where it runs, its tree, and the row its events ride. */
export interface SlateThreadFacts {
  workspaceId: string;
  rootThreadId: string;
  sessionId: string;
  /** The running turn, when one runs. */
  turnId?: string;
  /** The folder a run starts in, on this computer. */
  folder?: string;
  /** The computer's own name, for the consent sheet. */
  computer?: string;
}

export interface SlatesDeps {
  store: Store;
  now(): number;
  /** Records an event in the thread's transcript, live to every window. */
  record(event: SessionSlateEvent): void;
  /** Pushes an event to the windows and nowhere else. */
  emit(event: SlateValuesEvent | SlateRunEvent): void;
  thread(threadId: string): SlateThreadFacts | undefined;
  /** Every thread under the lead, the lead included. */
  under(lead: string): string[];
  threadOfToken(token: string): string;
  /** What the source resolvers read for this thread. */
  sources(threadId: string, workspaceId: string): SlateSourceContext;
  /** Puts a send's message into the thread: a start that the runtime steers or queues as it would any send. */
  deliver(o: { threadId: string; workspaceId: string; prompt: string; requestId: string }): Promise<{ outcome: "started" | "steered" | "queued"; turnId?: string }>;
  /** A slate in this workspace now binds the pull request's checks, so the host re-reads it sooner while one is pending. */
  watchPr?(workspaceId: string): void;
  /** The person's login environment a run starts from. */
  runEnv(): Readonly<Record<string, string>>;
  /** Where secrets declared keep are written, beside the state file. */
  secretsFile?: string;
  /** The runs factory; the real one unless a test swaps it. */
  runs?: (d: SlateRunsDeps) => SlateRuns;
}

/** Where a slate op names its thread: a window always, a thread's token by itself, a person's shell inside a turn by
 * that turn's token. */
export interface SlateTarget {
  threadId?: string;
  turnToken?: string;
}

type BatchBy = "person" | "agent" | "reaction" | "run" | "timer" | "host";
interface BatchEvent {
  piece: string;
  kind: "press" | "submit" | "change";
  item?: SlateJson;
  index?: number;
  rowAction?: number;
}
/** A send as the batch hands it over: the step, its values evaluated at the step's moment, and who fired it. */
type BatchSend = SlateBatchResult["sends"][number] & { values?: Record<string, SlateJson>; piece?: string; reaction?: string; by?: string };

const SNAPSHOTS_KEPT = 100;
const SNAPSHOT_BYTES = 8 * 1024 * 1024;
const VALUES_BYTES = 256 * 1024;
const MESSAGE_CHARS = 20_000;
const REQUEST_KEPT_MS = 10 * 60_000;
const PRESS_SEND_MS = 2_000;
const REACTION_SEND_MS = 60_000;
const WRITES_BURST = 20;
const WRITES_PER_SECOND = 5;
const WRITES_PER_HOUR = 600;
const ERRORS_LISTED = 20;
const PROBLEMS_KEPT = 20;
const PIECES_NAMED = 20;
const SOURCE_NAMES = [...HOST_SLATE_SOURCES.keys()];
const HELD_APPROVAL = "needs your approval";
/** The approval key that lets a slate's reactions message the agent. */
export const SLATE_SEND_KEY = "send";

const problem = (code: string, name: string, message: string, extra: Partial<SlateProblem> = {}): SlateProblem => ({ code, name, message, ...extra });

/** A refusal for a reason other than what was written: the version moved, too fast, nothing to undo. */
const refused = (p: SlateProblem, kind: string): Error => Object.assign(new Error(`${p.code} ${p.name}: ${p.message}`), { kind, code: p.code });

/** A write the parser or the validator refused, with every error it found and the warnings beside them. */
function invalid(errors: SlateProblem[], warnings: SlateProblem[]): Error {
  const first = errors[0]!;
  const where = [first.line !== undefined ? `line ${first.line}` : undefined, first.piece !== undefined ? (first.prop !== undefined ? `${first.piece}.${first.prop}` : first.piece) : undefined].filter(w => w !== undefined).join(", ");
  const more = errors.length > ERRORS_LISTED ? `, and ${errors.length - ERRORS_LISTED} more` : "";
  const fix = first.fix !== undefined ? `. Did you mean ${first.fix}?` : "";
  const message = `slate refused: ${errors.length} error${errors.length === 1 ? "" : "s"}${more}; the first: ${where === "" ? "" : `${where}: `}${first.code} ${first.name} ${first.message}${fix}`;
  return Object.assign(new Error(message), { kind: "invalid", errors: errors.slice(0, ERRORS_LISTED), warnings });
}

const usage = (p: SlateProblem): Error => Object.assign(new Error(`${p.code} ${p.name}: ${p.message}`), { kind: "usage", code: p.code });

/** The source names a document or a list of paths reads, read off its text. */
const sourcesNamed = (text: string): string[] => SOURCE_NAMES.filter(name => new RegExp(`\\b${name}\\.`).test(text));

/** A carried value with any line that would read as a second `slate:` line made harmless (12, injection). */
function defanged(value: SlateJson): SlateJson {
  if (typeof value === "string") return value.replace(/^(\s*slate)\s*:(?=\s*\{)/gm, "$1：");
  if (Array.isArray(value)) return value.map(defanged);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, defanged(v)]));
  return value;
}

/** Every string inside a value passed through fn. */
function mapStrings(value: SlateJson, fn: (s: string) => string): SlateJson {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map(v => mapStrings(v, fn));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

/** The longest string inside a value, by the path to it, for cutting a message down to its cap. */
function longest(value: SlateJson, at: (string | number)[] = []): { at: (string | number)[]; length: number } | undefined {
  if (typeof value === "string") return { at, length: value.length };
  const kids = Array.isArray(value) ? value.map((v, i) => longest(v, [...at, i])) : value !== null && typeof value === "object" ? Object.entries(value).map(([k, v]) => longest(v, [...at, k])) : [];
  return kids.reduce<{ at: (string | number)[]; length: number } | undefined>((best, k) => (k !== undefined && (best === undefined || k.length > best.length) ? k : best), undefined);
}

function cutAt(value: SlateJson, at: (string | number)[], keep: number): SlateJson {
  if (at.length === 0) return typeof value === "string" ? `${value.slice(0, keep)} (cut)` : value;
  const [head, ...rest] = at;
  if (Array.isArray(value)) return value.map((v, i) => (i === head ? cutAt(v, rest, keep) : v));
  if (value !== null && typeof value === "object") return { ...value, [head as string]: cutAt(value[head as string]!, rest, keep) };
  return value;
}

/** What each outcome reads as under the pressed piece (09, "Delivery"). */
const SAID: Record<"send" | "steer" | "queue", Record<"started" | "steered" | "queued", string>> = {
  send: { started: "Sent", steered: "Sent into the running turn", queued: "Waiting for the turn to end" },
  steer: { started: "Nothing was running, so it was sent as the next message", steered: "Sent into the running turn", queued: "Waiting for the turn to end" },
  // A queue that waits even where the agent takes messages mid-turn needs a flag on the start this build lacks, so
  // it goes as a send, and the person is told when that meant joining the running turn.
  queue: { started: "Sent", steered: "Sent into the running turn; this agent takes messages mid-turn", queued: "Waiting for the turn to end" },
};

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const isRunRecord = (v: SlateJson | undefined): v is SlateJson & { state: string; runs: number; why?: string } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof v["state"] === "string" && typeof v["runs"] === "number";
const asJson = (v: unknown): SlateJson => v as SlateJson;

export interface Slates {
  get(threadId: string): Promise<SlateView | null>;
  write(p: SlateTarget & { text?: string; document?: Record<string, unknown>; check?: boolean; ifVersion?: number }, caller?: Caller): Promise<SlateWriteAnswer>;
  state(p: SlateTarget & { values: Record<string, unknown>; ifVersion?: number }, caller?: Caller): Promise<SlateStateAnswer>;
  read(p: SlateTarget & { values?: string[]; text?: boolean; sketch?: boolean; document?: boolean }, caller?: Caller): Promise<SlateReadAnswer>;
  catalog(p: { name?: string }): { text: string };
  shown(threadId: string): Promise<void>;
  event(p: { threadId: string; version: number; piece: string; event: "press" | "submit" | "change"; requestId: string; scope?: { item?: unknown; index: number }; rowAction?: number }): Promise<SlateEventAnswer>;
  approve(p: { threadId: string; key: string; scope: "once" | "thread" | "refuse" }): Promise<void>;
  cancel(p: { threadId: string; run: string }): Promise<void>;
  /** A window's hold on sources for a thread's slate; the release goes when the window lets go or its socket closes. */
  subscribe(p: { threadId: string; sources: string[] }): () => void;
  resolve(p: { threadId: string; paths: string[] }): Promise<{ values: Record<string, SlateJson> }>;
  /** A turn ended: its snapshot is written, and the undo of a rewind in the same folder goes, as the files' does. */
  turnEnded(o: { threadId: string; turnId: string; workspaceId: string }): Promise<void>;
  /** The runtime rewound a thread to the end of turnId, cutting the turns named. */
  rewound(o: { threadId: string; turnId: string; cut: readonly string[] }): Promise<void>;
  /** Undo rewind; false when the slate has nothing to put back. */
  undoRewind(threadId: string): Promise<boolean>;
  hasRewound(threadId: string): Promise<boolean>;
  forget(threadId: string): Promise<void>;
  /** Whether a slate in the workspace watches the pull request's checks. */
  watchesPr(workspaceId: string): boolean;
  /** The stored slates loaded, runs that were running when the host stopped marked failed and their done fired. */
  ready(): Promise<void>;
  /** Every batch queued so far has run. */
  settled(): Promise<void>;
  close(): void;
}

export function createSlates(deps: SlatesDeps): Slates {
  const records = new Map<string, SlateRecord>();
  const queues = new Map<string, Promise<unknown>>();
  /** One change at a time per thread: a batch, a write and a turn's end never interleave on one record. */
  const serial = <T>(threadId: string, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(threadId) ?? Promise.resolve()).then(run, run);
    queues.set(threadId, next.catch(() => {}));
    return next;
  };
  const save = (r: SlateRecord): Promise<void> => {
    r.updatedAt = deps.now();
    return deps.store.put(SLATES, r.threadId, r);
  };

  /** The run a batch is starting: the runs module's first record of it is the batch's to write, not a batch of its own. */
  let capturing: { threadId: string; run: string } | undefined;
  /** Who started each run, for the transcript's event when its record goes running. */
  const startedBy = new Map<string, RunBy>();
  const byKey = (threadId: string, run: string): string => `${threadId}\u0000${run}`;

  const runs: SlateRuns = (deps.runs ?? createSlateRuns)({
    env: deps.runEnv,
    now: deps.now,
    ...(deps.secretsFile !== undefined ? { secretsFile: deps.secretsFile } : {}),
    approvals: {
      has: (threadId, key) => records.get(threadId)?.approvals[key]?.state === "allowed",
      allow: (threadId, key) => {
        const r = records.get(threadId);
        if (r === undefined) return;
        r.approvals[key] = { state: "allowed", at: deps.now(), ...approvalNames(r, key) };
        void save(r);
      },
      revoke: (threadId, key) => {
        const r = records.get(threadId);
        if (r?.approvals[key] === undefined) return;
        delete r.approvals[key];
        void save(r);
      },
      list: threadId => Object.entries(records.get(threadId)?.approvals ?? {}).flatMap(([k, a]) => (a.state === "allowed" ? [k] : [])),
    },
    onRecord: (threadId, run, record) => {
      if (capturing?.threadId === threadId && capturing.run === run) return;
      void serial(threadId, () => runMoved(threadId, run, record)).catch((e: unknown) => console.warn(`the slate of thread ${threadWord(threadId)} lost a record of $${run}: ${e instanceof Error ? e.message : String(e)}`));
    },
    onLine: (threadId, run, line) => {
      const r = records.get(threadId);
      if (r !== undefined) deps.emit({ type: "slate.run", workspaceId: r.workspaceId, threadId, run, lines: [line] });
    },
    onTimer: (threadId, run) => {
      void serial(threadId, async () => {
        const r = records.get(threadId);
        if (r?.document?.runs[run] === undefined) return;
        await batch(r, [], "timer", { starts: [run] });
      }).catch(() => {});
    },
  });

  /** The run name and command an approval key stands for, so the menu can list it after the document changes. */
  function approvalNames(r: SlateRecord, key: string): { run?: string; cmd?: string } {
    for (const [name, decl] of Object.entries(r.document?.runs ?? {})) if (decl.kind === "cmd" && runs.key(decl as CmdRunDecl) === key) return { run: name, cmd: decl.cmd };
    return {};
  }

  let loaded: Promise<void> | undefined;
  const ready = (): Promise<void> =>
    (loaded ??= deps.store.list(SLATES).then(async list => {
      // Schema 1 was the first proof's and never shipped: no migration is owed, so its records are not read.
      for (const stored of list as SlateRecord[]) if (stored.schema === 2 && !records.has(stored.threadId)) records.set(stored.threadId, { ...stored, revision: stored.revision ?? stored.version });
      for (const r of [...records.values()]) await serial(r.threadId, () => recover(r));
    }));

  /** A record loaded at start (01, "Host restart"): secrets read off the store, so a memory one reads unfilled; every
   * run that read running is failed and its done fires, one batch per slate; held runs held again so the sheet has
   * something to approve; timers armed. Nothing restarts by itself. */
  async function recover(r: SlateRecord): Promise<void> {
    refreshSecrets(r);
    const doc = r.document;
    if (doc === null) return;
    const input: { path: string; value: SlateJson }[] = [];
    for (const name of Object.keys(doc.runs)) {
      const rec = r.values[name];
      if (isRunRecord(rec) && rec.state === "running") input.push({ path: `$${name}`, value: asJson(restartedRecord(rec as unknown as RunRecord, deps.now())) });
    }
    if (input.length > 0) await batch(r, input, "run", {});
    else await save(r);
    armTimers(r);
    const views = await viewsFor(r);
    for (const name of Object.keys(doc.runs)) {
      const rec = r.values[name];
      if (isRunRecord(rec) && rec.state === "held" && rec.why === HELD_APPROVAL) startNow(r, name, "person", views);
    }
  }

  const writes = new Map<string, { tokens: number; at: number; hour: number[] }>();
  /** Agent writes: 5 a second sustained, a burst of 20, 600 an hour (V751). */
  const spendWrite = (threadId: string): void => {
    const now = deps.now();
    const b = writes.get(threadId) ?? { tokens: WRITES_BURST, at: now, hour: [] };
    b.tokens = Math.min(WRITES_BURST, b.tokens + ((now - b.at) / 1000) * WRITES_PER_SECOND);
    b.at = now;
    b.hour = b.hour.filter(t => now - t < 3_600_000);
    writes.set(threadId, b);
    if (b.tokens < 1 || b.hour.length >= WRITES_PER_HOUR) {
      const wait = b.tokens < 1 ? Math.ceil((1 - b.tokens) / WRITES_PER_SECOND) : Math.ceil((3_600_000 - (now - b.hour[0]!)) / 1000);
      throw refused(problem("V751", "write-rate", `wait ${wait} s; a slate that rewrites itself constantly is a bug`), "conflict");
    }
    b.tokens -= 1;
    b.hour.push(now);
  };

  const pressSentAt = new Map<string, number>();
  const reactionSentAt = new Map<string, number>();
  const requests = new Map<string, { at: number; answer: Promise<SlateEventAnswer> }>();
  const holds = new Map<string, Map<string, number>>();

  /** The thread a slate op is about, read off the caller's token before any argument (12, cross-thread). */
  const targetOf = (p: SlateTarget, caller: Caller | undefined, write: boolean): string => {
    const scope = scopeOf(caller);
    if (scope !== undefined) {
      if (p.threadId === undefined || p.threadId === scope.threadId) return scope.threadId;
      if (write) throw Object.assign(new Error(`Z800 thread-not-yours: a thread writes its own slate, and thread ${threadWord(p.threadId)} is not this one`), { kind: "usage", code: "Z800" });
      if (!deps.under(scope.threadId).includes(p.threadId)) throw Object.assign(notFoundRefusal(`no thread ${threadWord(p.threadId)}`), { code: "Z801" });
      return p.threadId;
    }
    if (p.threadId !== undefined) {
      if (deps.thread(p.threadId) === undefined && !records.has(p.threadId)) throw notFoundRefusal(`no thread ${threadWord(p.threadId)}`);
      return p.threadId;
    }
    if (p.turnToken !== undefined) return deps.threadOfToken(p.turnToken);
    throw usageRefusal("a slate belongs to a thread, and this line names none and runs inside no turn:", "name the thread by id, as wsp threads lists it.");
  };

  const byOf = (caller: Caller | undefined): "agent" | "person" => (scopeOf(caller) !== undefined ? "agent" : "person");

  const recordOf = async (threadId: string): Promise<SlateRecord | undefined> => {
    await ready();
    return records.get(threadId);
  };
  const needRecord = async (threadId: string): Promise<SlateRecord> => {
    const r = await recordOf(threadId);
    if (r === undefined || (r.document === null && r.version === 0)) throw usage(problem("Z802", "no-slate", "this thread has no slate yet; write one with slate_write"));
    return r;
  };
  const freshRecord = (threadId: string): SlateRecord => {
    const facts = deps.thread(threadId);
    if (facts === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
    return { threadId, workspaceId: facts.workspaceId, rootThreadId: facts.rootThreadId, schema: 2, version: 0, revision: 0, document: null, values: {}, empty: "none", turns: {}, kept: {}, comments: [], approvals: {}, problems: [], shownOnce: false, updatedAt: deps.now() };
  };

  const checkVersion = (r: SlateRecord, ifVersion: number | undefined): void => {
    if (ifVersion !== undefined && ifVersion !== r.version) throw refused(problem("V750", "version-behind", `the slate is at version ${r.version}, not ${ifVersion}; read it and write again`), "conflict");
  };

  const announce = (r: SlateRecord, cause: SlateCause, by: SlateBy, pieces: string[], run?: string): void => {
    const facts = deps.thread(r.threadId);
    deps.record({
      type: "session.slate",
      workspaceId: r.workspaceId,
      sessionId: facts?.sessionId ?? r.threadId,
      ...(facts?.turnId !== undefined ? { turnId: facts.turnId } : {}),
      threadId: r.threadId,
      cause,
      version: r.version,
      by,
      pieces: pieces.slice(0, PIECES_NAMED),
      ...(run !== undefined ? { run } : {}),
    });
  };

  const push = (r: SlateRecord, names: Iterable<string>): void => {
    const values = Object.fromEntries([...new Set(names)].filter(n => n in r.values).map(n => [`$${n}`, r.values[n]!]));
    if (Object.keys(values).length > 0) deps.emit({ type: "slate.values", workspaceId: r.workspaceId, threadId: r.threadId, version: r.version, revision: r.revision, values });
  };

  const keepProblems = (r: SlateRecord, found: readonly SlateProblem[]): void => {
    if (found.length > 0) r.problems = [...r.problems, ...found].slice(-PROBLEMS_KEPT);
  };

  /** The sources a document and a set of extra paths read, viewed once. */
  const viewsFor = async (r: SlateRecord, extra: readonly string[] = []) => {
    const text = `${r.document === null ? "" : JSON.stringify(r.document)} ${extra.join(" ")}`;
    // The clock always: ago() and until() read it without naming it.
    return viewSources(["time", ...sourcesNamed(text)], deps.sources(r.threadId, r.workspaceId));
  };

  /** How the host reads a path: own values and derived values off the record, sources off the views, the row scope. */
  const contextOf = (r: SlateRecord, views: ReadonlyMap<string, SlateJson | undefined>, row?: { item?: SlateJson; index?: number }): SlateEvalContext => {
    const derived = new Map<string, SlateJson | undefined>();
    const busy = new Set<string>();
    const ctx: SlateEvalContext = {
      now: deps.now(),
      ...(row?.item !== undefined ? { item: row.item } : {}),
      ...(row?.index !== undefined ? { index: row.index } : {}),
      resolve: path => {
        if (!path.startsWith("$")) return resolveIn(views, path);
        const own = parseSlateOwnPath(path);
        if (own === undefined) return undefined;
        const expr = r.document?.derived[own.name];
        if (expr === undefined) return getSlateValue(r.values, path);
        if (!derived.has(own.name)) {
          if (busy.has(own.name)) return undefined;
          busy.add(own.name);
          derived.set(own.name, evaluateSlateExpression(expr, ctx));
          busy.delete(own.name);
        }
        let at = derived.get(own.name);
        for (const seg of own.segs) at = slateStep(at, seg);
        return at;
      },
    };
    return ctx;
  };

  const scrub = (r: SlateRecord, text: string): string => runs.secrets.scrub(r.threadId, text);

  const sketched = (r: SlateRecord, views: ReadonlyMap<string, SlateJson | undefined>, check = false): string => {
    const text = sketchSlate(r.document, r.values, { ...contextOf(r, views), version: r.version, ...(check ? { check: true } : {}) });
    return scrub(r, /^slate v\d/.test(text) ? text : text.replace(/^slate\b/, `slate v${r.version}`));
  };
  const sketchOf = async (r: SlateRecord): Promise<string> => sketched(r, await viewsFor(r));

  /** The paths a document binds, as the evaluator names them. */
  const boundPaths = (doc: SlateDoc): string[] => {
    const found = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (typeof value === "object" && value !== null) {
        const o = value as Record<string, unknown>;
        if (isSlateBinding(o)) for (const d of slateDependencies(o.bind)) found.add(d);
        else if (typeof o["format"] === "string" && Object.keys(o).length === 1) for (const m of o["format"].matchAll(/\$\{([^}]*)\}/g)) for (const d of slateDependencies(m[1]!)) found.add(d);
        else Object.values(o).forEach(visit);
      }
    };
    for (const piece of Object.values(doc.pieces)) {
      visit(piece.props);
      if (piece.when !== undefined) for (const d of slateDependencies(piece.when)) found.add(d);
    }
    for (const expr of Object.values(doc.derived)) for (const d of slateDependencies(expr)) found.add(d);
    return [...found].filter(p => !p.startsWith("item") && !p.startsWith("index"));
  };

  /** What the agent is owed on a read: the standing runtime problems, data that has not arrived, held runs, and a
   * slate a rewind emptied. */
  const problemsOf = (r: SlateRecord, views: ReadonlyMap<string, SlateJson | undefined>): SlateProblem[] => {
    const found: SlateProblem[] = [...r.problems];
    if (r.document === null && r.empty === "rewound-before") found.push(problem("Z804", "rewound-before", "the thread was rewound to before this slate existed; write one with slate_write"));
    if (r.document !== null) {
      for (const path of boundPaths(r.document)) if (!path.startsWith("$") && resolveIn(views, path) === undefined) found.push(problem("R900", "data-missing", `${path} has no value yet`));
      for (const name of Object.keys(r.document.runs)) {
        const rec = r.values[name];
        if (isRunRecord(rec) && rec.state === "held") found.push(problem("R913", "run-held", `$${name} waits: ${rec.why ?? HELD_APPROVAL}`));
      }
    }
    return found;
  };

  const asksOf = (r: SlateRecord): SlateAsk[] => {
    const facts = deps.thread(r.threadId);
    return runs.held(r.threadId).map((a: RunAsk) => {
      const rec = r.values[a.run];
      return {
        key: a.key,
        run: a.run,
        kind: "cmd" as const,
        cmd: a.cmd,
        env: a.env,
        args: a.args,
        ...(a.stdin !== undefined ? { stdin: a.stdin } : {}),
        computer: facts?.computer ?? "this computer",
        folder: a.folder,
        timeoutS: a.timeout,
        ...(a.confirm !== undefined ? { confirm: a.confirm } : {}),
        why: isRunRecord(rec) && rec.why !== undefined ? rec.why : HELD_APPROVAL,
      };
    });
  };

  const viewOf = (r: SlateRecord): SlateView => ({
    threadId: r.threadId,
    workspaceId: r.workspaceId,
    version: r.version,
    revision: r.revision,
    document: r.document as unknown as Record<string, unknown> | null,
    values: r.values,
    ...(r.document === null ? { empty: r.empty ?? "none" } : {}),
    comments: r.comments,
    approvals: { ...r.approvals, ...(r.sendsAllowed !== undefined ? { [SLATE_SEND_KEY]: { state: "allowed" as const, at: r.sendsAllowed } } : {}) },
    asks: asksOf(r),
    problems: r.problems,
    shownOnce: r.shownOnce,
    canUndo: r.previous !== undefined,
    rewound: r.rewound !== undefined,
    updatedAt: r.updatedAt,
  });

  const snapOf = (r: SlateRecord): SlateSnap => ({ document: r.document, values: r.values, ...(r.empty !== undefined ? { empty: r.empty } : {}) });

  /** Every secret's handle read off the store: a rewind or a restart never fills or empties a secret (08, "Reuse"). */
  const refreshSecrets = (r: SlateRecord): void => {
    for (const [name, decl] of Object.entries(r.document?.values ?? {})) if (decl.secret === true) r.values[name] = asJson(runs.secrets.handle(r.threadId, name));
  };

  const armTimers = (r: SlateRecord): void => {
    const list = Object.entries(r.document?.runs ?? {}).flatMap(([run, decl]) => (decl.every !== undefined ? [{ run, every: decl.every, ...(decl.always === true ? { always: true } : {}) }] : []));
    runs.timers(r.threadId, list);
  };

  /** A snapshot put back: every run stopped with its completion dropped, records that said running say cancelled,
   * secrets read as the store holds them, and nothing fires (02, "Rewind"). */
  const become = (r: SlateRecord, snap: SlateSnap): void => {
    runs.stopAll(r.threadId, { quiet: true });
    r.document = snap.document;
    r.values = structuredClone(snap.values);
    for (const name of Object.keys(r.document?.runs ?? {})) {
      const rec = r.values[name];
      if (isRunRecord(rec)) r.values[name] = asJson(rewoundRecord(rec as unknown as RunRecord, deps.now()));
    }
    refreshSecrets(r);
    if (snap.document === null) r.empty = snap.empty ?? "none";
    else delete r.empty;
    armTimers(r);
  };

  /** A new document's live values (02, "Values"): names both documents declare keep their live value, names only
   * the new one declares start, names only the old one declared go; a run keeps its record, a secret its handle. */
  const valuesFor = (r: Pick<SlateRecord, "threadId" | "document" | "values">, next: SlateDoc): SlateValues => {
    const before = r.document;
    const live: SlateValues = {};
    for (const [name, decl] of Object.entries(next.values)) {
      if (decl.secret === true) live[name] = asJson(runs.secrets.handle(r.threadId, name));
      else if (before?.values[name] !== undefined && name in r.values) live[name] = r.values[name]!;
      else live[name] = structuredClone(decl.start);
    }
    for (const name of Object.keys(next.runs)) {
      const rec = r.values[name];
      live[name] = before?.runs[name] !== undefined && isRunRecord(rec) ? rec : asJson(structuredClone(SLATE_RUN_IDLE));
    }
    return live;
  };

  /** What a dropped declaration leaves behind: its secret forgotten at once, its run stopped. */
  const dropDeclared = (r: SlateRecord, next: SlateDoc | null): void => {
    for (const [name, decl] of Object.entries(r.document?.values ?? {})) if (decl.secret === true && next?.values[name]?.secret !== true) runs.secrets.forget(r.threadId, name);
    for (const name of Object.keys(r.document?.runs ?? {})) if (next?.runs[name] === undefined) runs.cancel(r.threadId, name);
  };

  /** Drops the oldest snapshots past the count and the byte cap, then every kept version no turn points at. */
  const trimSnapshots = (r: SlateRecord): void => {
    const order = Object.keys(r.turns);
    while (order.length > SNAPSHOTS_KEPT) delete r.turns[order.shift()!];
    const used = (): Set<string> => new Set(Object.values(r.turns).map(t => String(t.revision)));
    for (const v of Object.keys(r.kept)) if (!used().has(v)) delete r.kept[v];
    while (order.length > 1 && sizeOf(r.kept) > SNAPSHOT_BYTES) {
      delete r.turns[order.shift()!];
      const live = used();
      for (const v of Object.keys(r.kept)) if (!live.has(v)) delete r.kept[v];
    }
  };

  // ---- runs ----

  /** A declared run's env, args and stdin, read when the command starts; a secret named by a bare binding goes over
   * by name and becomes plaintext only inside the runs module (07, "Injection"). */
  const inputsOf = (r: SlateRecord, decl: Extract<SlateRunDecl, { kind: "cmd" }>) => () => {
    const ctx = contextOf(r, viewsNow.get(r.threadId) ?? new Map());
    const one = (v: SlatePropValue): RunInput => {
      if (isSlateBinding(v)) {
        const own = parseSlateOwnPath(v.bind.trim());
        if (own !== undefined && own.segs.length === 0 && r.document?.values[own.name]?.secret === true) return { secret: own.name };
      }
      return { value: resolveSlateProp(v, ctx) ?? null };
    };
    return {
      ...(decl.env !== undefined ? { env: Object.fromEntries(Object.entries(decl.env).map(([k, v]) => [k, one(v)])) } : {}),
      ...(decl.args !== undefined ? { args: decl.args.map(one) } : {}),
      ...(decl.stdin !== undefined ? { stdin: one(decl.stdin) } : {}),
    };
  };
  /** The sources a run's inputs read, kept from the last batch of its slate. */
  const viewsNow = new Map<string, ReadonlyMap<string, SlateJson | undefined>>();

  /** A declared run started through the runs module; its first record is the caller's to write. */
  const startNow = (r: SlateRecord, run: string, by: RunBy, views: ReadonlyMap<string, SlateJson | undefined>): { record: SlateRunRecord; ask?: RunAsk } => {
    const decl = r.document?.runs[run];
    const prior = r.values[run];
    const count = isRunRecord(prior) ? prior.runs : 0;
    if (decl === undefined) return { record: { state: "failed", why: `$${run} is not declared`, runs: count } };
    if (decl.kind !== "cmd") return { record: { state: "failed", why: `${decl.kind} runs are not in this build`, runs: count } };
    viewsNow.set(r.threadId, views);
    capturing = { threadId: r.threadId, run };
    try {
      const answer = runs.start({ threadId: r.threadId, run, decl: decl as CmdRunDecl, by, folder: deps.thread(r.threadId)?.folder ?? process.cwd(), inputs: inputsOf(r, decl), runs: count });
      startedBy.set(byKey(r.threadId, run), by);
      if (answer.record.state === "running") announce(r, "run", by, [], run);
      return { record: answer.record as SlateRunRecord, ...(answer.outcome === "held" && answer.ask !== undefined ? { ask: answer.ask } : {}) };
    } finally {
      capturing = undefined;
    }
  };

  /** The record a start inside a batch will give: running where the person said always and nothing asks every
   * time, else held for the sheet. */
  const provisional = (r: SlateRecord, run: string): SlateRunRecord => {
    const decl = r.document?.runs[run];
    const prior = r.values[run];
    const count = isRunRecord(prior) ? prior.runs : 0;
    const approved = decl?.kind === "cmd" && decl.confirm === undefined && r.approvals[runs.key(decl as CmdRunDecl)]?.state === "allowed";
    return approved ? { state: "running", runs: count + 1, startedAt: deps.now() } : { state: "held", why: HELD_APPROVAL, runs: count };
  };

  /** A record the runs module wrote outside a batch (an end, a cancel, a queued start, an approval): one batch, so
   * done reactions fire with the window closed (02, "Runs"). */
  async function runMoved(threadId: string, run: string, record: RunRecord): Promise<void> {
    const r = records.get(threadId);
    if (r?.document?.runs[run] === undefined) return;
    if (record.state === "running") announce(r, "run", startedBy.get(byKey(threadId, run)) ?? "person", [], run);
    await batch(r, [{ path: `$${run}`, value: asJson(record) }], "run", {});
  }

  // ---- the batch ----

  interface BatchOut {
    asks: RunAsk[];
    sends: { prompt: string; kind: "send" | "steer" | "queue"; requestId: string }[];
  }

  /** One arrival through the batch (02, "The batch"): the module's pure core with a start that runs here, then the
   * cancels, the sends composed, the values saved and pushed. Called inside serial. */
  async function batch(r: SlateRecord, input: { path: string; value: SlateJson }[], by: BatchBy, o: { event?: BatchEvent; starts?: string[]; requestId?: string; sendAt?: number }): Promise<BatchOut> {
    const doc = r.document;
    if (doc === null) return { asks: [], sends: [] };
    const views = await viewsFor(r);
    const asks: RunAsk[] = [];
    const before = r.values;
    const deferred: { run: string; by: RunBy; record: SlateRunRecord }[] = [];
    const ctx = {
      ...contextOf(r, views),
      // A timer's start record is a run's result, which the host writes on its own road (no A607).
      by: by === "timer" ? "run" : by,
      ...(o.event !== undefined ? { event: o.event } : {}),
      reactionSends: r.sendsAllowed !== undefined,
      // A run's env reads the values as this batch leaves them, so the batch gets the record the start will give and
      // the command is spawned once they are stored.
      start: (run: string, startBy: "person" | "reaction"): SlateRunRecord => {
        const record = provisional(r, run);
        deferred.push({ run, by: by === "timer" ? "timer" : startBy, record });
        return record;
      },
    };
    // A timer's start is no step of the document: it starts here and its record goes in as a run's write.
    const timed = (o.starts ?? []).map(run => ({ path: `$${run}`, value: asJson(startNow(r, run, "timer", views).record) }));
    const result = runSlateBatch(doc, r.values, [...input, ...timed], ctx);
    if (sizeOf(result.values) > VALUES_BYTES) {
      keepProblems(r, [problem("S500", "values-too-big", `the values would be ${sizeOf(result.values)} bytes; a slate holds at most ${VALUES_BYTES}`)]);
      await save(r);
      return { asks, sends: [] };
    }
    r.values = result.values;
    keepProblems(r, result.problems);
    for (const run of result.cancels) runs.cancel(r.threadId, run);
    for (const d of deferred) {
      const started = startNow(r, d.run, d.by, views);
      if (started.ask !== undefined) asks.push(started.ask);
      // The runs module held it for a reason the batch could not see (four running, the start budget): that record
      // goes through a batch of its own.
      if (started.record.state === d.record.state) r.values[d.run] = asJson(started.record);
      else void serial(r.threadId, () => runMoved(r.threadId, d.run, started.record as RunRecord));
    }

    const sends: BatchOut["sends"] = [];
    const now = o.sendAt ?? deps.now();
    for (const send of result.sends as BatchSend[]) {
      const fromPress = send.by === "person";
      const last = (fromPress ? pressSentAt : reactionSentAt).get(r.threadId);
      if (last !== undefined && now - last < (fromPress ? PRESS_SEND_MS : REACTION_SEND_MS)) {
        if (fromPress) throw refused(problem("V753", "send-rate", "too fast; try again in a moment"), "conflict");
        keepProblems(r, [problem("R912", "reaction-failed", `reaction ${send.reaction ?? "?"}: V753 send-rate, one message a minute from reactions`)]);
        continue;
      }
      (fromPress ? pressSentAt : reactionSentAt).set(r.threadId, now);
      sends.push({ prompt: compose(r, send, views, o.event, now), kind: send.do, requestId: o.requestId ?? `${r.threadId}:${r.version}:${send.reaction ?? send.piece ?? "slate"}:${now}` });
    }

    const changed = new Set<string>();
    for (const name of new Set([...Object.keys(before), ...Object.keys(r.values)])) if (!slateEqual(before[name], r.values[name])) changed.add(name);
    if (changed.size > 0 || result.problems.length > 0) {
      r.revision += 1;
      await save(r);
      push(r, changed);
    }
    return { asks, sends };
  }

  /** The message a send puts into the thread (09, "The message"): the literal text, a blank line, one `slate:` line
   * whose values are the host's, scrubbed and defanged, cut to 20,000 characters longest value first. */
  function compose(r: SlateRecord, send: BatchSend, views: ReadonlyMap<string, SlateJson | undefined>, event: BatchEvent | undefined, now: number): string {
    const ctx = contextOf(r, views, event);
    const named = send.with ?? [];
    let carried: SlateJson = Object.fromEntries(named.map(path => [path, defanged(mapStrings(send.values?.[path] ?? evaluateSlateExpression(path, ctx) ?? null, s => scrub(r, s)))]));
    const fromPress = send.by === "person";
    const pieceId = send.piece ?? (fromPress ? event?.piece : undefined);
    const piece = pieceId !== undefined ? r.document?.pieces[pieceId] : undefined;
    const rowActions = piece?.props?.["rowActions"];
    const owner = event?.rowAction !== undefined && Array.isArray(rowActions) ? (rowActions[event.rowAction] as { label?: unknown } | undefined) : undefined;
    const labelled = owner !== undefined ? owner.label : piece?.props?.["label"];
    const label = typeof labelled === "string" ? labelled.slice(0, 80) : undefined;
    const keyProp = piece?.props?.["key"];
    const key = event?.index === undefined || keyProp === undefined ? undefined : resolveSlateProp(keyProp, ctx);
    const line = (w: SlateJson): string =>
      `slate: ${JSON.stringify({
        v: 2,
        kind: fromPress ? "action" : "reaction",
        thread: threadWord(r.threadId),
        version: r.version,
        ...(pieceId !== undefined ? { piece: pieceId } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(event !== undefined && fromPress ? { event: event.kind } : {}),
        ...(send.reaction !== undefined ? { reaction: send.reaction } : {}),
        ...(event?.index !== undefined && fromPress ? { index: event.index } : {}),
        ...(key !== undefined ? { key } : {}),
        ...(named.length > 0 ? { with: w } : {}),
        by: fromPress ? "person" : "reaction",
        at: new Date(now).toISOString(),
      })}`;
    let prompt = `${send.text}\n\n${line(carried)}`;
    for (let i = 0; prompt.length > MESSAGE_CHARS && i < 50; i++) {
      const long = longest(carried);
      if (long === undefined || long.length < 20) break;
      carried = cutAt(carried, long.at, Math.max(0, long.length - (prompt.length - MESSAGE_CHARS) - 10));
      prompt = `${send.text}\n\n${line(carried)}`;
    }
    return prompt;
  }

  /** The sends a batch composed, delivered outside the record's queue: a start that waits on a running turn must not
   * hold up that turn's own writes to the slate. */
  const deliverAll = async (r: SlateRecord, sends: BatchOut["sends"]): Promise<{ outcome: "started" | "steered" | "queued"; turnId?: string; kind: "send" | "steer" | "queue" } | undefined> => {
    let first: { outcome: "started" | "steered" | "queued"; turnId?: string; kind: "send" | "steer" | "queue" } | undefined;
    for (const s of sends) {
      const landed = await deps.deliver({ threadId: r.threadId, workspaceId: r.workspaceId, prompt: s.prompt, requestId: s.requestId });
      first ??= { ...landed, kind: s.kind };
    }
    return first;
  };

  // ---- writes ----

  const writeDocument = async (r: SlateRecord, next: SlateDoc | null, values: SlateValues, by: "agent" | "person", cause: SlateCause, pieces: string[], warnings: SlateProblem[]): Promise<SlateWriteAnswer> => {
    if (sizeOf(values) > VALUES_BYTES) throw invalid([problem("S500", "values-too-big", `the values are ${sizeOf(values)} bytes; a slate holds at most ${VALUES_BYTES}`)], warnings);
    dropDeclared(r, next);
    if (r.version > 0) r.previous = { ...snapOf(r), version: r.version };
    // A clear keeps the values; a document write keeps what both documents declare and fires nothing (02).
    r.document = next;
    r.values = values;
    if (next === null) r.empty = "cleared";
    else delete r.empty;
    r.version += 1;
    r.revision += 1;
    records.set(r.threadId, r);
    armTimers(r);
    await save(r);
    announce(r, cause, by, pieces);
    if (next !== null && /\bpr\.checks\b/.test(JSON.stringify(next))) deps.watchPr?.(r.workspaceId);
    push(r, Object.keys(values));
    const views = await viewsFor(r);
    return { version: r.version, text: sketched(r, views), warnings, problems: problemsOf(r, views) };
  };

  const undo = async (r: SlateRecord, by: "agent" | "person"): Promise<SlateWriteAnswer> => {
    const back = r.previous;
    if (back === undefined) throw refused(problem("V752", "nothing-to-undo", "there is no earlier slate to go back to; the undo keeps one step"), "conflict");
    r.previous = { ...snapOf(r), version: r.version };
    become(r, back);
    r.version += 1;
    r.revision += 1;
    await save(r);
    announce(r, "undo", by, []);
    push(r, Object.keys(r.values));
    return { version: r.version, text: await sketchOf(r), warnings: [], problems: [] };
  };

  const slates: Slates = {
    ready,

    async settled() {
      for (let i = 0; i < 50; i++) {
        const pending = [...queues.values()];
        await Promise.all(pending);
        const now = [...queues.values()];
        if (now.length === pending.length && now.every((q, at) => q === pending[at])) return;
      }
    },

    close() {
      runs.close();
    },

    async get(threadId) {
      const r = await recordOf(threadId);
      return r === undefined ? null : viewOf(r);
    },

    async write(p, caller) {
      const threadId = targetOf(p, caller, true);
      const given = [p.text, p.document].filter(v => v !== undefined).length;
      if (given !== 1) throw Object.assign(usageRefusal(`A601 step-arg: a slate write takes exactly one of text or document, and this one has ${given === 0 ? "none" : "both"}:`, "send text alone."), { code: "A601" });
      const by = byOf(caller);
      const whole = p.document !== undefined || p.text!.trimStart().startsWith("<slate");
      return serial(threadId, async () => {
        const r = (await recordOf(threadId)) ?? freshRecord(threadId);
        if (whole) {
          const checked = p.text !== undefined ? parseSlate(p.text) : validateSlate(p.document);
          if (checked.errors.length > 0 || checked.document === undefined) throw invalid(checked.errors, checked.warnings);
          const doc = checked.document;
          if (p.check === true) {
            const preview: SlateRecord = { ...r, document: doc, values: valuesFor({ threadId, document: null, values: {} }, doc) };
            return { version: r.version, text: sketched(preview, new Map(), true), warnings: checked.warnings, problems: [] };
          }
          checkVersion(r, p.ifVersion);
          if (by === "agent") spendWrite(threadId);
          return writeDocument(r, doc, valuesFor(r, doc), by, "write", Object.keys(doc.pieces), checked.warnings);
        }
        if (r.version === 0) throw usage(problem("Z802", "no-slate", "this thread has no slate to patch; write a whole <slate> first"));
        const parsed = parseSlatePatch(p.text!, r.document);
        if (parsed.errors.length > 0 || parsed.patch === undefined) throw invalid(parsed.errors, []);
        const ops = parsed.patch.ops;
        if (ops.length === 1 && ops[0]!.op === "undo") {
          if (p.check === true) return { version: r.version, text: await sketchOf(r), warnings: [], problems: [] };
          checkVersion(r, p.ifVersion);
          return undo(r, by);
        }
        const applied = applySlatePatch(r.document, r.values, parsed.patch, parsed.lines);
        if (applied.errors.length > 0 || applied.document === undefined) throw invalid(applied.errors, applied.warnings);
        const next = applied.document;
        const values = next === null ? r.values : valuesFor({ threadId, document: r.document, values: applied.values ?? r.values }, next);
        if (p.check === true) return { version: r.version, text: sketched({ ...r, document: next, values }, new Map(), true), warnings: applied.warnings, problems: [] };
        checkVersion(r, p.ifVersion);
        if (by === "agent") spendWrite(threadId);
        const touched = [...new Set(ops.flatMap(op => ("id" in op && typeof op.id === "string" ? [op.id] : [])))];
        return writeDocument(r, next, values, by, next === null ? "clear" : "write", touched, applied.warnings);
      });
    },

    async state(p, caller) {
      const threadId = targetOf(p, caller, true);
      const by = byOf(caller);
      return serial(threadId, async () => {
        const r = await needRecord(threadId);
        const doc = r.document;
        if (doc === null) throw usage(problem("Z802", "no-slate", "this slate is empty; write one with slate_write"));
        checkVersion(r, p.ifVersion);
        const input: { path: string; value: SlateJson }[] = [];
        for (const [path, value] of Object.entries(p.values)) {
          const own = parseSlateOwnPath(path);
          if (own === undefined) throw invalid([problem("S501", "name-undeclared", `${path} is not a value path; a value path reads $name, with .field and [index] below it`, path.startsWith("$") ? {} : { fix: `$${path}` })], []);
          if (doc.derived[own.name] !== undefined || doc.runs[own.name] !== undefined) throw invalid([problem("A607", "set-not-value", `$${own.name} is a ${doc.derived[own.name] !== undefined ? "derived value" : "run"} and cannot be written`, { fix: "write the value it reads" })], []);
          const decl = doc.values[own.name];
          if (decl === undefined) {
            const near = slateNearest(own.name, Object.keys(doc.values));
            throw invalid([problem("S501", "name-undeclared", `$${own.name} is not declared`, near !== undefined ? { fix: `$${near}` } : {})], []);
          }
          if (decl.secret === true) {
            // The person's typing is the one road in for a secret, and it stops here: the batch sees the handle.
            if (by === "agent" || own.segs.length > 0) throw invalid([problem("S520", "secret-exposed", `$${own.name} is a secret: only the person types it, into its input`)], []);
            if (typeof value !== "string") throw invalid([problem("S520", "secret-exposed", `$${own.name} takes the typed text`)], []);
            const handle = value === "" ? runs.secrets.clear(threadId, own.name) : runs.secrets.set(threadId, own.name, value, decl.keep === true ? { keep: true } : {});
            input.push({ path: `$${own.name}`, value: asJson(handle) });
            continue;
          }
          input.push({ path, value: value as SlateJson });
        }
        if (by === "agent") {
          spendWrite(threadId);
          runs.release(threadId);
        }
        const out = await batch(r, input, by, {});
        if (by === "agent") announce(r, "state", by, []);
        void deliverAll(r, out.sends).catch((e: unknown) => console.warn(`a slate send in thread ${threadWord(threadId)} was not delivered: ${e instanceof Error ? e.message : String(e)}`));
        const views = await viewsFor(r);
        return { version: r.version, text: sketched(r, views), problems: problemsOf(r, views) };
      });
    },

    async read(p, caller) {
      const threadId = targetOf(p, caller, false);
      const r = await needRecord(threadId);
      const asked = p.values ?? [];
      const paths = asked.includes("*") && r.document !== null ? boundPaths(r.document) : asked.filter(v => v !== "*");
      const views = await viewsFor(r, paths);
      const ctx = contextOf(r, views);
      const doc = r.document;
      const clean = (v: SlateJson): SlateJson => mapStrings(v, s => scrub(r, s));
      const sketch = p.sketch !== false ? sketched(r, views) : `slate v${r.version}`;
      return {
        version: r.version,
        text: [sketch, ...(p.text !== false && doc !== null ? ["", printSlate(doc)] : [])].join("\n"),
        ...(p.document === true ? { document: doc as unknown as Record<string, unknown> | null } : {}),
        values: Object.fromEntries(paths.map(path => [path, clean(evaluateSlateExpression(path, ctx) ?? null)])),
        state: Object.fromEntries(Object.entries(r.values).filter(([name]) => doc?.runs[name] === undefined).map(([name, v]) => [`$${name}`, clean(v)])),
        derived: Object.fromEntries(Object.keys(doc?.derived ?? {}).map(name => [`$${name}`, clean(ctx.resolve(`$${name}`) ?? null)])),
        runs: Object.fromEntries(Object.keys(doc?.runs ?? {}).map(name => [`$${name}`, clean(r.values[name] ?? null)])),
        problems: problemsOf(r, views),
        comments: r.comments,
        approvals: Object.fromEntries(Object.entries(r.approvals).map(([k, a]) => [k, a.state])),
      };
    },

    catalog(p) {
      return { text: slateCatalog(p.name) };
    },

    async shown(threadId) {
      await serial(threadId, async () => {
        const r = await recordOf(threadId);
        if (r === undefined || r.shownOnce) return;
        r.shownOnce = true;
        await save(r);
      });
    },

    event(p) {
      const now = deps.now();
      for (const [id, held] of requests) if (now - held.at > REQUEST_KEPT_MS) requests.delete(id);
      // A press sent again after a reconnect is the same press: it answers what the first one came to.
      const seen = requests.get(p.requestId);
      if (seen !== undefined) return seen.answer;
      const composed = serial(p.threadId, async () => {
        const r = await needRecord(p.threadId);
        const doc = r.document;
        // The host reads the piece and its steps off its own document, never the window's copy (finding 6j).
        const piece = doc?.pieces[p.piece];
        if (doc === null || piece === undefined) throw usageRefusal(`That part of the slate is gone (piece ${p.piece}, version ${p.version}; the slate is at ${r.version}).`, "Press it again once the slate has redrawn.");
        if (p.rowAction !== undefined) {
          const rowActions = piece.props?.["rowActions"];
          if (!Array.isArray(rowActions) || rowActions[p.rowAction] === undefined) throw usageRefusal(`${p.piece} has no row action ${p.rowAction}.`, "Press it again once the slate has redrawn.");
        }
        // A row's item is the host's own, off the piece's list at delivery (finding 6k).
        let item: SlateJson | undefined;
        if (p.scope !== undefined) {
          const views = await viewsFor(r);
          const list = piece.props?.["items"] !== undefined ? resolveSlateProp(piece.props["items"], contextOf(r, views)) : undefined;
          item = Array.isArray(list) ? list[p.scope.index] : (p.scope.item as SlateJson | undefined);
        }
        runs.release(p.threadId);
        const event: BatchEvent = { piece: p.piece, kind: p.event, ...(item !== undefined ? { item } : {}), ...(p.scope !== undefined ? { index: p.scope.index } : {}), ...(p.rowAction !== undefined ? { rowAction: p.rowAction } : {}) };
        const out = await batch(r, [], "person", { event, requestId: p.requestId, sendAt: now });
        return { r, out };
      });
      const answer = composed.then(async ({ r, out }): Promise<SlateEventAnswer> => {
        let landed: Awaited<ReturnType<typeof deliverAll>>;
        try {
          landed = await deliverAll(r, out.sends);
        } catch (e) {
          throw Object.assign(new Error(`This thread cannot take a message now: ${e instanceof Error ? e.message : String(e)}`), { kind: (e as { kind?: unknown }).kind ?? "conflict" });
        }
        const held = out.asks[0];
        const ask = held === undefined ? undefined : asksOf(r).find(a => a.run === held.run);
        if (landed !== undefined) return { outcome: landed.outcome, said: SAID[landed.kind][landed.outcome], ...(landed.turnId !== undefined ? { turnId: landed.turnId } : {}), ...(ask !== undefined ? { ask } : {}) };
        if (ask !== undefined) return { outcome: "held", said: "Needs your approval", ask };
        return { outcome: "done", said: "" };
      });
      requests.set(p.requestId, { at: now, answer });
      // A refused press is not remembered, so the person can press again once the reason is gone.
      answer.catch(() => requests.delete(p.requestId));
      return answer;
    },

    async approve(p) {
      const r = await needRecord(p.threadId);
      if (p.key === SLATE_SEND_KEY) {
        await serial(p.threadId, async () => {
          if (p.scope === "refuse") delete r.sendsAllowed;
          else r.sendsAllowed = deps.now();
          await save(r);
        });
        return;
      }
      const named = Object.entries(r.document?.runs ?? {}).filter(([, decl]) => decl.kind === "cmd" && runs.key(decl as CmdRunDecl) === p.key).map(([name]) => name);
      if (named.length === 0) throw usageRefusal(`this slate declares no command with approval key ${p.key}:`, "read the slate again and approve what it asks now.");
      await serial(p.threadId, async () => {
        if (p.scope === "refuse") {
          r.approvals[p.key] = { state: "refused", at: deps.now(), ...approvalNames(r, p.key) };
          await save(r);
          for (const run of named) runs.deny(p.threadId, run);
          return;
        }
        if (p.scope === "thread") r.approvals[p.key] = { state: "allowed", at: deps.now(), ...approvalNames(r, p.key) };
        const views = await viewsFor(r);
        viewsNow.set(p.threadId, views);
        for (const run of named) {
          const rec = r.values[run];
          if (!isRunRecord(rec) || rec.state !== "held") continue;
          startedBy.set(byKey(p.threadId, run), "person");
          if (runs.approve(p.threadId, run, p.scope === "thread" ? "always" : "once") !== undefined) continue;
          // The hold was a host's before a restart, which this process never saw: hold it again, then answer it.
          const decl = r.document!.runs[run] as Extract<SlateRunDecl, { kind: "cmd" }>;
          const again = runs.start({ threadId: p.threadId, run, decl: decl as CmdRunDecl, by: "person", folder: deps.thread(p.threadId)?.folder ?? process.cwd(), inputs: inputsOf(r, decl), runs: rec.runs });
          if (again.outcome === "held") runs.approve(p.threadId, run, p.scope === "thread" ? "always" : "once");
        }
        await save(r);
      });
    },

    async cancel(p) {
      await needRecord(p.threadId);
      runs.cancel(p.threadId, p.run);
    },

    subscribe(p) {
      const held = holds.get(p.threadId) ?? new Map<string, number>();
      holds.set(p.threadId, held);
      for (const s of p.sources) held.set(s, (held.get(s) ?? 0) + 1);
      // A slate with any hold on it counts as shown for its timers (01, "slates.subscribe").
      runs.shown(p.threadId, true);
      if (p.sources.includes("pr")) {
        const r = records.get(p.threadId);
        if (r !== undefined) deps.watchPr?.(r.workspaceId);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const s of p.sources) {
          const n = (held.get(s) ?? 1) - 1;
          if (n <= 0) held.delete(s);
          else held.set(s, n);
        }
        if (held.size === 0) runs.shown(p.threadId, false);
      };
    },

    async resolve(p) {
      const r = await recordOf(p.threadId);
      if (r === undefined) return { values: Object.fromEntries(p.paths.map(path => [path, null])) };
      const views = await viewsFor(r, p.paths);
      const ctx = contextOf(r, views);
      return { values: Object.fromEntries(p.paths.map(path => [path, mapStrings(evaluateSlateExpression(path, ctx) ?? null, s => scrub(r, s))])) };
    },

    async turnEnded({ threadId, turnId, workspaceId }) {
      await ready();
      // A rewind can no longer be undone once the folder has moved on, the rule the files' own undo keeps.
      for (const r of records.values()) {
        if (r.workspaceId !== workspaceId || r.rewound === undefined || r.threadId === threadId) continue;
        await serial(r.threadId, async () => {
          delete r.rewound;
          await save(r);
        });
      }
      await serial(threadId, async () => {
        const r = records.get(threadId);
        if (r === undefined) return;
        delete r.rewound;
        const key = String(r.revision);
        r.kept[key] ??= structuredClone(snapOf(r));
        delete r.turns[turnId];
        r.turns[turnId] = { at: deps.now(), version: r.version, revision: r.revision };
        trimSnapshots(r);
        await save(r);
      });
    },

    async rewound({ threadId, turnId, cut }) {
      await ready();
      await serial(threadId, async () => {
        const r = records.get(threadId);
        if (r === undefined) return;
        const at = r.turns[turnId];
        const snap = at === undefined ? undefined : r.kept[String(at.revision)];
        r.rewound = { ...snapOf(r), version: r.version, at: deps.now() };
        // Approvals and secrets are the person's, not the document's: a rewind to before the slate keeps the values.
        become(r, snap !== undefined ? structuredClone(snap) : { document: null, values: r.values, empty: "rewound-before" });
        for (const id of cut) delete r.turns[id];
        trimSnapshots(r);
        r.version += 1;
        r.revision += 1;
        await save(r);
        announce(r, "restore", "host", []);
        push(r, Object.keys(r.values));
      });
    },

    async undoRewind(threadId) {
      return serial(threadId, async () => {
        const r = await recordOf(threadId);
        if (r?.rewound === undefined) return false;
        become(r, r.rewound);
        delete r.rewound;
        r.version += 1;
        r.revision += 1;
        await save(r);
        announce(r, "restore", "host", []);
        push(r, Object.keys(r.values));
        return true;
      });
    },

    async hasRewound(threadId) {
      return (await recordOf(threadId))?.rewound !== undefined;
    },

    async forget(threadId) {
      await serial(threadId, async () => {
        runs.drop(threadId);
        records.delete(threadId);
        holds.delete(threadId);
        await deps.store.delete(SLATES, threadId);
      });
    },

    watchesPr(workspaceId) {
      for (const r of records.values()) {
        if (r.workspaceId !== workspaceId) continue;
        if ((holds.get(r.threadId)?.get("pr") ?? 0) > 0) return true;
        if (r.document !== null && /\bpr\.checks\b/.test(JSON.stringify(r.document))) return true;
      }
      return false;
    },
  };
  return slates;
}
