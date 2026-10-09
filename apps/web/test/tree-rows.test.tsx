// SPDX-License-Identifier: AGPL-3.0-only
// The lead's Threads section as a tree: two levels of indent, then every deeper child at the second level's x.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarThreadSnapshot } from "../src/adapt/index.js";
import { useStore } from "../src/protocol/store.js";
import { TreeRows, type ChildNode } from "../src/tree/TreeRows.js";

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
  subagents: [],
  lastLine: null,
  failure: null,
  foldedAt: null, replaces: null, replacedBy: null,
  ...over,
});

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

  it("indents two levels and stands the third and deeper at the second level's x", () => {
    const chain = (depth: number): ChildNode => ({ thread: thread(`L${depth}`, `ws_${depth}`, { status: "running", endedAt: null }), place: "", children: depth === 4 ? [] : [chain(depth + 1)] });
    render(<TreeRows leadThread={null} leadPlace="" nodes={[chain(1)]} />);
    // Each list a row stands in moves it one step in, so the lists above a row are its x.
    const lists = (id: string): number => {
      let n = 0;
      for (let at = document.querySelector(`[data-thread-row="${id}"]`)!.parentElement; at !== null; at = at.parentElement) if (at.tagName === "UL") n++;
      return n;
    };
    expect(Object.fromEntries(["L1", "L2", "L3", "L4"].map(id => [id, lists(id)]))).toEqual({ L1: 0, L2: 1, L3: 1, L4: 1 });
  });
});
