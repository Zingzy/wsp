// SPDX-License-Identifier: AGPL-3.0-only
// The tree of branches: a lead's children, each on a branch of its own cut from the lead's, read as the lead's
// status carries them; what a child's record keeps of its landing; the replies of the three git frames the tree
// takes; and every word the lead's rows, the fork and the merge say.
import { z } from "zod";

const text = z.string();
const count = z.number().int().nonnegative();

/** The branch a copy was put on as the remote holds it, and the commit it now stands at. */
export const GitStartOnReply = z.object({ branch: text, oid: text });
export type GitStartOnReply = z.infer<typeof GitStartOnReply>;

/** How far a head is from a base on the git host: not pushed where the host lacks the head, else the commits each
 * has that the other lacks and the host's word for the two. */
export const GitBranchCompareReply = z.object({ pushed: z.boolean(), aheadBy: count.optional(), behindBy: count.optional(), status: text.optional() });
export type GitBranchCompareReply = z.infer<typeof GitBranchCompareReply>;

/** Merged with the commits it brought, the commit it left and the child's commit it took, or nothing merged and the
 * files that conflict. */
export const GitMergeInReply = z.object({ branch: text, merged: z.boolean(), commits: count, oid: text.optional(), head: text.optional(), conflicts: z.array(text) });
export type GitMergeInReply = z.infer<typeof GitMergeInReply>;

/** What a child's record keeps of the tree: its merge into the lead with the child's commit it took, the files a
 * merge stopped on, and why its last push was refused, cleared by the next push that lands. */
export const TreeRecord = z.object({
  merged: z.object({ oid: text, at: z.number(), head: text.optional() }).optional(),
  conflicts: z.array(text).optional(),
  pushRefused: text.optional(),
});
export type TreeRecord = z.infer<typeof TreeRecord>;

/** One child as the lead's rows read it: its branch, whether the git host holds that branch, how far it is from what
 * the lead's copy holds of it, and what its record keeps. That is the lead's branch as the git host holds it until a
 * merge, and the child's commit the merge took after one, since the lead's copy holds that before any push. The
 * counts are absent where nothing could count them. */
export const TreeChild = TreeRecord.extend({
  workspaceId: text,
  threadId: text.optional(),
  branch: text,
  /** Whether the git host holds the branch; absent where nothing could ask it, which the row reads as not counted. */
  pushed: z.boolean().optional(),
  aheadOfLead: count.optional(),
  behindLead: count.optional(),
});
export type TreeChild = z.infer<typeof TreeChild>;

/** A lead's children as the host last read them, against the lead's branch as the remote holds it; carried on the
 * status of a workspace that has children, and on no other. */
export const TreeFact = z.object({ leadBranch: text, children: z.array(TreeChild), readAt: z.number() });
export type TreeFact = z.infer<typeof TreeFact>;

/** What a merge into the lead answers: merged with the commits it brought, merged nothing, or the files it stopped on. */
export const MergeInResult = z.object({ lead: text, child: text, branch: text, merged: z.boolean(), commits: count, conflicts: z.array(text) });
export type MergeInResult = z.infer<typeof MergeInResult>;

/** One word table for the tree, on the lead's rows, the command line and the fork's reply. */
export const TREE_WORDS = {
  aheadOf: (n: number, lead: string): string => `${n} ahead of ${lead}`,
  notPushed: "not pushed",
  notCounted: "not counted",
  mergedIntoLead: "merged into lead",
  conflictsIn: (n: number): string => `conflicts in ${n} ${n === 1 ? "file" : "files"}`,
  mergeIntoLead: "Merge into lead",
  askTheLead: "Ask the lead to merge it",
} as const;

/** The one line a fork says once its child's copy stands on the branch the lead pushed. */
export function childStartedLine(child: string, branch: string): string {
  return `${child} starts on ${branch} as pushed`;
}

/** The line the lead's thread reads when a fork pushed its branch first, so the child starts from the lead's work. */
export function pushedForChildLine(branch: string, child: string): string {
  return `pushed ${branch} so ${child} starts from your work`;
}

/** What a fork says of the changes the lead had not committed, which the push could not carry. */
export function uncommittedStayed(n: number, lead: string): string {
  return `${n} uncommitted ${n === 1 ? "change" : "changes"} in ${lead} did not travel`;
}

/** Why a child could not be made on its lead's branch: the push or the start on it refused, in its own sentence. */
export function forkNeedsPushLine(lead: string, why: string): string {
  return `the child was not made, since ${lead}'s branch could not reach it: ${why}`;
}

/** What `wsp merge in` says once the child's branch is in the lead's. */
export function mergedInLine(lead: string, branch: string, child: string, commits: number): string {
  return `${lead}: merged ${branch} from ${child}, ${commits} ${commits === 1 ? "commit" : "commits"}`;
}

/** What it says where the merge stopped on conflicts and was taken back. */
export function mergeConflictsLine(lead: string, branch: string, paths: readonly string[]): string {
  return `${lead}: conflicts with ${branch} in ${paths.join(", ")}`;
}

/** What `wsp fix --child` says once the lead's agent is asked to merge the child. */
export function fixMergeChildLine(lead: string, agent: string, child: string): string {
  return `${lead}: asked ${agent} to merge ${child}`;
}

/** The one line a merge into the lead reads as, on the command line and in the tool's answer. */
export function mergeInLine(done: MergeInResult): string {
  if (!done.merged) return mergeConflictsLine(done.lead, done.branch, done.conflicts);
  return done.commits > 0 ? mergedInLine(done.lead, done.branch, done.child, done.commits) : nothingToMergeLine(done.lead, done.child);
}

/** What it says where the child has nothing the lead lacks. */
export function nothingToMergeLine(lead: string, child: string): string {
  return `${lead}: nothing to merge from ${child}`;
}

/** Why a merge waits: a turn runs on the lead in a thread other than the one asking, and a merge would land under it. */
export function leadBusyRefusal(lead: string, threadIds: readonly string[]): string {
  const named = threadIds.map(id => id.slice(0, 8)).join(", ");
  return `${lead} has a turn running in thread ${named}; merge once it ends, or from inside that turn`;
}

/** Why a merge into a workspace is refused for one that is not its child. */
export function notTheLeadsChildRefusal(child: string, lead: string): string {
  return `${child} is not a child of ${lead}; a lead merges only its own children`;
}

/** Why a thread may merge only into the workspace it runs on. */
export function mergeIntoOwnRefusal(threadId: string): string {
  return `thread ${threadId.slice(0, 8)} may merge a child only into its own workspace`;
}

/** Why a child is not merged where its copy is on no branch at all. */
export function childOnNoBranchRefusal(child: string): string {
  return `${child} is on no branch, so there is nothing to merge from it`;
}

/** Why a fix names a failed check or a child to merge, never both. */
export const FIX_CHECK_OR_CHILD = "name a failed check or a child to merge, not both";

/** Why a merge needs a remote where the lead and the child sit on two computers. */
export function noRemoteForTreeLine(project: string): string {
  return `${project} has no remote, so a child on another computer cannot be merged; add a remote to the project to merge across computers`;
}

/** The row's note under a child whose push was refused, pointing at that computer's sign-in. */
export function cannotPushFromLine(computer: string, why: string): string {
  return `can't push from ${computer}: ${why}`;
}

/** The message a lead's first thread is handed when a child's merge stopped on conflicts: fetch, merge with a merge
 * commit, resolve the files, test, commit. */
export function mergeChildPrompt(o: { leadBranch: string; childBranch: string; remote: string; conflicts: readonly string[] }): string {
  const files = o.conflicts.length > 0 ? `; resolve the conflicts in ${o.conflicts.join(", ")}` : "; resolve the conflicts";
  return `Fetch ${o.remote} ${o.childBranch} and merge it into ${o.leadBranch} with a merge commit${files}; run the tests; commit.`;
}
