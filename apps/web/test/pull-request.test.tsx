// SPDX-License-Identifier: AGPL-3.0-only
// The pull request in the app: the pane's rows off the page the host reads and the fact it pushes, a failed check's
// fix button, a line comment's Send to thread writing the quote into the composer, Merge offered only where the pull
// request can land with a menu of the repository's methods, the conflict's fix, the thread header's git button, and
// the composer's branch line, and Update from the base in the pane while the branch is behind.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixAskedLine, updateConflictsLine, type Checkout, type PullRequestFact, type PullRequestPage, type WorkspaceStatus } from "@wsp/protocol";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useNotices } from "../src/notices/store.js";
import { useStore } from "../src/protocol/store.js";
import { useDiffStore } from "../src/diffs/store.js";
import { GitSplit } from "../src/pull-request/GitSplit.js";
import { PullRequestSurface } from "../src/pull-request/PullRequestSurface.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { resetSurfaces, view, WS } from "./surface-harness.js";

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
    { name: "ci", workflow: "ci", state: "fail", run: { runId: 1, jobId: 2 }, link: "https://github.com/o/r/actions/runs/1/job/2" },
    { name: "lint", workflow: "ci", state: "pass" },
  ],
  additions: 120,
  deletions: 30,
  changedFiles: 9,
  commits: 4,
  behindBase: 1,
  readAt: 1,
  ...over,
});

const PAGE: PullRequestPage = {
  title: "Set .ci-status back to 0",
  body: "The check failed.",
  commits: [{ oid: "abc1234def", subject: "Set ci status", at: "2026-09-28T10:00:00Z" }],
  reviews: [{ author: "ana", state: "changes_requested", body: "see line 3", at: "2026-09-28T11:00:00Z" }],
  comments: [{ author: "bo", body: "thanks", at: "2026-09-28T12:00:00Z" }],
  reviewComments: [{ id: 7, path: "check.sh", line: 3, side: "RIGHT", author: "ana", body: "exit 1 here\nnot 0", url: "https://github.com/o/r/pull/12#discussion_r7", at: "2026-09-28T11:00:00Z" }],
  files: [{ path: "check.sh", additions: 2, deletions: 1 }],
  merge: { methods: ["merge", "squash"], defaultMethod: "squash", autoMerge: true },
};

const statusWith = (pr: WorkspaceStatus["pr"]): WorkspaceStatus =>
  ({ ...view, machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0, ...(pr !== undefined ? { pr } : {}) }) as WorkspaceStatus;

function withApi(pr: WorkspaceStatus["pr"], page: PullRequestPage = PAGE) {
  const api = {
    pullRequestView: vi.fn(async () => page),
    fix: vi.fn(async (_id: string, check?: string) => ({ outcome: "started" as const, threadId: "t1", base: "main", agent: "claude", ...(check !== undefined ? { check } : {}) })),
    merge: vi.fn(async () => ({ number: 12, method: "squash" as const, merged: true, autoArmed: false })),
    update: vi.fn(async () => ({ base: "main", merged: false, commits: 0, conflicts: ["README.md"] })),
  };
  act(() => useStore.setState({ api: api as never, statuses: { [WS]: statusWith(pr) } }));
  return api;
}

beforeEach(() => {
  resetSurfaces();
  useNotices.setState({ notices: [], toasts: [], unread: 0 });
  useComposerDraftStore.setState({ drafts: {} } as never);
});
afterEach(cleanup);

describe("the Pull request pane", () => {
  it("says the title once, the number in its state's ink as the link, the state and the stats as quiet facts, then checks, review, comments and the timeline", async () => {
    const api = withApi(fact());
    const { container } = render(<PullRequestSurface workspaceId={WS} />);
    await waitFor(() => expect(container.querySelector("[data-pr-title]")?.textContent).toBe("Set .ci-status back to 0"));
    expect(api.pullRequestView).toHaveBeenCalledWith(WS);
    const head = container.querySelector<HTMLElement>("[data-pr-head]")!;
    expect(head.textContent!.split("Set .ci-status back to 0")).toHaveLength(2);
    expect(head.textContent!.split("#12")).toHaveLength(2);
    const number = container.querySelector<HTMLAnchorElement>("[data-pr-number]")!;
    expect([number.textContent, number.getAttribute("href"), number.dataset["prState"]]).toEqual(["#12", "https://github.com/o/r/pull/12", "open"]);
    expect(number.className).toContain("text-pr-open");
    expect([...container.querySelectorAll("[data-pr-facts] > span")].map(n => n.textContent)).toEqual(["Checks failed", "+120 -30", "9 files", "4 commits"]);
    const checks = [...container.querySelectorAll<HTMLElement>("[data-pr-check]")];
    // The mark is the state; the word stands only on the failure, which is the row that opens.
    expect(checks.map(c => [c.dataset["prCheck"], c.querySelector("[data-pr-check-state]")?.textContent ?? null, c.querySelector("[data-pr-check-mark]")!.getAttribute("aria-label"), c.dataset["open"] ?? null])).toEqual([
      ["ci", "Failed", null, "true"],
      ["lint", null, "Passed", null],
    ]);
    // Each check wears its mark; only the failure opens, with its fix under it.
    expect(checks.every(c => c.querySelector("[data-pr-check-mark] svg, svg[data-pr-check-mark]") !== null)).toBe(true);
    expect(container.querySelectorAll("[data-pr-fix]")).toHaveLength(1);
    expect(checks[0]!.querySelector("[data-pr-fix]")).not.toBeNull();
    expect(container.querySelector("[data-pr-review]")!.textContent).toContain("Changes requested");
    expect(container.querySelector("[data-pr-comment='7']")!.textContent).toContain("check.sh:3");
    expect([...container.querySelectorAll("[data-pr-event]")].map(n => n.textContent)).toEqual(["abc1234committedSet ci status", "bocommentedthanks"]);
    // No section is ruled off, and no word is a chip.
    expect(container.innerHTML).not.toMatch(/border-b|rounded-full/);
  });

  it("sends a failed check to the agent in one press and says so with the command line's line", async () => {
    const api = withApi(fact());
    const { container } = render(<PullRequestSurface workspaceId={WS} />);
    await waitFor(() => expect(container.querySelector("[data-pr-fix='ci']")).not.toBeNull());
    fireEvent.click(container.querySelector("[data-pr-fix='ci']")!);
    await waitFor(() => expect(api.fix).toHaveBeenCalledWith(WS, "ci"));
    await waitFor(() => expect(useNotices.getState().notices[0]?.text).toBe(fixAskedLine("api", "Claude Code", "ci")));
  });

  it("puts a line comment into the composer for the person to send, under what is already typed, and sends nothing", async () => {
    const api = withApi(fact());
    act(() => useComposerDraftStore.getState().setDraft(WS, { prompt: "look at this", cursor: 12 }));
    const { container } = render(<PullRequestSurface workspaceId={WS} />);
    await waitFor(() => expect(container.querySelector("[data-pr-send='7']")).not.toBeNull());
    fireEvent.click(container.querySelector("[data-pr-send='7']")!);
    expect(useComposerDraftStore.getState().drafts[WS]?.prompt).toBe("look at this\n\nana commented on check.sh:3 in the pull request:\n> exit 1 here\n> not 0\n\n");
    expect(api.fix).not.toHaveBeenCalled();
  });

  it("offers Merge only where it can land, as a menu of the repository's methods with its default first", async () => {
    const api = withApi(fact({ checks: [{ name: "lint", state: "pass" }] }));
    const { container, rerender } = render(<PullRequestSurface workspaceId={WS} />);
    // Until the page says which methods the repository allows, Merge is one button taking its default.
    await waitFor(() => expect(container.querySelector("[data-pr-title]")?.textContent).toBe(PAGE.title));
    await waitFor(() => expect(container.querySelector("[data-pr-merge]")).not.toBeNull());
    fireEvent.click(container.querySelector("[data-pr-merge]")!);
    const items = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("[data-pr-merge-method]")];
      expect(found.length).toBe(2);
      return found;
    });
    expect(items.map(i => i.dataset["prMergeMethod"])).toEqual(["squash", "merge"]);
    fireEvent.click(items[1]!);
    await waitFor(() => expect(api.merge).toHaveBeenCalledWith(WS, { method: "merge", head: fact().headOid }));
    // A failed check or a conflict offers no merge; running checks offer the wait where the repository merges by itself.
    act(() => useStore.setState({ statuses: { [WS]: statusWith(fact()) } }));
    rerender(<PullRequestSurface workspaceId={WS} />);
    await waitFor(() => expect(container.querySelector("[data-pr-merge]")).toBeNull());
    act(() => useStore.setState({ statuses: { [WS]: statusWith(fact({ checks: [{ name: "ci", state: "pending" }] })) } }));
    await waitFor(() => expect(container.querySelector("[data-pr-merge-when]")).not.toBeNull());
    expect(container.querySelector("[data-pr-merge]")).toBeNull();
    fireEvent.click(container.querySelector("[data-pr-merge-when]")!);
    await waitFor(() => expect(api.merge).toHaveBeenLastCalledWith(WS, { whenChecksPass: true, head: fact().headOid }));
  });

  it("offers one Merge where the repository allows one method, and the fix for a conflict with the base", async () => {
    const api = withApi(fact({ mergeable: "conflicting", checks: [] }), { ...PAGE, merge: { methods: ["squash"], defaultMethod: "squash", autoMerge: false } });
    const { container } = render(<PullRequestSurface workspaceId={WS} />);
    await waitFor(() => expect(container.querySelector("[data-pr-title]")?.textContent).toBe(PAGE.title));
    await waitFor(() => expect(container.querySelector("[data-pr-fix-conflicts]")).not.toBeNull());
    expect(container.querySelector("[data-pr-word]")!.textContent).toBe("Conflicts with main");
    expect(container.querySelector("[data-pr-merge]")).toBeNull();
    fireEvent.click(container.querySelector("[data-pr-fix-conflicts]")!);
    await waitFor(() => expect(api.fix).toHaveBeenCalledWith(WS, undefined));
    act(() => useStore.setState({ statuses: { [WS]: statusWith(fact({ checks: [] })) } }));
    await waitFor(() => expect(container.querySelector("[data-pr-merge]")).not.toBeNull());
    fireEvent.click(container.querySelector("[data-pr-merge]")!);
    await waitFor(() => expect(api.merge).toHaveBeenCalledWith(WS, { head: fact().headOid }));
    expect(document.querySelector("[data-pr-merge-method]")).toBeNull();
  });

  it("says why there is nothing to show where the pull request could not be read", () => {
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

describe("Update from the base in the Pull request pane", () => {
  it("is offered only while the branch is behind its base, and names the files that conflict with the fix beside them", async () => {
    const api = withApi(fact({ checks: [], behindBase: 2 }));
    render(<PullRequestSurface workspaceId={WS} />);
    fireEvent.click(await screen.findByText("Update from main"));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(WS));
    await waitFor(() => expect(useNotices.getState().notices[0]?.text).toBe(updateConflictsLine("api", "main", ["README.md"])));
    const notice = useNotices.getState().notices[0]!;
    expect(notice.action?.word).toBe("Ask your agent to fix");
    notice.action!.run();
    await waitFor(() => expect(api.fix).toHaveBeenCalledWith(WS, undefined));
    act(() => useStore.setState({ statuses: { [WS]: statusWith(fact({ checks: [], behindBase: 0 })) } }));
    await waitFor(() => expect(screen.queryByText("Update from main")).toBeNull());
    // A conflict with the base is the fix's, which tries the same update first.
    act(() => useStore.setState({ statuses: { [WS]: statusWith(fact({ checks: [], behindBase: 2, mergeable: "conflicting" })) } }));
    await waitFor(() => expect(document.querySelector("[data-pr-fix-conflicts]")).not.toBeNull());
    expect(screen.queryByText("Update from main")).toBeNull();
  });
});
