// SPDX-License-Identifier: AGPL-3.0-only
// Starting and reviewing in the app: the project home's send becomes Start on #n when the composer holds an issue or a
// pull request link, a pull request's link adds Review #n beside it, a link no project here holds is refused under the
// box; the Pull request pane's head names where a workspace came from and offers Review with an agent; a review
// workspace's pane draws its draft: the verdict, the summary, one ticked row per comment, the notes, and one Post.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, START_WORDS, type PullRequestFact, type PullRequestPage, type ProjectView, type ReviewDraft, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerOptionsStore } from "../src/components/chat/composerOptionsStore.js";
import { useNotices } from "../src/notices/store.js";
import { projectHomeKey, useStore } from "../src/protocol/store.js";
import { PullRequestSurface } from "../src/pull-request/PullRequestSurface.js";
import { ProjectHome } from "../src/shell/ProjectHome.js";
import { resetSurfaces, view, WS } from "./surface-harness.js";
import { installFakeLayout } from "./fake-layout.js";
import { TABLE_CATALOG } from "./agents.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const HEAD = "ec5c10de663bd1860925ad42e9580bab4eb1d377";
const fact = (over: Partial<PullRequestFact> = {}): PullRequestFact => ({
  number: 7,
  url: "https://github.com/wsp/lab/pull/7",
  state: "open",
  host: "github.com",
  draft: false,
  base: "main",
  branch: "lab/review-me",
  headOid: HEAD,
  headSubject: "Rename the status word",
  mergeable: "mergeable",
  mergeState: "clean",
  review: "none",
  checks: [],
  additions: 2,
  deletions: 1,
  changedFiles: 2,
  commits: 1,
  readAt: 1,
  ...over,
});
const PAGE: PullRequestPage = { title: "Rename the status word", body: "", author: "", updatedAt: "", commits: [], reviews: [], comments: [], reviewComments: [], files: [] };

const DRAFT: ReviewDraft = {
  verdict: "request_changes",
  summary: "One wrong word and an unused variable.",
  comments: [
    { id: "c1", path: "check.sh", line: 4, side: "RIGHT", body: "unused is never read.", on: true },
    { id: "c2", path: "status.txt", line: 1, side: "RIGHT", body: "The old word was right.", on: true },
    { id: "c3", path: "README.md", line: 40, side: "RIGHT", body: "This line is not in the diff.", on: true, inSummary: true },
  ],
  headOid: HEAD,
  threadId: "thr_r",
  at: 1,
};

const statusWith = (pr: WorkspaceStatus["pr"]): WorkspaceStatus =>
  ({ ...view, machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0, ...(pr !== undefined ? { pr } : {}) }) as WorkspaceStatus;

function pane(o: { from?: WorkspaceView["from"]; review?: ReviewDraft; pr?: PullRequestFact } = {}) {
  const api = {
    pullRequestView: vi.fn(async () => PAGE),
    reviewDraft: vi.fn(async (_id: string, edits?: Record<string, unknown>) => ({ review: edits === undefined ? o.review : { ...o.review, ...edits } })),
    reviewPost: vi.fn(async () => ({ url: "https://github.com/wsp/lab/pull/7#pullrequestreview-1", number: 7, comments: 1, folded: 1 })),
    review: vi.fn(async () => ({ workspace: { ...view, id: "ws_review", name: "Review #7 Rename the status word" }, threadId: "thr_new", sessionId: "s1" })),
  };
  act(() =>
    useStore.setState({
      api: api as never,
      workspaces: [{ ...view, ...(o.from !== undefined ? { from: o.from } : {}) }],
      statuses: { [WS]: statusWith(o.pr ?? fact()) },
      reviews: o.review === undefined ? {} : { [WS]: o.review },
    } as never),
  );
  return api;
}

beforeEach(() => {
  resetSurfaces();
  useNotices.setState({ notices: [], toasts: [], unread: 0 });
});
afterEach(cleanup);

describe("the Pull request pane's head", () => {
  it("names the issue a workspace started from as a link, and offers Review with an agent on every pull request", async () => {
    const api = pane({ from: { kind: "issue", repo: "wsp/lab", number: 12, url: "https://github.com/wsp/lab/issues/12", title: "Add a greeting" } });
    const { container } = render(<PullRequestSurface workspaceId={WS} />);
    const from = await waitFor(() => container.querySelector<HTMLAnchorElement>("[data-pr-from]")!);
    expect(from.textContent).toBe(START_WORDS.fromIssue(12, "Add a greeting"));
    expect(from.getAttribute("href")).toBe("https://github.com/wsp/lab/issues/12");
    fireEvent.click(screen.getByRole("button", { name: START_WORDS.reviewWithAgent }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: "Codex" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(api.review).toHaveBeenCalledWith({ workspaceId: WS, agent: "codex" }));
    await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_review"));
  });
});

describe("a review workspace's draft", () => {
  const reviewFrom = { kind: "review" as const, repo: "wsp/lab", number: 7, url: "https://github.com/wsp/lab/pull/7", title: "Rename the status word", base: "main", head: { branch: "lab/review-me", oid: HEAD } };

  it("draws the verdict picked, the summary, one ticked row per comment with its place in mono, and the comment outside the diff noted", async () => {
    pane({ from: reviewFrom, review: DRAFT });
    const { container } = render(<PullRequestSurface workspaceId={WS} />);
    const section = await waitFor(() => container.querySelector<HTMLElement>("[data-pr-draft]")!);
    const draftAt = [...container.querySelectorAll("[data-pr-section]")].map(s => s.getAttribute("data-pr-section"));
    expect(draftAt[0]).toBe("draft review");
    expect(within(section).getByRole("radio", { name: "Request changes" }).getAttribute("aria-checked")).toBe("true");
    expect((within(section).getByRole("textbox", { name: "Summary" }) as HTMLTextAreaElement).value).toBe(DRAFT.summary);
    const rows = [...section.querySelectorAll<HTMLElement>("[data-pr-draft-comment]")];
    expect(rows.map(r => r.querySelector(".font-mono")!.textContent)).toEqual(["check.sh:4", "status.txt:1", "README.md:40"]);
    expect(rows.map(r => (r.querySelector("[role=checkbox]") as HTMLElement).getAttribute("aria-checked"))).toEqual(["true", "true", "true"]);
    expect(rows[2]!.textContent).toContain(START_WORDS.toSummary);
    expect(within(section).getByRole("button", { name: START_WORDS.post })).not.toHaveProperty("disabled", true);
  });

  it("saves a tick and a verdict to the host, holds Post while nothing is ticked and no summary stands, and posts on the press", async () => {
    const api = pane({ from: reviewFrom, review: DRAFT });
    const { container } = render(<PullRequestSurface workspaceId={WS} />);
    const section = await waitFor(() => container.querySelector<HTMLElement>("[data-pr-draft]")!);
    fireEvent.click(section.querySelector("[data-pr-draft-comment='c2'] [role=checkbox]")!);
    await waitFor(() => expect(api.reviewDraft).toHaveBeenCalledWith(WS, { on: [{ id: "c2", on: false }] }));
    fireEvent.click(within(section).getByRole("radio", { name: "Comment" }));
    await waitFor(() => expect(api.reviewDraft).toHaveBeenCalledWith(WS, { verdict: "comment" }));
    fireEvent.click(within(section).getByRole("button", { name: START_WORDS.post }));
    await waitFor(() => expect(api.reviewPost).toHaveBeenCalledWith(WS));

    cleanup();
    pane({ from: reviewFrom, review: { ...DRAFT, summary: "", comments: DRAFT.comments.map(c => ({ ...c, on: false })) } });
    const again = render(<PullRequestSurface workspaceId={WS} />);
    const held = await waitFor(() => again.container.querySelector<HTMLElement>("[data-pr-draft]")!);
    expect((within(held).getByRole("button", { name: START_WORDS.post }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says the pull request moved on since the review, and says the reviewer is still working while no draft has come", async () => {
    pane({ from: reviewFrom, review: DRAFT, pr: fact({ headOid: "0".repeat(40) }) });
    const { container } = render(<PullRequestSurface workspaceId={WS} />);
    await waitFor(() => expect(container.querySelector("[data-pr-draft]")!.textContent).toContain(START_WORDS.movedOn));
    cleanup();
    pane({ from: reviewFrom });
    const waiting = render(<PullRequestSurface workspaceId={WS} />);
    await waitFor(() => expect(waiting.container.querySelector("[data-pr-draft]")!.textContent).toContain(START_WORDS.stillWorking));
  });

  it("reads Posted with the link once posted, and the count that went into the summary", async () => {
    pane({ from: reviewFrom, review: { ...DRAFT, posted: { url: "https://github.com/wsp/lab/pull/7#pullrequestreview-1", at: Date.now() - 60_000, folded: ["c3"] } } });
    const { container } = render(<PullRequestSurface workspaceId={WS} />);
    const posted = await waitFor(() => container.querySelector<HTMLAnchorElement>("[data-pr-draft-posted]")!);
    expect(posted.getAttribute("href")).toBe("https://github.com/wsp/lab/pull/7#pullrequestreview-1");
    expect(posted.textContent).toMatch(/^Posted /);
    expect(container.querySelector("[data-pr-draft]")!.textContent).toContain("1 went into the summary");
  });
});

const PROJECT: ProjectView = { id: "pr_lab", name: "lab", computer: "here", source: { kind: "folder", path: "/root/lab" }, path: "/root/lab", remote: "git@github.com:wsp/lab.git", defaultBranch: "main", memoryKey: "-root-lab", memoryDir: "/root/.claude-cfg/projects/-root-lab/memory", createdAt: "t" };
const HOME = projectHomeKey(PROJECT.id);

describe("the project home with a link in the composer", () => {
  let restore: () => void = () => {};
  beforeAll(() => {
    restore = installFakeLayout();
  });
  afterAll(() => restore());

  function home() {
    const api = {
      preferences: async () => DEFAULT_PREFERENCES,
      listHarnesses: async () => [TABLE_CATALOG],
      portReach: async (_id: string, port: number) => ({ url: `https://m1-${port}.preview.example/`, expiresAt: Date.now() + 3_600_000 }),
      daemon: noDaemonApi,
      sessionHistory: async () => [],
      listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
      snapshotStorage: async () => null,
      listWorkspaces: async () => [],
      listSessions: async () => [],
      watchStatuses: async () => [],
      subscribe: () => () => {},
      getGolden: async () => undefined,
      capabilities: async () => caps(),
      start: vi.fn(async () => ({ workspace: { ...view, id: "ws_started", name: "#5 Add a greeting" }, threadId: "thr_started", sessionId: "s1" })),
      review: vi.fn(async () => ({ workspace: { ...view, id: "ws_review", name: "Review #7 Rename" }, threadId: "thr_review", sessionId: "s2" })),
    };
    useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} } as never);
    useComposerOptionsStore.setState({ byWorkspaceId: {}, pickedOn: {} });
    act(() => useStore.setState({ api: api as never, conn: "live", projects: [PROJECT], harnesses: [TABLE_CATALOG], harnessesByWorkspace: { [HOME]: [TABLE_CATALOG] }, preferences: DEFAULT_PREFERENCES }));
    render(<ProjectHome projectId={PROJECT.id} />);
    return api;
  }

  /** The composer's text as the person typed it: the draft its buttons read. */
  const say = (text: string) => act(() => useComposerDraftStore.getState().setDraft(HOME, { prompt: text, cursor: text.length }));

  it("reads Start on #n for an issue link, adds Review #n for a pull request's, and reads as it always did for plain text", async () => {
    home();
    say("https://github.com/wsp/lab/issues/5");
    await waitFor(() => expect(screen.getByRole("button", { name: START_WORDS.startOn(5) })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^Review #/ })).toBeNull();
    say("https://github.com/wsp/lab/pull/7");
    await waitFor(() => expect(screen.getByRole("button", { name: START_WORDS.review(7) })).toBeTruthy());
    expect(screen.getByRole("button", { name: START_WORDS.startOn(7) })).toBeTruthy();
    say("fix the flaky login test");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Start on #/ })).toBeNull());
  });

  it("starts on the link through the host with the composer's picks and opens the thread it made", async () => {
    const api = home();
    say("https://github.com/wsp/lab/issues/5");
    fireEvent.click(await screen.findByRole("button", { name: START_WORDS.startOn(5) }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ url: "https://github.com/wsp/lab/issues/5" })));
    await waitFor(() => expect(useStore.getState()).toMatchObject({ selectedId: "ws_started", selectedThreadId: "thr_started" }));
  });

  it("says under the box that no project here is a checkout of a link's repository, and offers no Start", async () => {
    home();
    say("https://github.com/someone/else/issues/1");
    await waitFor(() => expect(screen.getByText(START_WORDS.noProjectForRepo("someone/else"))).toBeTruthy());
    expect(screen.queryByRole("button", { name: START_WORDS.startOn(1) })).toBeNull();
  });
});
