// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { compileSlate, compileSlateJsx, printSlateJsx, type Slate } from "../../src/index.js";
import { PR_LINES, TRACKER_LINES, USAGE_LINES } from "./examples.js";

const lines = (src: string): Slate => {
  const r = compileSlate(src);
  expect(r.errors).toEqual([]);
  return r.document!;
};

describe("the JSX-like form", () => {
  it.each([["pr", PR_LINES], ["usage", USAGE_LINES], ["tracker", TRACKER_LINES]])("prints %s and reads it back to the same document", (_name, src) => {
    const doc = lines(src);
    const jsx = printSlateJsx(doc);
    const back = compileSlateJsx(jsx);
    expect(back.errors).toEqual([]);
    expect(back.document).toEqual(doc);
  });

  it("compiles to what the lines compile to", () => {
    const fromLines = lines(`slate 1 "Steps"

state.done = 0
state.note = ""

root: column
  bar: meter label="Steps" value={state.done} max=3 fraction
  note: input label="Note" value={state.note} lines=3
    @submit send text="A note." with=[state.note]
  next: button label="Go on" primary when={state.done < 3}
    @press send text="Go on." with=[state.done]
    @press set path=state.done value={state.done + 1}
  used: text value=\`\${pct(thread.context.percent)} used\` muted
  files: table items={thread.changes.files} key={item.path}
    - col title="File" value={item.path} mono
    - action label="Explain" when={item.additions > 0}
      @press send text="Explain this file." with=[item.path]
`);
    const fromJsx = compileSlateJsx(`<slate title="Steps" state={{ done: 0, note: "" }}>
  <column id="root">
    <meter id="bar" label="Steps" value={state.done} max={3} fraction />
    <input id="note" label="Note" value={state.note} lines={3} onSubmit={send("A note.", { with: [state.note] })} />
    <button id="next" label="Go on" primary when={state.done < 3}
      onPress={[send("Go on.", { with: [state.done] }), set(state.done, state.done + 1)]} />
    {/* words and formulas between the tags make a format */}
    <text id="used" muted>{pct(thread.context.percent)} used</text>
    <table id="files" items={thread.changes.files} key={item.path}>
      <col title="File" value={item.path} mono />
      <action label="Explain" when={item.additions > 0} onPress={send("Explain this file.", { with: [item.path] })} />
    </table>
  </column>
</slate>`);
    expect(fromJsx.errors).toEqual([]);
    expect(fromJsx.document).toEqual(fromLines);
  });

  it.each<[string, string, string]>([
    ["a bare number", '<meter label="x" value=3 />', "P100"],
    ["an unknown flag", '<text bold>x</text>', "P102"],
    ["an item outside its owner", '<column><col title="a" value={item.a} /></column>', "T314"],
    ["an unknown event", '<button label="x" onClick={send("go")} />', "A602"],
    ["a mismatched close", "<column><text>a</column>", "P100"],
    ["two roots", "<text>a</text><text>b</text>", "D202"],
    ["state that is not literal", '<slate state={{ a: pr.number }}><text>a</text></slate>', "S502"],
    ["JS logic in a formula", "<text when={a && b}>x</text>", "X400"],
    ["a send whose text is a formula", '<button label="x" onPress={send(`go ${git.branch}`)} />', "A603"],
  ])("refuses %s with its code", (_name, src, code) => {
    const r = compileSlateJsx(src);
    expect(r.errors.map(e => e.code)).toContain(code);
    expect(r.errors.every(e => e.line !== undefined || e.piece !== undefined || e.code === "D202")).toBe(true);
  });
});
