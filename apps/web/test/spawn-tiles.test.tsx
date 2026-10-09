// SPDX-License-Identifier: AGPL-3.0-only
// A lead's calls that started its children stand as the children's rows in its transcript: the marathon lead's eight
// threads and two subagents as two lists at their calls, one column each with no gap and the rows the Threads list
// draws; each child in its own state, finished and settled ones too; a press opening the child; and a child moving
// from working to finished drawing its own row again and no other.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const drawn = vi.hoisted(() => ({ rows: [] as string[] }));
vi.mock("../src/components/threads/ThreadRows.js", async importOriginal => {
  const { memo } = await import("react");
  const real = await importOriginal<typeof import("../src/components/threads/ThreadRows.js")>();
  // The row is a memo: count its draws inside it, behind the row's own comparison.
  const row = real.ThreadRow as unknown as { type: (props: { thread: { id: string } }) => ReactNode; compare: (a: object, b: object) => boolean };
  return {
    ...real,
    ThreadRow: memo((props: { thread: { id: string } }) => {
      drawn.rows.push(props.thread.id);
      return row.type(props);
    }, row.compare),
  };
});

import type { SessionEvent, SessionView, SubagentView, WorkspaceView } from "@wsp/protocol";
import { deriveMessagesTimelineRows, deriveSession, type SpawnCall } from "../src/adapt/index.js";
import { SpawnTiles } from "../src/components/threads/SpawnTiles.js";
import { useStore } from "../src/protocol/store.js";
import { MessagesTimeline } from "../src/components/chat/MessagesTimeline.js";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ReactNode } from "react";
import { installFakeLayout } from "./fake-layout.js";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const WS = "ws_lab";
const workspace: WorkspaceView = {
  id: WS,
  name: "lab",
  machineId: "m1",
  project: { id: "pr_lab", name: "lab", path: "/root/lab", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-10-01T00:00:00Z",
};

const LEAD = "thr_lead";
const minutes = (n: number): number => NOW - n * 60_000;
const row = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  id: `s_${id}`,
  workspaceId: WS,
  harness: "claude",
  status: "running",
  prompt: `Build ${id}`,
  threadId: `thr_${id}`,
  startedAt: minutes(10),
  startedBy: "agent",
  parentThreadId: LEAD,
  rootThreadId: LEAD,
  ...over,
});

const subagent = (id: string, over: Partial<SubagentView> = {}): SubagentView => ({ id, title: `Subagent ${id}`, state: "running", parentToolUseId: `tu_${id}`, startedAt: minutes(1), ...over });

/** The marathon's eight live threads: one asking, one failed, four working and two held by the computer's cap. */
const EIGHT = ["ask", "fail", "sec", "sheet", "ssh", "rev", "cap1", "cap2"];
const childRow = (id: string): SessionView =>
  id === "ask"
    ? row(id, { asking: "Run pnpm install --frozen-lockfile" })
    : id === "fail"
      ? row(id, { status: "failed", endedAt: minutes(4), failure: "pnpm test exited 1" })
      : id.startsWith("cap")
        ? row(id, { capped: { placeId: "here", place: "acme's laptop", running: 6, atOnce: 6 } })
        : row(id);
/** Six more children of the lead the transcript's calls never name, so the list the store holds is past twelve. */
const MORE = Array.from({ length: 6 }, (_, i) => row(`more${i}`, { status: "completed", endedAt: minutes(30 + i) }));

const leadRow = (subagents: SubagentView[]): SessionView => ({ ...row("lead", { parentThreadId: undefined, rootThreadId: undefined, startedBy: "person", threadId: LEAD, prompt: "Run the marathon" }), subagents });

function seed(children: SessionView[], subagents: SubagentView[] = [subagent("map"), subagent("hdr", { state: "failed", endedAt: minutes(0.5), failure: "WebFetch could not reach the site" })]): void {
  useStore.setState({ workspaces: [workspace], sessions: { [WS]: [leadRow(subagents), ...children] }, statuses: {}, landings: {}, places: [] } as never);
}

const threadCalls = (ids: string[]): SpawnCall[] => ids.map(id => ({ id: `call_${id}`, thread: `thr_${id}` }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  drawn.rows = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the marathon lead's transcript", () => {
  /** The lead's turn as its agent wrote it: eight runs answered with the threads they opened, its reply, two Agent
   * calls with their subagents' lines, and the question it is stopped on. */
  const scope = { workspaceId: WS, sessionId: "s_lead", threadId: LEAD, turnId: "turn_lead" };
  const events: SessionEvent[] = [
    { type: "session.start", ...scope, at: minutes(2), prompt: "Run the marathon" },
    ...EIGHT.flatMap((id): SessionEvent[] => [
      { type: "session.delta", ...scope, at: minutes(2), kind: "tool_use", toolName: "mcp__wsp__run", toolUseId: `tu_run_${id}`, text: JSON.stringify({ project: "lab", message: id, notify: "me", detach: true }) },
      { type: "session.delta", ...scope, at: minutes(2), kind: "tool_result", toolUseId: `tu_run_${id}`, text: JSON.stringify({ threadId: `thr_${id}`, workspaceId: WS, harness: "claude", outcome: "started" }) },
    ]),
    { type: "session.delta", ...scope, at: minutes(2), kind: "text", text: "Eight threads are out." },
    ...["map", "hdr"].flatMap((id): SessionEvent[] => [
      { type: "session.delta", ...scope, at: minutes(1), kind: "tool_use", toolName: "Agent", toolUseId: `tu_${id}`, text: JSON.stringify({ description: `Subagent ${id}`, prompt: id, subagent_type: "Explore" }) },
      { type: "session.subagent", ...scope, at: minutes(1), task: id, state: "running", parentToolUseId: `tu_${id}`, title: `Subagent ${id}` },
      { type: "session.delta", ...scope, at: minutes(1), kind: "text", text: "Reading.", parentToolUseId: `tu_${id}` },
    ]),
    { type: "session.permission", ...scope, at: minutes(0), askId: "ask_next", toolName: "AskUserQuestion", toolUseId: "tu_next", input: "{}", options: [{ id: "a", label: "A", effect: "answer" }] },
  ];

  it("shows its eight threads and its two subagents as two lists at their calls, in the order it started them", () => {
    seed(EIGHT.map(childRow));
    const model = deriveSession(events);
    const children = { lead: LEAD, threads: new Set(EIGHT.map(id => `thr_${id}`)), subagents: new Set(["tu_map", "tu_hdr"]) };
    const rows = deriveMessagesTimelineRows({ timelineEntries: model.timeline, turns: model.turns, isWorking: true, activeTurnStartedAt: null, children });
    const spawns = rows.flatMap(r => (r.kind === "spawn" ? [r] : []));
    expect(spawns).toHaveLength(2);
    // The runs, the reply under them, then the Agent calls: each list at its calls.
    const reply = rows.findIndex(r => r.kind === "message" && r.message.text === "Eight threads are out.");
    expect(rows.indexOf(spawns[0]!)).toBeLessThan(reply);
    expect(rows.indexOf(spawns[1]!)).toBeGreaterThan(reply);
    const [threads, subagents] = spawns;
    const { container } = render(
      <>
        <SpawnTiles calls={threads!.calls} leadKey={LEAD} />
        <SpawnTiles calls={subagents!.calls} leadKey={LEAD} />
      </>,
    );
    const lists = [...container.querySelectorAll<HTMLElement>("[data-spawn-tiles]")];
    expect(lists).toHaveLength(2);
    expect([...lists[0]!.children].map(el => el.getAttribute("data-thread-row"))).toEqual(EIGHT.map(id => `thr_${id}`));
    expect([...lists[1]!.children].map(el => el.getAttribute("data-subagent-row"))).toEqual(["map", "hdr"]);
    // One column with no gap, adding no inset of its own, so each mark stands at the x the Threads rows give it.
    for (const list of lists) {
      expect(list.className.split(" ")).toEqual(expect.arrayContaining(["flex", "flex-col"]));
      expect(list.className).not.toMatch(/(^|\s)(gap|space-y|p[xylrtbse]?|m[xylrtbse]?)-/);
    }
  });

  it("draws the two lists in the lead's own transcript, read off the store by the lead's id, and none in a thread with no id", () => {
    seed(EIGHT.map(childRow));
    const model = deriveSession(events);
    const props = { isWorking: true, activeTurnStartedAt: null, listRef: createRef<LegendListRef | null>(), timelineEntries: model.timeline, turns: model.turns, onImageExpand: () => {}, markdownCwd: undefined, resolvedTheme: "dark" as const, timestampFormat: "locale" as const, workspaceRoot: undefined };
    const restore = installFakeLayout();
    try {
      const lead = render(<MessagesTimeline {...props} threadKey={`${WS}/${LEAD}`} />);
      expect(lead.container.querySelectorAll("[data-spawn-tiles]")).toHaveLength(2);
      expect(lead.container.querySelectorAll("[data-spawn-tiles] [data-thread-row]")).toHaveLength(8);
      expect(lead.container.querySelectorAll("[data-spawn-tiles] [data-subagent-row]")).toHaveLength(2);
      lead.unmount();
      const bare = render(<MessagesTimeline {...props} threadKey={WS} />);
      expect(bare.container.querySelectorAll("[data-spawn-tiles]")).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("draws each row as the Threads list does: the asking line, the failure, the hold and the subagent's failure under the titles", () => {
    seed(EIGHT.map(childRow));
    render(<SpawnTiles calls={[...threadCalls(EIGHT), { id: "call_hdr", subagent: "tu_hdr" }]} leadKey={LEAD} />);
    const note = (sel: string) => document.querySelector(`${sel} [data-tree-note]`)?.textContent;
    expect(note('[data-thread-row="thr_ask"]')).toBe("Run pnpm install --frozen-lockfile");
    expect(note('[data-thread-row="thr_fail"]')).toBe("pnpm test exited 1");
    expect(note('[data-thread-row="thr_cap1"]')).toContain("6 of 6");
    expect(note('[data-subagent-row="hdr"]')).toBe("WebFetch could not reach the site");
    expect(document.querySelector('[data-thread-row="thr_sec"] [data-tree-note]')).toBeNull();
  });
});

describe("a child's tile", () => {
  it("stands at its call once its child finished or settled, in its own state", () => {
    seed([row("done", { status: "completed", endedAt: minutes(3) }), row("old", { status: "completed", startedAt: minutes(600), endedAt: minutes(590), readAt: minutes(580), settledAt: minutes(570) })]);
    render(<SpawnTiles calls={threadCalls(["done", "old"])} leadKey={LEAD} />);
    expect(document.querySelector('[data-thread-row="thr_done"]')?.getAttribute("data-child-part")).toBe("finished");
    expect(document.querySelector('[data-thread-row="thr_old"]')?.getAttribute("data-child-part")).toBe("settled");
  });

  it("says nothing of a branch, a push or a merge for a child on its own branch or on the lead's", () => {
    const fork: WorkspaceView = { ...workspace, id: "ws_fork", name: "fork" };
    const tree = { leadBranch: "main", children: [{ workspaceId: "ws_fork", branch: "fix/cart", pushed: false, aheadOfLead: 2, conflicts: ["a.ts"], pushRefused: "no git credential" }], readAt: 1 };
    useStore.setState({
      workspaces: [workspace, fork],
      sessions: { [WS]: [leadRow([]), row("sec")], ws_fork: [row("own", { workspaceId: "ws_fork", status: "completed", endedAt: minutes(2) })] },
      statuses: { [WS]: { ...workspace, machineState: "running", reach: { state: "reachable" }, tree } },
      landings: {},
      places: [],
    } as never);
    render(<SpawnTiles calls={threadCalls(["sec", "own"])} leadKey={LEAD} />);
    const rows = [...document.querySelectorAll<HTMLElement>("[data-thread-row]")];
    expect(rows).toHaveLength(2);
    for (const tile of rows) {
      expect(tile.textContent).not.toMatch(/fix\/cart|main|ahead|push|merge|conflict|credential/i);
      expect(tile.querySelectorAll("button:not([data-child-act])")).toHaveLength(0);
    }
  });

  it("opens its child on a press", () => {
    seed(EIGHT.map(childRow));
    const select = vi.fn();
    useStore.setState({ select } as never);
    render(<SpawnTiles calls={threadCalls(["sec"])} leadKey={LEAD} />);
    fireEvent.click(document.querySelector('[data-thread-row="thr_sec"]')!);
    expect(select).toHaveBeenCalledWith(WS, "thr_sec");
  });

  it("draws nothing for a call whose child left the listing", () => {
    seed([]);
    const { container } = render(<SpawnTiles calls={threadCalls(["gone"])} leadKey={LEAD} />);
    expect(container.querySelector("[data-spawn-tiles]")!.children).toHaveLength(0);
  });

  it("redraws its own tile alone when its child moves from working to finished", () => {
    const children = [...EIGHT.map(childRow), ...MORE];
    seed(children);
    render(<SpawnTiles calls={threadCalls(EIGHT)} leadKey={LEAD} />);
    expect(document.querySelectorAll("[data-thread-row]")).toHaveLength(8);
    drawn.rows = [];
    act(() => {
      seed(children.map(r => (r.threadId === "thr_sheet" ? { ...r, status: "completed", endedAt: NOW } : { ...r })));
    });
    expect(drawn.rows).toEqual(["thr_sheet"]);
    expect(document.querySelector('[data-thread-row="thr_sheet"]')?.getAttribute("data-child-part")).toBe("finished");
  });
});
