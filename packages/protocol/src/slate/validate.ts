// SPDX-License-Identifier: AGPL-3.0-only
// The validator (10, "The compile and validate loop"): one pass over a stored document that lists every error up to
// 20 and the warnings beside them, each with its piece, prop, line and a fix where one is computable. The same pass
// serves a JSX-like write, the JSON form, a check and a patched result.
import { checkSlateExpression, parseSlateExpression, parseSlateFormat, slateDependencies, type SlateCheckScope, type SlateType } from "./expr.js";
import { isSlateIcon, nearestSlateIcon } from "./icons.js";
import { SLATE_PIECES, SLATE_RESERVED_PROPS, type SlateItemSpec, type SlatePieceModule, type SlatePropSpec } from "./kit.js";
import { SLATE_LIMITS } from "./limits.js";
import { parseSlateOwnPath } from "./paths.js";
import { SLATE_WARNINGS, nearest, orList, slateProblem, type SlateCode } from "./problems.js";
import { SLATE_SOURCES, slateIsSeries, slateSourceType } from "./sources.js";
import { SLATE_STEPS } from "./steps.js";
import {
  SLATE_ID, SLATE_NAME, SLATE_PANE_KINDS, SLATE_RUN_FIELDS, SLATE_SECRET_FIELDS, SlateSchema, isSlateBinding, isSlateFormat,
  type SlateDoc, type SlateJson, type SlatePiece, type SlateProblem, type SlatePropValue, type SlateStep,
} from "./types.js";

/** Lines of the JSX-like text a document was compiled from: piece ids, "id.prop", "$name", "$name.attr", reaction keys. */
export type SlateLines = Map<string, number>;

type Kind = "value" | "secret" | "derived" | "run";
type Trigger = "press" | "submit" | "change" | "reaction";
interface Where { piece?: string; prop?: string }

const RUN_FIELD_TYPES: Record<string, SlateType> = {
  state: { t: "string" }, why: { t: "string" }, exit: { t: "number" }, out: { t: "any" }, err: { t: "string" }, json: { t: "any" },
  lines: { t: "list", of: { t: "string" } }, startedAt: { t: "number" }, endedAt: { t: "number" }, ms: { t: "number" }, runs: { t: "number" }, cut: { t: "boolean" }, stale: { t: "boolean" },
};
const SECRET_FIELD_TYPES: Record<string, SlateType> = { set: { t: "boolean" }, len: { t: "number" }, at: { t: "number" } };

/** The type a literal start reads as: a list of records takes its first record's fields. */
function literalType(v: SlateJson): SlateType {
  if (v === null) return { t: "any" };
  if (typeof v === "number") return { t: "number" };
  if (typeof v === "string") return { t: "string" };
  if (typeof v === "boolean") return { t: "boolean" };
  if (Array.isArray(v)) return v.length === 0 ? { t: "list" } : { t: "list", of: literalType(v[0]!) };
  const keys = Object.keys(v);
  return keys.length === 0 ? { t: "record" } : { t: "record", fields: Object.fromEntries(keys.map(k => [k, literalType(v[k]!)])) };
}

const isBound = (v: SlatePropValue | undefined): boolean => isSlateBinding(v) || isSlateFormat(v);
const looksLikePath = (s: string): boolean => { const m = /^([a-z]+)\.[a-zA-Z_.[\]0-9]+$/.exec(s); return m !== null && m[1]! in SLATE_SOURCES; };
const isRecordValue = (v: unknown): v is Record<string, SlatePropValue> => typeof v === "object" && v !== null && !Array.isArray(v) && !isBound(v as SlatePropValue);

class Validator {
  readonly errors: SlateProblem[] = [];
  readonly warnings: SlateProblem[] = [];
  private readonly kinds = new Map<string, Kind>();
  private readonly derivedTypes = new Map<string, SlateType>();
  private readonly seenErrors = new Set<string>();

  constructor(private readonly doc: SlateDoc, private readonly lines: SlateLines | undefined) {
    for (const [n, v] of Object.entries(doc.values)) this.kinds.set(n, v.secret === true ? "secret" : "value");
    for (const n of Object.keys(doc.derived)) this.kinds.set(n, "derived");
    for (const n of Object.keys(doc.runs)) this.kinds.set(n, "run");
  }

  private lineOf(w: Where): number | undefined {
    if (this.lines === undefined || w.piece === undefined) return undefined;
    let key = w.prop !== undefined ? `${w.piece}.${w.prop}` : w.piece;
    for (;;) {
      const hit = this.lines.get(key);
      if (hit !== undefined) return hit;
      const cut = Math.max(key.lastIndexOf("."), key.lastIndexOf("["));
      if (cut <= 0) return undefined;
      key = key.slice(0, cut);
    }
  }

  add(code: SlateCode, message: string, w: Where = {}, fix?: string): void {
    const p = slateProblem(code, message, { piece: w.piece, prop: w.prop, line: this.lineOf(w), fix: fix !== undefined && this.wrote(w, fix) ? undefined : fix });
    if (SLATE_WARNINGS.has(code)) { this.warnings.push(p); return; }
    const key = `${code}|${w.piece}|${w.prop}|${message}`;
    if (this.seenErrors.has(key) || this.errors.length >= SLATE_LIMITS.errorsPerPass) return;
    this.seenErrors.add(key);
    this.errors.push(p);
  }

  /** Whether a fix only says again what the piece already holds, which tells the agent nothing. */
  private wrote(w: Where, fix: string): boolean {
    if (w.piece === undefined || w.prop === undefined) return false;
    const v = this.doc.pieces[w.piece]?.props?.[w.prop];
    if (v === undefined) return false;
    const text = typeof v === "string" ? [v, `${w.prop}="${v}"`] : isSlateBinding(v) ? [v.bind, `{${v.bind}}`, `${w.prop}={${v.bind}}`] : [];
    const flat = (x: string): string => x.replace(/\s+/g, "");
    return text.some(t => flat(t) === flat(fix));
  }

  run(): void {
    const d = this.doc;
    if ((d.schema as number) !== 2) this.add("D200", `schema ${String(d.schema)} is not a version this host knows; this host reads schema 2`, {}, "update wsp");
    if (d.kit !== undefined && d.kit !== "wsp/2") this.add("D201", `kit ${d.kit} is not one this host has; it has wsp/2`);
    if (JSON.stringify(d).length > SLATE_LIMITS.documentBytes) this.add("D208", `the document is over ${SLATE_LIMITS.documentBytes / 1024} KB`);
    this.names();
    this.limits();
    for (const [name, v] of Object.entries(d.values)) this.value(name, v.start, v.secret === true, v.keep === true);
    for (const [name, expr] of Object.entries(d.derived)) this.expr(expr, { piece: `$${name}`, prop: "value" });
    this.derivedCycles();
    for (const [name, r] of Object.entries(d.runs)) this.runDecl(name, r);
    d.reactions.forEach((r, i) => this.reaction(r, i));
    this.reactionCycles();
    this.tree();
    this.loud();
  }

  private names(): void {
    for (const name of this.kinds.keys()) if (!SLATE_NAME.test(name)) this.add("P103", `"${name}" is not a name: a lowercase letter or _, then letters, digits and _`, { piece: `$${name}` });
    const counts = new Map<string, number>();
    for (const n of [...Object.keys(this.doc.values), ...Object.keys(this.doc.derived), ...Object.keys(this.doc.runs)]) counts.set(n, (counts.get(n) ?? 0) + 1);
    for (const [n, c] of counts) if (c > 1) this.add("P104", `$${n} is declared twice`, { piece: `$${n}` });
    for (const id of Object.keys(this.doc.pieces)) {
      if (!SLATE_ID.test(id)) this.add("P103", `"${id}" is not a piece id: lowercase letters, digits and dashes, starting with a letter`, { piece: id });
      if (this.kinds.has(id)) this.add("P104", `${id} names both a piece and $${id}; pieces and declarations share one namespace`, { piece: id });
    }
    const reactionIds = this.doc.reactions.map(r => r.id).filter((x): x is string => x !== undefined);
    for (const id of new Set(reactionIds)) if (reactionIds.filter(x => x === id).length > 1) this.add("P104", `reaction ${id} is declared twice`, { piece: id });
  }

  private limits(): void {
    const d = this.doc;
    const over = (n: number, max: number, code: SlateCode, what: string, fix?: string): void => { if (n > max) this.add(code, `${n} ${what}; the most is ${max}`, {}, fix); };
    over(Object.keys(d.values).length, SLATE_LIMITS.values, "S513", "values");
    over(Object.keys(d.derived).length, SLATE_LIMITS.derived, "S512", "derived values");
    over(Object.keys(d.runs).length, SLATE_LIMITS.runs, "K707", "runs");
    over(d.reactions.length, SLATE_LIMITS.reactions, "A611", "reactions");
    over(Object.keys(d.pieces).length, SLATE_LIMITS.pieces, "D207", "pieces", "bind a list to a table or a list instead of writing rows");
    const starts = JSON.stringify(Object.values(d.values).map(v => v.start)).length;
    if (starts > SLATE_LIMITS.valuesBytes) this.add("S500", `the values' starts are over ${SLATE_LIMITS.valuesBytes / 1024} KB`);
  }

  // ---- expressions ----

  private ownType(name: string, segs: readonly (string | number)[], secretOk: boolean): SlateType | { code: SlateCode; message: string; fix?: string } {
    const kind = this.kinds.get(name);
    if (kind === undefined) {
      const fix = nearest(name, [...this.kinds.keys()]);
      return { code: "S501", message: `$${name} is not declared; add <value name="${name}" start=... />${fix !== undefined ? ` or did you mean $${fix}?` : ""}`, ...(fix !== undefined ? { fix: `$${fix}` } : {}) };
    }
    const first = segs[0];
    if (kind === "secret") {
      if (typeof first === "string" && (SLATE_SECRET_FIELDS as readonly string[]).includes(first)) return SECRET_FIELD_TYPES[first]!;
      if (secretOk && segs.length === 0) return { t: "any" };
      return { code: "S520", message: `$${name} is a secret; only a run's env or stdin, an input's value or a send's paths may name it, and a formula reads only its .set, .len and .at`, fix: `$${name}.set` };
    }
    if (kind === "run") {
      if (first === undefined) return { t: "record", fields: RUN_FIELD_TYPES };
      if (typeof first !== "string" || !(SLATE_RUN_FIELDS as readonly string[]).includes(first)) {
        const fix = nearest(String(first), SLATE_RUN_FIELDS);
        return { code: "X401", message: `$${name}.${String(first)} is not a field of a run's result; the fields are ${SLATE_RUN_FIELDS.join(", ")}`, ...(fix !== undefined ? { fix: `$${name}.${fix}` } : {}) };
      }
      return segs.length === 1 ? RUN_FIELD_TYPES[first]! : { t: "any" };
    }
    let t: SlateType = kind === "derived" ? this.derivedType(name) : literalType(this.doc.values[name]!.start);
    for (const s of segs) {
      if (typeof s === "number") t = t.t === "list" ? (t.of ?? { t: "any" }) : { t: "any" };
      else if (t.t === "record" && t.fields !== undefined) t = t.fields[s] ?? { t: "any" };
      else t = { t: "any" };
    }
    return t;
  }

  private derivedType(name: string): SlateType {
    const hit = this.derivedTypes.get(name);
    if (hit !== undefined) return hit;
    this.derivedTypes.set(name, { t: "any" });
    const expr = this.doc.derived[name];
    const t = expr === undefined ? { t: "any" as const } : checkSlateExpression(expr, this.scope(undefined, false)).type;
    this.derivedTypes.set(name, t);
    return t;
  }

  private scope(row: SlateType | undefined, secretOk: boolean, enumWords?: readonly string[]): SlateCheckScope {
    return {
      ...(row !== undefined ? { row } : {}),
      path: (head, own, segs) => {
        if (own) return this.ownType(head, segs, secretOk);
        if (this.kinds.has(head)) return { code: "X401", message: `${head} is not a path; the slate's own values are $${head}`, fix: `$${head}` };
        if (enumWords?.includes(head)) return { code: "X401", message: `${head} is not a path; an enum word is a string`, fix: `"${head}"` };
        return slateSourceType(head, segs);
      },
    };
  }

  /** Checks one expression; answers its type. */
  expr(src: string, w: Where, opts: { row?: SlateType; secretOk?: boolean; enumWords?: readonly string[] } = {}): SlateType {
    if (typeof src !== "string") { this.add("T303", "a formula is text", w); return { t: "any" }; }
    const { type, problems } = checkSlateExpression(src, this.scope(opts.row, opts.secretOk === true, opts.enumWords));
    for (const p of problems) this.add(p.code as SlateCode, p.message, w, p.fix);
    return type;
  }

  /** Checks a prop value's formulas: a binding, each hole of a format, and the same nested in lists and records. */
  private propValue(v: SlatePropValue | undefined, w: Where, opts: { row?: SlateType; secretOk?: boolean; enumWords?: readonly string[] } = {}): SlateType | undefined {
    if (v === undefined || v === null || typeof v !== "object") return undefined;
    if (isSlateBinding(v)) return this.expr(v.bind, w, opts);
    if (isSlateFormat(v)) {
      const { parts, errors } = parseSlateFormat(v.format);
      for (const e of errors) this.add(e.code as SlateCode, e.message, w);
      for (const p of parts) if (typeof p !== "string") this.expr(p.expr, w, opts);
      return { t: "string" };
    }
    if (Array.isArray(v)) { v.forEach((x, i) => this.propValue(x, { ...w, prop: `${w.prop}[${i}]` }, opts)); return { t: "list" }; }
    for (const [k, x] of Object.entries(v)) this.propValue(x, { ...w, prop: `${w.prop}.${k}` }, opts);
    return { t: "record" };
  }

  // ---- declarations ----

  private value(name: string, start: SlateJson, secret: boolean, keep: boolean): void {
    const w = { piece: `$${name}`, prop: "start" };
    if (secret && start !== null) this.add("S503", `$${name} is a secret and starts empty; the person types it`, w);
    if (!secret && keep) this.add("T302", `keep is for a <secret>; $${name} is a value`, w);
  }

  private derivedCycles(): void {
    const deps = new Map<string, string[]>();
    for (const [name, expr] of Object.entries(this.doc.derived)) deps.set(name, roots(slateDependencies(expr)).filter(n => this.doc.derived[n] !== undefined));
    const state = new Map<string, "on" | "done">();
    const reported = new Set<string>();
    const visit = (n: string, stack: string[]): void => {
      if (state.get(n) === "done") return;
      if (state.get(n) === "on") {
        const cycle = [...stack.slice(stack.indexOf(n)), n];
        const key = [...cycle].sort().join(",");
        if (!reported.has(key)) { reported.add(key); this.add("S510", `derived values read each other in a cycle: ${cycle.map(x => `$${x}`).join(" reads ")}`, { piece: `$${n}`, prop: "value" }, "make one of them a value"); }
        return;
      }
      state.set(n, "on");
      for (const m of deps.get(n) ?? []) visit(m, [...stack, n]);
      state.set(n, "done");
    };
    for (const n of deps.keys()) visit(n, []);
  }

  private runDecl(name: string, r: SlateDoc["runs"][string]): void {
    const w = (prop: string): Where => ({ piece: `$${name}`, prop });
    if ("every" in r && r.every !== undefined && (!Number.isFinite(r.every) || r.every < SLATE_LIMITS.timerFloorS)) this.add("K703", `every is at least ${SLATE_LIMITS.timerFloorS} s`, w("every"), `every={${SLATE_LIMITS.timerFloorS}}`);
    if (r.always === true && r.every === undefined) this.add("K703", "always keeps a timer running while the slate is not shown, so it needs every", w("always"), "every={60} always");
    if (r.kind === "cmd") {
      if (typeof r.cmd !== "string" || r.cmd.trim() === "") this.add("K700", "the command is literal text; hand values to it with env={{ NAME: $value }}", w("cmd"));
      if (r.timeout !== undefined && (!Number.isFinite(r.timeout) || r.timeout <= 0 || r.timeout > SLATE_LIMITS.timeoutMaxS)) this.add("K704", `timeout is seconds up to ${SLATE_LIMITS.timeoutMaxS}`, w("timeout"), `timeout={${SLATE_LIMITS.timeoutDefaultS}}`);
      if (r.on !== undefined && r.on !== "thread" && r.on !== "host") this.add("K704", "on is \"thread\" or \"host\"", w("on"));
      const secretEnv: [string, string][] = [];
      for (const [k, v] of Object.entries(r.env ?? {})) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) this.add("K702", `${k} is not an environment variable name: capitals, digits and _`, w("env"), k.toUpperCase().replace(/[^A-Z0-9_]/g, "_"));
        this.propValue(v, w(`env.${k}`), { secretOk: true });
        for (const s of this.secretsIn(v)) secretEnv.push([k, s]);
      }
      (r.args ?? []).forEach((v, i) => {
        this.propValue(v, w(`args[${i}]`), { secretOk: true });
      });
      if (r.stdin !== undefined) this.propValue(r.stdin, w("stdin"), { secretOk: true });
      for (const [envName, secret] of secretEnv) {
        const flag = new RegExp(`(?:^|\\s)(-{1,2}[A-Za-z][\\w-]*)(?:=|\\s+)["']?\\$\\{?${envName}\\b`);
        const m = flag.exec(r.cmd);
        if (m !== null) {
          this.add("W011", `${envName} carries the secret $${secret}, and the command passes it after ${m[1]}, as an argument ps can read; hand it on stdin={$${secret}}, or let the program read ${envName} from its environment`, w("cmd"), `drop ${m[1]} "$${envName}" and use stdin={$${secret}} or the program's own ${envName}`);
        }
      }
    } else if (r.kind === "tool") {
      if (!r.server || !r.tool) this.add("K705", "tool names a server and a tool as \"server.tool\"", w("tool"));
      for (const [k, v] of Object.entries(r.args ?? {})) this.propValue(v, w(`args.${k}`), { secretOk: true });
    } else if (r.kind === "resource") {
      if (!r.server || !r.uri) this.add("K705", "resource names a server and a uri as \"server:uri\"", w("resource"));
    } else this.add("K701", `$${name} takes exactly one of cmd, tool or resource`, w("kind"));
  }

  /** The secrets a prop value reads, by name. */
  private secretsIn(v: SlatePropValue | undefined): string[] {
    const out: string[] = [];
    const visit = (x: SlatePropValue | undefined): void => {
      if (x === null || x === undefined || typeof x !== "object") return;
      if (isSlateBinding(x)) { for (const n of roots(slateDependencies(x.bind))) if (this.kinds.get(n) === "secret") out.push(n); return; }
      if (isSlateFormat(x)) { for (const p of parseSlateFormat(x.format).parts) if (typeof p !== "string") for (const n of roots(slateDependencies(p.expr))) if (this.kinds.get(n) === "secret") out.push(n); return; }
      for (const y of Array.isArray(x) ? x : Object.values(x)) visit(y);
    };
    visit(v);
    return out;
  }

  private reaction(r: SlateDoc["reactions"][number], i: number): void {
    const key = r.id ?? `reaction-${i + 1}`;
    const on = r.on as { change?: string[]; done?: string };
    if ((on.change === undefined) === (on.done === undefined)) { this.add("A611", "<when> takes exactly one of change={...} or done={$run}", { piece: key }); return; }
    if (on.change !== undefined) {
      if (on.change.length === 0) this.add("A611", "change lists at least one path", { piece: key, prop: "change" });
      for (const p of on.change) {
        const { ast } = parseSlateExpression(p);
        if (ast?.k !== "path") { this.add("A601", `change lists paths, not formulas: ${p}`, { piece: key, prop: "change" }); continue; }
        this.expr(p, { piece: key, prop: "change" }, { secretOk: true });
      }
    } else if (this.kinds.get(on.done!) !== "run") {
      this.add("K702", `done names a run: $${on.done} is ${this.kinds.get(on.done!) ?? "not declared"}`, { piece: key, prop: "done" }, nearest(on.done!, [...this.kinds].filter(([, k]) => k === "run").map(([n]) => `$${n}`)));
    }
    this.steps(r.do, { piece: key, prop: "do" }, "reaction");
  }

  private steps(steps: SlateStep[] | undefined, w: Where, trigger: Trigger, row?: SlateType): void {
    if (!Array.isArray(steps)) { this.add("A600", "a handler is a list of steps", w); return; }
    if (steps.length > SLATE_LIMITS.stepsPerReaction) this.add("A606", `${steps.length} steps in one handler; the most is ${SLATE_LIMITS.stepsPerReaction}`, w, "split it: a second <when> on what the first one sets");
    for (const s of steps) {
      const module = SLATE_STEPS[s.do];
      if (module === undefined) { this.add("A600", `${String(s.do)} is not a step; steps are ${Object.keys(SLATE_STEPS).join(", ")}`, w, nearest(String(s.do), Object.keys(SLATE_STEPS))); continue; }
      if (module.runs === "window" && trigger !== "press") this.add("A608", `${s.do} runs in the window and goes on a press, not on a ${trigger === "reaction" ? "reaction" : `${trigger} handler`}`, w, `onPress={${s.do}(...)}`);
      switch (s.do) {
        case "set": case "toggle": {
          const p = parseSlateOwnPath(s.path);
          if (p === undefined) { this.add("A601", `${s.do} writes the slate's own values: a $name path, not ${s.path}`, w); break; }
          const kind = this.kinds.get(p.name);
          if (kind === undefined) this.add("S501", `$${p.name} is not declared; add <value name="${p.name}" start=... />`, w, nearest(p.name, [...this.kinds.keys()]));
          else if (kind === "derived") this.add("A607", `$${p.name} is derived and cannot be written; write the value it reads, or make it a value`, w);
          else if (kind === "run") this.add("A607", `$${p.name} is a run; its result is the host's to write`, w);
          else if (kind === "secret") this.add("S520", `$${p.name} is a secret; only the person's typing fills it`, w);
          if (s.do === "set") this.propValue(s.value, w, { ...(row !== undefined ? { row } : {}) });
          break;
        }
        case "start": case "cancel":
          if (this.kinds.get(s.run) !== "run") this.add("K702", `${s.do} names a run: $${s.run} is ${this.kinds.get(s.run) ?? "not declared"}`, w, nearest(s.run, [...this.kinds].filter(([, k]) => k === "run").map(([n]) => n)));
          break;
        case "send": case "steer": case "queue": case "fill":
          if (typeof s.text !== "string") this.add("A603", `${s.do}'s text is a literal string`, w);
          for (const p of s.with ?? []) {
            const { ast } = parseSlateExpression(p);
            if (ast?.k !== "path") { this.add("A601", `${s.do} carries paths after its text; ${p} is a formula`, w); continue; }
            this.expr(p, w, { secretOk: true, ...(row !== undefined ? { row } : {}) });
          }
          break;
        case "open": this.propValue(s.target, w, { ...(row !== undefined ? { row } : {}) }); break;
        case "copy": this.propValue(s.text, w, { ...(row !== undefined ? { row } : {}) }); break;
        case "pane": if (!(SLATE_PANE_KINDS as readonly string[]).includes(s.kind)) this.add("A601", `pane names one of ${SLATE_PANE_KINDS.join(", ")}`, w, nearest(s.kind, SLATE_PANE_KINDS)); break;
      }
    }
  }

  private reactionCycles(): void {
    const edges = new Map<string, Set<string>>();
    const why = new Map<string, string>();
    const add = (from: string, to: string, text: string): void => {
      (edges.get(from) ?? edges.set(from, new Set()).get(from)!).add(to);
      if (!why.has(`${from}>${to}`)) why.set(`${from}>${to}`, text);
    };
    for (const [name, expr] of Object.entries(this.doc.derived)) for (const d of roots(slateDependencies(expr))) add(d, name, `$${name} reads $${d}`);
    for (const r of this.doc.reactions) {
      const change = (r.on as { change?: string[] }).change;
      if (change === undefined) continue;
      const triggers = roots(change);
      const targets = r.do.flatMap(s => (s.do === "set" || s.do === "toggle" ? [parseSlateOwnPath(s.path)?.name] : [])).filter((x): x is string => x !== undefined);
      for (const t of triggers) for (const g of targets) add(t, g, `when change of $${t} sets $${g}`);
    }
    const state = new Map<string, "on" | "done">();
    let reported = false;
    const visit = (n: string, stack: string[]): void => {
      if (reported || state.get(n) === "done") return;
      if (state.get(n) === "on") {
        const cycle = [...stack.slice(stack.indexOf(n)), n];
        const said = cycle.slice(0, -1).map((x, i) => why.get(`${x}>${cycle[i + 1]}`) ?? "");
        if (said.some(s => s.startsWith("when"))) {
          reported = true;
          this.add("A610", `reactions and derived values form a cycle: ${said.join("; ")}`, {}, "compute it as a <derived> value instead of setting it back");
        }
        return;
      }
      state.set(n, "on");
      for (const m of edges.get(n) ?? []) visit(m, [...stack, n]);
      state.set(n, "done");
    };
    for (const n of edges.keys()) visit(n, []);
  }

  // ---- pieces ----

  private tree(): void {
    const d = this.doc;
    if (d.pieces[d.root] === undefined) { this.add("D203", `the root ${d.root || "(none)"} is not a piece`, {}, nearest(d.root, Object.keys(d.pieces))); return; }
    const placed = new Set<string>();
    const walk = (id: string, depth: number, path: string[], row: SlateType | undefined): void => {
      if (path.includes(id)) { this.add("D205", `${id} is under itself: ${[...path, id].join(" > ")}`, { piece: id }); return; }
      if (placed.has(id)) { this.add("D205", `${id} sits in two places`, { piece: id }); return; }
      placed.add(id);
      if (depth > SLATE_LIMITS.depth) { this.add("D206", `the tree is deeper than ${SLATE_LIMITS.depth}`, { piece: id }); return; }
      const p = d.pieces[id]!;
      const childRow = this.piece(id, p, row);
      const children = p.children ?? [];
      if (children.length > SLATE_LIMITS.children) this.add("D207", `${id} has ${children.length} children; the most is ${SLATE_LIMITS.children}`, { piece: id }, "bind a list instead");
      for (const c of children) {
        if (d.pieces[c] === undefined) { this.add("D203", `${id} holds ${c}, which is not a piece`, { piece: id }, nearest(c, Object.keys(d.pieces))); continue; }
        walk(c, depth + 1, [...path, id], childRow);
      }
    };
    walk(d.root, 1, [], undefined);
  }

  /** Checks one piece; answers the row scope its children are read in. */
  private piece(id: string, p: SlatePiece, row: SlateType | undefined): SlateType | undefined {
    const spec = SLATE_PIECES[p.type];
    if (spec === undefined) {
      if (p.fallback === undefined) {
        const fix = nearest(p.type, Object.keys(SLATE_PIECES));
        this.add("T300", `"${p.type}" is not a piece${fix !== undefined ? `; did you mean ${fix}?` : ""}`, { piece: id }, fix);
      }
      return row;
    }
    if (p.when !== undefined) this.expr(p.when, { piece: id, prop: "when" }, { ...(row !== undefined ? { row } : {}) });
    if (typeof p.fallback === "string" && p.fallback !== "drop" && this.doc.pieces[p.fallback] === undefined) this.add("D203", `fallback names ${p.fallback}, which is not a piece`, { piece: id, prop: "fallback" });
    const props = p.props ?? {};
    const itemProps = new Map(Object.entries(spec.items).map(([tag, s]) => [s.prop, { tag, spec: s }]));
    const items = props.items;
    const rowType = spec.repeating === true ? this.itemsRow(items, id, row) : undefined;
    for (const [name, v] of Object.entries(props)) {
      const item = itemProps.get(name);
      const scalars = Array.isArray(v) && v.every(x => typeof x === "string" || typeof x === "number");
      if (item !== undefined && !(spec.props[name] !== undefined && (scalars || isBound(v)))) { this.items(id, name, v, item.tag, item.spec, rowType ?? row); continue; }
      const ps = spec.props[name];
      if (ps === undefined) {
        if (name in SLATE_RESERVED_PROPS) this.add("T312", `${name} is not a prop a slate can set; wsp draws the style. Use ${SLATE_RESERVED_PROPS[name]}.`, { piece: id, prop: name }, SLATE_RESERVED_PROPS[name]);
        else { const fix = nearest(name, Object.keys(spec.props)); this.add("T302", `${p.type} has no ${name}${fix !== undefined ? `; did you mean ${fix}?` : `; it takes ${Object.keys(spec.props).join(", ")}`}`, { piece: id, prop: name }, fix); }
        continue;
      }
      this.prop(p.type, ps, v, { piece: id, prop: name }, ps.binds === "item" ? rowType : row);
    }
    for (const [name, ps] of Object.entries(spec.props)) {
      if (ps.required !== true || props[name] !== undefined) continue;
      if (spec.interactive === true && name === "label") this.add("T307", `a ${p.type} needs a label for people using a screen reader`, { piece: id, prop: name }, `label="..."`);
      else this.add("T304", `${p.type} "${id}" needs ${name}`, { piece: id, prop: name });
    }
    for (const [tag, is] of Object.entries(spec.items)) {
      const n = Array.isArray(props[is.prop]) ? (props[is.prop] as SlatePropValue[]).length : 0;
      if (is.min !== undefined && n < is.min && !(is.prop === "options" && props.options !== undefined)) this.add("T304", `${p.type} needs at least ${is.min} <${tag}>`, { piece: id, prop: is.prop });
      if (is.max !== undefined && n > is.max) this.add("T309", `${p.type} takes at most ${is.max} <${tag}>`, { piece: id, prop: is.prop });
    }
    for (const [event, steps] of Object.entries(p.on ?? {})) {
      if (!(spec.events as readonly string[]).includes(event)) { this.add("A602", `${p.type} has no on${event[0]!.toUpperCase()}${event.slice(1)}${spec.events.length > 0 ? `; it has ${spec.events.map(e => `on${e[0]!.toUpperCase()}${e.slice(1)}`).join(", ")}` : ""}`, { piece: id, prop: `on${event[0]!.toUpperCase()}${event.slice(1)}` }); continue; }
      this.steps(steps, { piece: id, prop: `on${event[0]!.toUpperCase()}${event.slice(1)}` }, event as Trigger, row);
    }
    if (spec.needsHandler !== undefined && (p.on?.[spec.needsHandler] ?? []).length === 0) this.add("A602", `a ${p.type} needs on${spec.needsHandler[0]!.toUpperCase()}${spec.needsHandler.slice(1)}`, { piece: id }, `onPress={send("...")}`);
    const children = p.children ?? [];
    if (!spec.holdsChildren && children.length > 0) this.add("T308", `${p.type} holds no children`, { piece: id });
    if (spec.childLimit !== undefined) {
      if (children.length > spec.childLimit.max) this.add("T309", `${p.type} takes at most ${spec.childLimit.max} child${spec.childLimit.max === 1 ? "" : "ren"}`, { piece: id });
      if (spec.childLimit.types.length > 0) for (const c of children) { const t = this.doc.pieces[c]?.type; if (t !== undefined && !spec.childLimit.types.includes(t)) this.add("T309", `${p.type} takes ${orList(spec.childLimit.types)} children, not ${t}`, { piece: id }); }
    }
    if (p.type === "tabs" && children.length === 0) this.add("T309", "tabs holds the pieces its tabs show", { piece: id });
    if (p.type === "list" && children.length !== 1) this.add("T309", "list holds one child, drawn once per row", { piece: id });
    if (p.type === "checklist" && props.editable === true && !(isSlateBinding(props.items) && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(props.items.bind.trim()) && this.kinds.get(props.items.bind.trim().slice(1)) === "value")) {
      this.add("S502", "an editable checklist writes its ticks back, so items binds a value: items={$steps}", { piece: id, prop: "items" });
    }
    if (p.type === "bars" && isSlateBinding(items) && slateIsSeries(items.bind.trim())) this.add("W003", `${items.bind} is a series over time; draw it as a line`, { piece: id, prop: "items" }, "<chart>");
    else if (p.type === "bars" && isSlateBinding(props.name) && readsTime(props.name.bind)) this.add("W003", `bars name each row by ${props.name.bind}, a time: a series over time is a line`, { piece: id, prop: "name" }, "<chart>");
    return spec.rowTemplate === true ? rowType : row;
  }

  /** The row type of a repeating piece's items, where its shape is known. */
  private itemsRow(items: SlatePropValue | undefined, id: string, row: SlateType | undefined): SlateType {
    if (!isSlateBinding(items)) return { t: "any" };
    const { type } = checkSlateExpression(items.bind, this.scope(row, false));
    void id;
    return type.t === "list" ? (type.of ?? { t: "any" }) : { t: "any" };
  }

  private items(id: string, prop: string, v: SlatePropValue, tag: string, spec: SlateItemSpec, row: SlateType | undefined): void {
    if (!Array.isArray(v)) { this.add("T303", `${prop} is a list of <${tag}> items`, { piece: id, prop }); return; }
    v.forEach((it, i) => {
      const where = `${prop}[${i}]`;
      if (!isRecordValue(it)) { this.add("T303", `each <${tag}> is a record`, { piece: id, prop: where }); return; }
      const itemRow = spec.row === true ? row : undefined;
      for (const [k, x] of Object.entries(it)) {
        if (k === "on" && spec.events !== undefined) {
          for (const [ev, steps] of Object.entries((x ?? {}) as Record<string, SlateStep[]>)) {
            if (!(spec.events as readonly string[]).includes(ev)) { this.add("A602", `<${tag}> has no on${ev}`, { piece: id, prop: `${where}.on` }); continue; }
            this.steps(steps, { piece: id, prop: `${where}.onPress` }, "press", itemRow);
          }
          continue;
        }
        if (k === "when" && spec.row === true) { if (typeof x === "string") this.expr(x, { piece: id, prop: `${where}.when` }, { ...(itemRow !== undefined ? { row: itemRow } : {}) }); else this.add("T303", "when is a formula", { piece: id, prop: `${where}.when` }); continue; }
        const fs = spec.fields[k];
        if (fs === undefined) {
          if (k in SLATE_RESERVED_PROPS) this.add("T312", `${k} is not a prop a slate can set; use ${SLATE_RESERVED_PROPS[k]}`, { piece: id, prop: `${where}.${k}` }, SLATE_RESERVED_PROPS[k]);
          else { const fix = nearest(k, Object.keys(spec.fields)); this.add("T302", `<${tag}> has no ${k}; it takes ${Object.keys(spec.fields).join(", ")}`, { piece: id, prop: `${where}.${k}` }, fix); }
          continue;
        }
        this.prop(tag, fs, x, { piece: id, prop: `${where}.${k}` }, fs.binds === "item" || spec.row === true ? itemRow : row);
      }
      for (const [k, fs] of Object.entries(spec.fields)) if (fs.required === true && it[k] === undefined) this.add("T304", `<${tag}> needs ${k}`, { piece: id, prop: where });
    });
  }

  private prop(type: string, ps: SlatePropSpec, v: SlatePropValue, w: Where, row: SlateType | undefined): void {
    const name = w.prop!.split(".").at(-1)!;
    const enumWords = Array.isArray(ps.type) ? (ps.type as readonly string[]) : undefined;
    if (v === null) return;
    if (isBound(v)) {
      if (ps.binds === "no") { this.add("T305", `${name} takes a literal, not a formula`, w); return; }
      if (ps.binds === "state") {
        const bind = isSlateBinding(v) ? v.bind.trim() : "";
        const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(bind);
        const kind = m !== null ? this.kinds.get(m[1]!) : undefined;
        if (m === null) {
          const into = name === "value" ? "picked" : name;
          this.add("X410", `${name} on ${type} writes back, so it binds one plain value, not ${bind}; bind a value of its own and keep a list with append in a <when> if you need one per item`, w, `<value name="${into}" start={null} /> and ${name}={$${into}}`);
          return;
        }
        if (kind === undefined) { this.add("S501", `$${m[1]} is not declared; add <value name="${m[1]}" start=... />`, w, nearest(m[1]!, [...this.kinds.keys()])); return; }
        if (kind === "secret" && type !== "input") { this.add("S520", "a secret is typed into an input and nowhere else", w); return; }
        if (kind !== "value" && kind !== "secret") { this.add("X410", `${name} on ${type} writes a value; $${m[1]} is ${kind === "derived" ? "derived" : "a run"}`, w); return; }
        return;
      }
      const t = this.propValue(v, w, { ...(row !== undefined ? { row } : {}), ...(enumWords !== undefined ? { enumWords } : {}) });
      if (t !== undefined) {
        const wantsNumber = ps.type === "number" || ps.type === "integer";
        if (wantsNumber && ["string", "list", "record", "boolean"].includes(t.t)) this.add("X408", `${name} takes a number; this formula gives ${t.t === "string" ? "text" : `a ${t.t}`}`, w, t.t === "string" ? `num(...)` : t.t === "list" ? "len(...)" : undefined);
        if (ps.type === "list" && ["string", "number", "boolean"].includes(t.t)) this.add("X408", `${name} takes a list; this formula gives ${t.t === "string" ? "text" : `a ${t.t}`}`, w);
      }
      return;
    }
    if (ps.binds === "state") { this.add("X410", `${name} on ${type} is two-way and binds a value: ${name}={$name}`, w, `${name}={$${typeof v === "string" && /^[a-z_]\w*$/.test(v) ? v : "name"}}`); return; }
    if (ps.type === "path") {
      const m = typeof v === "string" ? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(v) : null;
      if (m === null) { this.add("T303", `${name} names a run or a value as $name`, w); return; }
      const kind = this.kinds.get(m[1]!);
      if (type === "output" && kind !== "run") this.add("K702", `run names a run: $${m[1]} is ${kind ?? "not declared"}`, w, nearest(m[1]!, [...this.kinds].filter(([, k]) => k === "run").map(([n]) => `$${n}`)));
      if (type === "form" && kind !== "value") this.add("S501", `into names a value: $${m[1]} is ${kind ?? "not declared"}`, w);
      return;
    }
    if (enumWords !== undefined) {
      if (typeof v !== "string" || !enumWords.includes(v)) this.add("T306", `${name} is ${orList(enumWords)}; ${JSON.stringify(v)} is not one`, w, nearest(String(v), enumWords));
      return;
    }
    switch (ps.type) {
      case "number": case "integer":
        if (typeof v === "string") { this.add("T303", `${name} takes a number; "${v}" is text. To bind it, write ${name}={${v}}`, w, `${name}={${v}}`); return; }
        if (typeof v !== "number") { this.add("T303", `${name} takes a number`, w); return; }
        if (ps.type === "integer" && !Number.isInteger(v)) this.add("T303", `${name} is a whole number`, w);
        if ((ps.min !== undefined && v < ps.min) || (ps.max !== undefined && v > ps.max)) this.add("T303", `${name} is ${ps.min} to ${ps.max}`, w);
        return;
      case "boolean":
        if (typeof v !== "boolean") this.add("T303", `${name} takes true or false: bare ${name}, or ${name}={false}`, w);
        return;
      case "list":
        if (!Array.isArray(v)) this.add("T303", `${name} takes a list: ${name}={path} or ${name}={[...]}`, w);
        return;
      case "icon": {
        if (isSlateIcon(v)) return;
        const fix = typeof v === "string" ? nearestSlateIcon(v) : undefined;
        this.add("T306", `${JSON.stringify(v)} is not an icon in the kit${fix !== undefined ? `; did you mean ${fix}?` : ""} slate_catalog icons lists them`, w, fix !== undefined ? `icon="${fix}"` : undefined);
        return;
      }
      case "string": case "text":
        if (typeof v === "string") {
          if (looksLikePath(v)) this.add("W001", `${name} is the literal text "${v}", which reads like a path`, w, `${name}={${v}}`);
          if (v.includes("\u2014")) this.add("W004", "an em dash in the slate's words; use a comma, a colon or a full stop", w);
          return;
        }
        if (typeof v === "number" && ps.type === "text") return;
        if (typeof v !== "string") this.add("T303", `${name} takes text`, w);
        return;
      default: return;
    }
  }

  private loud(): void {
    const tally = (pred: (p: SlatePiece) => boolean): string[] => Object.entries(this.doc.pieces).filter(([, p]) => pred(p)).map(([id]) => id);
    const check = (ids: string[], what: string): void => { if (ids.length > 1) this.add("T311", `${what} on ${ids.join(", ")}; one per slate reads loud, the rest draw as default`, { piece: ids[1]! }); };
    check(tally(p => p.props?.tone === "accent"), "accent");
    check(tally(p => p.type === "button" && p.props?.variant === "primary"), "primary");
    check(tally(p => p.props?.size === "large"), "large");
  }
}

const TIME_FIELDS = new Set(["at", "time", "date", "ts", "timestamp", "when", "day", "hour", "minute"]);
const TIME_FNS = /\b(?:date|time|ago|weekday)\s*\(/;

/** A row's name that reads a time: item.at, item.date, or date(...) and its kin. */
function readsTime(expr: string): boolean {
  if (TIME_FNS.test(expr) || slateDependencies(expr).includes("time.now")) return true;
  const field = /\bitem\.([A-Za-z_]+)\b/.exec(expr)?.[1];
  return field !== undefined && TIME_FIELDS.has(field);
}

/** The names a list of own paths starts from. */
function roots(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(p => p.startsWith("$")).map(p => p.slice(1).split(/[.[]/)[0]!))];
}

/** Validates a compiled or stored document, lines attached where the text gave them. */
export function validateDocument(doc: SlateDoc, lines?: SlateLines): { errors: SlateProblem[]; warnings: SlateProblem[] } {
  const v = new Validator(doc, lines);
  v.run();
  return { errors: v.errors, warnings: v.warnings };
}

/** The stored JSON form validated: the shape first, then every rule. */
export function validateSlate(input: unknown): { document?: SlateDoc; errors: SlateProblem[]; warnings: SlateProblem[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { errors: [slateProblem("D202", "a document is an object with schema, root, values, derived, runs, reactions and pieces")], warnings: [] };
  const schema = (input as { schema?: unknown }).schema;
  if (schema !== 2) return { errors: [slateProblem("D200", `schema ${JSON.stringify(schema)} is not a version this host knows; this host reads schema 2`, { fix: "update wsp" })], warnings: [] };
  const filled = { values: {}, derived: {}, runs: {}, reactions: [], ...(input as object) };
  const parsed = SlateSchema.safeParse(filled);
  if (!parsed.success) return { errors: parsed.error.issues.slice(0, SLATE_LIMITS.errorsPerPass).flatMap(i => shapeProblems(i, filled as Record<string, unknown>)), warnings: [] };
  const doc = parsed.data;
  const { errors, warnings } = validateDocument(doc);
  return { ...(errors.length === 0 ? { document: doc } : {}), errors, warnings };
}

interface ShapeIssue { code: string; path: (string | number)[]; message: string; keys?: string[] }

const DOC_KEYS = ["schema", "kit", "title", "root", "values", "derived", "runs", "reactions", "pieces"];
const PIECE_KEYS = "type, props, children, when, on and fallback";

/** A shape error said as the rule it breaks, naming the piece and the prop: a prop beside props instead of in it is
 * T302 with the move as its fix, not a root-ambiguous D202. */
function shapeProblems(issue: ShapeIssue, doc: Record<string, unknown>): SlateProblem[] {
  const path = issue.path.map(String);
  const [area, name, field, sub] = path;
  const keys = issue.code === "unrecognized_keys" ? (issue.keys ?? []) : [];
  if (area === "pieces" && name !== undefined) {
    const type = ((doc.pieces as Record<string, { type?: unknown }> | undefined)?.[name]?.type);
    const spec = typeof type === "string" ? SLATE_PIECES[type] : undefined;
    if (field === undefined && keys.length > 0) {
      return keys.map(k => {
        const known = spec?.props[k] !== undefined || Object.values(spec?.items ?? {}).some(i => i.prop === k);
        return slateProblem("T302", `${k} sits beside props on ${name}; a piece holds ${PIECE_KEYS}${known ? `, and ${k} goes inside props` : spec !== undefined ? `, and ${String(type)} has no ${k}` : ""}`, { piece: name, prop: k, fix: known ? `"props": { "${k}": ... }` : nearest(k, Object.keys(spec?.props ?? {})) });
      });
    }
    if (field === "type") return [slateProblem("T300", `${name}'s type is the piece's name as a string`, { piece: name, prop: "type" })];
    if (field === "on") return [slateProblem(keys.length > 0 ? "A602" : "A600", keys.length > 0 ? `${name} has no on.${keys.join(", on.")}; events are press, submit and change` : `${name}.${path.slice(2).join(".")}: a handler is a list of steps, ${issue.message}`, { piece: name, prop: `on${sub !== undefined ? `.${sub}` : ""}` })];
    const prop = field === "props" ? sub : field;
    return [slateProblem("T303", `${name}.${path.slice(2).join(".")}: ${issue.message}`, { piece: name, ...(prop !== undefined ? { prop } : {}) })];
  }
  if ((area === "values" || area === "derived" || area === "runs") && name !== undefined) {
    const piece = `$${name}`;
    if (keys.length > 0) {
      const takes = area === "values" ? "start, secret and keep" : area === "runs" ? "kind, cmd, env, args, stdin, on, cwd, timeout, stream, confirm, every, once and always" : "an expression";
      return keys.map(k => slateProblem(area === "runs" ? "K704" : "T302", `${piece} has no ${k}; it takes ${takes}`, { piece, prop: k }));
    }
    if (area === "runs" && issue.code === "invalid_union_discriminator") return [slateProblem("K701", `${piece} takes kind "cmd", "tool" or "resource"`, { piece, prop: "kind" })];
    return [slateProblem(area === "runs" ? "K704" : "T303", `${piece}.${path.slice(2).join(".") || "decl"}: ${issue.message}`, { piece, ...(field !== undefined ? { prop: field } : {}) })];
  }
  if (area === "reactions") return [slateProblem("A611", `reaction ${Number(name) + 1}${path.length > 2 ? `.${path.slice(2).join(".")}` : ""}: ${issue.message}; a <when> is { on: { change: [paths] } or { done: name }, do: [steps] }`, { piece: `reaction-${Number(name) + 1}` })];
  if (keys.length > 0) return keys.map(k => slateProblem("D202", `the document has no ${k}; it holds ${DOC_KEYS.join(", ")}${area === undefined && k in SLATE_RESERVED_PROPS ? "; a piece's props go under pieces.<id>.props" : ""}`, { fix: nearest(k, DOC_KEYS) }));
  return [slateProblem("D202", `${path.join(".") || "the document"}: ${issue.message}`)];
}
