import { describe, expect, it } from "vitest";
import { parseSlate, runSlateBatch, sketchSlate, slateCatalog, slateStartValues, slateTokens, SLATE_EXAMPLES, SLATE_PIECES, SLATE_SOURCES, type SlateDoc, type SlateJson } from "../../src/slate/index.js";
import { SLATE_INDEX_EXAMPLE } from "../../src/slate/catalog.js";
import { SPEC_EXAMPLES } from "./examples.js";

const now = Date.parse("2026-10-04T12:00:00Z");
const setup = (): SlateDoc => parseSlate(SPEC_EXAMPLES.find(e => e.text.includes("Deploy setup") && e.text.includes("vercelToken"))!.text).document!;

describe("the sketch", () => {
  it.each(SPEC_EXAMPLES.map(e => [e.name, e.text]))("%s sketches under its budget", (_name, text) => {
    const d = parseSlate(text).document!;
    const s = sketchSlate(d, slateStartValues(d), { version: 1, now });
    expect(s.split("\n")[0]).toMatch(/^slate v1 ".+", \d+ pieces, \d+ bound, 0 problems$/);
    expect(slateTokens(s)).toBeLessThan(500);
    expect(s.split("\n").every(l => l.length <= 100)).toBe(true);
  });

  it("draws the setup slate as the person sees it, the secret as dots, and the runs that moved", () => {
    const d = setup();
    const handle = { secret: true, set: true, len: 24, at: now };
    let v = runSlateBatch(d, slateStartValues(d), [{ path: "$vercelToken", value: handle }], { by: "person" }).values;
    v = runSlateBatch(d, v, [], { by: "person", event: { piece: "button-2", kind: "press" } }).values;
    v = runSlateBatch(d, v, [{ path: "$project", value: "wsp-landing" }], { by: "person", start: () => ({ state: "held", why: "needs your approval", runs: 0 }) }).values;
    const s = sketchSlate(d, v, { version: 4, now });
    expect(s).toBe([
      'slate v4 "Deploy setup", 24 pieces, 8 bound, 0 problems',
      "Step 2 of 4  [text-1 text strong]",
      "(hidden) [section-1 section]",
      "2. The project  [section-2 section]",
      '  Project name on Vercel: "wsp-landing"  [project-name input mono]',
      "  Approve the check to go on  [text-2 text muted]",
      "  (hidden) [text-3 text muted]",
      "  (hidden) [text-4 text bad]",
      "  (hidden) [text-5 text good]",
      "(hidden) [section-3 section]",
      "(hidden) [section-4 section]",
      "values:",
      "  $step = 2",
      '  $project = "wsp-landing"',
      "  $vercelToken = •••• (24 characters)",
      "  $checked = false",
      "  $written = false",
      "runs:",
      "  $check: held needs your approval",
    ].join("\n"));
    expect(s).not.toContain("plaintext");
  });

  it("shows formulas in braces for a check with no thread", () => {
    const d = parseSlate(`<slate><column><meter id="week" label="Weekly" value={usage.week.percent} /></column></slate>`).document!;
    expect(sketchSlate(d, {}, { check: true })).toBe('slate, 2 pieces, 1 bound, 0 problems\nWeekly  [{usage.week.percent} of 100]  [week meter]');
  });
});

describe("the catalog", () => {
  it("keeps the index near 1,000 tokens and its example valid", () => {
    expect(slateTokens(slateCatalog())).toBeLessThan(1060);
    expect(parseSlate(SLATE_INDEX_EXAMPLE).errors).toEqual([]);
    expect(slateCatalog()).toContain(SLATE_INDEX_EXAMPLE);
  });

  it("answers every piece under 200 tokens and every source under 300", () => {
    for (const p of Object.keys(SLATE_PIECES)) expect(slateTokens(slateCatalog(p)), p).toBeLessThan(200);
    for (const s of Object.keys(SLATE_SOURCES)) expect(slateTokens(slateCatalog(s)), s).toBeLessThan(300);
  });

  it("answers runs, functions, steps, handlers and examples within their budgets", () => {
    // A line for each run attribute, after small models guessed what always and once did, took it from 590 to 660.
    expect(slateTokens(slateCatalog("runs"))).toBeLessThan(660);
    for (const n of ["functions", "steps", "handlers"]) expect(slateTokens(slateCatalog(n)), n).toBeLessThan(600);
    expect(slateTokens(slateCatalog("examples"))).toBeLessThan(3500);
    for (const e of SLATE_EXAMPLES) expect(parseSlate(e.text).errors, e.title).toEqual([]);
  });

  it("the runs entry gives each run attribute a line of its own, and says what shown, a failed run, stale and a restart mean", () => {
    const lines = slateCatalog("runs").split("\n");
    for (const attr of ["name", "cmd", "env", "every", "always", "once", "timeout", "on", "confirm", "then", "tool"]) expect(lines.some(l => l.startsWith(`${attr}:`) || l.startsWith(`${attr}=`)), attr).toBe(true);
    const text = slateCatalog("runs");
    expect(text).toContain("while the Slate tab is on screen in the app");
    expect(text).toContain("A failed run's out and json are its own, often empty");
    expect(text).toContain("stale: the command changed since this result.");
    expect(text).toContain("<value> state and each run's last result outlive an app or host restart.");
  });

  it("names the nearest entry for a wrong name", () => {
    expect(slateCatalog("metre")).toMatch(/^metre is not in the catalog; did you mean meter\?/);
  });

  it("every piece's catalog example compiles", () => {
    for (const p of Object.values(SLATE_PIECES)) expect(slateCatalog(p.type), p.type).toMatch(/\nsketch: /);
  });
});

describe("the sketch says what the person sees", () => {
  type Spec = (typeof SLATE_PIECES)[string]["props"][string];
  const ROWS = [{ name: "a", v: 1, at: 1_759_000_000_000, title: "A", done: false }, { name: "b", v: 2, at: 1_759_000_060_000, title: "B", done: true }];
  /** Two different literals a prop of this spec may hold, the first one what a fresh piece is given: its default
   * where it has one, so the second moves it away from the default. */
  const pair = (name: string, spec: Spec): [SlateJson, SlateJson] => {
    const t = spec.type;
    if (Array.isArray(t)) return spec.default === undefined ? [t[0]!, t[1]!] : [spec.default, t.find(v => v !== spec.default)!];
    switch (t) {
      case "boolean": return [true, false];
      case "number": return [40, 70];
      case "text": return [12345, 23456];
      case "integer": return [spec.min ?? 1, (spec.min ?? 1) + 1];
      case "list": return name === "items" ? [ROWS, [...ROWS, { ...ROWS[1]!, name: "c", v: 3, at: 1_759_000_120_000 }]] : [[1, 2, 3], [4, 5, 6, 7]];
      case "icon": return ["zap", "clock"];
      case "path": return ["$r", "$s"];
      case "id": return ["a", "b"];
      default: return ["Alpha", "Beta"];
    }
  };
  /** A prop the person sees only in some state, and that state: a placeholder while empty, an answer once picked. */
  const SHOWN_WHEN: Record<string, Record<string, SlateJson>> = { placeholder: { value: "" }, answer: { options: ["Alpha", "Beta"], value: "Alpha" } };
  const fresh = (type: string): Record<string, SlateJson> => {
    const m = SLATE_PIECES[type]!;
    const props: Record<string, SlateJson> = {};
    for (const [name, spec] of Object.entries(m.props)) if (spec.required === true) props[name] = pair(name, spec)[0];
    for (const item of Object.values(m.items)) {
      if ((item.min ?? 0) === 0) continue;
      props[item.prop] = Array.from({ length: item.min! }, (_, i) => Object.fromEntries(Object.entries(item.fields).filter(([, f]) => f.required === true).map(([k, f]) => [k, f.type === "id" ? `c${i}` : `${String(pair(k, f)[0])}${i}`])));
    }
    return props;
  };
  const sketchOf = (type: string, props: Record<string, SlateJson>): string => {
    const run = { state: "done", exit: 0, out: "hi", err: "", runs: 1 };
    const doc = { schema: 2, root: "p", values: {}, derived: {}, reactions: [], runs: { r: { kind: "cmd", cmd: "true" }, s: { kind: "cmd", cmd: "true" } }, pieces: { p: { type, props } } } as unknown as SlateDoc;
    return sketchSlate(doc, { r: run, s: { ...run, out: "other" } } as never, { now });
  };

  it("says a chart's axes as they are labelled: an index from 0, a time by the clock", () => {
    const traffic = (x: string) => parseSlate(`<slate><value name="hits" start={${JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ n: 100 + i, at: Date.parse("2026-10-04T16:48:00") + i * 60_000 })))}} /><column><chart label="Requests" items={$hits} ${x} value={item.n} /></column></slate>`).document!;
    const byIndex = sketchSlate(traffic("x={index}"), slateStartValues(traffic("x={index}")));
    expect(byIndex).toContain("Requests  last 159, min 100, max 159 over 60 points");
    expect(byIndex.split("\n")).toContain("  x 0 to 59, y 100 to 180");
    const byTime = sketchSlate(traffic("x={item.at}"), slateStartValues(traffic("x={item.at}")));
    expect(byTime.split("\n")).toContain("  x 16:48 to 17:47, y 100 to 180");
  });

  for (const [type, m] of Object.entries(SLATE_PIECES)) {
    it(`${type}: every prop it declares that the person sees changes its sketch`, () => {
      for (const [name, spec] of Object.entries(m.props)) {
        if (spec.unseen !== undefined) continue;
        const [a, b] = pair(name, spec);
        const base = { ...fresh(type), ...SHOWN_WHEN[name] };
        expect(sketchOf(type, { ...base, [name]: a }), `${type}.${name}`).not.toBe(sketchOf(type, { ...base, [name]: b }));
      }
      for (const [kind, item] of Object.entries(m.items)) {
        for (const [field, spec] of Object.entries(item.fields)) {
          if (spec.unseen !== undefined) continue;
          const [a, b] = pair(field, spec);
          const base = fresh(type);
          const list = (base[item.prop] as Record<string, SlateJson>[] | undefined) ?? [Object.fromEntries(Object.entries(item.fields).filter(([, f]) => f.required === true).map(([k, f]) => [k, pair(k, f)[0]]))];
          const withField = (v: SlateJson) => ({ ...base, ...(item.row === true ? { items: ROWS } : {}), [item.prop]: list.map((x, i) => (i === 0 ? { ...x, [field]: v } : x)) });
          expect(sketchOf(type, withField(a)), `${type} <${kind} ${field}>`).not.toBe(sketchOf(type, withField(b)));
        }
      }
    });
  }
});

describe("the sketch of the sessions' writes", () => {
  const wrap = (pieces: string, decls = ""): string => `<slate title="T">\n${decls}\n  <column>\n    ${pieces}\n  </column>\n</slate>`;
  const sketch = (text: string, set: Record<string, SlateJson> = {}): string => {
    const r = parseSlate(text);
    expect(r.errors).toEqual([]);
    return sketchSlate(r.document!, { ...slateStartValues(r.document!), ...set }, { now });
  };

  it("leaves out a fact, a column and an option whose when does not hold, and keeps them when it does", () => {
    const decls = `  <value name="all" start={false} />\n  <value name="pick" start={null} />\n  <value name="rows" start={[{ name: "node", pid: 19271 }]} />`;
    const text = wrap(`<facts><fact label="Name" value="node" /><fact label="PID" value="19271" when={$all} /></facts>
    <table items={$rows}><col title="Name" value={item.name} /><col title="PID" value={item.pid} when={$all} /></table>
    <select label="Pick" value={$pick}><option value="a" /><option value="b" when={$all} /></select>`, decls);
    const off = sketch(text);
    expect(off).toContain("Name: node  [facts-1 facts]");
    expect(off).not.toContain("PID: 19271");
    expect(off).toContain("| Name |  [table-1 table]");
    expect(off).toContain("Pick: (none) (of a)");
    const on = sketch(text, { all: true });
    expect(on).toContain("Name: node  PID: 19271");
    expect(on).toContain("| Name | PID |");
    expect(on).toContain("(of a, b)");
  });

  it("draws a section a literal open={false} starts shut as collapsed", () => {
    expect(sketch(wrap(`<section title="More" collapsible open={false}><text>inside</text></section>`))).toContain("More (collapsed)");
  });

  it("names an icon a formula gives that the kit lacks as a problem, and stays quiet on one it has", () => {
    const text = wrap(`<number label="Change" value={$d} icon={$d >= 0 ? 'trending-up' : 'rocket-ship'} />`, `  <value name="d" start={1} />`);
    expect(sketch(text)).toContain("0 problems");
    const s = sketch(text, { d: -1 });
    expect(s).toContain("1 problem");
    expect(s).toContain('R905 number-1.icon: icon "rocket-ship" is not in the kit, so it draws none');
  });
});
