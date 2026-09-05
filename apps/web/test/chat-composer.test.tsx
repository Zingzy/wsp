// SPDX-License-Identifier: AGPL-3.0-only
// The composer on its own: keys, the slash menu over the harness catalog, the
// disabled reasons, and the draft that outlives a tab switch. Same fixture api
// shape as chat.test.tsx; no live daemon.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventUnion, SessionEvent, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { composerEditor, isEditable, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ConnStatus, ProtocolEvent } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { composerUnavailableReason } from "../src/components/chat/ChatComposer.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { CHAT_STREAM, CHAT_TURN, CHAT_WS } from "./fixtures/chat-stream.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => useComposerDraftStore.setState({ drafts: {} }));

const WS = CHAT_WS;
const scope = { workspaceId: WS, sessionId: "sess_0001", turnId: CHAT_TURN };
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
  claudeSessionId: "e16ed170-8257-4668-879e-fe836341633c",
};

function fixtureApi(workspaces: WorkspaceView[], history: Record<string, SessionEvent[]> = {}, statuses: WorkspaceStatus[] = []) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: Array<{ workspaceId: string; prompt: string; resume?: string }> = [];
  const interrupted: string[] = [];
  const api: Api = {
    interruptSession: async id => { interrupted.push(id); return "accepted"; },
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    builderReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async id => history[id] ?? [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true }),
    listSessions: async () => [],
    watchStatuses: async () => statuses,
    createFromGoldenHead: async () => workspaces[0]!,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
    startSession: async opts => {
      started.push(opts);
      return { id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: 0 };
    },
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, started, interrupted, emit };
}

async function setup(api: Api, conn: ConnStatus = "live") {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {} });
  useStore.getState().bind(api);
  useStore.getState().setConn(conn);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  const view = render(<WorkspaceThread workspaceId={WS} />);
  await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
  return view;
}

const draft = () => useComposerDraftStore.getState().drafts[WS]?.prompt ?? "";
const sendButton = () => screen.getByRole("button", { name: /Send message|Turn in flight|wsp|Workspace|Loading|Connecting/ }) as HTMLButtonElement;
const menuItem = (name: string) => document.querySelector<HTMLElement>(`[data-composer-item-id="provider-slash-command:claude:${name}"]`);
const menuDrawer = () => document.querySelector<HTMLElement>("[data-composer-command-drawer]");

describe("composer keys", () => {
  it("shift+enter inserts a newline instead of sending", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "line one");
    await press(editor, "Enter", { shiftKey: true });
    await waitFor(() => expect(draft()).toBe("line one\n"));
    expect(started.length).toBe(0);
    await typeInto(editor, "line two");
    expect(draft()).toBe("line one\nline two");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]?.prompt).toBe("line one\nline two");
  });

  it("escape with no menu leaves the draft", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "never mind");
    expect(draft()).toBe("never mind");
    await press(editor, "Escape");
    expect(editor.textContent).toBe("never mind");
    expect(draft()).toBe("never mind");
    expect(started.length).toBe(0);
  });

  it("keeps the draft across a tab switch", async () => {
    const { api } = fixtureApi([workspace]);
    const view = await setup(api);
    await typeInto(composerEditor(), "half a thought");
    view.unmount();
    render(<WorkspaceThread workspaceId={WS} />);
    await waitFor(() => expect(composerEditor().textContent).toBe("half a thought"));
  });

  it("does not let undo pull another workspace's draft across a switch", async () => {
    const other: WorkspaceView = { ...workspace, id: "ws_chat0002", name: "web", claudeSessionId: undefined };
    const { api } = fixtureApi([workspace, other]);
    const view = await setup(api);
    await typeInto(composerEditor(), "alpha draft");
    view.rerender(<WorkspaceThread workspaceId={other.id} />);
    await waitFor(() => expect(screen.queryByText("loading transcript")).toBeNull());
    const editor = composerEditor();
    expect(editor.textContent).toBe("");
    editor.focus();
    await press(editor, "z", { ctrlKey: true });
    await press(editor, "z", { metaKey: true });
    expect(editor.textContent).toBe("");
    expect(useComposerDraftStore.getState().drafts[other.id]?.prompt ?? "").toBe("");
    expect(draft()).toBe("alpha draft");
  });

  it("sends nothing on the Enter that commits an IME composition", async () => {
    const { api, started } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "日本");
    fireEvent.compositionStart(editor);
    await press(editor, "Enter", { isComposing: true });
    expect(started.length).toBe(0);
    expect(draft()).toBe("日本");
    fireEvent.compositionEnd(editor);
    // Some engines deliver the committing Enter after compositionend with the legacy 229 code and no flag.
    await press(editor, "Enter", { keyCode: 229 });
    expect(started.length).toBe(0);
    expect(draft()).toBe("日本");
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]?.prompt).toBe("日本");
  });
});

describe("composer slash menu", () => {
  it("opens at prompt start with the static catalog before any session, and inserts the pick", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuItem("model")).not.toBeNull());
    expect(screen.getByText("Show or change the model for this session")).toBeDefined();
    await press(editor, "Enter");
    await waitFor(() => expect(draft()).toBe("/model "));
    expect(menuItem("model")).toBeNull();
    expect(editor.textContent).toBe("/model ");
  });

  it("lists the commands the session announced, filters as you type, arrows move the highlight, tab picks", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
    for (const name of ["context", "cost", "init", "review"]) expect(menuItem(name)).not.toBeNull();
    expect(menuItem("model")).toBeNull();

    // The shortest prefix match ranks first, so "co" puts cost ahead of compact and context.
    await typeInto(editor, "co");
    await waitFor(() => expect(menuItem("init")).toBeNull());
    const listed = () => [...document.querySelectorAll("[data-composer-item-id]")].map(el => el.getAttribute("data-composer-item-id")?.split(":").pop());
    expect(listed()).toEqual(["cost", "compact", "context"]);
    expect(menuItem("cost")?.className).toContain("bg-accent!");
    await press(editor, "ArrowDown");
    await waitFor(() => expect(menuItem("compact")?.className).toContain("bg-accent!"));
    expect(menuItem("cost")?.className).not.toContain("bg-accent!");
    await press(editor, "Tab");
    await waitFor(() => expect(draft()).toBe("/compact "));
    expect(listed()).toEqual([]);
    expect(started.length).toBe(0);
    await press(editor, "Enter");
    await waitFor(() => expect(started.length).toBe(1));
    expect(started[0]?.prompt).toBe("/compact");
  });

  it("stays closed for a slash after the prompt start", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "see /");
    await waitFor(() => expect(draft()).toBe("see /"));
    expect(menuDrawer()).toBeNull();
    // A slash opening a later line is a line the CLI reads as text, so no menu there either.
    await press(editor, "Enter", { shiftKey: true });
    await typeInto(editor, "/");
    await waitFor(() => expect(draft()).toBe("see /\n/"));
    expect(menuDrawer()).toBeNull();
  });

  it("escape dismisses the menu, keeps the draft, and the menu returns when the query changes", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuItem("model")).not.toBeNull());
    await press(editor, "Escape");
    await waitFor(() => expect(menuDrawer()).toBeNull());
    expect(draft()).toBe("/");
    await typeInto(editor, "m");
    await waitFor(() => expect(menuItem("model")).not.toBeNull());
  });
});

describe("composer while the workspace is not live", () => {
  it("disables the editor with the reason while the workspace naps", async () => {
    const { api } = fixtureApi([{ ...workspace, phase: "napping" }]);
    await setup(api);
    expect(isEditable(composerEditor())).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("Workspace is napping; wake it to send");
    expect(sendButton().getAttribute("aria-label")).toBe("Workspace is napping; wake it to send");
    expect(sendButton().disabled).toBe(true);
  });

  it("disables the editor while the runtime socket is down and comes back with it", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api, "reconnecting");
    expect(isEditable(composerEditor())).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("wsp is not running, reconnecting");
    act(() => useStore.getState().setConn("live"));
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers stop while a turn streams and names the running turn as what blocks a send", async () => {
    const { api, emit, interrupted } = fixtureApi([workspace]);
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "go" });
    emit({ type: "session.delta", ...scope, kind: "text", text: "on it" });
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeDefined();
    expect(interrupted).toEqual([]);
    expect(screen.queryByRole("button", { name: /Send message|Turn in flight/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Turn in flight");
    expect(isEditable(composerEditor())).toBe(true);
    await typeInto(composerEditor(), "follow up");
    await press(composerEditor(), "Enter");
    expect(draft()).toBe("follow up");
    emit({ type: "session.done", ...scope, result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    emit({ type: "session.end", ...scope, exitCode: 0, sawResult: true });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
  });
});

describe("composerUnavailableReason", () => {
  const live = { conn: "live" as const, hasApi: true, phase: "running" as const, machineState: "running" as const, hydrated: true, finishing: false };
  it("names the first thing in the way, socket first", () => {
    expect(composerUnavailableReason(live)).toBeNull();
    expect(composerUnavailableReason({ ...live, hasApi: false })).toBe("Connecting to wsp");
    expect(composerUnavailableReason({ ...live, conn: "connecting" })).toBe("Connecting to wsp");
    expect(composerUnavailableReason({ ...live, conn: "reconnecting", phase: "napping" })).toBe("wsp is not running, reconnecting");
    expect(composerUnavailableReason({ ...live, conn: "closed" })).toBe("wsp is not running");
    expect(composerUnavailableReason({ ...live, phase: null })).toBe("Workspace not found");
    expect(composerUnavailableReason({ ...live, machineState: "gone" })).toBe("Workspace machine is gone");
    expect(composerUnavailableReason({ ...live, phase: "napping" })).toBe("Workspace is napping; wake it to send");
    expect(composerUnavailableReason({ ...live, phase: "waking" })).toBe("Workspace is waking");
    expect(composerUnavailableReason({ ...live, hydrated: false })).toBe("Loading transcript");
    expect(composerUnavailableReason({ ...live, finishing: true })).toBe("Finishing the previous turn");
    expect(composerUnavailableReason({ ...live, hydrated: false, finishing: true })).toBe("Loading transcript");
    expect(composerUnavailableReason({ ...live, machineState: null })).toBeNull();
  });
});
