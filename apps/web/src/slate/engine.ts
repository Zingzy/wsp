// SPDX-License-Identifier: AGPL-3.0-only
// One slate on screen: its document and live values, what each drawn piece reads, and the scheduler that redraws a
// piece only when something it reads moved. Pieces are keyed by id, so a new document redraws the pieces whose JSON
// changed and nothing else; a binding change marks the pieces whose dependency set holds the path and redraws them
// on the next frame, at most ten times a second. Nothing here knows React; the views subscribe by piece id.
import type { SlateJson, SlatePropValue } from "@wsp/protocol";
import { evaluate, resolveProp, type Resolve, type Row } from "./expr.js";
import type { SlateDoc, SlatePiece } from "./model.js";
import { expandDerived, getOwn, ownPath, pieceReads, setOwn, touches, walk } from "./paths.js";

/** Reads a source path ("pr.checks", "time.now") off whatever the window holds; undefined is not there yet. */
export type SourceReader = (path: string) => SlateJson | undefined;

export interface Scheduler {
  /** Runs fn once soon, at the next frame where there is one. */
  frame(fn: () => void): () => void;
  /** Runs fn after ms. */
  later(fn: () => void, ms: number): () => void;
  now(): number;
}

export const browserScheduler: Scheduler = {
  frame: fn => {
    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(() => fn());
      return () => cancelAnimationFrame(id);
    }
    const id = setTimeout(fn, 16);
    return () => clearTimeout(id);
  },
  later: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  now: () => Date.now(),
};

/** At most ten redraws a second per slate (12-rendering, budgets). */
const MIN_FLUSH_GAP_MS = 100;
/** The document's own listeners: the root, the title, the version. */
export const DOC = "";
/** Listeners on any run's record: the held-run rows under the header. */
export const RUNS = "#runs";
/** The lines a streaming run keeps (07, "Timeouts, output, streaming, cancel"). */
const LINES_KEPT = 500;

type Loud = "primary" | "large" | "accent";

export interface Held {
  readonly mine: SlateJson;
  readonly theirs: SlateJson;
}

export class SlateEngine {
  readonly threadId: string;
  #doc: SlateDoc | null = null;
  #version = 0;
  /** The data revision of the values drawn: orders pushes and records, never shown (ruling 1). */
  #revision = -1;
  #remote: Record<string, SlateJson> = {};
  /** Values typed here that the host has not taken yet, or that a focused field holds against a newer write. */
  #mine = new Map<string, SlateJson>();
  #sent = new Map<string, SlateJson[]>();
  #focused = new Set<string>();
  #held = new Map<string, SlateJson>();
  #view: Record<string, SlateJson> | null = null;
  #pieceJson = new Map<string, string>();
  #versions = new Map<string, number>();
  #revisions = new Map<string, number>();
  #listeners = new Map<string, Set<() => void>>();
  /** Which drawn pieces are shown, so a hidden one reads its `when` alone. */
  #mounted = new Map<string, number>();
  #shown = new Map<string, boolean>();
  #reads = new Map<string, { when: string[]; props: string[] }>();
  #dirty = new Set<string>();
  #cancel: (() => void) | null = null;
  #lastFlush = -Infinity;
  #readsListeners = new Set<() => void>();
  #readsDirty = false;
  #loud = new Map<Loud, string>();
  #parents = new Map<string, string>();
  /** Lines streamed by each run since it last started, ahead of the record's own. */
  #lines = new Map<string, string[]>();
  /** Runs refreshing whose streamed lines are still the last result's. */
  #fresh = new Set<string>();
  /** Section folds that name no value, kept for the window's life by piece id. */
  readonly folds = new Map<string, boolean>();
  #read: SourceReader;
  readonly #scheduler: Scheduler;

  constructor(threadId: string, read: SourceReader = () => undefined, scheduler: Scheduler = browserScheduler) {
    this.threadId = threadId;
    this.#read = read;
    this.#scheduler = scheduler;
  }

  get document(): SlateDoc | null {
    return this.#doc;
  }
  get version(): number {
    return this.#version;
  }

  setReader(read: SourceReader): void {
    this.#read = read;
    this.invalidateAll();
  }

  piece(id: string): SlatePiece | undefined {
    const pieces = this.#doc?.pieces;
    return pieces !== undefined && Object.prototype.hasOwnProperty.call(pieces, id) ? pieces[id] : undefined;
  }

  /** The host's record: a new document diffs against the old by id, so a piece that kept its id and its JSON is
   * not redrawn, and the values that moved redraw what reads them. A record read before a push this window already
   * drew keeps that push's values and adds only what it lacks; one older than the document drawn is dropped whole. */
  setRecord(doc: SlateDoc | null, values: Record<string, SlateJson>, version: number, revision: number): void {
    const stale = revision < this.#revision;
    if (stale && version < this.#version) return;
    const before = this.#doc;
    this.#doc = doc;
    this.#version = version;
    const next = new Map<string, string>();
    for (const [id, piece] of Object.entries(doc?.pieces ?? {})) next.set(id, JSON.stringify(piece));
    const changed = new Set<string>();
    for (const [id, json] of next) if (this.#pieceJson.get(id) !== json) changed.add(id);
    for (const id of this.#pieceJson.keys()) if (!next.has(id)) changed.add(id);
    this.#pieceJson = next;
    for (const id of changed) {
      this.#reads.delete(id);
      this.#revisions.set(id, (this.#revisions.get(id) ?? 0) + 1);
    }
    this.#parents = parentsOf(doc);
    // A piece draws by its place too (a text in a header row, a table beside others): a group that changed redraws
    // its children, and a table reads what the tables beside it read.
    const placed = new Set(changed);
    for (const id of changed) for (const child of doc?.pieces[id]?.children ?? []) placed.add(child);
    for (const id of placed) if (doc?.pieces[id]?.type === "table") for (const other of this.tablesBeside(id)) placed.add(other);
    for (const id of placed) this.#reads.delete(id);
    if (before?.root !== doc?.root || before?.title !== doc?.title || (before === null) !== (doc === null)) changed.add(DOC);
    this.#loud = loudOf(doc);
    if (!stale) this.#revision = revision;
    // Pushes arrive in order, so the window's own copy is newer for every key it holds; the record adds only the
    // values its document declared since.
    const moved = this.#replaceRemote(stale ? { ...values, ...this.#remote } : values).map(key => `$${key}`);
    for (const id of placed) if (this.#mounted.has(id)) this.#dirty.add(id);
    this.#markReading(moved);
    this.#runsMoved(moved);
    if (changed.size > 0) this.#readsChanged();
    this.#schedule();
    this.#bump(DOC);
  }

  /** The values a slate.values push carried, by own path ("$check", "$steps[2].done"); a push at or below the
   * revision drawn is older than what the window has and is dropped. Values never move the version. */
  applyValues(values: Record<string, SlateJson>, revision: number): void {
    if (revision <= this.#revision) return;
    this.#revision = revision;
    const paths: string[] = [];
    for (const [path, value] of Object.entries(values)) {
      if (ownPath(path) === undefined) continue;
      this.#restarted(path, value);
      this.#remote = setOwn(this.#remote, path, value);
      this.#hold(path, value);
      paths.push(path);
    }
    this.#view = null;
    this.invalidate(paths);
    this.#runsMoved(paths);
  }

  #replaceRemote(values: Record<string, SlateJson>): string[] {
    const moved: string[] = [];
    const keys = new Set([...Object.keys(this.#remote), ...Object.keys(values)]);
    for (const key of keys) if (JSON.stringify(this.#remote[key]) !== JSON.stringify(values[key])) moved.push(key);
    for (const key of moved) this.#restarted(`$${key}`, values[key]);
    this.#remote = values;
    for (const path of this.#mine.keys()) {
      const theirs = getOwn(values, path);
      if (theirs !== undefined) this.#hold(path, theirs);
    }
    this.#view = null;
    return moved;
  }

  /** A run that starts again begins its streamed lines afresh; a finished one keeps its last until then (11). */
  #restarted(path: string, value: SlateJson | undefined): void {
    const name = ownPath(path)?.name;
    if (name === undefined || path !== `$${name}` || this.#doc?.runs?.[name] === undefined) return;
    if (walk(value, ["state"]) !== "running") {
      // A refresh that streamed nothing ends on its record's own lines.
      if (this.#fresh.delete(name)) this.#lines.delete(name);
      return;
    }
    if (walk(this.#remote[name], ["state"]) === "running") return;
    // A refresh keeps the last lines drawn until its own first line arrives.
    if (walk(value, ["refreshing"]) === true) this.#fresh.add(name);
    else this.#lines.delete(name);
  }

  #runsMoved(paths: readonly string[]): void {
    const runs = this.#doc?.runs ?? {};
    if (paths.some(path => Object.prototype.hasOwnProperty.call(runs, ownPath(path)?.name ?? ""))) this.#bump(RUNS);
  }

  /** New lines of a streaming run, as slate.run carried them. */
  appendLines(run: string, lines: readonly string[]): void {
    const before = this.#fresh.delete(run) ? [] : (this.#lines.get(run) ?? []);
    const kept = [...before, ...lines].slice(-LINES_KEPT);
    this.#lines.set(run, kept);
    this.invalidate([`$${run}.lines`]);
  }

  /** The run's lines as the window has them: what streamed here, else the record's own. */
  lines(run: string): readonly string[] | undefined {
    return this.#lines.get(run);
  }

  /** Whether a run is refreshing: started again, its last result still in its record until the new one lands. */
  refreshing(run: string): boolean {
    const record = this.#remote[run];
    return this.#doc?.runs?.[run] !== undefined && walk(record, ["state"]) === "running" && walk(record, ["refreshing"]) === true;
  }

  /** Whether a piece under this one reads a refreshing run, short of a nested section and of the run's own output,
   * which each say it themselves. */
  refreshingUnder(id: string): boolean {
    const runs = Object.keys(this.#doc?.runs ?? {}).filter(run => this.refreshing(run));
    return runs.length > 0 && this.#readUnder(id, runs).length > 0;
  }

  /** The runs on a timer that a piece under this one reads, short of a nested section and of a run's own output. */
  timedUnder(id: string): string[] {
    const runs = Object.entries(this.#doc?.runs ?? {}).flatMap(([run, decl]) => (decl.every === undefined ? [] : [run]));
    return runs.length === 0 ? [] : this.#readUnder(id, runs);
  }

  #readUnder(id: string, runs: readonly string[]): string[] {
    const found = new Set<string>();
    const note = (path: string) => {
      for (const run of runs) if (touches(path, `$${run}`)) found.add(run);
    };
    const seen = new Set<string>();
    const visit = (at: string, top: boolean) => {
      if (seen.has(at)) return;
      seen.add(at);
      const piece = this.piece(at);
      if (piece === undefined || (!top && (piece.type === "section" || piece.type === "output"))) return;
      const own = this.#readsOf(at);
      own.when.forEach(note);
      own.props.forEach(note);
      for (const child of piece.children ?? []) visit(child, false);
    };
    visit(id, true);
    return runs.filter(run => found.has(run));
  }

  /** A secret's path: the person types it, the host keeps it, the window holds only its handle (08). */
  isSecret(path: string): boolean {
    const name = ownPath(path)?.name;
    return name !== undefined && this.#doc?.values?.[name]?.secret === true;
  }

  /** A write from elsewhere onto a path this window holds a value for: its own echo is dropped, a focused field
   * keeps the person's text and holds the other until it loses focus. */
  #hold(path: string, theirs: SlateJson): void {
    const mine = this.#mine.get(path);
    if (mine === undefined) return;
    const echoes = this.#sent.get(path) ?? [];
    if (echoes.some(sent => same(sent, theirs))) return;
    if (this.#focused.has(path)) this.#held.set(path, theirs);
    else {
      this.#mine.delete(path);
      this.#sent.delete(path);
    }
  }

  /** The live values as this window draws them: the host's copy under what was typed here. */
  get values(): Record<string, SlateJson> {
    if (this.#view === null) {
      let view = this.#remote;
      for (const [path, value] of this.#mine) view = setOwn(view, path, value);
      this.#view = view;
    }
    return this.#view;
  }

  /** The person typed or picked: the change is drawn at once, before the host answers. */
  writeLocal(path: string, value: SlateJson): void {
    this.#mine.set(path, value);
    this.#view = null;
    this.invalidate([path]);
  }

  /** The value is on its way to the host; its echo must not read as someone else's write. */
  noteSent(path: string, value: SlateJson): void {
    const list = this.#sent.get(path) ?? [];
    list.push(value);
    this.#sent.set(path, list.slice(-20));
  }

  /** The host took the value. */
  settle(path: string, value: SlateJson): void {
    this.#remote = setOwn(this.#remote, path, value);
    if (!this.#focused.has(path) && same(this.#mine.get(path), value)) {
      this.#mine.delete(path);
      this.#sent.delete(path);
    }
    this.#view = null;
  }

  focus(path: string): void {
    this.#focused.add(path);
  }

  /** Answers what was written over the field while the person typed in it, if anything. */
  blur(path: string): Held | undefined {
    this.#focused.delete(path);
    const theirs = this.#held.get(path);
    const mine = this.#mine.get(path);
    if (theirs === undefined || mine === undefined) return undefined;
    return { mine, theirs };
  }

  held(path: string): Held | undefined {
    const theirs = this.#held.get(path);
    const mine = this.#mine.get(path);
    return theirs === undefined || mine === undefined || this.#focused.has(path) ? undefined : { mine, theirs };
  }

  /** Take theirs: the held value replaces the person's. */
  takeTheirs(path: string): void {
    const theirs = this.#held.get(path);
    this.#held.delete(path);
    this.#mine.delete(path);
    this.#sent.delete(path);
    if (theirs !== undefined) this.#remote = setOwn(this.#remote, path, theirs);
    this.#view = null;
    this.invalidate([path]);
  }

  /** Keep mine: the person's value stands and goes to the host again. */
  keepMine(path: string): SlateJson | undefined {
    this.#held.delete(path);
    this.invalidate([path]);
    return this.#mine.get(path);
  }

  /** Reads any path an expression in this slate names: an own value, a derived value evaluated now, the row,
   * or a source. A derived value that reads itself through others is missing, never a loop. */
  reader(row?: Row): Resolve {
    const evaluating = new Set<string>();
    const read: Resolve = path => {
      const own = ownPath(path);
      if (own !== undefined) {
        const formula = this.#doc?.derived?.[own.name];
        if (formula === undefined) return walk(this.values[own.name], own.steps);
        if (evaluating.has(own.name)) return undefined;
        evaluating.add(own.name);
        try {
          return walk(evaluate(formula, read, undefined, this.#scheduler.now()), own.steps);
        } finally {
          evaluating.delete(own.name);
        }
      }
      if (row !== undefined) {
        if (path === "index") return row.index;
        if (path === "item") return row.item;
        if (path.startsWith("item.") || path.startsWith("item[")) return walkFrom(row.item, path.slice(4));
      }
      return this.#read(path);
    };
    return read;
  }

  /** One expression's value; anything that fails to evaluate is missing. */
  evaluate(expr: string, row?: Row): SlateJson | undefined {
    return evaluate(expr, this.reader(row), row, this.#scheduler.now());
  }

  /** One prop's value; anything that fails to evaluate is missing, and the piece draws its quiet placeholder. */
  resolve(value: SlatePropValue | undefined, row?: Row): SlateJson | undefined {
    if (value === undefined) return undefined;
    return resolveProp(value, this.reader(row), row, this.#scheduler.now());
  }

  // Subscriptions, one per drawn piece.

  subscribe(id: string, listener: () => void): () => void {
    let set = this.#listeners.get(id);
    if (set === undefined) this.#listeners.set(id, (set = new Set()));
    set.add(listener);
    const piece = id !== DOC && id !== RUNS;
    if (piece) {
      this.#mounted.set(id, (this.#mounted.get(id) ?? 0) + 1);
      this.#readsChanged();
    }
    return () => {
      set.delete(listener);
      if (!piece) return;
      const left = (this.#mounted.get(id) ?? 1) - 1;
      if (left <= 0) {
        this.#mounted.delete(id);
        this.#shown.delete(id);
      } else this.#mounted.set(id, left);
      this.#readsChanged();
    };
  }

  /** Moves only when the piece's own JSON changed: a patch to it, never a value it reads. */
  revision(id: string): number {
    return this.#revisions.get(id) ?? 0;
  }

  pieceVersion(id: string): number {
    return this.#versions.get(id) ?? 0;
  }

  /** The piece's `when` held or not on its last draw: a hidden piece does not read its props. */
  setShown(id: string, shown: boolean): void {
    if (this.#shown.get(id) === shown) return;
    this.#shown.set(id, shown);
    this.#readsChanged();
  }

  /** The group a piece is drawn in. */
  parent(id: string): SlatePiece | undefined {
    const parent = this.#parents.get(id);
    return parent === undefined ? undefined : this.piece(parent);
  }

  /** The id of the group a piece is drawn in. */
  parentId(id: string): string | undefined {
    return this.#parents.get(id);
  }

  /** The tables drawn in the same section as this one (the slate's root where there is none), itself included,
   * so stacked tables can share their column widths. */
  tablesBeside(id: string): string[] {
    let group = this.#parents.get(id);
    while (group !== undefined && this.piece(group)?.type !== "section" && this.#parents.has(group)) group = this.#parents.get(group);
    if (group === undefined) return [id];
    const out: string[] = [];
    const visit = (at: string) => {
      const piece = this.piece(at);
      if (piece === undefined) return;
      if (piece.type === "table") out.push(at);
      if (at === group || piece.type !== "section") for (const child of piece.children ?? []) visit(child);
    };
    visit(group);
    return out;
  }

  #readsOf(id: string): { when: string[]; props: string[] } {
    let reads = this.#reads.get(id);
    if (reads === undefined) {
      const piece = this.piece(id);
      const derived = this.#doc?.derived ?? {};
      let own = piece === undefined ? { when: [], props: [] } : pieceReads(piece);
      if (piece?.type === "table") {
        const beside = this.tablesBeside(id).flatMap(other => (other === id ? [] : pieceReads(this.piece(other)!).props));
        own = { when: own.when, props: [...new Set([...own.props, ...beside])] };
      }
      reads = { when: expandDerived(own.when, derived), props: expandDerived(own.props, derived) };
      this.#reads.set(id, reads);
    }
    return reads;
  }

  /** Every path a drawn piece reads now: what the source subscriptions are held for. */
  boundPaths(): string[] {
    const out = new Set<string>();
    for (const id of this.#mounted.keys()) {
      const reads = this.#readsOf(id);
      for (const path of reads.when) out.add(path);
      if (this.#shown.get(id) !== false) for (const path of reads.props) out.add(path);
    }
    return [...out];
  }

  onReadsChanged(listener: () => void): () => void {
    this.#readsListeners.add(listener);
    return () => this.#readsListeners.delete(listener);
  }

  #readsChanged(): void {
    if (this.#readsDirty) return;
    this.#readsDirty = true;
    queueMicrotask(() => {
      this.#readsDirty = false;
      for (const listener of [...this.#readsListeners]) listener();
    });
  }

  /** Something at these paths moved: the drawn pieces reading them redraw on the next frame. */
  invalidate(paths: readonly string[]): void {
    if (this.#markReading(paths)) this.#schedule();
  }

  invalidateAll(): void {
    for (const id of this.#mounted.keys()) this.#dirty.add(id);
    this.#schedule();
  }

  #markReading(paths: readonly string[]): boolean {
    let any = false;
    for (const id of this.#mounted.keys()) {
      const reads = this.#readsOf(id);
      const shown = this.#shown.get(id) !== false;
      const hit = paths.some(p => reads.when.some(r => touches(r, p)) || (shown && reads.props.some(r => touches(r, p))));
      if (hit) {
        this.#dirty.add(id);
        any = true;
      }
    }
    return any;
  }

  #schedule(): void {
    if (this.#cancel !== null || this.#dirty.size === 0) return;
    const wait = this.#lastFlush + MIN_FLUSH_GAP_MS - this.#scheduler.now();
    this.#cancel = wait > 0 ? this.#scheduler.later(() => this.#flush(), wait) : this.#scheduler.frame(() => this.#flush());
  }

  /** Redraws what is marked now; tests and a fresh answer call it rather than wait for the frame. */
  flush(): void {
    this.#cancel?.();
    this.#flush();
  }

  #flush(): void {
    this.#cancel = null;
    this.#lastFlush = this.#scheduler.now();
    const dirty = [...this.#dirty];
    this.#dirty.clear();
    for (const id of dirty) this.#bump(id);
  }

  #bump(id: string): void {
    this.#versions.set(id, (this.#versions.get(id) ?? 0) + 1);
    for (const listener of [...(this.#listeners.get(id) ?? [])]) listener();
  }

  /** Whether this piece is the slate's one primary button, one large figure or one accent: the first in display
   * order keeps it and the rest draw quiet (05-styling). */
  isLoud(kind: Loud, id: string): boolean {
    return this.#loud.get(kind) === id;
  }

  dispose(): void {
    this.#cancel?.();
    this.#cancel = null;
  }
}

function same(a: SlateJson | undefined, b: SlateJson | undefined): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function walkFrom(item: SlateJson, rest: string): SlateJson | undefined {
  let at: SlateJson | undefined = item;
  const steps = rest.match(/\.[a-zA-Z_][a-zA-Z0-9_]*|\[-?\d+\]/g) ?? [];
  for (const step of steps) {
    if (at === null || at === undefined || typeof at !== "object") return undefined;
    if (step.startsWith("[")) {
      if (!Array.isArray(at)) return undefined;
      const n = Number(step.slice(1, -1));
      at = at[n < 0 ? at.length + n : n];
    } else {
      if (Array.isArray(at)) return undefined;
      const key = step.slice(1);
      at = Object.prototype.hasOwnProperty.call(at, key) ? at[key] : undefined;
    }
  }
  return at;
}

function parentsOf(doc: SlateDoc | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, piece] of Object.entries(doc?.pieces ?? {})) for (const child of piece.children ?? []) if (!out.has(child)) out.set(child, id);
  return out;
}

/** The first piece in display order to ask for each loud thing with a literal. */
function loudOf(doc: SlateDoc | null): Map<Loud, string> {
  const out = new Map<Loud, string>();
  if (doc === null) return out;
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const piece = doc.pieces[id];
    if (piece === undefined) return;
    const props = piece.props ?? {};
    if (props["variant"] === "primary" && !out.has("primary")) out.set("primary", id);
    if (props["size"] === "large" && !out.has("large")) out.set("large", id);
    // A chart draws its line in the accent unless it names another tone, so the first chart takes the slate's one hue.
    if ((props["tone"] === "accent" || (piece.type === "chart" && props["tone"] === undefined)) && !out.has("accent")) out.set("accent", id);
    for (const child of piece.children ?? []) visit(child);
  };
  visit(doc.root);
  return out;
}
