// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { applySlatePatch, compileSlate, compileSlatePatch, printSlate, SLATE_PIECES, slateFlags, type Slate, type SlatePatchOp } from "../../src/index.js";
import { PR_LINES, PR_STORED, TRACKER_LINES, USAGE_LINES, USAGE_STORED } from "./examples.js";

const compiled = (lines: string): Slate => {
  const r = compileSlate(lines);
  expect(r.errors).toEqual([]);
  return r.document!;
};

describe("compiling lines", () => {
  it.each<[string, string, Slate["pieces"][string]]>([
    ["a literal, a binding and a format", 'm: meter label="Weekly" value={usage.week.percent} note=`resets ${until(usage.week.resetsAt)}`',
      { type: "meter", props: { label: "Weekly", value: { bind: "usage.week.percent" }, note: { format: "resets ${until(usage.week.resetsAt)}" } } }],
    ["numbers, booleans, null and words", "m: meter label=x value=46 max=100 tone=warning", { type: "meter", props: { label: "x", value: 46, max: 100, tone: "warning" } }],
    ["flags resolve to their prop", "t: text value=\"a\" strong muted small mono", { type: "text", props: { value: "a", emphasis: "strong", tone: "muted", size: "small", mono: true } }],
    ["no- sets a boolean false", "r: row no-wrap between", { type: "row", props: { wrap: false, align: "between" } }],
    ["when, announce and a binding key", "t: text value={git.branch} announce when={git.branch != null}", { type: "text", props: { value: { bind: "git.branch" } }, announce: true, when: "git.branch != null" }],
    ["a continuation line", "m: meter label=\"Weekly\"\n  value={usage.week.percent} good", { type: "meter", props: { label: "Weekly", value: { bind: "usage.week.percent" }, tone: "good" } }],
    ["block lines", "md: markdown\n  | one {x} ${y}\n  |\n  | three", { type: "markdown", props: { value: "one {x} ${y}\n\nthree" } }],
    ["an action line", "b: button label=Go\n  @press send text=\"Go on.\" with=[state.steps[2].done, git.branch]",
      { type: "button", props: { label: "Go" }, on: { press: { do: "send", text: "Go on.", with: ["state.steps[2].done", "git.branch"] } } }],
    ["two actions on one event become a list", "b: button label=Go\n  @press set path=state.a value=1\n  @press toggle path=state.b",
      { type: "button", props: { label: "Go" }, on: { press: [{ do: "set", path: "state.a", value: 1 }, { do: "toggle", path: "state.b" }] } }],
    ["a fallback, quoted and bare", "t: text value=x fallback=\"An older wsp\"", { type: "text", props: { value: "x" }, fallback: { text: "An older wsp" } }],
  ])("%s", (_name, line, piece) => {
    const { document, errors } = compileSlate(`state.a = 0\nstate.b = false\nstate.steps = []\n${line}`);
    expect(errors.filter(e => e.code !== "T301")).toEqual([]);
    const id = line.slice(0, line.indexOf(":"));
    expect(document?.pieces[id]).toEqual(piece);
  });

  it("mints ids by type in document order, skipping written ones", () => {
    const doc = compiled("root: column\n  text value=a\n  text-1: text value=b\n  text value=c\n  meter label=x value=1");
    expect(doc.pieces.root!.children).toEqual(["text-2", "text-1", "text-3", "meter-1"]);
  });

  it("reads the header and state lines", () => {
    const doc = compiled('slate 1 "T"\n\nstate.steps = [{"title": "a", "done": true}]\nstate.n.deep = 3\nroot: text value={state.n.deep}');
    expect(doc).toMatchObject({ schema: 1, title: "T", state: { steps: [{ title: "a", done: true }], n: { deep: 3 } }, root: "root" });
  });

  it("compiles appendix G to exactly its stored form", () => {
    expect(compiled(USAGE_LINES)).toEqual(USAGE_STORED);
  });

  it("compiles the cut pull request slate to its stored form", () => {
    expect(compiled(PR_LINES)).toEqual(PR_STORED);
  });
});

describe("the common mistakes name their code", () => {
  it.each<[string, string, string, string?]>([
    ["value=usage.week.percent on a meter", 'week: meter label="Weekly" value=usage.week.percent', "T303", "value takes a number; \"usage.week.percent\" is text. To bind it, write value={usage.week.percent}."],
    ["a misspelt path as text, folded into the fix", 'week: meter label="Weekly" value=usage.weekley.percent', "T303", "value takes a number; \"usage.weekley.percent\" is text. To bind it, write value={usage.week.percent}."],
    ["a ${} in a quoted literal", 'week: meter label="Weekly" value=1 note="resets ${until(x)}"', "W001", "note is a literal containing ${...}. For a format string use backticks."],
    ["when as a string", 't: text value=a when="pr.number != null"', "T303", "when takes an expression in braces: when={pr.number != null}"],
    ["a tab", "root: column\n\tt: text value=a", "P101", "indent with spaces, not tabs"],
    ["- column under a table", "t: table items={pr.checks}\n  - column title=x", "T314", "table takes - col or - action items, not column"],
    ["two top-level pieces", "head: text value=a\nlimits: column", "D202", "2 top-level pieces (head, limits). Wrap them in a column."],
    ["@click", 'b: button label=Go\n  @click send text="x"', "A602", "@click is not an event; events are press, submit and change"],
    ["bold on a text", "t: text value=a bold", "P102", "bold is not a flag of text. Slate takes meaning, not style: use strong."],
    ["normal bare", "t: text value=a normal", "P102", "normal is the default; leave it out or write prop=normal"],
    ["a flags-only line under a piece", "root: column\n  muted", "T300", "muted is not a piece type; a line that only adds flags starts with a prop, like tone=muted"],
    ["colour", 'week: meter label="Weekly" value=1 colour=red', "T312"],
    ["an odd indent", "root: column\n   t: text value=a", "P101"],
    ["a jump of two steps", "root: column\n    t: text value=a", "P101"],
    ["a duplicate id", "root: column\n  a: text value=x\n  a: text value=y", "P104", "a is also on line 2"],
    ["a bad id", "root: column\n  Big: text value=x", "P100"],
    ["bad JSON in a state line", "state.a = {nope}\nroot: text value=x", "P106"],
    ["an unknown piece", "root: gauge label=x", "T300"],
  ])("%s", (_name, lines, code, message) => {
    const r = compileSlate(lines);
    const all = [...r.errors, ...r.warnings];
    const hit = all.find(p => p.code === code);
    expect(hit, JSON.stringify(all)).toBeDefined();
    if (message !== undefined) expect(hit!.message).toBe(message);
    if (code !== "W001") expect(r.document).toBeUndefined();
  });

  it("gives a line and a column on compile errors", () => {
    const { errors } = compileSlate("root: column\n  t: text value=a bold");
    expect(errors[0]).toMatchObject({ code: "P102", line: 2, column: 19, fix: "strong" });
  });

  it("gives the line of the piece on validator errors", () => {
    const { errors } = compileSlate("root: column\n  a: text value=x\n  b: meter label=x value={usage.weekley.percent}");
    expect(errors[0]).toMatchObject({ code: "X401", line: 3, piece: "b", prop: "value", fix: "usage.week.percent" });
  });
});

describe("flags", () => {
  it("every flag word of every type sets exactly one prop, except default and normal", () => {
    for (const piece of Object.values(SLATE_PIECES)) {
      const ambiguous = [...slateFlags(piece.props)].filter(([, hit]) => hit === "ambiguous").map(([w]) => w);
      expect(ambiguous.filter(w => w !== "default" && w !== "normal"), piece.type).toEqual([]);
      for (const spec of Object.values(piece.items)) {
        const inner = [...slateFlags(spec.fields)].filter(([, hit]) => hit === "ambiguous").map(([w]) => w);
        expect(inner.filter(w => w !== "default" && w !== "normal"), piece.type).toEqual([]);
      }
    }
  });
});

describe("printing back", () => {
  it.each([["G", USAGE_LINES], ["the pull request", PR_LINES], ["a tracker", TRACKER_LINES]])("%s survives compile(print(d))", (_name, lines) => {
    const d = compiled(lines);
    const printed = printSlate(d);
    expect(compiled(printed)).toEqual(d);
    expect(printSlate(compiled(printed))).toBe(printed);
  });

  it("prints canonically: flags first, ids written, lines under 120", () => {
    const printed = printSlate(compiled(PR_LINES));
    expect(printed.split("\n").every(l => l.length <= 120)).toBe(true);
    expect(printed).toContain("  head: facts when={pr.number != null}\n    - fact label=\"State\" value={pr.word}");
    expect(printed).toContain('  fix: button primary label="Fix the failing checks"');
    expect(printed).toContain("    - col mono end title=\"Took\"");
  });

  it("round-trips generated slates", () => {
    const words = ["muted", "strong", "good", "mono", "small"];
    for (let seed = 1; seed <= 40; seed++) {
      let n = seed;
      const rand = (k: number): number => { n = (n * 1103515245 + 12345) % 2147483648; return n % k; };
      const lines = ["root: column"];
      for (let i = 0; i < 1 + rand(8); i++) {
        const kind = rand(4);
        if (kind === 0) lines.push(`  t${i}: text value="line ${i}" ${words[rand(words.length)]}`);
        if (kind === 1) lines.push(`  m${i}: meter label="M ${i}" value={usage.week.percent} max=${10 + rand(90)}`);
        if (kind === 2) lines.push(`  s${i}: section title="S ${i}" collapsible`, `    n${i}: number label="N" value={thread.cost.usd} usd`);
        if (kind === 3) lines.push(`  b${i}: button label="B ${i}" quiet`, `    @press send text="Pressed ${i}." with=[git.branch]`);
      }
      const d = compiled(lines.join("\n"));
      expect(compiled(printSlate(d))).toEqual(d);
    }
  });
});

describe("patches", () => {
  const base = (): Slate => compiled(TRACKER_LINES);
  const patch = (lines: string, doc = base()) => {
    const c = compileSlatePatch(lines, doc);
    expect(c.errors).toEqual([]);
    return { ops: c.ops!, applied: applySlatePatch(doc, { done: 2, note: "", total: 4 }, c.ops!) };
  };

  it("compiles each op", () => {
    expect(compileSlatePatch("~ progress tone=warning", base()).ops).toEqual([{ op: "props", id: "progress", props: { tone: "warning" } }]);
    expect(compileSlatePatch('+ eta: text value="Soon" under=root at=1', base()).ops).toEqual([{ op: "add", id: "eta", piece: { type: "text", props: { value: "Soon" } }, under: "root", at: 1 }]);
    expect(compileSlatePatch("> files under=root at=0", base()).ops).toEqual([{ op: "move", id: "files", under: "root", at: 0 }]);
    expect(compileSlatePatch("- intro", base()).ops).toEqual([{ op: "remove", id: "intro" }]);
    expect(compileSlatePatch("state.steps[2].done = true", base()).ops).toEqual([{ op: "state", path: "state.steps[2].done", value: true }]);
    expect(compileSlatePatch('~ intro: text value="Hi"', base()).ops).toEqual([{ op: "replace", id: "intro", piece: { type: "text", props: { value: "Hi" } } }]);
    expect(compileSlatePatch("~ progress when=null tone=null", base()).ops).toEqual([{ op: "props", id: "progress", props: { tone: null }, when: null }]);
  });

  it("adds a subtree in one op", () => {
    const { ops, applied } = patch('+ more: section title="More" under=root at=1\n  why: text value="Because." muted\n  go: button label=Go\n    @press send text="Go."');
    expect(ops[0]).toEqual({
      op: "add", id: "more", under: "root", at: 1,
      piece: { type: "section", props: { title: "More" }, children: ["why", "go"] },
      children: { why: { type: "text", props: { value: "Because.", tone: "muted" } }, go: { type: "button", props: { label: "Go" }, on: { press: { do: "send", text: "Go." } } } },
    });
    expect(applied.errors).toEqual([]);
    expect(applied.document!.pieces.root!.children).toEqual(["progress", "more", "changes", "note", "next", "intro"]);
  });

  it("merges props and replaces the named event, as appendix C's last op", () => {
    const { ops, applied } = patch('~ next label="Done, thanks" primary\n  @press send text="Thanks. Clear the slate."');
    expect(ops).toEqual([{ op: "props", id: "next", props: { label: "Done, thanks", variant: "primary" }, on: { press: { do: "send", text: "Thanks. Clear the slate." } } }]);
    expect(applied.document!.pieces.next).toMatchObject({ props: { label: "Done, thanks", variant: "primary" }, on: { press: { do: "send", text: "Thanks. Clear the slate." } } });
  });

  it("appends an item line to the current list", () => {
    const { applied } = patch('~ files\n  - col title="Kind" value={item.kind}');
    expect((applied.document!.pieces.files!.props!.columns as unknown[]).length).toBe(4);
  });

  it("sets state and moves and removes", () => {
    const { applied } = patch("state.done = 3\n> files under=root at=0\n- changes");
    expect(applied.errors).toEqual([]);
    expect(applied.state).toEqual({ done: 3, note: "", total: 4 });
    expect(applied.document!.pieces.root!.children).toEqual(["files", "progress", "note", "next", "intro"]);
    expect(applied.document!.pieces.changes).toBeUndefined();
  });

  it("is all or nothing, and names the op", () => {
    const doc = base();
    const ops: SlatePatchOp[] = [{ op: "props", id: "progress", props: { tone: "warning" } }, { op: "props", id: "progress", props: { colour: "red" } }];
    const r = applySlatePatch(doc, {}, ops);
    expect(r.document).toBeUndefined();
    expect(r.errors[0]).toMatchObject({ code: "T312", piece: "progress", op: 1 });
    expect(doc.pieces.progress!.props!.tone).toBeUndefined();
    expect(applySlatePatch(doc, {}, [{ op: "remove", id: "nope" }]).errors[0]).toMatchObject({ code: "D203", op: 0 });
    expect(applySlatePatch(doc, {}, [{ op: "move", id: "changes", under: "files" }]).errors[0]).toMatchObject({ code: "D205" });
  });

  it("refuses a top-level line that is not an op", () => {
    expect(compileSlatePatch("eta: text value=x", base()).errors[0]!.code).toBe("P105");
  });
});

describe("fuzz", () => {
  it("random lines never throw; they give a document or problems", () => {
    const bits = ["root: column", "  t: text value=", "{", "}", "`${", "\"", "  - col", "  @press send", "| x", "state.a = ", "[1, 2", "tone=bad", "  ", "\t", "~ t", "+ x: text", "> t under=root", "- t", "when={a <", "strong"];
    let n = 7;
    const rand = (k: number): number => { n = (n * 1103515245 + 12345) % 2147483648; return n % k; };
    for (let i = 0; i < 2_000; i++) {
      const lines = Array.from({ length: 1 + rand(6) }, () => Array.from({ length: 1 + rand(4) }, () => bits[rand(bits.length)]).join(rand(2) === 0 ? " " : "")).join("\n");
      expect(() => {
        const r = compileSlate(lines);
        expect(r.document !== undefined || r.errors.length > 0).toBe(true);
        compileSlatePatch(lines, USAGE_STORED);
      }, lines).not.toThrow();
    }
  });
});
