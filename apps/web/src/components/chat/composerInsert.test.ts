// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { splitPromptIntoComposerSegments, terminalExcerptText } from "../../composer-editor-mentions";
import { insertIntoComposer } from "./composerInsert";
import { useComposerDraftStore } from "./composerDraftStore";
import { MountedComposer } from "./testing";

beforeEach(() => useComposerDraftStore.setState({ drafts: {}, queues: {} }));
afterEach(cleanup);

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

  it("leaves the block in a mounted composer, which takes focus once the block has rendered", async () => {
    render(createElement(MountedComposer, { workspaceId: "ws_3" }));
    const block = terminalExcerptText({ label: "Terminal 1", text: "ok" });
    await act(async () => insertIntoComposer("ws_3", block));
    expect(useComposerDraftStore.getState().drafts["ws_3"]!.prompt).toBe(`${block}\n`);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("composer-editor");
  });
});
