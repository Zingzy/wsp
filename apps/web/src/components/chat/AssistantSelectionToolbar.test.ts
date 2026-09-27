// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "vitest";

import { readQuotedSelection } from "./AssistantSelectionToolbar";

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

function timeline(): HTMLElement {
  document.body.innerHTML = `
    <div id="viewport">
      <div data-quote-message="reply-1"><p id="one">Safari drops the cookie on redirect.</p></div>
      <div data-quote-message="reply-2"><p id="two">A second reply.</p></div>
      <p id="outside">A user's own message.</p>
    </div>`;
  return document.getElementById("viewport")!;
}

function select(from: Node, fromOffset: number, to: Node, toOffset: number): Selection {
  const range = document.createRange();
  range.setStart(from, fromOffset);
  range.setEnd(to, toOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("readQuotedSelection", () => {
  it("reads a selection inside one reply as its text and that reply's id, carrying no prompt on the row", () => {
    const viewport = timeline();
    const text = document.getElementById("one")!.firstChild!;
    expect(readQuotedSelection(viewport, select(text, 0, text, 6))).toMatchObject({ text: "Safari", messageId: "reply-1" });
    const second = document.getElementById("two")!.firstChild!;
    expect(readQuotedSelection(viewport, select(second, 2, second, 8))).toMatchObject({ text: "second", messageId: "reply-2" });
  });

  it("quotes nothing that runs across two replies or starts outside one", () => {
    const viewport = timeline();
    const one = document.getElementById("one")!.firstChild!;
    const two = document.getElementById("two")!.firstChild!;
    const outside = document.getElementById("outside")!.firstChild!;
    expect(readQuotedSelection(viewport, select(one, 0, two, 3))).toBeNull();
    expect(readQuotedSelection(viewport, select(outside, 0, outside, 4))).toBeNull();
  });
});
