// SPDX-License-Identifier: AGPL-3.0-only
// The checkout fact's words, the diff a draft is asked from, the question itself, and the answer read back as a
// commit message.
import { describe, expect, it } from "vitest";
import { CHECKOUT_WORDS, checkoutCounts, commitMessage, cutDiff, DRAFT_DIFF_MAX_BYTES, draftPrompt, type PullRequestFact } from "../src/index.js";

const fact = { branch: "fix/cart", ahead: 0, behind: 0, changed: 0, readAt: 1 };
/** A pull request as the status carries it, open against main unless a case says otherwise. */
const pr = (over: Partial<PullRequestFact> = {}): PullRequestFact => ({
  number: 12,
  url: "https://github.com/o/r/pull/12",
  state: "open",
  host: "github.com",
  draft: false,
  base: "main",
  branch: "fix/cart",
  headOid: "abc",
  headSubject: "",
  mergeable: "mergeable",
  mergeState: "clean",
  review: "none",
  checks: [],
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  commits: 1,
  readAt: 1,
  ...over,
});

describe("the counts after a branch", () => {
  it("names each count that is not zero, ahead then behind the base then changed, each its own words", () => {
    expect(checkoutCounts({ ...fact, ahead: 1, changed: 3 })).toEqual(["1 ahead", "3 changed"]);
    expect(checkoutCounts({ ...fact, ahead: 2, changed: 1 }, pr({ behindBase: 3 }))).toEqual(["2 ahead", "3 behind main", "1 changed"]);
    expect(checkoutCounts(fact)).toEqual([]);
  });

  it("counts behind the base only while the pull request is open, and never off one that could not be read", () => {
    expect(checkoutCounts(fact, pr({ behindBase: 3, state: "merged" }))).toEqual([]);
    expect(checkoutCounts(fact, pr({ behindBase: 3, state: "closed" }))).toEqual([]);
    expect(checkoutCounts(fact, { number: 12, url: "u", state: "merged", base: "main", readAt: 1 })).toEqual([]);
    expect(checkoutCounts(fact, { why: "not read", readAt: 1 })).toEqual([]);
    expect(checkoutCounts(fact, pr({ behindBase: 2, base: "develop" }))).toEqual(["2 behind develop"]);
  });

  it("counts behind against the base the pull request read, never against the branch's own upstream", () => {
    // Once pushed, the upstream count is almost always nothing and says nothing about main.
    const pushed = { ...fact, ahead: 2, behind: 1, changed: 1 };
    expect(checkoutCounts(pushed)).toEqual(["2 ahead", "1 changed"]);
    const behindUpstream = { ...fact, behind: 5 };
    expect(checkoutCounts(behindUpstream, pr({ behindBase: 0 }))).toEqual([]);
    expect(checkoutCounts(fact, pr({ base: "develop" }))).toEqual([]);
    expect(CHECKOUT_WORDS.behind(1, "develop")).toBe("1 behind develop");
  });

  it("says the changes were not read where a stopped copy's edits were not, and no count it does not have", () => {
    expect(checkoutCounts({ ...fact, ahead: 1, editsUnread: true })).toEqual(["1 ahead", CHECKOUT_WORDS.unread]);
    // The count behind the base is GitHub's and stands where git's own history was too long to walk.
    const unwalked = { ...fact, ahead: 4, behind: 2, countsUnknown: true, changed: 2 };
    expect(checkoutCounts(unwalked, pr({ behindBase: 1 }))).toEqual(["1 behind main", "2 changed"]);
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
