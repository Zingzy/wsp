// SPDX-License-Identifier: AGPL-3.0-only
// The Conversation tab's one timeline, read off the page in time order: comments, reviews with the threads they left
// on lines, a thread no review holds on its own, and the commits pushed between two of those folded into one row.
// What the merge box's Comments row counts and sends is read here too, so the row and the timeline agree.
import type { PullRequestItem, PullRequestPage } from "@wsp/protocol";

type Page = PullRequestPage;
export type PageComment = Page["comments"][number];
export type PageReview = Page["reviews"][number];
export type LineComment = Page["reviewComments"][number];
export type PageCommit = Page["commits"][number];

/** A thread on a line: its first comment and the replies to it, oldest first. */
export interface ReviewThread {
  readonly key: string;
  readonly path: string;
  readonly line?: number;
  readonly hunk?: string;
  readonly resolved: boolean;
  /** The thread's node id, which resolving names; absent on a thread past the newest the host read. */
  readonly threadId?: string;
  readonly reviewId?: number;
  readonly comments: readonly LineComment[];
}

export type TimelineEntry =
  | { readonly kind: "comment"; readonly key: string; readonly at: string; readonly comment: PageComment }
  | { readonly kind: "review"; readonly key: string; readonly at: string; readonly review: PageReview; readonly threads: readonly ReviewThread[] }
  | { readonly kind: "thread"; readonly key: string; readonly at: string; readonly thread: ReviewThread }
  | { readonly kind: "push"; readonly key: string; readonly at: string; readonly commits: readonly PageCommit[]; readonly authors: readonly string[] };

export type Tone = "ok" | "bad" | "warn" | "run" | "merged" | "quiet";

const VERDICTS: Record<string, { word: string; tone: Tone }> = {
  changes_requested: { word: "Changes asked for", tone: "warn" },
  approved: { word: "Approved", tone: "ok" },
  commented: { word: "Commented", tone: "quiet" },
  dismissed: { word: "Dismissed", tone: "quiet" },
  pending: { word: "Pending", tone: "quiet" },
};

/** A review's state as its head says it, in the ink the pull request's own word takes for the same verdict. */
export function reviewVerdict(state: string): { word: string; tone: Tone } {
  return VERDICTS[state.toLowerCase()] ?? { word: state.toLowerCase().replace(/_/g, " ").replace(/^./, c => c.toUpperCase()), tone: "quiet" };
}

/** The reviews the timeline draws: GitHub opens an empty commented review for every reply on a line, which holds no
 * thread of its own and says nothing, so it is left out; an approval or an ask for changes stands with no words. */
function reviewsSaid(page: Pick<Page, "reviews" | "reviewComments">, threads: readonly ReviewThread[] = threadsOf(page.reviewComments)): PageReview[] {
  return page.reviews.filter(r => r.state.toLowerCase() !== "commented" || r.body.trim() !== "" || threads.some(t => t.reviewId !== undefined && t.reviewId === r.id));
}

/** What the Conversation tab counts: every comment and every review it draws. */
export function conversationCount(page: Pick<Page, "comments" | "reviews" | "reviewComments">): number {
  return page.comments.length + reviewsSaid(page).length;
}

const byTime = <T extends { at: string }>(a: T, b: T): number => Date.parse(a.at) - Date.parse(b.at);

/** The comments on a page's lines as threads, a reply under the comment it answers: the timeline and the diff draw
 * the same threads. */
export function threadsOf(comments: readonly LineComment[]): ReviewThread[] {
  const roots = new Map<number, LineComment[]>();
  for (const c of [...comments].sort((a, b) => byTime(a, b) || a.id - b.id)) {
    const root = c.replyTo !== undefined && roots.has(c.replyTo) ? c.replyTo : c.id;
    const held = roots.get(root);
    if (held === undefined) roots.set(root, [c]);
    else held.push(c);
  }
  return [...roots.entries()].map(([id, held]) => {
    const first = held[0]!;
    const threadId = held.find(c => c.threadId !== undefined)?.threadId;
    return {
      key: `thread:${id}`,
      path: first.path,
      ...(first.line !== undefined ? { line: first.line } : {}),
      ...(first.hunk !== undefined ? { hunk: first.hunk } : {}),
      resolved: held.some(c => c.resolved === true),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(first.reviewId !== undefined ? { reviewId: first.reviewId } : {}),
      comments: held,
    };
  });
}

/** The timeline, oldest first; where two entries share a moment the page's own order holds, reviews before comments. */
export function conversationOf(page: Page): TimelineEntry[] {
  const threads = threadsOf(page.reviewComments);
  const reviewIds = new Set(page.reviews.flatMap(r => (r.id === undefined ? [] : [r.id])));
  const said: Exclude<TimelineEntry, { kind: "push" }>[] = [
    ...reviewsSaid(page, threads).map((review, i) => ({ kind: "review" as const, key: `review:${review.id ?? i}`, at: review.at, review, threads: threads.filter(t => t.reviewId !== undefined && t.reviewId === review.id) })),
    ...page.comments.map(comment => ({ kind: "comment" as const, key: `comment:${comment.id}`, at: comment.at, comment })),
    ...threads.filter(t => t.reviewId === undefined || !reviewIds.has(t.reviewId)).map(thread => ({ kind: "thread" as const, key: thread.key, at: thread.comments[0]!.at, thread })),
  ];
  const ordered = said.map((entry, i) => ({ entry, i })).sort((a, b) => byTime(a.entry, b.entry) || a.i - b.i).map(o => o.entry);
  const commits = page.commits.map((c, i) => ({ c, i })).sort((a, b) => byTime(a.c, b.c) || a.i - b.i).map(o => o.c);
  const out: TimelineEntry[] = [];
  let next = 0;
  const pushUntil = (until: number): void => {
    const run: PageCommit[] = [];
    while (next < commits.length && Date.parse(commits[next]!.at) <= until) run.push(commits[next++]!);
    if (run.length === 0) return;
    out.push({ kind: "push", key: `push:${run[0]!.oid}`, at: run.at(-1)!.at, commits: run, authors: [...new Set(run.map(c => c.author))] });
  };
  for (const entry of ordered) {
    pushUntil(Date.parse(entry.at));
    out.push(entry);
  }
  pushUntil(Number.POSITIVE_INFINITY);
  return out;
}

/** One line of a hunk as a thread draws it: its number on the old side and the new, and whether it was taken out,
 * put in or stands. */
export interface HunkLine {
  readonly old?: number;
  readonly new?: number;
  readonly kind: "add" | "del" | "ctx";
  readonly text: string;
}

/** The last lines of a comment's hunk, down to the commented one, numbered off the hunk's header. */
export function hunkTail(hunk: string, count = 3): HunkLine[] {
  const [head, ...body] = hunk.split("\n");
  const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(head ?? "");
  if (at === null) return [];
  let old = Number(at[1]);
  let now = Number(at[2]);
  const lines: HunkLine[] = [];
  for (const raw of body) {
    if (raw.startsWith("\\")) continue;
    const mark = raw[0];
    const text = raw.slice(1);
    if (mark === "+") lines.push({ new: now++, kind: "add", text });
    else if (mark === "-") lines.push({ old: old++, kind: "del", text });
    else lines.push({ old: old++, new: now++, kind: "ctx", text });
  }
  return lines.slice(-count);
}

/** When an item was sent to the agent, where it was. */
export function sentAt(page: Pick<Page, "sent">, item: PullRequestItem): number | undefined {
  return page.sent.find(s => s.kind === item.kind && s.id === item.id)?.at;
}

/** What the Comments row sends: every comment a person left on a line whose thread is not resolved and which was not
 * sent yet; and the word it counts them by, "unresolved" once the host reads which threads are. */
export function openComments(page: Pick<Page, "reviewComments" | "sent">): { items: PullRequestItem[]; word: "unresolved" | "unsent" } {
  const threads = threadsOf(page.reviewComments);
  const items = threads.filter(t => !t.resolved).flatMap(t => t.comments.filter(c => !c.bot && sentAt(page, { kind: "reviewComment", id: c.id }) === undefined).map(c => ({ kind: "reviewComment" as const, id: c.id })));
  return { items, word: page.reviewComments.some(c => c.resolved !== undefined) ? "unresolved" : "unsent" };
}
