// SPDX-License-Identifier: AGPL-3.0-only
// The slate's formula language: paths, literals, arithmetic, comparison, logic, a choice and named functions, with
// no loops, no assignment and no road from a string to code. One parser, one checker and one evaluator, which the
// host runs for reads and events and the renderer runs to draw, so a value never reads two ways.
import { fmtBytes, fmtClock, fmtCost, fmtDuration, fmtTokens } from "../format.js";
import { SLATE_LIMITS } from "./limits.js";
import { nearest, slateProblem } from "./problems.js";
import { slateStep } from "./state.js";
import { isSlateBinding, isSlateFormat, type SlateEvalContext, type SlateExpr, type SlateJson, type SlateProblem, type SlatePropValue } from "./types.js";

type Val = SlateJson | undefined;
type Bin = Extract<SlateExpr, { k: "bin" }>["op"];

const WORDS = new Set(["and", "or", "not", "true", "false", "null"]);
const COMPARE = new Set(["==", "!=", "<", "<=", ">", ">="]);

interface Token { t: "num" | "str" | "name" | "op" | "end"; v: string; at: number }

class SyntaxFault extends Error {
  constructor(message: string, readonly at: number, readonly code: "X400" | "X407" = "X400") { super(message); }
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
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
        if (src[i] === "\\" && i + 1 < src.length) { s += src[i + 1]; i += 2; continue; }
        s += src[i];
        i++;
      }
      if (i >= src.length) throw new SyntaxFault(`a string opened at column ${at + 1} never closes`, at);
      i++;
      out.push({ t: "str", v: s, at });
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "name", v: m[0], at });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      if (two === "&&" || two === "||") throw new SyntaxFault(`write ${two === "&&" ? "and" : "or"} instead of ${two}`, at);
      out.push({ t: "op", v: two, at });
      i += 2;
      continue;
    }
    if ("()[],.?:+-*/%<>".includes(c)) { out.push({ t: "op", v: c, at }); i++; continue; }
    if (c === "!") throw new SyntaxFault("write not instead of !", at);
    if (c === "=") throw new SyntaxFault("compare with ==, not =", at);
    throw new SyntaxFault(`"${c}" is not part of an expression`, at);
  }
  out.push({ t: "end", v: "", at: src.length });
  return out;
}

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token { return this.toks[this.i]!; }
  private next(): Token { return this.toks[this.i++]!; }
  private isOp(v: string): boolean { const t = this.peek(); return t.t === "op" && t.v === v; }
  private isWord(v: string): boolean { const t = this.peek(); return t.t === "name" && t.v === v; }
  private expect(v: string): void {
    const t = this.peek();
    if (t.t !== "op" || t.v !== v) throw new SyntaxFault(`expected ${v} at column ${t.at + 1}${t.t === "end" ? ", the expression ended" : ""}`, t.at);
    this.i++;
  }
  private enter(at: number): void {
    if (++this.depth > SLATE_LIMITS.exprDepth) throw new SyntaxFault(`nesting is deeper than ${SLATE_LIMITS.exprDepth}`, at, "X407");
  }

  parseAll(): SlateExpr {
    const e = this.expression();
    const t = this.peek();
    if (t.t !== "end") throw new SyntaxFault(`unexpected ${t.v || "text"} at column ${t.at + 1}`, t.at);
    return e;
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
      out = { k: "cond", test, then, else: other, at };
    }
    this.depth--;
    return out;
  }
  private or(): SlateExpr {
    let left = this.and();
    while (this.isWord("or")) { const at = this.next().at; left = { k: "bin", op: "or", left, right: this.and(), at }; }
    return left;
  }
  private and(): SlateExpr {
    let left = this.not();
    while (this.isWord("and")) { const at = this.next().at; left = { k: "bin", op: "and", left, right: this.not(), at }; }
    return left;
  }
  private not(): SlateExpr {
    if (this.isWord("not")) { const at = this.next().at; return { k: "not", arg: this.not(), at }; }
    return this.compare();
  }
  private compare(): SlateExpr {
    const left = this.sum();
    const t = this.peek();
    if (t.t === "op" && COMPARE.has(t.v)) {
      this.next();
      const right = this.sum();
      const after = this.peek();
      if (after.t === "op" && COMPARE.has(after.v)) throw new SyntaxFault("comparisons do not chain; write a < b and b < c", after.at);
      return { k: "bin", op: t.v as Bin, left, right, at: t.at };
    }
    return left;
  }
  private sum(): SlateExpr {
    let left = this.product();
    while (this.isOp("+") || this.isOp("-")) { const t = this.next(); left = { k: "bin", op: t.v as Bin, left, right: this.product(), at: t.at }; }
    return left;
  }
  private product(): SlateExpr {
    let left = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) { const t = this.next(); left = { k: "bin", op: t.v as Bin, left, right: this.unary(), at: t.at }; }
    return left;
  }
  private unary(): SlateExpr {
    if (this.isOp("-")) { const at = this.next().at; this.enter(at); const arg = this.unary(); this.depth--; return { k: "neg", arg, at }; }
    return this.primary();
  }
  private primary(): SlateExpr {
    const t = this.next();
    if (t.t === "num") return { k: "lit", v: Number(t.v), at: t.at };
    if (t.t === "str") return { k: "lit", v: t.v, at: t.at };
    if (t.t === "op" && t.v === "(") {
      const e = this.expression();
      this.expect(")");
      return e;
    }
    if (t.t === "name") {
      if (t.v === "true" || t.v === "false") return { k: "lit", v: t.v === "true", at: t.at };
      if (t.v === "null") return { k: "lit", v: null, at: t.at };
      if (WORDS.has(t.v)) throw new SyntaxFault(`${t.v} cannot start a value (column ${t.at + 1})`, t.at);
      if (this.isOp("(")) {
        this.next();
        const args: SlateExpr[] = [];
        if (!this.isOp(")")) {
          for (;;) {
            args.push(this.expression());
            if (this.isOp(",")) { this.next(); continue; }
            break;
          }
        }
        this.expect(")");
        return { k: "call", name: t.v, args, at: t.at };
      }
      const segs: (string | number)[] = [];
      for (;;) {
        if (this.isOp(".")) {
          this.next();
          const n = this.next();
          if (n.t !== "name") throw new SyntaxFault(`expected a name after . at column ${n.at + 1}`, n.at);
          segs.push(n.v);
          continue;
        }
        if (this.isOp("[")) {
          this.next();
          let sign = 1;
          if (this.isOp("-")) { this.next(); sign = -1; }
          const n = this.next();
          if (n.t !== "num" || !/^\d+$/.test(n.v)) throw new SyntaxFault(`an index is a whole number, at column ${n.at + 1}`, n.at);
          segs.push(sign * Number(n.v));
          this.expect("]");
          continue;
        }
        break;
      }
      return { k: "path", head: t.v, segs, at: t.at };
    }
    throw new SyntaxFault(t.t === "end" ? "the expression ended early" : `unexpected ${t.v} at column ${t.at + 1}`, t.at);
  }
}

const parsed = new Map<string, { ast?: SlateExpr; errors: SlateProblem[] }>();

export function parseSlateExpression(src: string): { ast?: SlateExpr; errors: SlateProblem[] } {
  const hit = parsed.get(src);
  if (hit !== undefined) return hit;
  let out: { ast?: SlateExpr; errors: SlateProblem[] };
  if (src.length > SLATE_LIMITS.exprChars) {
    out = { errors: [slateProblem("X407", `the expression is ${src.length} characters; the most is ${SLATE_LIMITS.exprChars}`)] };
  } else if (src.trim() === "") {
    out = { errors: [slateProblem("X400", "the expression is empty", { at: 0 })] };
  } else {
    try {
      out = { ast: new Parser(tokenize(src)).parseAll(), errors: [] };
    } catch (e) {
      if (!(e instanceof SyntaxFault)) throw e;
      out = { errors: [slateProblem(e.code, e.message, { at: e.at })] };
    }
  }
  if (parsed.size > 2_000) parsed.clear();
  parsed.set(src, out);
  return out;
}

/** The text of a path as the resolvers and the dependency sets name it: "pr.checks[0].name". */
export function slatePathText(head: string, segs: readonly (string | number)[]): string {
  return head + segs.map(s => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("");
}

// ---- format strings ----

export type SlateFormatPart = string | { expr: string; at: number };

/** A format string's literal runs and its ${...} holes; "$${" is a literal "${". A hole's braces balance and skip
 * quoted strings, so a "}" inside a quoted string does not close it. */
export function parseSlateFormat(src: string): { parts: SlateFormatPart[]; errors: SlateProblem[] } {
  const parts: SlateFormatPart[] = [];
  let lit = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("$${", i)) { lit += "${"; i += 3; continue; }
    if (src.startsWith("${", i)) {
      const start = i + 2;
      let j = start;
      let depth = 1;
      let quote: string | undefined;
      while (j < src.length) {
        const c = src[j]!;
        if (quote !== undefined) {
          if (c === "\\") j++;
          else if (c === quote) quote = undefined;
        } else if (c === "'" || c === '"') quote = c;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) break;
        j++;
      }
      if (j >= src.length) return { parts, errors: [slateProblem("X400", `a \${ at column ${i + 1} never closes`, { at: i })] };
      if (lit !== "") parts.push(lit);
      lit = "";
      parts.push({ expr: src.slice(start, j), at: start });
      i = j + 1;
      continue;
    }
    lit += src[i];
    i++;
  }
  if (lit !== "") parts.push(lit);
  const holes = parts.filter(p => typeof p !== "string").length;
  return { parts, errors: holes > SLATE_LIMITS.holes ? [slateProblem("X407", `${holes} holes in one string; the most is ${SLATE_LIMITS.holes}`)] : [] };
}

// ---- functions ----

type Fn = (args: Val[], env: Env) => Val;
interface FnSpec { min: number; max: number; returns: SlateType; sig: string; example: string; fn: Fn; clock?: true }
export type SlateType = "number" | "string" | "boolean" | "list" | "record" | "null" | "any";

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

/** "3d 7h", "3h 24m", "12m 4s", "40s": the two largest units, as a reset countdown and a tile's age read. */
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

function equal(a: Val, b: Val): boolean {
  if (missing(a) && missing(b)) return true;
  return a === b;
}

const F: Record<string, FnSpec> = {
  percent: { min: 1, max: 2, returns: "string", sig: "percent(fraction, places?)", example: "percent(thread.context.used / thread.context.window)",
    fn: ([x, p]) => {
      if (!isNum(x)) return null;
      const v = x * 100;
      return `${v.toFixed(places(p, Math.abs(v) < 10 && v !== 0 ? 1 : 0))}%`;
    } },
  pct: { min: 1, max: 2, returns: "string", sig: "pct(points, places?)", example: "pct(usage.week.percent)",
    fn: ([x, p]) => (isNum(x) ? `${x.toFixed(places(p, 0))}%` : null) },
  tokens: { min: 1, max: 1, returns: "string", sig: "tokens(n)", example: "tokens(thread.context.free)", fn: ([x]) => (isNum(x) ? fmtTokens(x) : null) },
  bytes: { min: 1, max: 1, returns: "string", sig: "bytes(n)", example: "bytes(machine.mem.used)", fn: ([x]) => (isNum(x) ? fmtBytes(x) : null) },
  usd: { min: 1, max: 2, returns: "string", sig: "usd(n, places?)", example: "usd(thread.cost.usd)",
    fn: ([x, p]) => (!isNum(x) ? null : p === undefined ? fmtCost(x) : `$${plainNumber(x, places(p, 2))}`) },
  number: { min: 1, max: 2, returns: "string", sig: "number(x, places?)", example: "number(machine.load1, 2)",
    fn: ([x, p]) => (isNum(x) ? plainNumber(x, p === undefined ? undefined : places(p, 0)) : null) },
  duration: { min: 1, max: 2, returns: "string", sig: "duration(ms, style?)", example: "duration(thread.lastTurn.durationMs)",
    fn: ([x, style]) => (isNum(x) ? fmtDuration(x, style === "clock" || style === "long" ? "clock" : "short") : null) },
  ago: { min: 1, max: 1, returns: "string", sig: "ago(time)", example: "ago(pr.readAt)", clock: true,
    fn: ([t], env) => { const at = ms(t); const now = env.now(); return at === null || now === null ? null : span(now - at, false); } },
  until: { min: 1, max: 1, returns: "string", sig: "until(time)", example: "until(usage.week.resetsAt)", clock: true,
    fn: ([t], env) => { const at = ms(t); const now = env.now(); return at === null || now === null ? null : at <= now ? "now" : `in ${span(at - now)}`; } },
  date: { min: 1, max: 2, returns: "string", sig: "date(time, style?)", example: "date(usage.week.resetsAt)",
    fn: ([t, style]) => {
      const at = ms(t);
      if (at === null) return null;
      return style === "long"
        ? new Date(at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(",", "")
        : new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
    } },
  time: { min: 1, max: 1, returns: "string", sig: "time(time)", example: "time(usage.session.resetsAt)",
    fn: ([t]) => { const at = ms(t); return at === null ? null : fmtClock(at).slice(0, 5); } },
  weekday: { min: 1, max: 1, returns: "string", sig: "weekday(time)", example: "weekday(usage.week.resetsAt)",
    fn: ([t]) => { const at = ms(t); return at === null ? null : new Date(at).toLocaleDateString("en-GB", { weekday: "long" }); } },
  plural: { min: 2, max: 3, returns: "string", sig: "plural(n, one, many?)", example: "plural(len(pr.checks), 'check')",
    fn: ([n, one, many]) => (isNum(n) && typeof one === "string" ? `${plainNumber(n)} ${n === 1 ? one : typeof many === "string" ? many : `${one}s`}` : null) },
  upper: { min: 1, max: 1, returns: "string", sig: "upper(s)", example: "upper(git.branch)", fn: ([s]) => (typeof s === "string" ? s.toUpperCase() : null) },
  lower: { min: 1, max: 1, returns: "string", sig: "lower(s)", example: "lower(pr.word)", fn: ([s]) => (typeof s === "string" ? s.toLowerCase() : null) },
  trim: { min: 1, max: 1, returns: "string", sig: "trim(s)", example: "trim(state.note)", fn: ([s]) => (typeof s === "string" ? s.trim() : null) },
  short: { min: 2, max: 2, returns: "string", sig: "short(s, n)", example: "short(pr.headSubject, 40)",
    fn: ([s, n]) => (typeof s === "string" && isNum(n) ? (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s) : null) },
  round: { min: 1, max: 2, returns: "number", sig: "round(x, places?)", example: "round(usage.week.percent)",
    fn: ([x, p]) => { if (!isNum(x)) return null; const f = 10 ** places(p, 0); return Math.round(x * f) / f; } },
  floor: { min: 1, max: 1, returns: "number", sig: "floor(x)", example: "floor(thread.context.percent)", fn: ([x]) => (isNum(x) ? Math.floor(x) : null) },
  ceil: { min: 1, max: 1, returns: "number", sig: "ceil(x)", example: "ceil(thread.context.percent)", fn: ([x]) => (isNum(x) ? Math.ceil(x) : null) },
  abs: { min: 1, max: 1, returns: "number", sig: "abs(x)", example: "abs(git.behind)", fn: ([x]) => (isNum(x) ? Math.abs(x) : null) },
  min: { min: 1, max: 99, returns: "number", sig: "min(a, b, ...) or min(list)", example: "min(usage.week.percent, 100)",
    fn: (args, env) => { const ns = numbersOf(env, listOrArgs(args), undefined); return ns.length === 0 ? null : Math.min(...ns); } },
  max: { min: 1, max: 99, returns: "number", sig: "max(a, b, ...) or max(list)", example: "max(0, thread.context.free)",
    fn: (args, env) => { const ns = numbersOf(env, listOrArgs(args), undefined); return ns.length === 0 ? null : Math.max(...ns); } },
  clamp: { min: 3, max: 3, returns: "number", sig: "clamp(x, lo, hi)", example: "clamp(usage.week.percent, 0, 100)",
    fn: ([x, lo, hi]) => (isNum(x) && isNum(lo) && isNum(hi) ? Math.min(hi, Math.max(lo, x)) : null) },
  str: { min: 1, max: 1, returns: "string", sig: "str(x)", example: "str(pr.number)", fn: ([x]) => (missing(x) ? null : slateText(x)) },
  num: { min: 1, max: 1, returns: "number", sig: "num(x)", example: "num(item.completedAt) - num(item.startedAt)",
    fn: ([x]) => {
      if (isNum(x)) return x;
      if (typeof x === "boolean") return x ? 1 : 0;
      if (typeof x !== "string" || x.trim() === "") return null;
      const n = Number(x);
      if (Number.isFinite(n)) return n;
      return /^\d{4}-\d{2}-\d{2}/.test(x) ? ms(x) : null;
    } },
  bool: { min: 1, max: 1, returns: "boolean", sig: "bool(x)", example: "bool(state.done)", fn: ([x]) => slateTruthy(x) },
  len: { min: 1, max: 1, returns: "number", sig: "len(list or string)", example: "len(pr.checks)",
    fn: ([x]) => (isList(x) || typeof x === "string" ? x.length : isRecord(x) ? Object.keys(x).length : 0) },
  count: { min: 1, max: 1, returns: "number", sig: "count(list)", example: "count(pr.checks)", fn: ([x]) => (isList(x) ? x.length : 0) },
  sum: { min: 1, max: 2, returns: "number", sig: "sum(list, field?)", example: "sum(thread.changes.files, 'additions')",
    fn: ([l, f], env) => (isList(l) ? numbersOf(env, l, f).reduce((a, b) => a + b, 0) : null) },
  avg: { min: 1, max: 2, returns: "number", sig: "avg(list, field?)", example: "avg(thread.changes.files, 'additions')",
    fn: ([l, f], env) => { const ns = numbersOf(env, l, f); return ns.length === 0 ? null : ns.reduce((a, b) => a + b, 0) / ns.length; } },
  first: { min: 1, max: 1, returns: "any", sig: "first(list)", example: "first(pr.checks).name", fn: ([l]) => (isList(l) ? (l[0] ?? null) : null) },
  last: { min: 1, max: 1, returns: "any", sig: "last(list)", example: "last(thread.plan.steps).text", fn: ([l]) => (isList(l) ? (l[l.length - 1] ?? null) : null) },
  pluck: { min: 2, max: 2, returns: "list", sig: "pluck(list, field)", example: "pluck(pr.checks, 'name')",
    fn: ([l, f], env) => (isList(l) && typeof f === "string" ? l.map(item => { env.charge(1); return field(item, f) ?? null; }) : null) },
  join: { min: 2, max: 2, returns: "string", sig: "join(list, sep)", example: "join(pluck(pr.checks, 'name'), ', ')",
    fn: ([l, sep], env) => (isList(l) ? l.map(item => { env.charge(1); return slateText(item); }).join(typeof sep === "string" ? sep : ", ") : null) },
  contains: { min: 2, max: 2, returns: "boolean", sig: "contains(list or string, value)", example: "contains(pluck(pr.checks, 'state'), 'fail')",
    fn: ([x, v], env) => {
      if (typeof x === "string") return typeof v === "string" ? x.includes(v) : false;
      if (!isList(x)) return false;
      env.charge(x.length);
      return x.some(item => equal(item, v));
    } },
  startsWith: { min: 2, max: 2, returns: "boolean", sig: "startsWith(s, prefix)", example: "startsWith(git.branch, 'poc/')",
    fn: ([s, p]) => (typeof s === "string" && typeof p === "string" ? s.startsWith(p) : false) },
  concat: { min: 1, max: 99, returns: "string", sig: "concat(a, b, ...)", example: "concat(git.branch, ' at ', git.head)", fn: args => args.map(slateText).join("") },
  orElse: { min: 2, max: 2, returns: "any", sig: "orElse(x, fallback)", example: "orElse(pr.word, 'no pull request')", fn: ([x, f]) => (missing(x) ? (f ?? null) : x) },
  exists: { min: 1, max: 1, returns: "boolean", sig: "exists(x)", example: "exists(usage.note)", fn: ([x]) => !missing(x) },
  isNull: { min: 1, max: 1, returns: "boolean", sig: "isNull(x)", example: "isNull(pr.number)", fn: ([x]) => missing(x) },
  coalesce: { min: 1, max: 99, returns: "any", sig: "coalesce(a, b, ...)", example: "coalesce(pr.headSubject, git.branch)", fn: args => args.find(a => !missing(a)) ?? null },
  if: { min: 3, max: 3, returns: "any", sig: "if(cond, a, b)", example: "if(pr.draft, 'Draft', 'Ready')", fn: ([c, a, b]) => (slateTruthy(c) ? a : b) ?? null },
};

/** Functions whose answer is null for a null argument where a value is needed; the rest take a missing value. */
const NULL_SAFE = new Set(["min", "max", "orElse", "exists", "isNull", "len", "count", "coalesce", "concat", "if", "bool", "contains", "startsWith"]);

export const SLATE_FUNCTIONS: Readonly<Record<string, Readonly<Omit<FnSpec, "fn">>>> = F;

// ---- evaluation ----

class OverBudget extends Error {}

interface Env {
  ctx: SlateEvalContext;
  steps: number;
  charge(n: number): void;
  now(): number | null;
}

function makeEnv(ctx: SlateEvalContext): Env {
  const env: Env = {
    ctx,
    steps: 0,
    charge(n) {
      env.steps += n;
      if (env.steps > SLATE_LIMITS.evalSteps) throw new OverBudget();
    },
    now() {
      const v = ctx.resolve("time.now");
      return isNum(v) ? v : (ctx.now ?? Date.now());
    },
  };
  return env;
}

function readPath(node: Extract<SlateExpr, { k: "path" }>, env: Env): Val {
  const { head, segs } = node;
  if (head === "item" || head === "index") {
    const row = env.ctx.row;
    if (row === undefined) return undefined;
    let v: Val = head === "item" ? row.item : row.index;
    for (const s of segs) v = slateStep(v, s);
    return v;
  }
  // The resolver answers the longest dotted path it knows; the evaluator steps into the rest.
  const firstIndex = segs.findIndex(s => typeof s === "number");
  let names = firstIndex === -1 ? segs.length : firstIndex;
  for (; names >= 0; names--) {
    const v = env.ctx.resolve(slatePathText(head, segs.slice(0, names)));
    if (v !== undefined) {
      let out: Val = v;
      for (const s of segs.slice(names)) out = slateStep(out, s);
      return out;
    }
  }
  if (head === "time" && segs.length === 1 && segs[0] === "now") return env.now();
  return undefined;
}

function arith(op: Bin, a: Val, b: Val): Val {
  if (!isNum(a) || !isNum(b)) return null;
  switch (op) {
    case "+": return finite(a + b);
    case "-": return finite(a - b);
    case "*": return finite(a * b);
    case "/": return b === 0 ? null : finite(a / b);
    default: return b === 0 ? null : finite(a % b);
  }
}

function order(op: Bin, a: Val, b: Val): Val {
  if (missing(a) || missing(b)) return null;
  if (!((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string"))) return null;
  switch (op) {
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    default: return a >= b;
  }
}

function run(node: SlateExpr, env: Env): Val {
  env.charge(1);
  switch (node.k) {
    case "lit": return node.v;
    case "path": return readPath(node, env);
    case "neg": { const v = run(node.arg, env); return isNum(v) ? -v : null; }
    case "not": return !slateTruthy(run(node.arg, env));
    case "cond": return slateTruthy(run(node.test, env)) ? run(node.then, env) : run(node.else, env);
    case "bin": {
      if (node.op === "and") { const l = run(node.left, env); return slateTruthy(l) ? run(node.right, env) : l; }
      if (node.op === "or") { const l = run(node.left, env); return slateTruthy(l) ? l : run(node.right, env); }
      const l = run(node.left, env);
      const r = run(node.right, env);
      if (node.op === "==") return equal(l, r);
      if (node.op === "!=") return !equal(l, r);
      if (COMPARE.has(node.op)) return order(node.op, l, r);
      return arith(node.op, l, r);
    }
    case "call": {
      const spec = F[node.name];
      if (spec === undefined || node.args.length < spec.min || node.args.length > spec.max) return null;
      const args = node.args.map(a => run(a, env));
      if (!NULL_SAFE.has(node.name) && missing(args[0])) return null;
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

function walk(node: SlateExpr, visit: (n: SlateExpr) => void): void {
  visit(node);
  switch (node.k) {
    case "neg": case "not": walk(node.arg, visit); break;
    case "bin": walk(node.left, visit); walk(node.right, visit); break;
    case "cond": walk(node.test, visit); walk(node.then, visit); walk(node.else, visit); break;
    case "call": for (const a of node.args) walk(a, visit); break;
    default: break;
  }
}

/** Every source and state path an expression reads, in first-read order, without item and index. A call to a
 * function that reads the clock (until, ago) adds time.now, so the countdown ticks. */
export function slateDependencies(expr: string | SlateExpr): string[] {
  const ast = typeof expr === "string" ? parseSlateExpression(expr).ast : expr;
  if (ast === undefined) return [];
  const out = new Set<string>();
  walk(ast, n => {
    if (n.k === "path" && n.head !== "item" && n.head !== "index") out.add(slatePathText(n.head, n.segs));
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
  path(head: string, segs: readonly (string | number)[]): { type: SlateType } | { code: "X401" | "X411"; message: string; fix?: string };
  /** Inside a repeating piece's row: item and index are known; field checks item.<segs> where the row's shape is. */
  row?: {
    item: SlateType;
    field?(segs: readonly (string | number)[]): { type: SlateType } | { code: "X401"; message: string; fix?: string };
  };
}

/** Problems with an expression at write time: syntax, unknown paths, functions, arity, item outside a row, string
 * arithmetic. Positions are offsets into src plus base. Returns the inferred type of the whole. */
export function checkSlateExpression(src: string, scope: SlateCheckScope, base = 0): { type: SlateType; problems: SlateProblem[] } {
  const { ast, errors } = parseSlateExpression(src);
  if (ast === undefined) return { type: "any", problems: errors.map(e => ({ ...e, at: (e.at ?? 0) + base })) };
  const problems: SlateProblem[] = [];
  const type = (node: SlateExpr): SlateType => {
    switch (node.k) {
      case "lit": return node.v === null ? "null" : (typeof node.v as SlateType);
      case "path": {
        if (node.head === "item" || node.head === "index") {
          if (scope.row === undefined) {
            problems.push(slateProblem("X409", `${node.head} is only known inside a repeating piece's row`, { at: node.at + base }));
            return "any";
          }
          if (node.head === "index") return node.segs.length === 0 ? "number" : "any";
          if (node.segs.length === 0) return scope.row.item;
          const known = scope.row.field?.(node.segs);
          if (known === undefined) return "any";
          if ("code" in known) {
            problems.push(slateProblem(known.code, known.message, { at: node.at + base, ...(known.fix !== undefined ? { fix: known.fix } : {}) }));
            return "any";
          }
          return known.type;
        }
        const known = scope.path(node.head, node.segs);
        if ("code" in known) {
          problems.push(slateProblem(known.code, known.message, { at: node.at + base, ...(known.fix !== undefined ? { fix: known.fix } : {}) }));
          return "any";
        }
        return known.type;
      }
      case "neg": type(node.arg); return "number";
      case "not": type(node.arg); return "boolean";
      case "cond": {
        type(node.test);
        const a = type(node.then);
        const b = type(node.else);
        return a === b ? a : a === "null" ? b : b === "null" ? a : "any";
      }
      case "bin": {
        const l = type(node.left);
        const r = type(node.right);
        if (node.op === "and" || node.op === "or") return l === r ? l : "any";
        if (COMPARE.has(node.op)) return "boolean";
        if (l === "string" || r === "string") {
          problems.push(slateProblem("X408", `${node.op} works on numbers; join text with concat() or a format string`, { at: node.at + base, fix: "use concat() or a format string" }));
        }
        return "number";
      }
      case "call": {
        const spec = F[node.name];
        for (const a of node.args) type(a);
        if (spec === undefined) {
          const fix = nearest(node.name, Object.keys(F));
          problems.push(slateProblem("X404", `${node.name} is not a function${fix !== undefined ? `; did you mean ${fix}?` : ""}`, { at: node.at + base, ...(fix !== undefined ? { fix } : {}) }));
          return "any";
        }
        if (node.args.length < spec.min || node.args.length > spec.max) {
          const want = spec.min === spec.max ? `${spec.min}` : spec.max >= 99 ? `at least ${spec.min}` : `${spec.min} or ${spec.max}`;
          problems.push(slateProblem("X405", `${node.name} takes ${want} argument${want === "1" ? "" : "s"}, got ${node.args.length}: ${spec.sig}`, { at: node.at + base, fix: spec.sig }));
        }
        return spec.returns;
      }
    }
  };
  return { type: type(ast), problems };
}
