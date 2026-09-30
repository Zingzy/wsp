// SPDX-License-Identifier: AGPL-3.0-only
// The branch, its counts and the pull request's word on row three of a workspace's tiles. The host reads a copy's checkout at a turn's end, on
// view and after a write, and pushes it on the workspace's status; a tile draws that fact and asks the host for it
// once as the sidebar mounts, and reads no daemon of its own. A copy the host has not read yet shows the branch it
// was made on, off its record.
import { useEffect } from "react";
import { capitalised, checkoutCounts, DETACHED_HEAD, isPullRequestNamed, pullRequestWord } from "@wsp/protocol";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { EDITOR_SSH_WORDS } from "../files/EditorConsent.js";
import { useStore } from "../protocol/store.js";
import { branchLine } from "./workspaceRows.js";

/** What a workspace's tiles show on row three: the branch, empty where none is known or the head is on none, the
 * counts beside it that say something at a glance, the word for an editor attached over ssh first while one is,
 * since it is also what keeps the workspace awake, and the pull request's word next; why that word is not read, for
 * the hover; and the word a settled tile's slot reads in place of its age where the pull request merged or closed.
 * Ahead is left out once the tile's thread is done, since the work it counts is over. */
export interface TileCheckout {
  branch: string;
  counts: readonly string[];
  why?: string;
  settledWord?: string;
}

export function tileCheckout(runs: Pick<SidebarProjectSnapshot, "workspace" | "status">, o: { done?: boolean; attached?: boolean } = {}): TileCheckout {
  const fact = runs.status?.checkout;
  const pr = runs.status?.pr;
  const word = [...(o.attached === true ? [EDITOR_SSH_WORDS.attached] : []), ...(pr === undefined ? [] : [pullRequestWord(pr)])];
  // The word stands next to the branch, ahead of the counts: a tile is too narrow for all of them, and the pull
  // request's state is the one a person scans the list for.
  const shown =
    fact === undefined
      ? { branch: branchLine(runs), counts: word }
      : { branch: fact.branch === DETACHED_HEAD ? "" : fact.branch, counts: [...word, ...checkoutCounts({ ...fact, ...(o.done === true ? { ahead: 0 } : {}) }, pr)] };
  return {
    ...shown,
    ...(pr !== undefined && "why" in pr ? { why: pr.why } : {}),
    ...(isPullRequestNamed(pr) && pr.state !== "open" ? { settledWord: capitalised(pullRequestWord(pr)) } : {}),
  };
}

/** Asks the host for one workspace's checkout as the sidebar mounts; the answer lands on the status it pushes. Draws nothing. */
export function CheckoutAsk({ workspaceId }: { workspaceId: string }) {
  const ask = useStore(s => s.api?.workspaceCheckout);
  useEffect(() => {
    void ask?.(workspaceId).catch(() => undefined);
  }, [ask, workspaceId]);
  return null;
}
