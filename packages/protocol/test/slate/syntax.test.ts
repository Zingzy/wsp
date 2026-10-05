import { describe, expect, it } from "vitest";
import { applySlatePatch, parseSlate, parseSlatePatch, printSlate, slateCatalog, slateStartValues, validateSlate, type SlateDoc } from "../../src/slate/index.js";
import { SPEC_EXAMPLES } from "./examples.js";

const doc = (text: string): SlateDoc => {
  const r = parseSlate(text);
  expect(r.errors).toEqual([]);
  return r.document!;
};
const codes = (text: string): string[] => parseSlate(text).errors.map(e => e.code);

describe("the JSX-like form", () => {
  it.each(SPEC_EXAMPLES.map(e => [e.name, e.text]))("%s compiles and validates", (_name, text) => {
    const r = parseSlate(text);
    expect(r.errors).toEqual([]);
    expect(r.document?.schema).toBe(2);
  });

  it.each(SPEC_EXAMPLES.map(e => [e.name, e.text]))("%s prints back to the same document, and printing is idempotent", (_name, text) => {
    const d = doc(text);
    const printed = printSlate(d);
    const again = parseSlate(printed);
    expect(again.errors).toEqual([]);
    expect(again.document).toEqual(d);
    expect(printSlate(again.document!)).toBe(printed);
  });

  it("compiles attributes to literals, bindings, formats and steps", () => {
    const d = doc(`<slate title="T">
  <value name="n" start={1} />
  <run name="check" cmd='gh api "$URL"' env={{ URL: $url, MODE: "x" }} timeout={20} every="30s" />
  <value name="url" start="" />
  <when change={$url} do={start($check)} />
  <column>
    <meter id="week" label="Weekly" value={usage.week.percent} max={100} note={\`resets \${until(usage.week.resetsAt)}\`} />
    <text tone="muted">{len(pr.checks)} checks, {'{'}literal{'}'}</text>
    <button label="Go" onPress={[set($n, $n + 1), send("Went.", $n, pr.url)]} />
  </column>
</slate>`);
    expect(d.pieces.week!.props).toEqual({ label: "Weekly", value: { bind: "usage.week.percent" }, max: 100, note: { format: "resets ${until(usage.week.resetsAt)}" } });
    expect(d.pieces["text-1"]!.props!.value).toEqual({ format: "${len(pr.checks)} checks, {literal}" });
    expect(d.pieces["button-1"]!.on!.press).toEqual([{ do: "set", path: "$n", value: { bind: "$n + 1" } }, { do: "send", text: "Went.", with: ["$n", "pr.url"] }]);
    expect(d.runs.check).toEqual({ kind: "cmd", cmd: 'gh api "$URL"', env: { URL: { bind: "$url" }, MODE: "x" }, timeout: 20, every: 30 });
    expect(d.reactions).toEqual([{ on: { change: ["$url"] }, do: [{ do: "start", run: "check" }] }]);
  });

  it("names the common mistakes of 03 with their codes and lines", () => {
    const wrap = (piece: string, decls = ""): string => `<slate>\n${decls}  <column>\n    ${piece}\n  </column>\n</slate>`;
    expect(codes(wrap(`<text muted>Hi</text>`))).toEqual(["P102"]);
    expect(parseSlate(wrap(`<text muted>Hi</text>`)).errors[0]).toMatchObject({ line: 3, fix: 'tone="muted"' });
    expect(codes(wrap(`<meter label="W" value="usage.week.percent" />`))).toEqual(["T303"]);
    expect(codes(wrap(`<text label="Say \\"hi\\"" />`))).toEqual(["P100"]);
    expect(codes(wrap(`<text>{items.map(i => i.name)}</text>`))).toEqual(["X420"]);
    expect(codes(wrap(`<text>{len($failing.length)}</text>`, `  <value name="failing" start={[]} />\n`))).toEqual(["X420"]);
    expect(codes(wrap(`<text when={pr.number != null && pr.draft}>x</text>`))).toEqual([]);
    expect(codes(wrap(`<button label="Go" onClick={send("x")} />`))).toContain("A602");
    expect(codes(wrap(`<meter label="W" value={1}>`))).toEqual(["P100"]);
    expect(codes(`<slate><text>a</text><text>b</text></slate>`)).toEqual(["D202"]);
    expect(codes(wrap(`<button label="Go" onPress={() => set($x, 1)} />`, `  <value name="x" start={0} />\n`))).toEqual(["A600"]);
    expect(codes(wrap(`<text>x</text>`, "  <value name=\"url\" start=\"\" />\n  <run name=\"r\" cmd={`gh api ${$url}`} />\n"))).toEqual(["K700"]);
    expect(codes(wrap(`<text>x</text>`, "  <value name=\"id\" start=\"\" />\n  <run name=\"check\" cmd=\"true\" />\n  <when change={$id}>start($check)</when>\n"))).toEqual(["A601"]);
    expect(codes(wrap(`<text>Hello {name}</text>`, `  <value name="name" start="" />\n`))).toEqual(["X401"]);
    expect(parseSlate(wrap(`<text>Hello {name}</text>`, `  <value name="name" start="" />\n`)).errors[0]!.fix).toBe("$name");
    expect(codes(wrap(`<text tone={good}>x</text>`))).toEqual(["X401"]);
    expect(codes(wrap(`<meter label="W" value={usage.weekley.percent} colour="red" />`))).toEqual(["X401", "T312"]);
    expect(parseSlate(wrap(`<meter label="W" value={usage.weekley.percent} />`)).errors[0]).toMatchObject({ code: "X401", piece: "meter-1", prop: "value", line: 3, fix: "usage.week.percent" });
  });

  it("collects every error in one pass", () => {
    const r = parseSlate(`<slate>
  <column>
    <meter label="A" value={usage.weekley.percent} />
    <text tone="loud">x</text>
    <bogus />
  </column>
</slate>`);
    expect(r.errors.map(e => [e.code, e.line])).toEqual([["X401", 3], ["T306", 4], ["T300", 5]]);
  });
});

describe("patches", () => {
  const base = doc(`<slate title="P">
  <value name="steps" start={[{ title: "a", done: false }]} />
  <column>
    <meter id="week" label="Weekly" value={usage.week.percent} />
    <text id="eta">Soon</text>
    <section id="more" title="More"><text id="inner">x</text></section>
  </column>
</slate>`);
  const values = slateStartValues(base);
  const apply = (text: string) => {
    const p = parseSlatePatch(text, base);
    expect(p.errors).toEqual([]);
    return applySlatePatch(base, values, p.patch!);
  };

  it("sets a piece's text from a text child of <props>, with its holes, and refuses one on a piece that takes no text", () => {
    const r = apply(`<props id="eta">Due in {$steps | count} steps</props>`);
    expect(r.errors).toEqual([]);
    expect(r.document!.pieces.eta!.props).toEqual({ value: { format: "Due in ${$steps | count} steps" } });
    expect(apply(`<props id="eta" tone="muted">Later</props>`).document!.pieces.eta!.props).toEqual({ value: "Later", tone: "muted" });
    expect(parseSlatePatch(`<props id="week">Hi</props>`, base).errors.map(e => e.code)).toEqual(["P105"]);
    expect(parseSlatePatch(`<props id="eta" value="a">b</props>`, base).errors.map(e => e.code)).toEqual(["T303"]);
  });

  it("patches a piece whose id is also a run's name", () => {
    const d = doc(`<slate>\n  <run name="spot" cmd="true" />\n  <column><text id="spot">x</text></column>\n</slate>`);
    const p = parseSlatePatch(`<props id="spot" tone="muted" />`, d);
    expect(p.errors).toEqual([]);
    expect(applySlatePatch(d, slateStartValues(d), p.patch!).document!.pieces.spot!.props).toEqual({ value: "x", tone: "muted" });
  });

  it("merges props, removes one with null, and leaves the rest", () => {
    const r = apply(`<props id="week" tone="warning" note={null} />`);
    expect(r.errors).toEqual([]);
    expect(r.document!.pieces.week!.props).toEqual({ label: "Weekly", value: { bind: "usage.week.percent" }, tone: "warning" });
  });

  it("merges a <col> inside <props> into the column with its title, so a tone saved by patch reads back", () => {
    const table = doc(`<slate title="P">
  <value name="procs" start={[{ name: "node", cpu: 80, mem: 524 }]} />
  <column>
    <table id="ps" items={$procs}>
      <col title="Name" value={item.name} />
      <col title="CPU" value={item.cpu} />
    </table>
  </column>
</slate>`);
    const patch = (text: string) => {
      const p = parseSlatePatch(text, table);
      expect(p.errors).toEqual([]);
      const r = applySlatePatch(table, slateStartValues(table), p.patch!);
      expect(r.errors).toEqual([]);
      return r.document!;
    };
    const toned = patch(`<props id="ps"><col title="CPU" tone={item.cpu > 50 ? 'bad' : 'default'} /></props>`);
    expect(toned.pieces.ps!.props!.columns).toEqual([
      { title: "Name", value: { bind: "item.name" } },
      { title: "CPU", value: { bind: "item.cpu" }, tone: { bind: "item.cpu > 50 ? 'bad' : 'default'" } },
    ]);
    expect(printSlate(toned)).toContain(`<col title="CPU" value={item.cpu} tone={item.cpu > 50 ? 'bad' : 'default'} />`);
    const untoned = applySlatePatch(toned, slateStartValues(toned), parseSlatePatch(`<props id="ps"><col title="CPU" tone={null} /><col title="Mem" value={item.mem} mono /></props>`, toned).patch!).document!;
    expect(untoned.pieces.ps!.props!.columns).toEqual([
      { title: "Name", value: { bind: "item.name" } },
      { title: "CPU", value: { bind: "item.cpu" } },
      { title: "Mem", value: { bind: "item.mem" }, mono: true },
    ]);
    expect(parseSlatePatch(`<props id="ps"><text>x</text></props>`, table).errors.map(e => e.code)).toEqual(["P105"]);
    expect(parseSlatePatch(`<col title="CPU" tone="bad" />`, table).errors[0]!.message).toContain(`<props id="..."><col ... /></props>`);
  });

  it("adds, moves, removes and replaces pieces by id", () => {
    const added = apply(`<add under="root" at={1}><text id="new">New</text></add>`);
    expect(added.document!.pieces["column-1"]!.children).toEqual(["week", "new", "eta", "more"]);
    expect(apply(`<move id="eta" under="more" at={0} />`).document!.pieces.more!.children).toEqual(["eta", "inner"]);
    const removed = apply(`<remove id="more" />`).document!;
    expect(removed.pieces.more).toBeUndefined();
    expect(removed.pieces.inner).toBeUndefined();
    const replaced = apply(`<section id="more" title="Less"><text>y</text></section>`).document!;
    expect(replaced.pieces.inner).toBeUndefined();
    expect(replaced.pieces.more!.children).toEqual(["text-1"]);
  });

  it("adds declarations and keeps live values both documents declare", () => {
    const live = { ...values, steps: [{ title: "a", done: true }] };
    const p = parseSlatePatch(`<value name="note" start="" />\n<run name="check" cmd="true" />\n<when id="w" change={$note} do={start($check)} />`, base);
    const r = applySlatePatch(base, live, p.patch!);
    expect(r.errors).toEqual([]);
    expect(r.values).toEqual({ steps: [{ title: "a", done: true }], note: "", check: { state: "idle", runs: 0 } });
    expect(r.document!.reactions).toEqual([{ id: "w", on: { change: ["$note"] }, do: [{ do: "start", run: "check" }] }]);
  });

  it("refuses a reaction without an id, a result that fails validation, and holds undo for the host", () => {
    expect(parseSlatePatch(`<when change={$steps} do={set($steps, [])} />`, base).errors[0]!.code).toBe("P107");
    const bad = apply(`<props id="week" value={usage.weekley.percent} />`);
    expect(bad.document).toBeUndefined();
    expect(bad.errors[0]!.code).toBe("X401");
    expect(apply(`<remove name="steps" />\n<text id="eta">{len($steps)}</text>`).errors[0]!.code).toBe("S501");
    expect(apply(`<clear />`)).toMatchObject({ document: null });
    expect(apply(`<undo />`).errors[0]!.code).toBe("V752");
  });
});

describe("a refusal a small model can act on", () => {
  it("JSON sent as text or as a document says a slate is JSX-like text and shows one", () => {
    const asText = parseSlate(`{"title": "Gold", "pieces": []}`);
    expect(asText.errors[0]).toMatchObject({ code: "P100", message: "this is JSON, and a slate is JSX-like text that starts with <slate>; slate_catalog shows it", fix: `<slate title="Gold"><number label="Spot" value={$spot.json.usd} unit="USD" /></slate>` });
    const asDocument = validateSlate({ title: "Gold", sections: [] });
    expect(asDocument.errors[0]).toMatchObject({ code: "D200", message: "this JSON is not a slate: a slate is the JSX-like text slate_catalog shows, sent as text, never JSON of your own" });
    expect(validateSlate({ schema: 3 }).errors[0]).toMatchObject({ code: "D200", fix: "update wsp" });
    expect(validateSlate({ slate: "<slate><text>x</text></slate>" }).errors[0]).toMatchObject({ code: "D200", message: "this JSON wraps slate markup; send the markup itself as text, not inside document" });
  });

  it("an escaped quote in an attribute string shows the quoting that works", () => {
    const refused = parseSlate(`<slate><run name="p" cmd="python3 -c \\"print(1)\\"" /><text>x</text></slate>`);
    expect(refused.errors[0]).toMatchObject({ code: "P100", message: `attribute strings take no escapes (cmd at line 1): a backslash does not hide a " inside "..."`, fix: `cmd='echo "hi"', single quotes outside the double ones` });
    expect(parseSlate(`<slate><run name="p" cmd='python3 -c "print(1)"' /><text>x</text></slate>`).errors).toEqual([]);
  });
});

describe("the catalog's patch entry", () => {
  it("every element it shows applies to a slate, and rule 6 points at it", () => {
    let d = parseSlate(`<slate><column id="root"><column id="list"><text id="eta">x</text><text id="price">p</text></column><column id="other"><text id="o">o</text></column></column></slate>`).document!;
    const shown = slateCatalog("patch").split("\n").slice(1).filter(l => l.includes(": ")).map(l => l.slice(0, l.indexOf(": "))).filter(l => l.startsWith("<") && !l.includes("...") && !l.includes(", "));
    expect(shown.length).toBeGreaterThan(4);
    for (const p of [...shown, `<value name="hist" start={[]} />`, `<remove name="hist" />`]) {
      const parsed = parseSlatePatch(p, d);
      expect(parsed.errors, p).toEqual([]);
      const applied = applySlatePatch(d, slateStartValues(d), parsed.patch!, parsed.lines);
      expect(applied.errors, p).toEqual([]);
      d = applied.document!;
    }
    expect(slateCatalog()).toContain("runs, patch, functions");
  });
});
