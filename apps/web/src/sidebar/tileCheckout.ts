// SPDX-License-Identifier: AGPL-3.0-only
// The branch, or the short commit a copy on no branch is at, and the pull request's #N on row three of a workspace's
// tiles. The host reads a copy's checkout at a turn's end, on view and after a write, and pushes it on the
// workspace's status; a tile draws that fact and asks the host for it once as the sidebar mounts, and reads no daemon
// of its own. A copy the host has not read yet shows the branch, or the commit, it was made on, off its record.
import { useEffect } from "react";
import { DETACHED_HEAD, isPullRequestNamed, type PullRequestState } from "@wsp/protocol";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { EDITOR_SSH_WORDS } from "../files/EditorConsent.js";
import { useStore } from "../protocol/store.js";
import { branchLine } from "./workspaceRows.js";

/** What a workspace's tiles show on row three: the branch, empty where none is known or the head is on none; the
 * head's short commit in its place where the branch is empty and a commit is known; the pull request by its number
 * and where it stands, which the tile marks in that state's ink and never words; the word for an editor attached over
 * ssh while one is, since it is also what keeps the workspace awake; and why the pull request is not read, for the
 * hover. Nothing counts what changed or how far the branch is from anything. */
export interface TileCheckout {
  branch: string;
  commit?: string;
  pr?: { number: number; state: PullRequestState; url: string };
  counts: readonly string[];
  why?: string;
}

const SHORT = 7;

export function tileCheckout(runs: Pick<SidebarProjectSnapshot, "workspace" | "status">, o: { attached?: boolean } = {}): TileCheckout {
  const fact = runs.status?.checkout;
  const pr = runs.status?.pr;
  const branch = fact === undefined ? branchLine(runs) : fact.branch === DETACHED_HEAD ? "" : fact.branch;
  const head = fact === undefined ? runs.workspace.copy?.base : fact.head;
  return {
    branch,
    ...(branch === "" && head !== undefined && head !== "" ? { commit: head.slice(0, SHORT) } : {}),
    ...(isPullRequestNamed(pr) ? { pr: { number: pr.number, state: pr.state, url: pr.url } } : {}),
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
