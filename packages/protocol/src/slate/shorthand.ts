// SPDX-License-Identifier: AGPL-3.0-only
// The line format agents write, compiled to the stored document and printed back from it. One piece per line,
// children two spaces in, bare words resolved against the piece type's own flags, items and actions on the lines
// under their owner. Patches are the same lines behind an op mark.
import { slateFlags, SLATE_PIECES, SLATE_RESERVED_PROPS, SLATE_ACTIONS, type SlateItemSpec, type SlatePieceModule } from "./kit.js";
import { nearest, orList, slateProblem, type SlateCode } from "./problems.js";
import { parseSlateStatePath, setSlateState } from "./state.js";
import { isSlateBinding, isSlateFormat, SLATE_EVENTS, SLATE_ID, type Slate, type SlateAction, type SlateEventName, type SlateFeed, type SlateJson, type SlatePatchOp, type SlatePiece, type SlateProblem, type SlatePropValue } from "./types.js";
import { validateSlate } from "./validate.js";
import { SLATE_LIMITS } from "./limits.js";

const WORD = /^[A-Za-z][A-Za-z0-9\-_./:]*(?:\[-?\d+\][A-Za-z0-9\-_./:]*)*/;
const NUMBER = /^-?\d+(?:\.\d+)?(?=$|[\s,\]])/;

class LineFault extends Error {
  constructor(readonly code: SlateCode, message: string, readonly column?: number, readonly fix?: string) { super(message); }
}

// ---- values ----

interface Attr { name?: string; value?: SlatePropValue; word?: string; column: number; quoted?: true }

/** Reads one value at text[i]; answers the value and where it ended. */
function readValue(text: string, i: number): { value: SlatePropValue; end: number } {
  const c = text[i];
  if (c === '"') {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    if (j >= text.length) throw new LineFault("P100", `a string opened at column ${i + 1} never closes`, i + 1);
    try {
      return { value: JSON.parse(text.slice(i, j + 1)) as string, end: j + 1 };
    } catch {
      throw new LineFault("P106", `the string at column ${i + 1} is not valid: escapes are JSON's`, i + 1);
    }
  }
  if (c === "`") {
    let j = i + 1;
    let hole = 0;
    let quote: string | undefined;
    while (j < text.length) {
      const ch = text[j]!;
      if (hole > 0) {
        if (quote !== undefined) { if (ch === "\\") j++; else if (ch === quote) quote = undefined; }
        else if (ch === "'" || ch === '"') quote = ch;
        else if (ch === "{") hole++;
        else if (ch === "}") hole--;
      } else if (ch === "`") break;
      else if (text.startsWith("${", j) && !text.startsWith("$${", j - 1)) { hole = 1; j += 2; continue; }
      j++;
    }
    if (j >= text.length) throw new LineFault("P100", `a format string opened at column ${i + 1} never closes`, i + 1);
    return { value: { format: text.slice(i + 1, j) }, end: j + 1 };
  }
  if (c === "{") {
    let j = i + 1;
    let depth = 1;
    let quote: string | undefined;
    while (j < text.length) {
      const ch = text[j]!;
      if (quote !== undefined) { if (ch === "\\") j++; else if (ch === quote) quote = undefined; }
      else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) break;
      j++;
    }
    if (j >= text.length) throw new LineFault("P100", `a binding opened at column ${i + 1} never closes`, i + 1);
    const expr = text.slice(i + 1, j).trim();
    if (expr === "") throw new LineFault("P100", `the binding at column ${i + 1} is empty`, i + 1);
    return { value: { bind: expr }, end: j + 1 };
  }
  if (c === "[") {
    const out: SlatePropValue[] = [];
    let j = i + 1;
    while (text[j] === " ") j++;
    if (text[j] === "]") return { value: out, end: j + 1 };
    for (;;) {
      const v = readValue(text, j);
      out.push(v.value);
      j = v.end;
      while (text[j] === " ") j++;
      if (text[j] === ",") { j++; while (text[j] === " ") j++; continue; }
      if (text[j] === "]") return { value: out, end: j + 1 };
      throw new LineFault("P100", `expected , or ] at column ${j + 1}`, j + 1);
    }
  }
  const rest = text.slice(i);
  const num = NUMBER.exec(rest);
  if (num !== null) return { value: Number(num[0]), end: i + num[0].length };
  const word = WORD.exec(rest);
  if (word !== null) {
    const w = word[0];
    return { value: w === "true" ? true : w === "false" ? false : w === "null" ? null : w, end: i + w.length };
  }
  throw new LineFault("P100", `cannot read a value at column ${i + 1}`, i + 1);
}

/** The attrs of a line from column start: name=value pairs and bare words. */
function readAttrs(text: string, start: number): Attr[] {
  const out: Attr[] = [];
  let i = start;
  for (;;) {
    while (text[i] === " ") i++;
    if (i >= text.length) return out;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(text.slice(i));
    if (m !== null) {
      const v = readValue(text, i + m[0].length);
      out.push({ name: m[1]!, value: v.value, column: i + 1, ...(text[i + m[0].length] === '"' ? { quoted: true as const } : {}) });
      i = v.end;
    } else {
      const w = /^[A-Za-z][A-Za-z0-9-]*/.exec(text.slice(i));
      if (w === null) throw new LineFault("P100", `cannot read this line at column ${i + 1}; a piece line is id: type prop=value flag`, i + 1);
      out.push({ word: w[0], column: i + 1 });
      i += w[0].length;
    }
    if (i < text.length && text[i] !== " ") throw new LineFault("P100", `expected a space at column ${i + 1}`, i + 1);
  }
}

// ---- the line machinery shared by documents and patches ----

type Owner =
  | { kind: "piece"; indent: number; id: string; piece: SlatePiece }
  | { kind: "item"; indent: number; record: Record<string, SlatePropValue>; spec: SlateItemSpec; pieceId: string }
  | { kind: "feed"; indent: number; feed: SlateFeed & { args?: Record<string, SlateJson> } }
  | { kind: "action"; indent: number; action: Record<string, SlatePropValue> };

interface Line { n: number; indent: number; text: string; body: string }

class Builder {
  readonly errors: SlateProblem[] = [];
  readonly pieceLine = new Map<string, number>();
  readonly explicit = new Set<string>();
  private minted = new Map<string, number>();
  pieces: Record<string, SlatePiece> = {};

  constructor(lines: string[], readonly lookup: (id: string) => SlatePiece | undefined = () => undefined) {
    for (const raw of lines) {
      const m = /^\s*(?:[+~]\s+)?([a-z][a-z0-9-]*):\s/.exec(raw);
      if (m !== null) this.explicit.add(m[1]!);
    }
  }

  fault(line: Line, e: unknown): void {
    if (!(e instanceof LineFault)) throw e;
    this.errors.push(slateProblem(e.code, e.message, { line: line.n, ...(e.column !== undefined ? { column: e.column } : {}), ...(e.fix !== undefined ? { fix: e.fix } : {}) }));
  }

  mint(type: string): string {
    let n = this.minted.get(type) ?? 0;
    let id: string;
    do id = `${type}-${++n}`; while (this.explicit.has(id) || this.pieces[id] !== undefined);
    this.minted.set(type, n);
    return id;
  }

  /** Parses "id: type attrs" or "type attrs" from column start; registers the piece. */
  pieceLine_(line: Line, start: number): { id: string; piece: SlatePiece } {
    const text = line.text;
    const m = /^([a-z][a-zA-Z0-9_-]*):(?=\s|$)/.exec(text.slice(start));
    let at = start;
    let id: string | undefined;
    if (m !== null) {
      id = m[1]!;
      if (!SLATE_ID.test(id)) throw new LineFault("P103", `"${id}" is not a piece id: lowercase letters, digits and dashes, starting with a letter`, start + 1, id.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
      at += m[0].length;
      while (text[at] === " ") at++;
    }
    const t = /^[a-z][a-z0-9-]*/.exec(text.slice(at));
    if (t === null) throw new LineFault("P100", `cannot read this line at column ${at + 1}; a piece line is id: type prop=value flag`, at + 1);
    const type = t[0];
    const module = SLATE_PIECES[type];
    if (module === undefined) {
      const flagOf = Object.values(SLATE_PIECES).map(p => slateFlags(p.props).get(type)).find(hit => hit !== undefined);
      if (flagOf !== undefined && m === null) {
        const like = `${flagOf === "ambiguous" ? "prop" : flagOf.prop}=${type}`;
        throw new LineFault("T300", `${type} is not a piece type; a line that only adds flags starts with a prop, like ${like}`, at + 1, like);
      }
    }
    if (id === undefined) id = this.mint(type);
    if (this.pieces[id] !== undefined) throw new LineFault("P104", `${id} is also on line ${this.pieceLine.get(id)}`, start + 1);
    const piece: SlatePiece = { type };
    this.pieces[id] = piece;
    this.pieceLine.set(id, line.n);
    this.applyAttrs(piece, module, readAttrs(text, at + type.length), id);
    return { id, piece };
  }

  /** Puts a line's attrs on a piece: the piece's own fields, its flags and its props. */
  applyAttrs(piece: SlatePiece, module: SlatePieceModule | undefined, attrs: Attr[], id: string, patch?: Record<string, unknown>): void {
    const flags = module === undefined ? undefined : slateFlags(module.props);
    const props: Record<string, SlatePropValue> = piece.props ?? {};
    for (const a of attrs) {
      if (a.word !== undefined) {
        if (a.word === "announce") { piece.announce = true; continue; }
        if (flags === undefined) continue;
        const [prop, value] = this.flag(flags, a, piece.type);
        props[prop] = value;
        continue;
      }
      const name = a.name!;
      const value = a.value!;
      if (name === "when") {
        if (value === null && patch !== undefined) { patch.when = null; continue; }
        if (!isSlateBinding(value)) {
          const text = typeof value === "string" ? value : "...";
          throw new LineFault("T303", `when takes an expression in braces: when={${text}}`, a.column, `when={${text}}`);
        }
        if (patch !== undefined) patch.when = value.bind;
        else piece.when = value.bind;
        continue;
      }
      if (name === "fallback") {
        const fb = typeof value !== "string" ? null : a.quoted === true ? { text: value } : value;
        if (fb === null && patch === undefined) throw new LineFault("T303", "fallback is drop, a piece id or a sentence in quotes", a.column);
        if (patch !== undefined) patch.fallback = fb;
        else piece.fallback = fb!;
        continue;
      }
      if (name === "announce" && typeof value === "boolean") { piece.announce = value; continue; }
      props[name] = value;
    }
    for (const [k, v] of Object.entries(props)) if (v === undefined) delete props[k];
    if (Object.keys(props).length > 0) piece.props = props;
    void id;
  }

  flag(flags: Map<string, { prop: string; value: SlateJson } | "ambiguous">, a: Attr, type: string): [string, SlatePropValue] {
    const word = a.word!;
    const hit = flags.get(word);
    if (hit !== undefined && hit !== "ambiguous") return [hit.prop, hit.value];
    if (word === "normal" || word === "default") throw new LineFault("P102", `${word} is the default; leave it out or write prop=${word}`, a.column);
    if (hit === "ambiguous") throw new LineFault("P102", `${word} is a value of more than one prop of ${type}; write it as prop=${word}`, a.column);
    const style = SLATE_RESERVED_PROPS[word];
    if (style !== undefined) {
      const use = word === "bold" ? "strong" : style;
      throw new LineFault("P102", `${word} is not a flag of ${type}. Slate takes meaning, not style: use ${use}.`, a.column, use);
    }
    const fix = nearest(word, [...flags.keys()].filter(w => flags.get(w) !== "ambiguous"));
    throw new LineFault("P102", `"${word}" is not a flag of ${type}${fix !== undefined ? `; did you mean ${fix}?` : ""}`, a.column, fix);
  }

  /** "- kind attrs" under a piece or an item: a record appended to the list prop the kind fills. */
  itemLine(line: Line, owner: Owner, current?: SlatePiece): Owner {
    const m = /^-\s+([a-z][a-z0-9-]*)/.exec(line.body);
    if (m === null) throw new LineFault("P100", "an item line is - kind prop=value", line.indent + 1);
    const kind = m[1]!;
    const attrs = readAttrs(line.text, line.indent + m[0].length);
    if (owner.kind === "feed" || owner.kind === "action" || (owner.kind === "item" && kind === "arg")) {
      if (kind !== "arg") throw new LineFault("T314", `only - arg items go here, not ${kind}`, line.indent + 3);
      const args: Record<string, SlatePropValue> = {};
      for (const a of attrs) if (a.name !== undefined) args[a.name] = a.value!;
      if (owner.kind === "feed") owner.feed.args = { ...owner.feed.args, ...(args as Record<string, SlateJson>) };
      else if (owner.kind === "action") owner.action.args = { ...((owner.action.args as Record<string, SlatePropValue>) ?? {}), ...args };
      else owner.record.args = { ...((owner.record.args as Record<string, SlatePropValue>) ?? {}), ...args };
      return owner;
    }
    if (owner.kind !== "piece") throw new LineFault("P100", "an item line goes under a piece", line.indent + 1);
    const module = SLATE_PIECES[owner.piece.type];
    const spec = module?.items[kind];
    if (spec === undefined) {
      const kinds = Object.keys(module?.items ?? {});
      throw new LineFault("T314", kinds.length === 0 ? `${owner.piece.type} takes no items` : `${owner.piece.type} takes ${orList(kinds.map(k => `- ${k}`))} items, not ${kind}`, line.indent + 3, nearest(kind, kinds));
    }
    const record: Record<string, SlatePropValue> = {};
    const flags = slateFlags(spec.fields);
    for (const a of attrs) {
      if (a.word !== undefined) { const [p, v] = this.flag(flags, a, `- ${kind}`); record[p] = v; continue; }
      if (a.name === "when" && spec.when === true) {
        if (!isSlateBinding(a.value)) throw new LineFault("T303", `when takes an expression in braces: when={${String(a.value)}}`, a.column);
        record.when = a.value.bind;
        continue;
      }
      record[a.name!] = a.value!;
    }
    const props = owner.piece.props ?? (owner.piece.props = {});
    const base = props[spec.prop] ?? (current?.props?.[spec.prop] as SlatePropValue | undefined);
    props[spec.prop] = [...(Array.isArray(base) ? base : []), record];
    return { kind: "item", indent: line.indent, record, spec, pieceId: owner.id };
  }

  /** "@event kind attrs": an action appended to the owner's on. */
  actionLine(line: Line, owner: Owner, on?: Record<string, SlateAction | SlateAction[]>): Owner {
    const m = /^@([a-zA-Z]+)\s+([a-z][a-z0-9-]*)/.exec(line.body);
    if (m === null) throw new LineFault("P100", "an action line is @event kind prop=value", line.indent + 1);
    const event = m[1]!;
    if (!(SLATE_EVENTS as readonly string[]).includes(event)) throw new LineFault("A602", `@${event} is not an event; events are press, submit and change`, line.indent + 1, nearest(event, SLATE_EVENTS));
    const action: Record<string, SlatePropValue> = { do: m[2]! };
    for (const a of readAttrs(line.text, line.indent + m[0].length)) {
      if (a.word !== undefined) throw new LineFault("P102", `"${a.word}" is not a flag of an action; actions take prop=value`, a.column);
      action[a.name!] = a.value!;
    }
    let target: Record<string, SlateAction | SlateAction[]>;
    if (on !== undefined) target = on;
    else if (owner.kind === "piece") target = (owner.piece.on ??= {}) as Record<string, SlateAction | SlateAction[]>;
    else if (owner.kind === "item" && owner.spec.events !== undefined) target = ((owner.record.on as unknown as Record<string, SlateAction | SlateAction[]>) ??= {} as never);
    else throw new LineFault("A602", "an action goes under a piece or a row action", line.indent + 1);
    if (owner.kind === "item" && owner.record.on === undefined) owner.record.on = target as unknown as SlatePropValue;
    const had = target[event];
    target[event] = had === undefined ? (action as unknown as SlateAction) : [...(Array.isArray(had) ? had : [had]), action as unknown as SlateAction];
    return { kind: "action", indent: line.indent, action };
  }

  blockLine(line: Line, owner: Owner): void {
    if (owner.kind !== "piece") throw new LineFault("P100", "a | line goes under a markdown piece", line.indent + 1);
    const prop = SLATE_PIECES[owner.piece.type]?.blockProp;
    if (prop === undefined) throw new LineFault("P100", `${owner.piece.type} takes no | lines; only a piece with a block of text does`, line.indent + 1);
    const text = line.body.startsWith("| ") ? line.body.slice(2) : line.body.slice(1);
    const props = owner.piece.props ?? (owner.piece.props = {});
    const had = props[prop];
    props[prop] = typeof had === "string" && this.blockOpen.has(owner.piece) ? `${had}\n${text}` : text;
    this.blockOpen.add(owner.piece);
  }
  private blockOpen = new WeakSet<SlatePiece>();

  contLine(line: Line, owner: Owner, patch?: Record<string, unknown>): void {
    const attrs = readAttrs(line.text, line.indent);
    if (owner.kind === "piece") this.applyAttrs(owner.piece, SLATE_PIECES[owner.piece.type], attrs, owner.id, patch);
    else if (owner.kind === "item") for (const a of attrs) { if (a.name !== undefined) owner.record[a.name] = a.name === "when" && isSlateBinding(a.value) ? a.value.bind : a.value!; }
    else if (owner.kind === "action") for (const a of attrs) { if (a.name !== undefined) owner.action[a.name] = a.value!; }
    else throw new LineFault("P100", "a continuation line goes under a piece or an item", line.indent + 1);
  }

  /** One body line under the owner stack: a child piece, an item, an action, a block line or a continuation. */
  body(line: Line, stack: Owner[], opts: { current?: SlatePiece; on?: Record<string, SlateAction | SlateAction[]>; patch?: Record<string, unknown> } = {}): void {
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= line.indent) stack.pop();
    const owner = stack[stack.length - 1];
    if (owner === undefined) throw new LineFault("P101", "this line is indented under nothing", 1);
    if (line.indent !== owner.indent + 2) throw new LineFault("P101", `indent is ${line.indent} spaces; children are two spaces in from their parent`, 1);
    const first = line.body[0];
    if (line.body.startsWith("- ")) { stack.push(this.itemLine(line, owner, opts.current)); return; }
    if (first === "@") { stack.push(this.actionLine(line, owner, owner === stack[0] ? opts.on : undefined)); return; }
    if (first === "|") { this.blockLine(line, owner); return; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line.body)) { this.contLine(line, owner, owner === stack[0] ? opts.patch : undefined); return; }
    if (owner.kind !== "piece") throw new LineFault("P100", "a piece line goes under a piece, not under an item or an action", line.indent + 1);
    const { id, piece } = this.pieceLine_(line, line.indent);
    (owner.piece.children ??= []).push(id);
    stack.push({ kind: "piece", indent: line.indent, id, piece });
  }

  stateLine(line: Line, state: Record<string, SlateJson>): Record<string, SlateJson> {
    const m = /^(state(?:\.[A-Za-z_][A-Za-z0-9_]*|\[-?\d+\])+)\s*=\s*(.*)$/.exec(line.body);
    if (m === null || parseSlateStatePath(m[1]!) === undefined) throw new LineFault("P100", "a state line is state.<key> = <json>", 1);
    let value: SlateJson;
    try {
      value = JSON.parse(m[2]!) as SlateJson;
    } catch (e) {
      throw new LineFault("P106", `the value is not one JSON value on one line: ${(e as Error).message}`, line.body.indexOf("=") + 2);
    }
    return setSlateState(state, m[1]!, value);
  }

  feedLine(line: Line): { name: string; feed: SlateFeed } {
    const m = /^feed\s+([a-z][a-z0-9_]*):\s+(mcp|file|dir)\b/.exec(line.body);
    if (m === null) throw new LineFault("P100", "a feed line is feed <name>: mcp|file|dir prop=value", 1);
    const feed: Record<string, SlatePropValue> = { kind: m[2]! };
    for (const a of readAttrs(line.text, m[0].length)) if (a.name !== undefined) feed[a.name] = a.value!;
    return { name: m[1]!, feed: feed as unknown as SlateFeed };
  }

  pipeLine(line: Line): { name: string; pipeline: string } {
    const m = /^pipe\s+([a-z][a-z0-9_]*)\s*=\s*(.+)$/.exec(line.body);
    if (m === null) throw new LineFault("P100", "a pipe line is pipe <name> = <pipeline>", 1);
    return { name: m[1]!, pipeline: m[2]!.trim() };
  }
}

function splitLines(src: string): { lines: Line[]; errors: SlateProblem[] } {
  const lines: Line[] = [];
  const errors: SlateProblem[] = [];
  src.split(/\r?\n/).forEach((text, i) => {
    const trimmed = text.trimEnd();
    if (trimmed.trim() === "" || trimmed.trimStart().startsWith("//")) return;
    if (/^[ ]*\t/.test(trimmed)) { errors.push(slateProblem("P101", "indent with spaces, not tabs", { line: i + 1, column: 1 })); return; }
    const indent = trimmed.length - trimmed.trimStart().length;
    if (indent % 2 !== 0) { errors.push(slateProblem("P101", `indent is ${indent} spaces; children are two spaces in from their parent`, { line: i + 1, column: 1 })); return; }
    lines.push({ n: i + 1, indent, text: trimmed, body: trimmed.slice(indent) });
  });
  return { lines, errors };
}

/** The shorthand as a document, before validation; errors are P codes and the T and A codes a line alone shows. */
export function compileLines(src: string): { document?: Slate; errors: SlateProblem[]; pieceLine: Map<string, number> } {
  const { lines, errors } = splitLines(src);
  const b = new Builder(src.split(/\r?\n/));
  b.errors.push(...errors);
  const doc: Slate = { schema: 1, root: "", pieces: {} };
  let state: Record<string, SlateJson> = {};
  let first = true;
  const tops: string[] = [];
  const stack: Owner[] = [];
  for (const line of lines) {
    try {
      if (line.indent === 0) {
        stack.length = 0;
        if (/^slate(\s|$)/.test(line.body)) {
          if (!first) throw new LineFault("P100", "the slate header goes on the first line", 1);
          const m = /^slate(?:\s+(\d+))?(?:\s+("(?:[^"\\]|\\.)*"))?\s*$/.exec(line.body);
          if (m === null) throw new LineFault("P100", "the header is slate <schema> \"<title>\"", 1);
          if (m[1] !== undefined) (doc as { schema: number }).schema = Number(m[1]);
          if (m[2] !== undefined) doc.title = JSON.parse(m[2]) as string;
        } else if (/^state[.[]/.test(line.body)) {
          state = b.stateLine(line, state);
        } else if (/^feed\s/.test(line.body)) {
          const { name, feed } = b.feedLine(line);
          (doc.feeds ??= {})[name] = feed;
          stack.push({ kind: "feed", indent: 0, feed });
        } else if (/^pipe\s/.test(line.body)) {
          const { name, pipeline } = b.pipeLine(line);
          (doc.pipes ??= {})[name] = pipeline;
        } else if (/^[-@|]/.test(line.body) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(line.body)) {
          throw new LineFault("P101", "this line needs a piece above it, indented two spaces in", 1);
        } else {
          const { id, piece } = b.pieceLine_(line, 0);
          tops.push(id);
          stack.push({ kind: "piece", indent: 0, id, piece });
        }
      } else {
        b.body(line, stack);
      }
    } catch (e) {
      b.fault(line, e);
    }
    first = false;
  }
  if (Object.keys(state).length > 0) doc.state = state;
  doc.pieces = b.pieces;
  if (tops.length === 1) doc.root = tops[0]!;
  else if (tops.length === 0) b.errors.push(slateProblem("D202", "there is no piece; write one, like root: column"));
  else b.errors.push(slateProblem("D202", `${tops.length} top-level pieces (${tops.join(", ")}). Wrap them in a column.`, { line: b.pieceLine.get(tops[1]!)!, fix: "root: column" }));
  return b.errors.length > 0 ? { errors: b.errors, pieceLine: b.pieceLine } : { document: doc, errors: [], pieceLine: b.pieceLine };
}

const capErrors = (errors: SlateProblem[]): SlateProblem[] =>
  errors.length <= SLATE_LIMITS.errorsPerPass ? errors : [...errors.slice(0, SLATE_LIMITS.errorsPerPass), slateProblem("P100", `and ${errors.length - SLATE_LIMITS.errorsPerPass} more`)];

/** Shorthand to a validated document: compile errors stop the pass; else every validator error, with the line
 * of the piece it names. */
export function compileSlate(lines: string): { document?: Slate; errors: SlateProblem[]; warnings: SlateProblem[] } {
  const compiled = compileLines(lines);
  if (compiled.document === undefined) return { errors: capErrors(compiled.errors), warnings: [] };
  const checked = validateSlate(compiled.document);
  const withLine = (p: SlateProblem): SlateProblem => (p.line === undefined && p.piece !== undefined && compiled.pieceLine.has(p.piece) ? { ...p, line: compiled.pieceLine.get(p.piece)! } : p);
  return { ...(checked.document !== undefined ? { document: checked.document } : {}), errors: checked.errors.map(withLine), warnings: checked.warnings.map(withLine) };
}

// ---- patches ----

/** Patch lines to ops against the current document; the ops are validated when applied. */
export function compileSlatePatch(lines: string, current: Slate): { ops?: SlatePatchOp[]; errors: SlateProblem[] } {
  const { lines: ls, errors } = splitLines(lines);
  const b = new Builder(lines.split(/\r?\n/), id => current.pieces[id]);
  for (const id of Object.keys(current.pieces)) b.explicit.add(id);
  b.errors.push(...errors);
  const ops: SlatePatchOp[] = [];
  const pending: (() => void)[] = [];
  const stack: Owner[] = [];
  let opts: Parameters<Builder["body"]>[2] = {};
  let addOp: { op: SlatePatchOp & { children?: Record<string, SlatePiece> }; id: string } | undefined;
  const closeAdd = (): void => {
    if (addOp === undefined) return;
    const children: Record<string, SlatePiece> = {};
    for (const [id, piece] of Object.entries(b.pieces)) if (id !== addOp.id) children[id] = piece;
    if (Object.keys(children).length > 0) addOp.op.children = children;
    addOp = undefined;
  };
  for (const line of ls) {
    try {
      if (line.indent > 0) {
        if (stack.length === 0) throw new LineFault("P101", "this line is indented under no op", 1);
        b.body(line, stack, opts);
        continue;
      }
      closeAdd();
      stack.length = 0;
      opts = {};
      b.pieces = {};
      const body = line.body;
      if (/^\+\s/.test(body)) {
        const start = body.indexOf(" ") + 1;
        const { id, piece } = b.pieceLine_(line, start + (body.slice(start).length - body.slice(start).trimStart().length));
        const props = piece.props ?? {};
        const under = props.under;
        const at = props.at;
        delete props.under;
        delete props.at;
        if (Object.keys(props).length === 0) delete piece.props;
        const op: SlatePatchOp = { op: "add", id, piece, ...(typeof under === "string" ? { under } : {}), ...(typeof at === "number" ? { at } : {}) };
        ops.push(op);
        addOp = { op, id };
        stack.push({ kind: "piece", indent: 0, id, piece });
        continue;
      }
      if (/^~\s+[a-z][a-z0-9-]*:/.test(body)) {
        const { id, piece } = b.pieceLine_(line, body.indexOf(" ") + 1);
        const op: SlatePatchOp = { op: "replace", id, piece };
        ops.push(op);
        addOp = { op, id };
        stack.push({ kind: "piece", indent: 0, id, piece });
        continue;
      }
      const tilde = /^~\s+([a-z][a-z0-9-]*)(?=\s|$)/.exec(body);
      if (tilde !== null) {
        const id = tilde[1]!;
        const had = current.pieces[id];
        if (had === undefined) throw new LineFault("D203", `no piece has the id ${id}`, 3, nearest(id, Object.keys(current.pieces)));
        const shell: SlatePiece = { type: had.type };
        const patch: Record<string, unknown> = {};
        b.applyAttrs(shell, SLATE_PIECES[had.type], readAttrs(line.text, tilde[0].length), id, patch);
        const op: SlatePatchOp & { op: "props" } = { op: "props", id, ...(shell.props !== undefined ? { props: shell.props } : {}) };
        if ("when" in patch) op.when = patch.when as string | null;
        else if (shell.when !== undefined) op.when = shell.when;
        if ("fallback" in patch) op.fallback = patch.fallback as SlatePiece["fallback"] | null;
        ops.push(op);
        const on: Record<string, SlateAction | SlateAction[]> = {};
        opts = { current: had, on, patch };
        stack.push({ kind: "piece", indent: 0, id, piece: shell });
        const finish = (): void => {
          if (shell.props !== undefined) op.props = shell.props;
          if (Object.keys(on).length > 0) op.on = on;
          if ("when" in patch) op.when = patch.when as string | null;
          if ("fallback" in patch) op.fallback = patch.fallback as SlatePiece["fallback"] | null;
        };
        pending.push(finish);
        continue;
      }
      const move = /^>\s+([a-z][a-z0-9-]*)(?=\s|$)/.exec(body);
      if (move !== null) {
        const op: Record<string, unknown> = { op: "move", id: move[1]! };
        for (const a of readAttrs(line.text, move[0].length)) if (a.name === "under" || a.name === "at") op[a.name] = a.value;
        if (typeof op.under !== "string") throw new LineFault("P100", "a move names under=<id>", 1);
        ops.push(op as SlatePatchOp);
        continue;
      }
      const remove = /^-\s+(?:(feed|pipe)\s+([a-z][a-z0-9_]*)|([a-z][a-z0-9-]*))\s*$/.exec(body);
      if (remove !== null) {
        if (remove[1] === "feed") ops.push({ op: "feed", id: remove[2]!, feed: null });
        else if (remove[1] === "pipe") ops.push({ op: "pipe", id: remove[2]!, pipeline: null });
        else ops.push({ op: "remove", id: remove[3]! });
        continue;
      }
      if (/^state[.[]/.test(body)) {
        const m = /^(state\S*)\s*=/.exec(body);
        const value = b.stateLine(line, {});
        const path = m![1]!;
        ops.push({ op: "state", path, value: getPathValue(value, path) });
        continue;
      }
      if (/^feed\s/.test(body)) {
        const { name, feed } = b.feedLine(line);
        ops.push({ op: "feed", id: name, feed });
        stack.push({ kind: "feed", indent: 0, feed });
        continue;
      }
      if (/^pipe\s/.test(body)) {
        const { name, pipeline } = b.pipeLine(line);
        ops.push({ op: "pipe", id: name, pipeline });
        continue;
      }
      throw new LineFault("P105", "a patch line starts with + (add), ~ (change), > (move), - (remove), state., feed or pipe", 1);
    } catch (e) {
      b.fault(line, e);
    }
  }
  closeAdd();
  for (const finish of pending.splice(0)) finish();
  return b.errors.length > 0 ? { errors: capErrors(b.errors) } : { ops, errors: [] };
}
function getPathValue(state: Record<string, SlateJson>, path: string): SlateJson {
  const segs = parseSlateStatePath(path) ?? [];
  let at: SlateJson | undefined = state;
  for (const s of segs) at = at !== null && typeof at === "object" ? (at as Record<string, SlateJson>)[s as never] : undefined;
  return at ?? null;
}

// ---- printing ----

const BARE = /^[a-z][a-z0-9\-_./:]*$/;

function printValue(v: SlatePropValue): string {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return BARE.test(v) && v !== "true" && v !== "false" && v !== "null" ? v : JSON.stringify(v);
  if (isSlateBinding(v)) return `{${v.bind}}`;
  if (isSlateFormat(v)) return `\`${v.format}\``;
  if (Array.isArray(v)) return `[${v.map(printValue).join(", ")}]`;
  return JSON.stringify(v);
}

/** One JSON value on one line with a space after each comma and colon, as the state lines read. */
function jsonLine(v: SlateJson): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jsonLine).join(", ")}]`;
  return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${jsonLine(x)}`).join(", ")}}`;
}

/** Attrs in canonical order: flags first, then props in declared order, then any the type does not declare. */
function printAttrs(values: Record<string, SlatePropValue>, specs: Record<string, { type: unknown }>, skip: ReadonlySet<string>): string[] {
  const flags = slateFlags(specs as never);
  const words: string[] = [];
  const pairs: string[] = [];
  const order = [...Object.keys(specs), ...Object.keys(values).filter(k => !(k in specs))];
  for (const name of order) {
    if (!(name in values) || skip.has(name)) continue;
    const v = values[name]!;
    if (typeof v === "boolean") {
      const word = v ? name : `no-${name}`;
      const hit = flags.get(word);
      if (hit !== undefined && hit !== "ambiguous" && hit.prop === name) { words.push(word); continue; }
    }
    if (typeof v === "string") {
      const hit = flags.get(v);
      if (hit !== undefined && hit !== "ambiguous" && hit.prop === name && v !== "normal" && v !== "default") { words.push(v); continue; }
    }
    pairs.push(`${name}=${printValue(v)}`);
  }
  return [...words, ...pairs];
}

/** Joins a head and its attrs, breaking onto continuation lines past the width; a flag never starts one. */
function wrap(indent: string, head: string, attrs: string[], out: string[]): void {
  let line = `${indent}${head}`;
  for (const a of attrs) {
    const fits = line.length + 1 + a.length <= SLATE_LIMITS.printColumns;
    if (!fits && a.includes("=") && line.trim() !== head.trim()) {
      out.push(line);
      line = `${indent}  ${a}`;
    } else line += ` ${a}`;
  }
  out.push(line);
}

function printActions(on: SlatePiece["on"], indent: string, out: string[]): void {
  if (on === undefined) return;
  for (const event of SLATE_EVENTS) {
    const list = on[event as SlateEventName];
    if (list === undefined) continue;
    for (const action of Array.isArray(list) ? list : [list]) {
      const { do: kind, ...args } = action as unknown as Record<string, SlatePropValue> & { do: string };
      const specs = SLATE_ACTIONS[kind]?.args ?? {};
      const order = [...Object.keys(specs), ...Object.keys(args).filter(k => !(k in specs))];
      const attrs = order.filter(k => k in args && k !== "args").map(k => `${k}=${printValue(args[k]!)}`);
      wrap(indent, `@${event} ${kind}`, attrs, out);
      const inner = args.args;
      if (inner !== undefined && typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
        for (const [k, v] of Object.entries(inner)) out.push(`${indent}  - arg ${k}=${printValue(v as SlatePropValue)}`);
      }
    }
  }
}

function printPiece(doc: Slate, id: string, depth: number, out: string[], seen: Set<string>): void {
  const piece = doc.pieces[id];
  if (piece === undefined || seen.has(id)) return;
  seen.add(id);
  const indent = "  ".repeat(depth);
  const module = SLATE_PIECES[piece.type];
  const props = piece.props ?? {};
  const itemProps = new Map(Object.entries(module?.items ?? {}).map(([kind, spec]) => [spec.prop, { kind, spec }]));
  const skip = new Set<string>([...itemProps.keys()].filter(p => Array.isArray(props[p])));
  if (module?.blockProp !== undefined && typeof props[module.blockProp] === "string") skip.add(module.blockProp);
  const attrs = printAttrs(props, module?.props ?? {}, skip);
  if (piece.announce === true) attrs.unshift("announce");
  if (piece.when !== undefined) attrs.push(`when={${piece.when}}`);
  if (piece.fallback !== undefined) attrs.push(`fallback=${typeof piece.fallback === "string" ? piece.fallback : JSON.stringify(piece.fallback.text)}`);
  wrap(indent, `${id}: ${piece.type}`, attrs, out);
  if (module?.blockProp !== undefined && skip.has(module.blockProp)) {
    for (const l of (props[module.blockProp] as string).split("\n")) out.push(`${indent}  |${l === "" ? "" : ` ${l}`}`);
  }
  for (const [prop, { kind, spec }] of itemProps) {
    const list = props[prop];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const rec = (item ?? {}) as Record<string, SlatePropValue>;
      const itemAttrs = printAttrs(rec, spec.fields, new Set(["on", "when"]));
      if (typeof rec.when === "string") itemAttrs.push(`when={${rec.when}}`);
      wrap(`${indent}  `, `- ${kind}`, itemAttrs, out);
      printActions(rec.on as SlatePiece["on"], `${indent}    `, out);
    }
  }
  printActions(piece.on, `${indent}  `, out);
  for (const child of piece.children ?? []) printPiece(doc, child, depth + 1, out, seen);
}

/** The document as canonical shorthand: header, state, feeds, pipes, then the root's subtree, every id written. */
export function printSlate(doc: Slate): string {
  const out: string[] = [doc.title !== undefined ? `slate ${doc.schema} ${JSON.stringify(doc.title)}` : `slate ${doc.schema}`];
  const state = Object.entries(doc.state ?? {});
  const top: string[] = [];
  for (const [k, v] of state.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) top.push(`state.${k} = ${jsonLine(v)}`);
  for (const [name, feed] of Object.entries(doc.feeds ?? {})) {
    const { kind, args, ...rest } = feed as SlateFeed & { args?: Record<string, SlateJson> };
    top.push([`feed ${name}: ${kind}`, ...Object.entries(rest).map(([k, v]) => `${k}=${printValue(v as SlatePropValue)}`)].join(" "));
    for (const [k, v] of Object.entries(args ?? {})) top.push(`  - arg ${k}=${printValue(v)}`);
  }
  for (const [name, pipe] of Object.entries(doc.pipes ?? {})) top.push(`pipe ${name} = ${pipe}`);
  if (top.length > 0) out.push("", ...top);
  out.push("");
  const seen = new Set<string>();
  printPiece(doc, doc.root, 0, out, seen);
  for (const id of Object.keys(doc.pieces)) if (!seen.has(id)) printPiece(doc, id, 0, out, seen);
  return `${out.join("\n")}\n`;
}
