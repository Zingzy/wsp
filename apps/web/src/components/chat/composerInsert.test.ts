// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from "vitest";

import { splitPromptIntoComposerSegments, terminalExcerptText } from "../../composer-editor-mentions";
import { insertIntoComposer } from "./composerInsert";
import { useComposerDraftStore } from "./composerDraftStore";

beforeEach(() => useComposerDraftStore.setState({ drafts: {}, queues: {} }));

describe("insertIntoComposer", () => {
  it("puts a block at the draft's caret on lines of its own, as one chip, with the caret after it", () => {
    useComposerDraftStore.getState().setDraft("ws_1", { prompt: "why does this fail", cursor: "why does this fail".length });
    const block = terminalExcerptText({ label: "Terminal 1", text: "$ pnpm test\nFAIL a.test.ts" });
    insertIntoComposer("ws_1", block);
    const draft = useComposerDraftStore.getState().drafts["ws_1"]!;
    expect(draft.prompt).toBe(`why does this fail\n${block}\n`);
    expect(splitPromptIntoComposerSegments(draft.prompt).map(segment => segment.type)).toEqual(["text", "terminal", "text"]);
    // "why does this fail" and its newline, the chip, then the newline after it.
    expect(draft.cursor).toBe("why does this fail\n".length + 1 + 1);
  });

  it("starts an empty draft with the block alone", () => {
    insertIntoComposer("ws_2", terminalExcerptText({ label: "Terminal 1", text: "ok" }));
    expect(useComposerDraftStore.getState().drafts["ws_2"]!.prompt).toBe("Terminal output from Terminal 1:\n```\nok\n```\n");
  });
});
