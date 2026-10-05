// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  applySlatePatch, parseSlatePatch, evaluateSlateExpression, parseSlate, printSlate, runSlateBatch, sketchSlate, slateCatalog, slateStartValues, validateSlate,
  SLATE_EXAMPLES, SLATE_ICONS, SLATE_PIECES, type SlateDoc, type SlateJson, type SlateValues,
} from "../../src/slate/index.js";

const example = (title: string): string => SLATE_EXAMPLES.find(e => e.title === title)!.text;
const GOLD = example("a live figure with an hour of history");
const QUIZ = example("a quiz that logs each answer");

function compiled(text: string): SlateDoc {
  const r = parseSlate(text);
  expect(r.errors).toEqual([]);
  return r.document!;
}

const slate = (body: string): string => `<slate>\n  <value name="hist" start={[1, 2, 3]} />\n  <value name="pick" start={null} />\n  <column>\n${body}\n  </column>\n</slate>`;
const codes = (text: string): string[] => { const r = parseSlate(text); return [...r.errors, ...r.warnings].map(p => p.code); };
const ev = (expr: string, values: Record<string, SlateJson> = {}, now?: number): SlateJson | undefined =>
  evaluateSlateExpression(expr, { resolve: p => (p.startsWith("$") ? values[p.slice(1)] : undefined), ...(now !== undefined ? { now } : {}) });

describe("the richer kit", () => {
  it("validates, sketches and prints back every new piece and prop", () => {
    const text = slate([
      `    <heading level="title" icon="gauge">Gold</heading>`,
      `    <heading level="label">Feed</heading>`,
      `    <grid columns={3} gap="loose" align="center" pad="tight" surface="inset"><number label="A" value={1} icon="zap" trend={$hist} /><number label="B" value={2} unit={concat('of ', 'x')} /><number label="C" value={3} /></grid>`,
      `    <section title="Feed" icon="activity" surface="inset" pad="loose" align="center"><text icon="clock">Every minute</text></section>`,
      `    <column pad="none" surface="plain" align="end"><button label="Go" icon="play" onPress={set($pick, 1)} /></column>`,
      `    <facts><fact label={concat('Sp', 'ot')} value={1} icon="tag" /></facts>`,
      `    <status tone="good">Live</status>`,
      `    <chip icon="git-branch">main</chip>`,
      `    <ring label="Done" value={3} max={4} format="fraction" tone="good" note="almost" />`,
      `    <chart label="Line" items={[{ at: '2026-10-04T12:00:00Z', v: 1 }, { at: '2026-10-04T12:01:00Z', v: 2 }, { at: '2026-10-04T12:02:00Z', v: 3 }]} x={item.at} value={item.v} format="usd" height="small" />`,
      `    <sparkline label="Load" values={$hist} />`,
      `    <bars label="Busiest" items={[{ n: 'a', v: 2 }]} name={item.n} value={item.v} />`,
      `    <choices label="Pick" value={$pick} options={[1, 2, 3]} answer={2} />`,
      `    <choices label="Pick again" value={$pick}><option value={1} label="One" note="the first" /><option value={2} label="Two" /></choices>`,
    ].join("\n"));
    expect(codes(text)).toEqual([]);
    const doc = compiled(text);
    for (const type of ["heading", "grid", "status", "chip", "ring", "chart", "sparkline", "bars", "choices"]) expect(Object.values(doc.pieces).some(p => p.type === type), type).toBe(true);
    const sketch = sketchSlate(doc, { ...slateStartValues(doc), pick: 2 });
    expect(sketch).toContain("# Gold  [heading-1 heading icon=gauge]");
    expect(sketch).toContain("FEED");
    expect(sketch).toContain("grid of 3");
    expect(sketch).toContain("A  1  trend 1 to 3");
    expect(sketch).toContain("(good) Live");
    expect(sketch).toContain("[main]");
    expect(sketch).toContain("Done  (3/4) [########..]  almost");
    expect(sketch).toContain("Line  last $3.00, min $1.00, max $3.00 over 3 points");
    expect(sketch).toMatch(/\n {2}x \d\d:\d\d to \d\d:\d\d, y \$0\.00 to \$4\.00\n/);
    expect(sketch).toContain("(x) 2 right");
    expect(compiled(printSlate(doc))).toEqual(doc);
    for (const type of ["heading", "grid", "status", "chip", "ring", "chart", "sparkline", "bars", "choices", "number", "section", "diagram"]) {
      expect(slateCatalog(type), type).toContain(SLATE_PIECES[type]!.purpose);
      const declared = `<value name="hist" start={[]} /><value name="pick" start={null} /><value name="up" start={true} /><value name="done" start={1} /><value name="steps" start={[]} /><value name="q" start={{ options: [], answer: null }} /><value name="step" start="build" />`;
      expect(parseSlate(`<slate>${declared}<column>${SLATE_PIECES[type]!.example}</column></slate>`).errors, type).toEqual([]);
    }
  });

  it("refuses what is not a design token", () => {
    expect(codes(slate(`    <grid columns={5}><text>a</text></grid>`))).toEqual(["T303"]);
    expect(codes(slate(`    <section title="x" pad="huge"><text>a</text></section>`))).toEqual(["T306"]);
    expect(codes(slate(`    <section title="x" background="grey"><text>a</text></section>`))).toEqual(["T312"]);
    expect(codes(slate(`    <bars label="Price" items={$hist} name={date(item)} value={item} />`))).toEqual(["W003"]);
    expect(codes(slate(`    <bars label="Price" items={$hist} name={item.at} value={item} />`))).toEqual(["W003"]);
  });

  it("warns of a misspelt icon with the nearest name, and writes the slate anyway", () => {
    const misspelt = parseSlate(slate(`    <text icon="gaueg">x</text>`));
    expect(misspelt.errors).toEqual([]);
    expect(misspelt.document).toBeDefined();
    expect(misspelt.warnings).toMatchObject([{ code: "W016", piece: "text-1", prop: "icon", fix: `icon="gauge"` }]);
    expect(misspelt.warnings[0]!.message).toContain("did you mean gauge?");
    expect(parseSlate(slate(`    <button label="x" icon="GitBranchIcon" onPress={set($pick, 1)} />`)).warnings).toMatchObject([{ code: "W016", fix: `icon="git-branch"` }]);
    expect(parseSlate(slate(`    <text icon={$pick}>x</text>`)).errors).toEqual([]);
    expect(slateCatalog("icons")).toContain(SLATE_ICONS.join(" "));
  });

  it("keeps a rolling history with record literals, append and last(list, n)", () => {
    expect(ev("append($h, { at: time.now, v: 2 })", { h: [{ at: 1, v: 1 }] }, 5)).toEqual([{ at: 1, v: 1 }, { at: 5, v: 2 }]);
    expect(ev("append(null, 1)")).toEqual([1]);
    expect(ev("last(append($h, 4), 3)", { h: [1, 2, 3] })).toEqual([2, 3, 4]);
    expect(ev("last($h)", { h: [1, 2, 3] })).toBe(3);
    expect(ev("[1, $a + 1, 'x']", { a: 1 })).toEqual([1, 2, "x"]);
  });

  it("reads a computed index and at(list, i)", () => {
    const values = { qs: [{ q: "a" }, { q: "b" }], i: 1 };
    expect(ev("$qs[$i].q", values)).toBe("b");
    expect(ev("$qs[$i - 1].q", values)).toBe("a");
    expect(ev("$qs[-1].q", values)).toBe("b");
    expect(ev("at($qs, $i).q", values)).toBe("b");
    expect(ev("$qs[$i + 4]", values)).toBe(null);
    expect(codes(`<slate><value name="qs" start={[{ q: "a" }]} /><value name="i" start={0} /><column><text>{$qs[$i].q}</text></column></slate>`)).toEqual([]);
  });

  it("draws the example: a heading, numbers with icons, an inset section, a status, a chip, a ring and a chart fed by a history", () => {
    const doc = compiled(GOLD);
    let values: SlateValues = slateStartValues(doc);
    for (const [at, price] of [[1000, 2400.5], [61000, 2401.25], [121000, 2399]] as const) {
      values = runSlateBatch(doc, values, [{ path: "$spot", value: { state: "done", exit: 0, out: "", json: { price }, runs: 1 } }], { by: "run", now: at }).values;
    }
    expect(values.hist).toEqual([{ at: 1000, v: 2400.5 }, { at: 61000, v: 2401.25 }, { at: 121000, v: 2399 }]);
    const sketch = sketchSlate(doc, values, { now: 121000 });
    for (const line of ["# Gold", "grid of 3", "Per ounce  $2,399.00  trend 2400.5 to 2399", "Low  $2,399.00", "High  $2,401.25", "Feed", "(good) Live", "[every minute]", "Last hour  (3/60) [#.........]", "Per ounce, last hour  last $2,399.00, min $2,399.00, max $2,401.25 over 3 points", "  x 1000 to 121000, y $2,399.00 to $2,401.50"]) expect(sketch).toContain(line);
    let capped: SlateValues = { ...values, hist: Array.from({ length: 60 }, (_, i) => ({ at: i, v: i })) };
    capped = runSlateBatch(doc, capped, [{ path: "$spot", value: { state: "done", exit: 0, json: { price: 99 }, runs: 2 } }], { by: "run", now: 9 }).values;
    expect((capped.hist as SlateJson[]).length).toBe(60);
    expect((capped.hist as SlateJson[]).at(-1)).toEqual({ at: 9, v: 99 });
  });

  it("logs a quiz's answers with append under a computed index", () => {
    const doc = compiled(QUIZ);
    const start = slateStartValues(doc);
    const picked = runSlateBatch(doc, start, [{ path: "$pick", value: "Network" }], { by: "person", event: { piece: "answer", kind: "change" } });
    expect(picked.values.log).toEqual([{ q: "Which layer routes packets between networks?", pick: "Network", right: true }]);
    expect(sketchSlate(doc, picked.values)).toContain("(x) Network right");
  });
});

describe("writing commands and fixes", () => {
  it("takes a command with both quote kinds three ways", () => {
    const want = `python3 -c "print('a $HOME {b}')"`;
    for (const form of [`cmd={"python3 -c \\"print('a $HOME {b}')\\""}`, "cmd={`python3 -c \"print('a $HOME {b}')\"`}"]) {
      expect(compiled(`<slate><run name="py" ${form} /><column><output run={$py} /></column></slate>`).runs.py).toEqual({ kind: "cmd", cmd: want });
    }
    const block = compiled("<slate><run name=\"py\" timeout={20}>{`python3 -c \"print('a $HOME {b}')\"`}</run><column><output run={$py} /></column></slate>");
    expect(block.runs.py).toEqual({ kind: "cmd", cmd: want, timeout: 20 });
    expect(compiled(printSlate(block))).toEqual(block);
    expect(slateCatalog("runs")).toContain(`<run name="py">{\``);
  });

  it("takes formulas on display props", () => {
    expect(codes(slate(`    <number label="Score" value={1} unit={\`of \${len($hist)}\`} />\n    <text placeholder={'Wait'}>{$pick}</text>`))).toEqual([]);
  });

  it("never offers as a fix what was written", () => {
    const r = parseSlate(`<slate><value name="qs" start={[1]} /><value name="i" start={0} /><column><select label="x" value={$qs[$i]} options={[1]} /></column></slate>`);
    expect(r.errors).toMatchObject([{ code: "X410" }]);
    expect(r.errors[0]!.fix).toBe(`<value name="picked" start={null} /> and value={$picked}`);
  });

  it("names the piece and prop for a prop placed outside props", () => {
    const r = validateSlate({ schema: 2, root: "col", pieces: { col: { type: "column", children: ["t"] }, t: { type: "text", tone: "bad", props: { value: "x" } } } });
    expect(r.errors).toEqual([expect.objectContaining({ code: "T302", piece: "t", prop: "tone", fix: `"props": { "tone": ... }` })]);
    expect(r.errors[0]!.message).toContain("tone sits beside props on t");
    const run = validateSlate({ schema: 2, root: "c", runs: { r: { kind: "cmd", cmd: "true", every: 60, alway: true } }, pieces: { c: { type: "column" } } });
    expect(run.errors).toMatchObject([{ code: "K704", piece: "$r", prop: "alway" }]);
  });

  it("marks a run whose command changed since it ran", () => {
    const doc = compiled(`<slate><run name="weather" cmd="true" /><column><text when={not $weather.stale}>fresh</text></column></slate>`);
    const sketch = sketchSlate(doc, { weather: { state: "done", exit: 0, ms: 812, runs: 1, stale: true } });
    expect(sketch).toContain("$weather: done (exit 0, 812 ms), stale: the command changed since it ran");
    expect(sketch).toContain("(hidden)");
  });

  it("applies the index's one-line patch by id", () => {
    const line = /<props id="price"[^>]*\/>/.exec(slateCatalog())![0];
    const doc = compiled(`<slate><run name="spot" cmd="true" /><column><number id="price" label="Price" value={1} /></column></slate>`);
    const { patch, errors } = parseSlatePatch(line, doc);
    expect(errors).toEqual([]);
    const out = applySlatePatch(doc, slateStartValues(doc), patch!);
    expect(out.errors).toEqual([]);
    expect(out.document!.pieces.price!.props!.value).toEqual({ bind: "$spot.json.v" });
  });
});

describe("the diagram", () => {
  it("takes a Mermaid source as a literal text child, braces and all, or a formula that reads the live step", () => {
    const literal = parseSlate(`<slate><column><diagram id="d" label="Flow">flowchart TD
  A{Ready?} -->|yes| B[Ship]</diagram></column></slate>`);
    expect(literal.errors).toEqual([]);
    expect(literal.document!.pieces["d"]!.props).toEqual({ label: "Flow", value: "flowchart TD\n  A{Ready?} -->|yes| B[Ship]" });
    const live = parseSlate(`<slate><value name="step" start="test" /><column>${SLATE_PIECES["diagram"]!.example}</column></slate>`);
    expect(live.errors).toEqual([]);
    expect(sketchSlate(live.document!, { step: "test" }, {})).toContain("Deploy  flowchart LR (+3 lines)");
    expect(parseSlate(printSlate(live.document!)).document).toEqual(live.document);
    expect(parseSlate(`<slate><column><diagram label="Flow" /></column></slate>`).errors.map(e => e.code)).not.toEqual([]);
  });

  it("is in the catalog's index, which points a flow at it", () => {
    expect(slateCatalog()).toContain("diagram: value! label");
    expect(slateCatalog()).toContain("a flow is a diagram");
  });
});
