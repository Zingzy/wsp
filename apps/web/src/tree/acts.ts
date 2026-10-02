// SPDX-License-Identifier: AGPL-3.0-only
// The two acts on a lead's child as the app runs them: each asks the host and says what it did in a toast with the
// command line's own line, or the host's refusal in its words.
import { agentName } from "@wsp/catalog";
import { TREE_WORDS, fixMergeChildLine, mergeInLine } from "@wsp/protocol";
import { addNotice, noticeFailure } from "../notices/store.js";
import { useStore } from "../protocol/store.js";

/** Merges the child's branch into the lead's copy; one that stops on conflicts says which files and offers the hand-over. */
export async function mergeIntoLead(lead: { id: string; name: string }, childId: string): Promise<void> {
  const mergeIn = useStore.getState().api?.mergeIn;
  if (mergeIn === undefined) return;
  try {
    const done = await mergeIn(lead.id, childId);
    if (done.merged) addNotice({ kind: "done", text: mergeInLine(done), where: lead.name });
    else addNotice({ kind: "note", text: mergeInLine(done), where: lead.name, action: { word: TREE_WORDS.askTheLead, run: () => void askLeadToMerge(lead, childId) } });
  } catch (e) {
    noticeFailure(e, said => said, { where: lead.name });
  }
}

/** Sends the lead's agent the merge that stopped, with the files it stopped on. */
export async function askLeadToMerge(lead: { id: string; name: string }, childId: string): Promise<void> {
  const fix = useStore.getState().api?.fix;
  if (fix === undefined) return;
  try {
    const asked = await fix(lead.id, undefined, childId);
    if (asked.outcome !== "updated") addNotice({ kind: "done", text: fixMergeChildLine(lead.name, agentName(asked.agent), asked.child ?? childId), where: lead.name });
  } catch (e) {
    noticeFailure(e, said => said, { where: lead.name });
  }
}
