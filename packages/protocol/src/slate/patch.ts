// SPDX-License-Identifier: AGPL-3.0-only
// Patches applied all or nothing (03, "Patches"), and the live values a document write keeps (02, "Values").
import { slateProblem } from "./problems.js";
import { validateDocument, type SlateLines } from "./validate.js";
import {
  SLATE_RUN_IDLE, SLATE_SECRET_EMPTY,
  type SlateDoc, type SlateJson, type SlatePatch, type SlatePiece, type SlateProblem, type SlateValues,
} from "./types.js";

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A fresh slate's live values: each value's start, each secret's empty handle, each run idle. */
export function slateStartValues(doc: SlateDoc): SlateValues {
  const out: SlateValues = {};
  for (const [name, v] of Object.entries(doc.values)) out[name] = v.secret === true ? { ...SLATE_SECRET_EMPTY } : copy(v.start);
  for (const name of Object.keys(doc.runs)) out[name] = { ...SLATE_RUN_IDLE };
  return out;
}

/** The live values after a document write: a name both documents declare as the same kind keeps its live value,
 * a name only the new one declares starts fresh, a name only the old one declared is dropped. */
export function carrySlateValues(before: SlateDoc | null, after: SlateDoc, values: SlateValues): SlateValues {
  const kind = (d: SlateDoc | null, n: string): string | undefined =>
    d === null ? undefined : d.values[n] !== undefined ? (d.values[n]!.secret === true ? "secret" : "value") : d.runs[n] !== undefined ? "run" : undefined;
  const fresh = slateStartValues(after);
  const out: SlateValues = {};
  for (const [name, start] of Object.entries(fresh)) {
    const k = kind(after, name);
    out[name] = k !== undefined && k === kind(before, name) && Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : start;
  }
  return out;
}

function subtree(doc: SlateDoc, id: string): string[] {
  const out: string[] = [];
  const walk = (x: string): void => {
    if (out.includes(x)) return;
    out.push(x);
    for (const c of doc.pieces[x]?.children ?? []) walk(c);
  };
  walk(id);
  return out;
}

const parentOf = (doc: SlateDoc, id: string): string | undefined => Object.keys(doc.pieces).find(k => (doc.pieces[k]!.children ?? []).includes(id));

/** Applies a patch to a copy, validates the whole result, and answers it with the values a write keeps; nothing
 * changes when any op or the result fails. clear answers a null document; undo is the host's, which holds the
 * document before the agent's last write, so it is refused here with V752. */
export function applySlatePatch(doc: SlateDoc | null, values: SlateValues, patch: SlatePatch, lines?: SlateLines): { document?: SlateDoc | null; values?: SlateValues; errors: SlateProblem[]; warnings: SlateProblem[] } {
  const ops = patch.ops;
  if (ops.length === 1 && ops[0]!.op === "clear") return { document: null, values, errors: [], warnings: [] };
  if (ops.some(o => o.op === "undo")) return { errors: [slateProblem("V752", "undo goes back to the document before the agent's last write, which the host holds; send <undo /> alone to the host")], warnings: [] };
  if (doc === null) return { errors: [slateProblem("Z802", "there is no slate to patch; write one with <slate>", { fix: "<slate title=\"...\">...</slate>" })], warnings: [] };
  const d = copy(doc);
  const errors: SlateProblem[] = [];
  const fail = (code: Parameters<typeof slateProblem>[0], message: string, piece?: string): void => { errors.push(slateProblem(code, message, { piece, line: piece !== undefined ? lines?.get(piece) : undefined })); };
  const insert = (under: string, ids: string[], at?: number): void => {
    const parent = d.pieces[under]!;
    const list = [...(parent.children ?? [])];
    list.splice(at === undefined ? list.length : Math.max(0, Math.min(list.length, at)), 0, ...ids);
    parent.children = list;
  };
  const detach = (id: string): void => {
    const parent = parentOf(d, id);
    if (parent === undefined) return;
    const p = d.pieces[parent]!;
    p.children = (p.children ?? []).filter(c => c !== id);
    if (p.children.length === 0) delete p.children;
  };
  for (const op of ops) {
    switch (op.op) {
      case "replace": {
        if (d.pieces[op.id] === undefined) { fail("D203", `there is no piece ${op.id} to replace`, op.id); break; }
        const keep = new Set([op.id, ...Object.keys(op.children ?? {})]);
        for (const old of subtree(d, op.id)) if (!keep.has(old)) delete d.pieces[old];
        d.pieces[op.id] = copy(op.piece);
        for (const [k, p] of Object.entries(op.children ?? {})) d.pieces[k] = copy(p);
        break;
      }
      case "props": {
        const p = d.pieces[op.id];
        if (p === undefined) { fail("D203", `there is no piece ${op.id}`, op.id); break; }
        for (const [k, v] of Object.entries(op.props ?? {})) {
          if (v === null) { if (p.props !== undefined) delete p.props[k]; }
          else (p.props ??= {})[k] = copy(v);
        }
        if (p.props !== undefined && Object.keys(p.props).length === 0) delete p.props;
        if (op.when === null) delete p.when; else if (op.when !== undefined) p.when = op.when;
        if (op.fallback === null) delete p.fallback; else if (op.fallback !== undefined) p.fallback = op.fallback;
        for (const [ev, steps] of Object.entries(op.on ?? {})) (p.on ??= {})[ev as keyof NonNullable<SlatePiece["on"]>] = copy(steps);
        break;
      }
      case "add": {
        if (d.pieces[op.under] === undefined) { fail("D203", `there is no piece ${op.under} to add under`, op.under); break; }
        for (const [k, p] of Object.entries(op.pieces)) {
          if (d.pieces[k] !== undefined) { fail("P104", `${k} is already a piece; replace it by writing it with its id`, k); continue; }
          d.pieces[k] = copy(p);
        }
        insert(op.under, op.order, op.at);
        break;
      }
      case "remove": {
        if (d.pieces[op.id] === undefined) { fail("D203", `there is no piece ${op.id} to remove`, op.id); break; }
        if (op.id === d.root) { fail("D202", "the root piece cannot be removed; write <clear /> or replace it", op.id); break; }
        detach(op.id);
        for (const x of subtree(d, op.id)) delete d.pieces[x];
        break;
      }
      case "move": {
        if (d.pieces[op.id] === undefined || d.pieces[op.under] === undefined) { fail("D203", `move names ${d.pieces[op.id] === undefined ? op.id : op.under}, which is not a piece`, op.id); break; }
        if (subtree(d, op.id).includes(op.under)) { fail("D205", `${op.id} cannot move under itself`, op.id); break; }
        detach(op.id);
        insert(op.under, [op.id], op.at);
        break;
      }
      case "value": if (op.decl === null) delete d.values[op.name]; else d.values[op.name] = copy(op.decl); break;
      case "derived": if (op.expr === null) delete d.derived[op.name]; else d.derived[op.name] = op.expr; break;
      case "run": if (op.decl === null) delete d.runs[op.name]; else d.runs[op.name] = copy(op.decl); break;
      case "reaction": {
        const i = d.reactions.findIndex(r => r.id === op.id);
        if (op.reaction === null) { if (i < 0) fail("D203", `there is no reaction ${op.id}`, op.id); else d.reactions.splice(i, 1); }
        else if (i >= 0) d.reactions[i] = copy(op.reaction);
        else d.reactions.push(copy(op.reaction));
        break;
      }
      case "file": {
        if (op.text !== null) (d.files ??= {})[op.name] = op.text;
        else if (d.files?.[op.name] === undefined) fail("D203", `there is no file ${op.name}`);
        else { delete d.files[op.name]; if (Object.keys(d.files).length === 0) delete d.files; }
        break;
      }
      case "clear": fail("P105", "<clear /> stands alone in its write"); break;
      default: break;
    }
  }
  if (errors.length > 0) return { errors, warnings: [] };
  const v = validateDocument(d, lines);
  if (v.errors.length > 0) return { errors: v.errors, warnings: v.warnings };
  return { document: d, values: carrySlateValues(doc, d, values) as Record<string, SlateJson>, errors: [], warnings: v.warnings };
}
