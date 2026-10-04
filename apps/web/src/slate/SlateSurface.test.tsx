// SPDX-License-Identifier: AGPL-3.0-only
// The Slate tab against a fake host: keyed by the selected thread, every empty state, a fetch on session.slate,
// the tab opened once on the agent's first write, and state pushes folded in place.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "../protocol/client";
import { useStore } from "../protocol/store";
import { useRightPanelStore } from "../rightPanelStore";
import { SlateSurface } from "./SlateSurface";
import { useSlateStore } from "./store";
import { slate } from "./testing";
import type { SlateApi, SlateRecord } from "./wire";

const DOC = slate({
  root: "root",
  title: "Progress",
  values: { step: { start: "one" } },
  pieces: {
    root: { type: "column", children: ["said", "where"] },
    said: { type: "text", props: { value: "First version" } },
    where: { type: "text", props: { value: { format: "on step ${$step}" } } },
  },
});

function record(over: Partial<SlateRecord> = {}): SlateRecord {
  return { threadId: "t1", workspaceId: "ws", version: 1, document: DOC, values: { step: "one" }, comments: [], approvals: {}, asks: [], problems: [], shownOnce: true, canUndo: false, rewound: false, updatedAt: 1, ...over };
}

const ROW: SessionView = { id: "s1", workspaceId: "ws", harness: "claude", status: "completed", threadId: "t1" };

function host(answers: (SlateRecord | null | { newer: number })[]): SlateApi & { calls: string[] } {
  const calls: string[] = [];
  let at = 0;
  return {
    calls,
    get: vi.fn(async () => {
      calls.push("get");
      const answer = answers[Math.min(at++, answers.length - 1)] ?? null;
      return answer !== null && "newer" in answer ? { record: record({ document: null }), newer: answer.newer } : { record: answer };
    }),
    state: vi.fn(async () => ({ version: 2 })),
    event: vi.fn(async () => ({ outcome: "started" as const, said: "Sent" })),
    approve: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    sketch: vi.fn(async () => ""),
    shown: vi.fn(async () => {
      calls.push("shown");
    }),
    undo: vi.fn(async () => ({ version: 2 })),
    clear: vi.fn(async () => ({ version: 2 })),
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    resolve: vi.fn(async () => ({})),
  };
}

function select(slates: SlateApi, threadId: string | null) {
  useStore.setState({ api: { slates, subscribe: () => () => {} } as unknown as Api, selectedId: "ws", selectedThreadId: threadId, sessions: { ws: [ROW] } });
}

const event = (e: Record<string, unknown>) => act(() => useStore.getState().applyEvent(e as unknown as ProtocolEvent));

beforeEach(() => {
  useSlateStore.setState({ byThread: {}, asking: {}, seen: {}, lastTurn: {} });
  useRightPanelStore.setState({ byWorkspaceId: {} });
});
afterEach(cleanup);

describe("the Slate tab", () => {
  it("asks for a thread when none is open", () => {
    select(host([null]), null);
    render(<SlateSurface />);
    expect(screen.getByText("Pick a thread to see its slate.")).toBeTruthy();
  });

  it("says nothing is here yet for a thread with no slate, with a way to ask for one", async () => {
    select(host([null]), "t1");
    render(<SlateSurface />);
    expect(await screen.findByText("Nothing here yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask for one" })).toBeTruthy();
  });

  it("says a slate was cleared, and offers Undo while there is one", async () => {
    select(host([record({ document: null, empty: "cleared", canUndo: true })]), "t1");
    render(<SlateSurface />);
    expect(await screen.findByText(/^Cleared\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("says a rewind went back to before the slate existed", async () => {
    select(host([record({ document: null, empty: "rewound-before" })]), "t1");
    render(<SlateSurface />);
    expect(await screen.findByText(/^Rewound to before this slate existed\./)).toBeTruthy();
  });

  it("says a slate newer than this build needs a newer wsp, and draws none of it", async () => {
    select(host([{ newer: 3 }]), "t1");
    render(<SlateSurface />);
    expect(await screen.findByText(/needs a newer wsp \(schema 3\)/)).toBeTruthy();
    expect(screen.queryByText("First version")).toBeNull();
  });

  it("draws the selected thread's slate and fetches it again on session.slate", async () => {
    const slates = host([record(), record({ version: 2, document: { ...DOC, pieces: { ...DOC.pieces, said: { type: "text", props: { value: "Second version" } } } } })]);
    select(slates, "t1");
    render(<SlateSurface />);
    expect(await screen.findByText("First version")).toBeTruthy();
    expect(screen.getByText("Progress")).toBeTruthy();
    expect(screen.getByText("v1")).toBeTruthy();
    event({ type: "session.slate", workspaceId: "ws", sessionId: "s1", threadId: "t1", cause: "patch", version: 2, by: "agent", pieces: ["said"] });
    expect(await screen.findByText("Second version")).toBeTruthy();
    expect(slates.calls.filter(c => c === "get")).toHaveLength(2);
  });

  it("folds a slate.values push into what is drawn without a fetch", async () => {
    const slates = host([record()]);
    select(slates, "t1");
    render(<SlateSurface />);
    expect(await screen.findByText("on step one")).toBeTruthy();
    event({ type: "slate.values", workspaceId: "ws", threadId: "t1", version: 2, values: { $step: "two" } });
    expect(await screen.findByText("on step two")).toBeTruthy();
    expect(slates.calls.filter(c => c === "get")).toHaveLength(1);
  });

  it("opens the tab once on the agent's first write to the open thread, and tells the host", async () => {
    const slates = host([record({ shownOnce: false })]);
    select(slates, "t1");
    event({ type: "session.slate", workspaceId: "ws", sessionId: "s1", threadId: "t1", cause: "set", version: 1, by: "agent", pieces: ["root"] });
    await waitFor(() => expect(slates.shown).toHaveBeenCalledWith("t1"));
    const panel = useRightPanelStore.getState().byWorkspaceId["ws"];
    expect(panel?.isOpen).toBe(true);
    expect(panel?.activeSurfaceId).toBe("slate");
    // A second write does not move the panel again: the person moved it back to another tab.
    useRightPanelStore.getState().open("ws", "diff");
    event({ type: "session.slate", workspaceId: "ws", sessionId: "s1", threadId: "t1", cause: "patch", version: 2, by: "agent", pieces: ["root"] });
    await waitFor(() => expect(slates.calls.filter(c => c === "get")).toHaveLength(2));
    expect(useRightPanelStore.getState().byWorkspaceId["ws"]?.activeSurfaceId).toBe("diff");
    expect(slates.shown).toHaveBeenCalledTimes(1);
  });

  it("does not open the tab for a write to a thread the centre does not show", async () => {
    const slates = host([record({ shownOnce: false })]);
    select(slates, "t1");
    event({ type: "session.slate", workspaceId: "ws", sessionId: "s2", threadId: "t2", cause: "set", version: 1, by: "agent", pieces: ["root"] });
    await waitFor(() => expect(slates.calls).toContain("get"));
    expect(slates.shown).not.toHaveBeenCalled();
    expect(useRightPanelStore.getState().byWorkspaceId["ws"]?.activeSurfaceId ?? null).toBeNull();
  });
});
