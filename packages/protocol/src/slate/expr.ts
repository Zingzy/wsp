// SPDX-License-Identifier: AGPL-3.0-only
// The slate's formula language (04-expressions): paths, literals, templates, arithmetic, comparison, logic, a choice,
// named functions, a field read after any of them, and a pipeline of list steps. No loops, no assignment, no road
// from a string to code. One parser, one checker and one evaluator, which the host runs for the batch, reads and
// events and the renderer runs to draw, so a value never reads two ways.
import { fmtBytes, fmtClock, fmtCost, fmtDuration, fmtTokens } from "../format.js";
import { CHECK_STATE_WORDS } from "../pull-request.js";
import { SLATE_LIMITS } from "./limits.js";
import { slateEqual, slateStep } from "./paths.js";
import { nearest, slateProblem, type SlateCode } from "./problems.js";
import { isSlateBinding, isSlateFormat, type SlateJson, type SlateProblem, type SlatePropValue } from "./types.js";

type Val = SlateJson | undefined;

export type SlateBinOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";
export interface SlatePipeStepNode { name: string; args: { name?: string; expr: SlateExpr }[]; at: number }
export type SlateTemplatePart = string | { expr: SlateExpr; src: string; at: number };

/** A parsed expression. at is the 0-based offset of the node in its source. */
export type SlateExpr =
  | { k: "lit"; v: SlateJson; at: number }
  | { k: "path"; head: string; own: boolean; segs: (string | number)[]; at: number }
  | { k: "field"; of: SlateExpr; name: string | number; at: number }
  | { k: "call"; name: string; args: SlateExpr[]; at: number }
  | { k: "neg"; arg: SlateExpr; at: number }
  | { k: "not"; arg: SlateExpr; at: number }
  | { k: "bin"; op: SlateBinOp; left: SlateExpr; right: SlateExpr; at: number }
  | { k: "cond"; test: SlateExpr; then: SlateExpr; else: SlateExpr; at: number }
  | { k: "tpl"; parts: SlateTemplatePart[]; at: number }
  | { k: "pipe"; head: SlateExpr; steps: SlatePipeStepNode[]; at: number };

/** What an expression reads its paths through. resolve answers undefined for data that has not arrived. item and
 * index are the row scope of a repeating piece or a step; now stands in for time.now where resolve has none. */
export interface SlateEvalContext {
  resolve(path: string): SlateJson | undefined;
  item?: SlateJson;
  index?: number;
  now?: number;
}

const COMPARE = new Set(["==", "!=", "<", "<=", ">", ">="]);
const RESERVED = new Set(["and", "or", "not", "true", "false", "null"]);

/** The handler step kinds, which an expression may not call. */
const HANDLER_STEPS = new Set(["set", "toggle", "start", "cancel", "send", "steer", "queue", "fill", "open", "copy", "pane"]);

interface Token { t: "num" | "str" | "tpl" | "own" | "name" | "op" | "end"; v: string; parts?: (string | { src: string; at: number })[]; at: number }

class Fault extends Error {
  constructor(readonly code: SlateCode, message: string, readonly at: number, readonly fix?: string) { super(message); }
}

/** JavaScript method names a model writes by reflex, with this language's spelling. */
const METHOD_FIX: Record<string, string> = {
  length: "len(x)", map: "x | map(name: item.field) or pluck(x, 'field')", filter: "x | where(item.cond)", toUpperCase: "upper(x)",
  toLowerCase: "lower(x)", includes: "contains(x, v)", join: "join(x, sep)", slice: "x | take(n)", find: "x | where(...) | first",
  some: "len(x | where(...)) > 0", trim: "trim(x)", split: "split(x, sep)", replace: "replace(x, a, b)", startsWith: "startsWith(x, p)",
  endsWith: "endsWith(x, p)", reduce: "x | sum(item.field)", sort: "x | sortBy(item.field)", toString: "str(x)", toFixed: "number(x, places)",
  test: "contains, startsWith or endsWith; there are no regular expressions", forEach: "a piece that takes items",
};

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    const at = i;
    if (/[0-9]/.test(c)) {
      const m = /^\d+(?:\.\d+)?(?:[eE]-?\d+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: m[0], at });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      let s = "";
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\" && i + 1 < src.length) { const n = src[i + 1]!; s += n === "n" ? "\n" : n === "t" ? "\t" : n; i += 2; continue; }
        s += src[i];
        i++;
      }
      if (i >= src.length) throw new Fault("X400", `a string opened at column ${at + 1} never closes`, at);
      i++;
      out.push({ t: "str", v: s, at });
      continue;
    }
    if (c === "`") {
      const parts: (string | { src: string; at: number })[] = [];
      let lit = "";
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src.startsWith("$${", i)) { lit += "${"; i += 3; continue; }
        if (src.startsWith("${", i)) {
          const start = i + 2;
          const end = closingBrace(src, start);
          if (end < 0) throw new Fault("X400", `a \${ at column ${i + 1} never closes`, i);
          if (lit !== "") parts.push(lit);
          lit = "";
          parts.push({ src: src.slice(start, end), at: start });
          i = end + 1;
          continue;
        }
        lit += src[i];
        i++;
      }
      if (i >= src.length) throw new Fault("X400", `a template opened at column ${at + 1} never closes`, at);
      if (lit !== "") parts.push(lit);
      i++;
      out.push({ t: "tpl", v: "`", parts, at });
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (m === null) throw new Fault("X400", `$ at column ${at + 1} must be followed by a name`, at);
      out.push({ t: "own", v: m[0].slice(1), at });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "name", v: m[0], at });
      i += m[0].length;
      continue;
    }
    if (src.startsWith("...", i)) throw new Fault("X420", "no spreads here; a list is reshaped with steps", at);
    const three = src.slice(i, i + 3);
    if (three === "===" || three === "!==") { out.push({ t: "op", v: three.slice(0, 2), at }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (two === "=>") throw new Fault("X420", "no functions here; a list is reshaped with steps", at, "items | map(name: item.name) or pluck(items, 'name')");
    if (two === "??") throw new Fault("X420", "?? is not an operator here", at, "orElse(a, b)");
    if (two === "?.") throw new Fault("X420", "?. is not needed: a missing field reads as null", at, "a.b");
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      out.push({ t: "op", v: two === "&&" ? "and" : two === "||" ? "or" : two, at });
      i += 2;
      continue;
    }
    if (c === "!") { out.push({ t: "op", v: "not", at }); i++; continue; }
    if ("()[],.?:+-*/%<>|{}".includes(c)) { out.push({ t: "op", v: c, at }); i++; continue; }
    if (c === "=") throw new Fault("X420", "compare with ==; to write a value use set($x, 1) in a handler", at, "==");
    throw new Fault("X400", `"${c}" is not part of an expression (column ${at + 1})`, at);
  }
  out.push({ t: "end", v: "", at: src.length });
  return out;
}

/** The index of the } closing a ${ whose body starts at start, quotes and nested braces skipped; -1 when none. */
export function closingBrace(src: string, start: number): number {
  let depth = 1;
  let quote: string | undefined;
  for (let j = start; j < src.length; j++) {
    const ch = src[j]!;
    if (quote !== undefined) { if (ch === "\\") j++; else if (ch === quote) quote = undefined; }
    else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return j;
  }
  return -1;
}

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private readonly toks: Token[], private readonly base: number) {}

  private peek(n = 0): Token { return this.toks[Math.min(this.i + n, this.toks.length - 1)]!; }
  private next(): Token { return this.toks[this.i++]!; }
  private isOp(v: string): boolean { const t = this.peek(); return t.t === "op" && t.v === v; }
  private isWord(v: string): boolean { const t = this.peek(); return t.t === "name" && t.v === v; }
  private expect(v: string): void {
    const t = this.peek();
    if (t.t !== "op" || t.v !== v) throw new Fault("X400", `expected ${v} at column ${t.at + 1}${t.t === "end" ? ", the expression ended" : ""}`, t.at);
    this.i++;
  }
  private enter(at: number): void {
    if (++this.depth > SLATE_LIMITS.exprDepth) throw new Fault("X407", `nesting is deeper than ${SLATE_LIMITS.exprDepth}`, at);
  }

  parseAll(): SlateExpr {
    const e = this.pipeline();
    const t = this.peek();
    if (t.t !== "end") {
      if (t.t === "op" && t.v === "=") throw new Fault("X420", "compare with ==", t.at, "==");
      throw new Fault("X400", `unexpected ${t.v || "text"} at column ${t.at + 1}`, t.at);
    }
    return e;
  }

  pipeline(): SlateExpr {
    const at = this.peek().at;
    const head = this.expression();
    const steps: SlatePipeStepNode[] = [];
    while (this.isOp("|")) {
      this.next();
      const name = this.next();
      if (name.t !== "name") throw new Fault("Q420", `expected a step after | at column ${name.at + 1}`, name.at);
      const spec = PIPE[name.v];
      if (spec === undefined) {
        const fix = name.v === "filter" ? "where" : name.v === "sort" || name.v === "orderBy" ? "sortBy" : name.v === "limit" ? "take" : nearest(name.v, Object.keys(PIPE));
        const fn = name.v in F ? `; ${name.v} is a function, not a step: ${name.v === "pluck" ? "pick(name) or pluck(list, 'name')" : `${name.v}(list, ...)`}` : "";
        throw new Fault("Q422", `${name.v} is not a step${fix !== undefined ? `; did you mean ${fix}?` : fn}`, name.at, fix ?? (name.v === "pluck" ? "pick(name) or pluck(list, 'name')" : undefined));
      }
      const args: { name?: string; expr: SlateExpr }[] = [];
      if (this.isOp("(")) {
        this.next();
        if (!this.isOp(")")) {
          for (;;) {
            let argName: string | undefined;
            if (this.peek().t === "name" && this.peek(1).t === "op" && this.peek(1).v === ":") { argName = this.next().v; this.next(); }
            args.push(argName !== undefined ? { name: argName, expr: this.pipeline() } : { expr: this.pipeline() });
            if (this.isOp(",")) { this.next(); continue; }
            break;
          }
        }
        this.expect(")");
      }
      if (args.length < spec.min || args.length > spec.max) {
        throw new Fault("Q423", `${name.v} takes ${spec.min === spec.max ? spec.min : spec.max >= 99 ? `at least ${spec.min}` : `${spec.min} to ${spec.max}`} argument${spec.max === 1 ? "" : "s"}, got ${args.length}: ${spec.sig}`, name.at, spec.sig);
      }
      if ((name.v === "take" || name.v === "skip") && !(args[0]!.expr.k === "lit" && Number.isInteger(args[0]!.expr.v))) throw new Fault("Q425", `${name.v}'s count is a literal integer`, name.at, `${name.v}(5)`);
      if (name.v === "pick") for (const a of args) if (!(a.expr.k === "path" && !a.expr.own && a.expr.segs.length === 0)) throw new Fault("Q423", "pick takes bare field names: pick(name, state)", name.at);
      if (name.v === "map") for (const a of args) if (a.name === undefined) throw new Fault("Q423", "map takes named arguments: map(name: item.title)", name.at);
      if (name.v !== "map" && args.some(a => a.name !== undefined)) throw new Fault("Q423", `${name.v} takes no named arguments; only map does`, name.at);
      steps.push({ name: name.v, args, at: name.at + this.base });
    }
    if (steps.length > SLATE_LIMITS.pipelineSteps) throw new Fault("Q426", `${steps.length} steps; the most is ${SLATE_LIMITS.pipelineSteps}`, at);
    return steps.length === 0 ? head : { k: "pipe", head, steps, at: at + this.base };
  }

  private expression(): SlateExpr {
    const at = this.peek().at;
    this.enter(at);
    const test = this.or();
    let out = test;
    if (this.isOp("?")) {
      this.next();
      const then = this.expression();
      this.expect(":");
      const other = this.expression();
      out = { k: "cond", test, then, else: other, at: at + this.base };
    }
    this.depth--;
    return out;
  }
  private or(): SlateExpr {
    let left = this.and();
    while (this.isWord("or") || this.isOp("or")) { const at = this.next().at; left = { k: "bin", op: "or", left, right: this.and(), at: at + this.base }; }
    return left;
  }
  private and(): SlateExpr {
    let left = this.not();
    while (this.isWord("and") || this.isOp("and")) { const at = this.next().at; left = { k: "bin", op: "and", left, right: this.not(), at: at + this.base }; }
    return left;
  }
  private not(): SlateExpr {
    if (this.isWord("not") || this.isOp("not")) {
      const at = this.next().at;
      this.enter(at);
      const arg = this.not();
      this.depth--;
      return { k: "not", arg, at: at + this.base };
    }
    return this.compare();
  }
  private compare(): SlateExpr {
    const left = this.sum();
    const t = this.peek();
    if (t.t === "op" && COMPARE.has(t.v)) {
      this.next();
      const right = this.sum();
      const after = this.peek();
      if (after.t === "op" && COMPARE.has(after.v)) throw new Fault("X400", "comparisons do not chain; write a < b and b < c", after.at, "a < b and b < c");
      return { k: "bin", op: t.v as SlateBinOp, left, right, at: t.at + this.base };
    }
    return left;
  }
  private sum(): SlateExpr {
    let left = this.product();
    while (this.isOp("+") || this.isOp("-")) { const t = this.next(); left = { k: "bin", op: t.v as SlateBinOp, left, right: this.product(), at: t.at + this.base }; }
    return left;
  }
  private product(): SlateExpr {
    let left = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) { const t = this.next(); left = { k: "bin", op: t.v as SlateBinOp, left, right: this.unary(), at: t.at + this.base }; }
    return left;
  }
  private unary(): SlateExpr {
    if (this.isOp("-")) {
      const at = this.next().at;
      this.enter(at);
      const arg = this.unary();
      this.depth--;
      return { k: "neg", arg, at: at + this.base };
    }
    return this.postfix();
  }
  private postfix(): SlateExpr {
    let node = this.primary();
    for (;;) {
      if (this.isOp(".")) {
        this.next();
        const n = this.next();
        if (n.t !== "name") throw new Fault("X400", `expected a name after . at column ${n.at + 1}`, n.at);
        if (this.isOp("(")) {
          const fix = METHOD_FIX[n.v];
          throw new Fault("X420", n.v === "test" ? "no regular expressions; use contains, startsWith or endsWith" : `no method calls; ${fix !== undefined ? `use ${fix}` : "use a function or a step"}`, n.at, fix);
        }
        if (n.v === "length") throw new Fault("X420", "length is not a field; use len()", n.at, "len(x)");
        node = node.k === "path" ? { ...node, segs: [...node.segs, n.v] } : { k: "field", of: node, name: n.v, at: n.at + this.base };
        continue;
      }
      if (this.isOp("[")) {
        this.next();
        let sign = 1;
        if (this.isOp("-")) { this.next(); sign = -1; }
        const n = this.next();
        if (n.t !== "num" || !/^\d+$/.test(n.v)) throw new Fault("X400", `an index is a whole number, at column ${n.at + 1}`, n.at);
        this.expect("]");
        const index = sign * Number(n.v);
        node = node.k === "path" ? { ...node, segs: [...node.segs, index] } : { k: "field", of: node, name: index, at: n.at + this.base };
        continue;
      }
      break;
    }
    return node;
  }
  private primary(): SlateExpr {
    const t = this.next();
    const at = t.at + this.base;
    if (t.t === "num") return { k: "lit", v: Number(t.v), at };
    if (t.t === "str") return { k: "lit", v: t.v, at };
    if (t.t === "tpl") {
      const parts: SlateTemplatePart[] = [];
      for (const p of t.parts ?? []) {
        if (typeof p === "string") { parts.push(p); continue; }
        const inner = parseAt(p.src, this.base + p.at);
        parts.push({ expr: inner, src: p.src.trim(), at: this.base + p.at });
      }
      const holes = parts.filter(p => typeof p !== "string").length;
      if (holes > SLATE_LIMITS.holes) throw new Fault("X407", `${holes} holes in one template; the most is ${SLATE_LIMITS.holes}`, t.at);
      return { k: "tpl", parts, at };
    }
    if (t.t === "own") return { k: "path", head: t.v, own: true, segs: [], at };
    if (t.t === "op" && t.v === "(") {
      this.enter(t.at);
      const e = this.pipeline();
      this.depth--;
      this.expect(")");
      return e;
    }
    if (t.t === "op" && t.v === "[") throw new Fault("X420", "a list literal stands only as a whole attribute, like start={[1, 2]}", t.at);
    if (t.t === "op" && t.v === "{") throw new Fault("X420", "a record literal stands only as a whole attribute, like start={{ a: 1 }}", t.at);
    if (t.t === "op" && t.v === "/") throw new Fault("X420", "no regular expressions; use contains, startsWith or endsWith", t.at);
    if (t.t === "name") {
      if (t.v === "true" || t.v === "false") return { k: "lit", v: t.v === "true", at };
      if (t.v === "null" || t.v === "undefined") return { k: "lit", v: null, at };
      if (RESERVED.has(t.v)) throw new Fault("X400", `${t.v} cannot start a value (column ${t.at + 1})`, t.at);
      if (this.isOp("(")) {
        this.next();
        const args: SlateExpr[] = [];
        if (!this.isOp(")")) {
          for (;;) {
            args.push(this.pipeline());
            if (this.isOp(",")) { this.next(); continue; }
            break;
          }
        }
        this.expect(")");
        return { k: "call", name: t.v, args, at };
      }
      return { k: "path", head: t.v, own: false, segs: [], at };
    }
    throw new Fault("X400", t.t === "end" ? "the expression ended early" : `unexpected ${t.v} at column ${t.at + 1}`, t.at);
  }
}

function parseAt(src: string, base: number): SlateExpr {
  if (src.trim() === "") throw new Fault("X400", "a hole is empty", 0);
  return new Parser(tokenize(src), base).parseAll();
}

const parsed = new Map<string, { ast?: SlateExpr; errors: SlateProblem[] }>();

/** The syntax tree of an expression or the first error, cached by source. Positions are offsets into src. */
export function parseSlateExpression(src: string): { ast?: SlateExpr; errors: SlateProblem[] } {
  const hit = parsed.get(src);
  if (hit !== undefined) return hit;
  let out: { ast?: SlateExpr; errors: SlateProblem[] };
  if (src.length > SLATE_LIMITS.exprChars) out = { errors: [slateProblem("X407", `the expression is ${src.length} characters; the most is ${SLATE_LIMITS.exprChars}`)] };
  else if (src.trim() === "") out = { errors: [slateProblem("X400", "the expression is empty", { at: 0 })] };
  else {
    try {
      out = { ast: parseAt(src, 0), errors: [] };
    } catch (e) {
      if (!(e instanceof Fault)) throw e;
      out = { errors: [slateProblem(e.code, e.message, { at: e.at, fix: e.fix })] };
    }
  }
  if (parsed.size > 4_000) parsed.clear();
  parsed.set(src, out);
  return out;
}

/** The text of a path as dependency sets and resolvers name it: "pr.checks[0].name", "$check.json". */
export function slatePathText(head: string, own: boolean, segs: readonly (string | number)[]): string {
  return (own ? `$${head}` : head) + segs.map(s => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("");
}

// ---- format strings ----

export type SlateFormatPart = string | { expr: string; at: number };

/** A format string's literal runs and its ${...} holes; "$${" is a literal "${". */
export function parseSlateFormat(src: string): { parts: SlateFormatPart[]; errors: SlateProblem[] } {
  const parts: SlateFormatPart[] = [];
  let lit = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("$${", i)) { lit += "${"; i += 3; continue; }
    if (src.startsWith("${", i)) {
      const start = i + 2;
      const end = closingBrace(src, start);
      if (end < 0) return { parts, errors: [slateProblem("X400", `a \${ at column ${i + 1} never closes`, { at: i })] };
      if (lit !== "") parts.push(lit);
      lit = "";
      parts.push({ expr: src.slice(start, end), at: start });
      i = end + 1;
      continue;
    }
    lit += src[i];
    i++;
  }
  if (lit !== "") parts.push(lit);
  const holes = parts.filter(p => typeof p !== "string").length;
  return { parts, errors: holes > SLATE_LIMITS.holes ? [slateProblem("X407", `${holes} holes in one text; the most is ${SLATE_LIMITS.holes}`)] : [] };
}

// ---- values ----

const isNum = (v: Val): v is number => typeof v === "number" && Number.isFinite(v);
const isList = (v: Val): v is SlateJson[] => Array.isArray(v);
const isRecord = (v: Val): v is { [key: string]: SlateJson } => typeof v === "object" && v !== null && !Array.isArray(v);
const missing = (v: Val): v is null | undefined => v === null || v === undefined;
const finite = (n: number): number | null => (Number.isFinite(n) ? n : null);

export function slateTruthy(v: Val): boolean {
  if (missing(v) || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** A value as a format hole and str() write it: nothing for null, JSON for a list or record. */
export function slateText(v: Val): string {
  if (missing(v)) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** A time as ms: a number is ms epoch, an ISO string is parsed. */
function ms(v: Val): number | null {
  if (isNum(v)) return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

function places(v: Val, fallback: number): number {
  return isNum(v) ? Math.max(0, Math.min(6, Math.round(v))) : fallback;
}

/** "3d 7h", "3h 24m", "12m 4s", "40s": the two largest units. */
function span(msLeft: number, two = true): string {
  const s = Math.max(0, Math.round(msLeft / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  if (d > 0) return two && h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return two && m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return two && sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

const plainNumber = (n: number, p?: number): string =>
  n.toLocaleString("en-US", p === undefined ? { maximumFractionDigits: 2 } : { minimumFractionDigits: p, maximumFractionDigits: p });

/** The app's own word for a known state (04, word()): check states, thread statuses, review and mergeable enums,
 * run states; any other string capitalised once. */
const WORDS: Record<string, string> = {
  ...CHECK_STATE_WORDS,
  starting: "Starting", working: "Working", "needs-you": "Needs you", resting: "Resting", done: "Done", failed: "Failed",
  none: "None", approved: "Approved", changes_asked: "Changes asked", required: "Review required",
  mergeable: "Mergeable", conflicting: "Conflicting", unknown: "Unknown",
  idle: "Not run yet", held: "Held", running: "Running",
  open: "Open", merged: "Merged", closed: "Closed",
};
export function slateWord(x: Val): Val {
  if (typeof x !== "string") return missing(x) ? null : slateText(x);
  const known = WORDS[x];
  if (known !== undefined) return known;
  const spaced = x.replace(/[_-]+/g, " ").trim();
  return spaced === "" ? "" : spaced[0]!.toUpperCase() + spaced.slice(1);
}

// ---- functions ----

export type SlateTypeName = "number" | "string" | "boolean" | "null" | "list" | "record" | "any";
/** A type as the checker knows it: a name, and where known a list's element or a record's fields. */
export interface SlateType { t: SlateTypeName; of?: SlateType; fields?: Record<string, SlateType> }
const T = {
  any: { t: "any" } as SlateType, num: { t: "number" } as SlateType, str: { t: "string" } as SlateType, bool: { t: "boolean" } as SlateType,
  nul: { t: "null" } as SlateType, list: { t: "list" } as SlateType, rec: { t: "record" } as SlateType,
};

interface Env {
  ctx: SlateEvalContext;
  steps: number;
  charge(n: number): void;
  now(): number | null;
}

type Fn = (args: Val[], env: Env) => Val;
interface FnSpec {
  min: number; max: number; sig: string; example: string; fn: Fn;
  returns(args: SlateType[]): SlateType;
  /** Takes a missing value and answers for it. */
  nullSafe?: true;
  /** The first argument is a number, held where its type is known. */
  numberFirst?: true;
  /** The first argument is a list, held where its type is known. */
  listFirst?: true;
  /** Reads the clock: its dependency set holds time.now. */
  clock?: true;
}

function listOrArgs(args: Val[]): SlateJson[] {
  return args.length === 1 && isList(args[0]) ? args[0] : args.map(a => a ?? null);
}

function field(item: Val, name: Val): Val {
  return typeof name === "string" ? slateStep(item, name) : item;
}

function numbersOf(env: Env, list: Val, name: Val): number[] {
  if (!isList(list)) return [];
  const out: number[] = [];
  for (const item of list) {
    env.charge(1);
    const v = name === undefined ? item : field(item, name);
    if (isNum(v)) out.push(v);
  }
  return out;
}

const ret = (t: SlateType) => (): SlateType => t;
const elemOf = (args: SlateType[]): SlateType => args[0]?.of ?? T.any;

const F: Record<string, FnSpec> = {
  percent: { min: 1, max: 2, returns: ret(T.str), numberFirst: true, sig: "percent(fraction, places?)", example: "percent(thread.context.used / thread.context.window)",
    fn: ([x, p]) => { if (!isNum(x)) return null; const v = x * 100; return `${v.toFixed(places(p, Math.abs(v) < 10 && v !== 0 ? 1 : 0))}%`; } },
  pct: { min: 1, max: 2, returns: ret(T.str), numberFirst: true, sig: "pct(points, places?)", example: "pct(usage.week.percent)",
    fn: ([x, p]) => (isNum(x) ? `${x.toFixed(places(p, 0))}%` : null) },
  tokens: { min: 1, max: 1, returns: ret(T.str), numberFirst: true, sig: "tokens(n)", example: "tokens(thread.context.free)", fn: ([x]) => (isNum(x) ? fmtTokens(x) : null) },
  bytes: { min: 1, max: 1, returns: ret(T.str), numberFirst: true, sig: "bytes(n)", example: "bytes(machine.mem.used)", fn: ([x]) => (isNum(x) ? fmtBytes(x) : null) },
  usd: { min: 1, max: 2, returns: ret(T.str), numberFirst: true, sig: "usd(n, places?)", example: "usd(thread.cost.usd)",
    fn: ([x, p]) => (!isNum(x) ? null : p === undefined ? fmtCost(x) : `$${plainNumber(x, places(p, 2))}`) },
  number: { min: 1, max: 2, returns: ret(T.str), numberFirst: true, sig: "number(x, places?)", example: "number(machine.load1, 2)",
    fn: ([x, p]) => (isNum(x) ? plainNumber(x, p === undefined ? undefined : places(p, 0)) : null) },
  duration: { min: 1, max: 2, returns: ret(T.str), numberFirst: true, sig: "duration(ms, style?)", example: "duration(thread.lastTurn.durationMs)",
    fn: ([x, style]) => (isNum(x) ? fmtDuration(x, style === "clock" ? "clock" : "short") : null) },
  ago: { min: 1, max: 1, returns: ret(T.str), clock: true, sig: "ago(t)", example: "ago(pr.readAt)",
    fn: ([t], env) => { const at = ms(t); const now = env.now(); return at === null || now === null ? null : span(now - at, false); } },
  until: { min: 1, max: 1, returns: ret(T.str), clock: true, sig: "until(t)", example: "until(usage.week.resetsAt)",
    fn: ([t], env) => { const at = ms(t); const now = env.now(); return at === null || now === null ? null : at <= now ? "now" : `in ${span(at - now)}`; } },
  date: { min: 1, max: 2, returns: ret(T.str), sig: "date(t, style?)", example: "date(usage.week.resetsAt)",
    fn: ([t, style]) => {
      const at = ms(t);
      if (at === null) return null;
      return style === "long"
        ? new Date(at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(",", "")
        : new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
    } },
  time: { min: 1, max: 1, returns: ret(T.str), sig: "time(t)", example: "time(usage.session.resetsAt)", fn: ([t]) => { const at = ms(t); return at === null ? null : fmtClock(at).slice(0, 5); } },
  weekday: { min: 1, max: 1, returns: ret(T.str), sig: "weekday(t)", example: "weekday(usage.week.resetsAt)",
    fn: ([t]) => { const at = ms(t); return at === null ? null : new Date(at).toLocaleDateString("en-GB", { weekday: "long" }); } },
  plural: { min: 2, max: 3, returns: ret(T.str), numberFirst: true, sig: "plural(n, one, many?)", example: "plural(len(pr.checks), 'check')",
    fn: ([n, one, many]) => (isNum(n) && typeof one === "string" ? `${plainNumber(n)} ${n === 1 ? one : typeof many === "string" ? many : `${one}s`}` : null) },
  word: { min: 1, max: 1, returns: ret(T.str), sig: "word(x)", example: "word(item.state)", fn: ([x]) => slateWord(x) },
  upper: { min: 1, max: 1, returns: ret(T.str), sig: "upper(s)", example: "upper(git.branch)", fn: ([s]) => (typeof s === "string" ? s.toUpperCase() : null) },
  lower: { min: 1, max: 1, returns: ret(T.str), sig: "lower(s)", example: "lower(pr.word)", fn: ([s]) => (typeof s === "string" ? s.toLowerCase() : null) },
  trim: { min: 1, max: 1, returns: ret(T.str), sig: "trim(s)", example: "trim($note)", fn: ([s]) => (typeof s === "string" ? s.trim() : null) },
  short: { min: 2, max: 2, returns: ret(T.str), sig: "short(s, n)", example: "short(pr.headSubject, 40)",
    fn: ([s, n]) => (typeof s === "string" && isNum(n) ? (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s) : null) },
  round: { min: 1, max: 2, returns: ret(T.num), numberFirst: true, sig: "round(x, places?)", example: "round(usage.week.percent)",
    fn: ([x, p]) => { if (!isNum(x)) return null; const f = 10 ** places(p, 0); return Math.round(x * f) / f; } },
  floor: { min: 1, max: 1, returns: ret(T.num), numberFirst: true, sig: "floor(x)", example: "floor(thread.context.percent)", fn: ([x]) => (isNum(x) ? Math.floor(x) : null) },
  ceil: { min: 1, max: 1, returns: ret(T.num), numberFirst: true, sig: "ceil(x)", example: "ceil(thread.context.percent)", fn: ([x]) => (isNum(x) ? Math.ceil(x) : null) },
  abs: { min: 1, max: 1, returns: ret(T.num), numberFirst: true, sig: "abs(x)", example: "abs(git.behind)", fn: ([x]) => (isNum(x) ? Math.abs(x) : null) },
  min: { min: 1, max: 99, returns: ret(T.num), nullSafe: true, sig: "min(a, b, ...) or min(list)", example: "min(usage.week.percent, 100)",
    fn: (args, env) => { const ns = numbersOf(env, listOrArgs(args), undefined); return ns.length === 0 ? null : Math.min(...ns); } },
  max: { min: 1, max: 99, returns: ret(T.num), nullSafe: true, sig: "max(a, b, ...) or max(list)", example: "max(0, thread.context.free)",
    fn: (args, env) => { const ns = numbersOf(env, listOrArgs(args), undefined); return ns.length === 0 ? null : Math.max(...ns); } },
  clamp: { min: 3, max: 3, returns: ret(T.num), numberFirst: true, sig: "clamp(x, lo, hi)", example: "clamp(usage.week.percent, 0, 100)",
    fn: ([x, lo, hi]) => (isNum(x) && isNum(lo) && isNum(hi) ? Math.min(hi, Math.max(lo, x)) : null) },
  str: { min: 1, max: 1, returns: ret(T.str), sig: "str(x)", example: "str(pr.number)", fn: ([x]) => (missing(x) ? null : slateText(x)) },
  num: { min: 1, max: 1, returns: ret(T.num), sig: "num(x)", example: "num(item.completedAt)",
    fn: ([x]) => {
      if (isNum(x)) return x;
      if (typeof x === "boolean") return x ? 1 : 0;
      if (typeof x !== "string" || x.trim() === "") return null;
      const n = Number(x);
      if (Number.isFinite(n)) return n;
      return /^\d{4}-\d{2}-\d{2}/.test(x) ? ms(x) : null;
    } },
  bool: { min: 1, max: 1, returns: ret(T.bool), nullSafe: true, sig: "bool(x)", example: "bool($done)", fn: ([x]) => slateTruthy(x) },
  concat: { min: 1, max: 99, returns: ret(T.str), nullSafe: true, sig: "concat(a, b, ...)", example: "concat(git.branch, ' at ', git.head)", fn: args => args.map(slateText).join("") },
  json: { min: 1, max: 1, returns: ret(T.any), sig: "json(s)", example: "json($check.out).title",
    fn: ([s]) => { if (typeof s !== "string") return null; try { return JSON.parse(s) as SlateJson; } catch { return null; } } },
  lines: { min: 1, max: 1, returns: ret({ t: "list", of: T.str }), sig: "lines(s)", example: "lines($tests.out)",
    fn: ([s]) => { if (typeof s !== "string") return null; const out = s.split(/\r?\n/); if (out[out.length - 1] === "") out.pop(); return out.slice(0, SLATE_LIMITS.listItems); } },
  split: { min: 2, max: 2, returns: ret({ t: "list", of: T.str }), sig: "split(s, sep)", example: "split($tags, ',')",
    fn: ([s, sep]) => (typeof s === "string" && typeof sep === "string" ? s.split(sep).slice(0, SLATE_LIMITS.listItems) : null) },
  replace: { min: 3, max: 3, returns: ret(T.str), sig: "replace(s, from, to)", example: "replace(git.branch, '/', ' ')",
    fn: ([s, a, b]) => (typeof s === "string" && typeof a === "string" && a !== "" ? s.split(a).join(slateText(b)) : typeof s === "string" ? s : null) },
  contains: { min: 2, max: 2, returns: ret(T.bool), nullSafe: true, sig: "contains(list or text, value)", example: "contains(pluck(pr.checks, 'state'), 'fail')",
    fn: ([x, v], env) => {
      if (typeof x === "string") return typeof v === "string" ? x.includes(v) : false;
      if (!isList(x)) return false;
      env.charge(x.length);
      return x.some(item => slateEqual(item, v ?? null));
    } },
  startsWith: { min: 2, max: 2, returns: ret(T.bool), nullSafe: true, sig: "startsWith(s, p)", example: "startsWith(git.branch, 'poc/')",
    fn: ([s, p]) => (typeof s === "string" && typeof p === "string" ? s.startsWith(p) : false) },
  endsWith: { min: 2, max: 2, returns: ret(T.bool), nullSafe: true, sig: "endsWith(s, p)", example: "endsWith(item.path, '.ts')",
    fn: ([s, p]) => (typeof s === "string" && typeof p === "string" ? s.endsWith(p) : false) },
  orElse: { min: 2, max: 2, returns: a => (a[0]?.t === "any" || a[0]?.t === "null" ? (a[1] ?? T.any) : (a[0] ?? T.any)), nullSafe: true, sig: "orElse(x, fallback)", example: "orElse(pr.word, 'no pull request')",
    fn: ([x, f]) => (missing(x) ? (f ?? null) : x) },
  exists: { min: 1, max: 1, returns: ret(T.bool), nullSafe: true, sig: "exists(x)", example: "exists(usage.note)", fn: ([x]) => !missing(x) },
  isNull: { min: 1, max: 1, returns: ret(T.bool), nullSafe: true, sig: "isNull(x)", example: "isNull(pr.number)", fn: ([x]) => missing(x) },
  coalesce: { min: 1, max: 99, returns: ret(T.any), nullSafe: true, sig: "coalesce(a, b, ...)", example: "coalesce(pr.headSubject, git.branch)", fn: args => args.find(a => !missing(a)) ?? null },
  if: { min: 3, max: 3, returns: a => merge(a[1] ?? T.any, a[2] ?? T.any), nullSafe: true, sig: "if(cond, a, b)", example: "if(pr.draft, 'Draft', 'Ready')", fn: ([c, a, b]) => (slateTruthy(c) ? a : b) ?? null },
  len: { min: 1, max: 1, returns: ret(T.num), nullSafe: true, sig: "len(x)", example: "len(pr.checks)",
    fn: ([x]) => (isList(x) || typeof x === "string" ? x.length : isRecord(x) ? Object.keys(x).length : 0) },
  count: { min: 1, max: 1, returns: ret(T.num), nullSafe: true, listFirst: true, sig: "count(list)", example: "count(pr.checks)", fn: ([x]) => (isList(x) ? x.length : 0) },
  sum: { min: 1, max: 2, returns: ret(T.num), listFirst: true, sig: "sum(list, field?)", example: "sum(thread.changes.files, 'additions')",
    fn: ([l, f], env) => (isList(l) ? numbersOf(env, l, f).reduce((a, b) => a + b, 0) : null) },
  avg: { min: 1, max: 2, returns: ret(T.num), listFirst: true, sig: "avg(list, field?)", example: "avg(thread.changes.files, 'additions')",
    fn: ([l, f], env) => { const ns = numbersOf(env, l, f); return ns.length === 0 ? null : ns.reduce((a, b) => a + b, 0) / ns.length; } },
  first: { min: 1, max: 1, returns: elemOf, listFirst: true, sig: "first(list)", example: "first(pr.checks).name", fn: ([l]) => (isList(l) ? (l[0] ?? null) : null) },
  last: { min: 1, max: 1, returns: elemOf, listFirst: true, sig: "last(list)", example: "last(thread.plan.steps).text", fn: ([l]) => (isList(l) ? (l[l.length - 1] ?? null) : null) },
  pluck: { min: 2, max: 2, returns: ret(T.list), listFirst: true, sig: "pluck(list, field)", example: "pluck(pr.checks, 'name')",
    fn: ([l, f], env) => (isList(l) && typeof f === "string" ? l.map(item => { env.charge(1); return field(item, f) ?? null; }) : null) },
  join: { min: 2, max: 2, returns: ret(T.str), listFirst: true, sig: "join(list, sep)", example: "join(pluck(pr.checks, 'name'), ', ')",
    fn: ([l, sep], env) => (isList(l) ? l.map(item => { env.charge(1); return slateText(item); }).join(typeof sep === "string" ? sep : ", ") : null) },
};

/** Every function with its signature and an example, for the catalog and the checker. */
export const SLATE_FUNCTIONS: Readonly<Record<string, Readonly<{ min: number; max: number; sig: string; example: string }>>> = F;

// ---- pipeline steps ----

interface PipeSpec {
  min: number; max: number; sig: string; example: string; purpose: string;
  /** Takes a list in; false for format, which takes a single value too. */
  needsList: boolean;
  out(input: SlateType, args: SlateType[]): SlateType;
}

const same = (input: SlateType): SlateType => input;
const PIPE: Record<string, PipeSpec> = {
  where: { min: 1, max: 1, needsList: true, out: same, sig: "where(cond)", purpose: "keeps the elements where cond is true", example: "pr.checks | where(item.state == 'fail')" },
  sortBy: { min: 1, max: 2, needsList: true, out: same, sig: "sortBy(expr, 'asc'|'desc')", purpose: "stable sort; nulls last", example: "processes.list | sortBy(item.cpu, 'desc')" },
  groupBy: { min: 1, max: 1, needsList: true, out: i => ({ t: "list", of: { t: "record", fields: { key: T.any, items: i, count: T.num } } }), sig: "groupBy(expr)", purpose: "{ key, items, count } per group in first-seen order", example: "pr.checks | groupBy(item.state)" },
  take: { min: 1, max: 1, needsList: true, out: same, sig: "take(n)", purpose: "the first n; n is a literal", example: "pr.checks | take(5)" },
  skip: { min: 1, max: 1, needsList: true, out: same, sig: "skip(n)", purpose: "all but the first n", example: "pr.checks | skip(1)" },
  count: { min: 0, max: 0, needsList: true, out: () => T.num, sig: "count", purpose: "the length", example: "$steps | where(item.done) | count" },
  sum: { min: 1, max: 1, needsList: true, out: () => T.num, sig: "sum(expr)", purpose: "the total of expr; nulls skipped", example: "thread.changes.files | sum(item.additions)" },
  min: { min: 1, max: 1, needsList: true, out: () => T.num, sig: "min(expr)", purpose: "the least expr", example: "pr.checks | min(num(item.startedAt))" },
  max: { min: 1, max: 1, needsList: true, out: () => T.num, sig: "max(expr)", purpose: "the greatest expr", example: "processes.list | max(item.cpu)" },
  avg: { min: 1, max: 1, needsList: true, out: () => T.num, sig: "avg(expr)", purpose: "the mean of expr", example: "processes.list | avg(item.mem)" },
  first: { min: 0, max: 0, needsList: true, out: i => i.of ?? T.any, sig: "first", purpose: "the first element or null", example: "thread.plan.steps | where(item.state == 'working') | first" },
  last: { min: 0, max: 0, needsList: true, out: i => i.of ?? T.any, sig: "last", purpose: "the last element or null", example: "thread.plan.steps | last" },
  pick: { min: 1, max: 99, needsList: true, out: () => ({ t: "list", of: T.rec }), sig: "pick(field, ...)", purpose: "keeps the named fields", example: "processes.list | pick(name, cpu)" },
  map: { min: 1, max: 99, needsList: true, out: () => ({ t: "list", of: T.rec }), sig: "map(name: expr, ...)", purpose: "adds or replaces fields", example: "pr.checks | map(took: num(item.completedAt) - num(item.startedAt))" },
  distinct: { min: 0, max: 1, needsList: true, out: same, sig: "distinct(expr?)", purpose: "drops later repeats", example: "pr.checks | distinct(item.workflow)" },
  flatten: { min: 0, max: 1, needsList: true, out: () => T.list, sig: "flatten(field?)", purpose: "joins inner lists", example: "tree.all | flatten(children)" },
  join: { min: 2, max: 3, needsList: true, out: same, sig: "join(other, key, otherKey?)", purpose: "attaches the matching element of other", example: "thread.subagents | join(tree.children, id)" },
  format: { min: 1, max: 1, needsList: false, out: i => (i.t === "list" ? { t: "list", of: T.str } : T.str), sig: "format(expr)", purpose: "expr as text per element", example: "pr.checks | format(`${item.name}: ${word(item.state)}`)" },
};

/** Every pipeline step with its signature, purpose and an example. */
export const SLATE_PIPE_STEPS: Readonly<Record<string, Readonly<{ min: number; max: number; sig: string; purpose: string; example: string }>>> = PIPE;

// ---- evaluation ----

class OverBudget extends Error {}

function makeEnv(ctx: SlateEvalContext): Env {
  const env: Env = {
    ctx,
    steps: 0,
    charge(n) {
      env.steps += n;
      if (env.steps > SLATE_LIMITS.pipelineVisits) throw new OverBudget();
    },
    now() {
      const v = ctx.resolve("time.now");
      return isNum(v) ? v : (ctx.now ?? Date.now());
    },
  };
  return env;
}

const inRow = (ctx: SlateEvalContext): boolean => ctx.item !== undefined || ctx.index !== undefined;

function readPath(node: Extract<SlateExpr, { k: "path" }>, env: Env): Val {
  const { head, segs, own } = node;
  if (!own && (head === "item" || head === "index")) {
    if (!inRow(env.ctx)) return undefined;
    let v: Val = head === "item" ? env.ctx.item : (env.ctx.index ?? null);
    for (const s of segs) v = slateStep(v, s);
    return v;
  }
  // The resolver answers the longest dotted path it knows; the evaluator steps into the rest.
  const firstIndex = segs.findIndex(s => typeof s === "number");
  for (let names = firstIndex === -1 ? segs.length : firstIndex; names >= 0; names--) {
    const v = env.ctx.resolve(slatePathText(head, own, segs.slice(0, names)));
    if (v !== undefined) {
      let out: Val = v;
      for (const s of segs.slice(names)) out = slateStep(out, s);
      return out;
    }
  }
  if (!own && head === "time" && segs.length === 1 && segs[0] === "now") return env.now();
  return undefined;
}

function arith(op: SlateBinOp, a: Val, b: Val): Val {
  if (!isNum(a) || !isNum(b)) return null;
  switch (op) {
    case "+": return finite(a + b);
    case "-": return finite(a - b);
    case "*": return finite(a * b);
    case "/": return b === 0 ? null : finite(a / b);
    default: return b === 0 ? null : finite(a % b);
  }
}

function order(op: SlateBinOp, a: Val, b: Val): Val {
  if (missing(a) || missing(b)) return null;
  if (!((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string"))) return null;
  switch (op) {
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    default: return a >= b;
  }
}

/** Sort order: numbers, then strings, then everything else, then nulls. */
function rank(v: Val): number { return isNum(v) ? 0 : typeof v === "string" ? 1 : missing(v) ? 3 : 2; }
function compareKeys(a: Val, b: Val, desc: boolean): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra === 3 || rb === 3) return ra - rb;
  const base = ra !== rb ? ra - rb : ra === 0 ? (a as number) - (b as number) : ra === 1 ? (a as string).localeCompare(b as string) : 0;
  return desc ? -base : base;
}

function keyText(v: Val): string { return JSON.stringify(v ?? null); }

function fieldName(e: SlateExpr): string | undefined {
  if (e.k === "path" && !e.own && e.segs.length === 0) return e.head;
  if (e.k === "lit" && typeof e.v === "string") return e.v;
  return undefined;
}

function runPipe(node: Extract<SlateExpr, { k: "pipe" }>, env: Env): Val {
  let cur = run(node.head, env);
  for (const step of node.steps) {
    const spec = PIPE[step.name]!;
    if (spec.needsList && !isList(cur)) return null;
    const list = isList(cur) ? cur.slice(0, SLATE_LIMITS.listItems) : [];
    const per = (e: SlateExpr, item: SlateJson, index: number): Val => { env.charge(1); return run(e, { ...env, ctx: { ...env.ctx, item, index } } as Env); };
    const arg = (n: number): SlateExpr => step.args[n]!.expr;
    switch (step.name) {
      case "where": cur = list.filter((item, i) => slateTruthy(per(arg(0), item, i))); break;
      case "sortBy": {
        const desc = step.args[1] !== undefined && run(arg(1), env) === "desc";
        const keyed = list.map((item, i) => ({ item, key: per(arg(0), item, i), i }));
        keyed.sort((a, b) => compareKeys(a.key, b.key, desc) || a.i - b.i);
        cur = keyed.map(k => k.item);
        break;
      }
      case "groupBy": {
        const groups = new Map<string, { key: SlateJson; items: SlateJson[] }>();
        list.forEach((item, i) => {
          const key = per(arg(0), item, i) ?? null;
          const k = keyText(key);
          const g = groups.get(k) ?? groups.set(k, { key, items: [] }).get(k)!;
          g.items.push(item);
        });
        cur = [...groups.values()].map(g => ({ key: g.key, items: g.items, count: g.items.length }));
        break;
      }
      case "take": { const n = run(arg(0), env); cur = isNum(n) ? list.slice(0, Math.max(0, n)) : null; env.charge(list.length); break; }
      case "skip": { const n = run(arg(0), env); cur = isNum(n) ? list.slice(Math.max(0, n)) : null; env.charge(list.length); break; }
      case "count": cur = list.length; break;
      case "sum": case "min": case "max": case "avg": {
        const ns = list.map((item, i) => per(arg(0), item, i)).filter(isNum);
        cur = ns.length === 0 ? (step.name === "sum" ? 0 : null)
          : step.name === "sum" ? ns.reduce((a, b) => a + b, 0)
          : step.name === "min" ? Math.min(...ns)
          : step.name === "max" ? Math.max(...ns)
          : ns.reduce((a, b) => a + b, 0) / ns.length;
        break;
      }
      case "first": cur = list[0] ?? null; break;
      case "last": cur = list[list.length - 1] ?? null; break;
      case "pick": {
        const names = step.args.map(a => fieldName(a.expr)).filter((n): n is string => n !== undefined);
        cur = list.map(item => { env.charge(1); return isRecord(item) ? Object.fromEntries(names.filter(n => Object.prototype.hasOwnProperty.call(item, n)).map(n => [n, item[n]!])) : null; });
        break;
      }
      case "map": {
        cur = list.map((item, i) => {
          const base: Record<string, SlateJson> = isRecord(item) ? { ...item } : { value: item };
          for (const a of step.args) base[a.name!] = per(a.expr, item, i) ?? null;
          return base;
        });
        break;
      }
      case "distinct": {
        const seen = new Set<string>();
        cur = list.filter((item, i) => { const k = keyText(step.args[0] !== undefined ? per(arg(0), item, i) : item); if (seen.has(k)) return false; seen.add(k); return true; });
        break;
      }
      case "flatten": {
        const name = step.args[0] !== undefined ? fieldName(arg(0)) : undefined;
        const out: SlateJson[] = [];
        for (const item of list) {
          const inner = name !== undefined ? slateStep(item, name) : item;
          if (isList(inner)) { env.charge(inner.length); out.push(...inner); }
        }
        cur = out.slice(0, SLATE_LIMITS.listItems);
        break;
      }
      case "join": {
        const otherExpr = arg(0);
        const other = run(otherExpr, env);
        const key = fieldName(arg(1));
        const otherKey = step.args[2] !== undefined ? fieldName(arg(2)) : key;
        const under = otherExpr.k === "path" ? String(otherExpr.segs.filter(s => typeof s === "string").at(-1) ?? otherExpr.head) : "other";
        const pool = isList(other) ? other : [];
        env.charge(pool.length);
        cur = list.map(item => {
          env.charge(1);
          const mine = key !== undefined ? slateStep(item, key) : undefined;
          const hit = pool.find(o => otherKey !== undefined && slateEqual(slateStep(o, otherKey), mine ?? null)) ?? null;
          return isRecord(item) ? { ...item, [under]: hit } : { value: item, [under]: hit };
        });
        break;
      }
      case "format": cur = isList(cur) ? list.map((item, i) => slateText(per(arg(0), item, i))) : slateText(per(arg(0), cur ?? null, 0)); break;
    }
  }
  return cur;
}

function run(node: SlateExpr, env: Env): Val {
  env.charge(1);
  switch (node.k) {
    case "lit": return node.v;
    case "path": return readPath(node, env);
    case "field": return slateStep(run(node.of, env), node.name);
    case "neg": { const v = run(node.arg, env); return isNum(v) ? -v : null; }
    case "not": return !slateTruthy(run(node.arg, env));
    case "cond": return slateTruthy(run(node.test, env)) ? run(node.then, env) : run(node.else, env);
    case "tpl": return node.parts.map(p => (typeof p === "string" ? p : slateText(run(p.expr, env)))).join("");
    case "pipe": return runPipe(node, env);
    case "bin": {
      if (node.op === "and") { const l = run(node.left, env); return slateTruthy(l) ? run(node.right, env) : l; }
      if (node.op === "or") { const l = run(node.left, env); return slateTruthy(l) ? l : run(node.right, env); }
      const l = run(node.left, env);
      const r = run(node.right, env);
      if (node.op === "==") return slateEqual(l ?? null, r ?? null);
      if (node.op === "!=") return !slateEqual(l ?? null, r ?? null);
      if (COMPARE.has(node.op)) return order(node.op, l, r);
      return arith(node.op, l, r);
    }
    case "call": {
      const spec = F[node.name];
      if (spec === undefined || node.args.length < spec.min || node.args.length > spec.max) return null;
      const args = node.args.map(a => run(a, env));
      if (spec.nullSafe !== true && missing(args[0])) return null;
      return spec.fn(args, env);
    }
  }
}

/** The value of an expression; null where it fails, undefined where a bare path's data has not arrived. Never throws. */
export function evaluateSlateExpression(expr: string | SlateExpr, ctx: SlateEvalContext): SlateJson | undefined {
  const ast = typeof expr === "string" ? parseSlateExpression(expr).ast : expr;
  if (ast === undefined) return null;
  try {
    const v = run(ast, makeEnv(ctx));
    return typeof v === "number" && !Number.isFinite(v) ? null : v;
  } catch (e) {
    if (e instanceof OverBudget || e instanceof RangeError) return null;
    throw e;
  }
}

/** A format string's text: each hole's value as text, nothing for a null. */
export function evaluateSlateFormat(src: string, ctx: SlateEvalContext): string {
  return parseSlateFormat(src).parts.map(p => (typeof p === "string" ? p : slateText(evaluateSlateExpression(p.expr, ctx)))).join("");
}

/** A prop's value: a literal as written, a binding evaluated, a format filled, lists and records through. */
export function resolveSlateProp(value: SlatePropValue, ctx: SlateEvalContext): SlateJson | undefined {
  if (value === null || typeof value !== "object") return value;
  if (isSlateBinding(value)) return evaluateSlateExpression(value.bind, ctx);
  if (isSlateFormat(value)) return evaluateSlateFormat(value.format, ctx);
  if (Array.isArray(value)) return value.map(v => resolveSlateProp(v, ctx) ?? null);
  const out: Record<string, SlateJson> = {};
  for (const [k, v] of Object.entries(value)) out[k] = resolveSlateProp(v, ctx) ?? null;
  return out;
}

// ---- dependencies ----

/** Every node, depth first. */
export function walkSlateExpr(node: SlateExpr, visit: (n: SlateExpr) => void): void {
  visit(node);
  switch (node.k) {
    case "neg": case "not": walkSlateExpr(node.arg, visit); break;
    case "field": walkSlateExpr(node.of, visit); break;
    case "bin": walkSlateExpr(node.left, visit); walkSlateExpr(node.right, visit); break;
    case "cond": walkSlateExpr(node.test, visit); walkSlateExpr(node.then, visit); walkSlateExpr(node.else, visit); break;
    case "call": for (const a of node.args) walkSlateExpr(a, visit); break;
    case "tpl": for (const p of node.parts) if (typeof p !== "string") walkSlateExpr(p.expr, visit); break;
    case "pipe":
      walkSlateExpr(node.head, visit);
      for (const s of node.steps) for (const [i, a] of s.args.entries()) {
        // pick's and join's bare field names are names, not paths.
        if ((s.name === "pick" || (s.name === "join" && i > 0) || s.name === "flatten") && fieldName(a.expr) !== undefined) continue;
        walkSlateExpr(a.expr, visit);
      }
      break;
    default: break;
  }
}

/** Every own and source path an expression reads, in first-read order, without item and index; a call to a function
 * that reads the clock (until, ago) adds time.now. */
export function slateDependencies(expr: string | SlateExpr): string[] {
  const ast = typeof expr === "string" ? parseSlateExpression(expr).ast : expr;
  if (ast === undefined) return [];
  const out = new Set<string>();
  walkSlateExpr(ast, n => {
    if (n.k === "path" && (n.own || (n.head !== "item" && n.head !== "index"))) out.add(slatePathText(n.head, n.own, n.segs));
    if (n.k === "call" && F[n.name]?.clock === true) out.add("time.now");
  });
  return [...out];
}

/** Every path a prop value reads, through its bindings, format holes and nested literals. */
export function slatePropDependencies(value: SlatePropValue | undefined): string[] {
  const out = new Set<string>();
  const visit = (v: SlatePropValue | undefined): void => {
    if (v === null || v === undefined || typeof v !== "object") return;
    if (isSlateBinding(v)) { for (const p of slateDependencies(v.bind)) out.add(p); return; }
    if (isSlateFormat(v)) {
      for (const part of parseSlateFormat(v.format).parts) if (typeof part !== "string") for (const p of slateDependencies(part.expr)) out.add(p);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    for (const x of Object.values(v)) visit(x);
  };
  visit(value);
  return [...out];
}

// ---- static checks ----

/** What the checker knows about the world an expression is read in. */
export interface SlateCheckScope {
  /** The type of a path, or a problem naming the nearest declared one. item and index never reach this. */
  path(head: string, own: boolean, segs: readonly (string | number)[]): SlateType | { code: SlateCode; message: string; fix?: string };
  /** The row scope: item's type inside a repeating piece's row. */
  row?: SlateType;
}

function merge(a: SlateType, b: SlateType): SlateType {
  if (a.t === b.t) return a;
  if (a.t === "null") return b;
  if (b.t === "null") return a;
  return T.any;
}

/** A field of a known type: a record's declared field, or any. */
function fieldType(of: SlateType, seg: string | number): SlateType | "unknown" {
  if (typeof seg === "number") return of.t === "list" ? (of.of ?? T.any) : of.t === "any" ? T.any : T.any;
  if (of.t === "record" && of.fields !== undefined) return of.fields[seg] ?? "unknown";
  return T.any;
}

/** Problems with an expression at write time: unknown paths, functions, arity, argument and step input types, item
 * outside a row, string arithmetic, a list compared with a string. Positions are offsets into src plus base. */
export function checkSlateExpression(src: string, scope: SlateCheckScope, base = 0): { type: SlateType; problems: SlateProblem[] } {
  const { ast, errors } = parseSlateExpression(src);
  if (ast === undefined) return { type: T.any, problems: errors.map(e => ({ ...e, at: (e.at ?? 0) + base })) };
  const problems: SlateProblem[] = [];
  const add = (code: SlateCode, message: string, at: number, fix?: string): void => { problems.push(slateProblem(code, message, { at: at + base, fix })); };
  const type = (node: SlateExpr, row: SlateType | undefined): SlateType => {
    switch (node.k) {
      case "lit": return node.v === null ? T.nul : typeof node.v === "number" ? T.num : typeof node.v === "string" ? T.str : typeof node.v === "boolean" ? T.bool : T.any;
      case "tpl": for (const p of node.parts) if (typeof p !== "string") type(p.expr, row); return T.str;
      case "path": {
        if (!node.own && (node.head === "item" || node.head === "index")) {
          if (row === undefined) { add("X409", `${node.head} is only known inside a repeating piece or a step`, node.at); return T.any; }
          if (node.head === "index") return node.segs.length === 0 ? T.num : T.any;
          let t = row;
          for (const [i, s] of node.segs.entries()) {
            const next = fieldType(t, s);
            if (next === "unknown") {
              const known = Object.keys(t.fields ?? {});
              const fix = nearest(String(s), known);
              add("X401", `item.${node.segs.slice(0, i + 1).join(".")} is not a field of this list's rows${fix !== undefined ? `; did you mean item.${fix}?` : `; they have ${known.join(", ")}`}`, node.at, fix !== undefined ? `item.${fix}` : undefined);
              return T.any;
            }
            t = next;
          }
          return t;
        }
        const known = scope.path(node.head, node.own, node.segs);
        if ("code" in known) { add(known.code, known.message, node.at, known.fix); return T.any; }
        return known;
      }
      case "field": {
        const of = type(node.of, row);
        const t = fieldType(of, node.name);
        if (t === "unknown") {
          const fix = nearest(String(node.name), Object.keys(of.fields ?? {}));
          add("X401", `${node.name} is not a field here${fix !== undefined ? `; did you mean ${fix}?` : ""}`, node.at, fix);
          return T.any;
        }
        return t;
      }
      case "neg": type(node.arg, row); return T.num;
      case "not": type(node.arg, row); return T.bool;
      case "cond": type(node.test, row); return merge(type(node.then, row), type(node.else, row));
      case "bin": {
        const l = type(node.left, row);
        const r = type(node.right, row);
        if (node.op === "and" || node.op === "or") return l.t === r.t ? l : T.any;
        if (node.op === "==" || node.op === "!=") {
          if ((l.t === "list" && r.t === "string") || (l.t === "string" && r.t === "list")) {
            add("X408", "a list never equals a string; use contains(), len() or a step", node.at, "contains(list, value), len(list) or list | where(item.field == value)");
          }
          return T.bool;
        }
        if (COMPARE.has(node.op)) return T.bool;
        if (l.t === "string" || r.t === "string") add("X408", `${node.op} works on numbers; join text with concat() or a template`, node.at, "concat(a, b) or `${a}${b}`");
        return T.num;
      }
      case "call": {
        if (HANDLER_STEPS.has(node.name) && F[node.name] === undefined) {
          for (const a of node.args) type(a, row);
          add("X400", `${node.name}(...) is a handler step, which goes in onPress, onSubmit, onChange or do`, node.at);
          return T.any;
        }
        const spec = F[node.name];
        const argTypes = node.args.map(a => type(a, row));
        if (spec === undefined) {
          const fix = node.name === "length" ? "len" : node.name === "toUpperCase" ? "upper" : nearest(node.name, Object.keys(F));
          add("X404", `${node.name} is not a function${fix !== undefined ? `; did you mean ${fix}?` : ""}`, node.at, fix);
          return T.any;
        }
        if (node.args.length < spec.min || node.args.length > spec.max) {
          const want = spec.min === spec.max ? `${spec.min}` : spec.max >= 99 ? `at least ${spec.min}` : `${spec.min} or ${spec.max}`;
          add("X405", `${node.name} takes ${want} argument${want === "1" ? "" : "s"}, got ${node.args.length}: ${spec.sig}`, node.at, spec.sig);
        }
        const first = argTypes[0];
        if (first !== undefined && spec.numberFirst === true && ["string", "list", "record", "boolean"].includes(first.t)) {
          add("X406", `${node.name} takes a number; this gives ${first.t === "string" ? "text" : `a ${first.t}`}`, node.args[0]!.at, first.t === "string" ? `${node.name}(num(...))` : undefined);
        }
        if (first !== undefined && spec.listFirst === true && ["string", "number", "boolean"].includes(first.t)) {
          add("X406", `${node.name} takes a list; this gives ${first.t === "string" ? "text" : `a ${first.t}`}`, node.args[0]!.at);
        }
        return spec.returns(argTypes);
      }
      case "pipe": {
        let cur = type(node.head, row);
        for (const step of node.steps) {
          const spec = PIPE[step.name]!;
          if (spec.needsList && ["number", "string", "boolean", "record"].includes(cur.t)) {
            add("Q424", `${step.name} takes a list; this is ${cur.t === "string" ? "text" : `a ${cur.t}`}`, step.at - base);
          }
          const elem = cur.t === "list" ? (cur.of ?? T.any) : T.any;
          const argTypes: SlateType[] = [];
          for (const [i, a] of step.args.entries()) {
            if ((step.name === "pick" || (step.name === "join" && i > 0) || step.name === "flatten") && fieldName(a.expr) !== undefined) { argTypes.push(T.str); continue; }
            argTypes.push(type(a.expr, step.name === "join" && i === 0 ? row : elem));
          }
          cur = spec.out(cur, argTypes);
        }
        return cur;
      }
    }
  };
  const t = type(ast, scope.row);
  return { type: t, problems };
}
