// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { buildComposerPromptHistoryEntries, stepComposerPromptHistory, type ComposerPromptHistoryPosition, type ComposerPromptHistoryStep } from "./composerPromptHistory";

const user = (id: string, text: string) => ({ id, role: "user", text });

describe("the prompts a thread sent, for arrow-up recall", () => {
  it("are the thread's own user messages oldest first, chips kept as the text they send, a repeat collapsed into the newest", () => {
    const entries = buildComposerPromptHistoryEntries([
      user("m1", "first"),
      { id: "a1", role: "assistant", text: "a reply" },
      user("m2", "summarise @apps/web/src/composer-logic.ts"),
      user("m3", "again"),
      user("m4", "again"),
      user("m5", "   "),
    ]);
    expect(entries).toEqual([
      { id: "m1", prompt: "first" },
      { id: "m2", prompt: "summarise @apps/web/src/composer-logic.ts" },
      { id: "m4", prompt: "again" },
    ]);
  });

  it("walk back newest first from an empty box, forward again, and past the newest empty the box", () => {
    const entries = buildComposerPromptHistoryEntries([user("m1", "one"), user("m2", "two"), user("m3", "three")]);
    let position: ComposerPromptHistoryPosition | null = null;
    let prompt = "";
    const seen: string[] = [];
    for (let n = 0; n < 3; n++) {
      const step: ComposerPromptHistoryStep = stepComposerPromptHistory({ direction: "backward", entries, position, currentPrompt: prompt })!;
      ({ position, prompt } = step);
      seen.push(prompt);
    }
    expect(seen).toEqual(["three", "two", "one"]);
    expect(stepComposerPromptHistory({ direction: "backward", entries, position, currentPrompt: prompt })).toBeNull();
    const forward = stepComposerPromptHistory({ direction: "forward", entries, position, currentPrompt: prompt })!;
    expect(forward.prompt).toBe("two");
    const past = stepComposerPromptHistory({ direction: "forward", entries, position: { entryId: "m3", recalled: "three" }, currentPrompt: "three" })!;
    expect(past).toEqual({ position: null, prompt: "" });
  });

  it("leave a box holding words the person typed alone, and end browsing once a recalled prompt is edited", () => {
    const entries = buildComposerPromptHistoryEntries([user("m1", "one"), user("m2", "two")]);
    expect(stepComposerPromptHistory({ direction: "backward", entries, position: null, currentPrompt: "half a thought" })).toBeNull();
    expect(stepComposerPromptHistory({ direction: "backward", entries, position: { entryId: "m2", recalled: "two" }, currentPrompt: "two, edited" })).toBeNull();
    expect(stepComposerPromptHistory({ direction: "forward", entries, position: null, currentPrompt: "" })).toBeNull();
  });
});
