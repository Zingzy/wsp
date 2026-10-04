// SPDX-License-Identifier: AGPL-3.0-only
// The slate as text with its values filled in (10, "The sketch"), returned after every write and read so an agent
// with no eyes knows what the person sees. Each piece type writes its own line; this file walks the tree, hides
// what is hidden, tags each line with its id and type, lists the values, runs and problems, and caps the whole.
import { evaluateSlateExpression, parseSlateFormat, resolveSlateProp, slateTruthy, type SlateEvalContext } from "./expr.js";
import { isSlateIcon } from "./icons.js";
import { SLATE_PIECES, slateHeldText, type SlatePieceModule, type SlatePropSpec, type SlateSketchView } from "./kit.js";
import { SLATE_LIMITS } from "./limits.js";
import { parseSlateOwnPath, slateEqual, slateStep } from "./paths.js";
import { slateProblem } from "./problems.js";
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

const size = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

const SECRET_DOTS = "••••";

function shownValue(v: SlateJson | undefined): string {
  if (isSlateSecretHandle(v)) return v.set ? `${SECRET_DOTS} (${v.len} characters)` : "(empty)";
  const s = JSON.stringify(v ?? null);
  return cut(s, SLATE_LIMITS.sketchValueChars);
}

/** An icon a formula named that the kit does not have: the piece draws none, and the agent hears why. */
function iconProblems(doc: SlateDoc, read: SlateEvalContext): SlateProblem[] {
  const out: SlateProblem[] = [];
  const check = (raw: SlatePropValue | undefined, piece: string, prop: string): void => {
    if (!isSlateBinding(raw) && !isSlateFormat(raw)) return;
    const name = resolveSlateProp(raw, read);
    if (typeof name === "string" && name !== "" && !isSlateIcon(name)) out.push(slateProblem("R905", `icon "${name}" is not in the kit, so it draws none; slate_catalog icons lists them`, { piece, prop }));
  };
  const icons = (fields: Readonly<Record<string, SlatePropSpec>>): string[] => Object.entries(fields).filter(([, f]) => f.type === "icon").map(([k]) => k);
  for (const [id, piece] of Object.entries(doc.pieces)) {
    const module: SlatePieceModule | undefined = SLATE_PIECES[piece.type];
    if (module === undefined) continue;
    for (const k of icons(module.props)) check(piece.props?.[k], id, k);
    for (const item of Object.values(module.items)) {
      const list = piece.props?.[item.prop];
      if (Array.isArray(list)) list.forEach((it, i) => { for (const k of icons(item.fields)) check((it as Record<string, SlatePropValue> | null)?.[k], id, `${item.prop}[${i}].${k}`); });
    }
  }
  return out;
}

const kindOf = (v: SlateJson): string => (Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : typeof v === "string" ? "a string" : "a boolean");

/** A value a piece plots that is not a number: the piece draws no point for it, and the agent hears what it read and,
 * where the value holds one, the number it most likely meant. A null is a gap in the line and draws as one. */
function plotProblems(doc: SlateDoc, read: SlateEvalContext): SlateProblem[] {
  const out: SlateProblem[] = [];
  const wrong = (v: SlateJson | undefined): v is Exclude<SlateJson, null | number> => v !== undefined && v !== null && typeof v !== "number";
  const field = (v: SlateJson): string | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? Object.keys(v).find(k => typeof v[k] === "number") : undefined);
  const numeric = (v: SlateJson): boolean => typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));
  for (const [id, piece] of Object.entries(doc.pieces)) {
    const module: SlatePieceModule | undefined = SLATE_PIECES[piece.type];
    if (module === undefined) continue;
    for (const [prop, spec] of Object.entries(module.props)) {
      const raw = piece.props?.[prop];
      if (!isSlateBinding(raw)) continue;
      const bind = raw.bind.trim();
      /** The binding that reads the number the wrong value holds: its one numeric field, or the number a string spells. */
      const meant = (v: SlateJson, list: boolean): string | undefined => {
        const key = field(v);
        if (key !== undefined) return list ? `pluck(${bind}, '${key}')` : `${bind}.${key}`;
        return !list && numeric(v) ? `num(${bind})` : undefined;
      };
      const add = (said: string, rule: string, got: SlateJson, list = false): void => {
        const fix = meant(got, list);
        out.push(slateProblem("R905", `${prop}={${bind}} ${said}; ${rule}${fix !== undefined ? `, like ${prop}={${fix}}` : ""}`, { piece: id, prop, ...(fix !== undefined ? { fix: `${prop}={${fix}}` } : {}) }));
      };
      if (spec.of === "number") {
        const list = resolveSlateProp(raw, read);
        const bad = Array.isArray(list) ? list.filter(wrong) : [];
        if (bad.length > 0) add(`holds ${kindOf(bad[0]!)} in ${bad.length} of ${(list as SlateJson[]).length} places, like ${shownValue(bad[0])}, so it draws no point for them`, "a plotted list holds numbers", bad[0]!, true);
      } else if ((spec.type === "number" || spec.type === "integer") && spec.binds === "item") {
        const items = resolveSlateProp(piece.props?.["items"] ?? null, read);
        const bad = Array.isArray(items) ? items.map((item, index) => resolveSlateProp(raw, { ...read, item, index })).filter(wrong) : [];
        if (bad.length > 0) add(`read ${kindOf(bad[0]!)} on ${bad.length} of ${(items as SlateJson[]).length} rows, like ${shownValue(bad[0])}, so it draws no point for them`, "a plotted value is a number", bad[0]!);
      } else if ((spec.type === "number" || spec.type === "integer") && spec.binds === "yes") {
        const value = resolveSlateProp(raw, read);
        if (wrong(value)) add(`read ${kindOf(value)}, ${shownValue(value)}, so it draws nothing`, "a plotted value is a number", value);
      }
    }
  }
  return out;
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
  const problems = [...(ctx.problems ?? []), ...(unbound ? [] : [...iconProblems(doc, read), ...plotProblems(doc, read)])];
  const head = `slate${version}${doc.title !== undefined ? ` ${JSON.stringify(doc.title)}` : ""}, ${plural(pieces, "piece")}, ${bound} bound, ${plural(problems.length, "problem")}`;

  const lines: string[] = [];
  let pieceLines = 0;
  let folded = 0;
  const view = (id: string, piece: SlatePiece, reads = new Set<string>()): SlateSketchView => {
    const rowCtx = (item: SlateJson, index: number): SlateEvalContext => ({ ...read, item, index });
    return {
      id,
      unbound,
      raw: name => { reads.add(name); return piece.props?.[name]; },
      bound: name => { reads.add(name); const v = piece.props?.[name]; return isSlateBinding(v) || isSlateFormat(v); },
      prop: name => {
        reads.add(name);
        const v = piece.props?.[name];
        if (v === undefined) return undefined;
        return unbound ? braces(v) : resolveSlateProp(v, read);
      },
      row: (spec, item, index) => {
        if (spec === null || typeof spec !== "object" || Array.isArray(spec) || isSlateBinding(spec) || isSlateFormat(spec)) return {};
        return Object.fromEntries(Object.entries(spec).filter(([k]) => k !== "on" && k !== "when").map(([k, v]) => [k, unbound ? braces(v) : resolveSlateProp(v, rowCtx(item, index))]));
      },
      test: (expr, item, index) => unbound || slateTruthy(evaluateSlateExpression(expr, rowCtx(item, index))),
      runKind: path => { const p = parseSlateOwnPath(path); return p === undefined || p.segs.length > 0 ? undefined : doc.runs[p.name]?.kind; },
      read: path => { const p = parseSlateOwnPath(path); return p === undefined ? undefined : p.segs.reduce<SlateJson | undefined>((v, s) => slateStep(v, s), values[p.name]); },
    };
  };
  const tag = (id: string, piece: SlatePiece, v: SlateSketchView, look: string[] = []): string => {
    const words = TAG_PROPS.map(([name]) => (v.bound(name) && unbound ? undefined : v.prop(name)) as SlateJson | undefined).filter((w, i): w is string => typeof w === "string" && w !== TAG_PROPS[i]![1]);
    return `[${[id, piece.type, ...words, ...look].join(" ")}]`;
  };
  /** Every prop the person sees that the piece's own line did not read and is not at its default, as a word: a flag by its name, the rest name=value. */
  const lookWords = (piece: SlatePiece, props: Readonly<Record<string, SlatePropSpec>>, reads: ReadonlySet<string>): string[] => {
    const words: string[] = [];
    for (const [name, spec] of Object.entries(props)) {
      if (spec.unseen !== undefined || spec.binds === "item" || reads.has(name) || TAG_PROPS.some(([t]) => t === name)) continue;
      const raw = piece.props?.[name];
      if (raw === undefined || raw === null || (unbound && (isSlateBinding(raw) || isSlateFormat(raw)))) continue;
      const value = resolveSlateProp(raw, read);
      if (name === "held" && slateHeldText(value) === undefined) continue;
      if (spec.default !== undefined && slateEqual(value, spec.default)) continue;
      if (value === true) words.push(name);
      else if (value !== false && value !== undefined && value !== null) words.push(`${name}=${cut(typeof value === "string" ? value : JSON.stringify(value), 24)}`);
    }
    return words;
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
    const reads = new Set<string>();
    const v = view(id, piece, reads);
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
    const look = lookWords(piece, module.props, reads);
    const transparent = module.holdsChildren && out.every(l => l === "") && look.length === 0;
    if (!transparent) {
      emit(indent, out[0] ?? "", tag(id, piece, v, look));
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
    runLines.push(`  $${name}: ${r.state}${r.refreshing === true ? ", refreshing" : ""}${r.text === true ? ", text only" : ""}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}${r.why !== undefined ? ` ${r.why}` : ""}${r.stale === true ? ", stale: the command changed since it ran" : ""}`);
  }
  if (runLines.length > 0) lines.push("runs:", ...runLines);
  const files = Object.entries(doc.files ?? {});
  if (files.length > 0) lines.push(`files in $SLATE_DIR: ${files.map(([name, text]) => `${name} (${size(new TextEncoder().encode(text).length)})`).join(", ")}`);
  if (problems.length > 0) {
    lines.push("problems:");
    for (const p of problems) lines.push(`  ${p.code} ${p.piece ?? "slate"}${p.prop !== undefined ? `.${p.prop}` : ""}${p.line !== undefined ? ` (line ${p.line})` : ""}: ${p.message}`);
  }
  const text = [head, ...lines].join("\n");
  const capChars = SLATE_LIMITS.sketchTokens * 4;
  return text.length <= capChars ? text : `${text.slice(0, capChars - 20)}\n... (cut)`;
}
