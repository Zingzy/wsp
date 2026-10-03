// SPDX-License-Identifier: AGPL-3.0-only
// The one check every write passes: the document's frame, its tree, every piece's props against its type, every
// expression against the sources and the slate's state, every action against its kind. It reports every error it
// finds in one pass, up to twenty, each with the piece and prop it is on and the fix where one is computable.
import { checkSlateExpression, parseSlateFormat, type SlateCheckScope, type SlateType } from "./expr.js";
import { SLATE_ACTIONS, SLATE_LATER_ACTIONS, SLATE_LATER_PIECES, SLATE_PIECES, SLATE_RESERVED_PROPS, SLATE_RESERVED_WORDS, SLATE_SOURCES, slateShapeText, slateSourcePaths, type SlatePropSpec, type SlateShape } from "./kit.js";
import { SLATE_LIMITS } from "./limits.js";
import { nearest, orList, SLATE_WARNINGS, slateProblem, type SlateCode } from "./problems.js";
import { parseSlateStatePath } from "./state.js";
import { isSlateBinding, isSlateFormat, SLATE_EVENTS, SLATE_ID, SLATE_STATE_KEY, type Slate, type SlateAction, type SlatePiece, type SlateProblem, type SlatePropValue } from "./types.js";

type Extra = Omit<SlateProblem, "code" | "name" | "message">;

const SOURCE_PATHS = new Map(Object.values(SLATE_SOURCES).map(s => [s.name, slateSourcePaths(s)]));

const shapeType = (shape: SlateShape): SlateType =>
  typeof shape === "string" ? (shape === "time" ? "any" : shape) : "enum" in shape ? "string" : "list" in shape ? "list" : "record";

/** Walks a declared shape by segments; answers the shape reached or the problem with the nearest declared path. */
function walkShape(head: string, root: SlateShape, segs: readonly (string | number)[], candidates: Iterable<string>, label = head): { shape: SlateShape } | { code: "X401"; message: string; fix?: string } {
  let shape = root;
  let at = label;
  for (const [k, seg] of segs.entries()) {
    if (typeof shape === "object" && "list" in shape) {
      if (typeof seg === "number") { shape = shape.list; at += `[${seg}]`; continue; }
      return seg === "length" || seg === "count" || seg === "size"
        ? { code: "X401", message: `${at} is a list; use len(${at})`, fix: `len(${at})` }
        : { code: "X401", message: `${at} is a list of ${slateShapeText(shape.list)}; read a row as ${at}[0].${seg} or bind it to a table's items` };
    }
    if (typeof shape === "object" && "fields" in shape && typeof seg === "string" && Object.prototype.hasOwnProperty.call(shape.fields, seg)) {
      shape = shape.fields[seg]!;
      at += `.${seg}`;
      continue;
    }
    const full = `${at}${typeof seg === "number" ? `[${seg}]` : `.${seg}`}`;
    const whole = segs.slice(k).reduce<string>((p, s) => `${p}${typeof s === "number" ? `[${s}]` : `.${s}`}`, at);
    const depth = (p: string): number => p.split(".").length;
    const fix = nearest(whole, [...candidates].filter(c => !c.includes("[]") && depth(c) === depth(whole)), 3) ?? nearest(full, [...candidates].filter(c => !c.includes("[]")), 2);
    if (typeof shape === "object" && "fields" in shape) {
      return { code: "X401", message: `${whole} is not a path${fix !== undefined ? `. Did you mean ${fix}?` : `; ${at} has ${Object.keys(shape.fields).join(", ")}`}`, ...(fix !== undefined ? { fix } : {}) };
    }
    return { code: "X401", message: `${at} is a ${slateShapeText(shape)}; it has no ${typeof seg === "number" ? `[${seg}]` : seg}` };
  }
  return { shape };
}

function sourcePath(head: string, segs: readonly (string | number)[]): { type: SlateType } | { code: "X401"; message: string; fix?: string } {
  const source = SLATE_SOURCES[head];
  if (source === undefined) {
    if (head === "feed" || head === "pipe") return { code: "X401", message: `${head}s are not in this build; bind a source or state` };
    const fix = nearest(head, [...Object.keys(SLATE_SOURCES), "state"]);
    return { code: "X401", message: `${head} is not a source; the sources are ${orList([...Object.keys(SLATE_SOURCES), "state"])}`, ...(fix !== undefined ? { fix: [fix, ...segs].join(".") } : {}) };
  }
  if (segs.length === 0) return { type: "record" };
  const walked = walkShape(head, source.shape, segs, SOURCE_PATHS.get(head)!.keys());
  return "shape" in walked ? { type: shapeType(walked.shape) } : walked;
}

/** The shape of a row when items binds a bare declared list path, else undefined. */
function rowShape(items: SlatePropValue | undefined): { shape: SlateShape; label: string } | undefined {
  if (!isSlateBinding(items)) return undefined;
  const m = /^([a-z]+)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/.exec(items.bind.trim());
  if (m === null) return undefined;
  const source = SLATE_SOURCES[m[1]!];
  if (source === undefined) return undefined;
  const walked = walkShape(m[1]!, source.shape, m[2]!.slice(1).split("."), []);
  return "shape" in walked && typeof walked.shape === "object" && "list" in walked.shape ? { shape: walked.shape.list, label: `a ${items.bind.trim()} row` } : undefined;
}

interface Ctx {
  doc: Slate;
  errors: SlateProblem[];
  warnings: SlateProblem[];
  stateKeys: Set<string>;
}

function add(ctx: Ctx, code: SlateCode, message: string, extra: Extra = {}): void {
  (SLATE_WARNINGS.has(code) ? ctx.warnings : ctx.errors).push(slateProblem(code, message, extra));
}

function scopeFor(ctx: Ctx, row?: { shape?: SlateShape; label?: string }): SlateCheckScope {
  return {
    path: (head, segs) => {
      if (head === "state") {
        const key = segs[0];
        if (typeof key !== "string") return { code: "X401", message: "a state path starts with a key: state.<key>" };
        if (!ctx.stateKeys.has(key)) {
          const fix = nearest(key, ctx.stateKeys);
          return { code: "X411", message: `state.${key} is not declared; add a state line or an action that writes it${fix !== undefined ? `, or did you mean state.${fix}?` : ""}`, ...(fix !== undefined ? { fix: `state.${fix}` } : {}) };
        }
        return { type: "any" };
      }
      return sourcePath(head, segs);
    },
    ...(row !== undefined ? {
      row: {
        item: row.shape !== undefined ? shapeType(row.shape) : "any",
        ...(row.shape !== undefined ? {
          field: (segs: readonly (string | number)[]) => {
            const walked = walkShape("item", row.shape!, segs, [], "item");
            return "shape" in walked ? { type: shapeType(walked.shape) } : { ...walked, message: walked.message.replace(/^item(\S*) is not a path/, `item$1 is not a field of ${row.label}`) };
          },
        } : {}),
      },
    } : {}),
  };
}

/** Checks one expression and files its problems on the piece and prop, with the type it yields. */
function expr(ctx: Ctx, src: string, extra: Extra, row?: { shape?: SlateShape; label?: string }): SlateType {
  const { type, problems } = checkSlateExpression(src, scopeFor(ctx, row));
  for (const p of problems) add(ctx, p.code as SlateCode, p.message, { ...extra, ...(p.at !== undefined ? { at: p.at } : {}), ...(p.fix !== undefined ? { fix: p.fix } : {}) });
  return type;
}

function format(ctx: Ctx, src: string, extra: Extra, row?: { shape?: SlateShape; label?: string }): void {
  const { parts, errors } = parseSlateFormat(src);
  for (const e of errors) add(ctx, e.code as SlateCode, e.message, { ...extra, ...(e.at !== undefined ? { at: e.at } : {}) });
  for (const part of parts) if (typeof part !== "string") {
    const { problems } = checkSlateExpression(part.expr, scopeFor(ctx, row), part.at);
    for (const p of problems) add(ctx, p.code as SlateCode, p.message, { ...extra, ...(p.at !== undefined ? { at: p.at } : {}), ...(p.fix !== undefined ? { fix: p.fix } : {}) });
  }
}

const typeWord = (t: SlatePropSpec["type"]): string =>
  Array.isArray(t) ? `one of ${orList(t as readonly string[])}` : t === "text" ? "text or a number" : t === "integer" ? "a whole number" : t === "list" ? "a list" : t === "expr" ? "an expression in braces" : t === "any" ? "a value" : `a ${t as string}`;

const literalKind = (v: SlatePropValue): string =>
  v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "a record" : typeof v === "string" ? `"${v.length > 40 ? `${v.slice(0, 39)}…` : v}" is text` : `${String(v)} is a ${typeof v}`;

/** A literal against its spec. */
function literal(ctx: Ctx, name: string, spec: SlatePropSpec, v: SlatePropValue, extra: Extra): void {
  const t = spec.type;
  const wrong = (fix?: string): void => add(ctx, "T303", `${name} takes ${typeWord(t)}; ${literalKind(v)}${fix !== undefined ? `. To bind it, write ${fix}.` : ""}`, { ...extra, ...(fix !== undefined ? { fix } : {}) });
  if (typeof v === "string") {
    if (v.length > SLATE_LIMITS.literalChars) add(ctx, "T310", `${name} is ${v.length} characters; the most is ${SLATE_LIMITS.literalChars}`, extra);
    if (v.includes("\u2014")) add(ctx, "W004", `${name} has an em dash; the app's copy uses none`, extra);
    if (v.includes("${")) add(ctx, "W001", `${name} is a literal containing \${...}. For a format string use backticks.`, extra);
  }
  if (t === "any") return;
  if (Array.isArray(t)) {
    if (typeof v !== "string" || !(t as readonly string[]).includes(v)) {
      const fix = typeof v === "string" ? nearest(v, t as readonly string[]) : undefined;
      add(ctx, "T306", `${name} is ${orList(t as readonly string[])}${typeof v === "string" ? `, not ${v}` : ""}`, { ...extra, ...(fix !== undefined ? { fix: `${name}=${fix}` } : {}) });
    }
    return;
  }
  const pathish = typeof v === "string" && /^[a-z]+(\.[A-Za-z_][A-Za-z0-9_]*|\[-?\d+\])+$/.test(v);
  const asBinding = (): string | undefined => {
    if (!pathish) return undefined;
    const [head, ...rest] = (v as string).split(".");
    const known = head === "state" ? undefined : sourcePath(head!, rest);
    const path = known !== undefined && "code" in known && known.fix !== undefined ? known.fix : (v as string);
    return `${name}={${path}}`;
  };
  switch (t) {
    case "string": if (typeof v !== "string") wrong(); else if (pathish && SOURCE_PATHS.get(v.split(".")[0]!)?.has(v)) add(ctx, "W001", `${name} is the text "${v}"; did you mean {${v}}?`, { ...extra, fix: `${name}={${v}}` }); return;
    case "number": if (typeof v !== "number") wrong(asBinding()); return;
    case "integer":
      if (typeof v !== "number" || !Number.isInteger(v)) wrong(asBinding());
      else if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) add(ctx, "T303", `${name} is ${spec.min} to ${spec.max}, not ${v}`, extra);
      return;
    case "boolean": if (typeof v !== "boolean") wrong(); return;
    case "text": if (typeof v !== "string" && typeof v !== "number") wrong(); return;
    case "list":
      if (!Array.isArray(v)) wrong(asBinding());
      else if ((spec.min !== undefined && v.length < spec.min) || (spec.max !== undefined && v.length > spec.max)) add(ctx, "T303", `${name} holds ${spec.min} to ${spec.max}, not ${v.length}`, extra);
      return;
    case "expr": wrong(typeof v === "string" ? `${name}={${v}}` : undefined); return;
    case "id": if (typeof v !== "string" || !SLATE_ID.test(v)) wrong(); return;
  }
}

/** One prop value against its spec: a binding, a format string or a literal. */
function prop(ctx: Ctx, name: string, spec: SlatePropSpec, v: SlatePropValue, extra: Extra, row?: { shape?: SlateShape; label?: string }): void {
  if (isSlateBinding(v) || isSlateFormat(v)) {
    if (spec.binds === "no") { add(ctx, "T305", `${name} cannot be bound; write a literal`, extra); return; }
    if (spec.binds === "state") {
      const bare = isSlateBinding(v) ? v.bind.trim() : undefined;
      if (bare === undefined || parseSlateStatePath(bare) === undefined) { add(ctx, "X410", `${name} must be a bare state path, like ${name}={state.note}`, { ...extra, fix: `${name}={state.${name}}` }); return; }
    }
    const scope = spec.binds === "item" ? row ?? {} : undefined;
    if (isSlateFormat(v)) { format(ctx, v.format, extra, scope); return; }
    const got = expr(ctx, v.bind, extra, scope);
    if ((spec.type === "number" || spec.type === "integer") && (got === "string" || got === "boolean" || got === "list" || got === "record")) {
      add(ctx, "X408", `${name} wants a number; this gives ${got === "string" ? "text" : `a ${got}`}`, extra);
    } else if (spec.type === "boolean" && (got === "list" || got === "record")) add(ctx, "X408", `${name} wants true or false; this gives a ${got}`, extra);
    return;
  }
  if (spec.binds === "state") { add(ctx, "X410", `${name} must be a bare state path, like ${name}={state.note}; declare the starting value with a state line`, { ...extra, fix: `${name}={state.${name}}` }); return; }
  if (spec.binds === "item" && spec.type === "expr") { literal(ctx, name, spec, v, extra); return; }
  literal(ctx, name, spec, v, extra);
}

function actions(ctx: Ctx, list: SlateAction | SlateAction[], event: string, extra: Extra, row?: { shape?: SlateShape; label?: string }): void {
  const all = Array.isArray(list) ? list : [list];
  if (all.length > SLATE_LIMITS.actionsPerEvent) add(ctx, "A606", `${all.length} actions on ${event}; the most is ${SLATE_LIMITS.actionsPerEvent}`, extra);
  all.forEach((action, i) => {
    const where = { ...extra, prop: `${extra.prop !== undefined ? `${extra.prop}.` : ""}on.${event}[${i}]` };
    const a = action as unknown as Record<string, SlatePropValue>;
    if (typeof a !== "object" || a === null || Array.isArray(a) || typeof a.do !== "string") { add(ctx, "A601", "an action is { do: <kind>, ... }", where); return; }
    const kind = a.do;
    const module = SLATE_ACTIONS[kind];
    if (module === undefined) {
      const later = (SLATE_LATER_ACTIONS as readonly string[]).includes(kind);
      const fix = nearest(kind, Object.keys(SLATE_ACTIONS));
      add(ctx, "A600", later ? `${kind} is not in this build; the actions are ${orList(Object.keys(SLATE_ACTIONS))}` : `"${kind}" is not an action${fix !== undefined ? `; did you mean ${fix}?` : `; the actions are ${orList(Object.keys(SLATE_ACTIONS))}`}`, { ...where, ...(fix !== undefined ? { fix } : {}) });
      return;
    }
    for (const [name, spec] of Object.entries(module.args)) if (spec.required === true && a[name] === undefined) add(ctx, "A601", `${kind} needs ${name}`, { ...where, prop: `${where.prop}.${name}` });
    for (const [name, v] of Object.entries(a)) {
      if (name === "do") continue;
      const spec = module.args[name];
      const at = { ...where, prop: `${where.prop}.${name}` };
      if (spec === undefined) {
        const fix = nearest(name, Object.keys(module.args));
        add(ctx, "A601", `${kind} takes ${orList(Object.keys(module.args))}, not ${name}`, { ...at, ...(fix !== undefined ? { fix } : {}) });
        continue;
      }
      if (name === "text") {
        if (typeof v !== "string") add(ctx, isSlateBinding(v) || isSlateFormat(v) ? "A603" : "A601", isSlateBinding(v) || isSlateFormat(v) ? "text must be plain; put the changing parts in with=" : "text is a sentence in quotes", at);
        else literal(ctx, name, spec, v, at);
        continue;
      }
      if (spec.path === "state") {
        if (typeof v !== "string" || parseSlateStatePath(v) === undefined) add(ctx, "A601", `${module.refusal}`, { ...at, fix: "path=state.<key>" });
        continue;
      }
      if (spec.path === "any") {
        if (!Array.isArray(v) || v.some(p => typeof p !== "string")) { add(ctx, "A601", "with is a list of paths, like with=[state.note, item.name]", at); continue; }
        for (const p of v as string[]) expr(ctx, p, at, row);
        continue;
      }
      prop(ctx, name, spec, v, at, row ? row : undefined);
    }
  });
}

/** Every state key the slate declares or writes: its state lines, set and toggle paths, two-way props. */
function writtenKeys(doc: Slate): Set<string> {
  const keys = new Set(Object.keys(doc.state ?? {}));
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (typeof v !== "object" || v === null) return;
    const rec = v as Record<string, unknown>;
    if ((rec.do === "set" || rec.do === "toggle") && typeof rec.path === "string") {
      const key = parseSlateStatePath(rec.path)?.[0];
      if (typeof key === "string") keys.add(key);
    }
    for (const x of Object.values(rec)) visit(x);
  };
  for (const piece of Object.values(doc.pieces)) {
    visit(piece.on);
    visit(piece.props);
    const module = SLATE_PIECES[piece.type];
    for (const [name, spec] of Object.entries(module?.props ?? {})) {
      const v = piece.props?.[name];
      if (isSlateBinding(v) && (spec.binds === "state" || name === "open")) {
        const key = parseSlateStatePath(v.bind.trim())?.[0];
        if (typeof key === "string" && spec.binds === "state") keys.add(key);
      }
    }
  }
  return keys;
}

const FRAME = new Set(["schema", "kit", "root", "title", "state", "feeds", "pipes", "pieces"]);
const PIECE_FIELDS = new Set(["type", "props", "children", "when", "on", "fallback", "announce"]);

/** The document checked whole. document is set only when there are no errors. */
export function validateSlate(input: unknown, opts: { stateKeys?: Iterable<string> } = {}): { document?: Slate; errors: SlateProblem[]; warnings: SlateProblem[] } {
  const ctx: Ctx = { doc: input as Slate, errors: [], warnings: [], stateKeys: new Set() };
  const done = (): { document?: Slate; errors: SlateProblem[]; warnings: SlateProblem[] } => {
    const errors = ctx.errors.length <= SLATE_LIMITS.errorsPerPass ? ctx.errors
      : [...ctx.errors.slice(0, SLATE_LIMITS.errorsPerPass), slateProblem(ctx.errors[SLATE_LIMITS.errorsPerPass]!.code as SlateCode, `and ${ctx.errors.length - SLATE_LIMITS.errorsPerPass} more`)];
    return { ...(ctx.errors.length === 0 ? { document: input as Slate } : {}), errors, warnings: ctx.warnings };
  };
  if (typeof input !== "object" || input === null || Array.isArray(input)) { add(ctx, "D203", "a slate is an object with schema, root and pieces"); return done(); }
  const doc = input as Slate & Record<string, unknown>;
  for (const key of Object.keys(doc)) if (!FRAME.has(key)) add(ctx, "T302", `a slate has no field ${key}; it has ${orList([...FRAME])}`, { ...(nearest(key, FRAME) !== undefined ? { fix: nearest(key, FRAME)! } : {}) });
  if (doc.schema !== 1) add(ctx, "D200", typeof doc.schema === "number" && doc.schema > 1 ? `schema ${doc.schema} is newer than this wsp (schema 1)` : "schema is 1", { fix: "slate 1" });
  if (doc.kit !== undefined && doc.kit !== "wsp/1") add(ctx, "D201", `kit ${String(doc.kit)} is not registered here; this wsp has wsp/1`, { fix: "wsp/1" });
  if (doc.title !== undefined && (typeof doc.title !== "string" || doc.title.length > SLATE_LIMITS.titleChars)) add(ctx, "T303", `title is text of at most ${SLATE_LIMITS.titleChars} characters`, { prop: "title" });
  if (typeof doc.pieces !== "object" || doc.pieces === null || Array.isArray(doc.pieces)) { add(ctx, "D203", "pieces is an object of pieces by id"); return done(); }
  if (typeof doc.root !== "string") { add(ctx, "D203", "root names the piece drawn first"); return done(); }
  const size = JSON.stringify(doc).length;
  if (size > SLATE_LIMITS.documentBytes) add(ctx, "D208", `the slate is ${Math.round(size / 1024)} KB; the most is 64 KB`);
  if (doc.feeds !== undefined && Object.keys(doc.feeds).length > 0) add(ctx, "P999", "feeds are not in this build; bind a source or state instead", { piece: Object.keys(doc.feeds)[0]! });
  if (doc.pipes !== undefined && Object.keys(doc.pipes).length > 0) add(ctx, "P999", "pipes are not in this build; compute with an expression instead, like len(pr.checks)", { piece: Object.keys(doc.pipes)[0]! });

  if (doc.state !== undefined) {
    if (typeof doc.state !== "object" || doc.state === null || Array.isArray(doc.state)) add(ctx, "S501", "state is an object of starting values by key");
    else {
      for (const key of Object.keys(doc.state)) if (!SLATE_STATE_KEY.test(key)) add(ctx, "S501", `state key "${key}" is not a name: letters, digits and _`, { prop: `state.${key}` });
      if (JSON.stringify(doc.state).length > SLATE_LIMITS.stateBytes) add(ctx, "S500", "state is over 256 KB");
    }
  }

  const ids = Object.keys(doc.pieces);
  if (ids.length > SLATE_LIMITS.pieces) add(ctx, "D207", `${ids.length} pieces; the most is ${SLATE_LIMITS.pieces}. Bind a list instead.`);
  for (const id of ids) {
    if (!SLATE_ID.test(id)) add(ctx, "P103", `"${id}" is not a piece id: lowercase letters, digits and dashes, starting with a letter`, { piece: id, fix: id.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "piece" });
    else if (SLATE_RESERVED_WORDS.has(id)) add(ctx, "P103", `${id} is a reserved word; item, index, state, feed, pipe, drop and the source names are not ids`, { piece: id, fix: `${id}-piece` });
  }
  if (doc.pieces[doc.root] === undefined) add(ctx, "D203", `root is "${doc.root}" but no piece has that id`, { ...(nearest(doc.root, ids) !== undefined ? { fix: nearest(doc.root, ids)! } : {}) });

  // The tree: parents, cycles, depth.
  const parent = new Map<string, string>();
  for (const [id, piece] of Object.entries(doc.pieces)) {
    if (typeof piece !== "object" || piece === null) continue;
    for (const child of Array.isArray(piece.children) ? piece.children : []) {
      if (doc.pieces[child] === undefined) add(ctx, "D203", `${id} lists "${child}" but no piece has that id`, { piece: id, prop: "children", ...(nearest(child, ids) !== undefined ? { fix: nearest(child, ids)! } : {}) });
      else if (parent.has(child)) add(ctx, "D205", `${child} is under both ${parent.get(child)} and ${id}; a piece has one parent`, { piece: child });
      else if (child === doc.root) add(ctx, "D205", `${id} lists the root ${child} as its child`, { piece: id, prop: "children" });
      else parent.set(child, id);
    }
  }
  const depthOf = (id: string): number => {
    let d = 1;
    const seen = new Set([id]);
    for (let at = parent.get(id); at !== undefined; at = parent.get(at)) {
      if (seen.has(at)) return -1;
      seen.add(at);
      d++;
    }
    return d;
  };
  for (const id of ids) {
    const d = depthOf(id);
    if (d === -1) { add(ctx, "D205", `${id} is under itself`, { piece: id }); continue; }
    if (d > SLATE_LIMITS.depth) add(ctx, "D206", `${id} is ${d} deep; the most is ${SLATE_LIMITS.depth}`, { piece: id });
    let top = id;
    for (let at = parent.get(id); at !== undefined; at = parent.get(at)) top = at;
    if (top !== doc.root && doc.pieces[doc.root] !== undefined) add(ctx, "D204", `"${id}" is under no piece; it will not draw`, { piece: id, fix: `put it under ${doc.root}` });
  }

  ctx.stateKeys = writtenKeys(doc);
  for (const key of opts.stateKeys ?? []) ctx.stateKeys.add(key);
  let announced = 0;
  const loud = { accent: [] as string[], large: [] as string[], primary: [] as string[] };

  for (const [id, piece] of Object.entries(doc.pieces) as [string, SlatePiece & Record<string, unknown>][]) {
    if (typeof piece !== "object" || piece === null || Array.isArray(piece)) { add(ctx, "D203", `${id} is not a piece`, { piece: id }); continue; }
    for (const key of Object.keys(piece)) if (!PIECE_FIELDS.has(key)) {
      const isStyle = SLATE_RESERVED_PROPS[key] !== undefined;
      add(ctx, isStyle ? "T312" : "T302", isStyle ? `${key} is not something a slate can set; wsp draws the style` : `a piece has no field ${key}; props go under props`, { piece: id, prop: key });
    }
    const module = SLATE_PIECES[piece.type];
    if (module === undefined) {
      const later = (SLATE_LATER_PIECES as readonly string[]).includes(piece.type);
      const fix = nearest(String(piece.type), Object.keys(SLATE_PIECES));
      add(ctx, "T300", later ? `${piece.type} is not in this build; the pieces are ${orList(Object.keys(SLATE_PIECES))}` : `"${piece.type}" is not a piece${fix !== undefined ? `; did you mean ${fix}?` : ""}`, { piece: id, ...(fix !== undefined ? { fix } : {}) });
      continue;
    }
    if (piece.fallback !== undefined) {
      add(ctx, "T301", `${id} has a fallback, which never draws here since this wsp knows ${piece.type}`, { piece: id, prop: "fallback" });
      if (typeof piece.fallback === "string" && piece.fallback !== "drop" && doc.pieces[piece.fallback] === undefined) add(ctx, "D203", `fallback names "${piece.fallback}" but no piece has that id`, { piece: id, prop: "fallback" });
    }
    const children = Array.isArray(piece.children) ? piece.children : [];
    if (children.length > 0 && !module.holdsChildren) add(ctx, "T308", `${piece.type} holds no children; put them in a column or a row`, { piece: id, prop: "children" });
    if (children.length > SLATE_LIMITS.children) add(ctx, "D207", `${id} has ${children.length} children; the most is ${SLATE_LIMITS.children}. Bind a list instead.`, { piece: id });
    if (module.childLimit !== undefined && (children.length > module.childLimit.max || children.some(c => doc.pieces[c] !== undefined && !module.childLimit!.types.includes(doc.pieces[c]!.type)))) {
      add(ctx, "T309", `${piece.type} holds at most ${module.childLimit.max} ${orList(module.childLimit.types)}`, { piece: id, prop: "children" });
    }

    const props = (piece.props ?? {}) as Record<string, SlatePropValue>;
    if (typeof props !== "object" || props === null || Array.isArray(props)) { add(ctx, "T303", "props is an object of values by name", { piece: id }); continue; }
    const row = rowShape(props.items);
    for (const [name, v] of Object.entries(props)) {
      const extra = { piece: id, prop: name };
      const style = SLATE_RESERVED_PROPS[name];
      if (style !== undefined) {
        const use = name === "color" || name === "colour" || name === "background" || name === "fill" || name === "ink" ? "tone=bad" : style;
        add(ctx, "T312", `${name} is not a prop a slate can set; wsp draws the style. Slate takes meaning, not style: use ${use}`, { ...extra, fix: use });
        continue;
      }
      const spec = module.props[name];
      if (spec === undefined) {
        const fix = nearest(name, Object.keys(module.props));
        add(ctx, "T302", `${piece.type} has no "${name}"${fix !== undefined ? `; did you mean ${fix}?` : `; it has ${orList(Object.keys(module.props))}`}`, { ...extra, ...(fix !== undefined ? { fix } : {}) });
        continue;
      }
      if (typeof v === "object" && v !== null && !Array.isArray(v) && ("bind" in v || "format" in v) && Object.keys(v).length > 1) {
        add(ctx, "T303", `${name} holds a binding beside other keys; a binding is { bind } alone`, extra);
        continue;
      }
      const itemKind = Object.entries(module.items).find(([, s]) => s.prop === name);
      if (itemKind !== undefined && Array.isArray(v)) {
        literal(ctx, name, spec, v, extra);
        const [kind, ispec] = itemKind;
        v.forEach((item, i) => {
          const at = { piece: id, prop: `${name}[${i}]` };
          if (typeof item !== "object" || item === null || Array.isArray(item) || isSlateBinding(item) || isSlateFormat(item)) { add(ctx, "T303", `each of ${name} is a record, as a - ${kind} line writes`, at); return; }
          const rec = item as Record<string, SlatePropValue>;
          for (const [f, fs] of Object.entries(ispec.fields)) if (fs.required === true && rec[f] === undefined) add(ctx, "T304", `- ${kind} needs ${f}`, { ...at, prop: `${at.prop}.${f}` });
          for (const [f, fv] of Object.entries(rec)) {
            const fat = { piece: id, prop: `${at.prop}.${f}` };
            if (f === "on" && ispec.events !== undefined) {
              for (const [event, list] of Object.entries(fv as Record<string, SlateAction | SlateAction[]>)) {
                if (!(ispec.events as readonly string[]).includes(event)) add(ctx, "A602", `a - ${kind} has no ${event} event; it has ${orList(ispec.events)}`, fat);
                else actions(ctx, list, event, { piece: id, prop: at.prop }, row ?? {});
              }
              continue;
            }
            if (f === "when" && ispec.when === true) {
              if (typeof fv !== "string") add(ctx, "T303", "when takes an expression in braces", fat);
              else expr(ctx, fv, fat, row ?? {});
              continue;
            }
            const fspec = ispec.fields[f];
            if (fspec === undefined) {
              const fix = nearest(f, Object.keys(ispec.fields));
              add(ctx, SLATE_RESERVED_PROPS[f] !== undefined ? "T312" : "T302", `- ${kind} has no "${f}"; it has ${orList(Object.keys(ispec.fields))}`, { ...fat, ...(fix !== undefined ? { fix } : {}) });
              continue;
            }
            prop(ctx, f, fspec, fv, fat, row ?? {});
          }
          if (ispec.events !== undefined && rec.on === undefined) add(ctx, "A602", `a - ${kind} needs an @press line under it`, at);
        });
        continue;
      }
      prop(ctx, name, spec, v, extra, row ?? {});
    }
    for (const [name, spec] of Object.entries(module.props)) {
      if (spec.required !== true || props[name] !== undefined) continue;
      if (module.blockProp === name) { add(ctx, "T304", `${piece.type} needs ${name}: write | lines under it`, { piece: id, prop: name }); continue; }
      if (name === "label" && module.interactive === true) add(ctx, "T307", `a ${piece.type} needs a label for people using a screen reader`, { piece: id, prop: name, fix: `label="..."` });
      else add(ctx, "T304", `${piece.type} needs ${name}: ${module.example.split("\n")[0]}`, { piece: id, prop: name, fix: module.example.split("\n")[0]! });
    }

    if (piece.when !== undefined) {
      if (typeof piece.when !== "string") add(ctx, "T303", "when takes an expression in braces", { piece: id, prop: "when" });
      else expr(ctx, piece.when, { piece: id, prop: "when" });
    }
    const on = piece.on as Record<string, SlateAction | SlateAction[]> | undefined;
    for (const [event, list] of Object.entries(on ?? {})) {
      if (!(SLATE_EVENTS as readonly string[]).includes(event)) { add(ctx, "A602", `${event} is not an event; events are press, submit and change`, { piece: id, prop: `on.${event}` }); continue; }
      if (!(module.events as readonly string[]).includes(event)) { add(ctx, "A602", `${piece.type} has no ${event} event${module.events.length > 0 ? `; it has ${orList(module.events)}` : ""}`, { piece: id, prop: `on.${event}` }); continue; }
      actions(ctx, list, event, { piece: id });
    }
    if (piece.type === "button" && on?.press === undefined) add(ctx, "A602", "a button needs an @press line under it", { piece: id, prop: "on.press", fix: "@press send text=\"...\"" });
    if (piece.announce === true) {
      if (!["text", "number", "meter"].includes(piece.type)) add(ctx, "T303", `announce is for text, number and meter, not ${piece.type}`, { piece: id, prop: "announce" });
      else if (++announced > SLATE_LIMITS.announce) add(ctx, "T313", `more than ${SLATE_LIMITS.announce} pieces announce; the first ${SLATE_LIMITS.announce} win`, { piece: id, prop: "announce" });
    }
    if (props.tone === "accent") loud.accent.push(id);
    if (props.size === "large") loud.large.push(id);
    if (props.variant === "primary") loud.primary.push(id);
  }
  for (const [word, list] of Object.entries(loud)) {
    if (list.length > 1) add(ctx, "T311", `"${list[0]}" and "${list[1]}" are both ${word}; the first keeps it`, { piece: list[1]! });
  }
  return done();
}
