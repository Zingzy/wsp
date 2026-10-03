// SPDX-License-Identifier: AGPL-3.0-only
// The slate as text with its values filled in, returned after every write and read, so an agent with no eyes
// knows what the person sees. Each piece type writes its own line; this file walks the tree, hides what is hidden,
// tags each line with its id and type, and caps the whole.
import { evaluateSlateExpression, parseSlateFormat, resolveSlateProp, slateTruthy } from "./expr.js";
import { SLATE_PIECES, type SlateSketchView } from "./kit.js";
import { SLATE_LIMITS } from "./limits.js";
import { getSlateState } from "./state.js";
import { isSlateBinding, isSlateFormat, type Slate, type SlateEvalContext, type SlateJson, type SlatePiece, type SlateProblem, type SlatePropValue } from "./types.js";

export interface SlateSketchOptions {
  /** The slate's version, for the header. */
  version?: number;
  /** Problems to list at the foot: the host's runtime problems, or the write's warnings. */
  problems?: SlateProblem[];
  /** A check with no thread: bound values show as their expression in braces instead of a figure. */
  unbound?: boolean;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How many props hold a binding or a format string, nested ones counted one by one. */
function boundCount(value: SlatePropValue | undefined): number {
  if (value === null || value === undefined || typeof value !== "object") return 0;
  if (isSlateBinding(value) || isSlateFormat(value)) return 1;
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + boundCount(v), 0);
  return Object.values(value).reduce<number>((n, v) => n + boundCount(v), 0);
}

function braces(value: SlatePropValue): SlateJson {
  if (value === null || typeof value !== "object") return value;
  if (isSlateBinding(value)) return `{${value.bind}}`;
  if (isSlateFormat(value)) return parseSlateFormat(value.format).parts.map(p => (typeof p === "string" ? p : `{${p.expr}}`)).join("");
  if (Array.isArray(value)) return value.map(braces);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, braces(v)]));
}

/** The words a tag carries past id and type: what is not the default, as the person would see it. */
const TAG_PROPS: readonly [string, string][] = [["emphasis", "normal"], ["tone", "default"], ["size", "normal"], ["variant", "default"]];

function cut(text: string, room: number): string {
  if (text.length <= room) return text;
  return room <= 1 ? "…" : `${text.slice(0, room - 1)}…`;
}

export function sketchSlate(doc: Slate | null, state: Record<string, SlateJson>, ctx: SlateEvalContext, opts: SlateSketchOptions = {}): string {
  const version = opts.version !== undefined ? ` v${opts.version}` : "";
  if (doc === null) return `slate${version}, empty: write one with slate set`;
  const read: SlateEvalContext = {
    ...ctx,
    resolve: path => (path === "state" || path.startsWith("state.") || path.startsWith("state[") ? (path === "state" ? state : getSlateState(state, path)) : ctx.resolve(path)),
  };
  const unbound = opts.unbound === true;
  const pieces = Object.keys(doc.pieces).length;
  const bound = Object.values(doc.pieces).reduce((n, p) => n + Object.values(p.props ?? {}).reduce<number>((m, v) => m + boundCount(v), 0), 0);
  const problems = opts.problems ?? [];
  const head = `slate${version}${doc.title !== undefined ? ` ${JSON.stringify(doc.title)}` : ""}, ${plural(pieces, "piece")}, ${bound} bound, ${plural(problems.length, "problem")}`;

  const lines: string[] = [];
  let pieceLines = 0;
  let folded = 0;
  const view = (id: string, piece: SlatePiece): SlateSketchView => {
    const rowCtx = (item: SlateJson, index: number): SlateEvalContext => ({ ...read, row: { item, index } });
    return {
      id,
      unbound,
      raw: name => piece.props?.[name],
      bound: name => { const v = piece.props?.[name]; return isSlateBinding(v) || isSlateFormat(v); },
      prop: name => {
        const v = piece.props?.[name];
        if (v === undefined) return undefined;
        return unbound ? braces(v) : resolveSlateProp(v, read);
      },
      row: (spec, item, index) => {
        if (spec === null || typeof spec !== "object" || Array.isArray(spec) || isSlateBinding(spec) || isSlateFormat(spec)) return {};
        return Object.fromEntries(Object.entries(spec).filter(([k]) => k !== "on" && k !== "when").map(([k, v]) => [k, unbound ? braces(v) : resolveSlateProp(v, rowCtx(item, index))]));
      },
      test: (expr, item, index) => slateTruthy(evaluateSlateExpression(expr, rowCtx(item, index))),
    };
  };
  const tag = (id: string, piece: SlatePiece, v: SlateSketchView): string => {
    const words = TAG_PROPS.map(([name]) => (unbound && v.bound(name) ? undefined : v.prop(name)))
      .filter((w, i): w is string => typeof w === "string" && w !== TAG_PROPS[i]![1]);
    return `[${[id, piece.type, ...words].join(" ")}]`;
  };
  const emit = (indent: string, body: string, label: string): void => {
    if (pieceLines >= SLATE_LIMITS.sketchPieceLines) { folded++; return; }
    pieceLines++;
    const room = SLATE_LIMITS.sketchColumns - indent.length - label.length - 2;
    lines.push(body === "" ? `${indent}${label}` : `${indent}${cut(body, Math.max(8, room))}${body === "(hidden)" ? " " : "  "}${label}`);
  };
  const walk = (id: string, depth: number, seen: Set<string>): void => {
    const piece = doc.pieces[id];
    if (piece === undefined || seen.has(id)) return;
    seen.add(id);
    const indent = "  ".repeat(depth);
    const module = SLATE_PIECES[piece.type];
    const v = view(id, piece);
    if (piece.when !== undefined && !unbound && !slateTruthy(evaluateSlateExpression(piece.when, read))) {
      emit(indent, "(hidden)", tag(id, piece, v));
      return;
    }
    const children = piece.children ?? [];
    if (module === undefined) {
      emit(indent, `${typeof piece.fallback === "object" ? piece.fallback.text : "This part needs a newer wsp"}`, `[${id} ${piece.type}]`);
      return;
    }
    const drawn = module.sketch(v);
    const out = Array.isArray(drawn) ? drawn : [drawn];
    const transparent = module.holdsChildren && out.every(l => l === "") ;
    if (!transparent) {
      emit(indent, out[0] ?? "", tag(id, piece, v));
      for (const more of out.slice(1)) if (pieceLines < SLATE_LIMITS.sketchPieceLines) lines.push(`${indent}${cut(more, SLATE_LIMITS.sketchColumns - indent.length)}`);
    }
    const collapsed = piece.type === "section" && v.prop("open") === false;
    if (!collapsed) for (const child of children) walk(child, transparent ? depth : depth + 1, seen);
  };
  const root = doc.pieces[doc.root];
  const seen = new Set<string>();
  if (root !== undefined && (root.children ?? []).length === 0) walk(doc.root, 0, seen);
  else if (root !== undefined) {
    seen.add(doc.root);
    if (root.when !== undefined && !unbound && !slateTruthy(evaluateSlateExpression(root.when, read))) emit("", "(hidden)", tag(doc.root, root, view(doc.root, root)));
    else {
      const module = SLATE_PIECES[root.type];
      const drawn = module?.sketch(view(doc.root, root)) ?? "";
      const own = Array.isArray(drawn) ? drawn : [drawn];
      const listed = own.some(l => l !== "");
      if (listed) emit("", own[0]!, tag(doc.root, root, view(doc.root, root)));
      for (const child of root.children ?? []) walk(child, listed ? 1 : 0, seen);
    }
  }
  if (folded > 0) lines.push(`... and ${folded} more pieces`);
  if (problems.length > 0) {
    lines.push("problems:");
    for (const p of problems) lines.push(`  ${p.code} ${p.piece ?? "slate"}${p.prop !== undefined ? `.${p.prop}` : ""}: ${p.message}${p.since !== undefined ? ` (since ${p.since})` : ""}`);
  }
  const text = [head, ...lines].join("\n");
  const capChars = 2_000 * 4;
  return text.length <= capChars ? text : `${text.slice(0, capChars - 20)}\n... (cut)`;
}
