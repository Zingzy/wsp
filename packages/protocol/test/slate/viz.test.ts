// SPDX-License-Identifier: AGPL-3.0-only
// The chart kinds past one line: series and a stack on the chart, the timeline, the treemap and the donut, as the
// agent writes them, as the sketch tells it what they drew, and the misuse each refuses with a code and a sentence.
import { describe, expect, it } from "vitest";
import { parseSlate, printSlate, sketchSlate, slateStartValues, type SlateJson, type SlateProblem } from "../../src/slate/index.js";

const wrap = (piece: string, name: string): string => `<slate title="T">\n  <value name="${name}" start={[]} />\n  <column>\n    ${piece}\n  </column>\n</slate>`;

function drawn(piece: string, name: string, rows: SlateJson[]): { sketch: string; problems: SlateProblem[] } {
  const r = parseSlate(wrap(piece, name));
  expect(r.errors).toEqual([]);
  expect(parseSlate(printSlate(r.document!)).document).toEqual(r.document);
  const problems: SlateProblem[] = [];
  const sketch = sketchSlate(r.document!, { ...slateStartValues(r.document!), [name]: rows }, { now: Date.parse("2026-10-07T14:10:25") });
  for (const line of sketch.split("\n").filter(l => /^  [A-Z]\d{3} /.test(l))) problems.push({ code: line.trim().slice(0, 4), name: "", message: line.trim() } as SlateProblem);
  return { sketch, problems };
}

/** A problem the agent reads is one sentence: no full stop before its end. */
const oneSentence = (message: string): boolean => !/\.\s/.test(message.replace(/\.\.\./g, ""));

const LAT = [
  { at: "2026-10-07T14:00:00", p50: 19, p99: 210 },
  { at: "2026-10-07T14:10:00", p50: 22, p99: 340 },
  { at: "2026-10-07T14:20:00", p50: 18, p99: 190 },
];
const STEPS: SlateJson[] = [
  { job: "Build", name: "Web app", start: "2026-10-07T14:02:10", end: "2026-10-07T14:04:03" },
  { job: "Test", name: "Shard 1", start: "2026-10-07T14:04:03" },
  { job: "Test", name: "Shard 2", start: "2026-10-07T14:04:03", end: "2026-10-07T14:05:00", state: "failed" },
  { job: "Deploy", name: "Preview" },
];
const MODULES = [
  { pkg: "mermaid", name: "core", bytes: 231_424 },
  { pkg: "mermaid", name: "dagre", bytes: 59_392 },
  { pkg: "app", name: "chat", bytes: 94_208 },
];
const COUNTRIES = ["India", "Brazil", "Germany", "Japan", "Kenya", "Peru", "Chile", "Norway"].map((name, i) => ({ name, n: 800 - i * 100 }));

describe("the chart kinds", () => {
  it("draws two to four series over one x, each line with its own figures", () => {
    const { sketch } = drawn(`<chart id="lat" label="Latency" items={$lat} x={item.at} unit="ms"><series label="p50" value={item.p50} /><series label="p99" value={item.p99} tone="bad" /></chart>`, "lat", LAT);
    expect(sketch).toContain("Latency  2 lines over 3 points");
    expect(sketch).toContain("  p50  last 18 ms, min 18 ms, max 22 ms");
    expect(sketch).toContain("  p99  last 190 ms, min 190 ms, max 340 ms [bad]");
    expect(sketch).toContain("  x 14:00 to 14:20, y 0 ms to 400 ms");
  });

  it("piles a stack's series into bands of one total, the axis reaching the total", () => {
    const { sketch } = drawn(`<chart id="lat" label="Latency" items={$lat} x={item.at} stack><series label="p50" value={item.p50} /><series label="p99" value={item.p99} /></chart>`, "lat", LAT);
    expect(sketch).toContain("Latency  2 stacked lines over 3 points");
    expect(sketch).toContain("  p99  last 190, min 190, max 340");
    expect(sketch).toContain("y 0 to 400");
  });

  it("draws a timeline's spans by clock, a running one to now, a failed and a waiting one in words, under their group", () => {
    const { sketch } = drawn(`<timeline id="ci" label="CI run" items={$steps} name={item.name} start={item.start} end={item.end} state={item.state} group={item.job} />`, "steps", STEPS);
    const lines = sketch.split("\n");
    expect(lines).toContain("  Build");
    expect(lines).toContain("  Web app  14:02:10 to 14:04:03  1m 53s");
    expect(lines).toContain("  Shard 1  14:04:03 to now  running 6m 22s");
    expect(lines).toContain("  Shard 2  14:04:03 to 14:05:00  failed");
    expect(lines).toContain("  Preview  waiting");
  });

  it("draws a treemap's parts with their share of the whole, and a donut's biggest five with the rest as Other", () => {
    const tree = drawn(`<treemap id="b" label="Bundle" items={$mods} name={item.name} value={item.bytes} group={item.pkg} format="bytes" />`, "mods", MODULES).sketch;
    expect(tree).toContain("Bundle  376 KB in 3 parts, 2 groups");
    expect(tree).toContain("  mermaid  core  226 KB 60%");
    const donut = drawn(`<donut id="c" label="Clicks" items={$c} name={item.name} value={item.n} format="integer" unit="clicks" />`, "c", COUNTRIES).sketch;
    expect(donut).toContain("Clicks  3,600 clicks");
    expect(donut).toContain("  India  800 22%");
    expect(donut).toContain("  Other  600 17%");
    expect(donut).not.toContain("Peru");
    // Six parts are five and Other, as the purpose says: the panel has five inks and Other's grey.
    const six = drawn(`<donut id="c" label="Clicks" items={$c} name={item.name} value={item.n} />`, "c", COUNTRIES.slice(0, 6)).sketch.split("\n");
    expect(six.filter(l => /^  [A-Z][a-z]+  \d/.test(l)).map(l => l.trim().split("  ")[0])).toEqual(["India", "Brazil", "Germany", "Japan", "Kenya", "Other"]);
  });
});

describe("what the chart kinds refuse", () => {
  it("a timeline whose start is not a time", () => {
    const { problems } = drawn(`<timeline id="ci" label="CI" items={$steps} name={item.name} start={item.start} end={item.end} />`, "steps", [{ name: "Build", start: "soon", end: "2026-10-07T14:04:03" }]);
    expect(problems.map(p => p.message)).toEqual([`R905 ci.start: start={item.start} read a string on 1 of 1 rows, like "soon", which is not a time, so it draws no span; a time is ISO or ms`]);
    expect(oneSentence(problems[0]!.message)).toBe(true);
  });

  it("a timeline whose end is not a time", () => {
    const { problems } = drawn(`<timeline id="ci" label="CI" items={$steps} name={item.name} start={item.start} end={item.end} />`, "steps", [{ name: "Build", start: "2026-10-07T14:02:10", end: { at: 1 } }]);
    expect(problems.map(p => p.message)).toEqual([`R905 ci.end: end={item.end} read an object on 1 of 1 rows, like {"at":1}, which is not a time, so it draws no span; a time is ISO or ms`]);
    expect(oneSentence(problems[0]!.message)).toBe(true);
  });

  it("a treemap value that is not a number", () => {
    const { problems } = drawn(`<treemap id="b" label="Bundle" items={$mods} name={item.name} value={item.size} />`, "mods", [{ name: "core", size: "226 KB" }]);
    expect(problems.map(p => p.message)).toEqual([`R905 b.value: value={item.size} read a string on 1 of 1 rows, like "226 KB", so it draws no point for them; a plotted value is a number`]);
    expect(oneSentence(problems[0]!.message)).toBe(true);
  });

  it("a donut value that is not a number", () => {
    const { problems } = drawn(`<donut id="c" label="Clicks" items={$c} name={item.name} value={item} />`, "c", [{ name: "India", n: 41 }]);
    expect(problems.map(p => p.message)).toEqual([`R905 c.value: value={item} read an object on 1 of 1 rows, like {"name":"India","n":41}, so it draws no point for them; a plotted value is a number, like value={item.n}`]);
    expect(oneSentence(problems[0]!.message)).toBe(true);
  });

  it("a series value that is not a number", () => {
    const { problems } = drawn(`<chart id="lat" label="Latency" items={$lat} x={item.at}><series label="p50" value={item.at} /><series label="p99" value={item.p99} /></chart>`, "lat", LAT);
    expect(problems.map(p => p.message)).toEqual([`R905 lat.series: <series value={item.at}> read a string on 3 of 3 rows, like "2026-10-07T14:00:00", so it draws no point for them; a plotted value is a number`]);
    expect(oneSentence(problems[0]!.message)).toBe(true);
  });

  it("more than four series", () => {
    const five = ["p50", "p75", "p90", "p95", "p99"].map(p => `<series label="${p}" value={item.${p}} />`).join("");
    const r = parseSlate(wrap(`<chart id="lat" label="Latency" items={$lat} x={item.at}>${five}</chart>`, "lat"));
    expect(r.errors.map(e => [e.code, e.message])).toEqual([["T309", "chart takes at most 4 <series>"]]);
    expect(oneSentence(r.errors[0]!.message)).toBe(true);
  });

  it("a timeline start written in seconds is told it reads as 1970, with the fix, and the panel still draws", () => {
    const { sketch, problems } = drawn(`<timeline id="ci" label="CI" items={$steps} name={item.name} start={item.start} end={item.end} />`, "steps", [{ name: "Build", start: 1_759_900_000, end: "2026-10-07T14:04:03" }]);
    expect(problems.map(p => p.message)).toEqual([`W021 ci.start: start={item.start} read on 1 of 1 rows, like 1759900000, a time before 2000 that is most likely seconds where a slate reads milliseconds, like start={item.start * 1000}. Fix: start={item.start * 1000}`]);
    expect(sketch).toContain("0 problems, 1 warning");
    const fixed = drawn(`<timeline id="ci" label="CI" items={$steps} name={item.name} start={item.start * 1000} end={item.end} />`, "steps", [{ name: "Build", start: 1_759_900_000, end: "2026-10-07T14:04:03" }]);
    expect(fixed.problems).toEqual([]);
  });

  it("a chart that gives both value and series is told which one it draws", () => {
    const r = parseSlate(wrap(`<chart id="lat" label="Latency" items={$lat} x={item.at} value={item.p50}><series label="p99" value={item.p99} /></chart>`, "lat"));
    expect(r.errors).toEqual([]);
    expect(r.warnings.map(w => [w.code, w.message])).toEqual([["W020", "the chart draws its <series> and leaves value out; drop value, or give it a <series> of its own"]]);
  });

  it("a chart with neither a value nor a series", () => {
    const r = parseSlate(wrap(`<chart id="lat" label="Latency" items={$lat} x={item.at} />`, "lat"));
    expect(r.errors.map(e => [e.code, e.message, e.fix])).toEqual([["T304", "a chart draws value={...} or a <series> per line, and it has neither", "value={item.v}"]]);
  });
});
