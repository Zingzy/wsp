// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { PullRequestPage } from "@wsp/protocol";
import { isMergeCommit } from "./commits.logic.js";
import { conversationCount, conversationOf, hunkTail, openComments, reviewVerdict } from "./conversation.logic.js";

const page = (over: Partial<PullRequestPage> = {}): PullRequestPage => ({
  title: "t",
  body: "",
  author: "cass",
  createdAt: "",
  updatedAt: "",
  labels: [],
  reviewRequests: [],
  latestReviews: [],
  assignees: [],
  commits: [],
  reviews: [],
  comments: [],
  reviewComments: [],
  files: [],
  sent: [],
  ...over,
});
const comment = (id: number, author: string, at: string, body = "c") => ({ id, author, bot: false, body, url: `u${id}`, at });
const line = (id: number, o: { author?: string; at: string; replyTo?: number; reviewId?: number; resolved?: boolean; bot?: boolean; path?: string }) => ({
  id,
  path: o.path ?? "a.ts",
  line: 4,
  side: "RIGHT",
  author: o.author ?? "ana",
  bot: o.bot ?? false,
  body: `b${id}`,
  url: `u${id}`,
  at: o.at,
  ...(o.replyTo !== undefined ? { replyTo: o.replyTo } : {}),
  ...(o.reviewId !== undefined ? { reviewId: o.reviewId } : {}),
  ...(o.resolved !== undefined ? { resolved: o.resolved } : {}),
});

describe("the conversation's timeline", () => {
  it("puts comments and reviews in time order, and folds the commits between two of them into one push", () => {
    const entries = conversationOf(
      page({
        comments: [comment(1, "vercel", "2026-09-27T01:00:00Z"), comment(2, "ana", "2026-09-27T04:00:00Z")],
        reviews: [{ id: 9, author: "bo", state: "CHANGES_REQUESTED", body: "see", at: "2026-09-27T02:00:00Z" }],
        commits: [
          { oid: "a".repeat(40), subject: "feat: one", body: "", at: "2026-09-27T00:30:00Z", author: "cass" },
          { oid: "b".repeat(40), subject: "fix: two", body: "", at: "2026-09-27T03:00:00Z", author: "cass" },
          { oid: "c".repeat(40), subject: "merge: origin/main into x", body: "", at: "2026-09-27T03:10:00Z", author: "dee" },
        ],
      }),
    );
    expect(entries.map(e => e.kind)).toEqual(["push", "comment", "review", "push", "comment"]);
    const push = entries[3]!;
    if (push.kind !== "push") throw new Error("not a push");
    expect(push.commits.map(c => c.oid[0])).toEqual(["b", "c"]);
    expect(push.authors).toEqual(["cass", "dee"]);
  });

  it("keeps a page's own order where two entries share a time, a review before the comment that answers it", () => {
    const at = "2026-09-27T02:00:00Z";
    const entries = conversationOf(page({ comments: [comment(1, "ana", at)], reviews: [{ author: "bo", state: "APPROVED", body: "", at }] }));
    expect(entries.map(e => e.kind)).toEqual(["review", "comment"]);
  });

  it("puts each thread under the review that left it, a reply under the comment it answers, and a thread no review holds on its own", () => {
    const entries = conversationOf(
      page({
        reviews: [{ id: 5, author: "ana", state: "COMMENTED", body: "", at: "2026-09-27T02:00:00Z" }],
        reviewComments: [
          line(11, { at: "2026-09-27T02:00:00Z", reviewId: 5 }),
          line(12, { at: "2026-09-27T03:00:00Z", author: "cass", replyTo: 11, reviewId: 6 }),
          line(13, { at: "2026-09-27T02:00:00Z", reviewId: 5, path: "b.ts" }),
          line(14, { at: "2026-09-27T04:00:00Z" }),
        ],
      }),
    );
    expect(entries.map(e => (e.kind === "review" ? ["review", e.threads.map(t => t.comments.map(c => c.id))] : e.kind === "thread" ? ["thread", e.thread.comments.map(c => c.id)] : [e.kind]))).toEqual([
      ["review", [[11, 12], [13]]],
      ["thread", [14]],
    ]);
  });

  it("leaves out the empty review GitHub opens for a reply on a line, in the timeline and in the count", () => {
    const p = page({
      reviews: [
        { id: 5, author: "ana", state: "COMMENTED", body: "", at: "2026-09-27T02:00:00Z" },
        { id: 6, author: "cass", state: "COMMENTED", body: "", at: "2026-09-27T03:00:00Z" },
      ],
      reviewComments: [line(11, { at: "2026-09-27T02:00:00Z", reviewId: 5 }), line(12, { at: "2026-09-27T03:00:00Z", author: "cass", replyTo: 11, reviewId: 6 })],
    });
    expect(conversationOf(p).map(e => (e.kind === "review" ? `review:${e.review.id}` : e.kind))).toEqual(["review:5"]);
    expect(conversationCount(p)).toBe(1);
  });

  it("counts the comments and the reviews, as the tab says", () => {
    expect(conversationCount(page({ comments: [comment(1, "a", "")], reviews: [{ author: "b", state: "COMMENTED", body: "looks fine", at: "" }] }))).toBe(2);
  });

  it("reads each review's verdict in the head's words, whatever case the host gave it", () => {
    expect(["CHANGES_REQUESTED", "approved", "COMMENTED", "DISMISSED"].map(reviewVerdict)).toEqual([
      { word: "Changes asked for", tone: "warn" },
      { word: "Approved", tone: "ok" },
      { word: "Commented", tone: "quiet" },
      { word: "Dismissed", tone: "quiet" },
    ]);
  });

  it("reads a merge off its two parents where the host counted them, and off its subject where it did not", () => {
    expect([
      isMergeCommit({ subject: "fix: x", parents: 2 }),
      isMergeCommit({ subject: "merge: origin/main into x", parents: 1 }),
      isMergeCommit({ subject: "Merge branch 'main' into x" }),
      isMergeCommit({ subject: "fix: x" }),
    ]).toEqual([true, false, true, false]);
  });
});

describe("a thread's code", () => {
  it("is the hunk's last three lines down to the commented one, numbered off its header", () => {
    const hunk = "@@ -253,4 +255,6 @@ export function x\n ctx\n-gone\n+const settled = a;\n+if (settled) return true;\n+if (open) return false;";
    expect(hunkTail(hunk)).toEqual([
      { new: 256, kind: "add", text: "const settled = a;" },
      { new: 257, kind: "add", text: "if (settled) return true;" },
      { new: 258, kind: "add", text: "if (open) return false;" },
    ]);
    expect(hunkTail("@@ -5,2 +5,2 @@\n a\n-b", 3)).toEqual([
      { old: 5, new: 5, kind: "ctx", text: "a" },
      { old: 6, kind: "del", text: "b" },
    ]);
    expect(hunkTail("not a hunk")).toEqual([]);
  });
});

describe("the Comments row", () => {
  it("counts a person's comments on unresolved threads not yet sent, leaving bots and sent ones out", () => {
    const p = page({
      reviewComments: [
        line(1, { at: "2026-09-27T01:00:00Z", resolved: false }),
        line(2, { at: "2026-09-27T02:00:00Z", replyTo: 1, resolved: false }),
        line(3, { at: "2026-09-27T01:00:00Z", resolved: true, path: "b.ts" }),
        line(4, { at: "2026-09-27T01:00:00Z", bot: true, resolved: false, path: "c.ts" }),
      ],
      sent: [{ kind: "reviewComment", id: 2, at: 1 }],
    });
    expect(openComments(p)).toEqual({ items: [{ kind: "reviewComment", id: 1 }], word: "unresolved" });
    expect(openComments(page({ reviewComments: [line(1, { at: "2026-09-27T01:00:00Z" })] })).word).toBe("unsent");
  });
});
