// SPDX-License-Identifier: AGPL-3.0-only
// The lead's THREADS list as the tree of branches: each child's row in ThreadRows' grammar with its branch and the
// count against the lead's branch beside it, the push its computer could not make as the note under the title, and
// in the state cell the thread's status while it works or waits, else the one act there is to take.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TREE_WORDS, cannotPushFromLine, mergedInLine, type TreeChild, type TreeFact } from "@wsp/protocol";
import type { SidebarThreadSnapshot } from "../src/adapt/index.js";
import { useNotices } from "../src/notices/store.js";
import { useStore } from "../src/protocol/store.js";
import { TreeRows } from "../src/tree/TreeRows.js";

const NOW = new Date("2026-09-29T12:00:00Z");

const thread = (id: string, workspaceId: string, over: Partial<SidebarThreadSnapshot> = {}): SidebarThreadSnapshot => ({
  id,
  threadId: `thr_${id}`,
  sessionId: `sess_${id}`,
  workspaceId,
  title: id,
  status: "completed",
  ran: true,
  startedAt: "2026-09-29T11:00:00Z",
  endedAt: "2026-09-29T11:46:00Z",
  indicator: null,
  harness: "claude",
  startedBy: "agent",
  project: null,
  parentThreadId: "thr_lead",
  attempt: null,
  model: null,
  asking: null,
  costUsd: null,
  unread: false,
  readAt: null,
  settledAt: null,
  needsYou: false,
  pinnedAt: null,
  snoozedUntil: null,
  section: null,
  ...over,
});

const child = (workspaceId: string, over: Partial<TreeChild> = {}): TreeChild => ({ workspaceId, branch: `child/${workspaceId}`, pushed: true, aheadOfLead: 2, behindLead: 0, ...over });
const tree = (children: TreeChild[]): TreeFact => ({ leadBranch: "tree/lead", children, readAt: 1 });
const LEAD = { id: "ws_lead", name: "lead" };

const rowOf = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-thread-row="${id}"]`)!;
const buttons = (row: HTMLElement): string[] => [...row.querySelectorAll("button")].map(b => b.textContent ?? "");

describe("the lead's rows", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useStore.setState({ api: null } as never);
  });

  it("names each child's branch in sans with its count against the lead's branch in the muted ink", () => {
    render(<TreeRows lead={LEAD} tree={tree([child("one")])} rows={[{ thread: thread("helper", "one"), place: "Solari" }]} />);
    const row = rowOf("helper");
    const branch = row.querySelector<HTMLElement>("[data-tree-branch]")!;
    expect(branch.textContent).toBe("child/one");
    expect(branch.className).not.toContain("font-mono");
    const fact = row.querySelector<HTMLElement>("[data-tree-fact]")!;
    expect(fact.textContent).toBe(TREE_WORDS.aheadOf(2, "tree/lead"));
    expect(fact.className).toContain("text-muted-foreground");
    expect(row.querySelector("[data-thread-place]")!.textContent).toBe("Solari");
  });

  it("shows the thread's status while it works or waits, and the keycap only once it is quiet with commits the lead lacks", () => {
    render(
      <TreeRows
        lead={LEAD}
        tree={tree([child("working"), child("asking"), child("quiet"), child("level", { aheadOfLead: 0 })])}
        rows={[
          { thread: thread("working", "working", { status: "running", endedAt: null }), place: "Solari" },
          { thread: thread("asking", "asking", { asking: "Bash: pnpm install" }), place: "Solari" },
          { thread: thread("quiet", "quiet"), place: "Solari" },
          { thread: thread("level", "level"), place: "Solari" },
        ]}
      />,
    );
    expect(buttons(rowOf("working"))).toEqual([]);
    expect(rowOf("working").querySelector("[data-thread-status]")).not.toBeNull();
    expect(buttons(rowOf("asking"))).toEqual([]);
    expect(buttons(rowOf("quiet"))).toEqual([TREE_WORDS.mergeIntoLead]);
    expect(rowOf("quiet").querySelector("[data-thread-status]")).toBeNull();
    expect(buttons(rowOf("level"))).toEqual([]);
  });

  it("says merged into lead after a merge, and conflicts in n files with the second keycap after one that stopped", () => {
    render(
      <TreeRows
        lead={LEAD}
        tree={tree([child("merged", { merged: { oid: "d00d", at: 1, head: "c0de" }, aheadOfLead: 0 }), child("stuck", { conflicts: ["lead.txt", "a.ts"] })])}
        rows={[
          { thread: thread("merged", "merged"), place: "Solari" },
          { thread: thread("stuck", "stuck"), place: "Solari" },
        ]}
      />,
    );
    expect(rowOf("merged").querySelector("[data-tree-fact]")!.textContent).toBe(TREE_WORDS.mergedIntoLead);
    expect(buttons(rowOf("merged"))).toEqual([]);
    expect(rowOf("stuck").querySelector("[data-tree-fact]")!.textContent).toBe(TREE_WORDS.conflictsIn(2));
    expect(buttons(rowOf("stuck"))).toEqual([TREE_WORDS.askTheLead]);
  });

  it("reads a merged child with commits since the merge as ahead again, with the keycap back", () => {
    render(
      <TreeRows
        lead={LEAD}
        tree={tree([child("again", { merged: { oid: "d00d", at: 1, head: "c0de" }, aheadOfLead: 1 })])}
        rows={[{ thread: thread("again", "again"), place: "Solari" }]}
      />,
    );
    expect(rowOf("again").querySelector("[data-tree-fact]")!.textContent).toBe(TREE_WORDS.aheadOf(1, "tree/lead"));
    expect(buttons(rowOf("again"))).toEqual([TREE_WORDS.mergeIntoLead]);
  });

  it("says not pushed where the remote lacks the branch, not counted where nothing could count it, and a refused push as the note", () => {
    const why = "this computer has no git credential for github.com, so nothing was pushed";
    render(
      <TreeRows
        lead={LEAD}
        tree={tree([child("local", { pushed: false, aheadOfLead: undefined }), child("unknown", { pushed: undefined, aheadOfLead: undefined }), child("refused", { pushed: false, aheadOfLead: undefined, pushRefused: why })])}
        rows={[
          { thread: thread("local", "local"), place: "Solari" },
          { thread: thread("unknown", "unknown"), place: "Solari" },
          { thread: thread("refused", "refused"), place: "box" },
        ]}
      />,
    );
    expect(rowOf("local").querySelector("[data-tree-fact]")!.textContent).toBe(TREE_WORDS.notPushed);
    expect(buttons(rowOf("local"))).toEqual([]);
    expect(rowOf("unknown").querySelector("[data-tree-fact]")!.textContent).toBe(TREE_WORDS.notCounted);
    // Nothing counted it, so the person may still try; the merge says itself if there was nothing to take.
    expect(buttons(rowOf("unknown"))).toEqual([TREE_WORDS.mergeIntoLead]);
    const note = rowOf("refused").querySelector<HTMLElement>("[data-tree-note]")!;
    expect(note.textContent).toBe(cannotPushFromLine("box", why));
    expect(note.className).toContain("text-[11px]");
  });

  it("merges through the host on the keycap and says what it did in the command line's own line", async () => {
    vi.useRealTimers();
    const mergeIn = vi.fn(async () => ({ lead: "lead", child: "helper", branch: "child/one", merged: true, commits: 2, conflicts: [] }));
    useStore.setState({ api: { mergeIn } } as never);
    render(<TreeRows lead={LEAD} tree={tree([child("one")])} rows={[{ thread: thread("helper", "one"), place: "Solari" }]} />);
    fireEvent.click(rowOf("helper").querySelector("button")!);
    await waitFor(() => expect(mergeIn).toHaveBeenCalledWith("ws_lead", "one"));
    await waitFor(() => expect(useNotices.getState().notices.some(n => n.text === mergedInLine("lead", "child/one", "helper", 2))).toBe(true));
  });

  it("hands a stopped merge to the lead's agent on the second keycap", async () => {
    vi.useRealTimers();
    const fix = vi.fn(async () => ({ outcome: "started", base: "tree/lead", child: "stuck", agent: "claude" }));
    useStore.setState({ api: { fix } } as never);
    render(<TreeRows lead={LEAD} tree={tree([child("stuck", { conflicts: ["lead.txt"] })])} rows={[{ thread: thread("stuck", "stuck"), place: "Solari" }]} />);
    fireEvent.click(rowOf("stuck").querySelector("button")!);
    await waitFor(() => expect(fix).toHaveBeenCalledWith("ws_lead", undefined, "stuck"));
  });
});
