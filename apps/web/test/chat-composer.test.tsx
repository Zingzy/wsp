// SPDX-License-Identifier: AGPL-3.0-only
// The composer on its own: keys, the slash menu over the harness catalog, the
// disabled reasons, and the draft that outlives a tab switch. Same fixture api
// shape as chat.test.tsx; no live daemon.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { screenCommandLine, sendRefusal, stillWorkingLine, type EventUnion, type HarnessCatalog, type SessionEvent, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { composerEditor, isEditable, press, typeInto } from "./composer-harness.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ConnStatus, ProtocolEvent, StartSessionOptions } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { composerSendBlock } from "../src/components/chat/ChatComposer.js";
import { SEND_LABEL, WAKE_AND_SEND_LABEL } from "../src/components/chat/ComposerPrimaryActions.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { requestComposerFocus, requestNewThread } from "../src/shell/shellRequests.js";
import { CHAT_HARNESS, CHAT_STREAM, CHAT_TURN, CHAT_WS } from "./fixtures/chat-stream.js";
import { caps } from "./caps.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => useComposerDraftStore.setState({ drafts: {}, queues: {} }));

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

/** The runtime's row for the composer's harness, as the table serves it before a machine answers: the commands that
 * work only in the CLI's own terminal ride it, so the menu and the send read them before any session ran. */
const SCREEN_COMMANDS = [
  { name: "login", control: "sign-in" as const },
  { name: "logout", control: "sign-in" as const },
  { name: "model", control: "model" as const },
  { name: "permissions", control: "access" as const },
  { name: "config", control: "settings" as const },
  { name: "help", control: "docs" as const },
];
const CLAUDE_CATALOG: HarnessCatalog = { harness: "claude", label: "Claude Code", source: "table", version: null, models: [], efforts: [], contextWindows: [], permissionModes: [], steers: false, renames: false, images: false, screenCommands: SCREEN_COMMANDS };

function fixtureApi(workspaces: WorkspaceView[], history: Record<string, SessionEvent[]> = {}, statuses: WorkspaceStatus[] = []) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const started: StartSessionOptions[] = [];
  const interrupted: string[] = [];
  const api: Api = {
    interruptSession: async id => { interrupted.push(id); return "accepted"; },
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async id => history[id] ?? [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => (caps()),
    listSessions: async () => [],
    listHarnesses: async () => [CLAUDE_CATALOG],
    watchStatuses: async () => statuses,
    createFromGoldenHead: async () => workspaces[0]!,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
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
const sendButton = () => screen.getByRole("button", { name: /Send message|Wake and send|Turn in flight|wsp|Workspace|Loading|Connecting/ }) as HTMLButtonElement;
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

  it("takes the caret when a workspace switch asks for it, and leaves it alone when another workspace is asked for", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).not.toBe(editor);
    act(() => requestComposerFocus("ws_chat9999"));
    expect(document.activeElement).not.toBe(editor);
    act(() => requestComposerFocus(WS));
    await waitFor(() => expect(document.activeElement).toBe(editor));
  });

  it("takes a caret asked for before it mounted", async () => {
    const { api } = fixtureApi([workspace]);
    requestComposerFocus(WS);
    await setup(api);
    await waitFor(() => expect(document.activeElement).toBe(composerEditor()));
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

/** The session's announcement with the CLI's screen-only commands in it, as a real init lists them beside the ones that run. */
const SCREEN_NAMES = SCREEN_COMMANDS.map(c => c.name);
const ANNOUNCED = [...CHAT_HARNESS.slashCommands, ...SCREEN_NAMES, "my-skill"];
const STREAM_WITH_SCREENS: SessionEvent[] = CHAT_STREAM.map(e => (e.type === "session.start" ? { ...e, harness: { ...CHAT_HARNESS, slashCommands: ANNOUNCED } } : e));
const listed = () => [...document.querySelectorAll("[data-composer-item-id]")].map(el => el.getAttribute("data-composer-item-id")?.split(":").pop());

describe("composer slash menu", () => {
  it("opens at prompt start before any session with the harness's seed, which offers nothing a headless turn cannot run", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuDrawer()).not.toBeNull());
    expect(listed()).toEqual([]);
    expect(menuItem("model")).toBeNull();
  });

  it("offers what the session announced less the commands that work only in the CLI's own terminal, and every custom one", async () => {
    const { api } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
    expect(listed()).toEqual([...CHAT_HARNESS.slashCommands, "my-skill"]);
    for (const name of SCREEN_NAMES) expect(menuItem(name), name).toBeNull();
    // Searching for one finds nothing rather than the screen command.
    await typeInto(editor, "log");
    await waitFor(() => expect(listed()).toEqual([]));
    expect(screen.getByText("No matching command.")).toBeDefined();
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

  it("typing a screen command and Enter sends nothing: the draft stays and the line names wsp's own road for it", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/login");
    await press(editor, "Enter");
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeNull());
    expectPlainLine(screenCommandLine(SCREEN_COMMANDS[0]!, CLAUDE_CATALOG, workspace));
    expect(screen.getByRole("status").textContent).toContain("Machine tab");
    expect(started).toHaveLength(0);
    expect(draft()).toBe("/login");
    expect(isEditable(editor)).toBe(true);
    // The pickers' commands name the row under the box; a command with words after it is still the command.
    await typeInto(editor, " opus");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(draft()).toBe("/login opus");
    await press(editor, "Enter");
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeNull());
    expect(started).toHaveLength(0);
  });

  it("a block on the send outranks the screen command's line, and the line is back once the block lifts", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/login");
    await press(editor, "Enter");
    const line = screenCommandLine(SCREEN_COMMANDS[0]!, CLAUDE_CATALOG, workspace);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(line));
    // The socket drops with the draft still in the box: the box is disabled and the slot says so, not the command.
    act(() => useStore.getState().setConn("reconnecting"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(sendRefusal("reconnecting")));
    expect(isEditable(editor)).toBe(false);
    act(() => useStore.getState().setConn("live"));
    await waitFor(() => expect(isEditable(editor)).toBe(true));
    // The draft still reads /login, so the line that explains it is still true.
    expect(screen.getByRole("status").textContent).toBe(line);
    expect(draft()).toBe("/login");
    expect(started).toHaveLength(0);
  });

  it("the line for a sign-in command on this computer names the person's own terminal, not the Machine tab", async () => {
    const local: WorkspaceView = { ...workspace, kind: "local" };
    const { api, started } = fixtureApi([local]);
    await setup(api);
    const editor = composerEditor();
    await typeInto(editor, "/logout");
    await press(editor, "Enter");
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeNull());
    expectPlainLine(screenCommandLine(SCREEN_COMMANDS[1]!, CLAUDE_CATALOG, local));
    expect(screen.getByRole("status").textContent).toContain("this computer");
    expect(started).toHaveLength(0);
  });

  it("a slash command the agent never announced still goes as text, since the words may be meant", async () => {
    const { api, started } = fixtureApi([workspace], { [WS]: STREAM_WITH_SCREENS });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/frobnicate now");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]?.prompt).toBe("/frobnicate now");
    expect(screen.queryByRole("status")).toBeNull();
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
    const { api } = fixtureApi([workspace], { [WS]: CHAT_STREAM.slice() });
    await setup(api);
    await screen.findByText(/Server is live at :3000\./);
    const editor = composerEditor();
    await typeInto(editor, "/");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
    await press(editor, "Escape");
    await waitFor(() => expect(menuDrawer()).toBeNull());
    expect(draft()).toBe("/");
    await typeInto(editor, "c");
    await waitFor(() => expect(menuItem("compact")).not.toBeNull());
  });
});

/** The reserved slot above the composer's box: laid out at one height whether or not a line is in it. */
const slot = () => document.querySelector<HTMLElement>("[data-composer-refusal]");
/** The refusal is one muted mono line in the slot: no panel, no border, no fill, no icon, no caution colour. */
function expectPlainLine(words: string): void {
  const line = screen.getByRole("status");
  expect(line.textContent).toBe(words);
  expect(slot()?.contains(line)).toBe(true);
  expect(line.className).toContain("font-mono");
  expect(line.className).toContain("text-muted-foreground");
  expect(line.className).not.toMatch(/border|bg-|warning|destructive|error/);
  expect(line.querySelector("svg")).toBeNull();
  expect(document.querySelector("[data-composer-banner-surface]")).toBeNull();
}

describe("composer while the workspace is not live", () => {
  it("a paused workspace takes words: no line above the box, the placeholder as always, and the send button reads Wake and send", async () => {
    const { api } = fixtureApi([{ ...workspace, phase: "napping" }]);
    await setup(api);
    expect(isEditable(composerEditor())).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(slot()!.textContent).toBe("");
    expect(composerEditor().closest("[data-chat-composer]")!.textContent).not.toContain("paused");
    expect(sendButton().getAttribute("aria-label")).toBe(WAKE_AND_SEND_LABEL);
    expect(sendButton().getAttribute("title")).toBe(WAKE_AND_SEND_LABEL);
    // Empty, so nothing to send yet; the words make it live, as on a running workspace.
    expect(sendButton().disabled).toBe(true);
    await typeInto(composerEditor(), "hello");
    expect(sendButton().disabled).toBe(false);
  });

  it("a running workspace's button reads plain Send", async () => {
    const { api } = fixtureApi([workspace]);
    await setup(api);
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    expect(sendButton().getAttribute("aria-label")).toBe(SEND_LABEL);
    expect(sendButton().getAttribute("title")).toBeNull();
  });

  it("sending on a paused workspace wakes it first and then starts the turn, in that order", async () => {
    const { api, started } = fixtureApi([{ ...workspace, phase: "napping" }]);
    const calls: string[] = [];
    let release!: () => void;
    api.wake = async id => {
      calls.push(`wake ${id}`);
      await new Promise<void>(resolve => (release = resolve));
      return { ...workspace, phase: "running" };
    };
    const start = api.startSession;
    api.startSession = async opts => {
      calls.push("start");
      return start(opts);
    };
    await setup(api);
    await typeInto(composerEditor(), "hello");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(calls).toEqual([`wake ${WS}`]));
    // While the machine wakes the box reads the waking state's own line; the start waits for the wake to settle.
    expect(useStore.getState().workspaces[0]!.phase).toBe("waking");
    expect(started).toHaveLength(0);
    release();
    await waitFor(() => expect(calls).toEqual([`wake ${WS}`, "start"]));
    expect(started[0]!.prompt).toBe("hello");
  });

  it("a gone machine reads the same way: the gone sentence, one line, no panel", async () => {
    const { api } = fixtureApi([{ ...workspace, phase: "gone" }]);
    await setup(api);
    expect(isEditable(composerEditor())).toBe(false);
    expectPlainLine(sendRefusal("gone")!);
    expect(sendButton().getAttribute("aria-label")).toBe("Workspace machine is gone; rebuild it to send");
    expect(sendButton().disabled).toBe(true);
  });

  it("the slot is laid out at one height with or without a line, so the composer does not move when a refusal lands", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    const empty = slot();
    expect(empty).not.toBeNull();
    expect(empty!.className).toContain("h-5");
    expect(empty!.className).toContain("max-w-3xl");
    // The slot is the live region, present before any words land, so a screen reader hears the line when it does.
    expect(empty!.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("status")).toBeNull();
    emit({ type: "workspace.status", status: { ...workspace, phase: "waking", machineState: "starting", reach: { state: "napping" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 } });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeNull());
    expectPlainLine(sendRefusal("waking")!);
    expect(slot()!.className).toBe(empty!.className);
  });

  it("a pushed pausing status disables the send while the view still says running", async () => {
    const { api, emit } = fixtureApi([workspace]);
    await setup(api);
    await waitFor(() => expect(isEditable(composerEditor())).toBe(true));
    emit({ type: "workspace.status", status: { ...workspace, phase: "pausing", machineState: "running", reach: { state: "napping" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Workspace is pausing; wake it to send"));
    expect(isEditable(composerEditor())).toBe(false);
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

  it("offers stop while a turn streams, with no banner; Enter then queues the message above the box", async () => {
    const { api, emit, interrupted, started } = fixtureApi([workspace]);
    await setup(api);
    emit({ type: "session.start", ...scope, prompt: "go" });
    emit({ type: "session.delta", ...scope, kind: "text", text: "on it" });
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeDefined();
    expect(interrupted).toEqual([]);
    expect(screen.queryByRole("button", { name: /Send message|Turn in flight/ })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(isEditable(composerEditor())).toBe(true);
    await typeInto(composerEditor(), "follow up");
    await press(composerEditor(), "Enter");
    expect(draft()).toBe("");
    expect((screen.getByRole("textbox", { name: "Queued message" }) as HTMLTextAreaElement).value).toBe("follow up");
    expect(started).toHaveLength(0);
    emit({ type: "session.done", ...scope, result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    emit({ type: "session.end", ...scope, exitCode: 0, sawResult: true });
    await waitFor(() => expect(started.map(s => s.prompt)).toEqual(["follow up"]));
    expect(screen.queryByRole("textbox", { name: "Queued message" })).toBeNull();
  });
});

describe("a new thread while another thread of the workspace works", () => {
  const a = { workspaceId: WS, sessionId: "sess_a", turnId: "turn_a", threadId: "thr_a" };
  const WORKING: SessionEvent[] = [
    { type: "session.start", ...a, prompt: "build it", cwd: "/root" },
    { type: "session.delta", ...a, kind: "text", text: "On it." },
  ];

  it("the new-thread composer has no turn: sendable, no line, and its send opens a second thread while the first keeps working", async () => {
    const { api, emit, started } = fixtureApi([workspace], { [WS]: WORKING });
    await setup(api);
    await screen.findByText("On it.");
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeDefined();
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in api?");
    const editor = composerEditor();
    expect(isEditable(editor)).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop generation" })).toBeNull();
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
    await typeInto(editor, "second thread");
    await press(editor, "Enter");
    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toEqual({ workspaceId: WS, requestId: expect.any(String), prompt: "second thread" });
    expect(screen.getByText("second thread")).toBeDefined();
    // The first thread runs on: its next words are its own and never reach the new thread.
    emit({ type: "session.delta", ...a, kind: "text", text: " Still on it." });
    expect(screen.queryByText(/Still on it/)).toBeNull();
    const b = { workspaceId: WS, sessionId: "sess_b", turnId: "turn_b", threadId: "thr_b" };
    emit({ type: "session.start", ...b, prompt: "second thread", requestId: started[0]!.requestId });
    emit({ type: "session.delta", ...b, kind: "text", text: "Second thread here." });
    await screen.findByText("Second thread here.");
    expect(screen.queryByText("On it.")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop generation" })).toBeDefined();
  });

  it("the working thread's own composer still says so: its turn replied and runs on, and the line names that thread", async () => {
    const { api, emit } = fixtureApi([workspace], { [WS]: WORKING });
    await setup(api);
    await screen.findByText("On it.");
    expect(screen.queryByRole("status")).toBeNull();
    emit({ type: "session.done", ...a, result: { status: "completed", durationMs: 900, costUsd: 0.001 } });
    expectPlainLine(stillWorkingLine("thr_a"));
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    // A new thread asked for now owes that turn nothing.
    act(() => requestNewThread({ workspaceId: WS }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(isEditable(composerEditor())).toBe(true);
    expect(sendButton().getAttribute("aria-label")).toBe("Send message");
  });
});

describe("composerSendBlock", () => {
  const live = { conn: "live" as const, hasApi: true, state: "running" as const, hydrated: true };
  it("names the first thing in the way, socket first, as the kind the refusal table gives words for", () => {
    expect(composerSendBlock(live)).toBeNull();
    expect(composerSendBlock({ ...live, hasApi: false })).toBe("connecting");
    expect(composerSendBlock({ ...live, conn: "connecting" })).toBe("connecting");
    expect(composerSendBlock({ ...live, conn: "reconnecting", state: "paused" })).toBe("reconnecting");
    expect(composerSendBlock({ ...live, conn: "closed" })).toBe("closed");
    // No workspace and no status: the app has nothing to name a state of, which is the row a missing workspace gets.
    expect(composerSendBlock({ ...live, state: null })).toBe("not-found");
    expect(composerSendBlock({ ...live, state: "gone" })).toBe("gone");
    expect(composerSendBlock({ ...live, state: "paused" })).toBe("paused");
    expect(composerSendBlock({ ...live, state: "pausing" })).toBe("pausing");
    expect(composerSendBlock({ ...live, state: "waking" })).toBe("waking");
    expect(composerSendBlock({ ...live, state: "unreachable" })).toBe("unreachable");
    expect(composerSendBlock({ ...live, hydrated: false })).toBe("loading");
  });
});
