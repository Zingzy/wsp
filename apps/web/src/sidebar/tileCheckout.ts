// SPDX-License-Identifier: AGPL-3.0-only
// The branch and counts on row three of a workspace's tiles. The host reads a copy's checkout at a turn's end, on
// view and after a write, and pushes it on the workspace's status; a tile draws that fact and asks the host for it
// once as the sidebar mounts, and reads no daemon of its own. A copy the host has not read yet shows the branch it
// was made on, off its record.
import { useEffect } from "react";
import { checkoutCounts, DETACHED_HEAD } from "@wsp/protocol";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { useStore } from "../protocol/store.js";
import { branchLine } from "./workspaceRows.js";

/** What a workspace's tiles show on row three: the branch, empty where none is known or the head is on none, and
 * the counts beside it that say something at a glance. Behind is left out, and so is ahead once the tile's thread
 * is done, since the work it counts is over. */
export function tileCheckout(runs: Pick<SidebarProjectSnapshot, "workspace" | "status">, done = false): { branch: string; counts: readonly string[] } {
  const fact = runs.status?.checkout;
  if (fact === undefined) return { branch: branchLine(runs), counts: [] };
  return { branch: fact.branch === DETACHED_HEAD ? "" : fact.branch, counts: checkoutCounts({ ...fact, behind: 0, ...(done ? { ahead: 0 } : {}) }) };
}

/** Asks the host for one workspace's checkout as the sidebar mounts; the answer lands on the status it pushes. Draws nothing. */
export function CheckoutAsk({ workspaceId }: { workspaceId: string }) {
  const ask = useStore(s => s.api?.workspaceCheckout);
  useEffect(() => {
    void ask?.(workspaceId).catch(() => undefined);
  }, [ask, workspaceId]);
  return null;
}
