// SPDX-License-Identifier: AGPL-3.0-only
// The batch's pure core (02, "The batch"): one arrival in, the values to store and what to do out. The host feeds
// it writes (an input's text, the agent's slate state, a run's record, a secret's handle) and a piece's event, and
// acts on what comes back: runs to start and cancel, messages to send, window steps to hand back. Derived values
// recompute before reactions fire, reactions fire in document order, a set in one round is seen by the next, and
// past 8 rounds the batch stops with R910.
import { evaluateSlateExpression, resolveSlateProp, type SlateEvalContext } from "./expr.js";
import { SLATE_LIMITS } from "./limits.js";
import { getSlateValue, parseSlateOwnPath, setSlateValue, slateEqual } from "./paths.js";
import { slateProblem, type SlateCode } from "./problems.js";
import { SLATE_STEPS } from "./steps.js";
import {
  isSlateSecretHandle,
  type SlateDoc, type SlateEventName, type SlateJson, type SlatePiece, type SlateProblem, type SlateRunRecord, type SlateRowAction,
  type SlateSendStep, type SlateStep, type SlateValues,
} from "./types.js";

export type SlateWriter = "person" | "agent" | "reaction" | "run" | "timer" | "host";

export interface SlateBatchContext {
  /** Source paths (time.now, pr.checks, ...); own $paths are read from the values. */
  resolve?(path: string): SlateJson | undefined;
  now?: number;
  /** Who made the arrival's writes. Only "run" and "host" may write a run's record. */
  by?: SlateWriter;
  /** A piece's event: its steps (or the row action's) run first, as round 0, with item and index in scope. */
  event?: { piece: string; kind: SlateEventName; item?: SlateJson; index?: number; rowAction?: number };
  /** The record a start puts the run in now: held while it waits for approval, else running. Without it a start is
   * only listed. */
  start?(run: string, by: "person" | "reaction"): SlateRunRecord;
  /** The person's one approval for this slate's reactions to message the agent (07). */
  reactionSends?: boolean;
}

export interface SlateBatchSend extends SlateSendStep {
  /** Each with path as the host read it at the step, row scope and earlier sets included; secrets as handles. */
  values: Record<string, SlateJson>;
  piece?: string;
  reaction?: string;
  by: "person" | "reaction";
}

export interface SlateBatchWindowStep { step: SlateStep; piece: string; value?: SlateJson; values?: Record<string, SlateJson> }

export interface SlateBatchResult {
  values: SlateValues;
  /** The own names whose value moved in this batch, as $name. */
  changed: string[];
  starts: { run: string; by: "person" | "reaction"; why: string }[];
  cancels: string[];
  sends: SlateBatchSend[];
  other: SlateBatchWindowStep[];
  problems: SlateProblem[];
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

class Batch {
  values: SlateValues;
  readonly out: SlateBatchResult;
  private derivedCache = new WeakMap<SlateValues, Map<string, SlateJson | undefined>>();

  constructor(private readonly doc: SlateDoc, values: SlateValues, private readonly ctx: SlateBatchContext) {
    this.values = values;
    this.out = { values, changed: [], starts: [], cancels: [], sends: [], other: [], problems: [] };
  }

  private kind(name: string): "value" | "secret" | "derived" | "run" | undefined {
    const v = this.doc.values[name];
    if (v !== undefined) return v.secret === true ? "secret" : "value";
    if (this.doc.derived[name] !== undefined) return "derived";
    if (this.doc.runs[name] !== undefined) return "run";
    return undefined;
  }

  /** An evaluation context over a given set of values, derived values computed on demand and cached per set. */
  evalCtx(values: SlateValues, row?: { item?: SlateJson; index?: number }): SlateEvalContext {
    let cache = this.derivedCache.get(values);
    if (cache === undefined) { cache = new Map(); this.derivedCache.set(values, cache); }
    const derived = cache;
    const resolving = new Set<string>();
    const ctx: SlateEvalContext = {
      resolve: (path: string) => {
        if (!path.startsWith("$")) return this.ctx.resolve?.(path);
        const p = parseSlateOwnPath(path);
        if (p === undefined || p.segs.length > 0) return undefined;
        if (this.doc.derived[p.name] !== undefined) {
          if (derived.has(p.name)) return derived.get(p.name) ?? null;
          if (resolving.has(p.name)) return null;
          resolving.add(p.name);
          const v = evaluateSlateExpression(this.doc.derived[p.name]!, { ...ctx, item: undefined, index: undefined });
          resolving.delete(p.name);
          derived.set(p.name, v ?? null);
          return v ?? null;
        }
        return Object.prototype.hasOwnProperty.call(values, p.name) ? values[p.name] : undefined;
      },
      ...(this.ctx.now !== undefined ? { now: this.ctx.now } : {}),
      ...(row?.item !== undefined ? { item: row.item } : {}),
      ...(row?.index !== undefined ? { index: row.index } : {}),
    };
    return ctx;
  }

  private read(path: string, values: SlateValues): SlateJson | undefined {
    return evaluateSlateExpression(path, this.evalCtx(values));
  }

  private problem(code: SlateCode, message: string, piece?: string): void {
    this.out.problems.push(slateProblem(code, message, piece !== undefined ? { piece } : {}));
  }

  /** One write of the arrival; a refusal is listed and the write is not applied. */
  write(path: string, value: SlateJson, by: SlateWriter): void {
    const p = parseSlateOwnPath(path);
    if (p === undefined) { this.problem("S501", `${path} is not one of the slate's own paths; they read $name`); return; }
    const kind = this.kind(p.name);
    if (kind === undefined) { this.problem("S501", `$${p.name} is not declared`); return; }
    if (kind === "derived") { this.problem("A607", `$${p.name} is derived and cannot be written; write the value it reads`); return; }
    if (kind === "run" && !((by === "run" || by === "host") && p.segs.length === 0)) { this.problem("A607", `$${p.name} is a run; its result is the host's to write`); return; }
    if (kind === "secret" && !(p.segs.length === 0 && isSlateSecretHandle(value) && by !== "agent")) { this.problem("S520", `$${p.name} is a secret; only the person's typing fills it, and its value is its handle`); return; }
    this.set(path, value);
  }

  /** Sets a path; answers why not when it cannot. */
  private set(path: string, value: SlateJson): string | undefined {
    const next = setSlateValue(this.values, path, value);
    if (next === undefined) return `${path} steps into a value that is not a list or a record`;
    if (JSON.stringify(next).length > SLATE_LIMITS.valuesBytes) return `the values would pass ${SLATE_LIMITS.valuesBytes / 1024} KB (S500)`;
    if (!slateEqual(getSlateValue(this.values, path), value)) this.values = next;
    return undefined;
  }

  /** Runs a list of steps; stops at the first refusal, which is listed as R912. */
  steps(steps: SlateStep[], from: { by: "person" | "reaction"; piece?: string; reaction?: string; row?: { item?: SlateJson; index?: number } }): void {
    const who = from.reaction !== undefined ? `reaction ${from.reaction}` : `piece ${from.piece}`;
    for (const [i, s] of steps.entries()) {
      const why = this.step(s, from);
      if (why !== undefined) {
        this.out.problems.push(slateProblem("R912", `${who}, step ${i + 1} (${s.do}): ${why}; the steps after it did not run`, { piece: from.reaction ?? from.piece }));
        return;
      }
    }
  }

  private step(s: SlateStep, from: { by: "person" | "reaction"; piece?: string; reaction?: string; row?: { item?: SlateJson; index?: number } }): string | undefined {
    const ctx = (): SlateEvalContext => this.evalCtx(this.values, from.row);
    switch (s.do) {
      case "set": case "toggle": {
        const p = parseSlateOwnPath(s.path);
        const kind = p !== undefined ? this.kind(p.name) : undefined;
        if (p === undefined || kind === undefined) return `${s.path} is not declared`;
        if (kind === "derived" || kind === "run") return `$${p.name} is ${kind === "derived" ? "derived" : "a run"} and cannot be written (A607)`;
        if (kind === "secret") return `$${p.name} is a secret; only the person's typing fills it (S520)`;
        const value = s.do === "set" ? (resolveSlateProp(s.value, ctx()) ?? null) : getSlateValue(this.values, s.path) !== true;
        return this.set(s.path, value);
      }
      case "start": {
        const decl = this.doc.runs[s.run];
        if (decl === undefined) return `$${s.run} is not a run (K702)`;
        const current = this.values[s.run] as Partial<SlateRunRecord> | undefined;
        if ("once" in decl && decl.once === true && current?.state === "running") return undefined;
        this.out.starts.push({ run: s.run, by: from.by, why: from.reaction !== undefined ? `reaction ${from.reaction}` : `a ${this.ctx.event?.kind ?? "press"} on ${from.piece}` });
        if (this.ctx.start !== undefined) return this.set(`$${s.run}`, this.ctx.start(s.run, from.by) as unknown as SlateJson);
        return undefined;
      }
      case "cancel":
        if (this.doc.runs[s.run] === undefined) return `$${s.run} is not a run (K702)`;
        this.out.cancels.push(s.run);
        return undefined;
      case "send": case "steer": case "queue": {
        if (from.by === "reaction" && this.ctx.reactionSends !== true) return "the person has not let this slate message the agent from a reaction";
        const values: Record<string, SlateJson> = {};
        for (const p of s.with ?? []) values[p] = evaluateSlateExpression(p, ctx()) ?? null;
        this.out.sends.push({ do: s.do, text: s.text, ...(s.with !== undefined ? { with: s.with } : {}), values, ...(from.piece !== undefined ? { piece: from.piece } : {}), ...(from.reaction !== undefined ? { reaction: from.reaction } : {}), by: from.by });
        return undefined;
      }
      default: {
        if (SLATE_STEPS[s.do]?.runs !== "window" || from.by !== "person" || from.piece === undefined) return `${s.do} runs in the window on a press (A608)`;
        const out: SlateBatchWindowStep = { step: s, piece: from.piece };
        if (s.do === "open") out.value = resolveSlateProp(s.target, ctx()) ?? null;
        if (s.do === "copy") out.value = resolveSlateProp(s.text, ctx()) ?? null;
        if (s.do === "fill") { out.values = {}; for (const p of s.with ?? []) out.values[p] = evaluateSlateExpression(p, ctx()) ?? null; }
        this.out.other.push(out);
        return undefined;
      }
    }
  }

  /** The event's steps: the piece's handler, or a row action's. */
  event(): void {
    const e = this.ctx.event;
    if (e === undefined) return;
    const piece: SlatePiece | undefined = this.doc.pieces[e.piece];
    if (piece === undefined) { this.problem("D203", `${e.piece} is not on the slate; press again once it has redrawn`); return; }
    let steps: SlateStep[] | undefined;
    if (e.rowAction !== undefined) {
      const actions = piece.props?.rowActions;
      const action = Array.isArray(actions) ? (actions[e.rowAction] as unknown as SlateRowAction | undefined) : undefined;
      steps = action?.on?.press;
    } else steps = piece.on?.[e.kind];
    if (steps === undefined || steps.length === 0) return;
    let item = e.item;
    if (item === undefined && e.index !== undefined && piece.props?.items !== undefined) {
      const items = resolveSlateProp(piece.props.items, this.evalCtx(this.values));
      item = Array.isArray(items) ? items[e.index] : undefined;
    }
    const by = this.ctx.by === "agent" ? "reaction" : "person";
    this.steps(steps, { by, piece: e.piece, row: { ...(item !== undefined ? { item } : {}), ...(e.index !== undefined ? { index: e.index } : {}) } });
  }

  /** Reactions whose trigger moved between two sets of values, in document order. */
  fired(before: SlateValues, after: SlateValues): { reaction: SlateDoc["reactions"][number]; key: string }[] {
    if (before === after) return [];
    const out: { reaction: SlateDoc["reactions"][number]; key: string }[] = [];
    this.doc.reactions.forEach((r, i) => {
      const key = r.id ?? `reaction-${i + 1}`;
      if ("change" in r.on) {
        if (r.on.change.some(p => !slateEqual(this.read(p, before) ?? null, this.read(p, after) ?? null))) out.push({ reaction: r, key });
        return;
      }
      const was = before[r.on.done] as Partial<SlateRunRecord> | undefined;
      const now = after[r.on.done] as Partial<SlateRunRecord> | undefined;
      if (now?.state !== undefined && TERMINAL.has(now.state) && !slateEqual(was as SlateJson, now as SlateJson)) out.push({ reaction: r, key });
    });
    return out;
  }
}

/** Processes one arrival as one batch (02, "The batch"). Pure: the values passed in are not changed. */
export function runSlateBatch(doc: SlateDoc, values: SlateValues, writes: { path: string; value: SlateJson }[], ctx: SlateBatchContext = {}): SlateBatchResult {
  const b = new Batch(doc, values, ctx);
  const start = values;
  for (const w of writes) b.write(w.path, w.value, ctx.by ?? "agent");
  b.event();
  let before = start;
  for (let round = 1; ; round++) {
    const fired = b.fired(before, b.values);
    if (fired.length === 0) break;
    if (round > SLATE_LIMITS.rounds) {
      b.out.problems.push(slateProblem("R910", `reactions ran ${SLATE_LIMITS.rounds} rounds in one batch and stopped: ${fired.map(f => f.key).join(", ")} would have fired again`));
      break;
    }
    before = b.values;
    for (const f of fired) b.steps(f.reaction.do, { by: "reaction", reaction: f.key });
  }
  const changed = [...new Set([...Object.keys(start), ...Object.keys(b.values)])].filter(n => !slateEqual(start[n], b.values[n])).map(n => `$${n}`);
  return { ...b.out, values: b.values, changed };
}
