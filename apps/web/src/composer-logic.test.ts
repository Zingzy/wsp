// Adapted from pingdotgg/t3code apps/web/src/composer-logic.test.ts at 57a66608 (MIT).
// Differs from upstream: the citation cases are dropped with T3's citation links;
// the pull-request arm is upstream's later one, and the cursor maps read wsp's
// own wire forms, where a block chip spans lines.
import { describe, expect, it } from "vitest";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  composerSubmissionIntentForEnter,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  isCollapsedCursorAdjacentToInlineToken,
  replaceTextRange,
} from "./composer-logic";
import { hostItemText, terminalExcerptText } from "./composer-editor-mentions";

describe("composerSubmissionIntentForEnter", () => {
  it("submits plain Enter on desktop", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: false,
        shiftKey: false,
        modifierKey: false,
        isDraftThread: true,
      }),
    ).toBe("foreground");
  });

  it("inserts a newline for plain Enter on mobile", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: true,
        shiftKey: false,
        modifierKey: false,
        isDraftThread: true,
      }),
    ).toBeNull();
  });

  it("inserts a newline for Shift+Enter", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: false,
        shiftKey: true,
        modifierKey: false,
        isDraftThread: true,
      }),
    ).toBeNull();
  });

  it("submits a new thread in the background with Mod+Enter", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: false,
        shiftKey: false,
        modifierKey: true,
        isDraftThread: true,
      }),
    ).toBe("background");
  });

  it("keeps Mod+Enter in the foreground for an active thread", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: false,
        shiftKey: false,
        modifierKey: true,
        isDraftThread: false,
      }),
    ).toBe("foreground");
  });
});

describe("detectComposerTrigger", () => {
  it("detects slash command token while typing command name", () => {
    const text = "/mo";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "mo",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps /model as a slash command item", () => {
    const text = "/model";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "model",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("does not keep a subcommand trigger active after /model arguments", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });

  it("detects a slash at the start of a later line with that line's offset", () => {
    const text = "first\n/rev";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: "first\n".length,
      rangeEnd: text.length,
    });
  });

  it("detects an @path token at the caret with the query after the @", () => {
    const text = "Please check @src/com";
    expect(detectComposerTrigger(text, text.length)).toEqual({ kind: "path", query: "src/com", rangeStart: "Please check ".length, rangeEnd: text.length });
    expect(detectComposerTrigger("@", 1)).toEqual({ kind: "path", query: "", rangeStart: 0, rangeEnd: 1 });
  });

  it("detects a $skill token", () => {
    const text = "run $unsl";
    expect(detectComposerTrigger(text, text.length)).toEqual({ kind: "skill", query: "unsl", rangeStart: 4, rangeEnd: text.length });
  });

  it("detects a # reference by number or by words, and a bare # before anything is typed", () => {
    expect(detectComposerTrigger("see #4", 6)).toEqual({ kind: "pull-request", query: "4", rangeStart: 4, rangeEnd: 6 });
    expect(detectComposerTrigger("fix #login", 10)).toEqual({ kind: "pull-request", query: "login", rangeStart: 4, rangeEnd: 10 });
    expect(detectComposerTrigger("#", 1)).toEqual({ kind: "pull-request", query: "", rangeStart: 0, rangeEnd: 1 });
  });

  it("opens nothing once the token is left behind or is no token of these", () => {
    expect(detectComposerTrigger("@src/a.ts ", 10)).toBeNull();
    expect(detectComposerTrigger("email me@x", 10)).toBeNull();
    expect(detectComposerTrigger("## Heading", 2)).toBeNull();
  });
});

describe("the cursor maps", () => {
  const mention = "@apps/web/src/composer-logic.ts";
  const block = terminalExcerptText({ label: "Terminal 1", text: "$ pnpm test\nok" });
  const text = `read ${mention} then\n${block}\nnow`;

  it("counts a chip as one place collapsed and its whole text expanded", () => {
    const afterMention = "read ".length + 1;
    expect(expandCollapsedComposerCursor(text, afterMention)).toBe("read ".length + mention.length);
    expect(collapseExpandedComposerCursor(text, "read ".length + mention.length)).toBe(afterMention);
    const afterBlock = afterMention + " then\n".length + 1;
    expect(expandCollapsedComposerCursor(text, afterBlock)).toBe(`read ${mention} then\n${block}`.length);
    expect(clampCollapsedComposerCursor(text, 10_000)).toBe(afterBlock + "\nnow".length);
  });

  it("says when the caret sits beside a chip, on either side", () => {
    expect(isCollapsedCursorAdjacentToInlineToken(text, "read ".length, "right")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, "read ".length + 1, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, 2, "left")).toBe(false);
  });

  it("keeps a # reference's body inside its one chip", () => {
    const reference = hostItemText({ kind: "pull-request", number: 42, title: "Login breaks on Safari", body: "Safari drops\nthe cookie", url: "https://github.com/o/r/pull/42" });
    const prompt = `${reference}\nwhat does this change`;
    expect(expandCollapsedComposerCursor(prompt, 1)).toBe(reference.length);
    expect(clampCollapsedComposerCursor(prompt, 10_000)).toBe(1 + "\nwhat does this change".length);
  });
});

describe("clampCollapsedComposerCursor", () => {
  it("bounds the cursor to the text and floors fractions", () => {
    expect(clampCollapsedComposerCursor("abc", -2)).toBe(0);
    expect(clampCollapsedComposerCursor("abc", 2.7)).toBe(2);
    expect(clampCollapsedComposerCursor("abc", 9)).toBe(3);
    expect(clampCollapsedComposerCursor("abc", Number.NaN)).toBe(3);
  });
});

describe("replaceTextRange", () => {
  it("replaces a text range and returns new cursor", () => {
    const replaced = replaceTextRange("hello @src", 6, 10, "");
    expect(replaced).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });
});
