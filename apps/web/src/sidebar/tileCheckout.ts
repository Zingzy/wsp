// SPDX-License-Identifier: AGPL-3.0-only
// What a workspace's tiles know of its checkout: the branch, the pull request and what is uncommitted, which the
// tile's card says and whose open pull request is the one mark on the tile itself. The host reads a copy's checkout
// at a turn's end, on view and after a write, and pushes it on the workspace's status; a tile draws that fact and asks
// the host for it once a connection, the first time one of the workspace's tiles comes into view, and reads no daemon
// of its own. A copy the host has not read yet shows the branch it was made on, off its record. A fork on a branch of its
// own says beside it the one fact its lead's tree holds of it; a fork on its lead's own branch names no branch at all.
import { useEffect, type RefObject } from "react";
import { checkoutCounts, DETACHED_HEAD, isPullRequestNamed, TREE_WORDS, type PullRequestState, type TreeChild, type TreeFact } from "@wsp/protocol";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { EDITOR_SSH_WORDS } from "../files/EditorConsent.js";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { branchLine } from "./workspaceRows.js";

/** What a workspace's tiles know of it: the branch, empty where none is known or the head is on none (no commit
 * stands in for it); the pull request by its number and where it stands; what the checkout holds uncommitted, in its
 * own words; the word for an editor attached over ssh while one is, since it is also what keeps the workspace awake;
 * and why the pull request is not read. */
export interface TileCheckout {
  /** The folder the workspace works in: its copy, or the project's own. */
  folder?: string;
  branch: string;
  pr?: { number: number; state: PullRequestState; url: string };
  changed?: string;
  counts: readonly string[];
  why?: string;
}

/** The one fact beside a child's branch: its landing where it has one, else how far it stands from the lead's. */
function childFact(child: TreeChild, leadBranch: string): string {
  if (child.conflicts !== undefined && child.conflicts.length > 0) return TREE_WORDS.conflictsIn(child.conflicts.length);
  if (child.merged !== undefined && (child.aheadOfLead ?? 0) === 0) return TREE_WORDS.mergedIntoLead;
  if (child.pushed === false) return TREE_WORDS.notPushed;
  if (child.aheadOfLead === undefined) return TREE_WORDS.notCounted;
  return TREE_WORDS.aheadOf(child.aheadOfLead, leadBranch);
}

/** A workspace's checkout as its tiles' card says it; `lead` is the tree of the workspace it was forked out of. */
export function tileCheckout(runs: Pick<SidebarProjectSnapshot, "id" | "workspace" | "status">, o: { attached?: boolean; lead?: TreeFact } = {}): TileCheckout {
  const fact = runs.status?.checkout;
  const pr = runs.status?.pr;
  const own = fact === undefined ? branchLine(runs) : fact.branch === DETACHED_HEAD ? "" : fact.branch;
  const child = o.lead?.children.find(c => c.workspaceId === runs.id);
  const name = own === "" ? (child?.branch ?? "") : own;
  const branch = child === undefined || name === "" ? own : child.branch === o.lead!.leadBranch ? "" : `${name}, ${childFact(child, o.lead!.leadBranch)}`;
  const changed = fact === undefined ? undefined : checkoutCounts(fact)[0];
  const folder = runs.workspace.folder ?? runs.workspace.project.path;
  return {
    ...(folder !== undefined && folder !== "" ? { folder } : {}),
    branch,
    ...(isPullRequestNamed(pr) ? { pr: { number: pr.number, state: pr.state, url: pr.url } } : {}),
    ...(changed !== undefined ? { changed } : {}),
    counts: o.attached === true ? [EDITOR_SSH_WORDS.attached] : [],
    ...(pr !== undefined && "why" in pr ? { why: pr.why } : {}),
  };
}

const TILE = "[data-workspace-id] [data-sidebar-row]";

/** The workspaces each connection has asked after, and since which gap: the status pushes keep a fact fresh once read,
 * so a sidebar drawn again (Settings and back) asks nothing, and a host that lost the window's events is asked again. */
const asked = new WeakMap<Api, { gaps: number; ids: Set<string> }>();

/** Asks the host for a workspace's checkout once a connection; the answer lands on the status it pushes. A refusal, or
 * a reply with no checkout (a workspace not running), leaves it to be asked again. */
export function askCheckout(api: Api, workspaceId: string): void {
  const read = api.workspaceCheckout;
  if (read === undefined) return;
  const gaps = useStore.getState().gaps;
  let mine = asked.get(api);
  if (mine === undefined || mine.gaps !== gaps) asked.set(api, (mine = { gaps, ids: new Set() }));
  const { ids } = mine;
  if (ids.has(workspaceId)) return;
  ids.add(workspaceId);
  void read(workspaceId).then(
    reply => {
      if (reply.checkout === undefined) ids.delete(workspaceId);
    },
    () => ids.delete(workspaceId),
  );
}

/** Asks for the checkout of a workspace on screen whose status carries none, whether or not a tile of it is in view,
 * and again when its phase moves (a workspace that starts). */
export function useCheckoutOf(workspaceId: string): void {
  const api = useStore(s => s.api);
  const gaps = useStore(s => s.gaps);
  const missing = useStore(s => s.statuses[workspaceId]?.checkout === undefined);
  const phase = useStore(s => s.workspaces.find(w => w.id === workspaceId)?.phase);
  useEffect(() => {
    if (api !== null && missing) askCheckout(api, workspaceId);
  }, [api, gaps, missing, phase, workspaceId]);
}

/** Asks the host for the checkout of each workspace whose tile comes into view under root. Without an
 * IntersectionObserver every tile counts as in view. */
export function useCheckoutAsks(root: RefObject<HTMLElement | null>): void {
  const api = useStore(s => s.api);
  const gaps = useStore(s => s.gaps);
  useEffect(() => {
    const el = root.current;
    if (el === null || api === null || api.workspaceCheckout === undefined) return;
    const ask = (tile: Element): void => {
      const id = tile.closest("[data-workspace-id]")?.getAttribute("data-workspace-id") ?? null;
      if (id !== null) askCheckout(api, id);
    };
    const seen =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(entries => {
            for (const entry of entries) if (entry.isIntersecting) ask(entry.target);
          });
    const watched = new Set<Element>();
    const scan = (): void => {
      for (const tile of el.querySelectorAll(TILE)) {
        if (watched.has(tile)) continue;
        watched.add(tile);
        if (seen === null) ask(tile);
        else seen.observe(tile);
      }
      for (const tile of [...watched]) {
        if (tile.isConnected) continue;
        watched.delete(tile);
        seen?.unobserve(tile);
      }
    };
    scan();
    const rows = new MutationObserver(scan);
    rows.observe(el, { childList: true, subtree: true });
    return () => {
      rows.disconnect();
      seen?.disconnect();
    };
  }, [api, gaps, root]);
}
