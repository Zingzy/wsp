import { describe, expect, it } from "vitest";
import { applySlatePatch, parseSlate, parseSlatePatch, printSlate, sketchSlate, slateCatalog, slateStartValues, validateSlate, SLATE_RULES, type SlateDoc } from "../../src/slate/index.js";

const TRAFFIC = `<slate title="Traffic">
  <run name="traffic" cmd='python3 "$SLATE_DIR/traffic.py"' every={60} />
  <column>
    <number id="hits" label="Hits today" value={$traffic.json.hits} unit="hits" />
    <file path="README.md" />
  </column>
  <file name="traffic.py">{\`
    import json, re
    hits = {"hits": 0}
    for line in open("access.log"):
        if re.search(r"GET /", line):
            hits["hits"] += 1
    print(json.dumps(hits))
  \`}</file>
</slate>`;

const PY = 'import json, re\nhits = {"hits": 0}\nfor line in open("access.log"):\n    if re.search(r"GET /", line):\n        hits["hits"] += 1\nprint(json.dumps(hits))';

const doc = (text: string): SlateDoc => {
  const r = parseSlate(text);
  expect(r.errors).toEqual([]);
  return r.document!;
};
const problems = (text: string) => { const r = parseSlate(text); return [...r.errors, ...r.warnings].map(p => `${p.code} ${p.message}`); };

describe("a slate's files", () => {
  it("declares code as written, indentation and braces kept, beside the file piece", () => {
    const d = doc(TRAFFIC);
    expect(d.files).toEqual({ "traffic.py": PY });
    expect(Object.values(d.pieces).map(p => p.type)).toEqual(["column", "number", "file"]);
    expect(d.pieces["file-1"]!.props).toEqual({ path: "README.md" });
  });

  it("prints back to the same document", () => {
    const d = doc(TRAFFIC);
    const printed = printSlate(d);
    expect(printed).toContain('  <file name="traffic.py">{`\n    import json, re\n');
    expect(doc(printed)).toEqual(d);
    const raw = { ...d, files: { "q.sh": "echo `date`" } };
    expect(doc(printSlate(raw)).files).toEqual({ "q.sh": "echo `date`" });
  });

  it("replaces a file by name in a patch and removes it with <remove name>", () => {
    const d = doc(TRAFFIC);
    const values = slateStartValues(d);
    const next = parseSlatePatch('<file name="traffic.py">{`print(1)`}</file>', d);
    expect(next.errors).toEqual([]);
    expect(next.patch!.ops).toEqual([{ op: "file", name: "traffic.py", text: "print(1)" }]);
    const replaced = applySlatePatch(d, values, next.patch!);
    expect(replaced.errors).toEqual([]);
    expect(replaced.document!.files).toEqual({ "traffic.py": "print(1)" });
    const added = applySlatePatch(d, values, parseSlatePatch('<file name="shape.py">{`print(2)`}</file>', d).patch!);
    expect(Object.keys(added.document!.files!)).toEqual(["traffic.py", "shape.py"]);
    const gone = parseSlatePatch('<remove name="traffic.py" />', d);
    expect(gone.patch!.ops).toEqual([{ op: "file", name: "traffic.py", text: null }]);
    const removed = applySlatePatch(d, values, gone.patch!);
    expect(removed.document!.files).toBeUndefined();
    expect(removed.warnings.map(w => w.code)).toEqual(["W015"]);
    expect(parseSlatePatch('<remove name="nope.py" />', d).errors.map(e => e.code)).toEqual(["D203"]);
  });

  it("holds a name to a plain file name", () => {
    for (const bad of ["../x.py", "a/b.py", ".env", "x y.py"]) {
      expect(problems(`<slate><column /><file name="${bad}">{\`x\`}</file></slate>`), bad).toEqual([expect.stringMatching(/^K708 /)]);
    }
    expect(problems('<slate><column /><file name="shape.v2.py">{`x`}</file></slate>')).toEqual([]);
  });

  it("holds the files to 16 and 64 KB in all, apart from the document's own 64 KB", () => {
    const many = Array.from({ length: 17 }, (_, i) => `<file name="f${i}.sh">{\`echo ${i}\`}</file>`).join("\n");
    expect(problems(`<slate><column />${many}</slate>`)).toEqual(["K709 17 files; the most is 16"]);
    const big = "x".repeat(40 * 1024);
    expect(problems(`<slate><column /><file name="a.txt">${big}</file></slate>`)).toEqual([]);
    expect(problems(`<slate><column /><file name="a.txt">${big}</file><file name="b.txt">${big}</file></slate>`)).toEqual(["K709 the files hold 80 KB; the most is 64 KB in all"]);
  });

  it("refuses a file that names a secret, which it would hold as written", () => {
    const text = (body: string): string => `<slate><secret name="token" /><run name="go" cmd='bash "$SLATE_DIR/go.sh"' env={{ TOKEN: $token }} /><column><input label="Token" value={$token} /></column><file name="go.sh">{\`${body}\`}</file></slate>`;
    expect(problems(text('curl -H "Authorization: $token" x'))).toEqual([expect.stringMatching(/^S520 go.sh names the secret \$token/)]);
    expect(problems(text("curl -H @- x <<< \"$TOKEN\""))).toEqual([]);
  });

  it("warns when a run runs a file no <file> declares", () => {
    expect(problems('<slate><run name="go" cmd=\'python3 "$SLATE_DIR/trafic.py"\' /><column /><file name="traffic.py">{`print(1)`}</file></slate>'))
      .toEqual(['W015 $go runs $SLATE_DIR/trafic.py, and no <file name="trafic.py"> is declared']);
    expect(problems('<slate><run name="go" cmd="echo hi" then=\'python3 ${SLATE_DIR}/shape.py\' /><column /></slate>'))
      .toEqual(['W015 $go runs $SLATE_DIR/shape.py, and no <file name="shape.py"> is declared']);
  });

  it("takes files in the stored JSON form too", () => {
    const d = doc(TRAFFIC);
    expect(validateSlate(JSON.parse(JSON.stringify(d))).document).toEqual(d);
  });

  it("sketches files by name and size, never their text", () => {
    const s = sketchSlate(doc(TRAFFIC), {});
    expect(s).toContain(`files in $SLATE_DIR: traffic.py (${PY.length} B)`);
    expect(s).not.toContain("import json");
  });

  it("is in the catalog: the declaration in the index, the rule in the runs entry", () => {
    expect(slateCatalog()).toContain("<file name>");
    expect(slateCatalog("runs")).toContain('Code only the slate uses goes in <file name="x.py"> and runs as $SLATE_DIR/x.py; project code runs where it is.');
    expect(slateCatalog("runs")).toContain("run by bash -c in the thread's folder");
  });

  it("says in the rules to build with the slate tools and to take a secret in a <secret> input", () => {
    expect(SLATE_RULES).toContain("Use the slate tools, never wsp from a shell.");
    expect(SLATE_RULES).toContain("A secret the person types goes in a <secret> input, never a file or the chat. One in a file stays there for the run to read, never you.");
  });
});
