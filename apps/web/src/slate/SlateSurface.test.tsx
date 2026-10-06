// SPDX-License-Identifier: AGPL-3.0-only
// The Slate tab against a fake host: keyed by the selected thread, every empty state, a fetch on session.slate,
// the tab opened once on the agent's first write, and state pushes folded in place.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "../protocol/client";
import { useStore } from "../protocol/store";
import { useRightPanelStore } from "../rightPanelStore";
import { SlateSurface } from "./SlateSurface";
import { useSlateStore } from "./store";
import { slate } from "./testing";
import { COALESCE_MS } from "./pieces/press";
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

// The engines live for the window's life, so across this file's tests: every record and push is newer than the last.
let revision = 0;

function record(over: Partial<SlateRecord> = {}): SlateRecord {
  return { threadId: "t1", workspaceId: "ws", version: 1, revision: (revision += 1), document: DOC, values: { step: "one" }, comments: [], approvals: {}, asks: [], problems: [], shownOnce: true, canUndo: false, updatedAt: 1, ...over };
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
    revoke: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    resolve: vi.fn(async () => ({})),
  };
}

function select(slates: SlateApi, threadId: string | null) {
  useStore.setState({ api: { slates, subscribe: () => () => {} } as unknown as Api, selectedId: "ws", selectedThreadId: threadId, sessions: { ws: [ROW] } });
}

const event = (e: Record<string, unknown>) => act(() => useStore.getState().applyEvent(e as unknown as ProtocolEvent));

beforeEach(() => {
  useSlateStore.setState({ byThread: {}, asking: {}, seen: {}, lastTurn: {}, linking: {} });
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
    expect(document.querySelector("[data-slate-version]")!.getAttribute("data-slate-version")).toBe("1");
    event({ type: "session.slate", workspaceId: "ws", sessionId: "s1", threadId: "t1", cause: "patch", version: 2, by: "agent", pieces: ["said"] });
    expect(await screen.findByText("Second version")).toBeTruthy();
    expect(slates.calls.filter(c => c === "get")).toHaveLength(2);
  });

  it("folds a slate.values push into what is drawn without a fetch", async () => {
    const slates = host([record()]);
    select(slates, "t1");
    render(<SlateSurface />);
    expect(await screen.findByText("on step one")).toBeTruthy();
    event({ type: "slate.values", workspaceId: "ws", threadId: "t1", version: 1, revision: (revision += 1), values: { $step: "two" } });
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

describe("a link a press opens", () => {
  const LINKED = slate({
    root: "root",
    pieces: { root: { type: "column", children: ["go"] }, go: { type: "button", props: { label: "Continue" }, on: { press: [{ do: "open", target: "https://example.com/x?d=1" }] } } },
  });

  it("names its domain on hover and asks once per domain before opening it", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const api = host([record({ document: LINKED, values: {} })]);
    select(api, "t1");
    render(<SlateSurface />);
    const button = await screen.findByRole("button", { name: "Continue" });
    expect(button.getAttribute("title")).toBe("Opens example.com");
    fireEvent.click(button);
    expect(await screen.findByText("Open example.com from this slate?")).toBeTruthy();
    expect(opened).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Always for this domain" }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith("https://example.com/x?d=1", "_blank", "noopener,noreferrer"));
    expect(api.approve).toHaveBeenCalledWith("t1", "domain:example.com", "thread");
    opened.mockRestore();
  });

  it("opens nothing and allows nothing on Don't, and opens once with no standing allowance on Open once", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const api = host([record({ document: LINKED, values: {} })]);
    select(api, "t1");
    render(<SlateSurface />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Don't" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opened).not.toHaveBeenCalled();
    // A second press inside the double-press window is the same press, so the next one waits it out.
    await act(async () => new Promise(r => setTimeout(r, COALESCE_MS + 50)));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open once" }));
    expect(opened).toHaveBeenCalledWith("https://example.com/x?d=1", "_blank", "noopener,noreferrer");
    expect(api.approve).not.toHaveBeenCalled();
    opened.mockRestore();
  });

  it("opens a domain this thread was allowed with no prompt", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    select(host([record({ document: LINKED, values: {}, approvals: { "domain:example.com": { state: "allowed", at: 1 } } })]), "t1");
    render(<SlateSurface />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Open example.com from this slate?")).toBeNull();
    opened.mockRestore();
  });
});

describe("the tab's Approvals", () => {
  it("stops every running run from the menu, and leaves the rest", async () => {
    const runDoc = slate({ title: "Runs", runs: { a: { kind: "cmd", cmd: "sleep 9" }, b: { kind: "cmd", cmd: "true" } }, root: "root", pieces: { root: { type: "column", children: ["said"] }, said: { type: "text", props: { value: "Runs" } } } });
    const api = host([record({ threadId: "t7", document: runDoc, values: { a: { state: "running", runs: 1 }, b: { state: "done", exit: 0, runs: 1 } } })]);
    select(api, "t7");
    render(<SlateSurface />);
    fireEvent.click(await screen.findByRole("button", { name: "Slate menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop runs" }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("t7", "a"));
    expect(api.cancel).toHaveBeenCalledTimes(1);
  });

  it("asks before forgetting the slate's secrets, and forgets nothing until the person says so", async () => {
    const secretDoc = slate({ title: "Deploy", values: { token: { start: "", secret: true } }, root: "root", pieces: { root: { type: "column", children: ["said"] }, said: { type: "text", props: { value: "Deploy" } } } });
    const api = host([record({ threadId: "t9", document: secretDoc, values: {} })]);
    select(api, "t9");
    render(<SlateSurface />);
    fireEvent.click(await screen.findByRole("button", { name: "Slate menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Forget secrets" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Forget this slate's secrets?" });
    expect(api.state).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Forget secrets" })));
    await waitFor(() => expect(api.state).toHaveBeenCalledWith("t9", { $token: "" }));
  });

  it("shows what the host refused: a revoke keeps its row and says why, a refused Clear says why under the title", async () => {
    const api = host([record({ threadId: "t8", approvals: { k1: { state: "allowed", at: 1, run: "deploy", cmd: "bash deploy.sh" } } })]);
    api.revoke = vi.fn(async () => Promise.reject(new Error("the host is restarting")));
    api.clear = vi.fn(async () => Promise.reject(new Error("the slate moved on; read it again")));
    select(api, "t8");
    render(<SlateSurface />);
    fireEvent.click(await screen.findByRole("button", { name: "Slate menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Clear" }));
    expect(await screen.findByText("the slate moved on; read it again")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Slate menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Approvals" }));
    await act(async () => fireEvent.click(document.querySelector<HTMLElement>('[data-slate-revoke="k1"]')!));
    expect(await screen.findByText("the host is restarting")).toBeTruthy();
    expect(document.querySelector('[data-slate-revoke="k1"]')).not.toBeNull();
  });

  it("lists each standing approval as a row with Revoke, and revoking asks the host", async () => {
    const api = host([
      record({ approvals: { k1: { state: "allowed", at: 1, run: "deploy", cmd: "bash deploy.sh" }, "domain:example.com": { state: "allowed", at: 2, cmd: "links to example.com" }, k2: { state: "refused", at: 3, run: "x", cmd: "rm -rf x" } } }),
      record({ approvals: { "domain:example.com": { state: "allowed", at: 2, cmd: "links to example.com" }, k2: { state: "refused", at: 3, run: "x", cmd: "rm -rf x" } } }),
    ]);
    select(api, "t1");
    render(<SlateSurface />);
    fireEvent.click(await screen.findByRole("button", { name: "Slate menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Approvals" }));
    expect(await screen.findByText("Approvals in this thread")).toBeTruthy();
    expect(screen.getByText("bash deploy.sh")).toBeTruthy();
    expect(screen.getByText("links to example.com")).toBeTruthy();
    // A refused one stands too, saying so, so a refusal can be undone from here.
    expect(screen.getByText("rm -rf x")).toBeTruthy();
    expect(screen.getByText("Refused. Run $x")).toBeTruthy();
    fireEvent.click(document.querySelector<HTMLElement>('[data-slate-revoke="k1"]')!);
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith("t1", "k1"));
    // The record read again after the revoke no longer holds it, and its row goes.
    await waitFor(() => expect(screen.queryByText("bash deploy.sh")).toBeNull());
    expect(screen.getByText("links to example.com")).toBeTruthy();
  });
});
