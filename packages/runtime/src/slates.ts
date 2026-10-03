// SPDX-License-Identifier: AGPL-3.0-only
// A thread's slate on the host: one record per thread in the `slates` collection, its versions, its one-step undo,
// its turn snapshots and what a rewind does to it, the ops a window and the slate verbs send, and a press that puts
// a message into the thread (01-architecture, 08-state, 09-actions). The slate module in @wsp/protocol compiles,
// validates and sketches; this file decides who may write, keeps the record and tells the windows.
import {
  applySlatePatch,
  compileSlate,
  compileSlatePatch,
  getSlateState,
  notFoundRefusal,
  parseSlateStatePath,
  printSlate,
  scopeOf,
  setSlateState,
  sketchSlate,
  SlatePatchOpSchema,
  slateDependencies,
  threadWord,
  usageRefusal,
  validateSlate,
  type Caller,
  type SessionSlateEvent,
  type Slate,
  type SlateAction,
  type SlateActAnswer,
  type SlateActOutcome,
  type SlateBy,
  type SlateCause,
  type SlateClearAnswer,
  type SlateEmpty,
  type SlateEvalContext,
  type SlateJson,
  type SlatePatchOp,
  type SlateProblem,
  type SlateReadAnswer,
  type SlateStateAnswer,
  type SlateStateEvent,
  type SlateUndoAnswer,
  type SlateView,
  type SlateWriteAnswer,
} from "@wsp/protocol";
import type { Store } from "./store.js";
import { resolveIn, viewSources, type SlateSourceContext } from "./slate-sources/index.js";

export const SLATES = "slates";

/** The slate's content at one version: what a snapshot, the undo and a rewind keep. */
interface SlateSnap {
  document: Slate | null;
  state: Record<string, SlateJson>;
  empty?: SlateEmpty;
}

/** One thread's slate as the store keeps it (08-state, "The record"). Snapshots are kept by version and turns point
 * at them, so a turn in which nothing about the slate changed adds a pointer and no copy. */
export interface SlateRecord extends SlateSnap {
  threadId: string;
  workspaceId: string;
  rootThreadId: string;
  schema: 1;
  version: number;
  previous?: SlateSnap & { version: number };
  /** By turn id, in the order the turns ended. */
  turns: Record<string, { at: number; version: number }>;
  kept: Record<string, SlateSnap>;
  rewound?: SlateSnap & { version: number; at: number };
  annotations: Record<string, SlateJson>[];
  consents: Record<string, { state: "allowed" | "refused"; at: number }>;
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
}

export interface SlatesDeps {
  store: Store;
  now(): number;
  /** Records an event in the thread's transcript, live to every window. */
  record(event: SessionSlateEvent): void;
  /** Pushes an event to the windows and nowhere else. */
  emit(event: SlateStateEvent): void;
  thread(threadId: string): SlateThreadFacts | undefined;
  /** Every thread under the lead, the lead included. */
  under(lead: string): string[];
  threadOfToken(token: string): string;
  /** What the source resolvers read for this thread. */
  sources(threadId: string, workspaceId: string, state: Record<string, SlateJson>): SlateSourceContext;
  /** Puts a press's message into the thread: a start that the runtime steers or queues as it would any send. */
  deliver(o: { threadId: string; workspaceId: string; prompt: string; requestId: string }): Promise<{ outcome: SlateActOutcome; turnId?: string }>;
  /** A slate in this workspace now binds the pull request's checks, so the host re-reads it sooner while one is pending. */
  watchPr?(workspaceId: string): void;
}

/** Where a slate op names its thread: a window always, a thread's token by itself, a person's shell inside a turn by
 * that turn's token. */
export interface SlateTarget {
  threadId?: string;
  turnToken?: string;
}

const SNAPSHOTS_KEPT = 100;
const SNAPSHOT_BYTES = 8 * 1024 * 1024;
const STATE_BYTES = 256 * 1024;
const MESSAGE_CHARS = 20_000;
const REQUEST_KEPT_MS = 10 * 60_000;
const SEND_EVERY_MS = 2_000;
const ACTIONS_PER_SECOND = 5;
const WRITES_BURST = 20;
const WRITES_PER_SECOND = 5;
const WRITES_PER_HOUR = 600;
const ERRORS_LISTED = 20;
const PIECES_NAMED = 20;
const SOURCE_NAMES = ["thread", "usage", "cost", "time", "git", "pr", "state"];

const problem = (code: string, name: string, message: string, extra: Partial<SlateProblem> = {}): SlateProblem => ({ code, name, message, ...extra });

/** A refusal for a reason other than what was written: the version moved, too fast, nothing to undo. */
const refused = (p: SlateProblem, kind: string): Error => Object.assign(new Error(`${p.code} ${p.name}: ${p.message}`), { kind, code: p.code });

/** A write the compiler or the validator refused, with every error it found and the warnings beside them. */
function invalid(errors: SlateProblem[], warnings: SlateProblem[]): Error {
  const first = errors[0]!;
  const where = [first.line !== undefined ? `line ${first.line}` : undefined, first.piece !== undefined ? (first.prop !== undefined ? `${first.piece}.${first.prop}` : first.piece) : undefined].filter(w => w !== undefined).join(", ");
  const more = errors.length > ERRORS_LISTED ? `, and ${errors.length - ERRORS_LISTED} more` : "";
  const fix = first.fix !== undefined ? `. Did you mean ${first.fix}?` : "";
  const message = `slate refused: ${errors.length} error${errors.length === 1 ? "" : "s"}${more}; the first: ${where === "" ? "" : `${where}: `}${first.code} ${first.name} ${first.message}${fix}`;
  return Object.assign(new Error(message), { kind: "invalid", errors: errors.slice(0, ERRORS_LISTED), warnings });
}

/** Problems from two passes over one document, each once. */
const merged = (...lists: SlateProblem[][]): SlateProblem[] => {
  const seen = new Set<string>();
  return lists.flat().filter(p => {
    const key = JSON.stringify(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Every expression a document carries, from bindings, format holes and `when`: what its dependencies are read off. */
function expressionsOf(doc: Slate): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === "object" && value !== null) {
      const o = value as Record<string, unknown>;
      if (typeof o["bind"] === "string" && Object.keys(o).length === 1) found.push(o["bind"]);
      else if (typeof o["format"] === "string" && Object.keys(o).length === 1) for (const m of o["format"].matchAll(/\$\{([^}]*)\}/g)) found.push(m[1]!);
      else Object.values(o).forEach(visit);
    }
  };
  for (const piece of Object.values(doc.pieces)) {
    visit(piece.props);
    if (piece.when !== undefined) found.push(piece.when);
  }
  return found;
}

/** The source names a document or a list of paths reads, read off its text so a source the evaluator cannot yet
 * name still gets viewed. */
const sourcesNamed = (text: string): string[] => SOURCE_NAMES.filter(name => new RegExp(`\\b${name}\\.`).test(text));

const actionsOf = (on: Slate["pieces"][string]["on"], event: string): SlateAction[] => {
  const listed = on?.[event as keyof NonNullable<typeof on>];
  return listed === undefined ? [] : Array.isArray(listed) ? listed : [listed];
};

/** A carried value with any line that would read as a second `slate:` line made harmless (13-security). */
function defanged(value: SlateJson): SlateJson {
  if (typeof value === "string") return value.replace(/^(\s*slate)\s*:(?=\s*\{)/gm, "$1：");
  if (Array.isArray(value)) return value.map(defanged);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, defanged(v)]));
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

/** What each outcome reads as under the pressed piece (09-actions, "Outcomes shown to the person"). */
const SAID: Record<"send" | "steer" | "queue", Record<SlateActOutcome, string>> = {
  send: { started: "Sent", steered: "Sent into the running turn", queued: "Waiting for the turn to end" },
  steer: { started: "Nothing was running, so it was sent as the next message", steered: "Sent into the running turn", queued: "Waiting for the turn to end" },
  // A queue that waits even where the agent takes messages mid-turn needs a flag on the start this build lacks, so
  // it goes as a send, and the person is told when that meant joining the running turn.
  queue: { started: "Sent", steered: "Sent into the running turn; this agent takes messages mid-turn", queued: "Waiting for the turn to end" },
};

export interface Slates {
  get(threadId: string): Promise<SlateView | null>;
  set(p: SlateTarget & { lines?: string; document?: Record<string, unknown>; ifVersion?: number }, caller?: Caller): Promise<SlateWriteAnswer>;
  patch(p: SlateTarget & { lines?: string; ops?: Record<string, unknown>[]; ifVersion?: number }, caller?: Caller): Promise<SlateWriteAnswer>;
  state(p: SlateTarget & { values: Record<string, unknown>; ifVersion?: number; sketch?: boolean }, caller?: Caller): Promise<SlateStateAnswer>;
  read(p: SlateTarget & { values?: string[]; lines?: boolean; sketch?: boolean }, caller?: Caller): Promise<SlateReadAnswer>;
  undo(p: SlateTarget, caller?: Caller): Promise<SlateUndoAnswer>;
  clear(p: SlateTarget, caller?: Caller): Promise<SlateClearAnswer>;
  shown(threadId: string): Promise<void>;
  act(p: { threadId: string; version: number; piece: string; event: string; action: number; requestId: string; scope?: { item: unknown; index: number } }): Promise<SlateActAnswer>;
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
}

export function createSlates(deps: SlatesDeps): Slates {
  const records = new Map<string, SlateRecord>();
  let loaded: Promise<void> | undefined;
  const ready = (): Promise<void> =>
    (loaded ??= deps.store.list(SLATES).then(list => {
      for (const r of list as SlateRecord[]) if (!records.has(r.threadId)) records.set(r.threadId, r);
    }));
  const queues = new Map<string, Promise<unknown>>();
  /** One change at a time per thread: a press, a write and a turn's end never interleave on one record. */
  const serial = <T>(threadId: string, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(threadId) ?? Promise.resolve()).then(run, run);
    queues.set(threadId, next.catch(() => {}));
    return next;
  };
  const save = (r: SlateRecord): Promise<void> => {
    r.updatedAt = deps.now();
    return deps.store.put(SLATES, r.threadId, r);
  };

  const writes = new Map<string, { tokens: number; at: number; hour: number[] }>();
  /** Agent writes: 5 a second sustained, a burst of 20, 600 an hour (V701). */
  const spendWrite = (threadId: string): void => {
    const now = deps.now();
    const b = writes.get(threadId) ?? { tokens: WRITES_BURST, at: now, hour: [] };
    b.tokens = Math.min(WRITES_BURST, b.tokens + ((now - b.at) / 1000) * WRITES_PER_SECOND);
    b.at = now;
    b.hour = b.hour.filter(t => now - t < 3_600_000);
    writes.set(threadId, b);
    if (b.tokens < 1 || b.hour.length >= WRITES_PER_HOUR) {
      const wait = b.tokens < 1 ? Math.ceil((1 - b.tokens) / WRITES_PER_SECOND) : Math.ceil((3_600_000 - (now - b.hour[0]!)) / 1000);
      throw refused(problem("V701", "rate-limited", `wait ${wait} s; a slate that rewrites itself constantly is a bug`), "conflict");
    }
    b.tokens -= 1;
    b.hour.push(now);
  };

  const presses = new Map<string, { at: number[]; sentAt?: number }>();
  const requests = new Map<string, { at: number; answer: Promise<SlateActAnswer> }>();

  const holds = new Map<string, Map<string, number>>();

  /** The thread a slate op is about, read off the caller's token before any argument (13-security). */
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

  const byOf = (caller: Caller | undefined): SlateBy => (scopeOf(caller) !== undefined ? "agent" : "person");

  const recordOf = async (threadId: string): Promise<SlateRecord | undefined> => {
    await ready();
    const held = records.get(threadId);
    if (held !== undefined) return held;
    const stored = (await deps.store.get(SLATES, threadId)) as SlateRecord | undefined;
    if (stored !== undefined) records.set(threadId, stored);
    return stored;
  };
  const needRecord = async (threadId: string): Promise<SlateRecord> => {
    const r = await recordOf(threadId);
    if (r === undefined || (r.document === null && r.version === 0)) throw Object.assign(new Error("Z802 no-slate: this thread has no slate yet; write one with slate set"), { kind: "usage", code: "Z802" });
    return r;
  };
  const freshRecord = (threadId: string): SlateRecord => {
    const facts = deps.thread(threadId);
    if (facts === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
    return { threadId, workspaceId: facts.workspaceId, rootThreadId: facts.rootThreadId, schema: 1, version: 0, document: null, state: {}, empty: "none", turns: {}, kept: {}, annotations: [], consents: {}, shownOnce: false, updatedAt: deps.now() };
  };

  const checkVersion = (r: SlateRecord, ifVersion: number | undefined): void => {
    if (ifVersion !== undefined && ifVersion !== r.version) throw refused(problem("V700", "version-behind", `the slate is at version ${r.version}, not ${ifVersion}; read it and write again`), "conflict");
  };

  const announce = (r: SlateRecord, cause: SlateCause, by: SlateBy, pieces: string[]): void => {
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
    });
  };

  /** The sources a document and a set of extra paths read, viewed once for this record. */
  const viewsFor = async (r: SlateRecord, extra: readonly string[] = []) => {
    const text = `${r.document === null ? "" : JSON.stringify(r.document)} ${extra.join(" ")}`;
    return viewSources(["state", ...sourcesNamed(text)], deps.sources(r.threadId, r.workspaceId, r.state));
  };

  const contextOf = (views: Map<string, SlateJson | undefined>): SlateEvalContext => ({ resolve: path => resolveIn(views, path), now: deps.now() });

  const sketchOf = async (r: SlateRecord): Promise<string> => sketchSlate(r.document, r.state, contextOf(await viewsFor(r)));

  /** The paths a document binds, as the evaluator names them. */
  const boundPaths = (doc: Slate): string[] => [...new Set(expressionsOf(doc).flatMap(e => slateDependencies(e)))];

  /** What the agent is owed on a read: data that has not arrived, and a slate a rewind emptied. */
  const problemsOf = (r: SlateRecord, views: Map<string, SlateJson | undefined>): SlateProblem[] => {
    const found: SlateProblem[] = [];
    if (r.document === null && r.empty === "rewound-before") found.push(problem("Z804", "rewound-before", "the thread was rewound to before this slate existed; write one with slate set"));
    if (r.document !== null)
      for (const path of boundPaths(r.document)) {
        if (path.startsWith("item") || path.startsWith("index") || path.startsWith("state.")) continue;
        if (resolveIn(views, path) === undefined) found.push(problem("R900", "data-missing", `${path} has no value yet`));
      }
    return found;
  };

  const viewOf = (r: SlateRecord): SlateView => ({
    threadId: r.threadId,
    workspaceId: r.workspaceId,
    version: r.version,
    document: r.document,
    state: r.state,
    ...(r.document === null ? { empty: r.empty ?? "none" } : {}),
    annotations: r.annotations,
    consents: r.consents,
    problems: [],
    shownOnce: r.shownOnce,
    canUndo: r.previous !== undefined,
    rewound: r.rewound !== undefined,
    updatedAt: r.updatedAt,
  });

  const snapOf = (r: SlateRecord): SlateSnap => ({ document: r.document, state: r.state, ...(r.empty !== undefined ? { empty: r.empty } : {}) });
  const become = (r: SlateRecord, snap: SlateSnap): void => {
    r.document = snap.document;
    r.state = snap.state;
    if (snap.document === null) r.empty = snap.empty ?? "none";
    else delete r.empty;
  };

  /** A new document's live state: keys both documents declare keep their live value, keys only the new one declares
   * start at its value, keys only the old one declared go, and keys neither declares (written by actions) stay. */
  const stateFor = (old: SlateRecord, next: Slate): Record<string, SlateJson> => {
    const before = old.document?.state ?? {};
    const after = next.state ?? {};
    const live: Record<string, SlateJson> = {};
    for (const [key, value] of Object.entries(old.state)) if (!(key in before) || key in after) live[key] = value;
    for (const [key, value] of Object.entries(after)) if (!(key in before) || !(key in live)) live[key] = structuredClone(value);
    return live;
  };

  const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

  /** Drops the oldest snapshots past the count and the byte cap, then every kept version no turn points at. */
  const trimSnapshots = (r: SlateRecord): void => {
    const order = Object.keys(r.turns);
    while (order.length > SNAPSHOTS_KEPT) delete r.turns[order.shift()!];
    const used = (): Set<string> => new Set(Object.values(r.turns).map(t => String(t.version)));
    for (const v of Object.keys(r.kept)) if (!used().has(v)) delete r.kept[v];
    while (order.length > 1 && sizeOf(r.kept) > SNAPSHOT_BYTES) {
      delete r.turns[order.shift()!];
      const live = used();
      for (const v of Object.keys(r.kept)) if (!live.has(v)) delete r.kept[v];
    }
  };

  const writeDocument = async (r: SlateRecord, next: Slate, cause: "set" | "patch", by: SlateBy, state: Record<string, SlateJson>, pieces: string[], warnings: SlateProblem[]): Promise<SlateWriteAnswer> => {
    if (sizeOf(state) > STATE_BYTES) throw invalid([problem("S500", "state-too-big", `the state is ${sizeOf(state)} bytes; it holds at most ${STATE_BYTES}`)], warnings);
    if (r.version > 0) r.previous = { ...snapOf(r), version: r.version };
    r.document = next;
    r.state = state;
    delete r.empty;
    r.version += 1;
    records.set(r.threadId, r);
    await save(r);
    announce(r, cause, by, pieces);
    if (/\bpr\.checks\b/.test(JSON.stringify(next))) deps.watchPr?.(r.workspaceId);
    const views = await viewsFor(r);
    return { version: r.version, sketch: sketchSlate(r.document, r.state, contextOf(views)), warnings, problems: problemsOf(r, views) };
  };

  const exactlyOne = (named: Record<string, unknown>): void => {
    const given = Object.entries(named).filter(([, v]) => v !== undefined).map(([k]) => k);
    if (given.length !== 1) throw Object.assign(usageRefusal(`A601 action-arg: a slate write takes exactly one of ${Object.keys(named).join(" or ")}, and this one has ${given.length === 0 ? "none" : given.join(" and ")}:`, `send ${Object.keys(named)[0]} alone.`), { code: "A601" });
  };

  const slates: Slates = {
    async get(threadId) {
      const r = await recordOf(threadId);
      return r === undefined ? null : viewOf(r);
    },

    async set(p, caller) {
      const threadId = targetOf(p, caller, true);
      exactlyOne({ lines: p.lines, document: p.document });
      return serial(threadId, async () => {
        const r = (await recordOf(threadId)) ?? freshRecord(threadId);
        checkVersion(r, p.ifVersion);
        let warnings: SlateProblem[] = [];
        let doc: Slate | undefined;
        if (p.lines !== undefined) {
          const compiled = compileSlate(p.lines);
          if (compiled.errors.length > 0 || compiled.document === undefined) throw invalid(compiled.errors, compiled.warnings);
          warnings = compiled.warnings;
          doc = compiled.document;
        }
        const checked = validateSlate(doc ?? p.document);
        if (checked.errors.length > 0 || checked.document === undefined) throw invalid(checked.errors, merged(warnings, checked.warnings));
        warnings = merged(warnings, checked.warnings);
        if (byOf(caller) === "agent") spendWrite(threadId);
        return writeDocument(r, checked.document, "set", byOf(caller), stateFor(r, checked.document), Object.keys(checked.document.pieces), warnings);
      });
    },

    async patch(p, caller) {
      const threadId = targetOf(p, caller, true);
      exactlyOne({ lines: p.lines, ops: p.ops });
      return serial(threadId, async () => {
        const r = await needRecord(threadId);
        if (r.document === null) throw Object.assign(new Error("Z802 no-slate: this slate is empty; write one with slate set"), { kind: "usage", code: "Z802" });
        checkVersion(r, p.ifVersion);
        let ops: SlatePatchOp[];
        if (p.lines !== undefined) {
          const compiled = compileSlatePatch(p.lines, r.document);
          if (compiled.errors.length > 0 || compiled.ops === undefined) throw invalid(compiled.errors, []);
          ops = compiled.ops;
        } else {
          const read = (p.ops ?? []).map((op, i) => ({ i, parsed: SlatePatchOpSchema.safeParse(op) }));
          const bad = read.filter(o => !o.parsed.success);
          if (bad.length > 0) throw invalid(bad.map(o => problem("P105", "unknown-op", `op ${o.i} is not a patch op: ${o.parsed.error?.issues[0]?.message ?? "unreadable"}`, { op: o.i })), []);
          ops = read.map(o => o.parsed.data!);
        }
        const applied = applySlatePatch(r.document, r.state, ops);
        if (applied.errors.length > 0 || applied.document === undefined) throw invalid(applied.errors, applied.warnings);
        const checked = validateSlate(applied.document);
        if (checked.errors.length > 0 || checked.document === undefined) throw invalid(checked.errors, merged(applied.warnings, checked.warnings));
        if (byOf(caller) === "agent") spendWrite(threadId);
        const touched = [...new Set(ops.flatMap(op => ("id" in op ? [op.id] : [])))];
        return writeDocument(r, checked.document, "patch", byOf(caller), applied.state ?? r.state, touched, merged(applied.warnings, checked.warnings));
      });
    },

    async state(p, caller) {
      const threadId = targetOf(p, caller, true);
      return serial(threadId, async () => {
        const r = await needRecord(threadId);
        checkVersion(r, p.ifVersion);
        let state = r.state;
        for (const [path, value] of Object.entries(p.values)) {
          if (parseSlateStatePath(path) === undefined) throw invalid([problem("S501", "state-key", `${path} is not a state path; a state path reads state.<key>, with .field and [index] below it`, { fix: path.startsWith("state.") ? undefined : `state.${path}` })], []);
          state = setSlateState(state, path, value as SlateJson);
        }
        if (sizeOf(state) > STATE_BYTES) throw invalid([problem("S500", "state-too-big", `the state would be ${sizeOf(state)} bytes; it holds at most ${STATE_BYTES}`)], []);
        const by = byOf(caller);
        if (by === "agent") spendWrite(threadId);
        r.state = state;
        r.version += 1;
        await save(r);
        const values = Object.fromEntries(Object.keys(p.values).map(path => [path, getSlateState(state, path) ?? null]));
        deps.emit({ type: "slate.state", workspaceId: r.workspaceId, threadId, version: r.version, values });
        // The person's typing stays out of the transcript; the agent's writes are each one small event.
        if (by === "agent") announce(r, "state", by, []);
        if (p.sketch !== true) return { version: r.version };
        const views = await viewsFor(r);
        return { version: r.version, sketch: sketchSlate(r.document, r.state, contextOf(views)), problems: problemsOf(r, views) };
      });
    },

    async read(p, caller) {
      const threadId = targetOf(p, caller, false);
      const r = await needRecord(threadId);
      const asked = p.values ?? [];
      const every = asked.includes("*");
      const paths = every && r.document !== null ? boundPaths(r.document) : asked.filter(v => v !== "*");
      const views = await viewsFor(r, paths);
      const values = Object.fromEntries(paths.map(path => [path, resolveIn(views, path) ?? null]));
      return {
        schema: 1,
        version: r.version,
        ...(r.document?.title !== undefined ? { title: r.document.title } : {}),
        document: r.document,
        ...(p.lines === true && r.document !== null ? { lines: printSlate(r.document) } : {}),
        state: r.state,
        pipes: {},
        feeds: {},
        values,
        problems: problemsOf(r, views),
        annotations: r.annotations,
        consents: r.consents,
        ...(p.sketch !== false ? { sketch: sketchSlate(r.document, r.state, contextOf(views)) } : {}),
      };
    },

    async undo(p, caller) {
      const threadId = targetOf(p, caller, true);
      return serial(threadId, async () => {
        const r = await needRecord(threadId);
        const back = r.previous;
        if (back === undefined) throw refused(problem("V702", "nothing-to-undo", "there is no earlier slate to go back to; the undo keeps one step"), "conflict");
        r.previous = { ...snapOf(r), version: r.version };
        become(r, back);
        r.version += 1;
        await save(r);
        announce(r, "undo", byOf(caller), []);
        return { version: r.version, sketch: await sketchOf(r) };
      });
    },

    async clear(p, caller) {
      const threadId = targetOf(p, caller, true);
      return serial(threadId, async () => {
        const r = await needRecord(threadId);
        r.previous = { ...snapOf(r), version: r.version };
        r.document = null;
        r.empty = "cleared";
        r.version += 1;
        await save(r);
        announce(r, "clear", byOf(caller), []);
        return { version: r.version };
      });
    },

    async shown(threadId) {
      await serial(threadId, async () => {
        const r = await recordOf(threadId);
        if (r === undefined || r.shownOnce) return;
        r.shownOnce = true;
        await save(r);
      });
    },

    act(p) {
      const now = deps.now();
      for (const [id, held] of requests) if (now - held.at > REQUEST_KEPT_MS) requests.delete(id);
      // A press sent again after a reconnect is the same press: it answers what the first one came to.
      const seen = requests.get(p.requestId);
      if (seen !== undefined) return seen.answer;
      const composed = serial(p.threadId, async () => {
        const r = await needRecord(p.threadId);
        // The host reads the action off its own document, never the window's copy.
        const piece = r.document?.pieces[p.piece];
        if (piece === undefined) throw usageRefusal(`That part of the slate is gone (piece ${p.piece}, version ${p.version}; the slate is at ${r.version}).`, "Press it again once the slate has redrawn.");
        const action = actionsOf(piece.on, p.event)[p.action];
        if (action === undefined) throw usageRefusal(`${p.piece} has no action ${p.action} on ${p.event}.`, "Press it again once the slate has redrawn.");
        if (action.do !== "send" && action.do !== "steer" && action.do !== "queue") throw usageRefusal(`a ${action.do} action runs in the window, not on the host:`, "only send, steer and queue are pressed through the host.");
        const pressed = presses.get(p.threadId) ?? { at: [] };
        pressed.at = pressed.at.filter(t => now - t < 1000);
        if (pressed.at.length >= ACTIONS_PER_SECOND || (pressed.sentAt !== undefined && now - pressed.sentAt < SEND_EVERY_MS)) throw refused(problem("V703", "action-rate", "too fast; try again in a moment"), "conflict");
        pressed.at.push(now);
        pressed.sentAt = now;
        presses.set(p.threadId, pressed);

        const named = action.with ?? [];
        const views = await viewsFor(r, named);
        const row = p.scope === undefined ? undefined : { item: p.scope.item as SlateJson, index: p.scope.index };
        const valueOf = (path: string): SlateJson => {
          if (row !== undefined && (path === "index" || path.startsWith("index"))) return row.index;
          if (row !== undefined && (path === "item" || path.startsWith("item.") || path.startsWith("item["))) return resolveIn(new Map([["item", row.item]]), path) ?? null;
          return resolveIn(views, path) ?? null;
        };
        let carried: SlateJson = Object.fromEntries(named.map(path => [path, defanged(valueOf(path))]));
        const label = typeof piece.props?.["label"] === "string" ? piece.props["label"].slice(0, 80) : undefined;
        const keyField = typeof piece.props?.["key"] === "string" ? piece.props["key"] : undefined;
        const key = row !== undefined && keyField !== undefined ? resolveIn(new Map([["item", row.item]]), `item.${keyField}`) : undefined;
        const line = (w: SlateJson): string =>
          `slate: ${JSON.stringify({ v: 1, kind: "action", thread: threadWord(p.threadId), version: r.version, piece: p.piece, ...(label !== undefined ? { label } : {}), event: p.event, action: action.do, ...(row !== undefined ? { index: row.index } : {}), ...(key !== undefined ? { key } : {}), ...(named.length > 0 ? { with: w } : {}), by: "person", at: new Date(now).toISOString() })}`;
        let prompt = `${action.text}\n\n${line(carried)}`;
        for (let i = 0; prompt.length > MESSAGE_CHARS && i < 50; i++) {
          const long = longest(carried);
          if (long === undefined || long.length < 20) break;
          carried = cutAt(carried, long.at, Math.max(0, long.length - (prompt.length - MESSAGE_CHARS) - 10));
          prompt = `${action.text}\n\n${line(carried)}`;
        }
        return { prompt, kind: action.do, workspaceId: r.workspaceId };
      });
      // Delivered outside the record's queue: a start that waits on a running turn must not hold up that turn's own
      // writes to the slate.
      const answer = composed.then(async ({ prompt, kind, workspaceId }): Promise<SlateActAnswer> => {
        let landed: { outcome: SlateActOutcome; turnId?: string };
        try {
          landed = await deps.deliver({ threadId: p.threadId, workspaceId, prompt, requestId: p.requestId });
        } catch (e) {
          throw Object.assign(new Error(`This thread cannot take a message now: ${e instanceof Error ? e.message : String(e)}`), { kind: (e as { kind?: unknown }).kind ?? "conflict" });
        }
        return { outcome: landed.outcome, said: SAID[kind][landed.outcome], ...(landed.turnId !== undefined ? { turnId: landed.turnId } : {}) };
      });
      requests.set(p.requestId, { at: now, answer });
      // A refused press is not remembered, so the person can press again once the reason is gone.
      answer.catch(() => requests.delete(p.requestId));
      return answer;
    },

    subscribe(p) {
      const held = holds.get(p.threadId) ?? new Map<string, number>();
      holds.set(p.threadId, held);
      for (const s of p.sources) held.set(s, (held.get(s) ?? 0) + 1);
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
      };
    },

    async resolve(p) {
      const r = await recordOf(p.threadId);
      if (r === undefined) return { values: Object.fromEntries(p.paths.map(path => [path, null])) };
      const views = await viewsFor(r, p.paths);
      return { values: Object.fromEntries(p.paths.map(path => [path, resolveIn(views, path) ?? null])) };
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
        const r = await recordOf(threadId);
        if (r === undefined) return;
        delete r.rewound;
        const key = String(r.version);
        r.kept[key] ??= structuredClone(snapOf(r));
        delete r.turns[turnId];
        r.turns[turnId] = { at: deps.now(), version: r.version };
        trimSnapshots(r);
        await save(r);
      });
    },

    async rewound({ threadId, turnId, cut }) {
      await serial(threadId, async () => {
        const r = await recordOf(threadId);
        if (r === undefined) return;
        const at = r.turns[turnId];
        const snap = at === undefined ? undefined : r.kept[String(at.version)];
        r.rewound = { ...snapOf(r), version: r.version, at: deps.now() };
        become(r, snap !== undefined ? structuredClone(snap) : { document: null, state: {}, empty: "rewound-before" });
        for (const id of cut) delete r.turns[id];
        trimSnapshots(r);
        r.version += 1;
        await save(r);
        announce(r, "restore", "host", []);
      });
    },

    async undoRewind(threadId) {
      return serial(threadId, async () => {
        const r = await recordOf(threadId);
        if (r?.rewound === undefined) return false;
        become(r, r.rewound);
        delete r.rewound;
        r.version += 1;
        await save(r);
        announce(r, "restore", "host", []);
        return true;
      });
    },

    async hasRewound(threadId) {
      return (await recordOf(threadId))?.rewound !== undefined;
    },

    async forget(threadId) {
      await serial(threadId, async () => {
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
