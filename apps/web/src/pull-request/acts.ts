// SPDX-License-Identifier: AGPL-3.0-only
// The three acts on a workspace's pull request as the app runs them: each asks the host, and says what it did in a
// toast with the command line's own line, or the host's refusal in its words.
import { agentName } from "@wsp/catalog";
import { fixAskedLine, fixConflictsLine, fixNothingLine, mergedLine, updateConflictsLine, updatedLine, type MergeMethod } from "@wsp/protocol";
import { addNotice, noticeFailure } from "../notices/store.js";
import { useStore } from "../protocol/store.js";
import { PR_WORDS } from "./words.js";

/** Sends a failed check, or with none the conflicts an update from the base found, to the workspace's agent. */
export async function askToFix(workspaceId: string, name: string, check?: string): Promise<void> {
  const fix = useStore.getState().api?.fix;
  if (fix === undefined) return;
  try {
    const asked = await fix(workspaceId, check);
    const text = asked.outcome === "updated" ? fixNothingLine(name, asked.base) : asked.check !== undefined ? fixAskedLine(name, agentName(asked.agent), asked.check) : fixConflictsLine(name, agentName(asked.agent), asked.base);
    addNotice({ kind: "done", text, where: name });
  } catch (e) {
    noticeFailure(e, said => said, { where: name });
  }
}

/** Merges the base's latest commits into the copy's branch; a conflict says which files and offers the fix. */
export async function updateFromBase(workspaceId: string, name: string): Promise<void> {
  const update = useStore.getState().api?.update;
  if (update === undefined) return;
  try {
    const done = await update(workspaceId);
    if (done.merged) addNotice({ kind: "done", text: updatedLine(name, done.base, done.commits), where: name });
    else addNotice({ kind: "note", text: updateConflictsLine(name, done.base, done.conflicts), where: name, action: { word: PR_WORDS.fix, run: () => void askToFix(workspaceId, name) } });
  } catch (e) {
    noticeFailure(e, said => said, { where: name });
  }
}

/** Merges the pull request by the method given, or the repository's default, or once its checks pass, naming the head the
 * window drew so a push since then fails the merge rather than landing unseen. */
export async function mergePullRequest(workspaceId: string, name: string, o: { method?: MergeMethod; whenChecksPass?: boolean; head: string }): Promise<void> {
  const merge = useStore.getState().api?.merge;
  if (merge === undefined) return;
  try {
    addNotice({ kind: "done", text: mergedLine(name, await merge(workspaceId, o)), where: name });
  } catch (e) {
    noticeFailure(e, said => said, { where: name });
  }
}
