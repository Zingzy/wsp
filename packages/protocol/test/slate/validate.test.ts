import { describe, expect, it } from "vitest";
import { parseSlate, parseSlatePatch, printSlate, slateCatalog, validateSlate, SLATE_CODES, SLATE_ICONS, SLATE_RUN_FIELDS } from "../../src/slate/index.js";
import { SPEC_EXAMPLES } from "./examples.js";

const wrap = (pieces: string, decls = ""): string => `<slate title="T">\n${decls}\n  <column>\n    ${pieces}\n  </column>\n</slate>`;
const all = (text: string): string[] => { const r = parseSlate(text); return [...r.errors, ...r.warnings].map(p => p.code); };

/** One write per code in scope, each raising that code. */
const FIXTURES: [string, string][] = [
  ["P100", `<slate><column><text>a</column></slate>`],
  ["P102", wrap(`<text muted>Hi</text>`)],
  ["P103", wrap(`<text id="Bad Id">x</text>`)],
  ["P104", wrap(`<text id="a">x</text><text id="a">y</text>`)],
  ["D202", `<slate><text>a</text><text>b</text></slate>`],
  ["D206", `<slate>${"<column>".repeat(11)}<text>x</text>${"</column>".repeat(11)}</slate>`],
  ["D207", wrap(Array.from({ length: 101 }, () => "<text>x</text>").join(""))],
  ["T300", wrap(`<metre label="x" value={1} />`)],
  ["T302", wrap(`<meter label="x" value={1} maxx={3} />`)],
  ["T303", wrap(`<meter label="x" value="usage.week.percent" />`)],
  ["T304", wrap(`<meter label="x" />`)],
  ["T305", wrap(`<text size={pr.word}>x</text>`)],
  ["T306", wrap(`<text tone="loud">x</text>`)],
  ["T307", wrap(`<toggle value={$on} />`, `  <value name="on" start={false} />`)],
  ["T308", wrap(`<meter label="x" value={1}><text>y</text></meter>`)],
  ["T309", wrap(`<empty title="x"><button label="a" onPress={copy('a')} /><button label="b" onPress={copy('b')} /></empty>`)],
  ["T311", wrap(`<button label="a" variant="primary" onPress={copy('a')} /><button label="b" variant="primary" onPress={copy('b')} />`)],
  ["T312", wrap(`<text color="red">x</text>`)],
  ["T314", wrap(`<facts><col title="x" value={1} /></facts>`)],
  ["X400", wrap(`<text>{1 +}</text>`)],
  ["X401", wrap(`<text>{pr.titel}</text>`)],
  ["X404", wrap(`<text>{lenn(pr.checks)}</text>`)],
  ["X405", wrap(`<text>{short(pr.word)}</text>`)],
  ["X406", wrap(`<text>{tokens(pr.word)}</text>`)],
  ["X407", wrap(`<text>{${"1 + ".repeat(130)}1}</text>`)],
  ["X408", wrap(`<text>{pr.checks == 'fail' ? 'a' : 'b'}</text>`)],
  ["X409", wrap(`<text>{item.name}</text>`)],
  ["X410", wrap(`<input label="x" value={pr.word} />`)],
  ["X420", wrap(`<text>{pr.checks.length}</text>`)],
  ["Q420", wrap(`<text>{pr.checks | 3}</text>`)],
  ["Q422", wrap(`<text>{pr.checks | filter(item.done)}</text>`)],
  ["Q423", wrap(`<text>{pr.checks | where()}</text>`)],
  ["Q424", wrap(`<text>{pr.number | count}</text>`)],
  ["Q425", wrap(`<text>{pr.checks | take(pr.number) | count}</text>`)],
  ["Q426", wrap(`<text>{pr.checks${" | skip(0)".repeat(13)} | count}</text>`)],
  ["S500", wrap(`<text>x</text>`, `  <value name="big" start="${"x".repeat(262_200)}" />`)],
  ["S501", wrap(`<text>{$nope}</text>`)],
  ["S502", wrap(`<checklist items={pr.checks} title={item.name} done={item.state == 'pass'} editable />`)],
  ["S503", wrap(`<text>x</text>`, `  <value name="v" start={pr.word} />`)],
  ["S510", wrap(`<text>x</text>`, `  <derived name="a" value={$b} />\n  <derived name="b" value={$a} />`)],
  ["S512", wrap(`<text>x</text>`, Array.from({ length: 33 }, (_, i) => `  <derived name="d${i}" value={1} />`).join("\n"))],
  ["S513", wrap(`<text>x</text>`, Array.from({ length: 65 }, (_, i) => `  <value name="v${i}" start={1} />`).join("\n"))],
  ["S520", wrap(`<text>{$token}</text>`, `  <secret name="token" />`)],
  ["A600", wrap(`<button label="x" onPress={go($x)} />`)],
  ["A601", wrap(`<button label="x" onPress={set(x, 1)} />`)],
  ["A602", wrap(`<button label="x" onClick={copy('a')} />`)],
  ["A603", wrap(`<button label="x" onPress={send(pr.word)} />`)],
  ["A606", wrap(`<button label="x" onPress={[copy('1'), copy('2'), copy('3'), copy('4'), copy('5'), copy('6'), copy('7')]} />`)],
  ["A607", wrap(`<button label="x" onPress={set($ok, true)} />`, `  <derived name="ok" value={1 == 1} />`)],
  ["A608", wrap(`<text>x</text>`, `  <value name="a" start={1} />\n  <when change={$a} do={open('https://x.example')} />`)],
  ["A610", wrap(`<text>x</text>`, `  <value name="a" start={1} />\n  <value name="b" start={1} />\n  <when change={$a} do={set($b, $a)} />\n  <when change={$b} do={set($a, $b)} />`)],
  ["A611", wrap(`<text>x</text>`, `  <value name="a" start={1} />\n  <when do={set($a, 1)} />`)],
  ["K700", wrap(`<text>x</text>`, "  <value name=\"u\" start=\"\" />\n  <run name=\"r\" cmd={`gh api ${$u}`} />")],
  ["K701", wrap(`<text>x</text>`, `  <run name="r" cmd="true" tool="a.b" />`)],
  ["K702", wrap(`<button label="x" onPress={start($nope)} />`)],
  ["K703", wrap(`<text>x</text>`, `  <run name="r" cmd="true" every={5} />`)],
  ["K704", wrap(`<text>x</text>`, `  <run name="r" cmd="true" timeout={900} />`)],
  ["K705", wrap(`<text>x</text>`, `  <run name="r" tool="nodot" />`)],
  ["K707", wrap(`<text>x</text>`, Array.from({ length: 17 }, (_, i) => `  <run name="r${i}" cmd="true" />`).join("\n"))],
  ["W001", wrap(`<text>pr.checks</text>`)],
  ["W003", wrap(`<bars label="x" items={machine.history.cpu} name={item.x} value={item.y} />`)],
  ["W004", wrap(`<text>a \u2014 b</text>`)],
  ["W011", wrap(`<text>x</text>`, `  <secret name="t" />\n  <run name="r" cmd='vercel ls --token "$T"' env={{ T: $t }} />`)],
  ["W012", wrap(`<text>Market closed \u00b7 Weekend close</text>`)],
  ["W013", wrap(`<chart label="Requests" items={$hits} x={index} value={item.n} />`, `  <value name="hits" start={[{ n: 1 }, { n: 2 }]} />`)],
  ["W014", wrap(`<text mono>Kill the node process now</text>`)],
];

describe("the validator", () => {
  it.each(FIXTURES)("raises %s", (code, text) => {
    expect(all(text)).toContain(code);
  });

  it("holds every code it raises to the closed table", () => {
    for (const [code] of FIXTURES) expect(code in SLATE_CODES).toBe(true);
  });

  it("gives no error and no warning beyond T311 for every spec example", () => {
    for (const e of SPEC_EXAMPLES) {
      const r = parseSlate(e.text);
      expect(r.errors, e.name).toEqual([]);
      expect(r.warnings.filter(w => w.code !== "T311"), e.name).toEqual([]);
    }
  });

  it("warns W011 on the uncorrected setup example and not on the corrected one (correction 1)", () => {
    const c = SPEC_EXAMPLES.find(e => e.text.includes("Deploy setup") && e.text.includes("vercelToken"))!.text;
    expect(parseSlate(c).warnings.map(w => w.code)).not.toContain("W011");
    const old = c
      .replace(`cmd='vercel project inspect "$PROJECT" 2>&1 | head -c 4000'`, `cmd='vercel project inspect "$PROJECT" --token "$VERCEL_TOKEN" 2>&1 | head -c 4000'`)
      .replace(`cmd='gh secret set VERCEL_TOKEN --repo "$REPO"' stdin={$vercelToken}\n    env={{ REPO: $repo }}`, `cmd='gh secret set VERCEL_TOKEN --repo "$REPO" --body "$VERCEL_TOKEN"'\n    env={{ REPO: $repo, VERCEL_TOKEN: $vercelToken }}`);
    const w = parseSlate(old).warnings.filter(x => x.code === "W011");
    expect(w.map(x => [x.piece, x.prop, x.message.split(",")[0]])).toEqual([
      ["$check", "cmd", "VERCEL_TOKEN carries the secret $vercelToken"],
      ["$ci", "cmd", "VERCEL_TOKEN carries the secret $vercelToken"],
    ]);
    expect(all(wrap(`<text>x</text>`, `  <secret name="t" />\n  <run name="r" cmd="gh x --body=$T" env={{ T: $t }} />`))).toContain("W011");
    expect(all(wrap(`<text>x</text>`, `  <secret name="t" />\n  <run name="r" cmd="vercel ls -p $T" env={{ T: $t }} />`))).toContain("W011");
    expect(all(wrap(`<text>x</text>`, `  <secret name="t" />\n  <run name="r" cmd='printf "%s" "$T" > f' env={{ T: $t }} />`))).not.toContain("W011");
  });

  it("warns W012 on words joined by a middle dot, a bullet or a bar, in a literal, a format or a formula", () => {
    const decls = `  <value name="a" start="x" />\n  <value name="xs" start={["a", "b"]} />`;
    const joined = [
      `<text>Market closed \u00b7 Weekend close</text>`,
      `<facts><fact label="Purity" value="24K \u00b7 99.9% pure" /></facts>`,
      `<text>Open \u2022 Closed</text>`,
      `<text>Spot | Ask</text>`,
      "<text>{`${$a} \u00b7 ${$a}`}</text>",
      `<text>Closed \u00b7 {$a}</text>`,
      `<text>{join($xs, " \u00b7 ")}</text>`,
      `<text>{join($xs, " | ")}</text>`,
    ];
    for (const piece of joined) {
      const w = parseSlate(wrap(piece, decls)).warnings.filter(x => x.code === "W012");
      expect(w, piece).toHaveLength(1);
      expect(w[0]!.message, piece).toContain("give each its own piece, or join with a comma");
    }
    const clean = [
      `<text>Market closed, weekend close</text>`,
      `<text>{$xs | take(1) | join(", ")}</text>`,
      `<markdown>| a | b |\n| - | - |\n| 1 | 2 |</markdown>`,
      `<text>\u2022 first</text>`,
    ];
    for (const piece of clean) expect(all(wrap(piece, decls)), piece).not.toContain("W012");
    expect(slateCatalog()).toContain("Separate things by layout, never by ·, • or |.");
  });

  it("warns W013 on a chart whose x is the row's index, and names a time in its fix", () => {
    const decls = `  <value name="hits" start={[{ n: 1, at: 1 }]} />`;
    for (const x of [`x={index}`, ``]) {
      const w = parseSlate(wrap(`<chart label="Requests" items={$hits} ${x} value={item.n} />`, decls)).warnings.filter(p => p.code === "W013");
      expect(w.map(p => [p.prop, p.fix]), x).toEqual([["x", "x={item.at}"]]);
      expect(w[0]!.message).toContain("give each row its time, for example x={item.at}");
    }
    expect(all(wrap(`<chart label="Requests" items={$hits} x={item.at} value={item.n} />`, decls))).not.toContain("W013");
    expect(slateCatalog("chart")).toContain("x: any, per row; a time on x (ISO or ms) labels the axis by clock, in this computer's time zone; a number by its value");
  });

  it("refuses always without every as K703 and takes it with every (correction 2)", () => {
    expect(all(wrap(`<text>x</text>`, `  <run name="r" cmd="true" always />`))).toContain("K703");
    const ok = parseSlate(wrap(`<text>x</text>`, `  <run name="r" cmd="true" every={60} always />`));
    expect(ok.errors).toEqual([]);
    expect(ok.document!.runs.r).toEqual({ kind: "cmd", cmd: "true", every: 60, always: true });
  });

  it("names a reaction cycle in the spec's words", () => {
    const r = parseSlate(FIXTURES.find(f => f[0] === "A610")![1]);
    expect(r.errors[0]!.message).toBe("reactions and derived values form a cycle: when change of $a sets $b; when change of $b sets $a");
  });

  it("validates the stored JSON form the same way", () => {
    const doc = parseSlate(SPEC_EXAMPLES[0]!.text).document!;
    expect(validateSlate(JSON.parse(JSON.stringify(doc))).errors).toEqual([]);
    expect(validateSlate({ ...doc, schema: 1 }).errors[0]!.code).toBe("D200");
    const broken = JSON.parse(JSON.stringify(doc));
    broken.pieces[doc.root].children.push("ghost");
    expect(validateSlate(broken).errors.map(e => e.code)).toEqual(["D203"]);
    broken.pieces[doc.root].children.pop();
    broken.pieces[doc.root].children.push(doc.root);
    expect(validateSlate(broken).errors.map(e => e.code)).toContain("D205");
  });

  it("raises P105, P107 and D203 in patches", () => {
    const base = parseSlate(wrap(`<text id="a">x</text>`)).document!;
    expect(parseSlatePatch(`<slate><text>x</text></slate>`, base).errors[0]!.code).toBe("P105");
    expect(parseSlatePatch(`<text>no id</text>`, base).errors[0]!.code).toBe("P105");
    expect(parseSlatePatch(`<when change={pr.number} do={copy('x')} />`, base).errors.map(e => e.code)).toContain("P107");
    expect(parseSlatePatch(`<text id="ghost">x</text>`, base).errors[0]!.code).toBe("D203");
  });
});

// Each write the owner's sessions had refused, now taken.
describe("writes the sessions were refused", () => {
  const clean = (text: string): void => { const r = parseSlate(text); expect(r.errors, text).toEqual([]); };

  it("takes a confirm formula, checks it like any prop, and prints it back", () => {
    const decls = "  <value name=\"pid\" start={19271} />\n  <value name=\"name\" start=\"node\" />\n  <run name=\"kill\" cmd='kill \"$PID\"' env={{ PID: $pid }} confirm={`Kill ${$name} (PID ${$pid})?`} />";
    const r = parseSlate(wrap(`<button label="Kill" onPress={start($kill)} />`, decls));
    expect(r.errors).toEqual([]);
    expect(r.document!.runs.kill).toMatchObject({ confirm: { format: "Kill ${$name} (PID ${$pid})?" } });
    expect(parseSlate(printSlate(r.document!)).document!.runs.kill).toEqual(r.document!.runs.kill);
    clean(wrap(`<text>x</text>`, `  <value name="ok" start={true} />\n  <run name="r" cmd="true" confirm={$ok ? 'Again?' : 'Run it?'} />`));
    clean(wrap(`<text>x</text>`, `  <run name="r" cmd="true" confirm="Run it?" />`));
    expect(all(wrap(`<text>x</text>`, `  <run name="r" cmd="true" confirm={$nope} />`))).toContain("S501");
    expect(all(wrap(`<text>x</text>`, `  <secret name="t" />\n  <run name="r" cmd="true" confirm={$t} />`))).toContain("S520");
  });

  it("takes when on a fact, a column, an option and a row action; a column's reads the piece's scope, an action's the row", () => {
    const decls = `  <value name="all" start={false} />\n  <value name="pick" start={null} />\n  <value name="rows" start={[{ name: "a", pid: 1 }]} />`;
    clean(wrap(`<facts><fact label="PID" value="1" when={$all} /></facts>`, decls));
    clean(wrap(`<table items={$rows}><col title="Name" value={item.name} /><col title="PID" value={item.pid} when={$all} /><action label="Kill" when={item.pid > 0} onPress={send("Kill it.", item.pid)} /></table>`, decls));
    clean(wrap(`<select label="Pick" value={$pick}><option value="a" /><option value="b" when={$all} /></select>`, decls));
    clean(wrap(`<choices label="Pick" value={$pick}><option value="a" /><option value="b" when={$all} /></choices>`, decls));
    expect(all(wrap(`<table items={$rows}><col title="PID" value={item.pid} when={item.pid > 0} /></table>`, decls))).toContain("X409");
  });

  it("takes a literal as a section's first state, and still a two-way value", () => {
    clean(wrap(`<section title="More" collapsible open={false}><text>x</text></section>`));
    clean(wrap(`<section title="More" collapsible open={$open}><text>x</text></section>`, `  <value name="open" start={true} />`));
    expect(all(wrap(`<section title="More" open="no"><text>x</text></section>`))).toContain("X410");
    expect(all(wrap(`<toggle label="On" value={true} />`))).toContain("X410");
  });

  it("knows about 200 icons, the sessions' among them, and takes a formula over them", () => {
    expect(SLATE_ICONS.length).toBeGreaterThanOrEqual(190);
    for (const n of ["mail", "gem", "inbox", "trending-up", "trending-down", "thermometer", "cloud-rain", "sun", "dollar-sign", "indian-rupee"]) expect(SLATE_ICONS, n).toContain(n);
    clean(wrap(`<heading icon="gem">Gold</heading><number label="Change" value={$d} icon={$d >= 0 ? 'trending-up' : 'trending-down'} />`, `  <value name="d" start={1} />`));
    clean(wrap(`<facts><fact label="Mail" value="3" icon={'inbox'} /></facts>`));
    expect(all(wrap(`<heading icon="gold-bar">Gold</heading>`))).toContain("W016");
  });

  it("takes camelCase piece ids, and a piece id may be a run's name", () => {
    const r = parseSlate(wrap(`<number id="goldPrice" label="Gold" value={$spot.json.v} /><text id="spot">x</text><text id="spot_at">y</text>`, `  <run name="spot" cmd="echo '{}'" />`));
    expect(r.errors).toEqual([]);
    expect(Object.keys(r.document!.pieces)).toEqual(expect.arrayContaining(["goldPrice", "spot", "spot_at"]));
    expect(all(wrap(`<text id="9lives">x</text>`))).toContain("P103");
    expect(all(wrap(`<text id="a">x</text><text id="a">y</text>`))).toContain("P104");
  });

  it("warns W014 on mono over a sentence, with drop mono as the fix, and never on a figure, an id, a time or a path", () => {
    const decls = `  <value name="pid" start={1} />\n  <value name="rows" start={[{ n: "a" }]} />`;
    const warned = [
      `<text mono>Kill the node process now</text>`,
      `<text mono>{$pid} processes are running here</text>`,
      `<facts><fact label="Note" value="the market is closed today" mono /></facts>`,
      "<table items={$rows}><col title=\"Why\" value={`waiting on the ${item.n} lock`} mono /></table>",
    ];
    for (const piece of warned) {
      const w = parseSlate(wrap(piece, decls)).warnings.filter(x => x.code === "W014");
      expect(w, piece).toHaveLength(1);
      expect(w[0]!.fix, piece).toBe("drop mono");
    }
    for (const piece of [`<text mono>{$pid}</text>`, `<text mono>2026-10-04 17:23 UTC</text>`, `<text mono>src/slate/kit.ts</text>`, `<text mono>PID 19271</text>`, `<facts><fact label="Head" value="b5ebeeff4" mono /></facts>`]) {
      expect(all(wrap(piece, decls)), piece).not.toContain("W014");
    }
  });
});

describe("every field a run reads", () => {
  it("type-checks each of SLATE_RUN_FIELDS, refreshing and text among them, instead of throwing", () => {
    for (const field of SLATE_RUN_FIELDS) {
      const r = parseSlate(`<slate><run name="p" cmd="echo 1" /><text value={if($p.${field}, "a", "b")} /></slate>`);
      expect(r.errors, field).toEqual([]);
    }
  });
});

describe("a per-row prop and a number given text", () => {
  it("say the formula over item, or a number in braces, never a bare path", () => {
    const chart = parseSlate(`<slate><value name="h" start={[]} /><chart label="x" items={$h} x="t" value="v" /></slate>`);
    expect(chart.errors).toMatchObject([{ code: "T303", prop: "x", fix: "x={item.t}" }, { code: "T303", prop: "value", fix: "value={item.v}" }]);
    expect(parseSlate(`<slate><value name="h" start={[]} /><bars label="x" items={$h} name="n" value={item.v} /></slate>`).errors).toMatchObject([{ code: "T303", fix: "name={item.n}" }]);
    expect(parseSlate(`<slate><value name="n" start={1} /><meter label="x" value={1} max="n" /></slate>`).errors).toMatchObject([{ code: "T303", fix: "max={$n}" }]);
    expect(parseSlate(`<slate><meter label="x" value={1} max="5" /></slate>`).errors).toMatchObject([{ code: "T303", fix: "max={5}" }]);
  });
});

describe("an HTML habit gets the piece it meant", () => {
  it("names the piece for <p>, <header> and <div>, points a piece's every at a <run>, and says what a form is for", () => {
    const codes = (t: string) => parseSlate(t).errors.map(e => `${e.code} ${e.message}`);
    expect(codes(`<slate><column><p>Waiting</p></column></slate>`)).toEqual([`T300 "p" is not a piece; words go in <text>...</text>`]);
    expect(codes(`<slate><column><header><text>PR</text></header></column></slate>`)).toEqual([`T300 "header" is not a piece; a title is a <heading>, or a <section title="...">`]);
    expect(codes(`<slate><column><div><text>x</text></div></column></slate>`)).toEqual([`T300 "div" is not a piece; a group is a <column>, a <row> or a <section>`]);
    expect(codes(`<slate><column><text every={60}>x</text></column></slate>`)).toContain(`T302 every is a <run>'s, not a piece's: <run name="x" cmd='...' every={60} />, and the piece reads $x`);
    expect(codes(`<slate><value name="r" start={null} /><form into="$r" /></slate>`)).toContain(`T304 form fills an MCP tool's arguments and needs tool="server.tool"; for fields of your own, use <input label="..." value={$x} /> and a <button>`);
  });
});

describe("what the render judge found agents writing", () => {
  it("warns of Title Case heads, emoji and a formula written as quoted text, and the write goes through", () => {
    const r = parseSlate(`<slate title="Live Gold Prices"><value name="x" start={1} /><column><section title="Bengaluru Retail Prices"><text>📈 Up</text></section><text value="$x.out" /><text value="{$x}" /><heading>Open PRs</heading></column></slate>`);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map(w => [w.code, w.fix])).toEqual([
      ["W018", `title="Live gold prices"`],
      ["W018", `title="Bengaluru retail prices"`],
      ["W017", undefined],
      ["W001", "value={$x.out}"],
      ["W001", "value={$x}"],
    ]);
  });
});
