// SPDX-License-Identifier: AGPL-3.0-only
// The children a run of a lead's calls started, each as its row where its call stands in the transcript: one column
// with no gap, the marks at the Threads rows' x, and each child in its own state as the lead's tree reads it, so a
// child that finished or settled still stands at its call. A thread's row opens the thread on a press, a subagent's
// its page.
import { SETTLE_MS, threadKeyOf } from "@wsp/protocol";
import { memo, useMemo } from "react";
import type { SpawnCall } from "../../adapt/index.js";
import type { SpawnedChildren } from "../../adapt/spawned.js";
import { usePlaces, useSidebarProjects, useStore } from "../../protocol/store.js";
import { computerName } from "../../sidebar/workspaceRows.js";
import { childNodesOf, type ChildNode } from "../../tree/TreeRows.js";
import { childTarget, kindOf, leadNodes, noteOf, partOf, type LeadNode, type Tree } from "./leadTree.js";
import { SubagentRow, ThreadRow } from "./ThreadRows.js";

const idSet = (joined: string): ReadonlySet<string> => new Set(joined === "" ? [] : joined.split("\n"));

/** The children a thread holds, read off the store as their ids alone, so a child's status moving leaves the
 * transcript's rows as they were: the threads its agent opened, and its agent's subagents by their launching calls. */
export function useSpawnedChildren(lead: string | null): SpawnedChildren | undefined {
  const threads = useStore(s => {
    if (lead === null) return "";
    const ids = new Set<string>();
    for (const rows of Object.values(s.sessions)) for (const row of rows) if (row.parentThreadId === lead && row.threadId !== undefined) ids.add(row.threadId);
    return [...ids].sort().join("\n");
  });
  const subagents = useStore(s => {
    if (lead === null) return "";
    for (const rows of Object.values(s.sessions)) {
      const own = rows.filter(row => threadKeyOf(row) === lead && row.subagents !== undefined).at(-1);
      if (own !== undefined) return own.subagents!.flatMap(sub => sub.parentToolUseId ?? []).join("\n");
    }
    return "";
  });
  return useMemo(() => (lead === null ? undefined : { lead, threads: idSet(threads), subagents: idSet(subagents) }), [lead, threads, subagents]);
}

const childOf = (nodes: ReadonlyArray<LeadNode<ChildNode>>, call: SpawnCall): LeadNode<ChildNode> | undefined =>
  nodes.find(node => ("thread" in call ? "node" in node && node.node.thread.threadId === call.thread : "subagent" in node && node.subagent.parentToolUseId === call.subagent));

function SpawnTile({ node, tree, leadPlace }: { node: LeadNode<ChildNode>; tree: Tree<ChildNode>; leadPlace: string }) {
  const part = partOf(node, tree);
  const note = noteOf(node, part);
  const target = childTarget(node, part, tree);
  const kind = kindOf(node, part);
  if ("subagent" in node) {
    const { of } = node;
    return <SubagentRow subagent={node.subagent} target={target} kind={kind} note={note} lead={of.threadId === null ? undefined : { workspaceId: of.workspaceId, threadId: of.threadId }} />;
  }
  const { thread, place, at } = node.node;
  return <ThreadRow thread={thread} place={place === leadPlace ? "" : place} at={at} {...(note !== undefined ? { note } : {})} target={target} kind={kind} />;
}

export const SpawnTiles = memo(function SpawnTiles({ calls, leadKey }: { calls: ReadonlyArray<SpawnCall>; leadKey: string }) {
  const projects = useSidebarProjects();
  const places = usePlaces();
  const settleMs = SETTLE_MS[useStore(s => s.preferences.settleAfter)];
  const kids = useMemo(() => childNodesOf(projects, places, leadKey), [projects, places, leadKey]);
  const lead = projects.flatMap(runs => runs.threads.map(thread => ({ thread, runs }))).find(({ thread }) => thread.id === leadKey);
  const tree: Tree<ChildNode> = { threadOf: n => n.thread, kidsOf: n => n.children, nowMs: Date.now(), settleMs };
  const nodes = leadNodes(lead?.thread ?? null, kids, tree);
  const leadPlace = lead === undefined ? "" : computerName(places, lead.runs);
  return (
    <div data-spawn-tiles className="flex min-w-0 flex-col">
      {calls.map(call => {
        const node = childOf(nodes, call);
        return node === undefined ? null : <SpawnTile key={call.id} node={node} tree={tree} leadPlace={leadPlace} />;
      })}
    </div>
  );
});
