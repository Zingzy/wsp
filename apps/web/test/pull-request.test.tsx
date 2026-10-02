// SPDX-License-Identifier: AGPL-3.0-only
// The Pull request pane: the head with the state word in its hue, the three tabs with their counts, comments and
// reviews as markdown, one timeline in time order with pushes folded and threads under their review, the 12-line
// clamp, the merge box's rows and their acts, the commits by day with merges marked, a file opening its diff in place
// with its comments on their lines, the sends to the agent one at a time and all at once; then the thread header's
// git button.
import { cloneElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fixAskedLine, updateConflictsLine, type Checkout, type PullRequestFact, type PullRequestKept, type PullRequestPage, type WorkspaceStatus } from "@wsp/protocol";
import { useNotices } from "../src/notices/store.js";
import { useStore } from "../src/protocol/store.js";
import { useDiffStore } from "../src/diffs/store.js";
import { PanelStripSlot } from "../src/components/PanelStripSlot.js";
import { GitSplit } from "../src/pull-request/GitSplit.js";
import { PullRequestSurface } from "../src/pull-request/PullRequestSurface.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { resetSurfaces, view, WS } from "./surface-harness.js";

const codeViews = vi.hoisted(() => ({ last: null as null | { files: { filePath: string }[]; lineNotes?: { filePath: string; line: number; side: string; render: () => unknown }[]; renderHeaderMetadata?: () => unknown; renderHeaderPrefix?: () => unknown; unsafeCSSExtra?: string } }));
vi.mock("../src/components/diffs/AnnotatableCodeView.js", () => ({
  AnnotatableCodeView: (props: NonNullable<typeof codeViews.last>) => {
    codeViews.last = props;
    return (
      <div data-code-view={props.files.map(f => f.filePath).join(",")}>
        {props.renderHeaderPrefix?.() as React.ReactNode}
        {props.renderHeaderMetadata?.() as React.ReactNode}
        {props.lineNotes?.map(n => <div key={`${n.filePath}:${n.line}`}>{n.render() as React.ReactNode}</div>)}
      </div>
    );
  },
}));
vi.mock("../src/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render: React.ReactElement<{ children?: React.ReactNode }>; children?: React.ReactNode }) => (children === undefined ? element : cloneElement(element, {}, children)),
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <span role="tooltip">{children}</span>,
}));
vi.mock("../src/components/DiffWorkerPoolProvider.js", () => ({ DiffWorkerPoolProvider: ({ children }: { children: React.ReactNode }) => children }));

const fact = (over: Partial<PullRequestFact> = {}): PullRequestFact => ({
  number: 12,
  url: "https://github.com/o/r/pull/12",
  state: "open",
  host: "github.com",
  draft: false,
  base: "main",
  branch: "fix/ci",
  headOid: "ec5c10de663bd1860925ad42e9580bab4eb1d377",
  headSubject: "Set .ci-status to 1",
  mergeable: "mergeable",
  mergeState: "clean",
  review: "none",
  checks: [
    { name: "ci", workflow: "ci", state: "fail", run: { runId: 1, jobId: 2 }, link: "https://github.com/o/r/actions/runs/1/job/2", startedAt: "2026-09-28T10:00:00Z", completedAt: "2026-09-28T10:16:00Z" },
    { name: "lint", workflow: "lint", state: "pass" },
  ],
  additions: 120,
  deletions: 30,
  changedFiles: 9,
  commits: 4,
  behindBase: 1,
  readAt: 1,
  ...over,
});

const HUNK = "@@ -1,2 +1,3 @@\n #!/bin/sh\n-exit 0\n+echo checking\n+exit 1";
const PAGE: PullRequestPage = {
  title: "Set .ci-status back to 0",
  body: "The check **failed**.",
  author: "cass",
  createdAt: "2026-09-28T09:00:00Z",
  updatedAt: "2026-09-28T12:00:00Z",
  labels: [{ name: "host", color: "5ee9b5" }],
  reviewRequests: [{ name: "octocat", team: false }],
  latestReviews: [
    { author: "ana", state: "changes_requested", at: "2026-09-28T11:00:00Z" },
    { author: "dee", state: "approved", at: "2026-09-28T11:30:00Z" },
  ],
  assignees: [],
  commits: [
    { oid: "abc1234def", subject: "Set ci status", body: "Why it moved.", at: "2026-09-28T10:00:00Z", author: "cass", parents: 1, additions: 1688, deletions: 117 },
    { oid: "def5678abc", subject: "merge: origin/main into fix", body: "", at: "2026-09-28T10:30:00Z", author: "cass", parents: 2, additions: 40, deletions: 9 },
  ],
  reviews: [
    { id: 50, author: "ana", state: "changes_requested", body: "## Cold review\n\nsee `check.sh`", at: "2026-09-28T11:00:00Z" },
    { id: 51, author: "cass", state: "commented", body: "", at: "2026-09-28T11:40:00Z" },
  ],
  comments: [
    { id: 1, author: "vercel", bot: true, avatar: "https://avatars.githubusercontent.com/in/8329", body: "Deployed", url: "u1", at: "2026-09-28T09:30:00Z" },
    { id: 2, author: "bo", bot: false, body: "thanks, **fixed**", url: "u2", at: "2026-09-28T12:00:00Z" },
  ],
  reviewComments: [
    { id: 7, path: "check.sh", line: 3, side: "RIGHT", author: "ana", bot: false, body: "exit 1 here", url: "u7", at: "2026-09-28T11:00:00Z", hunk: HUNK, reviewId: 50, resolved: false },
    { id: 8, path: "check.sh", line: 3, side: "RIGHT", author: "cass", bot: false, body: "Done", url: "u8", at: "2026-09-28T11:40:00Z", replyTo: 7, reviewId: 51, resolved: false },
  ],
  files: [{ path: "check.sh", additions: 2, deletions: 1 }],
  merge: { methods: ["merge", "squash"], defaultMethod: "squash", autoMerge: true },
  sent: [],
};
const DIFF = "diff --git a/check.sh b/check.sh\nindex 1..2 100644\n--- a/check.sh\n+++ b/check.sh\n@@ -1,2 +1,3 @@\n #!/bin/sh\n-exit 0\n+echo checking\n+exit 1\n";

const statusWith = (pr: WorkspaceStatus["pr"]): WorkspaceStatus =>
  ({ ...view, machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0, ...(pr !== undefined ? { pr } : {}) }) as WorkspaceStatus;

function withApi(pr: WorkspaceStatus["pr"], page: PullRequestPage = PAGE) {
  const api = {
    pullRequestView: vi.fn(async () => page),
    pullRequestDiff: vi.fn(async () => ({ diff: DIFF, truncated: false, left: [] as string[] })),
    pullRequestSend: vi.fn(async (_id: string, items: readonly { kind: "comment" | "review" | "reviewComment"; id: number }[]) => ({ outcome: "steered" as const, threadId: "t1", agent: "claude", sent: items.map(i => ({ ...i, at: Date.now() - 120_000 })) })),
    fix: vi.fn(async (_id: string, check?: string) => ({ outcome: "started" as const, threadId: "t1", base: "main", agent: "claude", ...(check !== undefined ? { check } : {}) })),
    merge: vi.fn(async () => ({ number: 12, method: "squash" as const, merged: true, autoArmed: false })),
    update: vi.fn(async () => ({ base: "main", merged: false, commits: 0, conflicts: ["README.md"] })),
  };
  act(() => useStore.setState({ api: api as never, statuses: { [WS]: statusWith(pr) }, sessions: { [WS]: [{ id: "s1", workspaceId: WS, harness: "claude", status: "done", threadId: "t1", startedAt: 1 }] } as never }));
  return api;
}

async function pane(pr: WorkspaceStatus["pr"] = fact(), page: PullRequestPage = PAGE) {
  const api = withApi(pr, page);
  const utils = render(<PullRequestSurface workspaceId={WS} />);
  await waitFor(() => expect(utils.container.querySelector("[data-pr-title]")?.textContent).toBe(page.title));
  return { api, ...utils };
}
const q = <T extends Element = HTMLElement>(c: ParentNode, sel: string): T => {
  const found = c.querySelector<T>(sel);
  if (found === null) throw new Error(`nothing at ${sel}`);
  return found;
};

/** What a row says, its faces' initials left out. */
const said = (el: Element): string => {
  const copy = el.cloneNode(true) as Element;
  for (const face of copy.querySelectorAll("[data-pr-face]")) face.remove();
  return copy.textContent ?? "";
};

beforeEach(() => {
  resetSurfaces();
  useNotices.setState({ notices: [], toasts: [], unread: 0 });
  codeViews.last = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the Pull request pane's head", () => {
  it("names the title, who opened it with their face and when, the number as a quiet link out, the word, the branches, the labels and who was asked", async () => {
    const { container, api } = await pane();
    expect(api.pullRequestView).toHaveBeenCalledWith(WS);
    const head = q(container, "[data-pr-head]");
    expect(said(q(head, "[data-pr-by]"))).toMatch(/^cass opened \d+ d ago$/);
    expect(q(head, "[data-pr-by] [data-pr-face='cass'] img").getAttribute("src")).toBe("https://github.com/cass.png?size=32");
    const number = q<HTMLAnchorElement>(head, "[data-pr-number]");
    expect([number.textContent, number.getAttribute("href")]).toEqual(["#12", "https://github.com/o/r/pull/12"]);
    expect(number.className).toContain("text-muted-foreground");
    expect(q(head, "[data-pr-branches]").textContent).toBe("main ← fix/ci");
    const label = q(head, "[data-pr-label='host']");
    expect([label.textContent, (label.querySelector("i") as HTMLElement).style.background]).toEqual(["host", "rgb(94, 233, 181)"]);
    expect(said(q(head, "[data-pr-asks]"))).toBe("Review asked of octocat");
  });

  it("wears GitHub's meanings: green open and approved, red closed, failed or conflicting, violet merged, muted draft, and pulses while checks run", async () => {
    const tone = (): [string, string, boolean] => {
      const w = q(document.body, "[data-k='pr-word']");
      return [w.textContent!, w.dataset["tone"]!, w.querySelector(".pr-word-pulse") !== null];
    };
    await pane();
    expect(tone()).toEqual(["Checks failed", "bad", false]);
    const states: [WorkspaceStatus["pr"], [string, string, boolean]][] = [
      [fact({ checks: [] }), ["Open", "ok", false]],
      [fact({ checks: [], mergeable: "conflicting" }), ["Conflicts with main", "bad", false]],
      [fact({ checks: [{ name: "ci", state: "pending" }] }), ["Checks running", "run", true]],
      [fact({ checks: [], review: "approved" }), ["Approved", "ok", false]],
      [fact({ checks: [], review: "changes_asked" }), ["Changes asked for", "warn", false]],
      [{ number: 12, url: "u", state: "merged", base: "main", readAt: 1 } satisfies PullRequestKept, ["Merged", "merged", false]],
      [{ number: 12, url: "u", state: "closed", base: "main", readAt: 1 } satisfies PullRequestKept, ["Closed", "bad", false]],
    ];
    for (const [pr, want] of states) {
      act(() => useStore.setState({ statuses: { [WS]: statusWith(pr) } }));
      expect(tone()).toEqual(want);
    }
  });

  it("scrolls to the merge box from the state word, from any tab", async () => {
    const scrolled = vi.fn();
    const was = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    onTestFinished(() => void (Element.prototype.scrollIntoView = was));
    const { container } = await pane();
    fireEvent.click(q(container, "[data-segment='files']"));
    fireEvent.click(q(container, "[data-pr-word-to-box]"));
    await waitFor(() => expect(scrolled).toHaveBeenCalledTimes(1));
    expect(scrolled.mock.contexts[0]).toBe(q(container, "[data-pr-merge-box]"));
  });

  it("stands its refresh in the panel's tab strip, and a press reads the page again", async () => {
    const strip = document.createElement("div");
    document.body.append(strip);
    onTestFinished(() => strip.remove());
    const api = withApi(fact());
    render(
      <PanelStripSlot.Provider value={strip}>
        <PullRequestSurface workspaceId={WS} />
      </PanelStripSlot.Provider>,
    );
    await waitFor(() => expect(api.pullRequestView).toHaveBeenCalledTimes(1));
    expect(document.querySelector("[data-pr-tabs] [data-pr-refresh]")).toBeNull();
    fireEvent.click(q(strip, "[data-pr-refresh]"));
    await waitFor(() => expect(api.pullRequestView).toHaveBeenCalledTimes(2));
  });

  it("counts each tab: the comments and reviews, the commits, the files", async () => {
    const { container } = await pane();
    expect([...container.querySelectorAll("[data-segment]")].map(s => s.textContent)).toEqual(["Conversation3", "Commits2", "Files1"]);
  });
});

describe("the Conversation tab", () => {
  it("renders the description, the comments and the reviews as markdown, a comment's head held at the body's size", async () => {
    const { container } = await pane();
    expect(q(container, "[data-pr-body] strong").textContent).toBe("failed");
    const review = q(container, "[data-pr-entry='review']");
    expect(q(review, ".pr-md-said h2").textContent).toBe("Cold review");
    expect(q(review, ".pr-md-said code").textContent).toBe("check.sh");
    expect(review.textContent).not.toContain("##");
    const comments = [...container.querySelectorAll<HTMLElement>("[data-pr-entry='comment']")];
    expect(q(comments.at(-1)!, "strong").textContent).toBe("fixed");
    expect(container.querySelectorAll("[data-pr-timeline] .whitespace-pre-wrap:not([data-pr-thread-code] *)")).toHaveLength(0);
  });

  it("puts the entries in time order, the commits between two of them as one push, each thread under its review with its code", async () => {
    const { container } = await pane();
    expect([...container.querySelectorAll<HTMLElement>("[data-pr-entry]")].map(e => e.dataset["prEntry"])).toEqual(["comment", "push", "review", "comment"]);
    const push = q(container, "[data-pr-entry='push']");
    expect(push.textContent).toContain("pushed 2 commits");
    expect([...push.querySelectorAll<HTMLElement>("[data-pr-pushed]")].map(r => r.textContent)).toEqual(["abc1234Set ci status", "def5678merge: origin/main into fix"]);
    const thread = q(q(container, "[data-pr-entry='review']"), "[data-pr-thread]");
    expect([...thread.querySelectorAll("[data-pr-line-comment]")].map(r => r.getAttribute("data-pr-line-comment"))).toEqual(["7", "8"]);
    expect([...thread.querySelectorAll<HTMLElement>("[data-pr-thread-code] [data-line]")].map(l => [l.dataset["line"], l.textContent])).toEqual([
      ["del", "2- exit 0"],
      ["add", "2+ echo checking"],
      ["add", "3+ exit 1"],
    ]);
  });

  it("folds a bot's notice to one line with its own face, its words a press away", async () => {
    const { container } = await pane();
    const bot = q(container, "[data-pr-entry='comment'][data-quiet]");
    expect(bot.textContent).toContain("vercel");
    expect(bot.textContent).toContain("left a notice");
    expect(bot.textContent).not.toContain("Deployed");
    expect(q(bot, "[data-pr-face='vercel'] img").getAttribute("src")).toBe("https://avatars.githubusercontent.com/in/8329");
    fireEvent.click(q(bot, "[data-pr-notice-toggle]"));
    expect(bot.textContent).toContain("Deployed");
  });

  it("names a deleted account and asks GitHub for no face for it", async () => {
    const { container } = await pane(fact(), { ...PAGE, comments: [{ id: 3, author: "", bot: false, body: "gone", url: "u3", at: "2026-09-28T12:00:00Z" }] });
    const entry = q(container, "[data-pr-entry='comment']");
    expect(q(entry, "[data-pr-entry-head] b").textContent).toBe("a deleted account");
    const face = q(entry, "[data-pr-face]");
    expect(face.querySelector("img")).toBeNull();
    expect(container.querySelector("img[src='https://github.com/.png?size=48']")).toBeNull();
    cleanup();
    const app = await pane(fact(), { ...PAGE, comments: [{ id: 4, author: "renovate[bot]", bot: false, body: "bump", url: "u4", at: "2026-09-28T12:00:00Z" }] });
    expect(q(app.container, "[data-pr-face='renovate[bot]']").querySelector("img")).toBeNull();
  });

  it("says once where the host read only the latest reviews and review threads, and not where it read them all", async () => {
    const { container } = await pane(fact(), { ...PAGE, cut: { reviews: true, threads: true } });
    expect([...container.querySelectorAll("[data-pr-cut]")].map(n => n.textContent)).toEqual(["Showing the latest 100 reviews", "Showing the latest 100 review threads"]);
    cleanup();
    const whole = await pane();
    expect(whole.container.querySelector("[data-pr-cut]")).toBeNull();
  });

  it("clamps a body taller than twelve lines with the fade and Show more, and a press lifts the fade", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.parentElement?.hasAttribute("data-pr-clamp") === true ? 900 : 0;
    });
    const { container } = await pane(fact(), { ...PAGE, body: "word ".repeat(400) });
    const body = q(container, "[data-pr-body]");
    expect(body.querySelector("[data-pr-clamp-fade]")?.className).toContain("max-h-[300px]");
    fireEvent.click(q(body, "[data-pr-show-more]"));
    expect(body.querySelector("[data-pr-clamp-fade]")).toBeNull();
    expect(q(body, "[data-pr-show-more]").textContent).toBe("Show less");
  });

  it("leaves a short body whole, with no Show more", async () => {
    const { container } = await pane();
    expect(container.querySelector("[data-pr-body] [data-pr-show-more]")).toBeNull();
  });

  it("sends one item to the agent from its head, named on the tooltip, and says when once sent", async () => {
    const { container, api } = await pane();
    const send = q<HTMLButtonElement>(container, "[data-pr-send='comment:2']");
    expect(send.getAttribute("aria-label")).toBe("Send to Claude Code");
    expect(send.querySelector("[data-harness-mark='claude']")).not.toBeNull();
    fireEvent.click(send);
    await waitFor(() => expect(api.pullRequestSend).toHaveBeenCalledWith(WS, [{ kind: "comment", id: 2 }]));
    await waitFor(() => expect(container.querySelector("[data-pr-send='comment:2']")).toBeNull());
    expect(q(q(container, "[data-pr-entry='comment']:not([data-quiet])"), "[data-pr-sent]").textContent).toBe("Sent 2 m ago");
  });
});

describe("the merge box", () => {
  const box = (c: HTMLElement) => q(c, "[data-pr-merge-box]");
  const row = (c: HTMLElement, k: string) => q(box(c), `[data-pr-box-row='${k}']`);

  it("stands after the timeline under its own head, the checks counted on one line with a failure open under it", async () => {
    const { container } = await pane();
    const timeline = q(container, "[data-pr-timeline]");
    expect(timeline.compareDocumentPosition(box(container)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(box(container).querySelector("h3")!.textContent).toBe("Merge");
    expect(row(container, "checks").textContent).toBe("Checks1 passed, 1 failed");
    expect(row(container, "check:ci").textContent).toContain("ci, failed after 16 min");
    expect(row(container, "checks:pass").textContent).toBe("1 passedlint");
    fireEvent.click(q(box(container), "[data-pr-checks]"));
    expect(box(container).querySelector("[data-pr-box-row='check:ci']")).toBeNull();
  });

  it("sends a failed check to the agent, wearing the agent's mark, and says so with the command line's line", async () => {
    const { container, api } = await pane();
    const fix = q(box(container), "[data-pr-fix='ci']");
    expect(fix.querySelector("[data-harness-mark='claude']")).not.toBeNull();
    fireEvent.click(fix);
    await waitFor(() => expect(api.fix).toHaveBeenCalledWith(WS, "ci"));
    await waitFor(() => expect(useNotices.getState().notices[0]?.text).toBe(fixAskedLine("api", "Claude Code", "ci")));
  });

  it("says each reviewer's standing verdict beside their faces, and offers Review with an agent", async () => {
    const { container } = await pane();
    const review = row(container, "review");
    expect(review.textContent).toContain("ana asked for changes, dee approved");
    expect([...review.querySelectorAll("[data-pr-faces] [data-pr-face]")].map(f => f.getAttribute("data-pr-face"))).toEqual(["ana", "dee"]);
    expect(within(review).getByRole("button", { name: "Review with an agent" })).not.toBeNull();
  });

  it("counts the unresolved comments not yet sent, and sends them all as one message", async () => {
    const { container, api } = await pane();
    const comments = row(container, "comments");
    expect(comments.textContent).toContain("2 unresolved");
    fireEvent.click(q(comments, "[data-pr-send-all]"));
    await waitFor(() =>
      expect(api.pullRequestSend).toHaveBeenCalledWith(WS, [
        { kind: "reviewComment", id: 7 },
        { kind: "reviewComment", id: 8 },
      ]),
    );
    await waitFor(() => expect(box(container).querySelector("[data-pr-box-row='comments']")).toBeNull());
  });

  it("offers Update from main while behind, the fix on a conflict, and says what holds the merge", async () => {
    const { container, api } = await pane(fact({ checks: [], behindBase: 2 }));
    expect(row(container, "base").textContent).toContain("2 commits behind");
    expect(row(container, "hold").textContent).toBe("Ready to merge");
    fireEvent.click(screen.getByText("Update from main"));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(WS));
    await waitFor(() => expect(useNotices.getState().notices[0]?.text).toBe(updateConflictsLine("api", "main", ["README.md"])));
    act(() => useStore.setState({ statuses: { [WS]: statusWith(fact({ checks: [], behindBase: 2, mergeable: "conflicting" })) } }));
    await waitFor(() => expect(row(container, "base").textContent).toContain("Conflicts"));
    expect(screen.queryByText("Update from main")).toBeNull();
    expect(row(container, "hold").textContent).toBe("Held until the conflicts are fixed");
    fireEvent.click(q(row(container, "base"), "[data-pr-fix-conflicts]"));
    await waitFor(() => expect(api.fix).toHaveBeenCalledWith(WS, undefined));
    act(() => useStore.setState({ statuses: { [WS]: statusWith(fact({ checks: [], behindBase: 0 })) } }));
    await waitFor(() => expect(box(container).querySelector("[data-pr-box-row='base']")).toBeNull());
  });

  it("holds Merge while a check failed, offers the repository's methods with its default first once it can land, and the wait while checks run", async () => {
    const { container, api } = await pane();
    expect(q<HTMLButtonElement>(box(container), "[data-pr-merge]").dataset["held"]).toBe("true");
    expect(row(container, "hold").textContent).toBe("Held until the checks pass");
    act(() => useStore.setState({ statuses: { [WS]: statusWith(fact({ checks: [{ name: "lint", state: "pass" }] })) } }));
    await waitFor(() => expect(q(box(container), "[data-pr-merge]").dataset["held"]).toBeUndefined());
    fireEvent.click(q(box(container), "[data-pr-merge]"));
    const items = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("[data-pr-merge-method]")];
      expect(found).toHaveLength(2);
      return found;
    });
    expect(items.map(i => i.dataset["prMergeMethod"])).toEqual(["squash", "merge"]);
    fireEvent.click(items[1]!);
    await waitFor(() => expect(api.merge).toHaveBeenCalledWith(WS, { method: "merge", head: fact().headOid }));
    act(() => useStore.setState({ statuses: { [WS]: statusWith(fact({ checks: [{ name: "ci", state: "pending" }] })) } }));
    fireEvent.click(await waitFor(() => q(box(container), "[data-pr-merge-when]")));
    await waitFor(() => expect(api.merge).toHaveBeenLastCalledWith(WS, { whenChecksPass: true, head: fact().headOid }));
    act(() => useStore.setState({ statuses: { [WS]: statusWith(fact({ checks: [{ name: "ci", state: "pending" }], autoMerge: { method: "squash", by: "cass" } })) } }));
    await waitFor(() => expect(row(container, "hold").textContent).toBe("Merges by squash when checks pass"));
    expect(box(container).querySelector("[data-pr-merge-when]")).toBeNull();
  });

  it("says a merged pull request merged, by whom and when, the commit it landed as, and links out", async () => {
    const merged: PullRequestKept = { number: 12, url: "https://github.com/o/r/pull/12", state: "merged", base: "main", mergedAt: Date.now() - 4 * 86_400_000, readAt: 1 };
    const { container } = await pane(merged, { ...PAGE, mergedBy: "cass", mergedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(), mergeCommit: "cfa39fab3cfa39fab3" });
    expect(said(row(container, "settled"))).toBe("Merged by cass4 d ago");
    expect(row(container, "landed").textContent).toBe("Landed on main as cfa39fa");
    expect(q<HTMLAnchorElement>(box(container), "[data-pr-open-github]").getAttribute("href")).toBe("https://github.com/o/r/pull/12");
    expect(box(container).querySelector("[data-pr-merge]")).toBeNull();
  });
});

describe("the Commits tab", () => {
  it("lists the commits by day, newest first, a merge marked with the branch it brought and no lines, every other row with its lines", async () => {
    const { container } = await pane();
    fireEvent.click(q(container, "[data-segment='commits']"));
    const rows = [...container.querySelectorAll<HTMLElement>("[data-pr-commit]")];
    expect(rows.map(r => r.dataset["prCommit"])).toEqual(["def5678abc", "abc1234def"]);
    expect(container.querySelectorAll("[data-pr-day]")).toHaveLength(1);
    expect([rows[0]!.dataset["merge"], q(rows[0]!, "[data-pr-commit-from]").textContent, q(rows[0]!, "[data-pr-commit-lines]").textContent]).toEqual(["true", "main", ""]);
    expect(rows[0]!.querySelector("[data-pr-commit-merge]")).not.toBeNull();
    expect([rows[1]!.dataset["merge"], q(rows[1]!, "[data-pr-commit-lines]").textContent, rows[1]!.querySelector("[data-pr-face='cass']") !== null]).toEqual([undefined, "+1,688\u2212117", true]);
    expect(q(rows[1]!, "[role=tooltip] [data-pr-commit-ago]").textContent).toMatch(/ago$/);
    fireEvent.click(q(rows[1]!, "button"));
    expect(q(rows[1]!, "[data-pr-commit-body]").textContent).toBe("Why it moved.");
    expect(container.querySelector("[data-pr-cut]")).toBeNull();
  });

  it("says at the foot where the host read only the first 100 commits", async () => {
    const { container } = await pane(fact(), { ...PAGE, cut: { commits: true } });
    fireEvent.click(q(container, "[data-segment='commits']"));
    const note = q(container, "[data-pr-commits] [data-pr-cut]");
    expect(note.textContent).toBe("Showing the first 100 commits");
    expect(q(container, "[data-pr-commits]").lastElementChild).toBe(note);
  });
});

describe("the Files tab", () => {
  it("opens a file's diff under its row, read once from the host, with its comments on their lines and a road to the Changes pane", async () => {
    const { container, api } = await pane();
    fireEvent.click(q(container, "[data-segment='files']"));
    expect(api.pullRequestDiff).not.toHaveBeenCalled();
    fireEvent.click(q(container, "[data-changed-file='check.sh']"));
    const opened = await waitFor(() => q(container, "[data-pr-file-diff='check.sh'] [data-code-view]"));
    expect(opened.dataset["codeView"]).toBe("check.sh");
    expect(opened.querySelector("[data-pr-file-glyph]")).not.toBeNull();
    expect(codeViews.last!.unsafeCSSExtra).toContain("[data-change-icon] { display: none");
    expect(api.pullRequestDiff).toHaveBeenCalledTimes(1);
    expect(codeViews.last!.lineNotes!.map(n => [n.filePath, n.line, n.side])).toEqual([["check.sh", 3, "additions"]]);
    expect([...opened.querySelectorAll("[data-pr-line-comment]")].map(r => r.getAttribute("data-pr-line-comment"))).toEqual(["7", "8"]);
    fireEvent.click(q(opened, "[data-pr-open-changes]"));
    expect(useDiffStore.getState().scopeByWorkspaceId[WS]).toBe("branch");
    expect(useRightPanelStore.getState().byWorkspaceId[WS]?.activeSurfaceId).toBe("diff");
    fireEvent.click(q(container, "[data-changed-file='check.sh']"));
    expect(container.querySelector("[data-pr-file-diff]")).toBeNull();
    fireEvent.click(q(container, "[data-changed-file='check.sh']"));
    await waitFor(() => q(container, "[data-pr-file-diff='check.sh'] [data-code-view]"));
    expect(api.pullRequestDiff).toHaveBeenCalledTimes(1);
  });

  it("says why where the host cut the diff before the file", async () => {
    const { container, api } = await pane();
    api.pullRequestDiff.mockResolvedValueOnce({ diff: "", truncated: true, left: ["check.sh"] });
    fireEvent.click(q(container, "[data-segment='files']"));
    fireEvent.click(q(container, "[data-changed-file='check.sh']"));
    await waitFor(() => expect(q(container, "[data-pr-file-diff='check.sh']").textContent).toBe("The diff was cut at 2 MB before this file"));
  });
});

describe("a pull request that could not be read", () => {
  it("says why there is nothing to show", () => {
    withApi({ why: "no signed-in command line for github.com is on this computer, so the pull request is not read", readAt: 1 });
    const { container } = render(<PullRequestSurface workspaceId={WS} />);
    expect(container.textContent).toBe("no signed-in command line for github.com is on this computer, so the pull request is not read");
  });
});

describe("the thread header's git button", () => {
  const withGit = (checkout: Partial<Checkout>, pr: WorkspaceStatus["pr"], draft: string | null = "Round the cart once") => {
    const api = {
      ...withApi(pr),
      bringBack: vi.fn(async () => ({ branch: "fix/ci", base: "main", ahead: 1, uncommitted: 0, stat: [], pr: fact() })),
      commitDraft: vi.fn(async () => (draft === null ? { message: null, note: "No agent is signed in to draft it." } : { message: draft })),
      commit: vi.fn(async () => ({ oid: "5f1c0e2b9a7d4c3e8f6a1b2c3d4e5f60718293a4", subject: "Round the cart once", filesChanged: 2, insertions: 3, deletions: 1 })),
    };
    act(() => useStore.setState({ api: api as never, statuses: { [WS]: { ...statusWith(pr), checkout: { branch: "fix/ci", ahead: 0, behind: 0, changed: 0, readAt: 1, ...checkout } } } }));
    return api;
  };
  const quick = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>("[data-git-quick]")!;

  it("names the act the checkout calls for, and View PR opens the Pull request pane", () => {
    withGit({}, fact({ checks: [] }));
    render(<GitSplit workspaceId={WS} />);
    expect(quick().textContent).toBe("View PR");
    fireEvent.click(quick());
    expect(useRightPanelStore.getState().byWorkspaceId[WS]?.activeSurfaceId).toBe("pr");
  });

  it("commits every changed file with the agent's draft, then pushes and opens the pull request", async () => {
    const api = withGit({ changed: 2 }, undefined);
    render(<GitSplit workspaceId={WS} />);
    expect(quick().textContent).toBe("Commit, push and PR");
    fireEvent.click(quick());
    await waitFor(() => expect(api.bringBack).toHaveBeenCalledWith(WS));
    expect(api.commitDraft).toHaveBeenCalledWith(WS);
    expect(api.commit).toHaveBeenCalledWith(WS, "Round the cart once");
  });

  it("opens the Changes pane on the uncommitted files where no draft comes back, and pushes nothing", async () => {
    const api = withGit({ changed: 2 }, undefined, null);
    render(<GitSplit workspaceId={WS} />);
    fireEvent.click(quick());
    await waitFor(() => expect(useRightPanelStore.getState().byWorkspaceId[WS]?.activeSurfaceId).toBe("diff"));
    expect(useDiffStore.getState().scopeByWorkspaceId[WS]).toBe("head");
    expect(api.commit).not.toHaveBeenCalled();
    expect(api.bringBack).not.toHaveBeenCalled();
  });

  it("draws nothing where the checkout is not read", () => {
    withApi(fact());
    expect(render(<GitSplit workspaceId={WS} />).container.innerHTML).toBe("");
  });
});
