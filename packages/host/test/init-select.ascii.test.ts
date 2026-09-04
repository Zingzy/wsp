// SPDX-License-Identifier: AGPL-3.0-only
// The rung screen and the card on a terminal without unicode (clack's `unicode`
// is false on TERM=linux): the bars, the focused end and the help line's
// separator fall back to ASCII of ours, never to clack's em-dash.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", async importOriginal => {
  const real = await importOriginal<typeof import("@clack/prompts")>();
  return { ...real, unicode: false, S_BAR: "|", S_BAR_END: "\u2014", S_STEP_ACTIVE: "*", S_STEP_SUBMIT: "o", S_STEP_CANCEL: "x" };
});

const { S_BAR_FOCUS, S_BAR_FOCUS_END, card, helpLine } = await import("../src/init-layout.js");
const { rungSelect } = await import("../src/init-select.js");

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  return { input, output, text: () => stripVTControlCharacters(chunks.join("")) };
}

describe("rung screen without unicode", () => {
  it("the focused bar is a pipe and its end a plus, one cell each, and the help line joins with spaces", async () => {
    expect([S_BAR_FOCUS, S_BAR_FOCUS_END]).toEqual(["|", "+"]);
    expect(helpLine([{ key: "space", does: "tick" }, { key: "esc", does: "back" }], 1)).toBe("space tick   esc back");
    const { input, output, text } = streams();
    const p = rungSelect({ title: "Tools", counter: "5/7", items: [{ id: "gh", label: "gh", group: "Homebrew", detail: [] }], initial: new Set(), input, output });
    await new Promise(r => setTimeout(r, 5));
    const lines = text().split("\n");
    expect(lines[0]).toMatch(/^\*  Tools\s+5\/7$/);
    expect(lines.slice(1, -1).every(l => l.startsWith("|"))).toBe(true);
    expect(lines.at(-1)).toBe("+  space tick   ← → fold   enter next   esc back");
    expect(text()).not.toMatch(/[\u2014•┃┗│└]/);
    input.write("\r");
    await p;
    expect(text().slice(text().lastIndexOf("o  Tools")).split("\n")[1]).toBe("|  none");
  });

  it("a card takes the ASCII step glyph; its bar is clack's own, drawn from the terminal clack saw at start", () => {
    const { output, text } = streams();
    card("Summary", ["Identity  2 of 3"], output);
    expect(text().split("\n")[1]).toBe("o  Summary");
  });
});
