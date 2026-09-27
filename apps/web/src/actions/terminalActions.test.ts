// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { resolveActions } from "./registry";
import { terminalActions, type TerminalVerbs } from "./terminalActions";

const verbs = (added: string[]): TerminalVerbs => ({
  split: () => {},
  splitVertical: () => {},
  newTerminal: () => {},
  close: () => {},
  addToChat: () => void added.push("added"),
});

describe("the terminal's Add to chat", () => {
  it("is offered only while lines are selected, and puts them into the draft", async () => {
    const added: string[] = [];
    expect(resolveActions(terminalActions, { hasSelection: false, atSplitLimit: false }, verbs(added)).map(a => a.id)).not.toContain("add-to-chat");
    const action = resolveActions(terminalActions, { hasSelection: true, atSplitLimit: false }, verbs(added)).find(a => a.id === "add-to-chat");
    expect(action?.title).toBe("Add to chat");
    expect(action?.refusal).toBeNull();
    await action?.run();
    expect(added).toEqual(["added"]);
  });
});
