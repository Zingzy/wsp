// SPDX-License-Identifier: AGPL-3.0-only
// The slate as text with its values filled in (10, "The sketch"), returned after every write and read so an agent
// with no eyes knows what the person sees. Each piece type writes its own line; this file walks the tree, hides
// what is hidden, tags each line with its id and type, lists the values, runs and problems, and caps the whole.
import { evaluateSlateExpression, parseSlateFormat, resolveSlateProp, slateTruthy, type SlateEvalContext } from "./expr.js";
import { SLATE_PIECES, type SlateSketchView } from "./kit.js";
import { SLATE_LIMITS } from "./limits.js";
import { parseSlateOwnPath, slateEqual, slateStep } from "./paths.js";
import { isSlateBinding, isSlateFormat, isSlateSecretHandle, type SlateDoc, type SlateJson, type SlatePiece, type SlateProblem, type SlatePropValue, type SlateRunRecord, type SlateValues } from "./types.js";

export interface SlateSketchContext {
  /** The slate's version, for the header. */
  version?: number;
  /** Source paths as the host reads them. */
  resolve?(path: string): SlateJson | undefined;
  now?: number;
  /** The standing problems: the host's runtime problems, or a write's warnings. */
  problems?: SlateProblem[];
  /** A check with no thread: bound values show as their formula in braces. */
  check?: boolean;
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

const TAG_PROPS: readonly [string, string][] = [["tone", "default"], ["emphasis", "normal"], ["size", "normal"], ["variant", "default"]];

function cut(text: string, room: number): string {
  if (text.length <= room) return text;
  return room <= 1 ? "…" : `${text.slice(0, room - 1)}…`;
}

const SECRET_DOTS = "••••";

function shownValue(v: SlateJson | undefined): string {
  if (isSlateSecretHandle(v)) return v.set ? `${SECRET_DOTS} (${v.len} characters)` : "(empty)";
  const s = JSON.stringify(v ?? null);
  return cut(s, SLATE_LIMITS.sketchValueChars);
}

/** The sketch: a header, one line per visible piece, then the values, runs and problems that matter. */
export function sketchSlate(doc: SlateDoc | null, values: SlateValues, ctx: SlateSketchContext = {}): string {
  const version = ctx.version !== undefined ? ` v${ctx.version}` : "";
  if (doc === null) return `slate${version}, empty: write one with slate_write`;
  const unbound = ctx.check === true;
  const derived = new Map<string, SlateJson | undefined>();
  const read: SlateEvalContext = {
    resolve: (path: string) => {
      if (!path.startsWith("$")) return ctx.resolve?.(path);
      const p = parseSlateOwnPath(path);
      if (p === undefined || p.segs.length > 0) return undefined;
      const expr = doc.derived[p.name];
      if (expr !== undefined) {
        if (!derived.has(p.name)) { derived.set(p.name, null); derived.set(p.name, evaluateSlateExpression(expr, read) ?? null); }
        return derived.get(p.name);
      }
      return values[p.name];
    },
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
  };
  const pieces = Object.keys(doc.pieces).length;
  const bound = Object.values(doc.pieces).reduce((n, p) => n + Object.values(p.props ?? {}).reduce<number>((m, v) => m + boundCount(v), 0), 0);
  const problems = ctx.problems ?? [];
  const head = `slate${version}${doc.title !== undefined ? ` ${JSON.stringify(doc.title)}` : ""}, ${plural(pieces, "piece")}, ${bound} bound, ${plural(problems.length, "problem")}`;

  const lines: string[] = [];
  let pieceLines = 0;
  let folded = 0;
  const view = (id: string, piece: SlatePiece): SlateSketchView => {
    const rowCtx = (item: SlateJson, index: number): SlateEvalContext => ({ ...read, item, index });
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
      test: (expr, item, index) => unbound || slateTruthy(evaluateSlateExpression(expr, rowCtx(item, index))),
      read: path => { const p = parseSlateOwnPath(path); return p === undefined ? undefined : p.segs.reduce<SlateJson | undefined>((v, s) => slateStep(v, s), values[p.name]); },
    };
  };
  const tag = (id: string, piece: SlatePiece, v: SlateSketchView): string => {
    const words = TAG_PROPS.map(([name]) => (v.bound(name) && unbound ? undefined : v.prop(name)) as SlateJson | undefined).filter((w, i): w is string => typeof w === "string" && w !== TAG_PROPS[i]![1]);
    return `[${[id, piece.type, ...words].join(" ")}]`;
  };
  const emit = (indent: string, body: string, label: string): void => {
    if (pieceLines >= SLATE_LIMITS.sketchPieceLines) { folded++; return; }
    pieceLines++;
    const room = SLATE_LIMITS.sketchColumns - indent.length - label.length - 2;
    lines.push(body === "" ? `${indent}${label}` : `${indent}${cut(body, Math.max(8, room))}${body === "(hidden)" ? " " : "  "}${label}`);
  };
  const seen = new Set<string>();
  const walk = (id: string, depth: number): void => {
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
    if (module === undefined) {
      if (piece.fallback !== "drop") emit(indent, typeof piece.fallback === "object" ? piece.fallback.text : "This part needs a newer wsp", `[${id} ${piece.type}]`);
      return;
    }
    const drawn = module.sketch(v);
    const out = Array.isArray(drawn) ? drawn : [drawn];
    const transparent = module.holdsChildren && out.every(l => l === "");
    if (!transparent) {
      emit(indent, out[0] ?? "", tag(id, piece, v));
      for (const more of out.slice(1)) if (pieceLines < SLATE_LIMITS.sketchPieceLines) lines.push(`${indent}${cut(more, SLATE_LIMITS.sketchColumns - indent.length)}`);
    }
    if (piece.type === "section" && v.prop("open") === false) return;
    if (module.rowTemplate === true) return;
    for (const child of piece.children ?? []) walk(child, transparent ? depth : depth + 1);
  };
  walk(doc.root, 0);
  if (folded > 0) lines.push(`... and ${folded} more pieces`);

  const valueLines: string[] = [];
  for (const [name, decl] of Object.entries(doc.values)) {
    const live = values[name];
    if (decl.secret === true) { if (isSlateSecretHandle(live) && live.set) valueLines.push(`  $${name} = ${shownValue(live)}`); continue; }
    if (!slateEqual(live, decl.start)) valueLines.push(`  $${name} = ${shownValue(live)}`);
  }
  if (!unbound) for (const name of Object.keys(doc.derived)) valueLines.push(`  $${name} = ${shownValue(read.resolve(`$${name}`))}`);
  if (valueLines.length > 0) lines.push("values:", ...valueLines);
  const runLines: string[] = [];
  for (const name of Object.keys(doc.runs)) {
    const r = values[name] as Partial<SlateRunRecord> | undefined;
    if (r?.state === undefined || r.state === "idle") continue;
    const facts = [r.exit !== undefined && r.exit !== null ? `exit ${r.exit}` : undefined, r.ms !== undefined ? `${r.ms} ms` : undefined].filter(Boolean);
    runLines.push(`  $${name}: ${r.state}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}${r.why !== undefined ? ` ${r.why}` : ""}`);
  }
  if (runLines.length > 0) lines.push("runs:", ...runLines);
  if (problems.length > 0) {
    lines.push("problems:");
    for (const p of problems) lines.push(`  ${p.code} ${p.piece ?? "slate"}${p.prop !== undefined ? `.${p.prop}` : ""}${p.line !== undefined ? ` (line ${p.line})` : ""}: ${p.message}`);
  }
  const text = [head, ...lines].join("\n");
  const capChars = SLATE_LIMITS.sketchTokens * 4;
  return text.length <= capChars ? text : `${text.slice(0, capChars - 20)}\n... (cut)`;
}
