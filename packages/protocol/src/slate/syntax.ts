// SPDX-License-Identifier: AGPL-3.0-only
// The JSX-like form of 03-syntax: a reader for elements, attributes, text children and holes; the compiler to the
// stored document and to patch ops; and the printer back. The compiler only builds the shape; every rule about
// meaning is the validator's, which runs on the compiled document so the JSON form and a patched result are held
// to the same checks. Lines ride beside the document so each problem names the line of the attribute it is on.
import { parseSlateExpression, slatePathText } from "./expr.js";
import { SLATE_ITEM_KINDS, SLATE_PIECES, type SlateItemSpec } from "./kit.js";
import { SLATE_LIMITS } from "./limits.js";
import { nearest, slateProblem, type SlateCode } from "./problems.js";
import { SLATE_STEPS } from "./steps.js";
import { validateDocument, type SlateLines } from "./validate.js";
import {
  SLATE_ID, SLATE_NAME, SLATE_PANE_KINDS, isSlateBinding, isSlateFormat,
  type SlateDoc, type SlateJson, type SlatePatch, type SlatePatchOp, type SlatePiece, type SlateProblem, type SlatePropValue,
  type SlateReactionDecl, type SlateRunDecl, type SlateStep, type SlateValueDecl,
} from "./types.js";

// ---- reading elements ----

interface Attr { name: string; kind: "bare" | "string" | "braced"; value: string; line: number }
interface Hole { expr: string; line: number }
interface El { tag: string; attrs: Attr[]; children: El[]; text?: (string | Hole)[]; raw?: string; line: number }

class Fatal extends Error {
  constructor(readonly code: SlateCode, message: string, readonly line: number, readonly fix?: string) { super(message); }
}

const DECLARATIONS = new Set(["value", "secret", "derived", "run", "when"]);
const PATCH_TAGS = new Set(["props", "add", "remove", "move", "clear", "undo"]);

class Reader {
  private i = 0;
  constructor(private readonly src: string) {}
  line(at = this.i): number { let n = 1; for (let j = 0; j < at && j < this.src.length; j++) if (this.src[j] === "\n") n++; return n; }
  private peek(n = 0): string | undefined { return this.src[this.i + n]; }
  private starts(s: string): boolean { return this.src.startsWith(s, this.i); }
  private ws(): void { while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++; }
  private fail(message: string, fix?: string): never { throw new Fatal("P100", message, this.line(), fix); }

  /** Every top-level element: one <slate> for a document, any number for a patch. */
  elements(): El[] {
    const out: El[] = [];
    for (;;) {
      this.ws();
      this.comments();
      this.ws();
      if (this.i >= this.src.length) break;
      if (this.peek() !== "<") this.fail(`expected an element at line ${this.line()}, found text`);
      out.push(this.element());
    }
    return out;
  }
  private comments(): void {
    for (;;) {
      if (this.starts("<!--")) { const end = this.src.indexOf("-->", this.i); if (end < 0) this.fail("a comment never closes"); this.i = end + 3; this.ws(); continue; }
      if (this.starts("{/*")) { const end = this.src.indexOf("*/}", this.i); if (end < 0) this.fail("a comment never closes"); this.i = end + 3; this.ws(); continue; }
      break;
    }
  }
  private element(): El {
    const line = this.line();
    this.i++;
    const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(this.src.slice(this.i));
    if (tag === null) this.fail(`cannot read a tag name at line ${line}`);
    const name = tag[0];
    this.i += name.length;
    const attrs: Attr[] = [];
    for (;;) {
      this.ws();
      if (this.starts("/>")) { this.i += 2; return { tag: name, attrs, children: [], line }; }
      if (this.peek() === ">") { this.i++; break; }
      if (this.i >= this.src.length) this.fail(`<${name}> at line ${line} is not closed; write <${name} ... /> or </${name}>`);
      const an = /^[A-Za-z][A-Za-z0-9_-]*/.exec(this.src.slice(this.i));
      if (an === null) this.fail(`cannot read an attribute of <${name}> at line ${this.line()}; write <${name} prop="literal" prop={formula} />`);
      const aline = this.line();
      this.i += an[0].length;
      this.ws();
      if (this.peek() !== "=") { attrs.push({ name: an[0], kind: "bare", value: "", line: aline }); continue; }
      this.i++;
      this.ws();
      const q = this.peek();
      if (q === '"' || q === "'") {
        const end = this.src.indexOf(q, this.i + 1);
        if (end < 0) this.fail(`the string for ${an[0]} at line ${aline} never closes`);
        const raw = this.src.slice(this.i + 1, end);
        if (raw.endsWith("\\")) this.fail(`attribute strings take no escapes (${an[0]} at line ${aline})`, q === '"' ? `use single quotes around it, or write it as {"..."}` : `use double quotes around it, or write it as {'...'}`);
        this.i = end + 1;
        attrs.push({ name: an[0], kind: "string", value: raw, line: aline });
        continue;
      }
      if (q === "{") {
        const end = this.balanced(this.i);
        attrs.push({ name: an[0], kind: "braced", value: this.src.slice(this.i + 1, end), line: aline });
        this.i = end + 1;
        continue;
      }
      if (q === "`") this.fail(`a template for ${an[0]} goes inside braces: ${an[0]}={\`...\`}`);
      this.fail(`cannot read the value of ${an[0]} at line ${aline}`);
    }
    if (SLATE_PIECES[name]?.rawText === true) {
      const close = `</${name}>`;
      const end = this.src.indexOf(close, this.i);
      if (end < 0) this.fail(`<${name}> at line ${line} is not closed; write </${name}>`);
      const raw = dedent(this.src.slice(this.i, end));
      this.i = end + close.length;
      return { tag: name, attrs, children: [], line, ...(raw !== "" ? { raw } : {}) };
    }
    const children: El[] = [];
    const text: (string | Hole)[] = [];
    for (;;) {
      if (this.i >= this.src.length) this.fail(`<${name}> at line ${line} is not closed; write <${name} ... /> or </${name}>`);
      if (this.starts("</")) {
        const m = /^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(this.src.slice(this.i));
        if (m === null) this.fail(`cannot read the closing tag at line ${this.line()}`);
        if (m[1] !== name) this.fail(`</${m[1]}> at line ${this.line()} closes <${name}> opened at line ${line}; expected </${name}>`, `</${name}>`);
        this.i += m[0].length;
        break;
      }
      if (this.starts("<!--") || this.starts("{/*")) { this.comments(); continue; }
      if (this.peek() === "<") { children.push(this.element()); continue; }
      if (this.peek() === "{") {
        const hl = this.line();
        const end = this.balanced(this.i);
        text.push({ expr: this.src.slice(this.i + 1, end), line: hl });
        this.i = end + 1;
        continue;
      }
      let j = this.i;
      while (j < this.src.length && this.src[j] !== "<" && this.src[j] !== "{") j++;
      text.push(this.src.slice(this.i, j));
      this.i = j;
    }
    const meaningful = text.some(t => typeof t !== "string" || t.trim() !== "");
    return { tag: name, attrs, children, line, ...(meaningful ? { text } : {}) };
  }
  /** The index of the } that closes the { at i, with strings, templates and nested braces skipped. */
  private balanced(i: number): number {
    let depth = 0;
    let quote: string | undefined;
    for (let j = i; j < this.src.length; j++) {
      const c = this.src[j]!;
      if (quote !== undefined) { if (c === "\\") j++; else if (c === quote) quote = undefined; }
      else if (c === "'" || c === '"' || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return j;
    }
    throw new Fatal("P100", `a { at line ${this.line(i)} never closes`, this.line(i));
  }
}

function dedent(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const indent = Math.min(...lines.filter(l => l.trim() !== "").map(l => l.length - l.trimStart().length));
  return lines.map(l => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}

/** A text child's literal run as stored: runs of spaces and tabs read as one, indentation around a newline goes,
 * newlines stay. The whole child is trimmed afterwards. */
const normalizeRun = (s: string): string => s.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
export const slateTextChildForm = (s: string): string => normalizeRun(s).replace(/^\s+|\s+$/g, "");

/** Splits text at top-level commas, honouring quotes, braces, brackets and parentheses. */
export function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== undefined) { cur += c; if (c === "\\") { cur += text[++i] ?? ""; } else if (c === quote) quote = undefined; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; cur += c; continue; }
    if ("{[(".includes(c)) depth++;
    if ("}])".includes(c)) depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

/** A JSON-ish literal: strings in either quote, numbers, true, false, null, lists and records with bare keys. */
export function parseSlateLiteral(text: string): SlateJson {
  let i = 0;
  const ws = (): void => { while (/\s/.test(text[i] ?? "")) i++; };
  const value = (): SlateJson => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const out: Record<string, SlateJson> = {};
      ws();
      if (text[i] === "}") { i++; return out; }
      for (;;) {
        ws();
        let key: string;
        if (text[i] === '"' || text[i] === "'") { const q = text[i]!; const end = text.indexOf(q, i + 1); if (end < 0) throw new Error("a key never closes"); key = text.slice(i + 1, end); i = end + 1; }
        else { const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i)); if (m === null) throw new Error(`a key at "${text.slice(i, i + 12)}"`); key = m[0]; i += m[0].length; }
        ws();
        if (text[i] !== ":") throw new Error("expected :");
        i++;
        out[key] = value();
        ws();
        if (text[i] === ",") { i++; ws(); if (text[i] === "}") { i++; return out; } continue; }
        if (text[i] === "}") { i++; return out; }
        throw new Error("expected , or }");
      }
    }
    if (c === "[") {
      i++;
      const out: SlateJson[] = [];
      ws();
      if (text[i] === "]") { i++; return out; }
      for (;;) {
        out.push(value());
        ws();
        if (text[i] === ",") { i++; ws(); if (text[i] === "]") { i++; return out; } continue; }
        if (text[i] === "]") { i++; return out; }
        throw new Error("expected , or ]");
      }
    }
    if (c === '"' || c === "'") {
      let s = "";
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") { const n = text[i + 1] ?? ""; s += n === "n" ? "\n" : n === "t" ? "\t" : n; i += 2; continue; }
        s += text[i++];
      }
      if (i >= text.length) throw new Error("a string never closes");
      i++;
      return s;
    }
    const m = /^(-?\d+(?:\.\d+)?(?:[eE]-?\d+)?|true|false|null)/.exec(text.slice(i));
    if (m === null) throw new Error(`not a literal: "${text.slice(i, i + 16)}"`);
    i += m[0].length;
    return m[0] === "true" ? true : m[0] === "false" ? false : m[0] === "null" ? null : Number(m[0]);
  };
  const v = value();
  ws();
  if (i < text.length) throw new Error(`unexpected "${text.slice(i, i + 16)}"`);
  return v;
}

/** Seconds from "30s", "2m", "1h" or a bare number; NaN when unreadable. */
function seconds(a: Attr): number {
  if (a.kind === "braced") return /^\s*\d+(\.\d+)?\s*$/.test(a.value) ? Number(a.value) : NaN;
  const m = /^(\d+)\s*(s|m|h)?$/.exec(a.value.trim());
  return m === null ? NaN : Number(m[1]) * ({ s: 1, m: 60, h: 3600 } as Record<string, number>)[m[2] ?? "s"]!;
}

// ---- compiling ----

class Compiler {
  readonly errors: SlateProblem[] = [];
  readonly warnings: SlateProblem[] = [];
  readonly lines: SlateLines = new Map();
  readonly doc: SlateDoc = { schema: 2, root: "", values: {}, derived: {}, runs: {}, reactions: [], pieces: {} };
  private readonly minted = new Map<string, number>();
  private readonly taken = new Set<string>();
  /** Names declared in this text and in the document a patch applies to. */
  readonly names = new Map<string, string>();
  patch = false;

  constructor(current?: SlateDoc | null) {
    if (current !== null && current !== undefined) {
      for (const id of Object.keys(current.pieces)) this.taken.add(id);
      for (const n of Object.keys(current.values)) this.names.set(n, current.values[n]!.secret === true ? "secret" : "value");
      for (const n of Object.keys(current.derived)) this.names.set(n, "derived");
      for (const n of Object.keys(current.runs)) this.names.set(n, "run");
    }
  }

  error(code: SlateCode, message: string, line: number, extra: { piece?: string; prop?: string; fix?: string } = {}): void {
    if (this.errors.length < SLATE_LIMITS.errorsPerPass) this.errors.push(slateProblem(code, message, { line, ...extra }));
  }
  private guard(fn: () => void): void {
    try { fn(); } catch (e) {
      if (!(e instanceof Fatal)) throw e;
      this.error(e.code, e.message, e.line, e.fix !== undefined ? { fix: e.fix } : {});
    }
  }

  document(el: El): void {
    for (const a of el.attrs) {
      if (a.name === "title" && a.kind === "string") this.doc.title = a.value;
      else if (a.name === "title") this.error("T303", "title is a literal string: <slate title=\"...\">", a.line);
      else this.error("T302", `<slate> takes title alone, not ${a.name}`, a.line, { fix: "title" });
    }
    if (el.text !== undefined) this.error("P100", "<slate> takes elements, not text; put the words in a <text>", el.line);
    for (const ch of el.children) if (DECLARATIONS.has(ch.tag)) this.guard(() => this.declareName(ch));
    const pieces = el.children.filter(ch => !DECLARATIONS.has(ch.tag));
    for (const p of pieces) for (const id of explicitIds(p)) this.taken.add(id);
    for (const ch of el.children) if (DECLARATIONS.has(ch.tag)) this.guard(() => this.declaration(ch));
    if (pieces.length !== 1) {
      const names = pieces.map(p => p.attrs.find(a => a.name === "id")?.value ?? p.tag);
      this.error("D202", pieces.length === 0 ? "there is no piece; write one, like <column>" : `${pieces.length} pieces at the top (${names.join(", ")}); wrap them in a <column>`, pieces[1]?.line ?? el.line, { fix: "<column>...</column>" });
    }
    if (pieces[0] !== undefined) this.doc.root = this.piece(pieces[0]) ?? "";
    for (const extra of pieces.slice(1)) this.piece(extra);
  }

  declareName(el: El): void {
    if (el.tag === "when") return;
    const name = el.attrs.find(a => a.name === "name");
    if (name === undefined || name.kind !== "string") throw new Fatal("P103", `<${el.tag}> needs name="..."`, el.line);
    if (!SLATE_NAME.test(name.value)) throw new Fatal("P103", `"${name.value}" is not a name: a lowercase letter or _, then letters, digits and _`, name.line, name.value.replace(/^[^a-z_]+/, "").replace(/[^a-zA-Z0-9_]/g, "_") || undefined);
    if (this.names.has(name.value) && !this.patch) throw new Fatal("P104", `$${name.value} is declared twice`, el.line);
    this.names.set(name.value, el.tag);
  }

  declaration(el: El): void {
    const allowed: Record<string, readonly string[]> = {
      value: ["name", "start"], secret: ["name", "keep"], derived: ["name", "value"],
      run: ["name", "cmd", "tool", "resource", "env", "args", "stdin", "on", "cwd", "timeout", "stream", "confirm", "every", "once", "always"],
      when: ["id", "change", "done", "do"],
    };
    const ok = allowed[el.tag]!;
    for (const a of el.attrs) if (!ok.includes(a.name)) this.error("T302", `<${el.tag}> has no attribute ${a.name}; it takes ${ok.join(", ")}`, a.line, { fix: nearest(a.name, ok) });
    if ((el.text !== undefined || el.children.length > 0) && !(el.tag === "when" && el.attrs.every(a => a.name !== "do"))) {
      const hint = el.tag === "when" ? "when takes do={steps}" : `<${el.tag}> is self-closing and takes no children`;
      this.error("A601", hint, el.line, el.tag === "when" ? { fix: "<when change={$id} do={start($check)} />" } : {});
    }
    const attr = (n: string): Attr | undefined => el.attrs.find(a => a.name === n);
    const name = attr("name")?.value ?? "";
    const key = el.tag === "when" ? "" : `$${name}`;
    if (el.tag !== "when") this.lines.set(key, el.line);
    switch (el.tag) {
      case "value": {
        const start = attr("start");
        this.doc.values[name] = { start: start === undefined ? null : this.literal(start, key) };
        break;
      }
      case "secret":
        this.doc.values[name] = { start: null, secret: true, ...(attr("keep") !== undefined ? { keep: true as const } : {}) };
        break;
      case "derived": {
        const v = attr("value");
        if (v === undefined || v.kind !== "braced") { this.error("T304", `<derived name="${name}"> needs value={formula}`, el.line, { piece: key, prop: "value" }); break; }
        this.doc.derived[name] = v.value.trim();
        this.lines.set(`${key}.value`, v.line);
        break;
      }
      case "run": this.run(el, name); break;
      case "when": this.reaction(el); break;
    }
  }

  private run(el: El, name: string): void {
    const key = `$${name}`;
    const attr = (n: string): Attr | undefined => el.attrs.find(a => a.name === n);
    for (const a of el.attrs) this.lines.set(`${key}.${a.name}`, a.line);
    const kinds = (["cmd", "tool", "resource"] as const).filter(k => attr(k) !== undefined);
    if (kinds.length !== 1) { this.error("K701", `<run name="${name}"> takes exactly one of cmd, tool or resource`, el.line, { piece: key }); return; }
    const common: { confirm?: string; every?: number; once?: true; always?: true } = {};
    const every = attr("every");
    if (every !== undefined) {
      const s = seconds(every);
      if (!Number.isFinite(s)) this.error("K703", "every takes seconds: every=\"30s\" or every={30}", every.line, { piece: key, prop: "every" });
      else common.every = s;
    }
    if (attr("once") !== undefined) common.once = true;
    if (attr("always") !== undefined) common.always = true;
    const confirm = attr("confirm");
    if (confirm !== undefined) { if (confirm.kind !== "string") this.error("T303", "confirm is a sentence in quotes", confirm.line, { piece: key, prop: "confirm" }); else common.confirm = confirm.value; }
    const kind = kinds[0]!;
    let run: SlateRunDecl;
    if (kind === "cmd") {
      const cmd = attr("cmd")!;
      const literal = cmd.kind === "string" ? cmd.value : cmd.kind === "braced" ? stringLiteral(cmd.value) : undefined;
      if (literal === undefined) this.error("K700", "the command is literal; hand values to it with env={{ NAME: $value }}, args={[...]} or stdin={...}", cmd.line, { piece: key, prop: "cmd", fix: "cmd='gh api \"$URL\"' env={{ URL: $url }}" });
      const r: Extract<SlateRunDecl, { kind: "cmd" }> = { kind: "cmd", cmd: literal ?? "", ...common };
      const env = attr("env");
      if (env !== undefined) { const o = this.object(env, key); if (o !== undefined) r.env = o; }
      const args = attr("args");
      if (args !== undefined) { const l = this.array(args, key); if (l !== undefined) r.args = l; }
      const stdin = attr("stdin");
      if (stdin !== undefined) r.stdin = this.value(stdin);
      const on = attr("on");
      if (on !== undefined) {
        if (on.kind !== "string" || (on.value !== "thread" && on.value !== "host")) this.error("K704", "on is \"thread\" or \"host\"", on.line, { piece: key, prop: "on" });
        else r.on = on.value;
      }
      const cwd = attr("cwd");
      if (cwd !== undefined) { if (cwd.kind !== "string") this.error("T303", "cwd is a literal path", cwd.line, { piece: key, prop: "cwd" }); else r.cwd = cwd.value; }
      const timeout = attr("timeout");
      if (timeout !== undefined) {
        const s = seconds(timeout);
        if (!Number.isFinite(s)) this.error("K704", "timeout is seconds: timeout={20}", timeout.line, { piece: key, prop: "timeout" });
        else r.timeout = s;
      }
      if (attr("stream") !== undefined) r.stream = true;
      for (const n of ["tool", "resource"]) if (attr(n) !== undefined) this.error("K701", `a cmd run takes no ${n}`, el.line, { piece: key });
      run = r;
    } else if (kind === "tool") {
      const tool = attr("tool")!;
      const dot = tool.value.indexOf(".");
      if (tool.kind !== "string" || dot <= 0 || dot === tool.value.length - 1) this.error("K705", "tool names a server and a tool as \"server.tool\"", tool.line, { piece: key, prop: "tool" });
      const r: Extract<SlateRunDecl, { kind: "tool" }> = { kind: "tool", server: tool.value.slice(0, Math.max(0, dot)), tool: tool.value.slice(dot + 1), ...common };
      const args = attr("args");
      if (args !== undefined) { const o = this.object(args, key); if (o !== undefined) r.args = o; }
      for (const n of ["env", "stdin", "on", "cwd", "timeout", "stream"]) if (attr(n) !== undefined) this.error("K701", `a tool run takes no ${n}`, el.line, { piece: key });
      run = r;
    } else {
      const res = attr("resource")!;
      const colon = res.value.indexOf(":");
      if (res.kind !== "string" || colon <= 0) this.error("K705", "resource names a server and a uri as \"server:uri\"", res.line, { piece: key, prop: "resource" });
      run = { kind: "resource", server: res.value.slice(0, Math.max(0, colon)), uri: res.value.slice(colon + 1), ...(common.every !== undefined ? { every: common.every } : {}), ...(common.always ? { always: true as const } : {}) };
      for (const n of ["env", "args", "stdin", "on", "cwd", "timeout", "stream", "confirm", "once"]) if (attr(n) !== undefined) this.error("K701", `a resource run takes no ${n}`, el.line, { piece: key });
    }
    this.doc.runs[name] = run;
  }

  private reaction(el: El): void {
    const attr = (n: string): Attr | undefined => el.attrs.find(a => a.name === n);
    const change = attr("change");
    const done = attr("done");
    const doAttr = attr("do");
    const id = attr("id");
    const key = id?.kind === "string" ? id.value : `reaction-${this.doc.reactions.length + 1}`;
    this.lines.set(key, el.line);
    if (this.patch && (id === undefined || id.kind !== "string")) this.error("P107", "a reaction in a patch carries an id, so a later patch can name it", el.line, { fix: "<when id=\"check-on-id\" ... />" });
    if ((change === undefined) === (done === undefined)) { this.error("A611", "<when> takes exactly one of change={...} or done={$run}", el.line, { piece: key }); return; }
    if (doAttr === undefined || doAttr.kind !== "braced") { this.error("A601", "when takes do={steps}", el.line, { piece: key, fix: "<when change={$id} do={start($check)} />" }); return; }
    let on: SlateReactionDecl["on"];
    if (change !== undefined) {
      if (change.kind !== "braced") { this.error("A601", "change takes a path or a list of paths in braces: change={$id}", change.line, { piece: key }); return; }
      const text = change.value.trim();
      const items = text.startsWith("[") && text.endsWith("]") ? splitTop(text.slice(1, -1)) : [text];
      const paths: string[] = [];
      for (const t of items) {
        const p = pathOf(t);
        if (p === undefined) { this.error("A601", `change lists paths, not formulas: ${t.trim()}`, change.line, { piece: key }); continue; }
        paths.push(p);
      }
      on = { change: paths };
    } else {
      const p = done!.kind === "braced" ? /^\s*\$([a-zA-Z_][a-zA-Z0-9_]*)\s*$/.exec(done!.value) : null;
      if (p === null) { this.error("K702", "done names a run: done={$check}", done!.line, { piece: key }); return; }
      on = { done: p[1]! };
    }
    this.lines.set(`${key}.do`, doAttr.line);
    const steps = this.steps(doAttr, key);
    this.doc.reactions.push({ ...(id?.kind === "string" ? { id: id.value } : {}), on, do: steps });
  }

  /** A handler's steps: one step call or a list of them (03, the steps rule). */
  steps(a: Attr, piece: string): SlateStep[] {
    const at = { piece, prop: a.name };
    if (a.kind !== "braced") { this.error("A600", "a handler is a step or a list of steps in braces: onPress={set($x, 1)}", a.line, at); return []; }
    let text = a.value.trim();
    if (/^\(?[^()]*\)?\s*=>/.test(text) || text.startsWith("function")) {
      const body = text.replace(/^\(?[^()]*\)?\s*=>\s*/, "");
      this.error("A600", "a handler is a step or a list of steps, not a function", a.line, { ...at, fix: `${a.name}={${body}}` });
      return [];
    }
    const list = text.startsWith("[") && text.endsWith("]");
    if (list) text = text.slice(1, -1);
    const out: SlateStep[] = [];
    for (const call of list ? splitTop(text) : [text]) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/.exec(call);
      if (m === null) { this.error("A600", `"${call.trim()}" is not a step; steps are ${Object.keys(SLATE_STEPS).join(", ")}`, a.line, at); continue; }
      const kind = m[1]!;
      if (SLATE_STEPS[kind] === undefined) {
        const fix = kind === "setState" ? "set" : kind === "navigate" || kind === "openUrl" ? "open" : nearest(kind, Object.keys(SLATE_STEPS));
        this.error("A600", `${kind} is not a step; steps are ${Object.keys(SLATE_STEPS).join(", ")}`, a.line, { ...at, fix });
        continue;
      }
      const args = splitTop(m[2]!).map(s => s.trim());
      const bad = (message: string, fix?: string): void => this.error("A601", `${kind}: ${message}`, a.line, { ...at, fix });
      const own = (s: string | undefined): string | undefined => (s !== undefined && /^\$[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[-?\d+\])*$/.test(s) ? s : undefined);
      switch (kind) {
        case "set": {
          const path = own(args[0]);
          if (path === undefined || args.length !== 2) { bad("set writes one of the slate's values: set($name, value)", "set($step, 2)"); break; }
          out.push({ do: "set", path, value: this.valueText(args[1]!) });
          break;
        }
        case "toggle": {
          const path = own(args[0]);
          if (path === undefined || args.length !== 1) { bad("toggle flips one of the slate's values: toggle($name)"); break; }
          out.push({ do: "toggle", path });
          break;
        }
        case "start": case "cancel": {
          const r = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(args[0] ?? "");
          if (r === null || args.length !== 1) { bad(`${kind} names a run: ${kind}($check)`); break; }
          out.push({ do: kind, run: r[1]! });
          break;
        }
        case "send": case "steer": case "queue": case "fill": {
          const t = args[0] !== undefined ? stringLiteral(args[0]) : undefined;
          if (t === undefined) { this.error("A603", `${kind}'s text is a literal string; put the changing parts after it as paths`, a.line, { ...at, fix: `${kind}("What to do.", $path)` }); break; }
          const paths: string[] = [];
          for (const p of args.slice(1)) {
            const path = pathOf(p);
            if (path === undefined) { bad(`${p} is not a path; ${kind} carries paths after its text, as data`); continue; }
            paths.push(path);
          }
          out.push({ do: kind, text: t, ...(paths.length > 0 ? { with: paths } : {}) });
          break;
        }
        case "open": case "copy": {
          if (args.length !== 1) { bad(`${kind} takes one value`); break; }
          const v = this.valueText(args[0]!);
          out.push(kind === "open" ? { do: "open", target: v } : { do: "copy", text: v });
          break;
        }
        case "pane": {
          const p = args[0] !== undefined ? stringLiteral(args[0]) : undefined;
          if (p === undefined || !(SLATE_PANE_KINDS as readonly string[]).includes(p)) { bad(`pane names one of ${SLATE_PANE_KINDS.join(", ")}`, nearest(p ?? "", SLATE_PANE_KINDS)); break; }
          out.push({ do: "pane", kind: p as (typeof SLATE_PANE_KINDS)[number] });
          break;
        }
      }
    }
    return out;
  }

  piece(el: El, depth = 1): string | undefined {
    if (DECLARATIONS.has(el.tag)) { this.error("P100", `<${el.tag}> is a declaration and goes directly under <slate>`, el.line); return undefined; }
    if ((SLATE_ITEM_KINDS as readonly string[]).includes(el.tag)) { this.error("T314", `<${el.tag}> is an item and goes inside the piece that takes it`, el.line); return undefined; }
    const spec = SLATE_PIECES[el.tag];
    const idAttr = el.attrs.find(a => a.name === "id");
    let id: string;
    if (idAttr !== undefined && idAttr.kind === "string" && SLATE_ID.test(idAttr.value)) {
      id = idAttr.value;
      if (this.doc.pieces[id] !== undefined || this.names.has(id)) this.error("P104", `${id} is used twice`, idAttr.line, { piece: id });
    } else {
      if (idAttr !== undefined) this.error("P103", `"${idAttr.value}" is not a piece id: lowercase letters, digits and dashes, starting with a letter`, idAttr.line, { fix: idAttr.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || undefined });
      id = this.mint(el.tag);
    }
    this.doc.pieces[id] = { type: el.tag };
    this.lines.set(id, el.line);
    const piece: SlatePiece = { type: el.tag };
    const props: Record<string, SlatePropValue> = {};
    for (const a of el.attrs) {
      if (a.name === "id") continue;
      this.lines.set(`${id}.${a.name}`, a.line);
      this.guard(() => {
        if (a.name === "when") {
          if (a.kind !== "braced") throw new Fatal("T303", `when takes a formula in braces: when={${a.kind === "string" ? a.value : "..."}}`, a.line);
          piece.when = a.value.trim();
          return;
        }
        if (a.name === "fallback") {
          if (a.kind === "string") piece.fallback = a.value;
          else { const t = a.kind === "braced" ? stringLiteral(a.value) : undefined; if (t === undefined) throw new Fatal("T303", "fallback is drop, a piece id or a sentence in braces", a.line); piece.fallback = { text: t }; }
          return;
        }
        if (/^on[A-Z]/.test(a.name)) {
          const event = a.name.slice(2).toLowerCase();
          if (event !== "press" && event !== "submit" && event !== "change") { this.error("A602", `${a.name} is not an event; events are onPress, onSubmit and onChange`, a.line, { piece: id, prop: a.name, fix: a.name === "onInput" ? "onChange" : "onPress" }); return; }
          (piece.on ??= {})[event] = this.steps(a, id);
          return;
        }
        if (a.kind === "bare") {
          const ps = spec?.props[a.name];
          if (ps !== undefined && ps.type !== "boolean") {
            const owner = Object.entries(spec!.props).find(([, s]) => Array.isArray(s.type) && (s.type as readonly string[]).includes(a.name));
            this.error("P102", `${a.name} is not a boolean prop of ${el.tag}`, a.line, { piece: id, prop: a.name, fix: owner !== undefined ? `${owner[0]}="${a.name}"` : `${a.name}="..."` });
            return;
          }
          if (ps === undefined && spec !== undefined && !(a.name in spec.props)) {
            const owner = Object.entries(spec.props).find(([, s]) => Array.isArray(s.type) && (s.type as readonly string[]).includes(a.name));
            if (owner !== undefined) { this.error("P102", `${a.name} is not a boolean prop of ${el.tag}`, a.line, { piece: id, prop: a.name, fix: `${owner[0]}="${a.name}"` }); return; }
          }
          props[a.name] = true;
          return;
        }
        if (spec?.props[a.name]?.type === "path" && a.kind === "braced" && /^\s*\$[A-Za-z_][A-Za-z0-9_]*\s*$/.test(a.value)) { props[a.name] = a.value.trim(); return; }
        props[a.name] = this.value(a);
      });
    }
    if (spec !== undefined && el.raw !== undefined && spec.textProp !== undefined) props[spec.textProp] = el.raw;
    if (el.text !== undefined) {
      if (spec?.textProp === undefined) this.error("P100", `${el.tag} takes elements, not text; put the words in a <text>`, el.line, { piece: id });
      else if (props[spec.textProp] !== undefined) this.error("T303", `${el.tag} has both ${spec.textProp}= and a text child; use one`, el.line, { piece: id, prop: spec.textProp });
      else { props[spec.textProp] = this.textChild(el.text); this.lines.set(`${id}.${spec.textProp}`, el.line); }
    }
    const children: string[] = [];
    for (const ch of el.children) {
      if ((SLATE_ITEM_KINDS as readonly string[]).includes(ch.tag)) {
        const itemSpec = spec?.items[ch.tag];
        if (itemSpec === undefined) {
          const kinds = Object.keys(spec?.items ?? {});
          this.error("T314", kinds.length === 0 ? `${el.tag} takes no items, not <${ch.tag}>` : `${el.tag} takes ${kinds.map(k => `<${k}>`).join(" and ")}, not <${ch.tag}>`, ch.line, { piece: id });
          continue;
        }
        const list = (props[itemSpec.prop] ??= []) as SlatePropValue[];
        this.lines.set(`${id}.${itemSpec.prop}[${list.length}]`, ch.line);
        list.push(this.item(ch, itemSpec, id, `${itemSpec.prop}[${list.length}]`));
        continue;
      }
      const child = this.piece(ch, depth + 1);
      if (child !== undefined) children.push(child);
    }
    if (Object.keys(props).length > 0) piece.props = props;
    if (children.length > 0) piece.children = children;
    // Key order as stored: type, when, props, children, on, fallback.
    this.doc.pieces[id] = {
      type: piece.type,
      ...(piece.when !== undefined ? { when: piece.when } : {}),
      ...(piece.props !== undefined ? { props: piece.props } : {}),
      ...(piece.children !== undefined ? { children: piece.children } : {}),
      ...(piece.on !== undefined ? { on: piece.on } : {}),
      ...(piece.fallback !== undefined ? { fallback: piece.fallback } : {}),
    };
    return id;
  }

  private item(el: El, spec: SlateItemSpec, pieceId: string, where: string): SlatePropValue {
    const out: Record<string, SlatePropValue> = {};
    for (const a of el.attrs) {
      this.lines.set(`${pieceId}.${where}.${a.name}`, a.line);
      if (/^on[A-Z]/.test(a.name)) {
        const event = a.name.slice(2).toLowerCase();
        if (!(spec.events ?? []).includes(event as "press")) { this.error("A602", `<${el.tag}> has no ${a.name}${spec.events !== undefined ? `; it has ${spec.events.map(e => `on${e[0]!.toUpperCase()}${e.slice(1)}`).join(", ")}` : ""}`, a.line, { piece: pieceId, prop: `${where}.${a.name}` }); continue; }
        out.on = { ...(out.on as object | undefined), [event]: this.steps(a, pieceId) as unknown as SlatePropValue };
        continue;
      }
      if (a.name === "when") {
        if (a.kind !== "braced") { this.error("T303", "when takes a formula in braces", a.line, { piece: pieceId, prop: `${where}.when` }); continue; }
        out.when = a.value.trim();
        continue;
      }
      out[a.name] = a.kind === "bare" ? true : this.value(a);
    }
    if (el.text !== undefined || el.children.length > 0 || el.raw !== undefined) this.error("P100", `<${el.tag}> is self-closing: <${el.tag} ... />`, el.line, { piece: pieceId });
    return out;
  }

  /** An attribute's stored value: a string literal as written; in braces, a literal formula as its value, a
   * template as a format, a list or record as one of values, anything else a binding. */
  value(a: Attr): SlatePropValue {
    if (a.kind === "bare") return true;
    if (a.kind === "string") return a.value;
    const text = a.value.trim();
    if (text.startsWith("[") && text.endsWith("]")) return this.array(a, "") ?? [];
    if (text.startsWith("{") && text.endsWith("}")) return this.object(a, "") ?? {};
    return this.valueText(text);
  }

  valueText(text: string): SlatePropValue {
    const t = text.trim();
    const { ast } = parseSlateExpression(t);
    if (ast?.k === "lit") return ast.v;
    if (ast?.k === "neg" && ast.arg.k === "lit" && typeof ast.arg.v === "number") return -ast.arg.v;
    if (ast?.k === "tpl") return { format: t.slice(1, -1) };
    return { bind: t };
  }

  private textChild(parts: (string | Hole)[]): SlatePropValue {
    let format = "";
    let holes = 0;
    for (const p of parts) {
      if (typeof p === "string") format += normalizeRun(p).replace(/\$\{/g, "$${");
      else {
        const e = p.expr.trim();
        if (e.startsWith("/*") && e.endsWith("*/")) continue;
        const lit = stringLiteral(e);
        if (lit !== undefined) { format += lit.replace(/\$\{/g, "$${"); continue; }
        format += `\${${e}}`;
        holes++;
      }
    }
    format = format.replace(/^\s+|\s+$/g, "");
    return holes === 0 ? format.replace(/\$\$\{/g, "${") : { format };
  }

  private literal(a: Attr, piece: string): SlateJson {
    if (a.kind === "string") return a.value;
    if (a.kind === "bare") return true;
    try { return parseSlateLiteral(a.value.trim()); } catch (e) {
      this.error("S503", `start takes a literal (a string, a number, true, false, null, a list or a record of literals): ${(e as Error).message}`, a.line, { piece, prop: "start" });
      return null;
    }
  }

  private object(a: Attr, piece: string): Record<string, SlatePropValue> | undefined {
    const text = a.value.trim();
    if (a.kind !== "braced" || !text.startsWith("{") || !text.endsWith("}")) { this.error("A601", `${a.name} takes an object: ${a.name}={{ NAME: $value }}`, a.line, { piece, prop: a.name }); return undefined; }
    const out: Record<string, SlatePropValue> = {};
    for (const part of splitTop(text.slice(1, -1))) {
      const m = /^\s*(?:([A-Za-z_][A-Za-z0-9_]*)|"([^"]*)"|'([^']*)')\s*:\s*([\s\S]+)$/.exec(part);
      if (m === null) { this.error("A601", `cannot read "${part.trim()}" as key: value in ${a.name}`, a.line, { piece, prop: a.name }); continue; }
      out[m[1] ?? m[2] ?? m[3]!] = this.valueText(m[4]!);
    }
    return out;
  }

  private array(a: Attr, piece: string): SlatePropValue[] | undefined {
    const text = a.value.trim();
    if (a.kind !== "braced" || !text.startsWith("[") || !text.endsWith("]")) { this.error("A601", `${a.name} takes a list: ${a.name}={[$a, 'x']}`, a.line, { piece, prop: a.name }); return undefined; }
    return splitTop(text.slice(1, -1)).map(part => this.valueText(part));
  }

  private mint(type: string): string {
    const base = /^[a-z][a-z0-9-]*$/.test(type) ? type : "piece";
    let n = this.minted.get(base) ?? 0;
    let id: string;
    do id = `${base}-${++n}`; while (this.taken.has(id) || this.doc.pieces[id] !== undefined);
    this.minted.set(base, n);
    return id;
  }

  // ---- patches ----

  patchOps(tops: El[], current: SlateDoc | null): SlatePatchOp[] {
    const ops: SlatePatchOp[] = [];
    for (const el of tops) for (const id of explicitIds(el)) if (current?.pieces[id] === undefined) this.taken.add(id);
    for (const el of tops) {
      const attr = (n: string): Attr | undefined => el.attrs.find(a => a.name === n);
      const lit = (n: string): string | undefined => { const a = attr(n); return a?.kind === "string" ? a.value : a?.kind === "braced" ? stringLiteral(a.value) : undefined; };
      const at = (): number | undefined => { const a = attr("at"); if (a === undefined) return undefined; const n = Number(a.value); if (!Number.isInteger(n)) this.error("P105", "at is a whole number: at={0}", a.line); return n; };
      const under = (): string => { const u = lit("under") ?? ""; return u === "root" && current?.pieces.root === undefined ? (current?.root ?? u) : u; };
      switch (el.tag) {
        case "clear": case "undo": ops.push({ op: el.tag }); continue;
        case "remove": {
          const id = lit("id");
          const name = lit("name");
          if ((id === undefined) === (name === undefined)) { this.error("P105", "<remove> takes id=\"...\" for a piece or a reaction, or name=\"...\" for a declaration", el.line); continue; }
          if (name !== undefined) {
            if (current?.derived[name] !== undefined) ops.push({ op: "derived", name, expr: null });
            else if (current?.runs[name] !== undefined) ops.push({ op: "run", name, decl: null });
            else if (current?.values[name] !== undefined) ops.push({ op: "value", name, decl: null });
            else this.error("D203", `nothing is declared as $${name}`, el.line, { fix: nearest(name, [...this.names.keys()]) });
            continue;
          }
          if (current?.pieces[id!] === undefined && current?.reactions.some(r => r.id === id)) ops.push({ op: "reaction", id: id!, reaction: null });
          else ops.push({ op: "remove", id: id! });
          continue;
        }
        case "move": {
          const id = lit("id");
          if (id === undefined || attr("under") === undefined) { this.error("P105", "<move> takes id and under", el.line); continue; }
          const n = at();
          ops.push({ op: "move", id, under: under(), ...(n !== undefined ? { at: n } : {}) });
          continue;
        }
        case "add": {
          if (attr("under") === undefined) { this.error("P105", "<add> takes under=\"<id>\"", el.line); continue; }
          const before = new Set(Object.keys(this.doc.pieces));
          const order = el.children.map(ch => this.piece(ch, 2)).filter((x): x is string => x !== undefined);
          const pieces = Object.fromEntries(Object.entries(this.doc.pieces).filter(([k]) => !before.has(k)));
          const n = at();
          ops.push({ op: "add", under: under(), ...(n !== undefined ? { at: n } : {}), pieces, order });
          continue;
        }
        case "props": {
          const id = lit("id");
          if (id === undefined) { this.error("P105", "<props> takes id=\"...\"", el.line); continue; }
          const op: Extract<SlatePatchOp, { op: "props" }> = { op: "props", id };
          for (const a of el.attrs) {
            if (a.name === "id") continue;
            this.lines.set(`${id}.${a.name}`, a.line);
            const isNull = a.kind === "braced" && a.value.trim() === "null";
            if (a.name === "when") { op.when = isNull ? null : a.kind === "braced" ? a.value.trim() : (this.error("T303", "when takes a formula in braces", a.line, { piece: id, prop: "when" }), null); continue; }
            if (a.name === "fallback") { op.fallback = isNull ? null : a.kind === "string" ? a.value : { text: stringLiteral(a.value) ?? "" }; continue; }
            if (/^on[A-Z]/.test(a.name)) { (op.on ??= {})[a.name.slice(2).toLowerCase() as "press"] = this.steps(a, id); continue; }
            (op.props ??= {})[a.name] = isNull ? null : this.value(a);
          }
          ops.push(op);
          continue;
        }
      }
      if (DECLARATIONS.has(el.tag)) {
        this.guard(() => this.declareName(el));
        const before = this.doc.reactions.length;
        this.declaration(el);
        const name = attr("name")?.value ?? "";
        if (el.tag === "value" || el.tag === "secret") { if (this.doc.values[name] !== undefined) ops.push({ op: "value", name, decl: this.doc.values[name]! }); }
        else if (el.tag === "derived") { if (this.doc.derived[name] !== undefined) ops.push({ op: "derived", name, expr: this.doc.derived[name]! }); }
        else if (el.tag === "run") { if (this.doc.runs[name] !== undefined) ops.push({ op: "run", name, decl: this.doc.runs[name]! }); }
        else if (this.doc.reactions.length > before) { const r = this.doc.reactions.at(-1)!; ops.push({ op: "reaction", id: r.id ?? "", reaction: r }); }
        continue;
      }
      if (PATCH_TAGS.has(el.tag)) continue;
      if (SLATE_PIECES[el.tag] !== undefined || !(SLATE_ITEM_KINDS as readonly string[]).includes(el.tag)) {
        const id = lit("id");
        if (id === undefined) { this.error("P105", `a piece at the top of a patch replaces the piece with its id, so <${el.tag}> needs id="..."`, el.line, { fix: `<add under="${current?.root ?? "root"}"><${el.tag} ... /></add>` }); continue; }
        if (current !== null && current.pieces[id] === undefined) { this.error("D203", `there is no piece ${id} to replace; add it with <add under="...">`, el.line, { fix: nearest(id, Object.keys(current.pieces)) }); continue; }
        this.taken.delete(id);
        const before = new Set(Object.keys(this.doc.pieces));
        this.piece(el, 2);
        const children = Object.fromEntries(Object.entries(this.doc.pieces).filter(([k]) => !before.has(k) && k !== id));
        ops.push({ op: "replace", id, piece: this.doc.pieces[id]!, ...(Object.keys(children).length > 0 ? { children } : {}) });
        continue;
      }
      this.error("P105", `a patch is pieces with an id, <props>, <add>, <remove>, <move>, declarations, <clear> or <undo>; not <${el.tag}>`, el.line);
    }
    return ops;
  }
}

function explicitIds(el: El): string[] {
  const out: string[] = [];
  const id = el.attrs.find(a => a.name === "id");
  if (id !== undefined && id.kind === "string") out.push(id.value);
  for (const ch of el.children) out.push(...explicitIds(ch));
  return out;
}

/** A quoted string literal's value, or undefined when the text is anything else. */
function stringLiteral(text: string): string | undefined {
  const { ast } = parseSlateExpression(text.trim());
  return ast?.k === "lit" && typeof ast.v === "string" ? ast.v : undefined;
}

/** A path's text, normalised, or undefined when the text is a formula rather than a path. */
function pathOf(text: string): string | undefined {
  const { ast } = parseSlateExpression(text.trim());
  return ast?.k === "path" ? slatePathText(ast.head, ast.own, ast.segs) : undefined;
}

/** Compiles the JSX-like text to a document and its lines, without validating it. */
export function compileSlateText(text: string): { document?: SlateDoc; lines: SlateLines; errors: SlateProblem[] } {
  const c = new Compiler();
  let tops: El[];
  try { tops = new Reader(text).elements(); } catch (e) {
    if (!(e instanceof Fatal)) throw e;
    return { lines: c.lines, errors: [slateProblem(e.code, e.message, { line: e.line, fix: e.fix })] };
  }
  if (tops.length !== 1 || tops[0]!.tag !== "slate") {
    const first = tops.find(t => t.tag !== "slate");
    return { lines: c.lines, errors: [slateProblem("D202", tops.length === 0 ? "there is no <slate> element" : `a document is one <slate> element with the pieces inside it; found ${tops.map(t => `<${t.tag}>`).join(", ")}`, { line: first?.line ?? 1, fix: "<slate title=\"...\">...</slate>" })] };
  }
  c.document(tops[0]!);
  return { ...(c.errors.length === 0 ? { document: c.doc } : {}), lines: c.lines, errors: c.errors };
}

/** The JSX-like form compiled and validated: the document when there are no errors, every error otherwise. */
export function parseSlate(text: string): { document?: SlateDoc; errors: SlateProblem[]; warnings: SlateProblem[] } {
  const compiled = compileSlateText(text);
  if (compiled.document === undefined) return { errors: compiled.errors, warnings: [] };
  const v = validateDocument(compiled.document, compiled.lines);
  return { ...(v.errors.length === 0 ? { document: compiled.document } : {}), errors: v.errors, warnings: v.warnings };
}

/** A patch: top-level elements without <slate>, compiled against the document it will apply to. The ops are
 * checked for shape here; applySlatePatch validates the whole patched result. */
export function parseSlatePatch(text: string, current: SlateDoc | null): { patch?: SlatePatch; errors: SlateProblem[]; lines: SlateLines } {
  const c = new Compiler(current);
  c.patch = true;
  let tops: El[];
  try { tops = new Reader(text).elements(); } catch (e) {
    if (!(e instanceof Fatal)) throw e;
    return { errors: [slateProblem(e.code, e.message, { line: e.line, fix: e.fix })], lines: c.lines };
  }
  if (tops.some(t => t.tag === "slate")) return { errors: [slateProblem("P105", "a patch is elements without <slate>; to rewrite the whole slate, write the <slate> alone", { line: 1 })], lines: c.lines };
  if (tops.length === 0) return { errors: [slateProblem("P105", "the patch is empty", { line: 1 })], lines: c.lines };
  const ops = c.patchOps(tops, current);
  const alone = ops.find(o => o.op === "clear" || o.op === "undo");
  if (alone !== undefined && ops.length > 1) c.error("P105", `<${alone.op} /> stands alone in its write`, 1);
  return { ...(c.errors.length === 0 ? { patch: { ops } } : {}), errors: c.errors, lines: c.lines };
}

// ---- printing ----

const ATTR_ORDER_LAST = ["when"];

function quoteAttr(s: string): string {
  if (!s.includes('"') && !s.endsWith("\\")) return `"${s}"`;
  if (!s.includes("'") && !s.endsWith("\\")) return `'${s}'`;
  return `{${exprString(s)}}`;
}

/** A string as a formula's string literal. */
const exprString = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}'`;

function literalText(v: SlateJson): string {
  if (v === null || typeof v !== "object") return typeof v === "string" ? exprString(v) : String(v);
  if (Array.isArray(v)) return `[${v.map(literalText).join(", ")}]`;
  return `{ ${Object.entries(v).map(([k, x]) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k)}: ${literalText(x)}`).join(", ")} }`;
}

/** A prop value as an expression inside braces or a step's argument. */
function valueExpr(v: SlatePropValue): string {
  if (isSlateBinding(v)) return v.bind;
  if (isSlateFormat(v)) return `\`${v.format}\``;
  if (v === null || typeof v !== "object") return literalText(v);
  if (Array.isArray(v)) return `[${v.map(valueExpr).join(", ")}]`;
  return `{ ${Object.entries(v).map(([k, x]) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k)}: ${valueExpr(x)}`).join(", ")} }`;
}

function attrText(name: string, v: SlatePropValue): string {
  if (v === true) return name;
  if (typeof v === "string") return `${name}=${quoteAttr(v)}`;
  if (Array.isArray(v)) return `${name}={[${v.map(valueExpr).join(", ")}]}`;
  if (v !== null && typeof v === "object" && !isSlateBinding(v) && !isSlateFormat(v)) return `${name}={${valueExpr(v)}}`;
  return `${name}={${valueExpr(v)}}`;
}

function stepText(s: SlateStep): string {
  switch (s.do) {
    case "set": return `set(${s.path}, ${valueExpr(s.value)})`;
    case "toggle": return `toggle(${s.path})`;
    case "start": case "cancel": return `${s.do}($${s.run})`;
    case "send": case "steer": case "queue": case "fill": return `${s.do}(${[JSON.stringify(s.text), ...(s.with ?? [])].join(", ")})`;
    case "open": return `open(${valueExpr(s.target)})`;
    case "copy": return `copy(${valueExpr(s.text)})`;
    case "pane": return `pane(${JSON.stringify(s.kind)})`;
  }
}

const stepsAttr = (name: string, steps: SlateStep[]): string =>
  `${name}={${steps.length === 1 ? stepText(steps[0]!) : `[${steps.map(stepText).join(", ")}]`}}`;

/** Whether a stored text value prints back as a text child unchanged. */
function asTextChild(v: SlatePropValue): string | undefined {
  if (typeof v === "string") {
    if (v === "" || /[<>{}\n]/.test(v) || v !== slateTextChildForm(v) || v.includes("${")) return undefined;
    return v;
  }
  if (isSlateFormat(v)) {
    if (/\n/.test(v.format) || v.format !== slateTextChildForm(v.format) || v.format.includes("$${")) return undefined;
    let out = "";
    let i = 0;
    const src = v.format;
    while (i < src.length) {
      if (src.startsWith("${", i)) {
        let depth = 1;
        let j = i + 2;
        let quote: string | undefined;
        for (; j < src.length; j++) {
          const c = src[j]!;
          if (quote !== undefined) { if (c === "\\") j++; else if (c === quote) quote = undefined; }
          else if (c === "'" || c === '"' || c === "`") quote = c;
          else if (c === "{") depth++;
          else if (c === "}" && --depth === 0) break;
        }
        out += `{${src.slice(i + 2, j)}}`;
        i = j + 1;
        continue;
      }
      if (/[<>{}]/.test(src[i]!)) return undefined;
      out += src[i];
      i++;
    }
    return out;
  }
  return undefined;
}

/** The document in the JSX-like form: declarations first (values, secrets, derived, runs, reactions), then the root
 * piece and its subtree, every id written, attributes in the catalog's prop order with when last. */
export function printSlate(doc: SlateDoc): string {
  const out: string[] = [`<slate${doc.title !== undefined ? ` title=${quoteAttr(doc.title)}` : ""}>`];
  const line = (depth: number, parts: string[], tail: string): void => {
    const indent = "  ".repeat(depth);
    let cur = `${indent}${parts[0]}`;
    for (const p of parts.slice(1)) {
      if (cur.length + 1 + p.length + tail.length > SLATE_LIMITS.printColumns && cur.trim() !== parts[0]) { out.push(cur); cur = `${indent}    ${p}`; }
      else cur += ` ${p}`;
    }
    out.push(`${cur}${tail}`);
  };
  const values = Object.entries(doc.values);
  for (const [name, v] of values.filter(([, v]) => v.secret !== true)) line(1, ["<value", `name="${name}"`, ...(v.start !== null ? [typeof v.start === "string" ? `start=${quoteAttr(v.start)}` : `start={${literalText(v.start)}}`] : [])], " />");
  for (const [name, v] of values.filter(([, v]) => v.secret === true)) line(1, ["<secret", `name="${name}"`, ...(v.keep === true ? ["keep"] : [])], " />");
  for (const [name, expr] of Object.entries(doc.derived)) line(1, ["<derived", `name="${name}"`, `value={${expr}}`], " />");
  for (const [name, r] of Object.entries(doc.runs)) {
    const parts = ["<run", `name="${name}"`];
    if (r.kind === "cmd") {
      parts.push(`cmd=${quoteAttr(r.cmd)}`);
      if (r.env !== undefined) parts.push(`env={${valueExpr(r.env)}}`);
      if (r.args !== undefined) parts.push(`args={[${r.args.map(valueExpr).join(", ")}]}`);
      if (r.stdin !== undefined) parts.push(attrText("stdin", r.stdin));
      if (r.on !== undefined) parts.push(`on="${r.on}"`);
      if (r.cwd !== undefined) parts.push(`cwd=${quoteAttr(r.cwd)}`);
      if (r.timeout !== undefined) parts.push(`timeout={${r.timeout}}`);
      if (r.stream === true) parts.push("stream");
    } else if (r.kind === "tool") {
      parts.push(`tool="${r.server}.${r.tool}"`);
      if (r.args !== undefined) parts.push(`args={${valueExpr(r.args)}}`);
    } else parts.push(`resource=${quoteAttr(`${r.server}:${r.uri}`)}`);
    if ("confirm" in r && r.confirm !== undefined) parts.push(`confirm=${quoteAttr(r.confirm)}`);
    if (r.every !== undefined) parts.push(`every={${r.every}}`);
    if ("once" in r && r.once === true) parts.push("once");
    if (r.always === true) parts.push("always");
    line(1, parts, " />");
  }
  for (const r of doc.reactions) {
    const parts = ["<when"];
    if (r.id !== undefined) parts.push(`id="${r.id}"`);
    if ("change" in r.on) parts.push(`change={${r.on.change.length === 1 ? r.on.change[0] : `[${r.on.change.join(", ")}]`}}`);
    else parts.push(`done={$${r.on.done}}`);
    parts.push(stepsAttr("do", r.do));
    line(1, parts, " />");
  }
  const seen = new Set<string>();
  const piece = (id: string, depth: number): void => {
    const p = doc.pieces[id];
    if (p === undefined || seen.has(id)) return;
    seen.add(id);
    const spec = SLATE_PIECES[p.type];
    const props = { ...(p.props ?? {}) };
    const isItemList = (v: SlatePropValue | undefined): boolean => Array.isArray(v) && v.every(x => x !== null && typeof x === "object" && !Array.isArray(x) && !isSlateBinding(x) && !isSlateFormat(x));
    const itemProps = new Map(Object.entries(spec?.items ?? {}).filter(([, s]) => isItemList(p.props?.[s.prop])).map(([tag, s]) => [s.prop, tag]));
    let text: string | undefined;
    let raw: string | undefined;
    if (spec?.textProp !== undefined && props[spec.textProp] !== undefined) {
      const v = props[spec.textProp]!;
      if (spec.rawText === true && typeof v === "string" && !v.includes(`</${p.type}>`)) { raw = v; delete props[spec.textProp]; }
      else if (spec.rawText !== true) { const t = asTextChild(v); if (t !== undefined) { text = t; delete props[spec.textProp]; } }
    }
    const order = [...Object.keys(spec?.props ?? {}), ...Object.keys(props)];
    const parts = [`<${p.type}`, `id="${id}"`];
    for (const name of [...new Set(order)]) {
      if (!(name in props) || itemProps.has(name) || ATTR_ORDER_LAST.includes(name)) continue;
      parts.push(attrText(name, props[name]!));
    }
    for (const [ev, steps] of Object.entries(p.on ?? {})) if (steps !== undefined) parts.push(stepsAttr(`on${ev[0]!.toUpperCase()}${ev.slice(1)}`, steps));
    if (p.fallback !== undefined) parts.push(typeof p.fallback === "string" ? `fallback=${quoteAttr(p.fallback)}` : `fallback={${exprString(p.fallback.text)}}`);
    if (p.when !== undefined) parts.push(`when={${p.when}}`);
    const items: string[][] = [];
    for (const [prop, tag] of itemProps) {
      const list = props[prop];
      if (!Array.isArray(list)) continue;
      for (const it of list) {
        const r = (it ?? {}) as Record<string, SlatePropValue>;
        const ip = [`<${tag}`];
        const fields = Object.keys(spec!.items[tag]!.fields);
        for (const k of [...new Set([...fields, ...Object.keys(r)])]) {
          if (!(k in r) || k === "on" || k === "when") continue;
          ip.push(attrText(k, r[k]!));
        }
        const on = r.on as Record<string, SlateStep[]> | undefined;
        for (const [ev, steps] of Object.entries(on ?? {})) ip.push(stepsAttr(`on${ev[0]!.toUpperCase()}${ev.slice(1)}`, steps));
        if (typeof r.when === "string") ip.push(`when={${r.when}}`);
        items.push(ip);
      }
    }
    const children = p.children ?? [];
    if (text === undefined && raw === undefined && items.length === 0 && children.length === 0) { line(depth, parts, " />"); return; }
    if (raw !== undefined) { line(depth, parts, `>${raw}</${p.type}>`); return; }
    if (text !== undefined && items.length === 0 && children.length === 0) { line(depth, parts, `>${text}</${p.type}>`); return; }
    line(depth, parts, ">");
    if (text !== undefined) out.push(`${"  ".repeat(depth + 1)}${text}`);
    for (const it of items) line(depth + 1, it, " />");
    for (const c of children) piece(c, depth + 1);
    out.push(`${"  ".repeat(depth)}</${p.type}>`);
  };
  piece(doc.root, 1);
  out.push("</slate>");
  return out.join("\n");
}
