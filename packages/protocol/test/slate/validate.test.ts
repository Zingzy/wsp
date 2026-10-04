import { describe, expect, it } from "vitest";
import { parseSlate, parseSlatePatch, slateCatalog, validateSlate, SLATE_CODES } from "../../src/slate/index.js";
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
    expect(slateCatalog()).toContain("Layout separates things, never \"·\"");
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
