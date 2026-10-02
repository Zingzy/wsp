// SPDX-License-Identifier: AGPL-3.0-only
// The Commits tab's rows: grouped by the local day, the newest first, a merge commit marked with the branch it brought
// in as git writes "Merge branch 'main' into" and the landings here write "merge: origin/main into".
import type { PullRequestPage } from "@wsp/protocol";
import { daysBack } from "../lib/timestampFormat.js";

type Commit = PullRequestPage["commits"][number];

export interface CommitRow {
  readonly oid: string;
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly at: string;
  readonly merge: boolean;
  /** The branch a merge brought in, where its subject names one. */
  readonly from?: string;
  /** The lines it changed, where the host counted them; a merge's are the base's and stay off the row. */
  readonly lines?: { readonly additions: number; readonly deletions: number };
  readonly body: string;
}

const MERGE_SUBJECTS: readonly RegExp[] = [
  /^Merge (?:remote-tracking )?branch '([^']+)'/,
  /^merge:? (\S+) into /i,
  /^Merge pull request #\d+ from /,
];

/** A merge commit read off its subject, with the branch it brought in where the subject names one; null for a commit
 * that is not a merge. */
export function mergeFrom(subject: string): { from?: string } | null {
  for (const re of MERGE_SUBJECTS) {
    const hit = re.exec(subject);
    if (hit === null) continue;
    const branch = hit[1]?.replace(/^origin\//, "");
    return branch === undefined ? {} : { from: branch };
  }
  return null;
}

/** Whether a commit is a merge: two parents where the host counted them, else what its subject says. */
export function isMergeCommit(c: Pick<Commit, "subject" | "parents">): boolean {
  return c.parents !== undefined ? c.parents >= 2 : mergeFrom(c.subject) !== null;
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function dayWord(at: Date, nowMs: number): string {
  const back = daysBack(at, nowMs);
  return back === 0 ? "Today" : back === 1 ? "Yesterday" : DAY.format(at);
}

function rowOf(c: Commit): CommitRow {
  const merge = isMergeCommit(c);
  const from = merge ? mergeFrom(c.subject)?.from : undefined;
  const lines = !merge && c.additions !== undefined && c.deletions !== undefined ? { additions: c.additions, deletions: c.deletions } : undefined;
  return { oid: c.oid, sha: c.oid.slice(0, 7), subject: c.subject, author: c.author, at: c.at, merge, body: c.body, ...(from !== undefined ? { from } : {}), ...(lines !== undefined ? { lines } : {}) };
}

export function commitDays(commits: readonly Commit[], nowMs: number = Date.now()): { day: string; rows: CommitRow[] }[] {
  const newest = commits.map((c, i) => ({ c, i })).sort((a, b) => Date.parse(b.c.at) - Date.parse(a.c.at) || b.i - a.i).map(o => o.c);
  const days: { day: string; rows: CommitRow[] }[] = [];
  for (const c of newest) {
    const day = dayWord(new Date(c.at), nowMs);
    const last = days.at(-1);
    if (last?.day === day) last.rows.push(rowOf(c));
    else days.push({ day, rows: [rowOf(c)] });
  }
  return days;
}
