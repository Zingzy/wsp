// SPDX-License-Identifier: AGPL-3.0-only
// What a workspace's tiles know of its checkout: the branch, the pull request and what is uncommitted, which the
// tile's card says and whose open pull request is the one mark on the tile itself. The host reads a copy's checkout
// at a turn's end, on view and after a write, and pushes it on the workspace's status; a tile draws that fact and asks
// the host for it once as the sidebar mounts, and reads no daemon of its own. A copy the host has not read yet shows
// the branch it was made on, off its record.
import { useEffect } from "react";
import { checkoutCounts, DETACHED_HEAD, isPullRequestNamed, type PullRequestState } from "@wsp/protocol";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { EDITOR_SSH_WORDS } from "../files/EditorConsent.js";
import { useStore } from "../protocol/store.js";
import { branchLine } from "./workspaceRows.js";

/** What a workspace's tiles know of it: the branch, empty where none is known or the head is on none (no commit
 * stands in for it); the pull request by its number and where it stands; what the checkout holds uncommitted, in its
 * own words; the word for an editor attached over ssh while one is, since it is also what keeps the workspace awake;
 * and why the pull request is not read. */
export interface TileCheckout {
  branch: string;
  pr?: { number: number; state: PullRequestState; url: string };
  changed?: string;
  counts: readonly string[];
  why?: string;
}

export function tileCheckout(runs: Pick<SidebarProjectSnapshot, "workspace" | "status">, o: { attached?: boolean } = {}): TileCheckout {
  const fact = runs.status?.checkout;
  const pr = runs.status?.pr;
  const branch = fact === undefined ? branchLine(runs) : fact.branch === DETACHED_HEAD ? "" : fact.branch;
  const changed = fact === undefined ? undefined : checkoutCounts(fact)[0];
  return {
    branch,
    ...(isPullRequestNamed(pr) ? { pr: { number: pr.number, state: pr.state, url: pr.url } } : {}),
    ...(changed !== undefined ? { changed } : {}),
    counts: o.attached === true ? [EDITOR_SSH_WORDS.attached] : [],
    ...(pr !== undefined && "why" in pr ? { why: pr.why } : {}),
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
