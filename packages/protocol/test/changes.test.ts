// SPDX-License-Identifier: AGPL-3.0-only
// The checkout fact's words, the diff a draft is asked from, the question itself, and the answer read back as a
// commit message.
import { describe, expect, it } from "vitest";
import { CHECKOUT_WORDS, checkoutCounts, commitMessage, cutDiff, DRAFT_DIFF_MAX_BYTES, draftPrompt, type Checkout } from "../src/index.js";

const fact: Checkout = { branch: "fix/cart", ahead: 0, behind: 0, changed: 0, readAt: 1 };

describe("the counts after a branch", () => {
  it("names only what the checkout holds uncommitted: never how far the branch is ahead or behind, which Update from main in the pane acts on", () => {
    const counted = (c: Checkout): string[] => checkoutCounts(c);
    expect(counted({ ...fact, ahead: 2, behind: 1, changed: 3 })).toEqual(["3 changed"]);
    expect(counted({ ...fact, ahead: 4 })).toEqual([]);
    expect(counted(fact)).toEqual([]);
  });

  it("says the changes were not read where a stopped copy's edits were not", () => {
    const counted = (c: Checkout): string[] => checkoutCounts(c);
    expect(counted({ ...fact, ahead: 1, editsUnread: true })).toEqual([CHECKOUT_WORDS.unread]);
    expect(counted({ ...fact, ahead: 4, behind: 2, countsUnknown: true, changed: 2 })).toEqual(["2 changed"]);
  });
});

describe("the diff a draft is asked from", () => {
  it("is left whole under the cap and cut at the last line end inside it over the cap", () => {
    expect(cutDiff("a\nb\n", 100)).toBe("a\nb\n");
    expect(cutDiff("one\ntwo\nthree\n", 9)).toBe("one\ntwo\n");
  });

  it("counts bytes, so a letter of two bytes is never cut in half", () => {
    const cut = cutDiff("é\né\né\n", 5);
    expect(cut).toBe("é\n");
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(5);
  });

  it("is capped at 48 KB", () => {
    expect(DRAFT_DIFF_MAX_BYTES).toBe(48 * 1024);
  });
});

describe("the draft question", () => {
  it("asks for a subject under 72 characters, a blank line, two to five lines of why, and no em dashes, with the diff", () => {
    const asked = draftPrompt("diff --git a/x b/x\n+one\n");
    expect(asked).toContain("under 72 characters");
    expect(asked).toContain("two to five lines");
    expect(asked).toContain("No em dashes");
    expect(asked.endsWith("diff --git a/x b/x\n+one\n")).toBe(true);
    expect(asked).not.toContain("The task");
  });

  it("carries the task the thread was opened with where there is one", () => {
    expect(draftPrompt("+x\n", "Fix the flaky cart test")).toContain("The task the agent was given:\nFix the flaky cart test");
  });
});

describe("the answer read as a commit message", () => {
  it("keeps the subject, one blank line and the body", () => {
    expect(commitMessage("Round the cart total once\n\nThe total rounded per line.\nNow it rounds at the end.\n")).toBe(
      "Round the cart total once\n\nThe total rounded per line.\nNow it rounds at the end.",
    );
    expect(commitMessage("Round the cart total once")).toBe("Round the cart total once");
  });

  it("takes off a fence or quotes around the message, and turns an em dash into a comma", () => {
    expect(commitMessage("```\nFix the cart\n\nWhy it broke.\n```")).toBe("Fix the cart\n\nWhy it broke.");
    expect(commitMessage('"Fix the cart"')).toBe("Fix the cart");
    expect(commitMessage("Fix the cart \u2014 rounding\n\nIt rounded twice \u2014 once per line.")).toBe("Fix the cart, rounding\n\nIt rounded twice, once per line.");
  });

  it("cuts a subject past 72 characters to the words that fit, and reads an empty answer as none", () => {
    const long = `${"word ".repeat(20).trim()}\n\nbody`;
    const subject = commitMessage(long)!.split("\n")[0]!;
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith("word")).toBe(true);
    expect(commitMessage("  \n ")).toBeNull();
  });
});
