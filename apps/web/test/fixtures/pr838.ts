// SPDX-License-Identifier: AGPL-3.0-only
// PR 838 as the host's page reads it, off what gh answered for it on 2026-10-02, with PR 875's cold review on its
// lines, the one real review with line comments; and the fact the pane's head reads, set to the states the locked
// mockup draws (open, one check failed, one running, two commits behind) since 838 itself has closed.
import type { PullRequestFact, PullRequestKept, PullRequestPage } from "@wsp/protocol";
import viewJson from "./pr838/pr838.json?raw";
import linesJson from "./pr838/pr875-line-comments.json?raw";
import sidebarDiff from "./pr838/sidebar-logic.diff?raw";
import graphqlJson from "./pr838/pr838-graphql.json?raw";

/** What of gh's answers the page reads. */
interface GhView {
  number: number;
  title: string;
  author: { login: string };
  createdAt: string;
  updatedAt: string;
  closedAt: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: { oid: string; messageHeadline: string; messageBody: string; committedDate: string; authors: { login: string }[] }[];
  comments: { id: string; author: { login: string }; body: string; createdAt: string; url: string }[];
  files: { path: string; additions: number; deletions: number }[];
  statusCheckRollup: { name: string; workflowName: string; detailsUrl: string; startedAt: string; completedAt: string }[];
}
interface GhLineComment {
  id: number;
  path: string;
  line: number | null;
  side: string;
  node_id: string;
  user: { login: string; type: string; avatar_url: string };
  body: string;
  html_url: string;
  created_at: string;
  diff_hunk: string;
  in_reply_to_id?: number;
  pull_request_review_id: number;
}
interface GhCommits {
  data: { repository: { pullRequest: { commits: { nodes: { commit: { abbreviatedOid: string; additions: number; deletions: number; parents: { totalCount: number } } }[] } } } };
}
const view = JSON.parse(viewJson) as GhView;
const lines = JSON.parse(linesJson) as GhLineComment[];
const counted = new Map((JSON.parse(graphqlJson) as GhCommits).data.repository.pullRequest.commits.nodes.map(n => [n.commit.abbreviatedOid, n.commit]));

export const PR838_DIFF: string = sidebarDiff;

export const PR838_PAGE: PullRequestPage = {
  title: view.title,
  body: "A finished turn nobody had opened looked the same as one that was read, and a thread only left the list after 24 hours. The host now keeps a read and a settled stamp per thread, so every window and wsp threads agree on Done.\n\nA read thread settles after 2 hours quiet, Settle takes a tree by hand, and new activity brings it back. The sidebar list drops its scroll fade, which made a tile part way under the head look broken.\n\nCloses Zingzy/wsp-map#1398 and #1406.",
  author: view.author.login,
  createdAt: view.createdAt,
  updatedAt: view.updatedAt,
  labels: [],
  reviewRequests: [],
  latestReviews: [],
  assignees: [],
  commits: view.commits.map(c => {
    const n = counted.get(c.oid.slice(0, 7));
    return { oid: c.oid, subject: c.messageHeadline, body: c.messageBody, at: c.committedDate, author: c.authors[0]?.login ?? "", ...(n === undefined ? {} : { parents: n.parents.totalCount, additions: n.additions, deletions: n.deletions }) };
  }),
  reviews: [],
  comments: view.comments.map((c, i) => ({ id: i + 1, nodeId: c.id, author: c.author.login, bot: false, body: c.body, url: c.url, at: c.createdAt })),
  reviewComments: lines.map(c => ({
    id: c.id,
    path: c.path,
    ...(c.line !== null ? { line: c.line } : {}),
    side: c.side,
    author: c.user.login,
    bot: c.user.type === "Bot",
    avatar: c.user.avatar_url,
    body: c.body,
    url: c.html_url,
    at: c.created_at,
    hunk: c.diff_hunk,
    ...(c.in_reply_to_id !== undefined ? { replyTo: c.in_reply_to_id } : {}),
    reviewId: c.pull_request_review_id,
    resolved: false,
    nodeId: c.node_id,
    threadId: `thread-of-${c.in_reply_to_id ?? c.id}`,
  })),
  files: view.files.map(f => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
  merge: { methods: ["squash", "merge"], defaultMethod: "squash", autoMerge: true },
  sent: [],
};

const checkOf = (c: (typeof view.statusCheckRollup)[number]): PullRequestFact["checks"][number] => {
  const state = c.name === "Install, build, test, types" ? "fail" : c.name === "Stage the desktop app" ? "pending" : "pass";
  return { name: c.name, workflow: c.workflowName, state, link: c.detailsUrl, startedAt: c.startedAt, ...(state === "pending" ? {} : { completedAt: c.completedAt }) };
};

export const PR838_FACT: PullRequestFact = {
  number: view.number,
  url: "https://github.com/Zingzy/wsp/pull/838",
  state: "open",
  host: "github.com",
  draft: view.isDraft,
  base: view.baseRefName,
  branch: view.headRefName,
  headOid: view.commits.at(-1)!.oid,
  headSubject: view.commits.at(-1)!.messageHeadline,
  mergeable: "mergeable",
  mergeState: "blocked",
  review: "none",
  checks: view.statusCheckRollup.map(checkOf),
  additions: view.additions,
  deletions: view.deletions,
  changedFiles: view.changedFiles,
  commits: view.commits.length,
  behindBase: 2,
  author: view.author.login,
  readAt: Date.parse("2026-10-02T11:00:00Z"),
};

/** The fact with its running check started four minutes before the moment given. */
export function pr838FactLately(nowMs: number): PullRequestFact {
  return { ...PR838_FACT, checks: PR838_FACT.checks.map(c => (c.state === "pending" ? { ...c, startedAt: new Date(nowMs - 4 * 60_000).toISOString() } : c)) };
}

/** PR 838 as it stands: closed without a merge, its checks kept from the read that saw it close. */
export const PR838_CLOSED: PullRequestKept = {
  number: view.number,
  url: "https://github.com/Zingzy/wsp/pull/838",
  state: "closed",
  base: view.baseRefName,
  closedAt: Date.parse(view.closedAt),
  readAt: Date.parse(view.closedAt),
  checks: view.statusCheckRollup.map(c => ({ name: c.name, workflow: c.workflowName, state: "pass" as const, link: c.detailsUrl, startedAt: c.startedAt, completedAt: c.completedAt })),
};

/** The same pull request once merged, as the record keeps a settled one. */
export const PR838_MERGED: PullRequestKept = { number: view.number, url: PR838_FACT.url, state: "merged", base: view.baseRefName, mergedAt: Date.parse(view.closedAt), readAt: PR838_FACT.readAt, ...(PR838_CLOSED.checks !== undefined ? { checks: PR838_CLOSED.checks } : {}) };

/** The page moved in time so its last comment lands forty minutes before the moment given, as the mockup reads it. */
export function pr838Lately(nowMs: number): PullRequestPage {
  const last = Math.max(...PR838_PAGE.comments.map(c => Date.parse(c.at)));
  const by = nowMs - 40 * 60_000 - last;
  const at = (iso: string): string => new Date(Date.parse(iso) + by).toISOString();
  return {
    ...PR838_PAGE,
    createdAt: at(PR838_PAGE.createdAt),
    updatedAt: at(PR838_PAGE.updatedAt),
    commits: PR838_PAGE.commits.map(c => ({ ...c, at: at(c.at) })),
    comments: PR838_PAGE.comments.map(c => ({ ...c, at: at(c.at) })),
    reviewComments: PR838_PAGE.reviewComments.map(c => ({ ...c, at: new Date(Date.parse(PR838_PAGE.comments[0]!.at) + by + 30 * 60_000).toISOString() })),
  };
}
