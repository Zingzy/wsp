// SPDX-License-Identifier: AGPL-3.0-only
// The JSX-like form, compiled to the same stored document as the lines and checked by the same validator. Elements
// are piece types, a child element named by an item kind is an item, props are "strings" or {formulas}, events are
// onPress={send("...", { with: [...] })} calls onto the existing actions, title and state sit on one <slate> frame.
import { parseSlateFormat } from "./expr.js";
import { SLATE_ACTIONS, SLATE_PIECES, slateFlags, type SlatePropSpec } from "./kit.js";
import { SLATE_LIMITS } from "./limits.js";
import { nearest, slateProblem, type SlateCode } from "./problems.js";
import { isSlateBinding, isSlateFormat, SLATE_EVENTS, SLATE_ID, type Slate, type SlateAction, type SlateJson, type SlatePiece, type SlateProblem, type SlatePropValue } from "./types.js";
import { validateSlate } from "./validate.js";

class JsxFault extends Error {
  constructor(readonly code: SlateCode, message: string, readonly at: number, readonly fix?: string) { super(message); }
}

/** The pieces whose value is written between the tags; markdown's is taken raw. */
const CONTENT: Readonly<Record<string, string>> = { text: "value", markdown: "value" };
const ITEM_OWNERS = new Map<string, string>(Object.values(SLATE_PIECES).flatMap(p => Object.keys(p.items).map(kind => [kind, p.type] as [string, string])));

// ---- values inside braces ----

type Node =
  | { k: "lit"; v: SlateJson }
  | { k: "arr"; items: Node[] }
  | { k: "obj"; entries: [string, Node][] }
  | { k: "tpl"; format: string }
  | { k: "raw"; src: string };

const isLiteral = (n: Node): boolean => n.k === "lit" || (n.k === "arr" && n.items.every(isLiteral)) || (n.k === "obj" && n.entries.every(([, v]) => isLiteral(v)));
const literal = (n: Node): SlateJson =>
  n.k === "lit" ? n.v : n.k === "arr" ? n.items.map(literal) : n.k === "obj" ? Object.fromEntries(n.entries.map(([k, v]) => [k, literal(v)])) : null;
const toValue = (n: Node): SlatePropValue =>
  n.k === "lit" ? n.v : n.k === "arr" ? n.items.map(toValue) : n.k === "obj" ? Object.fromEntries(n.entries.map(([k, v]) => [k, toValue(v)]))
    : n.k === "tpl" ? { format: n.format } : { bind: n.src };

/** The end of a quoted string or template opened at src[i], past its closing mark. */
function skipQuoted(src: string, i: number): number {
  const q = src[i]!;
  let j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === "\\") j++;
    else if (q === "`" && src.startsWith("${", j)) { j = matchBrace(src, j + 1); }
    j++;
  }
  if (j >= src.length) throw new JsxFault("P100", `a ${q === "`" ? "template" : "string"} opened here never closes`, i);
  return j + 1;
}

/** The index of the } closing the { at src[i]. */
function matchBrace(src: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '"' || c === "'" || c === "`") { j = skipQuoted(src, j); continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j;
    j++;
  }
  throw new JsxFault("P100", "a { opened here never closes", i);
}

/** A small reader for what sits inside braces: literals, lists, objects, templates, and any formula as raw text. */
class ValueReader {
  i = 0;
  constructor(readonly src: string, readonly base: number) {}

  ws(): void { while (/\s/.test(this.src[this.i] ?? "")) this.i++; }
  done(): boolean { this.ws(); return this.i >= this.src.length; }
  fault(message: string): never { throw new JsxFault("P100", message, this.base + this.i); }

  node(): Node {
    this.ws();
    const start = this.i;
    const c = this.src[this.i];
    let n: Node | undefined;
    if (c === '"' || c === "'") {
      const end = skipQuoted(this.src, this.i);
      const body = this.src.slice(this.i + 1, end - 1);
      this.i = end;
      try {
        n = { k: "lit", v: JSON.parse(`"${c === "'" ? body.replace(/\\'/g, "'").replace(/"/g, '\\"') : body}"`) as string };
      } catch {
        throw new JsxFault("P106", "the string is not valid: escapes are JSON's", this.base + start);
      }
    } else if (c === "`") {
      const end = skipQuoted(this.src, this.i);
      n = { k: "tpl", format: this.src.slice(this.i + 1, end - 1) };
      this.i = end;
    } else if (c === "[") {
      this.i++;
      const items: Node[] = [];
      for (;;) {
        this.ws();
        if (this.src[this.i] === "]") { this.i++; break; }
        items.push(this.node());
        this.ws();
        if (this.src[this.i] === ",") { this.i++; continue; }
        if (this.src[this.i] === "]") { this.i++; break; }
        return this.rawFrom(start);
      }
      n = { k: "arr", items };
    } else if (c === "{") {
      this.i++;
      const entries: [string, Node][] = [];
      for (;;) {
        this.ws();
        if (this.src[this.i] === "}") { this.i++; break; }
        const key = /^(?:([A-Za-z_][A-Za-z0-9_]*)|"([^"\\]*)"|'([^'\\]*)')\s*:/.exec(this.src.slice(this.i));
        if (key === null) this.fault("an object is { key: value, ... }");
        this.i += key[0].length;
        entries.push([key[1] ?? key[2] ?? key[3]!, this.node()]);
        this.ws();
        if (this.src[this.i] === ",") { this.i++; continue; }
        if (this.src[this.i] === "}") { this.i++; break; }
        this.fault("expected , or } in the object");
      }
      n = { k: "obj", entries };
    } else {
      const m = /^(?:-?\d+(?:\.\d+)?|true|false|null)(?![A-Za-z0-9_.(\[])/.exec(this.src.slice(this.i));
      if (m !== null) { n = { k: "lit", v: JSON.parse(m[0]) as SlateJson }; this.i += m[0].length; }
    }
    if (n === undefined) return this.rawFrom(start);
    const save = this.i;
    this.ws();
    if (this.i < this.src.length && !",]})".includes(this.src[this.i]!)) return this.rawFrom(start);
    this.i = save;
    return n;
  }

  /** A formula from start to the next , ] } or ) at depth 0. */
  rawFrom(start: number): Node {
    let j = start;
    let depth = 0;
    while (j < this.src.length) {
      const c = this.src[j]!;
      if (c === '"' || c === "'" || c === "`") { j = skipQuoted(this.src, j); continue; }
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) { if (depth === 0) break; depth--; }
      else if (c === "," && depth === 0) break;
      j++;
    }
    this.i = j;
    const src = this.src.slice(start, j).trim();
    if (src === "") this.fault("expected a value");
    return { k: "raw", src };
  }
}

/** A braced prop value: a literal stays literal, a template is a format, anything else binds. */
function braced(inner: string, base: number): SlatePropValue {
  const src = inner.trim();
  if (src === "") throw new JsxFault("P100", "the braces are empty", base);
  const r = new ValueReader(src, base);
  const n = r.node();
  if (!r.done()) return { bind: src };
  if (isLiteral(n)) return literal(n);
  if (n.k === "tpl") return { format: n.format };
  return { bind: src };
}

/** An argument naming a path: a bare path or a quoted one. */
const pathOf = (n: Node): SlatePropValue => (n.k === "raw" ? n.src : n.k === "lit" && typeof n.v === "string" ? n.v : toValue(n));

/** One call, kind(arg, ..., { option: value }), onto an action: positional arguments fill the action's args in
 * their declared order, and a trailing object past the required ones carries the rest by name. */
function readCall(r: ValueReader): SlateAction {
  r.ws();
  const at = r.i;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(r.src.slice(r.i));
  if (m === null) throw new JsxFault("A601", `an event takes a call like send("text", { with: [paths] }), or a list of them in [ ]`, r.base + at, 'send("...")');
  r.i += m[0].length;
  const args: Node[] = [];
  for (;;) {
    r.ws();
    if (r.src[r.i] === ")") { r.i++; break; }
    args.push(r.node());
    r.ws();
    if (r.src[r.i] === ",") { r.i++; continue; }
    if (r.src[r.i] === ")") { r.i++; break; }
    r.fault("expected , or ) in the call");
  }
  const kind = m[1]!;
  const specs = Object.entries(SLATE_ACTIONS[kind]?.args ?? {}) as [string, SlatePropSpec & { path?: string }][];
  const required = specs.filter(([, s]) => s.required === true).length;
  const action: Record<string, SlatePropValue> = { do: kind };
  const put = (name: string, n: Node): void => {
    const spec = specs.find(([k]) => k === name)?.[1];
    action[name] = spec?.path === "state" ? pathOf(n) : spec?.path === "any" && n.k === "arr" ? n.items.map(pathOf) : toValue(n);
  };
  args.forEach((n, i) => {
    if (n.k === "obj" && i >= required && i === args.length - 1) for (const [k, v] of n.entries) put(k, v);
    else if (i < specs.length) put(specs[i]![0], n);
    else throw new JsxFault("A601", `${kind} takes ${specs.map(([k]) => k).join(", ") || "no arguments"}; this one is extra`, r.base + at);
  });
  return action as unknown as SlateAction;
}

function readActions(inner: string, base: number): SlateAction | SlateAction[] {
  const r = new ValueReader(inner, base);
  r.ws();
  if (r.src[r.i] !== "[") {
    const one = readCall(r);
    if (!r.done()) r.fault("one call, or a list of calls in [ ]");
    return one;
  }
  r.i++;
  const out: SlateAction[] = [];
  for (;;) {
    r.ws();
    if (r.src[r.i] === "]") { r.i++; break; }
    out.push(readCall(r));
    r.ws();
    if (r.src[r.i] === ",") { r.i++; continue; }
    if (r.src[r.i] === "]") { r.i++; break; }
    r.fault("expected , or ] between the calls");
  }
  if (!r.done()) r.fault("nothing goes after the list of calls");
  return out.length === 1 ? out[0]! : out;
}

// ---- elements ----

interface Attr { name: string; at: number; value?: SlatePropValue; raw?: string; rawAt?: number; quoted?: true }

/** Babel's rule for text between tags: lines trimmed where they meet a line break, blank lines dropped, joined by a space. */
function jsxText(s: string): string {
  const lines = s.split(/\r?\n/);
  let last = 0;
  lines.forEach((l, i) => { if (/[^ \t]/.test(l)) last = i; });
  let out = "";
  lines.forEach((l, i) => {
    let t = l.replace(/\t/g, " ");
    if (i !== 0) t = t.replace(/^ +/, "");
    if (i !== lines.length - 1) t = t.replace(/ +$/, "");
    if (t !== "") out += i !== last ? `${t} ` : t;
  });
  return out;
}

function dedent(s: string): string {
  const lines = s.split(/\r?\n/);
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const pad = Math.min(...lines.filter(l => l.trim() !== "").map(l => l.length - l.trimStart().length));
  return lines.map(l => l.slice(Number.isFinite(pad) ? pad : 0).trimEnd()).join("\n");
}

class Compiler {
  readonly errors: SlateProblem[] = [];
  readonly pieceAt = new Map<string, number>();
  readonly pieces: Record<string, SlatePiece> = {};
  private readonly explicit = new Set<string>();
  private readonly minted = new Map<string, number>();
  i = 0;

  constructor(readonly src: string) {
    for (const m of src.matchAll(/\bid\s*=\s*["']([^"']*)["']/g)) this.explicit.add(m[1]!);
  }

  line(at: number): { line: number; column: number } {
    const before = this.src.slice(0, at);
    const line = before.split("\n").length;
    return { line, column: at - before.lastIndexOf("\n") };
  }
  fault(e: unknown): void {
    if (!(e instanceof JsxFault)) throw e;
    this.errors.push(slateProblem(e.code, e.message, { ...this.line(e.at), ...(e.fix !== undefined ? { fix: e.fix } : {}) }));
  }
  /** Runs one attribute's work; a fault there is reported and the element goes on. */
  tryAttr(work: () => void): void { try { work(); } catch (e) { this.fault(e); } }

  /** Whitespace and {/* comments * /} between elements. */
  skip(): void {
    for (;;) {
      while (/\s/.test(this.src[this.i] ?? "")) this.i++;
      const c = /^\{\s*\/\*[\s\S]*?\*\/\s*\}/.exec(this.src.slice(this.i));
      if (c === null) return;
      this.i += c[0].length;
    }
  }

  name(): string {
    const m = /^[A-Za-z][A-Za-z0-9_-]*/.exec(this.src.slice(this.i));
    if (m === null) throw new JsxFault("P100", "expected a name here", this.i);
    this.i += m[0].length;
    return m[0];
  }

  /** The attributes up to > or />; answers whether the tag closed itself. */
  attrs(): { attrs: Attr[]; selfClosing: boolean } {
    const attrs: Attr[] = [];
    for (;;) {
      while (/\s/.test(this.src[this.i] ?? "")) this.i++;
      if (this.src.startsWith("/>", this.i)) { this.i += 2; return { attrs, selfClosing: true }; }
      if (this.src[this.i] === ">") { this.i++; return { attrs, selfClosing: false }; }
      if (this.i >= this.src.length) throw new JsxFault("P100", "a tag opened here never closes with > or />", this.i);
      const at = this.i;
      const name = this.name();
      while (this.src[this.i] === " ") this.i++;
      if (this.src[this.i] !== "=") { attrs.push({ name, at }); continue; }
      this.i++;
      while (this.src[this.i] === " ") this.i++;
      const c = this.src[this.i];
      if (c === '"' || c === "'") {
        const end = skipQuoted(this.src, this.i);
        const body = this.src.slice(this.i + 1, end - 1);
        let value: string;
        try {
          value = JSON.parse(`"${c === "'" ? body.replace(/"/g, '\\"') : body}"`) as string;
        } catch {
          throw new JsxFault("P106", `the string for ${name} is not valid: escapes are JSON's`, this.i);
        }
        attrs.push({ name, at, value, quoted: true });
        this.i = end;
      } else if (c === "{") {
        const end = matchBrace(this.src, this.i);
        attrs.push({ name, at, raw: this.src.slice(this.i + 1, end), rawAt: this.i + 1 });
        this.i = end + 1;
      } else {
        const word = /^[^\s/>]+/.exec(this.src.slice(this.i))?.[0] ?? "";
        throw new JsxFault("P100", `${name}= takes "a string" or {a formula}`, this.i, /^-?\d/.test(word) ? `${name}={${word}}` : `${name}="${word}"`);
      }
    }
  }

  mint(type: string): string {
    let n = this.minted.get(type) ?? 0;
    let id: string;
    do id = `${type}-${++n}`; while (this.explicit.has(id) || this.pieces[id] !== undefined);
    this.minted.set(type, n);
    return id;
  }

  flag(props: Record<string, SlatePropSpec>, word: string, type: string, at: number): [string, SlatePropValue] {
    const flags = slateFlags(props);
    const hit = flags.get(word);
    if (hit !== undefined && hit !== "ambiguous") return [hit.prop, hit.value];
    if (hit === "ambiguous") throw new JsxFault("P102", `${word} is a value of more than one prop of ${type}; write it as prop="${word}"`, at);
    const fix = nearest(word, [...flags.keys()].filter(w => flags.get(w) !== "ambiguous"));
    throw new JsxFault("P102", `"${word}" is not a flag of ${type}${fix !== undefined ? `; did you mean ${fix}?` : ""}`, at, fix);
  }

  value(a: Attr): SlatePropValue {
    return a.raw !== undefined ? braced(a.raw, a.rawAt!) : a.value!;
  }

  event(a: Attr, on: Record<string, SlateAction | SlateAction[]>): void {
    const event = a.name.slice(2).toLowerCase();
    if (!(SLATE_EVENTS as readonly string[]).includes(event)) {
      const fix = nearest(event, SLATE_EVENTS);
      throw new JsxFault("A602", `${a.name} is not an event; events are onPress, onSubmit and onChange`, a.at, fix !== undefined ? `on${fix[0]!.toUpperCase()}${fix.slice(1)}` : undefined);
    }
    if (a.raw === undefined) throw new JsxFault("A601", `${a.name} takes a call in braces, like ${a.name}={send("...")}`, a.at);
    on[event] = readActions(a.raw, a.rawAt!);
  }

  /** One element at this.i: a piece (answers its id) or, under a piece that takes it, an item. */
  element(parent?: { id: string; piece: SlatePiece }): string | undefined {
    const open = this.i;
    this.i++;
    const tag = this.name();
    const owner = parent === undefined ? undefined : SLATE_PIECES[parent.piece.type];
    const spec = owner?.items[tag];
    const { attrs, selfClosing } = this.attrs();
    if (spec !== undefined) {
      const record: Record<string, SlatePropValue> = {};
      const on: Record<string, SlateAction | SlateAction[]> = {};
      for (const a of attrs) this.tryAttr(() => {
        if (a.raw === undefined && a.value === undefined) { const [p, v] = this.flag(spec.fields, a.name, `<${tag}>`, a.at); record[p] = v; return; }
        if (/^on[A-Z]/.test(a.name) && spec.events !== undefined) { this.event(a, on); return; }
        const v = this.value(a);
        record[a.name] = a.name === "when" && spec.when === true && isSlateBinding(v) ? v.bind : v;
      });
      if (Object.keys(on).length > 0) record.on = on as unknown as SlatePropValue;
      const props = parent!.piece.props ?? (parent!.piece.props = {});
      const list = props[spec.prop];
      props[spec.prop] = [...(Array.isArray(list) ? list : []), record];
      if (!selfClosing) {
        this.skip();
        if (!this.src.startsWith(`</${tag}`, this.i)) throw new JsxFault("P100", `<${tag}> holds nothing; close it with />`, this.i);
        this.closeTag(tag, open);
      }
      return undefined;
    }
    if (ITEM_OWNERS.has(tag) && SLATE_PIECES[tag] === undefined) {
      const home = ITEM_OWNERS.get(tag)!;
      throw new JsxFault("T314", `<${tag}> goes inside a <${home}>${owner !== undefined ? `, not a <${parent!.piece.type}>` : ""}`, open);
    }
    const piece: SlatePiece = { type: tag };
    const module = SLATE_PIECES[tag];
    let id: string | undefined;
    const idAttr = attrs.find(a => a.name === "id");
    if (idAttr !== undefined) this.tryAttr(() => {
      if (typeof idAttr.value !== "string") throw new JsxFault("P103", 'id is a word in quotes, like id="checks"', idAttr.at);
      if (!SLATE_ID.test(idAttr.value)) throw new JsxFault("P103", `"${idAttr.value}" is not a piece id: lowercase letters, digits and dashes, starting with a letter`, idAttr.at, idAttr.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
      if (this.pieces[idAttr.value] !== undefined) throw new JsxFault("P104", `${idAttr.value} is also on line ${this.line(this.pieceAt.get(idAttr.value)!).line}`, idAttr.at);
      id = idAttr.value;
    });
    id ??= this.mint(tag);
    this.pieces[id] = piece;
    this.pieceAt.set(id, open);
    const props: Record<string, SlatePropValue> = {};
    const on: Record<string, SlateAction | SlateAction[]> = {};
    for (const a of attrs) this.tryAttr(() => {
      if (a.name === "id") return;
      if (a.raw === undefined && a.value === undefined) {
        if (a.name === "announce") { piece.announce = true; return; }
        if (module === undefined) return;
        const [p, v] = this.flag(module.props, a.name, tag, a.at);
        props[p] = v;
        return;
      }
      if (/^on[A-Z]/.test(a.name)) { this.event(a, on); return; }
      const v = this.value(a);
      if (a.name === "when") {
        if (!isSlateBinding(v)) throw new JsxFault("T303", "when takes a formula in braces: when={...}", a.at);
        piece.when = v.bind;
        return;
      }
      if (a.name === "fallback") {
        if (typeof v !== "string") throw new JsxFault("T303", 'fallback is "drop", a piece id or a sentence', a.at);
        piece.fallback = v === "drop" || SLATE_ID.test(v) ? v : { text: v };
        return;
      }
      if (a.name === "announce" && typeof v === "boolean") { piece.announce = v; return; }
      props[a.name] = v;
    });
    if (Object.keys(props).length > 0) piece.props = props;
    if (Object.keys(on).length > 0) piece.on = on as SlatePiece["on"];
    if (!selfClosing) this.content(tag, id, piece, open);
    return id;
  }

  closeTag(tag: string, open: number): void {
    const m = /^<\/\s*([A-Za-z][A-Za-z0-9_-]*)\s*>/.exec(this.src.slice(this.i));
    if (m === null || m[1] !== tag) throw new JsxFault("P100", `<${tag}> opened on line ${this.line(open).line} is closed by ${m === null ? "nothing" : `</${m[1]}>`}; close it with </${tag}>`, this.i);
    this.i += m[0].length;
  }

  /** What sits between a piece's tags: child elements, or for text and markdown, its value. */
  content(tag: string, id: string, piece: SlatePiece, open: number): void {
    const prop = CONTENT[tag];
    if (tag === "markdown") {
      const end = this.src.indexOf("</markdown>", this.i);
      if (end < 0) throw new JsxFault("P100", "<markdown> is never closed with </markdown>", open);
      const raw = this.src.slice(this.i, end);
      const trimmed = raw.trim();
      let value: SlatePropValue = dedent(raw);
      if (trimmed.startsWith("{") && matchBrace(trimmed, 0) === trimmed.length - 1) value = braced(trimmed.slice(1, -1), this.i + raw.indexOf("{") + 1);
      if (trimmed !== "") this.setContent(piece, prop!, value, open);
      this.i = end + "</markdown>".length;
      return;
    }
    const parts: ({ lit: string } | { hole: SlatePropValue })[] = [];
    for (;;) {
      const c = /^\{\s*\/\*[\s\S]*?\*\/\s*\}/.exec(this.src.slice(this.i));
      if (c !== null) { this.i += c[0].length; continue; }
      if (this.i >= this.src.length) throw new JsxFault("P100", `<${tag}> opened on line ${this.line(open).line} is never closed`, open);
      if (this.src.startsWith("</", this.i)) { this.closeTag(tag, open); break; }
      if (this.src[this.i] === "<") {
        if (prop !== undefined) throw new JsxFault("P100", `<${tag}> holds words and {formulas}, not elements`, this.i);
        const child = this.element({ id, piece });
        if (child !== undefined) (piece.children ??= []).push(child);
        continue;
      }
      if (this.src[this.i] === "{") {
        const end = matchBrace(this.src, this.i);
        const at = this.i;
        const v = braced(this.src.slice(this.i + 1, end), this.i + 1);
        this.i = end + 1;
        if (prop === undefined) throw new JsxFault("P100", `<${tag}> holds pieces, not a {formula}; put it in a <text>`, at);
        parts.push({ hole: v });
        continue;
      }
      const m = /^[^<{]+/.exec(this.src.slice(this.i))!;
      const at = this.i;
      this.i += m[0].length;
      const words = prop === undefined && m[0].trim() === "" ? "" : jsxText(m[0]);
      if (words === "") continue;
      if (prop === undefined) throw new JsxFault("P100", `<${tag}> holds pieces, not words; put them in a <text>`, at);
      parts.push({ lit: words });
    }
    if (prop === undefined || parts.length === 0) return;
    let value: SlatePropValue;
    if (parts.length === 1 && "hole" in parts[0]!) value = parts[0].hole;
    else if (parts.every(p => "lit" in p)) value = parts.map(p => (p as { lit: string }).lit).join("");
    else value = { format: parts.map(p => ("lit" in p ? p.lit.replace(/\$\{/g, "$${") : isSlateFormat(p.hole) ? p.hole.format : isSlateBinding(p.hole) ? `\${${p.hole.bind}}` : String(p.hole).replace(/\$\{/g, "$${"))).join("") };
    this.setContent(piece, prop, value, open);
  }

  setContent(piece: SlatePiece, prop: string, value: SlatePropValue, open: number): void {
    if (piece.props?.[prop] !== undefined) throw new JsxFault("P100", `${prop} is given twice, as ${prop}= and between the tags`, open);
    piece.props = { ...piece.props, [prop]: value };
  }

  document(): Slate {
    const doc: Slate = { schema: 1, root: "", pieces: {} };
    const tops: string[] = [];
    this.skip();
    let frame = false;
    if (/^<slate[\s>/]/.test(this.src.slice(this.i))) {
      frame = true;
      const open = this.i;
      this.i += "<slate".length;
      const { attrs, selfClosing } = this.attrs();
      for (const a of attrs) this.tryAttr(() => {
        if (a.name === "title" && typeof a.value === "string") { doc.title = a.value; return; }
        if (a.name === "state" && a.raw !== undefined) {
          const r = new ValueReader(a.raw.trim(), a.rawAt!);
          const n = r.node();
          if (!r.done() || n.k !== "obj" || !isLiteral(n)) throw new JsxFault("S502", "state is an object of starting values, like state={{ done: 0, note: \"\" }}; values are literals", a.at);
          doc.state = literal(n) as Record<string, SlateJson>;
          return;
        }
        throw new JsxFault("P100", `<slate> takes title="..." and state={{ ... }}, not ${a.name}`, a.at);
      });
      if (selfClosing) throw new JsxFault("D202", "<slate> holds one piece, like <column>", open, "<column>");
      this.skip();
      while (this.src[this.i] === "<" && !this.src.startsWith("</", this.i)) {
        const id = this.element();
        if (id !== undefined) tops.push(id);
        this.skip();
      }
      this.closeTag("slate", open);
    } else {
      while (this.src[this.i] === "<" && !this.src.startsWith("</", this.i)) {
        const id = this.element();
        if (id !== undefined) tops.push(id);
        this.skip();
      }
    }
    this.skip();
    if (this.i < this.src.length) throw new JsxFault("P100", frame ? "nothing goes after </slate>" : "expected an element here, like <column>", this.i);
    doc.pieces = this.pieces;
    if (tops.length === 1) doc.root = tops[0]!;
    else if (tops.length === 0) this.errors.push(slateProblem("D202", "there is no piece; write one, like <column>"));
    else this.errors.push(slateProblem("D202", `${tops.length} top-level pieces (${tops.join(", ")}). Wrap them in a <column>.`, { ...this.line(this.pieceAt.get(tops[1]!)!), fix: "<column>" }));
    return doc;
  }
}

/** The JSX-like form to a validated document, as compileSlate does for the lines. */
export function compileSlateJsx(src: string): { document?: Slate; errors: SlateProblem[]; warnings: SlateProblem[] } {
  const c = new Compiler(src);
  let doc: Slate | undefined;
  try {
    doc = c.document();
  } catch (e) {
    c.fault(e);
  }
  if (doc === undefined || c.errors.length > 0) {
    const errors = c.errors.length <= SLATE_LIMITS.errorsPerPass ? c.errors : [...c.errors.slice(0, SLATE_LIMITS.errorsPerPass), slateProblem("P100", `and ${c.errors.length - SLATE_LIMITS.errorsPerPass} more`)];
    return { errors, warnings: [] };
  }
  const checked = validateSlate(doc);
  const withLine = (p: SlateProblem): SlateProblem => (p.line === undefined && p.piece !== undefined && c.pieceAt.has(p.piece) ? { ...p, line: c.line(c.pieceAt.get(p.piece)!).line } : p);
  return { ...(checked.document !== undefined ? { document: checked.document } : {}), errors: checked.errors.map(withLine), warnings: checked.warnings.map(withLine) };
}

// ---- printing ----

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A value as it reads inside braces. */
function js(v: SlatePropValue): string {
  if (isSlateBinding(v)) return v.bind;
  if (isSlateFormat(v)) return `\`${v.format}\``;
  if (Array.isArray(v)) return `[${v.map(js).join(", ")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v).map(([k, x]) => `${KEY.test(k) ? k : JSON.stringify(k)}: ${js(x)}`);
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(v);
}

const attrText = (name: string, v: SlatePropValue): string =>
  typeof v === "string" && !/["\\\n]/.test(v) ? `${name}="${v}"` : `${name}={${js(v)}}`;

function callText(a: SlateAction): string {
  const { do: kind, ...rest } = a as unknown as Record<string, SlatePropValue> & { do: string };
  const specs = Object.entries(SLATE_ACTIONS[kind]?.args ?? {});
  const positional: string[] = [];
  const named: string[] = [];
  for (const [name, spec] of specs) {
    if (!(name in rest)) continue;
    const v = rest[name]!;
    const text = (spec as { path?: string }).path === "state" && typeof v === "string" ? v
      : (spec as { path?: string }).path === "any" && Array.isArray(v) ? `[${v.map(p => (typeof p === "string" ? p : js(p))).join(", ")}]` : js(v);
    if (spec.required === true) positional.push(text);
    else named.push(`${name}: ${text}`);
  }
  return `${kind}(${[...positional, ...(named.length > 0 ? [`{ ${named.join(", ")} }`] : [])].join(", ")})`;
}

function eventAttrs(on: SlatePiece["on"]): string[] {
  const out: string[] = [];
  for (const event of SLATE_EVENTS) {
    const list = on?.[event];
    if (list === undefined) continue;
    const calls = (Array.isArray(list) ? list : [list]).map(callText);
    out.push(`on${event[0]!.toUpperCase()}${event.slice(1)}={${calls.length === 1 ? calls[0] : `[${calls.join(", ")}]`}}`);
  }
  return out;
}

/** Flags first, then props in declared order, then any the type does not declare. */
function propAttrs(values: Record<string, SlatePropValue>, specs: Record<string, SlatePropSpec>, skip: ReadonlySet<string>): string[] {
  const flags = slateFlags(specs);
  const words: string[] = [];
  const pairs: string[] = [];
  for (const name of [...Object.keys(specs), ...Object.keys(values).filter(k => !(k in specs))]) {
    if (!(name in values) || skip.has(name)) continue;
    const v = values[name]!;
    const word = typeof v === "boolean" ? (v ? name : `no-${name}`) : typeof v === "string" ? v : undefined;
    const hit = word === undefined ? undefined : flags.get(word);
    if (hit !== undefined && hit !== "ambiguous" && hit.prop === name && word !== "normal" && word !== "default") { words.push(word!); continue; }
    pairs.push(attrText(name, v));
  }
  return [...words, ...pairs];
}

/** A text value as words and {formulas} between the tags, where that reads back the same. */
function contentText(v: SlatePropValue): string | undefined {
  const safe = (s: string): boolean => s !== "" && !/[<>{}\n]/.test(s) && s.trim() === s;
  if (typeof v === "string") return safe(v) ? v : undefined;
  if (isSlateBinding(v)) return `{${v.bind}}`;
  if (!isSlateFormat(v)) return undefined;
  const { parts, errors } = parseSlateFormat(v.format);
  if (errors.length > 0) return undefined;
  const out = parts.map(p => (typeof p === "string" ? p : `{${p.expr}}`)).join("");
  return parts.every(p => typeof p !== "string" || !/[<>{}\n]/.test(p)) && out.trim() === out && out !== "" ? out : undefined;
}

function tag(indent: string, name: string, attrs: string[], close: string, out: string[]): void {
  const one = `${indent}<${name}${attrs.map(a => ` ${a}`).join("")}${close}`;
  if (one.length <= SLATE_LIMITS.printColumns) { out.push(one); return; }
  out.push(`${indent}<${name}`, ...attrs.map(a => `${indent}  ${a}`), `${indent}${close.trim()}`);
}

function printPiece(doc: Slate, id: string, depth: number, out: string[], seen: Set<string>): void {
  const piece = doc.pieces[id];
  if (piece === undefined || seen.has(id)) return;
  seen.add(id);
  const indent = "  ".repeat(depth);
  const module = SLATE_PIECES[piece.type];
  const props = piece.props ?? {};
  const items = Object.entries(module?.items ?? {}).filter(([, s]) => Array.isArray(props[s.prop]));
  const skip = new Set(items.map(([, s]) => s.prop));
  const contentProp = CONTENT[piece.type];
  let inner: string | undefined;
  let block: string[] | undefined;
  if (contentProp !== undefined && props[contentProp] !== undefined) {
    const v = props[contentProp]!;
    if (piece.type === "markdown" && typeof v === "string" && !v.includes("</markdown>")) block = v.split("\n");
    else if (piece.type !== "markdown") inner = contentText(v);
    if (inner !== undefined || block !== undefined) skip.add(contentProp);
  }
  const attrs = [`id="${id}"`, ...(piece.announce === true ? ["announce"] : []), ...propAttrs(props, module?.props ?? {}, skip)];
  if (piece.when !== undefined) attrs.push(`when={${piece.when}}`);
  if (piece.fallback !== undefined) attrs.push(attrText("fallback", typeof piece.fallback === "string" ? piece.fallback : piece.fallback.text));
  attrs.push(...eventAttrs(piece.on));
  const kids = piece.children ?? [];
  if (inner !== undefined) {
    const head: string[] = [];
    tag(indent, piece.type, attrs, ">", head);
    if (head.length === 1) { out.push(`${head[0]}${inner}</${piece.type}>`); return; }
    out.push(...head, `${indent}  ${inner}`, `${indent}</${piece.type}>`);
    return;
  }
  if (block !== undefined) {
    tag(indent, piece.type, attrs, ">", out);
    out.push(...block.map(l => (l === "" ? "" : `${indent}  ${l}`)), `${indent}</${piece.type}>`);
    return;
  }
  if (items.length === 0 && kids.length === 0) { tag(indent, piece.type, attrs, " />", out); return; }
  tag(indent, piece.type, attrs, ">", out);
  for (const [kind, spec] of items) {
    for (const item of props[spec.prop] as SlatePropValue[]) {
      const rec = (item ?? {}) as Record<string, SlatePropValue>;
      const itemAttrs = propAttrs(rec, spec.fields, new Set(["on", "when"]));
      if (typeof rec.when === "string") itemAttrs.push(`when={${rec.when}}`);
      itemAttrs.push(...eventAttrs(rec.on as SlatePiece["on"]));
      tag(`${indent}  `, kind, itemAttrs, " />", out);
    }
  }
  for (const child of kids) printPiece(doc, child, depth + 1, out, seen);
  out.push(`${indent}</${piece.type}>`);
}

/** The document in the JSX-like form: the <slate> frame with title and state, then the root's subtree, every id written. */
export function printSlateJsx(doc: Slate): string {
  const frame: string[] = [];
  if (doc.title !== undefined) frame.push(attrText("title", doc.title));
  if (doc.state !== undefined && Object.keys(doc.state).length > 0) frame.push(`state={${js(doc.state as SlatePropValue)}}`);
  const out: string[] = [];
  tag("", "slate", frame, ">", out);
  const seen = new Set<string>();
  printPiece(doc, doc.root, 1, out, seen);
  for (const id of Object.keys(doc.pieces)) if (!seen.has(id)) printPiece(doc, id, 1, out, seen);
  out.push("</slate>");
  return `${out.join("\n")}\n`;
}
