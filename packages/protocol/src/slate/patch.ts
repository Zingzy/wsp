// SPDX-License-Identifier: AGPL-3.0-only
// A patch applied all or nothing: every op on a copy, the whole result validated, and only then handed back.
import { nearest, slateProblem, type SlateCode } from "./problems.js";
import { parseSlateStatePath, setSlateState } from "./state.js";
import type { Slate, SlateAction, SlateJson, SlatePatchOp, SlatePiece, SlateProblem } from "./types.js";
import { validateSlate } from "./validate.js";

class OpFault extends Error {
  constructor(readonly code: SlateCode, message: string, readonly fix?: string) { super(message); }
}

function parentOf(doc: Slate, id: string): string | undefined {
  for (const [pid, p] of Object.entries(doc.pieces)) if (p.children?.includes(id) === true) return pid;
  return undefined;
}

function detach(doc: Slate, id: string): void {
  for (const p of Object.values(doc.pieces)) {
    if (p.children?.includes(id) !== true) continue;
    p.children = p.children.filter(c => c !== id);
    if (p.children.length === 0) delete p.children;
  }
}

function attach(doc: Slate, id: string, under: string, at: number | undefined): void {
  const parent = doc.pieces[under];
  if (parent === undefined) throw new OpFault("D203", `under names "${under}" but no piece has that id`, nearest(under, Object.keys(doc.pieces)));
  const children = parent.children ?? [];
  const i = at === undefined ? children.length : Math.max(0, Math.min(children.length, at));
  parent.children = [...children.slice(0, i), id, ...children.slice(i)];
}

function removeTree(doc: Slate, id: string): void {
  const piece = doc.pieces[id];
  if (piece === undefined) return;
  delete doc.pieces[id];
  for (const child of piece.children ?? []) removeTree(doc, child);
}

function need(doc: Slate, id: string): SlatePiece {
  const piece = doc.pieces[id];
  if (piece === undefined) throw new OpFault("D203", `no piece has the id ${id}`, nearest(id, Object.keys(doc.pieces)));
  return piece;
}

export function applySlatePatch(doc: Slate, state: Record<string, SlateJson>, ops: SlatePatchOp[]):
  { document?: Slate; state?: Record<string, SlateJson>; errors: SlateProblem[]; warnings: SlateProblem[] } {
  const next = structuredClone(doc);
  let live = structuredClone(state);
  const errors: SlateProblem[] = [];
  const madeBy = new Map<string, number>();
  ops.forEach((op, i) => {
    try {
      switch (op.op) {
        case "add": {
          const all = { [op.id]: op.piece, ...(op.children ?? {}) };
          for (const [id, piece] of Object.entries(all)) {
            if (next.pieces[id] !== undefined) throw new OpFault("P104", `${id} is already a piece; change it with ~ ${id} or remove it first`);
            next.pieces[id] = structuredClone(piece);
            madeBy.set(id, i);
          }
          if (op.under !== undefined) attach(next, op.id, op.under, op.at);
          break;
        }
        case "replace": {
          const old = need(next, op.id);
          const keep = new Set(op.piece.children ?? []);
          for (const child of old.children ?? []) if (!keep.has(child) && op.children?.[child] === undefined) removeTree(next, child);
          next.pieces[op.id] = structuredClone(op.piece);
          for (const [id, piece] of Object.entries(op.children ?? {})) {
            if (next.pieces[id] !== undefined && !keep.has(id)) throw new OpFault("P104", `${id} is already a piece`);
            next.pieces[id] = structuredClone(piece);
            madeBy.set(id, i);
          }
          madeBy.set(op.id, i);
          break;
        }
        case "props": {
          const piece = need(next, op.id);
          if (op.props !== undefined) {
            const props = { ...(piece.props ?? {}) };
            for (const [k, v] of Object.entries(op.props)) {
              if (v === null) delete props[k];
              else props[k] = structuredClone(v);
            }
            if (Object.keys(props).length > 0) piece.props = props;
            else delete piece.props;
          }
          if (op.when === null) delete piece.when;
          else if (op.when !== undefined) piece.when = op.when;
          if (op.fallback === null) delete piece.fallback;
          else if (op.fallback !== undefined) piece.fallback = op.fallback;
          if (op.on !== undefined) piece.on = { ...(piece.on ?? {}), ...(structuredClone(op.on) as Record<string, SlateAction | SlateAction[]>) };
          madeBy.set(op.id, i);
          break;
        }
        case "move": {
          need(next, op.id);
          if (op.id === op.under) throw new OpFault("D205", `${op.id} cannot go under itself`);
          for (let at: string | undefined = op.under; at !== undefined; at = parentOf(next, at)) {
            if (at === op.id) throw new OpFault("D205", `${op.under} is inside ${op.id}; moving ${op.id} under it makes a cycle`);
          }
          detach(next, op.id);
          attach(next, op.id, op.under, op.at);
          madeBy.set(op.id, i);
          break;
        }
        case "remove": {
          need(next, op.id);
          detach(next, op.id);
          removeTree(next, op.id);
          break;
        }
        case "state": {
          if (parseSlateStatePath(op.path) === undefined) throw new OpFault("S501", `${op.path} is not a state path; write state.<key>`);
          live = setSlateState(live, op.path, op.value);
          break;
        }
        case "feed": {
          if (op.feed === null) { if (next.feeds !== undefined) delete next.feeds[op.id]; }
          else (next.feeds ??= {})[op.id] = structuredClone(op.feed);
          if (next.feeds !== undefined && Object.keys(next.feeds).length === 0) delete next.feeds;
          break;
        }
        case "pipe": {
          if (op.pipeline === null) { if (next.pipes !== undefined) delete next.pipes[op.id]; }
          else (next.pipes ??= {})[op.id] = op.pipeline;
          if (next.pipes !== undefined && Object.keys(next.pipes).length === 0) delete next.pipes;
          break;
        }
        default:
          throw new OpFault("P105", `${String((op as { op?: unknown }).op)} is not an op`);
      }
    } catch (e) {
      if (!(e instanceof OpFault)) throw e;
      errors.push(slateProblem(e.code, e.message, { op: i, ...("id" in op && typeof op.id === "string" ? { piece: op.id } : {}), ...(e.fix !== undefined ? { fix: e.fix } : {}) }));
    }
  });
  if (errors.length > 0) return { errors, warnings: [] };
  const checked = validateSlate(next, { stateKeys: Object.keys(live) });
  const withOp = (p: SlateProblem): SlateProblem => (p.piece !== undefined && madeBy.has(p.piece) ? { ...p, op: madeBy.get(p.piece)! } : p);
  if (checked.errors.length > 0) return { errors: checked.errors.map(withOp), warnings: checked.warnings.map(withOp) };
  return { document: next, state: live, errors: [], warnings: checked.warnings.map(withOp) };
}
